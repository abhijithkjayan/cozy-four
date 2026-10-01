import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase";
import { Login } from "@/components/chat/Login";
import { ChatApp } from "@/components/chat/ChatApp";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Lion's Den" },
      { name: "robots", content: "noindex, nofollow, noarchive" },
    ],
  }),
  component: Index,
});

function Index() {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => data.subscription.unsubscribe();
  }, []);

  if (session === undefined)
    return <div className="flex h-dvh items-center justify-center text-sm text-muted-foreground">Loading…</div>;
  if (!session) return <Login />;
  return <ChatApp key={session.user.id} userId={session.user.id} />;
}
