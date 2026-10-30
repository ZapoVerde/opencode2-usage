import { DateTime, IANAZone } from "luxon"

export const GRANULARITIES = ["hour", "day", "week", "month"] as const
export type Granularity = (typeof GRANULARITIES)[number]

export const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const
export const HOURS = Array.from({ length: 24 }, (_, hour) => hour)

/** Upper bound for a continuous series axis; older buckets are dropped. */
export const MAX_SERIES_BUCKETS = 3_660

/** Safety bound for sparse lookups (pivot, heatmap); the axis only spans observed data. */
const MAX_LOOKUP_BUCKETS = 200_000

export type TimeBucket = {
  readonly start: number
  readonly key: string
  readonly label: string
  /** ISO weekday, 1 = Monday … 7 = Sunday. */
  readonly weekday: number
  readonly hour: number
}

export type BucketAxis = {
  readonly buckets: readonly TimeBucket[]
  /** Index of the last bucket whose start is at or before `ms`, or -1. */
  indexOf(ms: number): number
}

export function isValidTimeZone(zone: string) {
  return IANAZone.isValidZone(zone)
}

/**
 * Build bucket starts with Luxon so the zone's real calendar (including DST
 * transitions) decides each boundary. Event lookups then binary-search the
 * boundary list instead of paying a DateTime construction per event.
 */
export function bucketAxis(
  startMs: number,
  endMs: number,
  zone: string,
  granularity: Granularity,
  limit = MAX_LOOKUP_BUCKETS,
): BucketAxis {
  const last = DateTime.fromMillis(endMs, { zone }).startOf(granularity)
  let first = DateTime.fromMillis(startMs, { zone }).startOf(granularity)
  const units = unitNames(granularity)
  const span = Math.round(last.diff(first, units.diff).as(units.diff) as number) + 1
  if (span > limit) first = first.plus({ [units.add]: span - limit })

  const buckets: TimeBucket[] = []
  let cursor = first
  while (cursor.toMillis() <= last.toMillis() && buckets.length < limit) {
    buckets.push({
      start: cursor.toMillis(),
      key: bucketKey(cursor, granularity),
      label: bucketLabel(cursor, granularity),
      weekday: cursor.weekday,
      hour: cursor.hour,
    })
    cursor = cursor.plus({ [units.add]: 1 })
  }

  return { buckets, indexOf: (ms) => floorIndex(buckets, ms) }
}

/** Continuous axis for `series`, `roundSeries`, and `errorSeries`. */
export function seriesAxis(
  since: number | null,
  firstData: number | null,
  lastData: number | null,
  now: number,
  zone: string,
  granularity: Granularity,
): BucketAxis {
  const start = since ?? firstData
  if (start === null) return { buckets: [], indexOf: () => -1 }
  const end = lastData !== null && lastData > now ? lastData : now
  const seen = new Set<string>()
  const buckets = bucketAxis(start, end, zone, granularity, MAX_SERIES_BUCKETS).buckets.filter((bucket) => {
    if (seen.has(bucket.key)) return false
    seen.add(bucket.key)
    return true
  })
  return { buckets, indexOf: (ms) => floorIndex(buckets, ms) }
}

function bucketKey(at: DateTime, granularity: Granularity) {
  if (granularity === "hour") return at.toFormat("yyyy-MM-dd'T'HH:00")
  return at.toISODate() ?? ""
}

function bucketLabel(at: DateTime, granularity: Granularity) {
  if (granularity === "hour") return at.toFormat("MM-dd HH")
  if (granularity === "day") return at.toFormat("MM-dd")
  if (granularity === "week") return `W${at.weekNumber}`
  return at.toFormat("LLL")
}

function unitNames(granularity: Granularity) {
  if (granularity === "hour") return { add: "hours", diff: "hours" } as const
  if (granularity === "day") return { add: "days", diff: "days" } as const
  if (granularity === "week") return { add: "weeks", diff: "weeks" } as const
  return { add: "months", diff: "months" } as const
}

function floorIndex(buckets: readonly TimeBucket[], ms: number) {
  let low = 0
  let high = buckets.length - 1
  let found = -1
  while (low <= high) {
    const middle = (low + high) >> 1
    const bucket = buckets[middle]
    if (bucket !== undefined && bucket.start <= ms) {
      found = middle
      low = middle + 1
    } else high = middle - 1
  }
  return found
}
