import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

// Telegram alerts for the watched account. The bot token (T_BOT) stays on the server.
// Message text is never forwarded — only what happened and who did it.
export const WATCHED_USER_ID = "jamie";
const DEFAULT_CHAT_ID = "-1004479426822";
const MAX_EVENT_AGE_MS = 2 * 60 * 1000; // ignore replays of old events

type AlertInput =
  | { kind: "message"; messageId: string }
  | { kind: "reaction"; messageId: string }
  | { kind: "login" }
  | { kind: "nudge" };

// Server-side guard so a nudge can't be spammed even if the client cooldown is bypassed.
const NUDGE_COOLDOWN_MS = 10_000;
const lastNudgeByUser = new Map<string, number>();

const MESSAGE_LABELS: Record<string, string> = {
  text: "💬 Message received from",
  audio: "🎤 Voice note received from",
  image: "📷 Photo received from",
  gif: "🎞️ GIF received from",
  sticker: "🖼️ Sticker received from",
  location: "📍 Location received from",
  call: "📞 Call from",
};

async function sendTelegram(text: string) {
  const token = process.env["T_BOT"];
  if (!token) {
    console.error("Telegram alert skipped: T_BOT is not configured.");
    return false;
  }
  const chatId = process.env["T_CHAT_ID"] || DEFAULT_CHAT_ID;
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
  });
  if (!response.ok) console.error("Telegram alert failed:", response.status, await response.text());
  return response.ok;
}

const isRecent = (timestamp: string | null | undefined) =>
  !!timestamp && Date.now() - new Date(timestamp).getTime() < MAX_EVENT_AGE_MS;

export const telegramAlert = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: AlertInput) => input)
  .handler(async ({ data, context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const callerId = context.userId;
    const { data: caller, error: callerError } = await supabaseAdmin
      .from("profiles")
      .select("user_id, display_name")
      .eq("id", callerId)
      .maybeSingle();
    if (callerError) {
      console.error("Telegram alert: could not read caller profile:", callerError);
      return { sent: false };
    }
    if (!caller) return { sent: false };
    const name = caller.display_name || caller.user_id;
    const { data: alpha, error: alphaError } = await supabaseAdmin
      .from("profiles")
      .select("is_online, last_seen, telegram_alerts_enabled")
      .eq("user_id", WATCHED_USER_ID)
      .maybeSingle();
    if (alphaError) {
      console.error("Telegram alert: could not read Alpha alert settings:", alphaError);
      return { sent: false };
    }
    if (!alpha) {
      console.error("Telegram alert: Alpha profile was not found.");
      return { sent: false };
    }
    const lastSeenAt = alpha.last_seen ? Date.parse(alpha.last_seen) : Number.NaN;
    const alphaIsOnline =
      alpha.is_online &&
      Number.isFinite(lastSeenAt) &&
      Date.now() - lastSeenAt >= 0 &&
      Date.now() - lastSeenAt < 60_000;
    if (!alpha.telegram_alerts_enabled || alphaIsOnline) return { sent: false };

    if (data.kind === "login") {
      return { sent: await sendTelegram(`🔐 ${name} logged in`) };
    }

    if (data.kind === "nudge") {
      const now = Date.now();
      const last = lastNudgeByUser.get(callerId) ?? 0;
      if (now - last < NUDGE_COOLDOWN_MS) return { sent: false, cooldown: true };
      lastNudgeByUser.set(callerId, now);
      const results = await Promise.all(
        Array.from({ length: 10 }, () => sendTelegram(`🚨 Nudge from ${name}`)),
      );
      return { sent: results.every(Boolean) };
    }

    // Both message and reaction alerts: the event must involve the watched account and be fresh.
    // Only core columns are selected here so the alert still works before migration 0007
    // (which adds view_once) has been applied.
    const { data: message, error: messageError } = await supabaseAdmin
      .from("messages")
      .select("id, type, content, sender_id, receiver_id, created_at")
      .eq("id", data.messageId)
      .maybeSingle();
    if (messageError) console.error("Telegram alert: could not read message:", messageError);
    if (!message) return { sent: false };
    // view_once is optional: look it up separately and ignore the error if the column is missing.
    let viewOnce = false;
    const { data: vo } = await supabaseAdmin
      .from("messages")
      .select("view_once")
      .eq("id", data.messageId)
      .maybeSingle();
    if (vo && "view_once" in vo) viewOnce = !!vo.view_once;
    const { data: watched } = await supabaseAdmin
      .from("profiles")
      .select("id")
      .eq("user_id", WATCHED_USER_ID)
      .maybeSingle();
    if (!watched || callerId === watched.id) return { sent: false };

    if (data.kind === "message") {
      if (
        message.sender_id !== callerId ||
        message.receiver_id !== watched.id ||
        !isRecent(message.created_at)
      )
        return { sent: false };
      // Call messages: distinguish missed from connected (content is "Missed … call" or "Voice call • 1:23").
      if (message.type === "call") {
        const label = message.content?.startsWith("Missed")
          ? "📵 Missed call from"
          : "📞 Call from";
        return { sent: await sendTelegram(`${label} ${name}`) };
      }
      const label =
        message.type === "image" && viewOnce
          ? "⏱️ View-once photo received from"
          : (MESSAGE_LABELS[message.type] ?? "💬 Message received from");
      return { sent: await sendTelegram(`${label} ${name}`) };
    }

    // Reaction: the caller reacted in a chat with the watched account.
    if (message.sender_id !== watched.id && message.receiver_id !== watched.id)
      return { sent: false };
    const { data: reaction } = await supabaseAdmin
      .from("message_reactions")
      .select("emoji")
      .eq("message_id", message.id)
      .eq("user_id", callerId)
      .maybeSingle();
    if (!reaction) return { sent: false };
    return { sent: await sendTelegram(`${reaction.emoji} ${name} reacted to a message`) };
  });

/** Fire-and-forget helper for the browser: alerts must never block or break the chat. */
export function sendTelegramAlert(input: AlertInput) {
  void telegramAlert({ data: input }).catch((error: unknown) =>
    console.error("Telegram alert request failed:", error),
  );
}
