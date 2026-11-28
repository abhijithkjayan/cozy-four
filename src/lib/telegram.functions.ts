import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { TELEGRAM_FILE_MAX_BYTES, TELEGRAM_TARGET_BYTES, telegramRoutes } from "@/lib/telegram-media";
import { telegramUpload, type UploadFile } from "@/lib/telegram-upload";
import { NAUGHTY_PATH, serveNaughty } from "@/lib/r2";

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
const NUDGE_MESSAGES = 10;
// Telegram allows about one message a second to the same chat.
const NUDGE_GAP_MS = 1050;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
  // Telegram answers 429 with a wait time when messages come too fast, and requests can fail on
  // the way. One short wait and a second try gets the alert through.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
        signal: AbortSignal.timeout(10_000),
      });
      if (response.ok) return true;
      const body = await response.text();
      console.error("Telegram alert failed:", response.status, body);
      if (response.status !== 429 || attempt > 0) return false;
      let retryAfter = 1;
      try {
        retryAfter = Number(JSON.parse(body).parameters?.retry_after) || 1;
      } catch {
        // keep one second
      }
      if (retryAfter > 5) return false;
      await wait(retryAfter * 1000 + 250);
    } catch (error) {
      console.error("Telegram alert failed:", error);
      if (attempt > 0) return false;
      await wait(500);
    }
  }
  return false;
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
      // Every outcome is logged so a missing alert can be traced in the server logs.
      const skip = (reason: string) => {
        console.log(`Price alert (${data.kind}) skipped: ${reason}`);
        return { sent: false, reason };
      };
      const sent = (ok: boolean, what: string) => {
        console.log(`Price alert (${what}) to ${priceChatId}: ${ok ? "sent" : "Telegram refused, see error above"}`);
        return ok ? { sent: true } : { sent: false, reason: "Telegram refused the message (check T_BOT and that the bot is an admin of the channel)" };
      };
      // Price channel alerts are always on (no switch, no night schedule, no migration needed);
      // none are sent while the other person is online.
      const alertsOnFor = (_person: unknown) => true;
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
        if (!caller.show_online_status) return skip("Alpha hides online status");
        const { data: others, error: othersError } = await supabaseAdmin
          .from("profiles")
          .select("*")
          .neq("user_id", WATCHED_USER_ID);
        if (othersError) console.error("Telegram alert: could not read presence:", othersError);
        const people = others ?? [];
        if (people.some(isOnlineNow)) return skip("another account is online");
        const now = Date.now();
        if (now - lastPriceLiveAt < ONLINE_COOLDOWN_MS) return skip("LIVE sent less than 60s ago");
        lastPriceLiveAt = now;
        return sent(await sendTelegram(PRICE_TEXT.live, priceChatId), "LIVE");
      }
      if (data.kind === "nudge") return skip("nudges from Alpha are not sent");
      const { data: own, error: ownError } = await supabaseAdmin
        .from("messages")
        .select("id, sender_id, receiver_id, created_at")
        .eq("id", data.messageId)
        .maybeSingle();
      if (ownError) console.error("Telegram alert: could not read message:", ownError);
      if (!own) return skip("message not found");
      if (data.kind === "message") {
        if (own.sender_id !== callerId || !isRecent(own.created_at)) return skip("not a fresh message from Alpha");
        if (await receiverBlocks(own.receiver_id)) return skip("receiver is online");
        return sent(await sendTelegram(PRICE_TEXT.message, priceChatId), "message");
      }
      if (own.sender_id !== callerId && own.receiver_id !== callerId) return skip("not Alpha's chat");
      const { data: ownReaction } = await supabaseAdmin
        .from("message_reactions")
        .select("emoji")
        .eq("message_id", own.id)
        .eq("user_id", callerId)
        .maybeSingle();
      if (!ownReaction) return skip("reaction not found");
      const otherId = own.sender_id === callerId ? own.receiver_id : own.sender_id;
      if (await receiverBlocks(otherId)) return skip("receiver is online");
      return sent(await sendTelegram(PRICE_TEXT.reaction, priceChatId), "reaction");
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
      // One after another. Ten at the same instant trips Telegram's flood limit, which then also
      // refuses the ordinary alerts that follow.
      let delivered = 0;
      for (let i = 0; i < NUDGE_MESSAGES; i++) {
        if (!(await sendTelegram(`🚨 Nudge from ${name}`))) break;
        delivered++;
        if (i < NUDGE_MESSAGES - 1) await wait(NUDGE_GAP_MS);
      }
      return { sent: delivered > 0 };
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
          ? "📵 Missed Ping from"
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
  void telegramAlert({ data: input })
    .then((result: { sent: boolean; reason?: string }) => {
      if (!result.sent && result.reason) console.info(`Telegram alert (${input.kind}) not sent: ${result.reason}`);
    })
    .catch((error: unknown) => console.error("Telegram alert request failed:", error));
}

