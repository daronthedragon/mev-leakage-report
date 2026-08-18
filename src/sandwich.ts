import type { Address, Hex, PublicClient } from 'viem'
import { resolvePool } from './pools.js'
import type { Direction, PoolMeta, Sandwich, Swap, SyncPoint, TokenMeta } from './types.js'

const opposite = (d: Direction): Direction => (d === '0->1' ? '1->0' : '0->1')

/** The token a swap in this direction pays into the pool. */
const inputToken = (pool: PoolMeta, d: Direction): TokenMeta =>
  d === '0->1' ? pool.token0 : pool.token1

/** The token a swap in this direction takes out of the pool. */
const outputToken = (pool: PoolMeta, d: Direction): TokenMeta =>
  d === '0->1' ? pool.token1 : pool.token0

const lower = (a: Address): string => a.toLowerCase()

// A wallet trades through the same pools repeatedly and one attacker leg can
// bracket several victims, so transaction lookups are cached for the process.
const txCache = new Map<string, { from: Address; to: Address | null }>()
const gasCache = new Map<string, bigint>()

async function txMeta(
  client: PublicClient,
  hash: Hex,
): Promise<{ from: Address; to: Address | null }> {
  const key = hash.toLowerCase()
  const hit = txCache.get(key)
  if (hit) return hit
  const tx = await client.getTransaction({ hash })
  const meta = { from: tx.from, to: tx.to ?? null }
  txCache.set(key, meta)
  return meta
}

async function txGas(client: PublicClient, hash: Hex): Promise<bigint> {
  const key = hash.toLowerCase()
  const hit = gasCache.get(key)
  if (hit !== undefined) return hit
  try {
    const receipt = await client.getTransactionReceipt({ hash })
    const gas = receipt.gasUsed * receipt.effectiveGasPrice
    gasCache.set(key, gas)
    return gas
  } catch {
    return 0n
  }
}

/**
 * Constant-product output with the standard 0.3% fee, as used by Uniswap V2 and
 * the forks that copied it unchanged. Integer math throughout so the result
 * matches on-chain rounding exactly.
 */
export function v2AmountOut(amountIn: bigint, reserveIn: bigint, reserveOut: bigint): bigint {
  if (amountIn <= 0n || reserveIn <= 0n || reserveOut <= 0n) return 0n
  const amountInWithFee = amountIn * 997n
  return (amountInWithFee * reserveOut) / (reserveIn * 1000n + amountInWithFee)
}

/**
 * Reserves as they stood immediately before the frontrun, reconstructed by
 * undoing the frontrun against the Sync event it emitted. This is what lets the
 * counterfactual run without an archive node.
 *
 * V2 emits Sync inside the same call, just ahead of Swap, carrying the reserves
 * the swap produced. So the frontrun's own snapshot is the closest Sync below
 * its log index.
 */
function reservesBefore(
  front: Swap,
  syncs: SyncPoint[],
): { reserveIn: bigint; reserveOut: bigint } | null {
  // Sorted defensively: this is an exported entry point and callers other than
  // fetchPoolActivity may not order their logs.
  const ordered = [...syncs].sort((a, b) => a.logIndex - b.logIndex)
  let after: SyncPoint | undefined
  for (const sync of ordered) {
    if (sync.logIndex >= front.logIndex) break
    after = sync
  }
  if (!after) return null

  const [inAfter, outAfter] =
    front.direction === '0->1' ? [after.reserve0, after.reserve1] : [after.reserve1, after.reserve0]

  // The frontrun paid amountIn into the pool and took amountOut out of it.
  const reserveIn = inAfter - front.amountIn
  const reserveOut = outAfter + front.amountOut
  if (reserveIn <= 0n || reserveOut <= 0n) return null
  return { reserveIn, reserveOut }
}

/** Addresses appearing on both swaps at the event level. */
function sharedActors(a: Swap, b: Swap): Set<string> {
  const first = new Set([lower(a.sender), lower(a.recipient)])
  const shared = new Set<string>()
  for (const candidate of [lower(b.sender), lower(b.recipient)]) {
    if (first.has(candidate)) shared.add(candidate)
  }
  return shared
}

/**
 * Whether the two legs share an address that is not just the router the victim
 * also traded through.
 *
 * On a V2 pair the Swap event's sender is msg.sender of pair.swap(), which for
 * ordinary retail flow is a shared router contract. Treating that as identity
 * links complete strangers, so an overlap consisting only of addresses the
 * victim also used proves nothing on its own.
 */
function hasStrongLink(front: Swap, back: Swap, victim: Swap): boolean {
  const routerish = new Set([lower(victim.sender), lower(victim.recipient)])
  for (const actor of sharedActors(front, back)) {
    if (!routerish.has(actor)) return true
  }
  return false
}

/**
 * Whether the frontrun position was already unwound before the victim traded.
 * If it was, this frontrun belongs to an earlier victim and reusing it would
 * double-count the same attack.
 */
