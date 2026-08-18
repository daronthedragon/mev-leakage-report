import { getAddress, type Address, type PublicClient } from 'viem'
import { ERC20_ABI, POOL_ABI } from './abi.js'
import type { PoolMeta, TokenMeta } from './types.js'

/** Multicall3, deployed at the same address on every major chain. */
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11' as const

const poolCache = new Map<string, PoolMeta>()
const tokenCache = new Map<string, TokenMeta>()

function shortAddress(address: Address): string {
  return address.slice(0, 6) + '..' + address.slice(-4)
}

async function resolveToken(client: PublicClient, address: Address): Promise<TokenMeta> {
  const key = address.toLowerCase()
  const cached = tokenCache.get(key)
  if (cached) return cached

  const results = await client.multicall({
    multicallAddress: MULTICALL3,
    allowFailure: true,
    contracts: [
      { address, abi: ERC20_ABI, functionName: 'symbol' },
      { address, abi: ERC20_ABI, functionName: 'decimals' },
    ],
  })

  // Pre-ERC20 tokens return bytes32 symbols and fail to decode. Degrade to the
  // address rather than dropping the sandwich entirely.
  const symbol = results[0]?.status === 'success' ? String(results[0].result) : shortAddress(address)
  const decimals = results[1]?.status === 'success' ? Number(results[1].result) : 18

  const meta: TokenMeta = { address, symbol, decimals }
  tokenCache.set(key, meta)
  return meta
}

export async function resolvePool(client: PublicClient, pool: Address): Promise<PoolMeta> {
  const key = pool.toLowerCase()
  const cached = poolCache.get(key)
  if (cached) return cached

  const results = await client.multicall({
    multicallAddress: MULTICALL3,
    allowFailure: true,
    contracts: [
      { address: pool, abi: POOL_ABI, functionName: 'token0' },
      { address: pool, abi: POOL_ABI, functionName: 'token1' },
    ],
  })

  if (results[0]?.status !== 'success' || results[1]?.status !== 'success') {
    throw new Error(pool + ' does not expose token0/token1, not a recognised pool')
  }

  const [token0, token1] = await Promise.all([
    resolveToken(client, getAddress(results[0].result as Address)),
    resolveToken(client, getAddress(results[1].result as Address)),
  ])

  const meta: PoolMeta = { address: pool, token0, token1 }
  poolCache.set(key, meta)
  return meta
}
