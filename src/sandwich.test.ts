import assert from 'node:assert/strict'
import test from 'node:test'
import {
  encodeAbiParameters,
  encodeEventTopics,
  parseAbiParameters,
  type Address,
  type Log,
  type PublicClient,
} from 'viem'
import { V3_SWAP } from './abi.js'
import { detectSandwich, v2AmountOut } from './sandwich.js'
import { decodeSwapLog } from './swaps.js'
import type { Swap, SyncPoint } from './types.js'

const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' as Address
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' as Address
const POOL = '0xB4e16d0168e52d35CaCD2c6185b44281Ec28C9Dc' as Address
const ATTACKER = '0x00000000000000000000000000000000000000A1' as Address
const ROUTER = '0x00000000000000000000000000000000000000B2' as Address
const VICTIM = '0x00000000000000000000000000000000000000C3' as Address
const STRANGER = '0x00000000000000000000000000000000000000D4' as Address

interface MockOpts {
  /** tx.from per transaction hash. */
  from?: Record<string, Address>
  /** tx.to per transaction hash. */
  to?: Record<string, Address>
}

/** Answers only the calls resolvePool, txMeta and txGas actually make. */
function mockClient(opts: MockOpts = {}): PublicClient {
  return {
    multicall: async ({ contracts }: { contracts: { address: Address; functionName: string }[] }) =>
      contracts.map((c) => {
        switch (c.functionName) {
          case 'token0':
            return { status: 'success', result: USDC }
          case 'token1':
            return { status: 'success', result: WETH }
          case 'symbol':
            return { status: 'success', result: c.address === USDC ? 'USDC' : 'WETH' }
          case 'decimals':
            return { status: 'success', result: c.address === USDC ? 6 : 18 }
          default:
            return { status: 'failure' }
        }
      }),
    getTransaction: async ({ hash }: { hash: string }) => ({
      from: opts.from?.[hash] ?? ATTACKER,
      to: opts.to?.[hash] ?? null,
    }),
    getTransactionReceipt: async () => ({
      gasUsed: 150_000n,
      effectiveGasPrice: 20_000_000_000n,
    }),
  } as unknown as PublicClient
}

const swap = (
  over: Partial<Swap> &
    Pick<Swap, 'txIndex' | 'logIndex' | 'direction' | 'amountIn' | 'amountOut' | 'txHash'>,
): Swap => ({
  pool: POOL,
  protocol: 'v2',
  blockNumber: 18_000_000n,
  sender: ROUTER,
  recipient: VICTIM,
  ...over,
})

/**
 * Replays a sandwich through real constant-product math so the detector can be
 * checked against numbers we know we put in. `unwind` is the fraction of the
 * frontrun position the backrun sells again.
 */
function buildScenario({
  unwind = 1,
  frontIn = 50_000_000000n,
  victimIn = 10_000_000000n,
  // Transaction lookups are cached per hash for the life of the process, so
  // each scenario needs its own hashes to stay isolated.
  tag = 'a',
} = {}) {
  const r0 = 1_000_000_000000n // 1M USDC, 6 decimals
  const r1 = 500n * 10n ** 18n // 500 WETH, 18 decimals

  const cleanFill = v2AmountOut(victimIn, r0, r1)

  const frontOut = v2AmountOut(frontIn, r0, r1)
  const r0a = r0 + frontIn
  const r1a = r1 - frontOut

  const victimOut = v2AmountOut(victimIn, r0a, r1a)
  const r0b = r0a + victimIn
  const r1b = r1a - victimOut

  const backIn = (frontOut * BigInt(Math.round(unwind * 10_000))) / 10_000n
  const backOut = v2AmountOut(backIn, r1b, r0b)
  const r0c = r0b - backOut
  const r1c = r1b + backIn

  // V2 emits Sync just ahead of Swap, so each pair sits at (n, n+1).
  const syncs: SyncPoint[] = [
    { pool: POOL, logIndex: 0, reserve0: r0a, reserve1: r1a },
    { pool: POOL, logIndex: 2, reserve0: r0b, reserve1: r1b },
    { pool: POOL, logIndex: 4, reserve0: r0c, reserve1: r1c },
  ]

  const frontrun = swap({
    txIndex: 0,
    logIndex: 1,
    direction: '0->1',
    amountIn: frontIn,
    amountOut: frontOut,
    sender: ATTACKER,
    recipient: ATTACKER,
    txHash: `0xfront${tag}`,
  })
  const victim = swap({
    txIndex: 1,
    logIndex: 3,
    direction: '0->1',
    amountIn: victimIn,
    amountOut: victimOut,
    txHash: `0xvictim${tag}`,
  })
  const backrun = swap({
    txIndex: 2,
    logIndex: 5,
    direction: '1->0',
    amountIn: backIn,
    amountOut: backOut,
    sender: ATTACKER,
    recipient: ATTACKER,
    txHash: `0xback${tag}`,
  })

  return { syncs, frontrun, victim, backrun, cleanFill, victimOut, frontIn, backIn, backOut, tag }
}

