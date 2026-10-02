import { useCallback, useEffect, useRef, useState } from "react";
import { Bell, Camera, LogOut, MessageSquare, Moon, MoreVertical, PhoneCall, Pin, PinOff, Sun, Trash2 } from "lucide-react";
import { supabase, type Message, type Profile, emitMsg, bus, pairFilter } from "@/lib/supabase";
import { listTime } from "@/lib/format";
import { messageTone, notify } from "@/lib/tones";
import { cn } from "@/lib/utils";
import { imageToAvatar, secureLogout, useIdleLogout } from "@/lib/security";
import { Avatar } from "./Avatar";
import { CallProvider } from "./Calls";
import { Conversation } from "./Conversation";
import { CallLog } from "./CallLog";
import { ProfilePanel } from "./ProfilePanel";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

export function preview(m: Message | undefined, me: string) {
  if (!m) return "No messages yet";
  if (m.deleted_for_everyone) return "This message was deleted";
  const prefix = m.sender_id === me && m.type !== "call" ? "You: " : "";
  if (m.type === "image") return prefix + "📷 Photo";
  if (m.type === "audio") return prefix + "🎤 Voice message";
  if (m.type === "location") return prefix + "📍 Location";
  if (m.type === "gif") return prefix + "GIF";
  if (m.type === "sticker") return prefix + "Sticker";
  return prefix + (m.content ?? "");
}