/** Sends a chat photo/video/file (or GIF/sticker) to the Telegram channel. Caller must be able to read the message (RLS). */
export const shareToTelegram = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  // `url` is still accepted from older app copies but no longer used: the link is read from the message itself.
  .validator((input: { messageId: string; url?: string; compressedPath?: string }) => ({
    messageId: String(input.messageId),
    compressedPath: input.compressedPath ? String(input.compressedPath) : undefined,
  }))
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

    type Failure = { status: number; reason: string } | null;
    // Returns null on success, otherwise Telegram's own explanation.
    const send = async (method: string, init: RequestInit): Promise<Failure> => {
      let res: Response;
      try {
        res = await fetch(`https://api.telegram.org/bot${token}/${method}`, { ...init, method: "POST" });
      } catch (cause) {
        console.error(`Telegram ${method} failed:`, cause);
        return { status: 0, reason: "could not reach Telegram" };
      }
      if (res.ok) {
        await res.body?.cancel();
        return null;
      }
      const body = await res.text();
      console.error(`Telegram ${method} failed:`, res.status, body);
      try {
        return { status: res.status, reason: String(JSON.parse(body).description) };
      } catch {
        return { status: res.status, reason: `HTTP ${res.status}` };
      }
    };

    // An upload needs the file's exact size. When the server does not state one (or the body is
    // compressed on the way, so the stated size is wrong), read it, up to the limit, to find out.
    const sized = async (res: Response, limit: number): Promise<UploadFile | null> => {
      if (!res.ok || !res.body) {
        await res.body?.cancel();
        return null;
      }
      const type = res.headers.get("content-type") ?? "";
      const declared = res.headers.get("content-encoding") ? 0 : Number(res.headers.get("content-length")) || 0;
      if (declared > 0) return { body: res.body, size: declared, type };
      const reader = res.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > limit) {
          await reader.cancel();
          return { body: new Blob([]).stream(), size: total, type };
        }
        chunks.push(value);
      }
      const blob = new Blob(chunks as BlobPart[], { type });
      return { body: blob.stream(), size: blob.size, type };
    };

    // `open` is called once per attempt, because a stream can only be read once.
    const upload = async (open: () => Promise<UploadFile | null>, filename: string, limit: number, messageType: string): Promise<"sent" | "too-big"> => {
      let file = await open();
      if (!file) throw new Error("Could not read this file from storage.");
      if (file.size > limit) {
        await file.body.cancel();
        return "too-big";
      }
      const { size, type } = file;
      let failure: Failure = null;
      // Each route falls through to the next, ending with a plain file.
      for (const route of telegramRoutes(messageType, type, filename, size)) {
        file ??= await open();
        if (!file) throw new Error("Could not read this file from storage.");
        const request = await telegramUpload({ chat_id: chatId }, route.field, filename, file);
        file = null;
        failure = await send(route.method, request);
        if (!failure) return "sent";
        // Only a 400 is about this file. Anything else (bad token, bot not in channel) won't change on retry.
        if (failure.status !== 400) break;
      }
      throw new Error(`Telegram did not accept the file: ${failure?.reason ?? "unknown error"}`);
    };

    const lastSegment = (path: string, fallback: string) => {
      try {
        return decodeURIComponent(path.split("/").pop() || "") || fallback;
      } catch {
        return fallback;
      }
    };

    // GIFs and stickers from the picker have no stored file, only a link kept in the message.
    if (!msg.media_url) {
      if (msg.type !== "gif" && msg.type !== "sticker") throw new Error("This message has no file to send.");
      let link = "";
      try {
        link = String((JSON.parse(msg.content ?? "") as { url?: unknown }).url ?? "");
      } catch {
        // not JSON: no link
      }
      // NAUGHTY stickers live in the private bucket, which Telegram cannot reach: upload the file itself.
      if (link.startsWith(NAUGHTY_PATH)) {
        const result = await upload(
          async () => sized(await serveNaughty(new Request(new URL(link, "https://app.invalid"))), TELEGRAM_FILE_MAX_BYTES),
          lastSegment(link, `sticker-${msg.id}`),
          TELEGRAM_FILE_MAX_BYTES,
          "image",
        );
        if (result === "too-big") throw new Error("This sticker is over Telegram's 50 MB limit.");
        return { sent: true };
      }
      let host = "";
      try {
        const parsed = new URL(link);
        if (parsed.protocol === "https:") host = parsed.hostname;
      } catch {
        // not a link
      }
      // Public web addresses only (a name with a dot, not a bare number or a local name).
      if (!/^(?=.*[a-z])[a-z0-9.-]+\.[a-z]{2,}$/i.test(host)) throw new Error("This message has no file to send.");
      // Telegram fetches a public link itself. That works for GIF and MP4.
      const failure = await send("sendAnimation", {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, animation: link }),
      });
      if (!failure) return { sent: true };
      if (failure.status !== 400) throw new Error(`Telegram did not accept the file: ${failure.reason}`);
      // Anything else (WebP stickers, files Telegram could not fetch) is downloaded here and uploaded.
      const result = await upload(
        async () => sized(await fetch(link, { signal: AbortSignal.timeout(20_000) }), TELEGRAM_FILE_MAX_BYTES),
        lastSegment(new URL(link).pathname, `media-${msg.id}`),
        TELEGRAM_FILE_MAX_BYTES,
        "image",
      );
      if (result === "too-big") throw new Error("This file is over Telegram's 50 MB limit.");
      return { sent: true };
    }

    // Stored media is uploaded directly. Sending Telegram a link instead caps photos at 5 MB and
    // other files at 20 MB, and sendDocument by link only works for GIF, PDF and ZIP.
    // A compressed copy is the caller's own temporary upload of this message's media.
    if (data.compressedPath && (!data.compressedPath.startsWith(`${context.userId}/`) || data.compressedPath.includes("..")))
      throw new Error("Invalid compressed file.");
    const mediaPath = data.compressedPath ?? msg.media_url;
    const { data: signed } = await context.supabase.storage.from("chat-media").createSignedUrl(mediaPath, 600);
    if (!signed?.signedUrl) throw new Error("Could not read this file from storage.");
    const signedUrl = signed.signedUrl;
    // Too big for Telegram: the browser shrinks it and calls again with compressedPath.
    const limit = data.compressedPath ? TELEGRAM_FILE_MAX_BYTES : TELEGRAM_TARGET_BYTES;
    const result = await upload(async () => sized(await fetch(signedUrl), limit), lastSegment(mediaPath, `media-${msg.id}`), limit, msg.type);
    if (result === "too-big") {
      if (data.compressedPath) throw new Error("The compressed file is still over Telegram's 50 MB limit.");
      return { sent: false, needsCompression: true };
    }
    return { sent: true };
  });