function alreadyClosed(front: Swap, victim: Swap, poolSwaps: Swap[]): boolean {
  const actors = new Set([lower(front.sender), lower(front.recipient)])
  return poolSwaps.some(
    (s) =>
      s.txIndex > front.txIndex &&
      s.txIndex < victim.txIndex &&
      s.direction === opposite(front.direction) &&
      (actors.has(lower(s.sender)) || actors.has(lower(s.recipient))),
  )
}

/**
 * Attacker profit denominated in the victim's input token.
 *
 * A backrun rarely sells back exactly what the frontrun bought. Ignoring the
 * remainder makes a profitable partial unwind look like a large loss, so the
 * leftover inventory is valued at the price the backrun itself achieved.
 */
function computeProfit(front: Swap, back: Swap): { profit: bigint; residual: bigint } {
  const residual = front.amountOut - back.amountIn
  const residualValue = back.amountIn > 0n ? (residual * back.amountOut) / back.amountIn : 0n
  return { profit: back.amountOut + residualValue - front.amountIn, residual }
}

interface Candidate {
  front: Swap
  back: Swap
  strong: boolean
  ratio: number
}

/**
 * Look for a frontrun and backrun bracketing the victim on the same pool in the
 * same block. The frontrun must push price the same way the victim is about to,
 * and the backrun must unwind it.
 */
export async function detectSandwich(
  client: PublicClient,
  victim: Swap,
  poolSwaps: Swap[],
  syncs: SyncPoint[],
): Promise<Sandwich | null> {
  const before = poolSwaps.filter(
    (s) => s.txIndex < victim.txIndex && s.direction === victim.direction,
  )
  const after = poolSwaps.filter(
    (s) => s.txIndex > victim.txIndex && s.direction === opposite(victim.direction),
  )
  if (before.length === 0 || after.length === 0) return null

  const candidates: Candidate[] = []
  for (const front of before) {
    if (alreadyClosed(front, victim, poolSwaps)) continue
    for (const back of after) {
      if (sharedActors(front, back).size === 0) continue
      // The attacker should unwind roughly the position they opened. A wide band
      // keeps partial unwinds without admitting unrelated traffic.
      const ratio = Number(back.amountIn) / Number(front.amountOut)
      if (!Number.isFinite(ratio) || ratio < 0.5 || ratio > 1.5) continue
      candidates.push({ front, back, strong: hasStrongLink(front, back, victim), ratio })
    }
  }
  if (candidates.length === 0) return null

  // Prefer a link the victim's own router cannot explain, then the cleanest
  // unwind, then the tightest bracket around the victim.
  candidates.sort(
    (a, b) =>
      Number(b.strong) - Number(a.strong) ||
      Math.abs(a.ratio - 1) - Math.abs(b.ratio - 1) ||
      b.front.txIndex - a.front.txIndex,
  )

  // Only the best few are worth spending transaction lookups on.
  for (const candidate of candidates.slice(0, 4)) {
    const [frontTx, backTx] = await Promise.all([
      txMeta(client, candidate.front.txHash),
      txMeta(client, candidate.back.txHash),
    ])

    const origin = lower(frontTx.from) === lower(backTx.from)
    const target =
      frontTx.to !== null && backTx.to !== null && lower(frontTx.to) === lower(backTx.to)

    // A router-only overlap is not evidence. Require the transactions
    // themselves to tie the two legs together.
    if (!candidate.strong && !origin && !target) continue

    const pool = await resolvePool(client, victim.pool)
    const { profit, residual } = computeProfit(candidate.front, candidate.back)

    let confidence = 0.4
    if (candidate.strong) confidence += 0.25
    if (origin) confidence += 0.25
    else if (target) confidence += 0.15
    const drift = Math.abs(candidate.ratio - 1)
    if (drift < 0.01) confidence += 0.2
    else if (drift < 0.1) confidence += 0.1

    // Exact counterfactual, only reconstructable for constant-product pools.
    let victimShortfall: bigint | null = null
    if (victim.protocol === 'v2' && candidate.front.protocol === 'v2') {
      const reserves = reservesBefore(candidate.front, syncs)
      if (reserves) {
        const ideal = v2AmountOut(victim.amountIn, reserves.reserveIn, reserves.reserveOut)
        const shortfall = ideal - victim.amountOut
        if (shortfall > 0n) victimShortfall = shortfall
      }
    }

    const [frontGas, backGas] = await Promise.all([
      txGas(client, candidate.front.txHash),
      txGas(client, candidate.back.txHash),
    ])

    return {
      victim,
      frontrun: candidate.front,
      backrun: candidate.back,
      pool,
      sameOrigin: origin,
      sameTarget: target,
      strongLink: candidate.strong,
      confidence: Math.min(confidence, 1),
      unwindRatio: candidate.ratio,
      attackerProfit: profit,
      attackerProfitToken: inputToken(pool, victim.direction),
      residual,
      victimShortfall,
      victimShortfallToken: outputToken(pool, victim.direction),
      attackerGasWei: frontGas + backGas,
    }
  }

  return null
}
