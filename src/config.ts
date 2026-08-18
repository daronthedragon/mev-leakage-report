import 'dotenv/config'

export interface Config {
  rpcUrl: string
  /** Optional. Without it, history comes from Blockscout, which needs no key. */
  etherscanKey?: string
  chainId: number
  usingDefaultRpc: boolean
}

/**
 * Public endpoint used when none is configured. Fine for trying the tool out;
 * a dedicated endpoint is faster and will not rate limit a long scan.
 */
const DEFAULT_RPC = 'https://eth.drpc.org'

export function loadConfig(): Config {
  const rpcUrl = process.env.RPC_URL?.trim()
  const etherscanKey = process.env.ETHERSCAN_API_KEY?.trim()
  const chainId = Number(process.env.CHAIN_ID ?? 1)

  if (!Number.isInteger(chainId) || chainId <= 0) {
    throw new Error(`CHAIN_ID must be a positive integer, got "${process.env.CHAIN_ID}"`)
  }
  if (!rpcUrl && chainId !== 1) {
    throw new Error(`RPC_URL must be set for chain ${chainId}. The built-in default is mainnet only.`)
  }

  return {
    rpcUrl: rpcUrl || DEFAULT_RPC,
    etherscanKey: etherscanKey || undefined,
    chainId,
    usingDefaultRpc: !rpcUrl,
  }
}
