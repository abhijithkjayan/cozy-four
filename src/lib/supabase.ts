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
  show_online_status: boolean;
  read_receipts_enabled: boolean;
};

export type Message = {
  id: string;
  sender_id: string;
  receiver_id: string;
  type: "text" | "image" | "audio" | "call" | "location" | "gif" | "sticker";
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
};

const urlCache = new Map<string, { url: string; exp: number }>();
export async function signedUrl(path: string) {
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
