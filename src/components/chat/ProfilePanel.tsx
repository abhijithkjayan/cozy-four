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
import { WATCHED_USER_ID } from "@/lib/telegram.functions";
import { Avatar } from "./Avatar";

type LoginEvent = Tables<"login_activity">;

export function ProfilePanel({
  profile,
  open,
  onOpenChange,
  onStatusSaved,
  onTelegramAlertsSaved,
  onOnlineVisibilitySaved,
  onReadReceiptsSaved,
  editable,
}: {
  profile: Profile;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onStatusSaved: (status: string) => void;
  onTelegramAlertsSaved: (enabled: boolean) => void;
  onOnlineVisibilitySaved: (enabled: boolean) => void;
  onReadReceiptsSaved: (enabled: boolean) => void;
  editable: boolean;
}) {
  const [status, setStatus] = useState(profile.status_text ?? "");
  const [events, setEvents] = useState<LoginEvent[]>([]);
  const [telegramAlertsEnabled, setTelegramAlertsEnabled] = useState(
    profile.telegram_alerts_enabled,
  );
  const [showOnlineStatus, setShowOnlineStatus] = useState(profile.show_online_status);
  const [readReceiptsEnabled, setReadReceiptsEnabled] = useState(profile.read_receipts_enabled);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [activityError, setActivityError] = useState("");
  const [alertsSaving, setAlertsSaving] = useState(false);
  const [alertsError, setAlertsError] = useState("");

  useEffect(() => setStatus(profile.status_text ?? ""), [profile.id, profile.status_text]);
  useEffect(
    () => setTelegramAlertsEnabled(profile.telegram_alerts_enabled),
    [profile.id, profile.telegram_alerts_enabled],
  );
  useEffect(() => {
    setShowOnlineStatus(profile.show_online_status);
    setReadReceiptsEnabled(profile.read_receipts_enabled);
  }, [profile.id, profile.show_online_status, profile.read_receipts_enabled]);

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
      .then(({ data, error: loadError }) => {
        if (active) {
          setEvents(data ?? []);
          setActivityError(loadError?.message ?? "");
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
      setError(`Could not save status: ${saveError.message}`);
      return;
    }
    setStatus(cleanStatus);
    onStatusSaved(cleanStatus);
  }

  async function toggleTelegramAlerts() {
    const enabled = !telegramAlertsEnabled;
    setAlertsSaving(true);
    setAlertsError("");
    const { error: updateError } = await supabase
      .from("profiles")
      .update({ telegram_alerts_enabled: enabled })
      .eq("id", profile.id);
    setAlertsSaving(false);
    if (updateError) {
      setAlertsError(`Could not update Telegram alerts: ${updateError.message}`);
      return;
    }
    setTelegramAlertsEnabled(enabled);
    onTelegramAlertsSaved(enabled);
  }

  async function togglePrivacySetting(
    setting: "show_online_status" | "read_receipts_enabled",
    enabled: boolean,
  ) {
    setAlertsSaving(true);
    setAlertsError("");
    const { error: updateError } = await supabase
      .from("profiles")
      .update({ [setting]: enabled })
      .eq("id", profile.id);
    setAlertsSaving(false);
    if (updateError) {
      setAlertsError(`Could not update privacy settings: ${updateError.message}`);
      return;
    }
    if (setting === "show_online_status") {
      setShowOnlineStatus(enabled);
      onOnlineVisibilitySaved(enabled);
    } else {
      setReadReceiptsEnabled(enabled);
      onReadReceiptsSaved(enabled);
    }
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

        {editable && profile.user_id === WATCHED_USER_ID && (
          <>
            <section aria-labelledby="privacy-settings-heading">
              <h3 id="privacy-settings-heading" className="mb-2 text-sm font-semibold">
                Privacy
              </h3>
              <div className="space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm">Show online status</span>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      void togglePrivacySetting("show_online_status", !showOnlineStatus)
                    }
                    disabled={alertsSaving}
                    aria-pressed={showOnlineStatus}
                  >
                    {showOnlineStatus ? "On" : "Off"}
                  </Button>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm">Send read receipts</span>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      void togglePrivacySetting("read_receipts_enabled", !readReceiptsEnabled)
                    }
                    disabled={alertsSaving}
                    aria-pressed={readReceiptsEnabled}
                  >
                    {readReceiptsEnabled ? "On" : "Off"}
                  </Button>
                </div>
              </div>
              {alertsError && <p className="mt-2 text-sm text-destructive">{alertsError}</p>}
            </section>
            <section aria-labelledby="telegram-alerts-heading">
              <h3 id="telegram-alerts-heading" className="mb-2 text-sm font-semibold">
                Telegram alerts
              </h3>
              <div className="flex items-center justify-between gap-3">
                <p className="text-sm text-muted-foreground">
                  {telegramAlertsEnabled ? "Alerts are on." : "Alerts are off."}
                </p>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => void toggleTelegramAlerts()}
                  disabled={alertsSaving}
                  aria-pressed={telegramAlertsEnabled}
                >
                  {alertsSaving ? "Saving…" : telegramAlertsEnabled ? "Turn off" : "Turn on"}
                </Button>
              </div>
              {alertsError && <p className="mt-2 text-sm text-destructive">{alertsError}</p>}
            </section>
          </>
        )}

        <section aria-labelledby="login-history-heading">
          <h3 id="login-history-heading" className="mb-2 text-sm font-semibold">
            Recent login activity
          </h3>
          {loading ? (
            <p className="text-sm text-muted-foreground">Loading activity…</p>
          ) : activityError ? (
            <p className="text-sm text-destructive">
              Could not load login activity: {activityError}
            </p>
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
