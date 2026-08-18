import type { Address, Hex } from 'viem'

/** Which way a swap moved through the pool, expressed in token index terms. */
export type Direction = '0->1' | '1->0'

/** A single decoded DEX swap, normalised across Uniswap V2 and V3 shapes. */
export interface Swap {
  pool: Address
  protocol: 'v2' | 'v3'
  blockNumber: bigint
  txHash: Hex
  /** Position of the transaction within the block. Decides frontrun vs backrun. */
  txIndex: number
  /** Position of the log within the block. Orders swaps inside one transaction. */
  logIndex: number
  direction: Direction
  /** Amount of the input token the pool received, in raw token units. */
  amountIn: bigint
  /** Amount of the output token the pool paid out, in raw token units. */
  amountOut: bigint
  /** Event-level actor fields. Used to link a frontrun to its backrun. */
  sender: Address
  recipient: Address
}

/** Reserves after a V2 swap, taken from the Sync event that follows it. */
export interface SyncPoint {
  pool: Address
  logIndex: number
  reserve0: bigint
  reserve1: bigint
}

export interface TokenMeta {
  address: Address
  symbol: string
  decimals: number
}

export interface PoolMeta {
  address: Address
  token0: TokenMeta
  token1: TokenMeta
}

/** One detected sandwich: a frontrun and backrun bracketing a victim swap. */
export interface Sandwich {
  victim: Swap
  frontrun: Swap
  backrun: Swap
  pool: PoolMeta
  /** True when frontrun and backrun share a transaction sender. */
  sameOrigin: boolean
  /** True when both attacker legs called the same contract. */
  sameTarget: boolean
  /**
   * True when the two legs are linked by an address that is not simply the
   * router the victim also used. Weak links need transaction-level proof.
   */
  strongLink: boolean
  /** Heuristic strength of the match, 0 to 1. */
  confidence: number
  /** backrun input over frontrun output. 1.0 is a clean, complete unwind. */
  unwindRatio: number
  /**
   * Profit the attacker cycled out, in raw units of the token they started
   * with. Includes any inventory left unsold, valued at the price the backrun
   * itself executed at, so a partial unwind is not mistaken for a loss.
   */
  attackerProfit: bigint
  attackerProfitToken: TokenMeta
  /**
   * Output-token inventory the attacker kept rather than selling back.
   * Zero for a complete unwind.
   */
  residual: bigint
  /**
   * What the victim would have received with no frontrun, minus what they
   * actually received. Exact for V2, null for V3 where we cannot reconstruct
   * concentrated liquidity from events alone.
   */
  victimShortfall: bigint | null
  victimShortfallToken: TokenMeta
  /** Gas the attacker burned on both legs, in wei. Subtract for net profit. */
  attackerGasWei: bigint
}

export interface PricedSandwich extends Sandwich {
  /** Extracted value in USD, or null when no price could be resolved. */
  extractedUsd: number | null
  /** Victim shortfall in USD, or null. */
  shortfallUsd: number | null
}

export interface Report {
  address: Address
  swapsScanned: number
  blocksScanned: number
  sandwiches: PricedSandwich[]
  totalExtractedUsd: number
  /** Sandwiches whose USD value could not be resolved. */
  unpricedCount: number
  /** Bracketed trades dropped because the round trip did not turn a profit. */
  discardedCount: number
  /** Where the transaction list came from. */
  source: string
  fromBlock: bigint
  toBlock: bigint
}
