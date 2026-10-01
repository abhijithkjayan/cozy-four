import { useCallback, useEffect, useState } from "react";
import { Phone, PhoneIncoming, PhoneMissed, PhoneOutgoing, Video } from "lucide-react";
import type { Tables } from "@/integrations/supabase/types";
import { supabase, type Profile } from "@/lib/supabase";
import { fmtDur } from "@/lib/format";
import { useCalls } from "./Calls";

type CallRow = Tables<"calls">;

export function CallLog({
  userId,
  profiles,
  onViewProfile,
}: {
  userId: string;
  profiles: Profile[];
  onViewProfile: (profile: Profile) => void;
}) {
  const [calls, setCalls] = useState<CallRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const { startCall, busy } = useCalls();
  const profileById = new Map(profiles.map((profile) => [profile.id, profile]));

  const loadCalls = useCallback(async () => {
    const { data, error } = await supabase
      .from("calls")
      .select("*")
      .or(`caller_id.eq.${userId},receiver_id.eq.${userId}`)
      .order("started_at", { ascending: false })
      .limit(100);
    if (error) {
      setFailed(true);
      setLoading(false);
      return;
    }
    setCalls(data ?? []);
    setFailed(false);
    setLoading(false);
  }, [userId]);

  useEffect(() => {
    void loadCalls();
    const channel = supabase
      .channel(`call-log:${userId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "calls" },
        () => void loadCalls(),
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [loadCalls, userId]);

  if (loading) return <p className="p-4 text-sm text-muted-foreground">Loading calls…</p>;
  if (failed) return <p className="p-4 text-sm text-destructive">Could not load call history.</p>;
  if (!calls.length) return <p className="p-4 text-sm text-muted-foreground">No calls yet.</p>;

  return (
    <ul className="flex-1 overflow-y-auto overscroll-contain">
      {calls.map((call) => {
        const incoming = call.receiver_id === userId;
        const otherId = incoming ? call.caller_id : call.receiver_id;
        const other = profileById.get(otherId);
        const missed = call.status === "missed" || call.status === "declined";
        const Icon = missed ? PhoneMissed : incoming ? PhoneIncoming : PhoneOutgoing;
        const connectedAt = call.connected_at ?? call.started_at;
        const duration =
          call.ended_at && connectedAt
            ? fmtDur((new Date(call.ended_at).getTime() - new Date(connectedAt).getTime()) / 1000)
            : call.status === "active" && connectedAt
              ? fmtDur((Date.now() - new Date(connectedAt).getTime()) / 1000)
              : null;

        return (
          <li key={call.id} className="flex items-center gap-3 border-b px-4 py-3">
            <Icon
              className={missed ? "h-5 w-5 text-destructive" : "h-5 w-5 text-muted-foreground"}
              aria-hidden="true"
            />
            <div className="min-w-0 flex-1">
              <button
                type="button"
                disabled={!other}
                onClick={() => other && onViewProfile(other)}
                className="block max-w-full truncate text-left text-sm font-medium hover:underline"
              >
                {other?.display_name ?? "Unknown contact"}
              </button>
              <div className="text-xs text-muted-foreground">
                {incoming ? "Incoming" : "Outgoing"} {call.type === "video" ? "video" : "voice"}{" "}
                call
                {missed ? " · Missed" : duration ? ` · ${duration}` : ` · ${call.status}`}
              </div>
              <time
                className="text-xs text-muted-foreground"
                dateTime={call.started_at ?? undefined}
              >
                {call.started_at ? new Date(call.started_at).toLocaleString() : "Time unavailable"}
              </time>
            </div>
            <button
              type="button"
              disabled={busy || !other}
              onClick={() => other && void startCall(other, call.type === "video")}
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-muted disabled:opacity-40"
              aria-label={`Call ${other?.display_name ?? "contact"} again`}
              title={call.type === "video" ? "Video call again" : "Voice call again"}
            >
              {call.type === "video" ? <Video size={18} /> : <Phone size={18} />}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
