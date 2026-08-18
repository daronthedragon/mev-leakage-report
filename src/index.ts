#!/usr/bin/env node
import { createPublicClient, getAddress, http, isAddress, type Address } from 'viem'
import pc from 'picocolors'
import { loadConfig } from './config.js'
import { fetchSentTransactions } from './history.js'
import { fetchPoolActivity, fetchSwapsInTx } from './swaps.js'
import { detectSandwich } from './sandwich.js'
import { fetchPrices, priceSandwiches } from './pricing.js'
import { renderJson, renderReport } from './report.js'
import type { Report, Sandwich, Swap } from './types.js'

const USAGE = `
  mev-leakage <address> [options]

  --limit <n>              transactions to scan          (default 200)
  --min-confidence <0-1>   drop weaker matches           (default 0.5)
  --from-block <n>         only scan from this block
  --include-unprofitable   keep brackets that lost money
  --json                   machine-readable output
  --help                   show this
`

/** Flags that consume the next argument, so it is not mistaken for the address. */
const VALUE_FLAGS = new Set(['limit', 'min-confidence', 'from-block'])
const BOOL_FLAGS = new Set(['json', 'include-unprofitable', 'help'])

interface Args {
  address: Address
  limit: number
  minConfidence: number
  fromBlock?: bigint
  includeUnprofitable: boolean
  json: boolean
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = []
  const values = new Map<string, string>()
  const bools = new Set<string>()

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] as string
    if (!token.startsWith('--')) {
      positional.push(token)
      continue
    }

    const body = token.slice(2)
    const eq = body.indexOf('=')
    if (eq >= 0) {
      values.set(body.slice(0, eq), body.slice(eq + 1))
      continue
    }
    if (VALUE_FLAGS.has(body)) {
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) {
        throw new Error(`--${body} needs a value`)
      }
      values.set(body, next)
      i++
      continue
    }
    if (!BOOL_FLAGS.has(body)) throw new Error(`Unknown option --${body}\n${USAGE}`)
    bools.add(body)
  }

  if (bools.has('help')) throw new Error(USAGE.trim())

  const address = positional[0]
  if (!address) throw new Error(`Missing address.\n${USAGE}`)
  if (!isAddress(address)) throw new Error(`"${address}" is not a valid address.\n${USAGE}`)

  const number = (name: string, fallback: number): number => {
    const raw = values.get(name)
    if (raw === undefined) return fallback
    const parsed = Number(raw)
    if (!Number.isFinite(parsed)) throw new Error(`--${name} must be a number, got "${raw}"`)
    return parsed
  }

  const limit = number('limit', 200)
  if (!Number.isInteger(limit) || limit <= 0) throw new Error('--limit must be a positive integer')

  const minConfidence = number('min-confidence', 0.5)
  if (minConfidence < 0 || minConfidence > 1) {
    throw new Error('--min-confidence must be between 0 and 1')
  }

  const rawFromBlock = values.get('from-block')
  let fromBlock: bigint | undefined
  if (rawFromBlock !== undefined) {
    if (!/^\d+$/.test(rawFromBlock)) {
      throw new Error(`--from-block must be a whole number, got "${rawFromBlock}"`)
    }
    fromBlock = BigInt(rawFromBlock)
  }

  return {
    address: getAddress(address),
    limit,
    minConfidence,
    fromBlock,
    includeUnprofitable: bools.has('include-unprofitable'),
    json: bools.has('json'),
  }
}

/** Run tasks with a fixed number in flight, so free RPC tiers do not rate limit us. */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (cursor < items.length) {
      const index = cursor++
      results[index] = await fn(items[index] as T, index)
    }
  })
  await Promise.all(workers)
  return results
}

/**
 * One attacker pair can bracket several of the user's swaps in a block, but it
 * only extracted value once. Keep the strongest match per pair.
 */
