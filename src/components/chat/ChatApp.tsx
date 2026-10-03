import { useCallback, useEffect, useRef, useState } from "react";
import { Archive, ArchiveRestore, ArrowLeft, Bell, BellOff, Camera, ChevronDown, LogOut, MessageSquare, Moon, MoreVertical, PhoneCall, Pin, PinOff, Sun, Trash2 } from "lucide-react";
import { supabase, type Message, type Profile, emitMsg, bus, hideChatForMe, pairFilter } from "@/lib/supabase";
import { listTime } from "@/lib/format";
import { alertsMuted, messageTone, notificationsEnabled, notify, registerNotificationWorker, setNotificationsOff } from "@/lib/tones";
import { cn } from "@/lib/utils";
import { secureLogout, useGlobalLogout, useIdleLogout } from "@/lib/security";
import { AvatarCropper } from "./AvatarCropper";
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
  const [notifOn, setNotifOn] = useState(false);
  const [archived, toggleArchived] = useStoredSet(me ? `archived-chats:${me.id}` : null);
  const [muted, toggleMuted, mutedRef] = useStoredSet(me ? `muted-chats:${me.id}` : null);
  const [showArchived, setShowArchived] = useState(false);
  const [rowMenu, setRowMenu] = useState<string | null>(null);
  const [chatVersion, setChatVersion] = useState(0);
  const rowPressTimer = useRef<number | undefined>(undefined);
  const rowLongPressed = useRef(false);
  const { left, disabled: idleLogoutDisabled, tapCountdown } = useIdleLogout();
  useGlobalLogout();
  const photoRef = useRef<HTMLInputElement>(null);
  const [photoBusy, setPhotoBusy] = useState(false);
  const selRef = useRef<string | null>(null);
  selRef.current = sel;
  const allRef = useRef(all);
  allRef.current = all;

  const setAvatar = async (url: string | null) => {
    if (!me) return;
    setPhotoBusy(true);
    const { error } = await supabase.from("profiles").update({ avatar_url: url }).eq("id", me.id);
    setPhotoBusy(false);
    if (error) return alert("Could not update the photo. Please try again.");
    setMe({ ...me, avatar_url: url });
    setAll((a) => a.map((p) => (p.id === me.id ? { ...p, avatar_url: url } : p)));
  };
  const [cropFile, setCropFile] = useState<File | null>(null);
  const pickPhoto = (f: File | undefined) => {
    if (f) setCropFile(f);
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

  const toggleArchive = (peerId: string) => {
    const archiving = !archived.has(peerId);
    if (archiving && pinned.has(peerId)) void togglePin(peerId);
    toggleArchived(peerId, archiving);
  };

  const deleteChat = async (peerId: string) => {
    if (!me) return;
    const name = peers.find((p) => p.id === peerId)?.display_name ?? "this chat";
    if (!window.confirm(`Delete chat with ${name}? Messages are removed for you only.`)) return;
    if (!(await hideChatForMe(me.id, peerId))) return alert("Could not delete this chat. Please try again.");
    setLast((l) => ({ ...l, [peerId]: undefined }));
    setUnread((u) => ({ ...u, [peerId]: 0 }));
    if (selRef.current === peerId) setChatVersion((v) => v + 1); // reload the open conversation
  };

  // Tap and hold (or right-click) a chat to open its menu.
  const startRowPress = (peerId: string) => {
    rowLongPressed.current = false;
    clearTimeout(rowPressTimer.current);
    rowPressTimer.current = window.setTimeout(() => {
      rowLongPressed.current = true;
      setRowMenu(peerId);
    }, 500);
  };
  const cancelRowPress = () => clearTimeout(rowPressTimer.current);

  const openProfile = useCallback((profile: Profile) => {
    setProfileTarget(profile);
    setProfileOpen(true);
  }, []);

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
  const closeChat = useCallback(() => {
    if (history.state?.chat) history.back();
    else setSel(null);
  }, []);
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
  const currentProfileId = me?.id;
  useEffect(() => {
    if (!currentProfileId) return;
    const ch = supabase.channel("presence:global", { config: { presence: { key: currentProfileId } } });
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
    const updateOnlineState = () => {
      const visible = document.visibilityState === "visible";
      const update = visible
        ? { is_online: true, last_seen: new Date().toISOString() }
        : { is_online: false };
      void supabase.from("profiles").update(update).eq("id", currentProfileId).then(({ error }) => {
        if (error) console.error("Could not update online status:", error);
      });
    };
    const markOffline = () => {
      void supabase.from("profiles").update({ is_online: false }).eq("id", currentProfileId).then(({ error }) => {
        if (error) console.error("Could not mark profile offline:", error);
      });
    };
    updateOnlineState();
    const t = setInterval(updateOnlineState, 30000);
    document.addEventListener("visibilitychange", updateOnlineState);
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
    window.addEventListener("beforeunload", markOffline);
    return () => {
      clearInterval(t);
      markOffline();
      document.removeEventListener("visibilitychange", trackPresence);
      document.removeEventListener("visibilitychange", updateOnlineState);
      window.removeEventListener("beforeunload", markOffline);
      supabase.removeChannel(ch);
      supabase.removeChannel(pch);
    };
  }, [currentProfileId]);

  // Message stream
  useEffect(() => {
    if (!me) return;
    const meId = me.id;
    const onChange = (m: Message, isInsert: boolean) => {
      if (m.sender_id !== meId && m.receiver_id !== meId) return;
      emitMsg(m);
      const peer = m.sender_id === meId ? m.receiver_id : m.sender_id;
      setLast((l) => {
        const cur = l[peer];
        if (m.deleted_for?.includes(me.id)) return cur?.id === m.id ? { ...l, [peer]: undefined } : l;
        if (!cur || cur.id === m.id || new Date(m.created_at) >= new Date(cur.created_at)) return { ...l, [peer]: m };
        return l;
      });
      if (isInsert && m.receiver_id === meId) {
        if (m.status === "sent") supabase.from("messages").update({ status: "delivered" }).eq("id", m.id).eq("status", "sent").then();
        const visible = selRef.current === peer && document.visibilityState === "visible";
        if (!visible && m.type !== "call") {
          setUnread((u) => ({ ...u, [peer]: (u[peer] ?? 0) + 1 }));
          const who = allRef.current.find((p) => p.id === peer)?.display_name ?? "New message";
          if (!mutedRef.current.has(peer)) {
            if (!alertsMuted()) messageTone();
            void notify(who, preview(m, meId), `chat-${peer}`);
          }
        }
      }
    };
    const ch = supabase
      .channel("messages-" + meId)
      .on("postgres_changes", { event: "*", schema: "public", table: "messages" }, (payload) => {
        if (payload.new && typeof payload.new === "object" && "id" in payload.new) {
          onChange(payload.new as Message, payload.eventType === "INSERT");
        }
      })
      .subscribe((status, error) => {
        if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          console.error("Message realtime subscription failed:", status, error);
        }
      });
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
  }, [me?.id, mutedRef]);

  // Notification state survives logout: logging out removes the service worker, so register it again.
  useEffect(() => {
    const on = notificationsEnabled();
    setNotifOn(on);
    if (on) void registerNotificationWorker();
  }, []);

  // Unread count on the browser tab ("(3) Ontario ISP") and on the installed app icon.
  const totalUnread = Object.values(unread).reduce((sum, n) => sum + n, 0);
  const baseTitle = useRef<string | null>(null);
  useEffect(() => {
    baseTitle.current ??= document.title.replace(/^\(\d+\)\s*/, "");
    document.title = totalUnread ? `(${totalUnread}) ${baseTitle.current}` : baseTitle.current;
    const nav = navigator as Navigator & { setAppBadge?: (n: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
    if (totalUnread) void nav.setAppBadge?.(totalUnread).catch(() => {});
    else void nav.clearAppBadge?.().catch(() => {});
  }, [totalUnread]);
  useEffect(() => () => {
    if (baseTitle.current) document.title = baseTitle.current;
  }, []);

  const clearUnread = useCallback((id: string) => setUnread((u) => ({ ...u, [id]: 0 })), []);

  const askNotify = async () => {
    if (notifOn) {
      setNotificationsOff(true);
      setNotifOn(false);
      return;
    }
    const sendTestNotification = async () => {
      setNotificationsOff(false);
      setNotifOn(true);
      await registerNotificationWorker();
      const testNotificationSent = await notify(
        "Notifications enabled",
        "Browser notifications are ready on this device.",
      );
      alert(
        testNotificationSent
          ? "Browser notifications are enabled. A test notification was sent to this browser."
          : "Permission is enabled, but this browser could not display a test notification. Check browser and device notification settings.",
      );
    };

    if (typeof Notification === "undefined") {
      alert("This browser does not support notifications.");
      return;
    }
    if (Notification.permission === "granted") {
      await sendTestNotification();
      return;
    }
    if (Notification.permission === "denied") {
      alert(
        "Notifications are blocked by your browser. Allow them in the browser's site settings.",
      );
      return;
    }
    if (
      !window.confirm(
        "Enable browser notifications for incoming messages and calls? Notifications will be delivered by this browser only.",
      )
    )
      return;

    try {
      const permission = await Notification.requestPermission();
      if (permission === "granted") {
        await sendTestNotification();
      }
      else if (permission === "denied")
        alert(
          "Browser notifications were blocked. You can change this in your browser's site settings.",
        );
      else alert("Browser notifications were not enabled.");
    } catch (error) {
      console.error("Could not request browser notification permission:", error);
      alert("Could not enable browser notifications. Please try again.");
    }
  };

  if (missing)
    return (
      <div className="app-shell flex flex-col items-center justify-center gap-4 p-6 text-center">
        <p className="max-w-md text-muted-foreground">Your account has no profile yet. Run the setup script (supabase-setup.sql) in the database, then sign in again.</p>
        <button onClick={() => secureLogout(true)} className="rounded-lg border px-4 py-2 text-sm text-muted-foreground hover:bg-muted">Log out</button>
      </div>
    );
  if (!me) return <div className="app-shell flex items-center justify-center text-sm text-muted-foreground">Loading…</div>;

  const sorted = [...peers]
    .filter((p) => archived.has(p.id) === showArchived)
    .sort((a, b) => {
      const pinOrder = Number(pinned.has(b.id)) - Number(pinned.has(a.id));
      return pinOrder || new Date(last[b.id]?.created_at ?? 0).getTime() - new Date(last[a.id]?.created_at ?? 0).getTime();
    });
  const archivedCount = peers.filter((p) => archived.has(p.id)).length;
  const archivedUnread = peers.reduce((sum, p) => sum + (archived.has(p.id) ? unread[p.id] ?? 0 : 0), 0);
  const peer = peers.find((p) => p.id === sel);

  return (
    <CallProvider me={me} profiles={all}>
      <div className="app-shell flex flex-col overflow-hidden bg-background">
        <div className="flex h-11 shrink-0 items-center justify-between gap-2 bg-primary px-2 text-primary-foreground sm:px-4">
          <span className="min-w-0 flex-1 truncate text-center text-[10px] font-bold tracking-[0.12em] sm:text-xs sm:tracking-[0.35em]">CYBER SECURITY WING</span>
          <div className="flex shrink-0 items-center gap-1.5">
            <button type="button" onClick={tapCountdown} className="cursor-pointer select-none rounded-md bg-primary-foreground/15 px-1.5 py-1 text-[11px] font-semibold tabular-nums hover:bg-primary-foreground/25 sm:px-2 sm:text-xs" aria-label={idleLogoutDisabled ? "Automatic logout is disabled. Click to turn it back on." : `Automatic logout in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}. Click five times to disable it for this session.`} title={idleLogoutDisabled ? "Click to enable automatic logout for this session" : "Click five times to disable automatic logout for this session"}>
              {idleLogoutDisabled ? "OFF" : `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`}
            </button>
            <button onClick={() => secureLogout(true)} className="flex h-9 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg bg-destructive px-3 text-destructive-foreground shadow-sm hover:opacity-90" aria-label="Log out">
              <LogOut className="h-4 w-4" />
              <span className="text-xs font-semibold">Log out</span>
            </button>
          </div>
        </div>
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
              <AvatarCropper file={cropFile} onCancel={() => setCropFile(null)} onDone={(url) => { setCropFile(null); void setAvatar(url); }} />
            </div>
            <div className="flex items-center gap-1">
            <DropdownMenu>
              <DropdownMenuTrigger className="rounded-full p-2 text-muted-foreground hover:bg-muted" aria-label="Menu">
                <MoreVertical className="h-5 w-5" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => photoRef.current?.click()}><Camera className="mr-2 h-4 w-4" />{photoBusy ? "Saving…" : "Change profile photo"}</DropdownMenuItem>
                {me.avatar_url && <DropdownMenuItem onClick={() => setAvatar(null)}><Trash2 className="mr-2 h-4 w-4" />Remove profile photo</DropdownMenuItem>}
                <DropdownMenuItem onClick={toggleDark}>{dark ? <Sun className="mr-2 h-4 w-4" /> : <Moon className="mr-2 h-4 w-4" />}{dark ? "Light mode" : "Dark mode"}</DropdownMenuItem>
                <DropdownMenuItem onClick={askNotify}>{notifOn ? <BellOff className="mr-2 h-4 w-4" /> : <Bell className="mr-2 h-4 w-4" />}{notifOn ? "Disable notifications" : "Enable notifications"}</DropdownMenuItem>
                <DropdownMenuItem onClick={() => secureLogout(true)} className="text-muted-foreground focus:text-foreground"><LogOut className="mr-2 h-4 w-4" />Log out</DropdownMenuItem>
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
            {showArchived ? (
              <li>
                <button type="button" onClick={() => setShowArchived(false)} className="flex w-full items-center gap-3 px-4 py-3 text-left text-sm font-medium text-primary hover:bg-muted">
                  <ArrowLeft size={18} /> Archived chats
                </button>
              </li>
            ) : archivedCount > 0 && (
              <li>
                <button type="button" onClick={() => setShowArchived(true)} className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-muted">
                  <span className="flex h-12 w-12 items-center justify-center text-primary"><Archive size={20} /></span>
                  <span className="flex-1 font-medium">Archived</span>
                  <span className="text-xs font-medium text-primary">{archivedUnread || archivedCount}</span>
                </button>
              </li>
            )}
            {showArchived && sorted.length === 0 && <li className="px-4 py-8 text-center text-sm text-muted-foreground">No archived chats.</li>}
            {sorted.map((p) => {
              const m = last[p.id];
              const n = unread[p.id] ?? 0;
              const isPinned = pinned.has(p.id);
              const isMuted = muted.has(p.id);
              const isArchived = archived.has(p.id);
              return (
                <li key={p.id}>
                  <div
                    className={cn("group flex select-none items-center gap-1 px-2 transition [-webkit-touch-callout:none]", sel === p.id && "bg-muted")}
                    onPointerDown={() => startRowPress(p.id)}
                    onPointerUp={cancelRowPress}
                    onPointerLeave={cancelRowPress}
                    onPointerCancel={cancelRowPress}
                    onPointerMove={(event) => { if (event.pointerType !== "mouse") cancelRowPress(); }}
                    onContextMenu={(event) => { event.preventDefault(); cancelRowPress(); setRowMenu(p.id); }}
                    onClickCapture={(event) => {
                      if (!rowLongPressed.current) return;
                      event.preventDefault();
                      event.stopPropagation();
                      rowLongPressed.current = false;
                    }}
                  >
                    <button onClick={() => openChat(p.id)} className="flex min-w-0 flex-1 items-center gap-3 py-3 pl-2 text-left active:bg-muted md:hover:bg-muted">
                      <Avatar
                        p={p}
                        online={p.show_online_status ? online.has(p.id) : undefined}
                        away={p.show_online_status ? away.has(p.id) : undefined}
                      />
                      <div className="min-w-0 flex-1 border-b border-border/60 pb-2">
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="truncate font-medium">{p.display_name}</span>
                        {m && <span className={cn("shrink-0 text-xs", n && !isMuted ? "font-medium text-primary" : "text-muted-foreground")}>{listTime(m.created_at)}</span>}
                      </div>
                      {p.status_text && <div className="truncate text-xs text-muted-foreground">{p.status_text}</div>}
                      <div className="mt-0.5 flex items-center justify-between gap-2">
                        <span className="truncate text-sm text-muted-foreground">{preview(m, me.id)}</span>
                        <span className="flex shrink-0 items-center gap-1.5 text-muted-foreground">
                          {isMuted && <BellOff size={14} aria-label="Muted" />}
                          {isPinned && <Pin size={14} aria-label="Pinned" />}
                          {n > 0 && <span className={cn("flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-[11px] font-semibold", isMuted ? "bg-muted-foreground/60 text-background" : "bg-primary text-primary-foreground")}>{n}</span>}
                        </span>
                      </div>
                      </div>
                    </button>
                    <DropdownMenu open={rowMenu === p.id} onOpenChange={(open) => setRowMenu(open ? p.id : null)}>
                      <DropdownMenuTrigger className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-muted md:opacity-0 md:group-hover:opacity-100 md:focus:opacity-100 md:data-[state=open]:opacity-100" aria-label={`Chat options for ${p.display_name}`}>
                        <ChevronDown size={18} />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        {!isArchived && (
                          <DropdownMenuItem onClick={() => void togglePin(p.id)}>{isPinned ? <PinOff className="mr-2 h-4 w-4" /> : <Pin className="mr-2 h-4 w-4" />}{isPinned ? "Unpin chat" : "Pin chat"}</DropdownMenuItem>
                        )}
                        <DropdownMenuItem onClick={() => toggleArchive(p.id)}>{isArchived ? <ArchiveRestore className="mr-2 h-4 w-4" /> : <Archive className="mr-2 h-4 w-4" />}{isArchived ? "Unarchive chat" : "Archive chat"}</DropdownMenuItem>
                        <DropdownMenuItem onClick={() => toggleMuted(p.id)}>{isMuted ? <Bell className="mr-2 h-4 w-4" /> : <BellOff className="mr-2 h-4 w-4" />}{isMuted ? "Unmute notifications" : "Mute notifications"}</DropdownMenuItem>
                        <DropdownMenuItem onClick={() => void deleteChat(p.id)} className="text-destructive focus:text-destructive"><Trash2 className="mr-2 h-4 w-4" />Delete chat</DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </li>
              );
            })}
          </ul>}
        </aside>
        <main className={cn("min-w-0 flex-1", !sel && "hidden md:flex")}>
          {peer ? (
            <Conversation key={`${peer.id}:${chatVersion}`} me={me} peer={peer} online={peer.show_online_status && online.has(peer.id)} away={peer.show_online_status && away.has(peer.id)} onBack={closeChat} onSeen={clearUnread} onViewProfile={openProfile} />
          ) : (
            <div className="flex h-full w-full flex-col items-center justify-center gap-2 bg-chat-bg text-center text-muted-foreground">
              <p className="text-lg font-medium text-foreground">Ontario ISP</p>
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
        onTelegramAlertsSaved={(enabled) => {
          setMe((current) => current ? { ...current, telegram_alerts_enabled: enabled } : current);
          setPeers((current) => current.map((profile) => profile.id === me.id ? { ...profile, telegram_alerts_enabled: enabled } : profile));
          setAll((current) => current.map((profile) => profile.id === me.id ? { ...profile, telegram_alerts_enabled: enabled } : profile));
        }}
        onOnlineVisibilitySaved={(enabled) => {
          setMe((current) => current ? { ...current, show_online_status: enabled } : current);
          setPeers((current) => current.map((profile) => profile.id === me.id ? { ...profile, show_online_status: enabled } : profile));
          setAll((current) => current.map((profile) => profile.id === me.id ? { ...profile, show_online_status: enabled } : profile));
        }}
        onReadReceiptsSaved={(enabled) => {
          setMe((current) => current ? { ...current, read_receipts_enabled: enabled } : current);
          setPeers((current) => current.map((profile) => profile.id === me.id ? { ...profile, read_receipts_enabled: enabled } : profile));
          setAll((current) => current.map((profile) => profile.id === me.id ? { ...profile, read_receipts_enabled: enabled } : profile));
        }}
      />
    </CallProvider>
  );
}

/** A set of ids saved per device in localStorage (used for archived and muted chats). */
function useStoredSet(storageKey: string | null) {
  const [items, setItems] = useState<Set<string>>(() => new Set());
  const ref = useRef(items);
  useEffect(() => {
    if (!storageKey) return;
    let next = new Set<string>();
    try {
      const saved: unknown = JSON.parse(localStorage.getItem(storageKey) ?? "[]");
      if (Array.isArray(saved)) next = new Set(saved.filter((id): id is string => typeof id === "string"));
    } catch {
      // Unreadable storage: start empty.
    }
    ref.current = next;
    setItems(next);
  }, [storageKey]);
  const toggle = useCallback((id: string, on?: boolean) => {
    const next = new Set(ref.current);
    if (on ?? !next.has(id)) next.add(id);
    else next.delete(id);
    ref.current = next;
    setItems(next);
    if (!storageKey) return;
    try {
      localStorage.setItem(storageKey, JSON.stringify([...next]));
    } catch {
      // Private mode / storage full: the change still applies for this session.
    }
  }, [storageKey]);
  return [items, toggle, ref] as const;
}
