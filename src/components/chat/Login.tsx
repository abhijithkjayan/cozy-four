import { useState } from "react";
import { MessageCircle } from "lucide-react";
import { PASSWORD_PAD, supabase, toEmail } from "@/lib/supabase";

export function Login() {
  const [uid, setUid] = useState("");
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr("");
    setBusy(true);
    const { error } = await supabase.auth.signInWithPassword({ email: toEmail(uid), password: pw + PASSWORD_PAD });
    setBusy(false);
    if (error) setErr("Wrong User ID or password.");
  };

  return (
    <div className="flex min-h-dvh items-center justify-center bg-chat-bg px-5">
      <form onSubmit={submit} className="w-full max-w-sm rounded-2xl border bg-card p-8 shadow-sm">
        <div className="mb-8 flex flex-col items-center gap-3">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-primary text-primary-foreground">
            <MessageCircle className="h-7 w-7" />
          </div>
          <h1 className="text-xl font-semibold">JTWDFLC!🩸</h1>
        </div>
        <label className="mb-1 block text-xs font-medium text-muted-foreground">User ID</label>
        <input
          value={uid}
          onChange={(e) => setUid(e.target.value)}
          autoCapitalize="none"
          autoComplete="username"
          className="mb-4 w-full rounded-lg border bg-background px-3 py-2.5 outline-none focus:ring-2 focus:ring-ring"
          required
        />
        <label className="mb-1 block text-xs font-medium text-muted-foreground">Password</label>
        <input
          type="password"
          value={pw}
          onChange={(e) => setPw(e.target.value)}
          autoComplete="current-password"
          className="mb-5 w-full rounded-lg border bg-background px-3 py-2.5 outline-none focus:ring-2 focus:ring-ring"
          required
        />
        {err && <p className="mb-4 text-sm text-destructive">{err}</p>}
        <button
          disabled={busy}
          className="w-full rounded-lg bg-primary py-2.5 font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-60"
        >
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}
