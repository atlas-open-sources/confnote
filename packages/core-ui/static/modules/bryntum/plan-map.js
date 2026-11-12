/* Planner data mapping, kept free of DOM and Bryntum so node can test it.
 *
 *   Concierge plan → "My plan" row: the model may only pick events from the
 *   list it was given; ids, dates and times are checked, its note is text.
 *   Wallet ledger → "Credits" row: one bar per metered AI step, purchase,
 *   promo or auto top-up, at its time.
 */
(() => {
  const PLAN_RESOURCE = "my-plan";
  const CREDITS_RESOURCE = "credits";
  const DEFAULT_START = "09:00";
  const DEFAULT_END = "17:00";
  const NOTE_MAX = 140;
  const NAME_MAX = 120;
  // A ledger entry is an instant; give its bar a width that reads when zoomed to the hour.
  const LEDGER_BAR_MS = 5 * 60000;
  // PayPal order and capture ids: upper-case letters and digits, 17 of them today.
  const PAYPAL_REF = /^[A-Z0-9]{12,24}$/;
  const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
  const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

  function text(value, max) {
    return String(value == null ? "" : value)
      .replace(/[\r\n\t]+/g, " ")
      .trim()
      .slice(0, max);
  }

  // Local calendar day, not the UTC one toISOString would give.
  function localDay(date) {
    const pad = (n) => String(n).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }

  function localTime(date) {
    return date.toTimeString().slice(0, 5);
  }

  function daysBetween(from, to) {
    const days = [];
    const cursor = new Date(from + "T00:00:00");
    const last = new Date(to + "T00:00:00");
    while (cursor <= last) {
      days.push(localDay(cursor));
      cursor.setDate(cursor.getDate() + 1);
    }
    return days;
  }

  function jsonFrom(reply) {
    const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(reply);
    const body = fenced ? fenced[1] : reply.slice(reply.indexOf("{"), reply.lastIndexOf("}") + 1);
    try {
      return JSON.parse(body);
    } catch {
      return null;
    }
  }

  /** Model reply → plan days, keeping only picks that name a listed event on one of its days in the trip. */
  function parsePlan(reply, trip, candidates) {
    const parsed = jsonFrom(String(reply || ""));
    const raw = parsed && Array.isArray(parsed.days) ? parsed.days : null;
    if (!raw) return null;
    const byId = new Map(candidates.map((e) => [e.id, e]));
    const tripDays = new Set(daysBetween(trip.from, trip.to));
    const seen = new Set();
    const days = [];
    for (const item of raw) {
      if (!item || typeof item !== "object") continue;
      const event = byId.get(item.eventId);
      const date = typeof item.date === "string" && ISO_DAY.test(item.date) ? item.date : null;
      if (!event || !date || !tripDays.has(date)) continue;
      if (date < event.start.slice(0, 10) || date > event.end.slice(0, 10)) continue;
      const key = date + "|" + event.id;
      if (seen.has(key)) continue;
      seen.add(key);
      let start = HHMM.test(item.start) ? item.start : DEFAULT_START;
      let end = HHMM.test(item.end) ? item.end : DEFAULT_END;
      if (end <= start) {
        start = DEFAULT_START;
        end = DEFAULT_END;
      }
      days.push({ date, eventId: event.id, start, end, note: text(item.note, NOTE_MAX) });
    }
    return days.sort((a, b) => (a.date + a.start < b.date + b.start ? -1 : 1));
  }

  /** Plan days → Bryntum events on the My plan row. */
  function planToEvents(days, candidates) {
    const byId = new Map(candidates.map((e) => [e.id, e]));
    return days
      .filter((day) => byId.has(day.eventId))
      .map((day) => ({
        id: `plan:${day.date}:${day.eventId}`,
        resourceId: PLAN_RESOURCE,
        name: text(byId.get(day.eventId).name, NAME_MAX),
        startDate: new Date(`${day.date}T${day.start}:00`),
        endDate: new Date(`${day.date}T${day.end}:00`),
        eventId: day.eventId,
        // Not "note": Bryntum 7 events have a built-in note field of their own.
        why: day.note || "",
        kind: "plan",
        cls: "cn-plan",
      }));
  }

  /** A moved or resized plan bar → the stored plan day. */
  function eventToPlanDay(record) {
    return {
      date: localDay(record.startDate),
      eventId: record.eventId,
      start: localTime(record.startDate),
      end: localTime(record.endDate),
      note: record.why || "",
    };
  }

  function usd(value) {
    const n = Number(value);
    const sign = n < 0 ? "−" : "+";
    const abs = Math.abs(n);
    return sign + "$" + (abs >= 1 ? abs.toFixed(2) : abs.toFixed(4));
  }

  /** /api/wallet/usage rows → Bryntum events on the Credits row. */
  function ledgerToEvents(rows) {
    const events = [];
    for (const [index, row] of (rows || []).entries()) {
      const at = new Date(row && row.at);
      const amount = Number(row && row.charged);
      if (Number.isNaN(at.getTime()) || !Number.isFinite(amount)) continue;
      const charge = amount < 0;
      const ref = text(row.ref, 64);
      events.push({
        id: `ledger:${ref || index}:${at.getTime()}`,
        resourceId: CREDITS_RESOURCE,
        name: usd(amount),
        startDate: at,
        endDate: new Date(at.getTime() + LEDGER_BAR_MS),
        kind: charge ? "charge" : "grant",
        reason: text(row.reason, 40),
        model: text(row.model, 80),
        amount: usd(amount),
        balanceAfter: row.balanceAfter == null ? "" : "$" + Number(row.balanceAfter).toFixed(4),
        paypalRef: !charge && PAYPAL_REF.test(ref) ? ref : "",
        ref,
        cls: charge ? "cn-charge" : "cn-grant",
        draggable: false,
        resizable: false,
      });
    }
    return events;
  }

  /** Tooltip lines for a Credits bar (the caller encodes each line). */
  function ledgerLines(event) {
    const lines = [
      (event.kind === "charge" ? "AI step" : "Credits added") +
        (event.reason ? " · " + event.reason : ""),
      "Amount: " + event.amount,
    ];
    if (event.model) lines.push("Model: " + event.model);
    if (event.balanceAfter) lines.push("Balance after: " + event.balanceAfter);
    if (event.paypalRef) lines.push("PayPal ref: " + event.paypalRef);
    else if (event.ref && event.kind === "grant") lines.push("Ledger ref: " + event.ref);
    return lines;
  }

  const api = {
    PLAN_RESOURCE,
    CREDITS_RESOURCE,
    parsePlan,
    planToEvents,
    eventToPlanDay,
    ledgerToEvents,
    ledgerLines,
    localDay,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else globalThis.confnoteBryntumMap = api;
})();