export function ChatApp({ userId }: { userId: string }) {
  const [me, setMe] = useState<Profile | null>(null);
  const [peers, setPeers] = useState<Profile[]>([]);
  const [all, setAll] = useState<Profile[]>([]);
  const [online, setOnline] = useState<Set<string>>(new Set());
  const [away, setAway] = useState<Set<string>>(new Set());
  const [sel, setSel] = useState<string | null>(null);
  const [last, setLast] = useState<Record<string, Message | undefined>>({});
  const [unread, setUnread] = useState<Record<string, number>>({});
  const [missing, setMissing] = useState(false);
  const [dark, setDark] = useState(false);
  const [pinned, setPinned] = useState<Set<string>>(new Set());
  const [listView, setListView] = useState<"chats" | "calls">("chats");
  const [profileOpen, setProfileOpen] = useState(false);
  const [profileTarget, setProfileTarget] = useState<Profile | null>(null);
  const { left, stay } = useIdleLogout();
  const photoRef = useRef<HTMLInputElement>(null);
  const [photoBusy, setPhotoBusy] = useState(false);
  const selRef = useRef<string | null>(null);
  selRef.current = sel;

  const setAvatar = async (url: string | null) => {
    if (!me) return;
    setPhotoBusy(true);
    const { error } = await supabase.from("profiles").update({ avatar_url: url }).eq("id", me.id);
    setPhotoBusy(false);
    if (error) return alert("Could not update the photo. Please try again.");
    setMe({ ...me, avatar_url: url });
    setAll((a) => a.map((p) => (p.id === me.id ? { ...p, avatar_url: url } : p)));
  };
  const pickPhoto = async (f: File | undefined) => {
    if (!f) return;
    try { await setAvatar(await imageToAvatar(f)); } catch { alert("That image could not be used. Try another photo."); }
  };

  const togglePin = async (peerId: string) => {
    if (!me) return;
    if (pinned.has(peerId)) {
      const { error } = await supabase.from("pinned_chats").delete().eq("user_id", me.id).eq("peer_id", peerId);
      if (error) return alert("Could not unpin this chat. Please try again.");
      setPinned((current) => {
        const next = new Set(current);
        next.delete(peerId);
        return next;
      });
      return;
    }
    const { error } = await supabase.from("pinned_chats").insert({ user_id: me.id, peer_id: peerId });
    if (error) return alert("Could not pin this chat. Please try again.");
    setPinned((current) => new Set(current).add(peerId));
  };

  const openProfile = (profile: Profile) => {
    setProfileTarget(profile);
    setProfileOpen(true);
  };

  // Mobile: follow the visible viewport so the on-screen keyboard never covers the input
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const set = () => {
      document.documentElement.style.setProperty("--app-h", `${vv.height}px`);
      window.scrollTo(0, 0);
    };
    set();
    vv.addEventListener("resize", set);
    vv.addEventListener("scroll", set);
    return () => {
      vv.removeEventListener("resize", set);
      vv.removeEventListener("scroll", set);
      document.documentElement.style.removeProperty("--app-h");
    };
  }, []);

  // Mobile: phone Back button returns to the chat list instead of leaving the app
  const openChat = (id: string) => {
    if (!selRef.current) history.pushState({ chat: id }, "");
    setSel(id);
  };
  const closeChat = () => {
    if (history.state?.chat) history.back();
    else setSel(null);
  };
  useEffect(() => {
    const onPop = () => setSel(null);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

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
      const { data: savedPins } = await supabase.from("pinned_chats").select("peer_id").eq("user_id", userId);
      setPinned(new Set((savedPins ?? []).map((row) => row.peer_id)));
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
    const syncPresence = () => {
      const active = new Set<string>();
      const inactive = new Set<string>();
      for (const [id, presences] of Object.entries(ch.presenceState())) {
        if (presences.some((presence) => (presence as { status?: string }).status === "online")) active.add(id);
        else inactive.add(id);
      }
      setOnline(active);
      setAway(inactive);
    };
    const trackPresence = () => {
      void ch.track({
        at: Date.now(),
        status: document.visibilityState === "visible" ? "online" : "away",
      });
    };
    ch.on("presence", { event: "sync" }, syncPresence);
    ch.subscribe((s) => s === "SUBSCRIBED" && trackPresence());
    document.addEventListener("visibilitychange", trackPresence);
    const beat = () => supabase.from("profiles").update({ last_seen: new Date().toISOString() }).eq("id", me.id).then();
    beat();
    const t = setInterval(beat, 30000);
    const pch = supabase
      .channel("profiles-changes")
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "profiles" }, ({ new: p }) =>
        {
          // Large values (the photo) can be left out of live updates when they didn't change,
          // so keep the photo we already have and re-check it from the server.
          const incoming = p as Partial<Profile> & { id: string };
          const merge = (x: Profile) => {
            if (x.id !== incoming.id) return x;
            const next = { ...x, ...incoming } as Profile;
            if (!incoming.avatar_url && x.avatar_url) next.avatar_url = x.avatar_url;
            return next;
          };
          setPeers((ps) => ps.map(merge));
          setAll((ps) => ps.map(merge));
          setMe((current) => (current ? merge(current) : current));
          if (!incoming.avatar_url) {
            void supabase.from("profiles").select("avatar_url").eq("id", incoming.id).maybeSingle().then(({ data }) => {
              if (!data) return;
              const fix = (x: Profile) => (x.id === incoming.id ? { ...x, avatar_url: data.avatar_url } : x);
              setPeers((ps) => ps.map(fix));
              setAll((ps) => ps.map(fix));
              setMe((current) => (current ? fix(current) : current));
            });
          }
        },
      )
      .subscribe();
    window.addEventListener("beforeunload", beat);
    return () => {
      clearInterval(t);
      beat();
      document.removeEventListener("visibilitychange", trackPresence);
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
    try {
      if (typeof Notification !== "undefined" && Notification.permission === "default") Notification.requestPermission();
    } catch {}
  };

  if (missing)
    return (
      <div className="app-shell flex flex-col items-center justify-center gap-4 p-6 text-center">
        <p className="max-w-md text-muted-foreground">Your account has no profile yet. Run the setup script (supabase-setup.sql) in the database, then sign in again.</p>
        <button onClick={() => secureLogout()} className="rounded-lg border px-4 py-2 text-sm text-muted-foreground hover:bg-muted">Log out</button>
      </div>
    );
  if (!me) return <div className="app-shell flex items-center justify-center text-sm text-muted-foreground">Loading…</div>;

  const sorted = [...peers].sort((a, b) => {
    const pinOrder = Number(pinned.has(b.id)) - Number(pinned.has(a.id));
    return pinOrder || new Date(last[b.id]?.created_at ?? 0).getTime() - new Date(last[a.id]?.created_at ?? 0).getTime();
  });
  const peer = peers.find((p) => p.id === sel);

  return (
    <CallProvider me={me} profiles={all}>
      {left !== null && (
        <div className="fixed bottom-4 right-4 z-[60] flex max-w-[calc(100vw-2rem)] items-center gap-3 rounded-xl bg-foreground px-4 py-3 text-sm text-background shadow-xl">
          <span>Logging out in <strong>{left}s</strong> because you were inactive.</span>
          <button onClick={stay} className="shrink-0 rounded-md bg-background px-3 py-1 font-medium text-foreground">Stay signed in</button>
        </div>
      )}
      <div className="app-shell flex flex-col overflow-hidden bg-background" onClick={askNotify}>
        <div className="flex h-8 shrink-0 items-center justify-center bg-primary text-xs font-bold tracking-[0.35em] text-primary-foreground">GOH</div>
        <div className="flex min-h-0 flex-1 overflow-hidden">
        <aside className={cn("flex w-full flex-col border-r bg-card md:w-[360px] md:shrink-0", sel && "hidden md:flex")}>
          <header className="flex h-16 shrink-0 items-center justify-between px-4 pt-[env(safe-area-inset-top)] box-content">
            <div className="flex items-center gap-3">
              <button onClick={() => openProfile(me)} className="relative rounded-full" aria-label="Open profile and login activity">
                <Avatar p={me} size={38} />
              </button>
              <button onClick={() => openProfile(me)} className="min-w-0 text-left">
                <span className="block truncate font-semibold">{me.display_name}</span>
                <span className="block max-w-36 truncate text-xs text-muted-foreground">{me.status_text || "Set a status"}</span>
              </button>
              <input ref={photoRef} type="file" accept="image/*" hidden onChange={(e) => { pickPhoto(e.target.files?.[0]); e.target.value = ""; }} />
            </div>
            <div className="flex items-center gap-1">
              <button onClick={() => secureLogout()} className="flex items-center gap-1.5 rounded-lg bg-destructive px-3 py-2 text-xs font-semibold text-destructive-foreground shadow-sm hover:opacity-90" aria-label="Log out">
                <LogOut className="h-4 w-4" />
                <span>Log out</span>
              </button>
            <DropdownMenu>
              <DropdownMenuTrigger className="rounded-full p-2 text-muted-foreground hover:bg-muted" aria-label="Menu">
                <MoreVertical className="h-5 w-5" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => photoRef.current?.click()}><Camera className="mr-2 h-4 w-4" />{photoBusy ? "Saving…" : "Change profile photo"}</DropdownMenuItem>
                {me.avatar_url && <DropdownMenuItem onClick={() => setAvatar(null)}><Trash2 className="mr-2 h-4 w-4" />Remove profile photo</DropdownMenuItem>}
                <DropdownMenuItem onClick={toggleDark}>{dark ? <Sun className="mr-2 h-4 w-4" /> : <Moon className="mr-2 h-4 w-4" />}{dark ? "Light mode" : "Dark mode"}</DropdownMenuItem>
                <DropdownMenuItem onClick={askNotify}><Bell className="mr-2 h-4 w-4" />Enable notifications</DropdownMenuItem>
                <DropdownMenuItem onClick={() => secureLogout()} className="text-muted-foreground focus:text-foreground"><LogOut className="mr-2 h-4 w-4" />Log out</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            </div>
          </header>
          <div className="flex border-b px-3" role="tablist" aria-label="Chats and calls">
            <button type="button" role="tab" aria-selected={listView === "chats"} onClick={() => setListView("chats")} className={cn("flex h-11 flex-1 items-center justify-center gap-2 border-b-2 text-sm font-medium", listView === "chats" ? "border-primary text-primary" : "border-transparent text-muted-foreground")}>
              <MessageSquare size={16} /> Chats
            </button>
            <button type="button" role="tab" aria-selected={listView === "calls"} onClick={() => setListView("calls")} className={cn("flex h-11 flex-1 items-center justify-center gap-2 border-b-2 text-sm font-medium", listView === "calls" ? "border-primary text-primary" : "border-transparent text-muted-foreground")}>
              <PhoneCall size={16} /> Calls
            </button>
          </div>
          {listView === "calls" ? (
            <CallLog userId={me.id} profiles={all} onViewProfile={openProfile} />
          ) : <ul className="flex-1 overflow-y-auto overscroll-contain pb-[env(safe-area-inset-bottom)]">
            {sorted.map((p) => {
              const m = last[p.id];
              const n = unread[p.id] ?? 0;
              return (
                <li key={p.id}>
                  <div className={cn("flex items-center gap-1 px-2 transition", sel === p.id && "bg-muted")}>
                    <button onClick={() => openChat(p.id)} className="flex min-w-0 flex-1 items-center gap-3 py-3 pl-2 text-left active:bg-muted md:hover:bg-muted">
                      <Avatar p={p} online={online.has(p.id)} away={away.has(p.id)} />
                      <div className="min-w-0 flex-1 border-b border-border/60 pb-2">
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="truncate font-medium">{p.display_name}</span>
                        {m && <span className={cn("shrink-0 text-xs", n ? "font-medium text-primary" : "text-muted-foreground")}>{listTime(m.created_at)}</span>}
                      </div>
                      {p.status_text && <div className="truncate text-xs text-muted-foreground">{p.status_text}</div>}
                      <div className="mt-0.5 flex items-center justify-between gap-2">
                        <span className="truncate text-sm text-muted-foreground">{preview(m, me.id)}</span>
                        {n > 0 && <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-[11px] font-semibold text-primary-foreground">{n}</span>}
                      </div>
                      </div>
                    </button>
                    <button type="button" onClick={() => void togglePin(p.id)} className={cn("flex h-10 w-10 shrink-0 items-center justify-center rounded-full hover:bg-muted", pinned.has(p.id) ? "text-primary" : "text-muted-foreground")} aria-label={pinned.has(p.id) ? `Unpin ${p.display_name}` : `Pin ${p.display_name}`} title={pinned.has(p.id) ? "Unpin chat" : "Pin chat"}>
                      {pinned.has(p.id) ? <PinOff size={17} /> : <Pin size={17} />}
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>}
        </aside>
        <main className={cn("min-w-0 flex-1", !sel && "hidden md:flex")}>
          {peer ? (
            <Conversation key={peer.id} me={me} peer={peer} online={online.has(peer.id)} away={away.has(peer.id)} onBack={closeChat} onSeen={clearUnread} onViewProfile={openProfile} />
          ) : (
            <div className="flex h-full w-full flex-col items-center justify-center gap-2 bg-chat-bg text-center text-muted-foreground">
              <p className="text-lg font-medium text-foreground">Lion's Den</p>
              <p className="text-sm">Pick a chat to start messaging.</p>
            </div>
          )}
        </main>
        </div>
      </div>
      <ProfilePanel
        profile={profileTarget ?? me}
        open={profileOpen}
        onOpenChange={setProfileOpen}
        editable={(profileTarget ?? me).id === me.id}
        onStatusSaved={(statusText) => {
          setMe((current) => current ? { ...current, status_text: statusText } : current);
          setPeers((current) => current.map((profile) => profile.id === me.id ? { ...profile, status_text: statusText } : profile));
          setAll((current) => current.map((profile) => profile.id === me.id ? { ...profile, status_text: statusText } : profile));
        }}
      />
    </CallProvider>
  );
}
