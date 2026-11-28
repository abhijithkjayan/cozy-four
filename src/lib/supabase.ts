import { supabase } from "@/integrations/supabase/client";
export { supabase };

export const PASSWORD_PAD = "_pad_secure";
export const toEmail = (userId: string) => `${userId.trim().toLowerCase()}@chat.local`;

export type Profile = {
  id: string;
  user_id: string;
  display_name: string;
  status_text: string;
  avatar_url: string | null;
  last_seen: string | null;
  is_online: boolean;
  telegram_alerts_enabled: boolean;
  telegram_alerts_changed_at?: string | null;
  show_online_status: boolean;
  read_receipts_enabled: boolean;
};

export type Message = {
  id: string;
  sender_id: string;
  receiver_id: string;
  type: "text" | "image" | "video" | "audio" | "call" | "location" | "gif" | "sticker";
  content: string | null;
  media_url: string | null;
  reply_to: string | null;
  status: "sent" | "delivered" | "read";
  created_at: string;
  delivered_at?: string | null;
  read_at?: string | null;
  deleted_for: string[];
  deleted_for_everyone: boolean;
  view_once?: boolean;
  view_once_opened_at?: string | null;
  pinned_at?: string | null;
  pinned_by?: string | null;
};

const urlCache = new Map<string, { url: string; exp: number }>();
let presigning: Promise<void> = Promise.resolve();

/** Signs many media paths in one request and remembers them: a page of messages costs one request, not one per photo. */
export function presign(paths: string[]) {
  presigning = presigning
    .then(async () => {
      const wanted = [...new Set(paths)].filter((path) => (urlCache.get(path)?.exp ?? 0) <= Date.now());
      if (!wanted.length) return;
      const { data } = await supabase.storage.from("chat-media").createSignedUrls(wanted, 3600);
      for (const row of data ?? []) {
        if (row.path && row.signedUrl) urlCache.set(row.path, { url: row.signedUrl, exp: Date.now() + 3500_000 });
      }
    })
    .catch(() => {});
  return presigning;
}

export async function signedUrl(path: string) {
  // A batch may be signing this very path right now.
  await presigning;
  const c = urlCache.get(path);
  if (c && c.exp > Date.now()) return c.url;
  const { data } = await supabase.storage.from("chat-media").createSignedUrl(path, 3600);
  if (!data) return null;
  urlCache.set(path, { url: data.signedUrl, exp: Date.now() + 3500_000 });
  return data.signedUrl;
}

export const wipeLocalCaches = () => urlCache.clear();

export const pairFilter = (a: string, b: string) =>
  `and(sender_id.eq.${a},receiver_id.eq.${b}),and(sender_id.eq.${b},receiver_id.eq.${a})`;

export const bus = new EventTarget();
export const emitMsg = (m: Message) => bus.dispatchEvent(new CustomEvent("msg", { detail: m }));

/** Tells open screens that the live connection came back, so they fetch what they missed. */
export const emitResync = () => bus.dispatchEvent(new Event("resync"));

/** Hides every message between two users for `meId` only (WhatsApp "Delete chat" / "Clear chat for me"). */
export async function hideChatForMe(meId: string, peerId: string) {
  const { data, error } = await supabase
    .from("messages")
    .select("id, deleted_for")
    .or(pairFilter(meId, peerId))
    .not("deleted_for", "cs", `{${meId}}`);
  if (error) return false;
  const rows = (data ?? []) as { id: string; deleted_for: string[] | null }[];
  for (let i = 0; i < rows.length; i += 15) {
    const results = await Promise.all(
      rows.slice(i, i + 15).map((r) => supabase.from("messages").update({ deleted_for: [...(r.deleted_for ?? []), meId] }).eq("id", r.id)),
    );
    if (results.some((r) => r.error)) return false;
  }
  return true;
}
