import { parseAbiItem, toEventSelector } from 'viem'

/** Uniswap V2 and every fork that copied its Pair contract verbatim. */
export const V2_SWAP = parseAbiItem(
  'event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)',
)

/** Emitted after every V2 swap. Gives us exact reserves with no archive node. */
export const V2_SYNC = parseAbiItem('event Sync(uint112 reserve0, uint112 reserve1)')

/** Uniswap V3 and forks. Amounts are signed: positive means the pool received. */
export const V3_SWAP = parseAbiItem(
  'event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)',
)

export const TOPIC_V2_SWAP = toEventSelector(V2_SWAP)
export const TOPIC_V2_SYNC = toEventSelector(V2_SYNC)
export const TOPIC_V3_SWAP = toEventSelector(V3_SWAP)

/** Minimal reads needed to label a pool and its tokens. */
export const POOL_ABI = [
  parseAbiItem('function token0() view returns (address)'),
  parseAbiItem('function token1() view returns (address)'),
] as const

export const ERC20_ABI = [
  parseAbiItem('function symbol() view returns (string)'),
  parseAbiItem('function decimals() view returns (uint8)'),
] as const
