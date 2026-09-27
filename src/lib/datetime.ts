/**
 * DATE/TIME — INDIA STANDARD TIME (Asia/Kolkata, UTC+05:30)
 * ===========================================================================
 *
 * Every timestamp column is stored as `timestamp with time zone`, so storage
 * itself is timezone-agnostic (Postgres always keeps the UTC instant). What
 * varies is DISPLAY and DAY-BOUNDARY BUSINESS LOGIC, and both must be
 * anchored to India Standard Time regardless of the server's or the viewer's
 * local timezone — otherwise two people looking at the same row see two
 * different "days", and a server running in a different timezone would
 * compute a different "today" than the product intends.
 *
 * This module is the single source of truth for both:
 *   - `formatDateTime` / `formatDate` / `formatTime` / `formatShort` — display
 *     formatting, always rendered in IST via `Intl.DateTimeFormat`.
 *   - `startOfIstDay` / `istCalendarDayNumber` / `istCalendarDaysBetween` —
 *     the shared primitive for any "day boundary" business rule (the daily
 *     issuance limit, the 7-day company-sale eligibility window, loan
 *     reminder staging), so every one of those rules agrees on where a day
 *     starts and ends.
 */

export const IST_TIME_ZONE = "Asia/Kolkata";

/** IST is a fixed UTC+05:30 offset — India does not observe daylight saving. */
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

type DateInput = Date | string | number;

function toDate(value: DateInput): Date {
  return value instanceof Date ? value : new Date(value);
}

// ---------------------------------------------------------------------------
// Display formatting
// ---------------------------------------------------------------------------

const dateTimeFormatter = new Intl.DateTimeFormat("en-IN", {
  timeZone: IST_TIME_ZONE,
  day: "2-digit",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: true,
});

const dateFormatter = new Intl.DateTimeFormat("en-IN", {
  timeZone: IST_TIME_ZONE,
  day: "2-digit",
  month: "short",
  year: "numeric",
});

const timeFormatter = new Intl.DateTimeFormat("en-IN", {
  timeZone: IST_TIME_ZONE,
  hour: "2-digit",
  minute: "2-digit",
  hour12: true,
});

/** Compact numeric date, e.g. "27/09/2026" — for tight table cells. */
const shortDateFormatter = new Intl.DateTimeFormat("en-IN", {
  timeZone: IST_TIME_ZONE,
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
});

/** Date + time, always rendered in IST — e.g. "27 Sep 2026, 06:45 pm IST". */
export function formatDateTime(value: DateInput): string {
  return `${dateTimeFormatter.format(toDate(value))} IST`;
}

/** Date only, always rendered in IST — e.g. "27 Sep 2026". */
export function formatDate(value: DateInput): string {
  return dateFormatter.format(toDate(value));
}

/** Time only, always rendered in IST — e.g. "06:45 pm". */
export function formatTime(value: DateInput): string {
  return `${timeFormatter.format(toDate(value))} IST`;
}

/** Compact numeric date, IST — e.g. "27/09/2026". */
export function formatShortDate(value: DateInput): string {
  return shortDateFormatter.format(toDate(value));
}

// ---------------------------------------------------------------------------
// IST calendar-day primitives (for business logic, not display)
// ---------------------------------------------------------------------------

/**
 * The UTC instant corresponding to 00:00:00.000 IST on the calendar day that
 * contains `value` (when read as an IST wall-clock time).
 *
 * This is the shared primitive every "day boundary" rule in the app must use:
 * the daily issuance limit, the company-sale age window, and loan reminder
 * staging. Two Dates that fall on the same IST calendar day always produce
 * the same result here, however far apart they are in real time within that
 * day, and however different the server's own local timezone is.
 */
export function startOfIstDay(value: DateInput): Date {
  const date = toDate(value);
  const istShifted = new Date(date.getTime() + IST_OFFSET_MS);
  const flooredIstMs = Date.UTC(
    istShifted.getUTCFullYear(),
    istShifted.getUTCMonth(),
    istShifted.getUTCDate(),
  );
  return new Date(flooredIstMs - IST_OFFSET_MS);
}

/**
 * A monotonically increasing integer identifying the IST calendar day that
 * `value` falls on (days since the Unix epoch, counted in IST). Two values on
 * the same IST calendar day always return the same number, so subtracting
 * these is the correct way to count "how many IST calendar days apart".
 */
export function istCalendarDayNumber(value: DateInput): number {
  return Math.floor(startOfIstDay(value).getTime() / MS_PER_DAY);
}

/**
 * Whole IST calendar days between `from` and `to` (positive when `to` is
 * later). This is a CALENDAR difference, not an elapsed-duration one: 11pm
 * IST on day 1 to 1am IST on day 2 is `1`, even though under 24 hours passed.
 */
export function istCalendarDaysBetween(from: DateInput, to: DateInput): number {
  return istCalendarDayNumber(to) - istCalendarDayNumber(from);
}

/** True when `a` and `b` fall on the same IST calendar day. */
export function isSameIstDay(a: DateInput, b: DateInput): boolean {
  return istCalendarDayNumber(a) === istCalendarDayNumber(b);
}
