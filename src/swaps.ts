import { decodeEventLog, type Address, type Log, type PublicClient } from 'viem'
import {
  TOPIC_V2_SWAP,
  TOPIC_V2_SYNC,
  TOPIC_V3_SWAP,
  V2_SWAP,
  V2_SYNC,
  V3_SWAP,
} from './abi.js'
import type { Swap, SyncPoint } from './types.js'

/**
 * Turn a raw log into a normalised Swap, or null if it is not a swap we
 * understand. V2 and V3 encode the same event name with different shapes, so
 * both are collapsed into a single in/out representation here.
 */
export function decodeSwapLog(log: Log): Swap | null {
  const topic0 = log.topics[0]
  if (!topic0) return null
  if (log.blockNumber === null || log.transactionIndex === null || log.logIndex === null) {
    return null
  }
  if (log.transactionHash === null) return null

  const base = {
    pool: log.address as Address,
    blockNumber: log.blockNumber,
    txHash: log.transactionHash,
    txIndex: log.transactionIndex,
    logIndex: log.logIndex,
  }

  try {
    if (topic0 === TOPIC_V2_SWAP) {
      const { args } = decodeEventLog({ abi: [V2_SWAP], data: log.data, topics: log.topics })
      const zeroIn = args.amount0In > 0n
      // A genuine swap is one-sided in each direction. Anything else is a fork
      // with different semantics, and its amounts would not be comparable.
      if (args.amount0In > 0n && args.amount1In > 0n) return null
      if (args.amount0Out > 0n && args.amount1Out > 0n) return null
      const amountIn = zeroIn ? args.amount0In : args.amount1In
      const amountOut = zeroIn ? args.amount1Out : args.amount0Out
      if (amountIn <= 0n || amountOut <= 0n) return null
      return {
        ...base,
        protocol: 'v2',
        direction: zeroIn ? '0->1' : '1->0',
        amountIn,
        amountOut,
        sender: args.sender,
        recipient: args.to,
      }
    }

    if (topic0 === TOPIC_V3_SWAP) {
      const { args } = decodeEventLog({ abi: [V3_SWAP], data: log.data, topics: log.topics })
      // Signed amounts: positive is what the pool received, negative what it
      // paid. One of each, always. Same-sign pairs come from forks that reuse
      // the topic with different meaning, and would yield negative quantities.
      if (args.amount0 === 0n || args.amount1 === 0n) return null
      if (args.amount0 > 0n === args.amount1 > 0n) return null
      const zeroIn = args.amount0 > 0n
      return {
        ...base,
        protocol: 'v3',
        direction: zeroIn ? '0->1' : '1->0',
        amountIn: zeroIn ? args.amount0 : args.amount1,
        amountOut: zeroIn ? -args.amount1 : -args.amount0,
        sender: args.sender,
        recipient: args.recipient,
      }
    }
  } catch {
    // Forks sometimes reuse the topic with a different payload. Skip them.
    return null
  }

  return null
}

/** Reserves snapshot emitted after each V2 swap. Keyed by log position. */
export function decodeSyncLog(log: Log): SyncPoint | null {
  if (log.topics[0] !== TOPIC_V2_SYNC || log.logIndex === null) return null
  try {
    const { args } = decodeEventLog({ abi: [V2_SYNC], data: log.data, topics: log.topics })
    return {
      pool: log.address as Address,
      logIndex: log.logIndex,
      reserve0: args.reserve0,
      reserve1: args.reserve1,
    }
  } catch {
    return null
  }
}

/** Every swap the given transaction produced. These are the user's own trades. */
export async function fetchSwapsInTx(client: PublicClient, txHash: `0x${string}`): Promise<Swap[]> {
  const receipt = await client.getTransactionReceipt({ hash: txHash })
  return receipt.logs.map(decodeSwapLog).filter((s): s is Swap => s !== null)
}

/**
 * All activity on one pool within one block. Filtering by pool address keeps
 * this cheap enough to run against a free RPC tier.
 */
export async function fetchPoolActivity(
  client: PublicClient,
  pool: Address,
  blockNumber: bigint,
): Promise<{ swaps: Swap[]; syncs: SyncPoint[] }> {
  const logs = await client.getLogs({ address: pool, fromBlock: blockNumber, toBlock: blockNumber })
  const swaps: Swap[] = []
  const syncs: SyncPoint[] = []
  for (const log of logs) {
    const swap = decodeSwapLog(log)
    if (swap) {
      swaps.push(swap)
      continue
    }
    const sync = decodeSyncLog(log)
    if (sync) syncs.push(sync)
  }
  // Block order is transaction order, then log order inside a transaction.
  swaps.sort((a, b) => a.txIndex - b.txIndex || a.logIndex - b.logIndex)
  syncs.sort((a, b) => a.logIndex - b.logIndex)
  return { swaps, syncs }
}