const runDetect = (s: ReturnType<typeof buildScenario>, client = mockClient()) =>
  detectSandwich(client, s.victim, [s.frontrun, s.victim, s.backrun], s.syncs)

test('detects a sandwich and recovers the exact attacker profit', async () => {
  const s = buildScenario()
  const hit = await runDetect(s)

  assert.ok(hit, 'expected a sandwich to be detected')
  assert.equal(hit.attackerProfit, s.backOut - s.frontIn)
  assert.ok(hit.attackerProfit > 0n, 'attacker should end in profit')
  assert.equal(hit.attackerProfitToken.symbol, 'USDC')
  assert.equal(hit.residual, 0n, 'a complete unwind leaves no inventory')
})

test('reconstructs the victim shortfall against the pre-frontrun pool', async () => {
  const s = buildScenario()
  const hit = await runDetect(s)

  assert.ok(hit)
  assert.equal(hit.victimShortfall, s.cleanFill - s.victimOut)
  assert.ok((hit.victimShortfall as bigint) > 0n, 'victim should be worse off')
  assert.equal(hit.victimShortfallToken.symbol, 'WETH')
})

test('scores a same-origin, fully unwound sandwich at full confidence', async () => {
  const s = buildScenario()
  const hit = await runDetect(s)

  assert.ok(hit)
  assert.equal(hit.confidence, 1)
  assert.equal(hit.sameOrigin, true)
  assert.equal(hit.strongLink, true)
})

test('shortfall is unaffected by the order syncs arrive in', async () => {
  const s = buildScenario()
  const expected = await runDetect(s)
  const shuffled = { ...s, syncs: [s.syncs[2]!, s.syncs[0]!, s.syncs[1]!] }
  const actual = await runDetect(shuffled)

  assert.ok(expected && actual)
  assert.equal(actual.victimShortfall, expected.victimShortfall)
})

test('values leftover inventory so a partial unwind is not read as a loss', async () => {
  // The bot sells back only 80% of what it bought, keeping the rest.
  const s = buildScenario({ unwind: 0.8, tag: 'partial' })
  const hit = await runDetect(s)

  assert.ok(hit)
  assert.ok(hit.residual > 0n, 'an 80% unwind must leave inventory behind')

  // Ignoring that inventory is what used to invert the sign.
  const naive = s.backOut - s.frontIn
  assert.ok(naive < 0n, 'the naive round trip looks like a loss here')
  assert.ok(hit.attackerProfit > 0n, 'valuing the leftover reveals the real profit')
  assert.ok(hit.attackerProfit > naive)
})

test('rejects two strangers linked only by the router the victim also used', async () => {
  const s = buildScenario({ tag: 'router' })
  // Both legs route through the same public router, and nothing else connects
  // them: different senders, different target contracts.
  const frontrun: Swap = { ...s.frontrun, sender: ROUTER, recipient: STRANGER }
  const backrun: Swap = { ...s.backrun, sender: ROUTER, recipient: ATTACKER }
  const client = mockClient({
    from: { '0xfrontrouter': STRANGER, '0xbackrouter': ATTACKER },
    to: { '0xfrontrouter': STRANGER, '0xbackrouter': ATTACKER },
  })

  const hit = await detectSandwich(client, s.victim, [frontrun, s.victim, backrun], s.syncs)
  assert.equal(hit, null)
})

