export type SummaryInput = {
  since?: string
  model?: string | null
  calls?: number | string | null
  costUSD?: number | string | null
  tokens?: number | string | null
  ttftAvg?: number | string | null
  ttftP95?: number | string | null
  tps?: number | string | null
  cacheHitRate?: number | string | null
  rounds?: number | string | null
  roundP50?: number | string | null
  callErrorRate?: number | null
  failedCalls?: number | null
  interruptedCalls?: number | null
  timeouts?: number | null
  retries?: number | null
}

export function summarize(input: SummaryInput): string
export function formatTokens(value: number): string
export function formatCost(value: number): string
export function formatDuration(value: number): string
export function formatTPS(value: number): string
export function formatInt(value: number): string
export function formatPercent(value: number): string
