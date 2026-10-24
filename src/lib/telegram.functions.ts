import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { effectiveAlertsEnabled } from "@/lib/alert-schedule";

// Telegram alerts for the watched account. The bot token (T_BOT) stays on the server.
// Message text is never forwarded — only what happened and who did it.
export const WATCHED_USER_ID = "jamie";
const DEFAULT_CHAT_ID = "-1004479426822";
// Separate channel that receives the watched account's own activity, with fixed wording.
const DEFAULT_PRICE_CHAT_ID = "-1003634172468";
const PRICE_TEXT = {
  live: "Price list LIVE",
  message: "Price List New Notification",
  reaction: "Price Reacted to Base",
};
const MAX_EVENT_AGE_MS = 2 * 60 * 1000; // ignore replays of old events

type AlertInput =
  | { kind: "message"; messageId: string }
  | { kind: "reaction"; messageId: string }
  | { kind: "login" }
  | { kind: "online" }
  | { kind: "nudge" };

// Server-side guard so "Price list LIVE" isn't repeated on quick reconnects.
const ONLINE_COOLDOWN_MS = 60_000;
let lastPriceLiveAt = 0;

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

async function sendTelegram(text: string, chatId = process.env["T_CHAT_ID"] || DEFAULT_CHAT_ID) {
  const token = process.env["T_BOT"];
  if (!token) {
    console.error("Telegram alert skipped: T_BOT is not configured.");
    return false;
  }
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

// Online means flagged online with a heartbeat in the last minute (the app beats every 30s).
const isOnlineNow = (profile: { is_online: boolean; last_seen: string | null }) => {
  const lastSeenAt = profile.last_seen ? Date.parse(profile.last_seen) : Number.NaN;
  return (
    profile.is_online &&
    Number.isFinite(lastSeenAt) &&
    Date.now() - lastSeenAt >= 0 &&
    Date.now() - lastSeenAt < 60_000
  );
};

export const telegramAlert = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: AlertInput) => input)
  .handler(async ({ data, context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const callerId = context.userId;
    const { data: caller, error: callerError } = await supabaseAdmin
      .from("profiles")
      .select("user_id, display_name, show_online_status")
      .eq("id", callerId)
      .maybeSingle();
    if (callerError) {
      console.error("Telegram alert: could not read caller profile:", callerError);
      return { sent: false };
    }
    if (!caller) return { sent: false };

    // The watched account's own activity goes to the price channel, but only while the
    // other person is offline. The online alert also follows the watched account's privacy setting.
    if (caller.user_id === WATCHED_USER_ID) {
      const priceChatId = process.env["T_PRICE_CHAT_ID"] || DEFAULT_PRICE_CHAT_ID;
      // The other person's alerts follow their switch and the night schedule (off 11 PM to 7 AM
      // Canada Eastern, manual night-time switch-on lasts 15 minutes), and none are sent while
      // they are online. "*" keeps this working before migration 0015 adds telegram_alerts_changed_at.
      const alertsOnFor = (person: { telegram_alerts_enabled: boolean; telegram_alerts_changed_at?: string | null }) =>
        effectiveAlertsEnabled(person.telegram_alerts_enabled, person.telegram_alerts_changed_at);
      const receiverBlocks = async (profileId: string) => {
        const { data: person, error } = await supabaseAdmin
          .from("profiles")
          .select("*")
          .eq("id", profileId)
          .maybeSingle();
        if (error) console.error("Telegram alert: could not read receiver settings:", error);
        return !person || !alertsOnFor(person) || isOnlineNow(person);
      };
      if (data.kind === "login" || data.kind === "online") {
        if (!caller.show_online_status) return { sent: false };
        const { data: others, error: othersError } = await supabaseAdmin
          .from("profiles")
          .select("*")
          .neq("user_id", WATCHED_USER_ID);
        if (othersError) console.error("Telegram alert: could not read presence:", othersError);
        const people = others ?? [];
        if (people.some(isOnlineNow) || !people.some(alertsOnFor)) return { sent: false };
        const now = Date.now();
        if (now - lastPriceLiveAt < ONLINE_COOLDOWN_MS) return { sent: false, cooldown: true };
        lastPriceLiveAt = now;
        return { sent: await sendTelegram(PRICE_TEXT.live, priceChatId) };
      }
      if (data.kind === "nudge") return { sent: false };
      const { data: own, error: ownError } = await supabaseAdmin
        .from("messages")
        .select("id, sender_id, receiver_id, created_at")
        .eq("id", data.messageId)
        .maybeSingle();
      if (ownError) console.error("Telegram alert: could not read message:", ownError);
      if (!own) return { sent: false };
      if (data.kind === "message") {
        if (own.sender_id !== callerId || !isRecent(own.created_at)) return { sent: false };
        if (await receiverBlocks(own.receiver_id)) return { sent: false };
        return { sent: await sendTelegram(PRICE_TEXT.message, priceChatId) };
      }
      if (own.sender_id !== callerId && own.receiver_id !== callerId) return { sent: false };
      const { data: ownReaction } = await supabaseAdmin
        .from("message_reactions")
        .select("emoji")
        .eq("message_id", own.id)
        .eq("user_id", callerId)
        .maybeSingle();
      if (!ownReaction) return { sent: false };
      const otherId = own.sender_id === callerId ? own.receiver_id : own.sender_id;
      if (await receiverBlocks(otherId)) return { sent: false };
      return { sent: await sendTelegram(PRICE_TEXT.reaction, priceChatId) };
    }
    if (data.kind === "online") return { sent: false };

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
    const alphaIsOnline = isOnlineNow(alpha);
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

// Browser-side: how long the app must be away before returning counts as coming online again.
export const ONLINE_ALERT_GAP_MS = 2 * 60 * 1000;
let lastOnlineAlertAt = 0;

/** Fire-and-forget helper for the browser: alerts must never block or break the chat. */
export function sendTelegramAlert(input: AlertInput) {
  if (input.kind === "login" || input.kind === "online") {
    // Login is followed by the app opening; only announce coming online once per gap.
    const now = Date.now();
    if (input.kind === "online" && now - lastOnlineAlertAt < ONLINE_ALERT_GAP_MS) return;
    lastOnlineAlertAt = now;
  }
  void telegramAlert({ data: input }).catch((error: unknown) =>
    console.error("Telegram alert request failed:", error),
  );
}

/** Sends a chat photo/video/file (or GIF link) to the Telegram channel. Caller must be able to read the message (RLS). */
export const shareToTelegram = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: { messageId: string; url?: string }) => ({ messageId: String(input.messageId), url: input.url ? String(input.url) : undefined }))
  .handler(async ({ data, context }) => {
    const token = process.env["T_BOT"];
    if (!token) throw new Error("Telegram bot is not configured.");
    const chatId = process.env["T_CHAT_ID"] || DEFAULT_CHAT_ID;
    const { data: msg, error } = await context.supabase
      .from("messages")
      .select("id, type, media_url, content, view_once, view_once_opened_at, receiver_id, deleted_for_everyone")
      .eq("id", data.messageId)
      .maybeSingle();
    if (error || !msg || msg.deleted_for_everyone) throw new Error("Message not found.");
    if (msg.view_once) {
      // Only the watched account may share view-once media it received and opened
      // (senders are told so when they send it).
      const { data: caller } = await context.supabase
        .from("profiles")
        .select("user_id")
        .eq("id", context.userId)
        .maybeSingle();
      const kept = caller?.user_id === WATCHED_USER_ID && msg.receiver_id === context.userId && !!msg.view_once_opened_at;
      if (!kept) throw new Error("View-once media can't be shared.");
    }
    let fileUrl: string | undefined;
    if (msg.media_url) {
      const { data: signed } = await context.supabase.storage.from("chat-media").createSignedUrl(msg.media_url, 600);
      fileUrl = signed?.signedUrl;
    } else if ((msg.type === "gif" || msg.type === "sticker") && data.url?.startsWith("https://")) {
      fileUrl = data.url;
    }
    if (!fileUrl) throw new Error("This message has no file to send.");
    const isAnim = msg.type === "gif" || msg.type === "sticker" || /\.gif(\?|$)/i.test(fileUrl);
    const [method, field] =
      msg.type === "image" ? ["sendPhoto", "photo"] :
      msg.type === "video" ? ["sendVideo", "video"] :
      msg.type === "audio" ? ["sendAudio", "audio"] :
      isAnim ? ["sendAnimation", "animation"] : ["sendDocument", "document"];
    const send = async (m: string, f: string) => {
      const res = await fetch(`https://api.telegram.org/bot${token}/${m}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, [f]: fileUrl }),
      });
      if (!res.ok) console.error(`Telegram ${m} failed:`, res.status, await res.text());
      return res.ok;
    };
    // Fall back to sending as a plain file if Telegram rejects the typed upload.
    const ok = (await send(method, field)) || (method !== "sendDocument" && (await send("sendDocument", "document")));
    if (!ok) throw new Error("Telegram did not accept the file.");
    return { sent: true };
  });
