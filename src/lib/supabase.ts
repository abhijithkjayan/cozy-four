import { createClient } from "@supabase/supabase-js";

// Publishable (anon) credentials — safe in browser code. Access is enforced by RLS.
export const SUPABASE_URL = "https://ijulcjptlhxxhvmcqgde.supabase.co";
export const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlqdWxjanB0bGh4eGh2bWNxZ2RlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTA3OTUzMjYsImV4cCI6MjEwNjM3MTMyNn0.Y9S9YGyUjHD4HpFrbJeuLmLXxsCqJIamsCyHjvLPOIc";

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, storageKey: "pm-auth" },
});

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

export const pairFilter = (a: string, b: string) =>
  `and(sender_id.eq.${a},receiver_id.eq.${b}),and(sender_id.eq.${b},receiver_id.eq.${a})`;

export const bus = new EventTarget();
export const emitMsg = (m: Message) => bus.dispatchEvent(new CustomEvent("msg", { detail: m }));