test('accepts a router-only event link when the transactions share a target', async () => {
  const s = buildScenario({ tag: 'target' })
  const frontrun: Swap = { ...s.frontrun, sender: ROUTER, recipient: STRANGER }
  const backrun: Swap = { ...s.backrun, sender: ROUTER, recipient: ATTACKER }
  // Different funding EOAs, one shared execution contract: a real bot pattern.
  const client = mockClient({
    from: { '0xfronttarget': STRANGER, '0xbacktarget': ATTACKER },
    to: { '0xfronttarget': ATTACKER, '0xbacktarget': ATTACKER },
  })

  const hit = await detectSandwich(client, s.victim, [frontrun, s.victim, backrun], s.syncs)
  assert.ok(hit, 'a shared target contract is real evidence')
  assert.equal(hit.sameTarget, true)
  assert.equal(hit.strongLink, false)
})

test('does not reuse a frontrun that was already unwound before this victim', async () => {
  const s = buildScenario({ tag: 'closed' })
  // FrontA -> Victim1 -> BackA closes it -> our victim trades -> a later,
  // unrelated attacker sell. FrontA must not be paired with that later sell.
  const victim2 = swap({
    txIndex: 3,
    logIndex: 7,
    direction: '0->1',
    amountIn: s.victim.amountIn,
    amountOut: s.victim.amountOut,
    txHash: '0xvictim2',
  })
  const laterSell = swap({
    txIndex: 4,
    logIndex: 9,
    direction: '1->0',
    amountIn: s.backIn,
    amountOut: s.backOut,
    sender: ATTACKER,
    recipient: ATTACKER,
    txHash: '0xlater',
  })

  const hit = await detectSandwich(
    mockClient(),
    victim2,
    [s.frontrun, s.victim, s.backrun, victim2, laterSell],
    s.syncs,
  )
  assert.equal(hit, null)
})

test('ignores ordinary traffic with no bracketing pair', async () => {
  const s = buildScenario()
  const hit = await detectSandwich(mockClient(), s.victim, [s.frontrun, s.victim], s.syncs)
  assert.equal(hit, null)
})

test('ignores a backrun that does not unwind the frontrun position', async () => {
  const s = buildScenario()
  const unrelated: Swap = { ...s.backrun, amountIn: s.backrun.amountIn / 10n }
  const hit = await detectSandwich(
    mockClient(),
    s.victim,
    [s.frontrun, s.victim, unrelated],
    s.syncs,
  )
  assert.equal(hit, null)
})

test('constant-product math matches the Uniswap V2 fee model', () => {
  const out = v2AmountOut(1000n, 1_000_000n, 1_000_000n)
  const amountInWithFee = 1000n * 997n
  assert.equal(out, (amountInWithFee * 1_000_000n) / (1_000_000n * 1000n + amountInWithFee))
  assert.ok(out < 1000n, 'fee and slippage must leave the trader with less than input')
})

/** Builds a real ABI-encoded V3 Swap log so the decoder is exercised for real. */
function v3Log(amount0: bigint, amount1: bigint): Log {
  return {
    address: POOL,
    topics: encodeEventTopics({
      abi: [V3_SWAP],
      eventName: 'Swap',
      args: { sender: ATTACKER, recipient: VICTIM },
    }),
    data: encodeAbiParameters(parseAbiParameters('int256, int256, uint160, uint128, int24'), [
      amount0,
      amount1,
      1n,
      1n,
      0,
    ]),
    blockNumber: 18_000_000n,
    transactionHash: '0xabc',
    transactionIndex: 0,
    logIndex: 0,
  } as unknown as Log
}

test('decodes both V3 directions into non-negative quantities', () => {
  const zeroIn = decodeSwapLog(v3Log(1000n, -500n))
  assert.ok(zeroIn)
  assert.equal(zeroIn.direction, '0->1')
  assert.equal(zeroIn.amountIn, 1000n)
  assert.equal(zeroIn.amountOut, 500n)

  const oneIn = decodeSwapLog(v3Log(-500n, 1000n))
  assert.ok(oneIn)
  assert.equal(oneIn.direction, '1->0')
  assert.equal(oneIn.amountIn, 1000n)
  assert.equal(oneIn.amountOut, 500n)
})

test('rejects V3 logs whose amounts share a sign', () => {
  // A real swap always moves one token in and the other out. Forks that reuse
  // the topic with different semantics would otherwise yield negative amounts.
  assert.equal(decodeSwapLog(v3Log(-100n, -50n)), null)
  assert.equal(decodeSwapLog(v3Log(100n, 50n)), null)
})
