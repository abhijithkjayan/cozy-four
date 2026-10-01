import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowLeft, Check, CheckCheck, ChevronDown, Download, Forward, Image as ImageIcon, ListChecks, MapPin, MoreVertical, Phone, PhoneMissed, Reply, Send, Sticker, Trash2, Video, X } from "lucide-react";
import { supabase, type Message, type Profile, bus, emitMsg, pairFilter } from "@/lib/supabase";
import { dayLabel, fmtTime, lastSeen } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Avatar } from "./Avatar";
import { AudioPlayer, ImageThumb } from "./Media";
import { VoiceRecorder } from "./VoiceRecorder";
import { GiphyPicker } from "./GiphyPicker";
import { useCalls } from "./Calls";
import { preview } from "./ChatApp";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

const PAGE = 30;

export function Conversation({ me, peer, online, onBack, onSeen, onViewProfile }: { me: Profile; peer: Profile; online: boolean; onBack: () => void; onSeen: (id: string) => void; onViewProfile: (profile: Profile) => void }) {
  const [msgs, setMsgs] = useState<Message[]>([]);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(false);
  const [text, setText] = useState("");
  const [reply, setReply] = useState<Message | null>(null);
  const [typing, setTyping] = useState(false);
  const [viewer, setViewer] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const keepBottom = useRef(true);
  const prevHeight = useRef<number | null>(null);
  const typingCh = useRef<ReturnType<typeof supabase.channel> | null>(null);
  const lastTypingSent = useRef(0);
  const typingTimer = useRef<number | undefined>(undefined);
  const fileRef = useRef<HTMLInputElement>(null);
  const { startCall, busy } = useCalls();
  const [sel, setSel] = useState<Set<string> | null>(null); // selection mode when not null
  const [confirm, setConfirm] = useState<null | "clear" | "delete">(null);
  const [fwdOpen, setFwdOpen] = useState(false);
  const [giphyOpen, setGiphyOpen] = useState(false);
  const [contacts, setContacts] = useState<Profile[]>([]);
  const [busyOp, setBusyOp] = useState(false);
  const pressTimer = useRef<number | undefined>(undefined);

  const visible = (m: Message) => !m.deleted_for?.includes(me.id);

  const markRead = useCallback(() => {
    if (document.visibilityState !== "visible") return;
    supabase.from("messages").update({ status: "read" }).eq("sender_id", peer.id).eq("receiver_id", me.id).neq("status", "read").then();
    onSeen(peer.id);
  }, [peer.id, me.id, onSeen]);

  const load = useCallback(async (before?: string) => {
    setLoading(true);
    let q = supabase.from("messages").select("*").or(pairFilter(me.id, peer.id)).order("created_at", { ascending: false }).limit(PAGE);
    if (before) q = q.lt("created_at", before);
    const { data } = await q;
    const rows = ((data ?? []) as Message[]).reverse();
    setHasMore(rows.length === PAGE);
    if (before && scroller.current) prevHeight.current = scroller.current.scrollHeight;
    setMsgs((m) => (before ? [...rows, ...m] : rows));
    setLoading(false);
  }, [me.id, peer.id]);

  useEffect(() => {
    load();
    markRead();
    const onVis = () => markRead();
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [load, markRead]);

  // Live updates
  useEffect(() => {
    const on = (e: Event) => {
      const m = (e as CustomEvent<Message>).detail;
      const inPair = (m.sender_id === peer.id && m.receiver_id === me.id) || (m.sender_id === me.id && m.receiver_id === peer.id);
      if (!inPair) return;
      setMsgs((list) => {
        const i = list.findIndex((x) => x.id === m.id);
        if (i >= 0) { const c = [...list]; c[i] = m; return c; }
        const el = scroller.current;
        keepBottom.current = !el || el.scrollHeight - el.scrollTop - el.clientHeight < 150 || m.sender_id === me.id;
        return [...list, m];
      });
      if (m.sender_id === peer.id) { setTyping(false); if (m.status !== "read") markRead(); }
    };
    bus.addEventListener("msg", on);
    return () => bus.removeEventListener("msg", on);
  }, [peer.id, me.id, markRead]);

  // Typing channel
  useEffect(() => {
    const ch = supabase.channel(`typing:${[me.id, peer.id].sort().join(":")}`);
    ch.on("broadcast", { event: "typing" }, ({ payload }) => {
      if (payload.from !== peer.id) return;
      setTyping(true);
      clearTimeout(typingTimer.current);
      typingTimer.current = window.setTimeout(() => setTyping(false), 3500);
    }).subscribe();
    typingCh.current = ch;
    return () => { supabase.removeChannel(ch); clearTimeout(typingTimer.current); };
  }, [me.id, peer.id]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (prevHeight.current !== null) {
      el.scrollTop = el.scrollHeight - prevHeight.current;
      prevHeight.current = null;
    } else if (keepBottom.current) el.scrollTop = el.scrollHeight;
  }, [msgs]);

  const onScroll = () => {
    const el = scroller.current;
    if (el && el.scrollTop < 60 && hasMore && !loading && msgs.length) load(msgs[0]!.created_at);
  };

  const onType = (v: string) => {
    setText(v);
    if (Date.now() - lastTypingSent.current > 2000) {
      lastTypingSent.current = Date.now();
      typingCh.current?.send({ type: "broadcast", event: "typing", payload: { from: me.id } });
    }
  };

  const insert = async (row: Partial<Message>) => {
    keepBottom.current = true;
    const { data, error } = await supabase.from("messages").insert({ sender_id: me.id, receiver_id: peer.id, reply_to: reply?.id ?? null, ...row }).select().single();
    if (error) return alert("Message failed to send.");
    setReply(null);
    emitMsg(data as Message);
  };

  const sendText = () => {
    const t = text.trim();
    if (!t) return;
    setText("");
    insert({ type: "text", content: t });
  };

  const upload = async (blob: Blob, ext: string) => {
    const path = `${me.id}/${peer.id}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
    const { error } = await supabase.storage.from("chat-media").upload(path, blob, { contentType: blob.type });
    if (error) { alert("Upload failed."); return null; }
    return path;
  };

  const sendImages = async (files: File[]) => {
    setUploading(true);
    for (const f of files) {
      const path = await upload(f, f.name.split(".").pop() || "jpg");
      if (path) insert({ type: "image", media_url: path });
    }
    setUploading(false);
  };

  const sendVoice = async (blob: Blob, secs: number, mime: string) => {
    setUploading(true);
    const path = await upload(blob, mime.includes("mp4") ? "m4a" : mime.includes("ogg") ? "ogg" : "webm");
    setUploading(false);
    if (path) insert({ type: "audio", media_url: path, content: String(Math.round(secs)) });
  };

  const sendLocation = () => {
    if (!navigator.geolocation) return alert("Location is not available in this browser.");
    setUploading(true);
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => {
        setUploading(false);
        insert({ type: "location", content: JSON.stringify({ lat: coords.latitude, lng: coords.longitude, mapsUrl: `https://www.google.com/maps?q=${coords.latitude},${coords.longitude}` }) });
      },
      () => { setUploading(false); alert("Could not get your location. Please allow location access and try again."); },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 },
    );
  };

  const sendGiphy = (kind: "gif" | "sticker", item: { url: string; preview: string; title: string }) => {
    setGiphyOpen(false);
    insert({ type: kind, content: JSON.stringify(item) });
  };

  const downloadAttachment = async (message: Message, url?: string, title?: string) => {
    try {
      let blob: Blob;
      let filename: string;
      if (message.media_url) {
        const { data, error } = await supabase.storage.from("chat-media").download(message.media_url);
        if (error || !data) throw error ?? new Error("Attachment not found");
        blob = data;
        filename = decodeURIComponent(message.media_url.split("/").pop() || `attachment-${message.id}`);
      } else if (url) {
        const response = await fetch(url);
        if (!response.ok) throw new Error("Download failed");
        blob = await response.blob();
        const extension = new URL(url).pathname.match(/\.([a-z0-9]{2,5})$/i)?.[1] || "gif";
        filename = title?.trim().replace(/[\\/:*?"<>|]/g, "_") || `attachment-${message.id}`;
        if (!/\.[a-z0-9]{2,5}$/i.test(filename)) filename += `.${extension}`;
      } else {
        return;
      }

      const objectUrl = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = objectUrl;
      link.download = filename;
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
    } catch {
      alert("Could not download this attachment. Please try again.");
    }
  };

  const deleteForMe = (m: Message) => supabase.from("messages").update({ deleted_for: [...(m.deleted_for ?? []), me.id] }).eq("id", m.id).then();
  const deleteForAll = (m: Message) => supabase.from("messages").update({ deleted_for_everyone: true, content: null, media_url: null }).eq("id", m.id).then();

  // ---- selection / clear / forward ----
  const toggleSel = (id: string) =>
    setSel((s) => {
      if (!s) return s;
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  const startSel = (id: string) => setSel(new Set([id]));
  const cancelPress = () => clearTimeout(pressTimer.current);
  const markDeletedLocally = (ids: Set<string>) =>
    setMsgs((l) => l.map((m) => (ids.has(m.id) && !m.deleted_for?.includes(me.id) ? { ...m, deleted_for: [...(m.deleted_for ?? []), me.id] } : m)));

  const selected = msgs.filter((m) => sel?.has(m.id));
  const allMine = selected.length > 0 && selected.every((m) => m.sender_id === me.id && !m.deleted_for_everyone && m.type !== "call");
  const forwardable = selected.filter((m) => m.type !== "call" && !m.deleted_for_everyone);

  // Mark messages as deleted for me (client-side, no database changes needed)
  const hideForMe = async (rows: { id: string; deleted_for: string[] | null }[]) => {
    for (let i = 0; i < rows.length; i += 15) {
      const results = await Promise.all(
        rows.slice(i, i + 15).map((r) => supabase.from("messages").update({ deleted_for: [...(r.deleted_for ?? []), me.id] }).eq("id", r.id)),
      );
      if (results.some((r) => r.error)) return false;
    }
    return true;
  };
  const doClear = async () => {
    setBusyOp(true);
    const { data, error } = await supabase.from("messages").select("id, deleted_for").or(pairFilter(me.id, peer.id)).not("deleted_for", "cs", `{${me.id}}`);
    const ok = !error && (await hideForMe((data ?? []) as { id: string; deleted_for: string[] | null }[]));
    setBusyOp(false);
    if (!ok) return alert("Could not clear chat. Please try again.");
    markDeletedLocally(new Set((data ?? []).map((r) => r.id as string)));
    setMsgs((l) => l.map((m) => (m.deleted_for?.includes(me.id) ? m : { ...m, deleted_for: [...(m.deleted_for ?? []), me.id] })));
    setConfirm(null);
    setSel(null);
  };
  const doDeleteForMe = async () => {
    setBusyOp(true);
    const ok = await hideForMe(selected.map((m) => ({ id: m.id, deleted_for: m.deleted_for })));
    setBusyOp(false);
    if (!ok) return alert("Could not delete. Please try again.");
    markDeletedLocally(new Set(selected.map((m) => m.id)));
    setConfirm(null);
    setSel(null);
  };
  const doDeleteForAll = async () => {
    const ids = selected.map((m) => m.id);
    setBusyOp(true);
    const { error } = await supabase.from("messages").update({ deleted_for_everyone: true, content: null, media_url: null }).in("id", ids).eq("sender_id", me.id);
    setBusyOp(false);
    if (error) return alert("Could not delete for everyone.");
    setMsgs((l) => l.map((m) => (ids.includes(m.id) ? { ...m, deleted_for_everyone: true, content: null, media_url: null } : m)));
    setConfirm(null);
    setSel(null);
  };
  const openForward = async () => {
    setFwdOpen(true);
    const { data } = await supabase.from("profiles").select("*").neq("id", me.id).order("user_id");
    setContacts((data ?? []) as Profile[]);
  };
  const forwardTo = async (target: Profile) => {
    setBusyOp(true);
    const items = [...forwardable].sort((a, b) => a.created_at.localeCompare(b.created_at));
    for (const m of items) {
      let media = m.media_url;
      if (media) {
        const ext = media.split(".").pop() || "bin";
        const dest = `${me.id}/${target.id}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
        const { error } = await supabase.storage.from("chat-media").copy(media, dest);
        if (error) continue;
        media = dest;
      }
      const { data, error } = await supabase.from("messages").insert({ sender_id: me.id, receiver_id: target.id, type: m.type, content: m.content, media_url: media }).select().single();
      if (!error && data) emitMsg(data as Message);
    }
    setBusyOp(false);
    setFwdOpen(false);
    setSel(null);
  };

  const byId = new Map(msgs.map((m) => [m.id, m]));
  const shown = msgs.filter(visible);
  const status = typing ? "typing…" : online ? "online" : lastSeen(peer.last_seen);

  return (
    <div className="flex h-full w-full flex-col bg-chat-bg">
      {sel ? (
        <header className="box-content flex h-16 shrink-0 items-center gap-2 border-b bg-card px-2 pt-[env(safe-area-inset-top)]">
          <button onClick={() => setSel(null)} className="flex h-11 w-11 items-center justify-center rounded-full active:bg-muted" aria-label="Cancel selection"><X className="h-5 w-5" /></button>
          <div className="flex-1 font-medium">{sel.size} selected</div>
          <button disabled={!forwardable.length} onClick={openForward} className="flex h-11 w-11 items-center justify-center rounded-full text-muted-foreground active:bg-muted disabled:opacity-30" aria-label="Forward"><Forward className="h-5 w-5" /></button>
          <button disabled={!sel.size} onClick={() => setConfirm("delete")} className="flex h-11 w-11 items-center justify-center rounded-full text-destructive active:bg-muted disabled:opacity-30" aria-label="Delete"><Trash2 className="h-5 w-5" /></button>
        </header>
      ) : (
      <header className="box-content flex h-16 shrink-0 items-center gap-2 border-b bg-card px-2 pt-[env(safe-area-inset-top)] md:gap-3 md:px-4">
        <button onClick={onBack} className="flex h-11 w-11 items-center justify-center rounded-full active:bg-muted md:hidden" aria-label="Back"><ArrowLeft className="h-5 w-5" /></button>
        <button type="button" onClick={() => onViewProfile(peer)} className="flex min-w-0 flex-1 items-center gap-2 rounded-md text-left hover:bg-muted/50" aria-label={`View ${peer.display_name}'s profile and login activity`}>
          <Avatar p={peer} size={40} />
          <span className="min-w-0 flex-1">
            <span className="block truncate font-medium">{peer.display_name}</span>
            {peer.status_text && <span className="block truncate text-xs text-muted-foreground">{peer.status_text}</span>}
            <span className={cn("block line-clamp-1 text-xs leading-4", typing ? "text-primary" : "text-muted-foreground")}>{status}</span>
          </span>
        </button>
        <button disabled={busy} onClick={() => startCall(peer, true)} className="flex h-11 w-11 items-center justify-center rounded-full text-muted-foreground active:bg-muted disabled:opacity-40 md:hover:bg-muted" aria-label="Video call"><Video className="h-5 w-5" /></button>
        <button disabled={busy} onClick={() => startCall(peer, false)} className="flex h-11 w-11 items-center justify-center rounded-full text-muted-foreground active:bg-muted disabled:opacity-40 md:hover:bg-muted" aria-label="Voice call"><Phone className="h-5 w-5" /></button>
        <DropdownMenu>
          <DropdownMenuTrigger className="flex h-11 w-11 items-center justify-center rounded-full text-muted-foreground active:bg-muted md:hover:bg-muted" aria-label="Chat menu"><MoreVertical className="h-5 w-5" /></DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => setSel(new Set())}><ListChecks className="mr-2 h-4 w-4" />Select messages</DropdownMenuItem>
            <DropdownMenuItem onClick={() => setConfirm("clear")} className="text-destructive"><Trash2 className="mr-2 h-4 w-4" />Clear chat</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </header>
      )}

      <div ref={scroller} onScroll={onScroll} className="flex-1 overflow-y-auto overscroll-contain px-3 py-4 md:px-[8%]">
        {loading && hasMore && <div className="py-2 text-center text-xs text-muted-foreground">Loading…</div>}
        {shown.map((m, i) => {
          const newDay = i === 0 || dayLabel(shown[i - 1]!.created_at) !== dayLabel(m.created_at);
          const mine = m.sender_id === me.id;
          const rep = m.reply_to ? byId.get(m.reply_to) : undefined;
          const attachment = parseAttachment(m.content);
          return (
            <Fragment key={m.id}>
              {newDay && (
                <div className="my-3 flex justify-center">
                  <span className="rounded-lg bg-card px-3 py-1 text-xs text-muted-foreground shadow-sm">{dayLabel(m.created_at)}</span>
                </div>
              )}
              {m.type === "call" ? (
                <div className={cn("my-2 flex items-center justify-center gap-2", sel?.has(m.id) && "bg-primary/10")} onClick={sel ? () => toggleSel(m.id) : undefined}>
                  {sel && <Tick on={sel.has(m.id)} />}
                  <span className={cn("flex items-center gap-2 rounded-lg bg-card px-3 py-1.5 text-xs shadow-sm", m.content?.startsWith("Missed") && "text-destructive")}>
                    {m.content?.startsWith("Missed") ? <PhoneMissed className="h-3.5 w-3.5" /> : m.content?.startsWith("Video") ? <Video className="h-3.5 w-3.5" /> : <Phone className="h-3.5 w-3.5" />}
                    {m.content} · {fmtTime(m.created_at)}
                  </span>
                </div>
              ) : (
                <div
                  className={cn("group my-0.5 flex items-center gap-2 [-webkit-touch-callout:none]", mine ? "justify-end" : "justify-start", sel?.has(m.id) && "bg-primary/10", sel && "cursor-pointer")}
                  onClick={sel ? () => toggleSel(m.id) : undefined}
                  onPointerDown={!sel && !m.deleted_for_everyone ? () => { pressTimer.current = window.setTimeout(() => startSel(m.id), 500); } : undefined}
                  onPointerUp={cancelPress}
                  onPointerLeave={cancelPress}
                  onPointerCancel={cancelPress}
                  onPointerMove={cancelPress}
                >
                  {sel && <div className={cn(mine && "order-last")}><Tick on={sel.has(m.id)} /></div>}
                  <div className={cn("relative max-w-[80%] rounded-xl px-2 pb-1 pt-1.5 shadow-sm md:max-w-[65%]", mine ? "rounded-tr-sm bg-bubble-out" : "rounded-tl-sm bg-bubble-in")}>
                    {!m.deleted_for_everyone && (
                      <DropdownMenu>
                        <DropdownMenuTrigger className="absolute right-0 top-0 z-10 flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground opacity-0 transition group-hover:opacity-100 focus:opacity-100 data-[state=open]:opacity-100 max-md:opacity-60" aria-label="Message options">
                          <ChevronDown className="h-4 w-4" />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align={mine ? "end" : "start"}>
                          <DropdownMenuItem onClick={() => setReply(m)}><Reply className="mr-2 h-4 w-4" />Reply</DropdownMenuItem>
                          {(m.media_url || attachment?.url) && <DropdownMenuItem onClick={() => void downloadAttachment(m, attachment?.url, attachment?.title)}><Download className="mr-2 h-4 w-4" />Download</DropdownMenuItem>}
                          <DropdownMenuItem onClick={() => startSel(m.id)}><ListChecks className="mr-2 h-4 w-4" />Select</DropdownMenuItem>
                          <DropdownMenuItem onClick={() => deleteForMe(m)}><Trash2 className="mr-2 h-4 w-4" />Delete for me</DropdownMenuItem>
                          {mine && <DropdownMenuItem onClick={() => deleteForAll(m)} className="text-destructive"><Trash2 className="mr-2 h-4 w-4" />Delete for everyone</DropdownMenuItem>}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                    {rep && !m.deleted_for_everyone && (
                      <div className="mb-1 rounded-md border-l-4 border-primary bg-foreground/5 px-2 py-1 text-xs">
                        <div className="font-medium text-primary">{rep.sender_id === me.id ? "You" : peer.display_name}</div>
                        <div className="truncate text-muted-foreground">{preview(rep, "")}</div>
                      </div>
                    )}
                    {m.deleted_for_everyone ? (
                      <p className="px-1 pr-16 text-sm italic text-muted-foreground">🚫 This message was deleted</p>
                    ) : m.type === "image" && m.media_url ? (
                      <ImageThumb path={m.media_url} onOpen={setViewer} />
                    ) : m.type === "audio" && m.media_url ? (
                      <AudioPlayer path={m.media_url} duration={Number(m.content) || 0} />
                    ) : m.type === "location" && attachment?.mapsUrl ? (
                      <a href={attachment.mapsUrl} target="_blank" rel="noreferrer" className="flex min-w-52 items-center gap-3 rounded-lg bg-primary/10 px-3 py-3 text-sm hover:bg-primary/20">
                        <MapPin className="h-5 w-5 shrink-0 text-primary" />
                        <span><strong className="block">Current location</strong><span className="text-xs text-muted-foreground">Open in Google Maps</span></span>
                      </a>
                    ) : (m.type === "gif" || m.type === "sticker") && attachment?.url ? (
                      <button onClick={() => setViewer(attachment.url!)} className="block overflow-hidden rounded-lg" aria-label={`View ${m.type}`}>
                        <img src={attachment.url} alt={attachment.title || m.type} className="max-h-72 max-w-64 object-cover" />
                      </button>
                    ) : (
                      <p className="whitespace-pre-wrap break-words px-1 pr-16 text-[15px] leading-snug">{m.content}</p>
                    )}
                    <div className="-mt-3.5 flex items-center justify-end gap-1 pl-4 text-[11px] text-muted-foreground">
                      <span>{fmtTime(m.created_at)}</span>
                      {mine && !m.deleted_for_everyone && (m.status === "sent" ? <Check className="h-3.5 w-3.5" /> : <CheckCheck className={cn("h-3.5 w-3.5", m.status === "read" && "text-tick-read")} />)}
                    </div>
                  </div>
                </div>
              )}
            </Fragment>
          );
        })}
        {typing && (
          <div className="my-1 flex">
            <div className="flex gap-1 rounded-xl rounded-tl-sm bg-bubble-in px-3 py-3 shadow-sm">
              {[0, 1, 2].map((i) => <span key={i} className="h-2 w-2 animate-bounce rounded-full bg-muted-foreground/60" style={{ animationDelay: `${i * 0.15}s` }} />)}
            </div>
          </div>
        )}
      </div>

      {reply && (
        <div className="flex items-center gap-2 border-t bg-card px-3 py-2">
          <div className="min-w-0 flex-1 rounded-md border-l-4 border-primary bg-muted px-2 py-1 text-xs">
            <div className="font-medium text-primary">{reply.sender_id === me.id ? "You" : peer.display_name}</div>
            <div className="truncate text-muted-foreground">{preview(reply, "")}</div>
          </div>
          <button onClick={() => setReply(null)} className="p-1 text-muted-foreground" aria-label="Cancel reply"><X className="h-4 w-4" /></button>
        </div>
      )}

      <div className={cn("flex items-end gap-2 bg-chat-bg px-2 py-2 md:px-4", sel && "hidden")} style={{ paddingBottom: "max(0.5rem, env(safe-area-inset-bottom))" }}>
        <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={(e) => { const files = Array.from(e.target.files || []).slice(0, 20); if (files.length) sendImages(files); e.target.value = ""; }} />
        {text ? null : (
          <>
            <button onClick={() => fileRef.current?.click()} disabled={uploading} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-muted-foreground active:bg-muted disabled:opacity-50" aria-label="Send photo">
              <ImageIcon className="h-5 w-5" />
            </button>
            <button onClick={sendLocation} disabled={uploading} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-muted-foreground active:bg-muted disabled:opacity-50" aria-label="Send current location">
              <MapPin className="h-5 w-5" />
            </button>
            <button onClick={() => setGiphyOpen(true)} disabled={uploading} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-muted-foreground active:bg-muted disabled:opacity-50" aria-label="Send GIF or sticker">
              <Sticker className="h-5 w-5" />
            </button>
          </>
        )}
        <textarea
          value={text}
          onChange={(e) => onType(e.target.value)}
          onKeyDown={(e) => {
            // On phones Enter adds a new line (like WhatsApp); on desktop Enter sends
            const touch = window.matchMedia("(pointer: coarse)").matches;
            if (e.key === "Enter" && !e.shiftKey && !touch) { e.preventDefault(); sendText(); }
          }}
          onFocus={() => setTimeout(() => { const el = scroller.current; if (el) el.scrollTop = el.scrollHeight; }, 300)}
          enterKeyHint="enter"
          autoCapitalize="sentences"
          rows={1}
          placeholder={uploading ? "Sending…" : "Message"}
          className="max-h-32 min-h-11 flex-1 resize-none rounded-3xl border-0 bg-card px-4 py-2.5 text-base leading-snug shadow-sm outline-none"
        />
        {text.trim() ? (
          <button onClick={sendText} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground" aria-label="Send">
            <Send className="h-5 w-5" />
          </button>
        ) : (
          <VoiceRecorder onSend={sendVoice} />
        )}
      </div>

      {confirm && (
        <Modal onClose={() => !busyOp && setConfirm(null)}>
          {confirm === "clear" ? (
            <>
              <h3 className="text-base font-semibold">Clear this chat?</h3>
              <p className="mt-1 text-sm text-muted-foreground">All messages will be removed for you. {peer.display_name} will still have them.</p>
              <div className="mt-5 flex justify-end gap-2">
                <button disabled={busyOp} onClick={() => setConfirm(null)} className="rounded-lg px-4 py-2 text-sm">Cancel</button>
                <button disabled={busyOp} onClick={doClear} className="rounded-lg bg-destructive px-4 py-2 text-sm font-medium text-white disabled:opacity-60">{busyOp ? "Clearing…" : "Clear chat"}</button>
              </div>
            </>
          ) : (
            <>
              <h3 className="text-base font-semibold">Delete {sel?.size} message{sel?.size === 1 ? "" : "s"}?</h3>
              <div className="mt-4 flex flex-col gap-2">
                <button disabled={busyOp} onClick={doDeleteForMe} className="rounded-lg border px-4 py-2.5 text-sm font-medium disabled:opacity-60">Delete for me</button>
                {allMine && <button disabled={busyOp} onClick={doDeleteForAll} className="rounded-lg border border-destructive px-4 py-2.5 text-sm font-medium text-destructive disabled:opacity-60">Delete for everyone</button>}
                <button disabled={busyOp} onClick={() => setConfirm(null)} className="rounded-lg px-4 py-2 text-sm text-muted-foreground">Cancel</button>
              </div>
            </>
          )}
        </Modal>
      )}

      {fwdOpen && (
        <Modal onClose={() => !busyOp && setFwdOpen(false)}>
          <h3 className="text-base font-semibold">Forward {forwardable.length} message{forwardable.length === 1 ? "" : "s"} to…</h3>
          <ul className="mt-3 max-h-72 overflow-y-auto">
            {contacts.map((c) => (
              <li key={c.id}>
                <button disabled={busyOp} onClick={() => forwardTo(c)} className="flex w-full items-center gap-3 rounded-lg px-2 py-2.5 text-left active:bg-muted disabled:opacity-60">
                  <Avatar p={c} size={36} />
                  <span className="font-medium">{c.display_name}</span>
                </button>
              </li>
            ))}
          </ul>
          {busyOp && <p className="mt-2 text-center text-xs text-muted-foreground">Sending…</p>}
          <div className="mt-3 flex justify-end"><button disabled={busyOp} onClick={() => setFwdOpen(false)} className="rounded-lg px-4 py-2 text-sm">Cancel</button></div>
        </Modal>
      )}

      {viewer && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-call-bg/95 p-4" onClick={() => setViewer(null)}>
          <button className="absolute right-4 flex h-11 w-11 items-center justify-center rounded-full text-call-fg" style={{ top: "max(1rem, env(safe-area-inset-top))" }} aria-label="Close"><X className="h-6 w-6" /></button>
          <img src={viewer} alt="Full size" className="max-h-full max-w-full rounded-lg object-contain" />
        </div>
      )}
      {giphyOpen && <GiphyPicker onClose={() => setGiphyOpen(false)} onSelect={(item, kind) => sendGiphy(kind, item)} />}
    </div>
  );
}

function parseAttachment(content: string | null): { url?: string; title?: string; mapsUrl?: string } | null {
  if (!content) return null;
  try { return JSON.parse(content) as { url?: string; title?: string; mapsUrl?: string }; } catch { return null; }
}

function Tick({ on }: { on: boolean }) {
  return (
    <span className={cn("ml-1 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2", on ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground/50")}>
      {on && <Check className="h-3 w-3" />}
    </span>
  );
}

function Modal({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-4 sm:items-center" onClick={onClose}>
      <div className="w-full max-w-sm rounded-2xl bg-card p-5 shadow-xl" style={{ marginBottom: "env(safe-area-inset-bottom)" }} onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>
  );
}
