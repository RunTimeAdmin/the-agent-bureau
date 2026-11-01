// The retention baseline (Phase 0 decision 5), shared by the intake, which
// takes a packet sealed elsewhere only if it will be erased within this long of
// its seal, and the evidence check, which takes no charge older than this.
export const RETENTION_MONTHS = 24;

/** Adds calendar months in UTC, clamping to the month's last day as CounterAudit does. */
export function addMonthsUtc(date: Date, months: number): Date {
  const out = new Date(date.getTime());
  const day = out.getUTCDate();
  out.setUTCDate(1);
  out.setUTCMonth(out.getUTCMonth() + months);
  const lastDay = new Date(
    Date.UTC(out.getUTCFullYear(), out.getUTCMonth() + 1, 0)
  ).getUTCDate();
  out.setUTCDate(Math.min(day, lastDay));
  return out;
}
