const MISSING = "—"

function finite(value: number | null | undefined): value is number {
  return value !== null && value !== undefined && Number.isFinite(value)
}

// Compact token counts: `999`, `1.2k`, `3.4m`.
export function humanizeTokens(value: number | null | undefined) {
  if (!finite(value)) return MISSING
  const units = [
    { size: 1_000_000_000, suffix: "b" },
    { size: 1_000_000, suffix: "m" },
    { size: 1_000, suffix: "k" },
  ]
  const unit = units.find((candidate) => Math.abs(value) >= candidate.size)
  if (!unit) return String(Math.round(value))
  const scaled = value / unit.size
  const text = Math.abs(scaled) >= 100 ? scaled.toFixed(0) : scaled.toFixed(1)
  return `${text.replace(/\.0$/, "")}${unit.suffix}`
}

// Exact zero is `$0`; positive amounts below one tenth of a cent are `<$0.001`.
export function humanizeCost(value: number | null | undefined) {
  if (!finite(value)) return MISSING
  if (value === 0) return "$0"
  if (Math.abs(value) < 0.001) return "<$0.001"
  return `$${value.toFixed(4).replace(/0+$/, "").replace(/\.$/, "")}`
}

export function humanizeDuration(value: number | null | undefined) {
  if (!finite(value)) return MISSING
  const milliseconds = Math.max(0, value)
  if (milliseconds < 1_000) return `${Math.round(milliseconds)}ms`
  if (milliseconds < 60_000) return `${(milliseconds / 1_000).toFixed(1)}s`
  if (milliseconds < 3_600_000) return `${(milliseconds / 60_000).toFixed(1)}m`
  return `${(milliseconds / 3_600_000).toFixed(1)}h`
}

export function humanizeTPS(value: number | null | undefined) {
  if (!finite(value)) return MISSING
  return value.toFixed(1)
}

export function humanizeRate(value: number | null | undefined) {
  if (!finite(value)) return MISSING
  return `${(value * 100).toFixed(1)}%`
}

export function retryLabel(value: number | null | undefined) {
  if (!finite(value) || value <= 0) return MISSING
  return String(Math.round(value))
}

export function errorLabel(value: string | null | undefined) {
  return value ?? "(none)"
}

export function formatDateTime(value: number | null | undefined) {
  if (!finite(value)) return MISSING
  const date = new Date(value)
  return `${formatDate(value)} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`
}

export function formatDate(value: number | null | undefined) {
  if (!finite(value)) return MISSING
  const date = new Date(value)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`
}

// The short form is the first ten characters after `ses_`, matching the CLI's session filter.
export function shortSession(sessionID: string) {
  const prefix = "ses_"
  return sessionID.startsWith(prefix) ? sessionID.slice(prefix.length, prefix.length + 10) : sessionID.slice(0, 10)
}

export function modelLabel(providerID: string | null, modelID: string | null) {
  if (providerID === null && modelID === null) return MISSING
  return `${providerID ?? MISSING}/${modelID ?? MISSING}`
}

export function tokenTriple(input: number | null, output: number | null, reasoning: number | null) {
  if (input === null && output === null && reasoning === null) return MISSING
  return `${humanizeTokens(input)}/${humanizeTokens(output)}/${humanizeTokens(reasoning)}`
}

export function cachePair(read: number | null, write: number | null) {
  if (read === null && write === null) return MISSING
  return `${humanizeTokens(read)}/${humanizeTokens(write)}`
}

export function statusLabel(kind: string, status: string) {
  if (kind !== "compaction") return status
  return status === "completed" ? "compaction" : `${status} (compaction)`
}

export type Align = "left" | "right"

// Width-aware truncation, so wide glyphs do not push a column out of alignment.
export function truncate(text: string, maxWidth: number) {
  if (Bun.stringWidth(text) <= maxWidth) return text
  const chars: string[] = []
  let width = 0
  for (const char of text) {
    const next = width + Bun.stringWidth(char)
    if (next > maxWidth - 1) break
    chars.push(char)
    width = next
  }
  return `${chars.join("")}…`
}

// Error messages can contain multi-line provider text; keep one compact line.
export function singleLine(text: string | null | undefined, maxWidth: number) {
  if (text === null || text === undefined) return MISSING
  const collapsed = text.replace(/\s+/g, " ").trim()
  if (collapsed.length === 0) return MISSING
  return truncate(collapsed, maxWidth)
}

export function renderTable(
  headers: readonly string[],
  rows: readonly (readonly string[])[],
  aligns: readonly Align[],
) {
  const widths = headers.map((header, column) =>
    Math.max(Bun.stringWidth(header), ...rows.map((row) => Bun.stringWidth(row[column] ?? ""))),
  )
  const line = (cells: readonly string[]) =>
    cells
      .map((cell, column) => {
        const width = widths[column] ?? 0
        const padding = " ".repeat(Math.max(0, width - Bun.stringWidth(cell)))
        return aligns[column] === "right" ? `${padding}${cell}` : `${cell}${padding}`
      })
      .join("  ")
      .trimEnd()
  const separator = widths.map((width) => "-".repeat(width)).join("  ")
  return [line(headers), separator, ...rows.map(line)].join("\n")
}
