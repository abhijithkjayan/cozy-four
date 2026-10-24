// Night schedule for the price channel alerts that other people (not the watched account) receive.
// Alerts switch off automatically at 11 PM and back on at 7 AM, Canadian Eastern time.
// Turning them on manually at night only lasts 15 minutes, then they switch off again.
export const ALERT_TIME_ZONE = "America/Toronto";
export const NIGHT_START_HOUR = 23;
export const NIGHT_END_HOUR = 7;
export const NIGHT_MANUAL_ON_MS = 15 * 60 * 1000;

const formatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: ALERT_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "numeric",
  hourCycle: "h23",
});

/** The day or night the moment falls in, e.g. "day:2026-10-24" or "night:2026-10-24" (the night starting that evening). */
function alertPeriod(moment: Date) {
  const parts = Object.fromEntries(formatter.formatToParts(moment).map((part) => [part.type, part.value]));
  const year = Number(parts["year"]);
  const month = Number(parts["month"]);
  const day = Number(parts["day"]);
  const hour = Number(parts["hour"]) % 24;
  const night = hour >= NIGHT_START_HOUR || hour < NIGHT_END_HOUR;
  // Early morning belongs to the night that started the previous evening.
  const date = new Date(Date.UTC(year, month - 1, hour < NIGHT_END_HOUR ? day - 1 : day));
  return { night, id: `${night ? "night" : "day"}:${date.toISOString().slice(0, 10)}` };
}

export function isAlertNight(now = new Date()) {
  return alertPeriod(now).night;
}

/**
 * Whether alerts are on right now, given the saved switch and when it was last changed.
 * A change only holds for the day or night it was made in; at 7 AM alerts are on again and at 11 PM off.
 */
export function effectiveAlertsEnabled(enabled: boolean, changedAt: string | null | undefined, now = new Date()) {
  const period = alertPeriod(now);
  const changedMs = changedAt ? Date.parse(changedAt) : Number.NaN;
  const known = Number.isFinite(changedMs);
  const changedThisPeriod = known && alertPeriod(new Date(changedMs)).id === period.id;
  // Daytime: a switch-off from an earlier day or night has expired, so alerts are back on.
  if (!period.night) return known && !changedThisPeriod ? true : enabled;
  return enabled && changedThisPeriod && now.getTime() - changedMs < NIGHT_MANUAL_ON_MS;
}

/** When a manual night-time switch-on runs out, or null if it isn't running. */
export function nightManualOnEndsAt(enabled: boolean, changedAt: string | null | undefined, now = new Date()) {
  if (!isAlertNight(now) || !effectiveAlertsEnabled(enabled, changedAt, now) || !changedAt) return null;
  return new Date(new Date(changedAt).getTime() + NIGHT_MANUAL_ON_MS);
}
