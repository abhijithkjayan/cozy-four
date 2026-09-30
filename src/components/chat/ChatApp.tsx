import { useCallback, useEffect, useRef, useState } from "react";
import { Bell, LogOut, Moon, MoreVertical, Sun } from "lucide-react";
import { supabase, type Message, type Profile, emitMsg, bus, pairFilter } from "@/lib/supabase";
import { listTime } from "@/lib/format";
import { messageTone, notify } from "@/lib/tones";
import { cn } from "@/lib/utils";
import { Avatar } from "./Avatar";
import { CallProvider } from "./Calls";
import { Conversation } from "./Conversation";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

export function preview(m: Message | undefined, me: string) {
  if (!m) return "No messages yet";
  if (m.deleted_for_everyone) return "This message was deleted";
  const prefix = m.sender_id === me && m.type !== "call" ? "You: " : "";
  if (m.type === "image") return prefix + "📷 Photo";
  if (m.type === "audio") return prefix + "🎤 Voice message";
  return prefix + (m.content ?? "");
}

export function ChatApp({ userId }: { userId: string }) {
  const [me, setMe] = useState<Profile | null>(null);
  const [peers, setPeers] = useState<Profile[]>([]);
  const [all, setAll] = useState<Profile[]>([]);
  const [online, setOnline] = useState<Set<string>>(new Set());
  const [sel, setSel] = useState<string | null>(null);
  const [last, setLast] = useState<Record<string, Message | undefined>>({});
  const [unread, setUnread] = useState<Record<string, number>>({});
  const [missing, setMissing] = useState(false);
  const [dark, setDark] = useState(false);
  const selRef = useRef<string | null>(null);
  selRef.current = sel;

  useEffect(() => setDark(document.documentElement.classList.contains("dark")), []);
  const toggleDark = () => {
    const d = !dark;
    document.documentElement.classList.toggle("dark", d);
    localStorage.setItem("pm-theme", d ? "dark" : "light");
    setDark(d);
  };

  // Load profiles & previews
  useEffect(() => {
    (async () => {
      const { data } = await supabase.from("profiles").select("*").order("user_id");
      const list = (data ?? []) as Profile[];
      const mine = list.find((p) => p.id === userId);
      if (!mine) return setMissing(true);
      setMe(mine);
      setAll(list);
      const others = list.filter((p) => p.id !== userId);
      setPeers(others);
      const l: Record<string, Message | undefined> = {};
      const u: Record<string, number> = {};
      await Promise.all(
        others.map(async (p) => {
          const [{ data: m }, { count }] = await Promise.all([
            supabase.from("messages").select("*").or(pairFilter(userId, p.id)).not("deleted_for", "cs", `{${userId}}`).order("created_at", { ascending: false }).limit(1),
            supabase.from("messages").select("id", { count: "exact", head: true }).eq("sender_id", p.id).eq("receiver_id", userId).neq("status", "read").neq("type", "call"),
          ]);
          l[p.id] = (m?.[0] as Message) ?? undefined;
          u[p.id] = count ?? 0;
        }),
      );
      setLast(l);
      setUnread(u);
      // mark everything received as delivered
      supabase.from("messages").update({ status: "delivered" }).eq("receiver_id", userId).eq("status", "sent").then();
    })();
  }, [userId]);

  // Presence + last_seen heartbeat
  useEffect(() => {
    if (!me) return;
    const ch = supabase.channel("presence:global", { config: { presence: { key: me.id } } });
    ch.on("presence", { event: "sync" }, () => setOnline(new Set(Object.keys(ch.presenceState()))));
    ch.subscribe((s) => s === "SUBSCRIBED" && ch.track({ at: Date.now() }));
    const beat = () => supabase.from("profiles").update({ last_seen: new Date().toISOString() }).eq("id", me.id).then();
    beat();
    const t = setInterval(beat, 30000);
    const pch = supabase
      .channel("profiles-changes")
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "profiles" }, ({ new: p }) =>
        setPeers((ps) => ps.map((x) => (x.id === (p as Profile).id ? (p as Profile) : x))),
      )
      .subscribe();
    window.addEventListener("beforeunload", beat);
    return () => {
      clearInterval(t);
      beat();
      window.removeEventListener("beforeunload", beat);
      supabase.removeChannel(ch);
      supabase.removeChannel(pch);
    };
  }, [me]);

  // Message stream
  useEffect(() => {
    if (!me) return;
    const onChange = (m: Message, isInsert: boolean) => {
      emitMsg(m);
      const peer = m.sender_id === me.id ? m.receiver_id : m.sender_id;
      setLast((l) => {
        const cur = l[peer];
        if (m.deleted_for?.includes(me.id)) return cur?.id === m.id ? { ...l, [peer]: undefined } : l;
        if (!cur || cur.id === m.id || new Date(m.created_at) >= new Date(cur.created_at)) return { ...l, [peer]: m };
        return l;
      });
      if (isInsert && m.receiver_id === me.id) {
        if (m.status === "sent") supabase.from("messages").update({ status: "delivered" }).eq("id", m.id).eq("status", "sent").then();
        const visible = selRef.current === peer && document.visibilityState === "visible";
        if (!visible && m.type !== "call") {
          setUnread((u) => ({ ...u, [peer]: (u[peer] ?? 0) + 1 }));
          messageTone();
          const who = all.find((p) => p.id === peer)?.display_name ?? "New message";
          notify(who, preview(m, me.id));
        }
      }
    };
    const ch = supabase
      .channel("messages-" + me.id)
      .on("postgres_changes", { event: "*", schema: "public", table: "messages", filter: `receiver_id=eq.${me.id}` }, (p) => p.new && onChange(p.new as Message, p.eventType === "INSERT"))
      .on("postgres_changes", { event: "*", schema: "public", table: "messages", filter: `sender_id=eq.${me.id}` }, (p) => p.new && onChange(p.new as Message, p.eventType === "INSERT"))
      .subscribe();
    const onLocal = (e: Event) => {
      const m = (e as CustomEvent<Message>).detail;
      const peer = m.sender_id === me.id ? m.receiver_id : m.sender_id;
      setLast((l) => (!l[peer] || new Date(m.created_at) >= new Date(l[peer]!.created_at) ? { ...l, [peer]: m } : l));
    };
    bus.addEventListener("msg", onLocal);
    return () => {
      supabase.removeChannel(ch);
      bus.removeEventListener("msg", onLocal);
    };
  }, [me, all]);

  const clearUnread = useCallback((id: string) => setUnread((u) => ({ ...u, [id]: 0 })), []);

  const askNotify = () => {
    if (typeof Notification !== "undefined" && Notification.permission === "default") Notification.requestPermission();
  };

  if (missing)
    return (
      <div className="flex h-dvh flex-col items-center justify-center gap-4 p-6 text-center">
        <p className="max-w-md text-muted-foreground">Your account has no profile yet. Run the setup script (supabase-setup.sql) in the database, then sign in again.</p>
        <button onClick={() => supabase.auth.signOut()} className="rounded-lg border px-4 py-2 text-sm">Log out</button>
      </div>
    );
  if (!me) return <div className="flex h-dvh items-center justify-center text-sm text-muted-foreground">Loading…</div>;

  const sorted = [...peers].sort((a, b) => new Date(last[b.id]?.created_at ?? 0).getTime() - new Date(last[a.id]?.created_at ?? 0).getTime());
  const peer = peers.find((p) => p.id === sel);

  return (
    <CallProvider me={me} profiles={all}>
      <div className="flex h-dvh overflow-hidden bg-background" onClick={askNotify}>
        <aside className={cn("flex w-full flex-col border-r bg-card md:w-[360px] md:shrink-0", sel && "hidden md:flex")}>
          <header className="flex h-16 items-center justify-between px-4">
            <div className="flex items-center gap-3">
              <Avatar p={me} size={38} />
              <span className="font-semibold">{me.display_name}</span>
            </div>
            <DropdownMenu>
              <DropdownMenuTrigger className="rounded-full p-2 text-muted-foreground hover:bg-muted" aria-label="Menu">
                <MoreVertical className="h-5 w-5" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={toggleDark}>{dark ? <Sun className="mr-2 h-4 w-4" /> : <Moon className="mr-2 h-4 w-4" />}{dark ? "Light mode" : "Dark mode"}</DropdownMenuItem>
                <DropdownMenuItem onClick={() => Notification?.requestPermission?.()}><Bell className="mr-2 h-4 w-4" />Enable notifications</DropdownMenuItem>
                <DropdownMenuItem onClick={() => supabase.auth.signOut()}><LogOut className="mr-2 h-4 w-4" />Log out</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </header>
          <h2 className="px-4 pb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">Chats</h2>
          <ul className="flex-1 overflow-y-auto">
            {sorted.map((p) => {
              const m = last[p.id];
              const n = unread[p.id] ?? 0;
              return (
                <li key={p.id}>
                  <button
                    onClick={() => setSel(p.id)}
                    className={cn("flex w-full items-center gap-3 px-4 py-3 text-left transition hover:bg-muted", sel === p.id && "bg-muted")}
                  >
                    <Avatar p={p} online={online.has(p.id)} />
                    <div className="min-w-0 flex-1 border-b border-border/60 pb-3">
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="truncate font-medium">{p.display_name}</span>
                        {m && <span className={cn("shrink-0 text-xs", n ? "font-medium text-primary" : "text-muted-foreground")}>{listTime(m.created_at)}</span>}
                      </div>
                      <div className="mt-0.5 flex items-center justify-between gap-2">
                        <span className="truncate text-sm text-muted-foreground">{preview(m, me.id)}</span>
                        {n > 0 && <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-[11px] font-semibold text-primary-foreground">{n}</span>}
                      </div>
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        </aside>
        <main className={cn("flex-1", !sel && "hidden md:flex")}>
          {peer ? (
            <Conversation key={peer.id} me={me} peer={peer} online={online.has(peer.id)} onBack={() => setSel(null)} onSeen={clearUnread} />
          ) : (
            <div className="flex h-full w-full flex-col items-center justify-center gap-2 bg-chat-bg text-center text-muted-foreground">
              <p className="text-lg font-medium text-foreground">JTWDFLC!🩸</p>
              <p className="text-sm">Pick a chat to start messaging.</p>
            </div>
          )}
        </main>
      </div>
    </CallProvider>
  );
}
