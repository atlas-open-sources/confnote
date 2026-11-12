/** Calendar day at the event location; unknown zones preserve the timestamp offset. */
export function localDay(start: string, timezone?: string | null): string {
  if (!timezone || start.length === 10) return start.slice(0, 10);
  const parts = new Intl.DateTimeFormat("en", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(start));
  function part(type: string): string { return parts.find(value => value.type === type)!.value; }
  return `${part("year")}-${part("month")}-${part("day")}`;
}
