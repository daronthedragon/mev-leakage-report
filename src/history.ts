import type { Address, Hex } from 'viem'

interface ExplorerTx {
  blockNumber: string
  timeStamp: string
  hash: string
  from: string
  isError: string
}

export interface HistoryEntry {
  hash: Hex
  blockNumber: bigint
  timestamp: number
}

export type HistorySource = 'etherscan' | 'blockscout'

export interface HistoryResult {
  entries: HistoryEntry[]
  source: HistorySource
}

/**
 * Blockscout serves the same txlist shape as Etherscan and needs no key, so it
 * is the default when no Etherscan key is configured.
 */
const BLOCKSCOUT_HOSTS: Record<number, string> = {
  1: 'https://eth.blockscout.com',
  10: 'https://optimism.blockscout.com',
  100: 'https://gnosis.blockscout.com',
  8453: 'https://base.blockscout.com',
  42161: 'https://arbitrum.blockscout.com',
}

export function pickSource(chainId: number, apiKey?: string): HistorySource {
  if (apiKey) return 'etherscan'
  if (BLOCKSCOUT_HOSTS[chainId]) return 'blockscout'
  throw new Error(
    `No transaction source for chain ${chainId}. Set ETHERSCAN_API_KEY in .env, ` +
      `or use a chain Blockscout covers (${Object.keys(BLOCKSCOUT_HOSTS).join(', ')}).`,
  )
}

function buildUrl(opts: {
  source: HistorySource
  address: Address
  chainId: number
  limit: number
  startBlock: bigint
  apiKey?: string
}): URL {
  const url =
    opts.source === 'etherscan'
      ? new URL('https://api.etherscan.io/v2/api')
      : new URL(`${BLOCKSCOUT_HOSTS[opts.chainId]}/api`)

  if (opts.source === 'etherscan') {
    url.searchParams.set('chainid', String(opts.chainId))
    url.searchParams.set('apikey', opts.apiKey ?? '')
  }
  url.searchParams.set('module', 'account')
  url.searchParams.set('action', 'txlist')
  url.searchParams.set('address', opts.address)
  url.searchParams.set('startblock', String(opts.startBlock))
  url.searchParams.set('endblock', '99999999')
  url.searchParams.set('page', '1')
  // Etherscan caps offset at 10000 per page.
  url.searchParams.set('offset', String(Math.min(opts.limit, 10_000)))
  url.searchParams.set('sort', 'desc')
  return url
}

/**
 * Transactions the address actually sent, newest first. Transactions merely
 * received are excluded, since we only care about trades the user initiated.
 */
export async function fetchSentTransactions(opts: {
  address: Address
  apiKey?: string
  chainId: number
  limit: number
  startBlock?: bigint
}): Promise<HistoryResult> {
  const source = pickSource(opts.chainId, opts.apiKey)
  const url = buildUrl({ ...opts, source, startBlock: opts.startBlock ?? 0n })

  const res = await fetch(url)
  if (!res.ok) throw new Error(`${source} HTTP ${res.status}`)
  const body = (await res.json()) as { status?: string; message?: string; result?: unknown }

  // An empty result set is the common case for a fresh address, and both
  // explorers signal it with the same failure status as a real error.
  if (body.status !== '1') {
    if (Array.isArray(body.result) && body.result.length === 0) return { entries: [], source }
    const detail = typeof body.result === 'string' ? body.result : ''
    if (/no transactions found|not found|no records/i.test(`${body.message} ${detail}`)) {
      return { entries: [], source }
    }
    throw new Error(`${source}: ${body.message ?? 'request failed'} ${detail}`.trim())
  }

  if (!Array.isArray(body.result)) {
    throw new Error(`${source} returned an unexpected shape: result was not a list`)
  }

  const self = opts.address.toLowerCase()
  return {
    source,
    entries: (body.result as ExplorerTx[])
      .filter((t) => t.from?.toLowerCase() === self && t.isError === '0')
      .map((t) => ({
        hash: t.hash as Hex,
        blockNumber: BigInt(t.blockNumber),
        timestamp: Number(t.timeStamp),
      })),
  }
}
