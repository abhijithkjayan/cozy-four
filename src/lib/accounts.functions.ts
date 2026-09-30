import { createServerFn } from "@tanstack/react-start";

const USERS = ["user1", "user2", "user3", "user4"];
const PASSWORD = "00000_pad_secure";

// Idempotently creates the 4 fixed accounts + profiles. Only ever creates these fixed users.
export const ensureAccounts = createServerFn({ method: "POST" }).handler(async () => {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data: list } = await supabaseAdmin.auth.admin.listUsers({ perPage: 100 });
  const existing = new Map((list?.users ?? []).map((u) => [u.email, u.id]));
  for (const u of USERS) {
    const email = `${u}@chat.local`;
    let id = existing.get(email);
    if (!id) {
      const { data, error } = await supabaseAdmin.auth.admin.createUser({
        email,
        password: PASSWORD,
        email_confirm: true,
      });
      if (error) throw new Error(error.message);
      id = data.user.id;
    }
    await supabaseAdmin
      .from("profiles")
      .upsert({ id, user_id: u, display_name: u }, { onConflict: "id", ignoreDuplicates: true });
  }
  return { ok: true };
});
