import pc from 'picocolors'
import { formatEther, formatUnits } from 'viem'
import type { PricedSandwich, Report, TokenMeta } from './types.js'

const RULE = '─'.repeat(66)

/** Matches SGR colour codes so padding can measure visible width. */
const ANSI = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g')

function amount(raw: bigint, token: TokenMeta): string {
  const value = Number(formatUnits(raw, token.decimals))
  if (value === 0) return `0 ${token.symbol}`

  const magnitude = Math.abs(value)
  // Dust would round to a bare "0" and read as nothing at all.
  if (magnitude < 0.000001) return `${value < 0 ? '-' : ''}<0.000001 ${token.symbol}`

  let text = value.toFixed(magnitude >= 1 ? 4 : 6)
  if (text.includes('.')) text = text.replace(/0+$/, '').replace(/\.$/, '')
  return `${text} ${token.symbol}`
}

function usd(value: number | null): string {
  if (value === null) return pc.dim('unpriced')
  const formatted = Math.abs(value).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
  return `${value < 0 ? '-' : ''}$${formatted}`
}

function confidenceLabel(score: number): string {
  if (score >= 0.9) return pc.red('high')
  if (score >= 0.7) return pc.yellow('medium')
  return pc.dim('low')
}

function pad(text: string, width: number): string {
  const visible = text.replace(ANSI, '').length
  return text + ' '.repeat(Math.max(0, width - visible))
}

/** Short note on how the two attacker legs were tied together. */
function linkNote(s: PricedSandwich): string {
  if (s.sameOrigin) return 'same sender'
  if (s.sameTarget) return 'same contract'
  return 'linked by pool actor'
}

function renderSandwich(s: PricedSandwich, index: number): string {
  const pair = `${s.pool.token0.symbol}/${s.pool.token1.symbol}`
  const lines = [
    `${pc.bold(`#${index + 1}`)}  block ${pc.cyan(String(s.victim.blockNumber))}  ${pc.bold(pair)}  ${confidenceLabel(s.confidence)}`,
    `    your swap      ${pc.dim(s.victim.txHash)}`,
    `    extracted      ${pc.red(amount(s.attackerProfit, s.attackerProfitToken))}  ${usd(s.extractedUsd)}`,
  ]

  if (s.victimShortfall !== null) {
    lines.push(
      `    you received   ${pc.yellow(amount(s.victimShortfall, s.victimShortfallToken))} less than a clean fill  ${usd(s.shortfallUsd)}`,
    )
  }

  // Dust left over from integer rounding is not a partial unwind.
  if (Math.abs(s.unwindRatio - 1) >= 0.005) {
    lines.push(
      pc.dim(
        `    partial unwind ${(s.unwindRatio * 100).toFixed(1)}% closed, ` +
          `${amount(s.residual, s.victimShortfallToken)} left held`,
      ),
    )
  }

  lines.push(
    `    attacker gas   ${formatEther(s.attackerGasWei)} ETH  ${pc.dim(`(${linkNote(s)})`)}`,
    `    frontrun       ${pc.dim(s.frontrun.txHash)}`,
    `    backrun        ${pc.dim(s.backrun.txHash)}`,
  )

  return lines.join('\n')
}

export function renderReport(report: Report): string {
  const out: string[] = []

  out.push('')
  out.push(pc.bold(pc.magenta('  MEV Leakage Report')))
  out.push(`  ${pc.dim(report.address)}`)
  out.push('')
  out.push(
    `  Scanned ${pc.bold(String(report.swapsScanned))} swaps across ${pc.bold(String(report.blocksScanned))} blocks ` +
      pc.dim(`(blocks ${report.fromBlock}-${report.toBlock}, history via ${report.source})`),
  )
  out.push('')

  if (report.sandwiches.length === 0) {
    out.push(pc.green('  No sandwiches detected. Either you route through private mempools,'))
    out.push(pc.green('  trade illiquid pairs bots ignore, or you have been lucky.'))
    if (report.discardedCount > 0) {
      out.push('')
      out.push(
        pc.dim(
          `  ${report.discardedCount} bracketed trade(s) were found but discarded as unprofitable.`,
        ),
      )
      out.push(pc.dim('  Pass --include-unprofitable to see them.'))
    }
    out.push('')
    return out.join('\n')
  }

  const worst = report.sandwiches.reduce((max, s) => Math.max(max, s.extractedUsd ?? 0), 0)

  out.push(`  ${RULE}`)
  out.push(`  ${pad('Sandwiches found', 24)}${pc.bold(String(report.sandwiches.length))}`)
  out.push(
    `  ${pad('Value extracted', 24)}${pc.bold(pc.red(usd(report.totalExtractedUsd)))}` +
      (report.unpricedCount > 0 ? pc.dim(`  (${report.unpricedCount} unpriced)`) : ''),
  )
  out.push(`  ${pad('Worst single hit', 24)}${usd(worst)}`)
  if (report.discardedCount > 0) {
    out.push(`  ${pad('Discarded as unprofitable', 24)}${pc.dim(String(report.discardedCount))}`)
  }
  out.push(`  ${RULE}`)
  out.push('')

  report.sandwiches.forEach((s, i) => {
    out.push(renderSandwich(s, i))
    out.push('')
  })

  out.push(pc.dim('  Extracted value is the attacker round trip, priced at current spot.'))
  out.push(pc.dim('  Shortfall is the exact counterfactual fill, V2 pools only.'))
  out.push('')

  return out.join('\n')
}

/** Machine-readable output for piping into other tools. */
export function renderJson(report: Report): string {
  return JSON.stringify(
    report,
    (_key, value) => (typeof value === 'bigint' ? value.toString() : value),
    2,
  )
}
