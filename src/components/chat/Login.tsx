import { useState } from "react";
import { ArrowLeft } from "lucide-react";
import lionLogo from "@/assets/ontario-logo.jpg.asset.json";
import { PASSWORD_PAD, supabase, toEmail } from "@/lib/supabase";
import { IDLE_LOGOUT_DISABLED_KEY } from "@/lib/security";
import { ensureAccounts } from "@/lib/accounts.functions";
import { sendTelegramAlert } from "@/lib/telegram.functions";

export function Login() {
  const [uid, setUid] = useState("");
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr("");
    // Lock this browser for one minute after three wrong attempts.
    let until = 0;
    try {
      until = Number(localStorage.getItem("lk-until") || 0);
    } catch {
      /* Storage can be unavailable. */
    }
    if (Date.now() < until)
      return setErr(`Too many attempts. Try again in ${Math.ceil((until - Date.now()) / 1000)}s.`);
    setBusy(true);
    const creds = { email: toEmail(uid), password: pw + PASSWORD_PAD };
    let { data: authData, error } = await supabase.auth.signInWithPassword(creds);
    if (error) {
      try {
        await ensureAccounts();
        ({ data: authData, error } = await supabase.auth.signInWithPassword(creds));
      } catch {
        /* ignore */
      }
    }
    setBusy(false);
    if (error) {
      let n = 0;
      try {
        n = Number(localStorage.getItem("lk-n") || 0) + 1;
        localStorage.setItem("lk-n", String(n));
      } catch {
        /* Storage can be unavailable. */
      }
      if (n >= 3) {
        try {
          localStorage.setItem("lk-until", String(Date.now() + 60_000));
        } catch {
          /* Storage can be unavailable. */
        }
        setErr("Too many attempts. Try again in 1 minute.");
      } else setErr("Wrong User ID or password.");
    } else {
      try {
        sessionStorage.setItem("tab-live", "1");
        sessionStorage.removeItem(IDLE_LOGOUT_DISABLED_KEY);
        sessionStorage.removeItem("idle-logout-taps");
        localStorage.removeItem("lk-n");
        localStorage.removeItem("lk-until");
      } catch {
        /* Storage can be unavailable. */
      }
      if (authData.user) {
        const { error: activityError } = await supabase
          .from("login_activity")
          .insert({ user_id: authData.user.id });
        if (activityError) console.error("Could not record login activity", activityError);
        sendTelegramAlert({ kind: "login" });
      }
    }
  };

  return (
    <div
      className="flex min-h-dvh items-center justify-center bg-chat-bg px-5 py-6"
      style={{
        paddingTop: "max(1.5rem, env(safe-area-inset-top))",
        paddingBottom: "max(1.5rem, env(safe-area-inset-bottom))",
      }}
    >
      <form onSubmit={submit} className="w-full max-w-sm rounded-2xl border bg-card p-8 shadow-sm">
        <div className="mb-8 flex flex-col items-center gap-3">
          <img
            src={lionLogo.url}
            alt="Ontario ISP logo"
            className="h-20 w-20 rounded-2xl object-cover"
          />
          <h1 className="text-xl font-semibold">Ontario ISP</h1>
        </div>
        <label className="mb-1 block text-xs font-medium text-muted-foreground">User ID</label>
        <input
          value={uid}
          onChange={(e) => setUid(e.target.value)}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="next"
          autoComplete="username"
          className="mb-4 w-full rounded-lg border bg-background px-3 py-3 text-base outline-none focus:ring-2 focus:ring-ring"
          required
        />
        <label className="mb-1 block text-xs font-medium text-muted-foreground">Password</label>
        <input
          type="password"
          value={pw}
          onChange={(e) => setPw(e.target.value)}
          autoComplete="current-password"
          enterKeyHint="go"
          className="mb-5 w-full rounded-lg border bg-background px-3 py-3 text-base outline-none focus:ring-2 focus:ring-ring"
          required
        />
        {err && <p className="mb-4 text-sm text-destructive">{err}</p>}
        <button
          disabled={busy}
          className="min-h-12 w-full rounded-lg bg-primary py-3 font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-60"
        >
          {busy ? "Signing in…" : "Sign in"}
        </button>
        <a
          href="https://pixel-perfect-capture-4516.lovable.app/"
          className="mt-3 flex min-h-11 w-full items-center justify-center gap-2 rounded-lg border px-4 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted"
        >
          <ArrowLeft aria-hidden="true" size={16} />
          Back to TIPS
        </a>
      </form>
    </div>
  );
}
