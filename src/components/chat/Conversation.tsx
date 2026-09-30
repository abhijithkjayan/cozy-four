import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowLeft, Check, CheckCheck, ChevronDown, Image as ImageIcon, Phone, PhoneMissed, Reply, Send, Trash2, Video, X } from "lucide-react";
import { supabase, type Message, type Profile, bus, emitMsg, pairFilter } from "@/lib/supabase";
import { dayLabel, fmtTime, lastSeen } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Avatar } from "./Avatar";
import { AudioPlayer, ImageThumb } from "./Media";
import { VoiceRecorder } from "./VoiceRecorder";
import { useCalls } from "./Calls";
import { preview } from "./ChatApp";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

const PAGE = 30;

export function Conversation({ me, peer, online, onBack, onSeen }: { me: Profile; peer: Profile; online: boolean; onBack: () => void; onSeen: (id: string) => void }) {
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
  const typingTimer = useRef<number>();
  const fileRef = useRef<HTMLInputElement>(null);
  const { startCall, busy } = useCalls();

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
    if (el && el.scrollTop < 60 && hasMore && !loading && msgs.length) load(msgs[0].created_at);
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

  const sendImage = async (f: File) => {
    setUploading(true);
    const path = await upload(f, f.name.split(".").pop() || "jpg");
    setUploading(false);
    if (path) insert({ type: "image", media_url: path });
  };

  const sendVoice = async (blob: Blob, secs: number, mime: string) => {
    setUploading(true);
    const path = await upload(blob, mime.includes("mp4") ? "m4a" : mime.includes("ogg") ? "ogg" : "webm");
    setUploading(false);
    if (path) insert({ type: "audio", media_url: path, content: String(Math.round(secs)) });
  };

  const deleteForMe = (m: Message) => supabase.from("messages").update({ deleted_for: [...(m.deleted_for ?? []), me.id] }).eq("id", m.id).then();
  const deleteForAll = (m: Message) => supabase.from("messages").update({ deleted_for_everyone: true, content: null, media_url: null }).eq("id", m.id).then();

  const byId = new Map(msgs.map((m) => [m.id, m]));
  const shown = msgs.filter(visible);
  const status = typing ? "typing…" : online ? "online" : lastSeen(peer.last_seen);

  return (
    <div className="flex h-full w-full flex-col bg-chat-bg">
      <header className="flex h-16 shrink-0 items-center gap-3 border-b bg-card px-2 md:px-4">
        <button onClick={onBack} className="rounded-full p-2 hover:bg-muted md:hidden" aria-label="Back"><ArrowLeft className="h-5 w-5" /></button>
        <Avatar p={peer} size={40} />
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium">{peer.display_name}</div>
          <div className={cn("truncate text-xs", typing ? "text-primary" : "text-muted-foreground")}>{status}</div>
        </div>
        <button disabled={busy} onClick={() => startCall(peer, true)} className="rounded-full p-2.5 text-muted-foreground hover:bg-muted disabled:opacity-40" aria-label="Video call"><Video className="h-5 w-5" /></button>
        <button disabled={busy} onClick={() => startCall(peer, false)} className="rounded-full p-2.5 text-muted-foreground hover:bg-muted disabled:opacity-40" aria-label="Voice call"><Phone className="h-5 w-5" /></button>
      </header>

      <div ref={scroller} onScroll={onScroll} className="flex-1 overflow-y-auto px-3 py-4 md:px-[8%]">
        {loading && hasMore && <div className="py-2 text-center text-xs text-muted-foreground">Loading…</div>}
        {shown.map((m, i) => {
          const newDay = i === 0 || dayLabel(shown[i - 1].created_at) !== dayLabel(m.created_at);
          const mine = m.sender_id === me.id;
          const rep = m.reply_to ? byId.get(m.reply_to) : undefined;
          return (
            <Fragment key={m.id}>
              {newDay && (
                <div className="my-3 flex justify-center">
                  <span className="rounded-lg bg-card px-3 py-1 text-xs text-muted-foreground shadow-sm">{dayLabel(m.created_at)}</span>
                </div>
              )}
              {m.type === "call" ? (
                <div className="my-2 flex justify-center">
                  <span className={cn("flex items-center gap-2 rounded-lg bg-card px-3 py-1.5 text-xs shadow-sm", m.content?.startsWith("Missed") && "text-destructive")}>
                    {m.content?.startsWith("Missed") ? <PhoneMissed className="h-3.5 w-3.5" /> : m.content?.startsWith("Video") ? <Video className="h-3.5 w-3.5" /> : <Phone className="h-3.5 w-3.5" />}
                    {m.content} · {fmtTime(m.created_at)}
                  </span>
                </div>
              ) : (
                <div className={cn("group my-0.5 flex", mine ? "justify-end" : "justify-start")}>
                  <div className={cn("relative max-w-[80%] rounded-xl px-2 pb-1 pt-1.5 shadow-sm md:max-w-[65%]", mine ? "rounded-tr-sm bg-bubble-out" : "rounded-tl-sm bg-bubble-in")}>
                    {!m.deleted_for_everyone && (
                      <DropdownMenu>
                        <DropdownMenuTrigger className="absolute right-1 top-1 z-10 rounded-full bg-inherit p-0.5 text-muted-foreground opacity-0 transition group-hover:opacity-100 focus:opacity-100 data-[state=open]:opacity-100 max-md:opacity-60" aria-label="Message options">
                          <ChevronDown className="h-4 w-4" />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align={mine ? "end" : "start"}>
                          <DropdownMenuItem onClick={() => setReply(m)}><Reply className="mr-2 h-4 w-4" />Reply</DropdownMenuItem>
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

      <div className="flex items-end gap-2 bg-chat-bg px-2 py-2 md:px-4" style={{ paddingBottom: "max(0.5rem, env(safe-area-inset-bottom))" }}>
        <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) sendImage(f); e.target.value = ""; }} />
        {text ? null : (
          <button onClick={() => fileRef.current?.click()} disabled={uploading} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-muted disabled:opacity-50" aria-label="Send photo">
            <ImageIcon className="h-5 w-5" />
          </button>
        )}
        <textarea
          value={text}
          onChange={(e) => onType(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendText(); } }}
          rows={1}
          placeholder={uploading ? "Sending…" : "Message"}
          className="max-h-32 min-h-11 flex-1 resize-none rounded-3xl border-0 bg-card px-4 py-2.5 text-[15px] shadow-sm outline-none"
        />
        {text.trim() ? (
          <button onClick={sendText} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground" aria-label="Send">
            <Send className="h-5 w-5" />
          </button>
        ) : (
          <VoiceRecorder onSend={sendVoice} />
        )}
      </div>

      {viewer && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-call-bg/95 p-4" onClick={() => setViewer(null)}>
          <button className="absolute right-4 top-4 rounded-full p-2 text-call-fg" aria-label="Close"><X className="h-6 w-6" /></button>
          <img src={viewer} alt="Full size" className="max-h-full max-w-full rounded-lg object-contain" />
        </div>
      )}
    </div>
  );
}
