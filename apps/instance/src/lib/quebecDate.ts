/** Today's date in Quebec (America/Toronto) as YYYY-MM-DD. The server runs in UTC, which is already "tomorrow" in the evening. */
export const quebecToday = (now: Date = new Date()): string =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
