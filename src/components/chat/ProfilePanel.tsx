import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { Tables } from "@/integrations/supabase/types";
import { supabase, type Profile } from "@/lib/supabase";
import { Avatar } from "./Avatar";

type LoginEvent = Tables<"login_activity">;

export function ProfilePanel({
  profile,
  open,
  onOpenChange,
  onStatusSaved,
  editable,
}: {
  profile: Profile;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onStatusSaved: (status: string) => void;
  editable: boolean;
}) {
  const [status, setStatus] = useState(profile.status_text);
  const [events, setEvents] = useState<LoginEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => setStatus(profile.status_text), [profile.id, profile.status_text]);

  useEffect(() => {
    if (!open) return;
    let active = true;
    setLoading(true);
    void supabase
      .from("login_activity")
      .select("*")
      .eq("user_id", profile.id)
      .order("logged_in_at", { ascending: false })
      .limit(30)
      .then(({ data }) => {
        if (active) {
          setEvents(data ?? []);
          setLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [open, profile.id]);

  async function saveStatus() {
    const cleanStatus = status.trim().slice(0, 80);
    setSaving(true);
    setError("");
    const { error: saveError } = await supabase
      .from("profiles")
      .update({ status_text: cleanStatus })
      .eq("id", profile.id);
    setSaving(false);
    if (saveError) {
      setError("Could not save status. Please try again.");
      return;
    }
    setStatus(cleanStatus);
    onStatusSaved(cleanStatus);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85dvh] w-[calc(100%-2rem)] max-w-md overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Profile</DialogTitle>
          <DialogDescription>Your status and recent sign-ins.</DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-3">
          <Avatar p={profile} size={52} />
          <div className="min-w-0">
            <div className="truncate font-semibold">{profile.display_name}</div>
            <div className="truncate text-sm text-muted-foreground">{profile.user_id}</div>
          </div>
        </div>

        <section aria-labelledby="profile-status-heading">
          <h3 id="profile-status-heading" className="mb-2 text-sm font-semibold">
            Status
          </h3>
          {editable ? (
            <>
              <textarea
                value={status}
                onChange={(event) => setStatus(event.target.value.slice(0, 80))}
                maxLength={80}
                rows={2}
                aria-label="Your status"
                placeholder="Set a status"
                className="w-full resize-none rounded-lg border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
              />
              <div className="mt-2 flex items-center justify-between gap-3">
                <span className="text-xs text-muted-foreground">{status.length}/80</span>
                <Button
                  type="button"
                  size="sm"
                  onClick={() => void saveStatus()}
                  disabled={saving || status === profile.status_text}
                >
                  {saving ? "Saving…" : "Save status"}
                </Button>
              </div>
              {error && <p className="mt-2 text-sm text-destructive">{error}</p>}
            </>
          ) : (
            <p className="rounded-lg border bg-muted/40 px-3 py-2 text-sm">
              {profile.status_text || "No status set."}
            </p>
          )}
        </section>

        <section aria-labelledby="login-history-heading">
          <h3 id="login-history-heading" className="mb-2 text-sm font-semibold">
            Recent login activity
          </h3>
          {loading ? (
            <p className="text-sm text-muted-foreground">Loading activity…</p>
          ) : events.length ? (
            <ol className="max-h-52 divide-y overflow-y-auto rounded-lg border">
              {events.map((event) => (
                <li key={event.id} className="px-3 py-2 text-sm">
                  <span>Signed in</span>
                  <time
                    className="mt-0.5 block text-xs text-muted-foreground"
                    dateTime={event.logged_in_at}
                  >
                    {new Date(event.logged_in_at).toLocaleString()}
                  </time>
                </li>
              ))}
            </ol>
          ) : (
            <p className="text-sm text-muted-foreground">No sign-in activity recorded yet.</p>
          )}
        </section>
      </DialogContent>
    </Dialog>
  );
}
