import { supabase } from "@/integrations/supabase/client";
export { supabase };

export const PASSWORD_PAD = "_pad_secure";
export const toEmail = (userId: string) => `${userId.trim().toLowerCase()}@chat.local`;

export type Profile = {
  id: string;
  user_id: string;
  display_name: string;
  avatar_url: string | null;
  last_seen: string | null;
};

export type Message = {
  id: string;
  sender_id: string;
  receiver_id: string;
  type: "text" | "image" | "audio" | "call";
  content: string | null;
  media_url: string | null;
  reply_to: string | null;
  status: "sent" | "delivered" | "read";
  created_at: string;
  deleted_for: string[];
  deleted_for_everyone: boolean;
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
