import type { Address } from 'viem'
import { formatUnits } from 'viem'
import type { PricedSandwich, Sandwich } from './types.js'

/** CoinGecko platform slugs, keyed by chain id. */
const PLATFORMS: Record<number, string> = {
  1: 'ethereum',
  10: 'optimistic-ethereum',
  56: 'binance-smart-chain',
  137: 'polygon-pos',
  8453: 'base',
  42161: 'arbitrum-one',
}

/** Survives across calls so a long scan never asks for the same token twice. */
const priceCache = new Map<string, number | null>()

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * One token price. The free CoinGecko tier rejects requests carrying more than
 * a single contract address, so batching is not an option and each lookup is
 * its own request.
 */
async function fetchOne(address: string, platform: string): Promise<number | null> {
  const url = new URL(`https://api.coingecko.com/api/v3/simple/token_price/${platform}`)
  url.searchParams.set('contract_addresses', address)
  url.searchParams.set('vs_currencies', 'usd')

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url)
      if (res.status === 429) {
        // Free tier throttles hard. Back off rather than giving up on the token.
        await sleep(1500 * (attempt + 1))
        continue
      }
      if (!res.ok) return null
      const body = (await res.json()) as Record<string, { usd?: number }>
      const entry = body[address] ?? body[address.toLowerCase()]
      return typeof entry?.usd === 'number' ? entry.usd : null
    } catch {
      return null
    }
  }
  return null
}

/**
 * Spot USD prices for a set of tokens.
 *
 * These are current prices, not prices at the time of the sandwich. For tokens
 * that have moved a lot since, the USD column drifts. Token amounts in the
 * report are always exact regardless.
 */
export async function fetchPrices(
  tokens: Address[],
  chainId: number,
): Promise<Map<string, number>> {
  const prices = new Map<string, number>()
  const platform = PLATFORMS[chainId]
  if (!platform || tokens.length === 0) return prices

  const wanted = [...new Set(tokens.map((t) => t.toLowerCase()))]

  for (const address of wanted) {
    const cached = priceCache.get(address)
    if (cached !== undefined) {
      if (cached !== null) prices.set(address, cached)
      continue
    }
    const price = await fetchOne(address, platform)
    priceCache.set(address, price)
    if (price !== null) prices.set(address, price)
    // Serialised deliberately: parallel requests trip the rate limiter far
    // faster than they save time on the handful of tokens a report needs.
    await sleep(250)
  }

  return prices
}

function toUsd(
  amount: bigint,
  decimals: number,
  address: Address,
  prices: Map<string, number>,
): number | null {
  const price = prices.get(address.toLowerCase())
  if (price === undefined) return null
  return Number(formatUnits(amount, decimals)) * price
}

export function priceSandwiches(
  sandwiches: Sandwich[],
  prices: Map<string, number>,
): PricedSandwich[] {
  return sandwiches.map((s) => ({
    ...s,
    extractedUsd: toUsd(
      s.attackerProfit,
      s.attackerProfitToken.decimals,
      s.attackerProfitToken.address,
      prices,
    ),
    shortfallUsd:
      s.victimShortfall === null
        ? null
        : toUsd(
            s.victimShortfall,
            s.victimShortfallToken.decimals,
            s.victimShortfallToken.address,
            prices,
          ),
  }))
}
