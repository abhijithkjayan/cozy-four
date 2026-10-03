import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase";
import { Login } from "@/components/chat/Login";
import { ChatApp } from "@/components/chat/ChatApp";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Ontario ISP" },
      { name: "description", content: "Ontario ISP private messenger." },
      { property: "og:title", content: "Ontario ISP" },
      { property: "og:description", content: "Ontario ISP private messenger." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
      { name: "robots", content: "noindex, nofollow, noarchive" },
    ],
  }),
  component: Index,
});

function Index() {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  useEffect(() => {
    // A session only lives while this tab is open: a reopened tab/browser starts signed out.
    supabase.auth.getSession().then(async ({ data }) => {
      let live = false;
      try { live = sessionStorage.getItem("tab-live") === "1"; } catch {}
      if (data.session && !live) { await supabase.auth.signOut(); setSession(null); return; }
      setSession(data.session);
    });
    const { data } = supabase.auth.onAuthStateChange((e, s) => {
      if (e === "SIGNED_IN") { try { sessionStorage.setItem("tab-live", "1"); } catch {} }
      setSession(s);
    });
    return () => data.subscription.unsubscribe();
  }, []);

  if (session === undefined)
    return <div className="flex h-dvh items-center justify-center text-sm text-muted-foreground">Loading…</div>;
  if (!session) return <Login />;
  return <ChatApp key={session.user.id} userId={session.user.id} />;
}
