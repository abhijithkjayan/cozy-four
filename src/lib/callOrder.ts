type CallStamp = { id: string; ts?: string | undefined };

// Two people called each other at once: both sides must pick the same call.
// The earlier server timestamp wins; the call id settles exact ties and missing timestamps.
export function firstCallWins(mine: CallStamp, theirs: CallStamp): boolean {
  const a = Date.parse(mine.ts ?? "");
  const b = Date.parse(theirs.ts ?? "");
  if (!Number.isNaN(a) && !Number.isNaN(b) && a !== b) return a < b;
  return mine.id < theirs.id;
}
