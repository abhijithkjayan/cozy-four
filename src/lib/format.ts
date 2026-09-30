export const fmtTime = (d: string | Date) =>
  new Date(d).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();

export function dayLabel(d: string | Date) {
  const date = new Date(d);
  const now = new Date();
  const y = new Date(); y.setDate(now.getDate() - 1);
  if (sameDay(date, now)) return "Today";
  if (sameDay(date, y)) return "Yesterday";
  return date.toLocaleDateString([], { day: "numeric", month: "long", year: date.getFullYear() === now.getFullYear() ? undefined : "numeric" });
}

export function listTime(d: string) {
  const date = new Date(d);
  const l = dayLabel(date);
  if (l === "Today") return fmtTime(date);
  if (l === "Yesterday") return l;
  return date.toLocaleDateString([], { day: "2-digit", month: "2-digit", year: "2-digit" });
}

export const fmtDur = (s: number) => {
  s = Math.max(0, Math.round(s));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

export function lastSeen(d: string | null) {
  if (!d) return "offline";
  const l = dayLabel(d);
  return `last seen ${l === "Today" ? "today" : l === "Yesterday" ? "yesterday" : l} at ${fmtTime(d)}`;
}
