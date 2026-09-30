import { createServerFn } from "@tanstack/react-start";

// Fixed accounts. `old` = previous User ID: if it exists it is renamed (keeps chat history).
// Passwords here are what the user types; the app adds the same suffix as PASSWORD_PAD in src/lib/supabase.ts.
const PAD = "_pad_secure";
const USERS: { id: string; pw: string; old?: string }[] = [
  { id: "jamie", pw: "chiku", old: "user1" },
  { id: "cersi", pw: "vichu", old: "user2" },
  { id: "user3", pw: "00000" },
  { id: "user4", pw: "00000" },
];

// Idempotently creates/renames the fixed accounts + profiles. Only ever touches these fixed users.
export const ensureAccounts = createServerFn({ method: "POST" }).handler(async () => {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data: list } = await supabaseAdmin.auth.admin.listUsers({ perPage: 200 });
  const existing = new Map((list?.users ?? []).map((u) => [u.email, u.id]));
  for (const u of USERS) {
    const email = `${u.id}@chat.local`;
    let id = existing.get(email);
    if (!id && u.old) {
      const oldId = existing.get(`${u.old}@chat.local`);
      if (oldId) {
        // Rename the old account to the new User ID + password (chat history is kept)
        const { error } = await supabaseAdmin.auth.admin.updateUserById(oldId, {
          email,
          password: u.pw + PAD,
          email_confirm: true,
        });
        if (error) throw new Error(error.message);
        id = oldId;
      }
    }
    if (!id) {
      const { data, error } = await supabaseAdmin.auth.admin.createUser({
        email,
        password: u.pw + PAD,
        email_confirm: true,
      });
      if (error) throw new Error(error.message);
      id = data.user.id;
    }
    // Make sure the profile exists and shows the new name
    const { data: prof } = await supabaseAdmin.from("profiles").select("user_id, display_name").eq("id", id).maybeSingle();
    if (!prof) {
      await supabaseAdmin.from("profiles").insert({ id, user_id: u.id, display_name: u.id });
    } else if (prof.user_id !== u.id) {
      await supabaseAdmin.from("profiles").update({ user_id: u.id, display_name: prof.display_name === prof.user_id ? u.id : prof.display_name }).eq("id", id);
    }
  }
  return { ok: true };
});