function dedupe(hits: Sandwich[]): Sandwich[] {
  const byPair = new Map<string, Sandwich>()
  for (const hit of hits) {
    const key = `${hit.frontrun.txHash}:${hit.backrun.txHash}`
    const existing = byPair.get(key)
    if (!existing || hit.confidence > existing.confidence) byPair.set(key, hit)
  }
  return [...byPair.values()]
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const config = loadConfig()
  const log = (msg: string) => {
    if (!args.json) process.stderr.write(msg + '\n')
  }

  const client = createPublicClient({ transport: http(config.rpcUrl) })
  if (config.usingDefaultRpc) {
    log(pc.dim(`No RPC_URL set, using the public default (${config.rpcUrl}).`))
  }

  log(pc.dim(`Fetching transaction history for ${args.address}...`))
  const { entries: history, source } = await fetchSentTransactions({
    address: args.address,
    apiKey: config.etherscanKey,
    chainId: config.chainId,
    limit: args.limit,
    startBlock: args.fromBlock,
  })

  if (history.length === 0) {
    log(pc.yellow('No outgoing transactions found for that address.'))
    return
  }
  log(pc.dim(`Found ${history.length} transactions via ${source}. Looking for swaps...`))

  // Step 1: the user's own trades, pulled from their transaction receipts.
  const swapBatches = await mapLimit(history, 8, async (entry) => {
    try {
      return await fetchSwapsInTx(client, entry.hash)
    } catch {
      return [] as Swap[]
    }
  })
  const victimSwaps = swapBatches.flat()

  if (victimSwaps.length === 0) {
    log(pc.yellow('No DEX swaps found in those transactions.'))
    return
  }
  log(pc.dim(`Found ${victimSwaps.length} swaps. Checking surrounding block activity...`))

  // Step 2: pull each relevant pool's full activity for the block it traded in.
  const groups = new Map<string, { pool: Address; block: bigint; victims: Swap[] }>()
  for (const swap of victimSwaps) {
    const key = `${swap.blockNumber}:${swap.pool.toLowerCase()}`
    const existing = groups.get(key)
    if (existing) existing.victims.push(swap)
    else groups.set(key, { pool: swap.pool, block: swap.blockNumber, victims: [swap] })
  }

  // Step 3: detect. Most blocks hold nothing, so failures here are not fatal.
  const found = await mapLimit([...groups.values()], 5, async (group) => {
    const hits: Sandwich[] = []
    try {
      const { swaps, syncs } = await fetchPoolActivity(client, group.pool, group.block)
      for (const victim of group.victims) {
        try {
          const hit = await detectSandwich(client, victim, swaps, syncs)
          if (hit && hit.confidence >= args.minConfidence) hits.push(hit)
        } catch {
          // One bad victim must not discard the hits already found here.
        }
      }
    } catch {
      // Block unavailable from this provider. Nothing to report for it.
    }
    return hits
  })

  const detected = dedupe(found.flat())
  const profitable = args.includeUnprofitable
    ? detected
    : detected.filter((s) => s.attackerProfit > 0n)
  const sandwiches = profitable.sort((a, b) =>
    Number(b.victim.blockNumber - a.victim.blockNumber),
  )

  // Step 4: price and render.
  const tokens = sandwiches.flatMap((s) => [
    s.attackerProfitToken.address,
    s.victimShortfallToken.address,
  ])
  if (tokens.length > 0) log(pc.dim('Resolving token prices...'))
  const prices = await fetchPrices(tokens, config.chainId)
  const priced = priceSandwiches(sandwiches, prices)

  const blockNumbers = victimSwaps.map((s) => s.blockNumber)
  const report: Report = {
    address: args.address,
    swapsScanned: victimSwaps.length,
    blocksScanned: new Set(blockNumbers.map(String)).size,
    sandwiches: priced,
    totalExtractedUsd: priced.reduce((sum, s) => sum + Math.max(0, s.extractedUsd ?? 0), 0),
    unpricedCount: priced.filter((s) => s.extractedUsd === null).length,
    discardedCount: detected.length - profitable.length,
    source,
    fromBlock: blockNumbers.reduce((min, b) => (b < min ? b : min), blockNumbers[0] as bigint),
    toBlock: blockNumbers.reduce((max, b) => (b > max ? b : max), blockNumbers[0] as bigint),
  }

  process.stdout.write(args.json ? renderJson(report) + '\n' : renderReport(report))
}

main().catch((err: unknown) => {
  process.stderr.write(pc.red(`\n${err instanceof Error ? err.message : String(err)}\n\n`))
  process.exit(1)
})
