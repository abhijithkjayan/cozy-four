import { lazy, memo, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { ArrowLeft, Check, CheckCheck, ChevronDown, Clock3, Download, Forward, Image as ImageIcon, Images, ListChecks, Link2, MapPin, MoreVertical, Pencil, Phone, PhoneMissed, Reply, Search, Send, Share, Smile, Sticker, Trash2, Video, X } from "lucide-react";
import { supabase, type Message, type Profile, bus, emitMsg, pairFilter, signedUrl } from "@/lib/supabase";
import { dayLabel, fmtTime, lastSeen } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Avatar } from "./Avatar";
import { AudioPlayer, ImageThumb } from "./Media";
import { VoiceRecorder } from "./VoiceRecorder";
import { GiphyPicker } from "./GiphyPicker";
import { useCalls } from "./Calls";
import { preview } from "./ChatApp";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
// Heavy emoji library: loaded only when someone opens "More emojis…".
import type { EmojiStyle } from "emoji-picker-react";
const EmojiPicker = lazy(() => import("emoji-picker-react"));

const PAGE = 30;
const MAX_IMAGE_ZOOM = 5;
const QUICK_REACTIONS = ["❤️", "😂", "👍", "😮", "😢", "🙏"];
const URL_PATTERN = /https?:\/\/[^\s<>"']+|www\.[^\s<>"']+|(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s<>"']*)?/gi;

type ImageTransform = { scale: number; x: number; y: number };
type ImagePointer = { x: number; y: number };
type MessageReaction = { message_id: string; user_id: string; emoji: string; created_at: string };
type ImageGesture = {
  kind: "pan" | "pinch";
  start: ImageTransform;
  startDistance?: number;
  startMidpoint?: ImagePointer;
};

function extractMessageLinks(content: string) {
  const links: { start: number; end: number; url: string; href: string }[] = [];
  for (const match of content.matchAll(URL_PATTERN)) {
    const originalUrl = match[0];
    if (!originalUrl) continue;
    let url = originalUrl;
    while (/[),.!?;:]$/.test(url)) url = url.slice(0, -1);
    if (!url) continue;

    const start = match.index ?? 0;
    const hasProtocol = /^https?:\/\//i.test(url);
    const hasWww = /^www\./i.test(url);
    const previousCharacter = start > 0 ? content[start - 1] : undefined;
    if (!hasProtocol && !hasWww && previousCharacter && /[\w@.-]/.test(previousCharacter)) continue;

    const href = hasProtocol ? url : `https://${url}`;
    try {
      const parsed = new URL(href);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") continue;
    } catch {
      continue;
    }
    links.push({ start, end: start + url.length, url, href });
  }
  return links;
}

function renderLinkedText(content: string): ReactNode[] {
  const links = extractMessageLinks(content);
  const nodes: ReactNode[] = [];
  let cursor = 0;
  links.forEach(({ start, end, url, href }, index) => {
    if (start > cursor) nodes.push(content.slice(cursor, start));
    nodes.push(
      <a
        key={`link-${index}`}
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(event) => event.stopPropagation()}
        className="break-all text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary"
      >
        {url}
      </a>,
    );
    cursor = end;
  });
  if (cursor < content.length) nodes.push(content.slice(cursor));
  return nodes;
}

// Memoized: the parent re-renders every second for the idle-logout countdown.
export const Conversation = memo(function Conversation({ me, peer, online, away, onBack, onSeen, onViewProfile }: { me: Profile; peer: Profile; online: boolean; away: boolean; onBack: () => void; onSeen: (id: string) => void; onViewProfile: (profile: Profile) => void }) {
  const [msgs, setMsgs] = useState<Message[]>([]);
  const [reactions, setReactions] = useState<MessageReaction[]>([]);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(false);
  const [text, setText] = useState("");
  const [reply, setReply] = useState<Message | null>(null);
  const [editing, setEditing] = useState<Message | null>(null);
  const [savingEdit, setSavingEdit] = useState(false);
  const [typing, setTyping] = useState(false);
  const [viewer, setViewer] = useState<string | null>(null);
  const [imageTransform, setImageTransform] = useState<ImageTransform>({ scale: 1, x: 0, y: 0 });
  const imageViewport = useRef<HTMLDivElement>(null);
  const imageElement = useRef<HTMLImageElement>(null);
  const imagePointers = useRef(new Map<number, ImagePointer>());
  const imageGesture = useRef<ImageGesture | null>(null);
  const [pendingImages, setPendingImages] = useState<{ file: File; previewUrl: string }[]>([]);
  const pendingImageUrls = useRef(new Set<string>());
  const [playedAudio, setPlayedAudio] = useState<Set<string>>(() => {
    try {
      const saved = localStorage.getItem(`played-audio:${me.id}`);
      return new Set(saved ? JSON.parse(saved) as string[] : []);
    } catch {
      return new Set();
    }
  });
  const playedAudioRef = useRef(playedAudio);
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
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<Message[]>([]);
  const [searching, setSearching] = useState(false);
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [galleryLoading, setGalleryLoading] = useState(false);
  const [galleryTab, setGalleryTab] = useState<"media" | "audio" | "links">("media");
  const [galleryMessages, setGalleryMessages] = useState<Message[]>([]);
  const [reactionPickerMessage, setReactionPickerMessage] = useState<string | null>(null);
  const messageElements = useRef(new Map<string, HTMLDivElement>());
  const pendingScrollId = useRef<string | null>(null);
  const pressTimer = useRef<number | undefined>(undefined);
  const longPressTriggered = useRef(false);
  const messageIds = useRef(new Set<string>());
  const [openMessageMenu, setOpenMessageMenu] = useState<string | null>(null);

  const visible = (m: Message) => !m.deleted_for?.includes(me.id);

  useEffect(() => {
    setImageTransform({ scale: 1, x: 0, y: 0 });
    imagePointers.current.clear();
    imageGesture.current = null;
  }, [viewer]);

  const clampImageTransform = (transform: ImageTransform): ImageTransform => {
    const viewport = imageViewport.current;
    const image = imageElement.current;
    if (!viewport || !image) return transform;
    const scale = Math.min(MAX_IMAGE_ZOOM, Math.max(1, transform.scale));
    const maxX = Math.max(0, (image.clientWidth * scale - viewport.clientWidth) / 2);
    const maxY = Math.max(0, (image.clientHeight * scale - viewport.clientHeight) / 2);
    return {
      scale,
      x: Math.min(maxX, Math.max(-maxX, transform.x)),
      y: Math.min(maxY, Math.max(-maxY, transform.y)),
    };
  };

  const imagePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    imagePointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const points = [...imagePointers.current.values()];
    if (points.length >= 2) {
      const [first, second] = points;
      if (!first || !second) return;
      imageGesture.current = {
        kind: "pinch",
        start: imageTransform,
        startDistance: Math.hypot(second.x - first.x, second.y - first.y),
        startMidpoint: { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 },
      };
    } else {
      imageGesture.current = {
        kind: "pan",
        start: imageTransform,
        startMidpoint: { x: event.clientX, y: event.clientY },
      };
    }
  };

  const imagePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!imagePointers.current.has(event.pointerId)) return;
    event.preventDefault();
    imagePointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const gesture = imageGesture.current;
    if (!gesture) return;
    const points = [...imagePointers.current.values()];

    if (gesture.kind === "pinch" && points.length >= 2 && gesture.startDistance && gesture.startMidpoint) {
      const [first, second] = points;
      if (!first || !second) return;
      const distance = Math.hypot(second.x - first.x, second.y - first.y);
      const midpoint = { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 };
      const scale = Math.min(MAX_IMAGE_ZOOM, Math.max(1, gesture.start.scale * distance / gesture.startDistance));
      const rect = imageViewport.current?.getBoundingClientRect();
      if (!rect) return;
      const startCenterX = gesture.startMidpoint.x - (rect.left + rect.width / 2) - gesture.start.x;
      const startCenterY = gesture.startMidpoint.y - (rect.top + rect.height / 2) - gesture.start.y;
      const ratio = scale / gesture.start.scale;
      setImageTransform(clampImageTransform({
        scale,
        x: midpoint.x - (rect.left + rect.width / 2) - startCenterX * ratio,
        y: midpoint.y - (rect.top + rect.height / 2) - startCenterY * ratio,
      }));
    } else if (points.length === 1 && gesture.start.scale > 1 && gesture.startMidpoint) {
      const point = points[0];
      if (!point) return;
      setImageTransform(clampImageTransform({
        ...gesture.start,
        x: gesture.start.x + point.x - gesture.startMidpoint.x,
        y: gesture.start.y + point.y - gesture.startMidpoint.y,
      }));
    }
  };

  const imagePointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    imagePointers.current.delete(event.pointerId);
    const remaining = [...imagePointers.current.values()];
    if (remaining.length >= 2) {
      const first = remaining[0];
      const second = remaining[1];
      if (first && second) {
        imageGesture.current = {
          kind: "pinch",
          start: imageTransform,
          startDistance: Math.hypot(second.x - first.x, second.y - first.y),
          startMidpoint: { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 },
        };
      }
    } else if (remaining.length === 1) {
      const point = remaining[0];
      if (point) imageGesture.current = { kind: "pan", start: imageTransform, startMidpoint: point };
    } else {
      imageGesture.current = null;
    }
  };

  useEffect(() => () => pendingImageUrls.current.forEach((url) => URL.revokeObjectURL(url)), []);

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
    if (rows.length) {
      const ids = rows.map((message) => message.id);
      const { data: reactionRows, error: reactionError } = await supabase
        .from("message_reactions")
        .select("*")
        .in("message_id", ids);
      if (reactionError) {
        console.error("Could not load message reactions:", reactionError);
      } else {
        setReactions((current) => [
          ...current.filter((reaction) => !ids.includes(reaction.message_id)),
          ...(reactionRows ?? []),
        ]);
      }
    }
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

  useEffect(() => {
    messageIds.current = new Set(msgs.map((message) => message.id));
  }, [msgs]);

  useEffect(() => {
    const channel = supabase
      .channel(`message-reactions:${[me.id, peer.id].sort().join(":")}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "message_reactions" }, (payload) => {
        const row = (payload.eventType === "DELETE" ? payload.old : payload.new) as MessageReaction;
        if (!row.message_id || !messageIds.current.has(row.message_id)) return;
        setReactions((current) => {
          const remaining = current.filter(
            (reaction) => !(reaction.message_id === row.message_id && reaction.user_id === row.user_id),
          );
          return payload.eventType === "DELETE" ? remaining : [...remaining, row];
        });
      })
      .subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, [me.id, peer.id]);

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
    if (pendingScrollId.current) {
      messageElements.current.get(pendingScrollId.current)?.scrollIntoView({ block: "center" });
      pendingScrollId.current = null;
      prevHeight.current = null;
      keepBottom.current = false;
      return;
    }
    if (prevHeight.current !== null) {
      el.scrollTop = el.scrollHeight - prevHeight.current;
      prevHeight.current = null;
    } else if (keepBottom.current) el.scrollTop = el.scrollHeight;
  }, [msgs]);

  const onScroll = () => {
    const el = scroller.current;
    if (el && el.scrollTop < 60 && hasMore && !loading && msgs.length) load(msgs[0]!.created_at);
  };

  const searchMessages = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const term = searchQuery.trim();
    if (!term) {
      setSearchResults([]);
      return;
    }
    setSearching(true);
    const pattern = `%${term.replace(/[\\%_]/g, "\\$&")}%`;
    const { data, error } = await supabase
      .from("messages")
      .select("*")
      .or(pairFilter(me.id, peer.id))
      .ilike("content", pattern)
      .not("deleted_for", "cs", `{${me.id}}`)
      .eq("deleted_for_everyone", false)
      .neq("type", "call")
      .order("created_at", { ascending: false })
      .limit(50);
    setSearching(false);
    if (error) {
      alert("Could not search this chat. Please try again.");
      return;
    }
    setSearchResults((data ?? []) as Message[]);
  };

  const openSearchResult = (message: Message) => {
    if (msgs.some((item) => item.id === message.id)) {
      messageElements.current.get(message.id)?.scrollIntoView({ block: "center" });
      setSearchOpen(false);
      return;
    }
    keepBottom.current = false;
    pendingScrollId.current = message.id;
    setMsgs((current) => {
      const next = current.some((item) => item.id === message.id) ? current : [...current, message];
      return next.sort((a, b) => a.created_at.localeCompare(b.created_at));
    });
    setSearchOpen(false);
  };

  const openGallery = async () => {
    setGalleryOpen(true);
    setGalleryLoading(true);
    const [media, links] = await Promise.all([
      supabase
        .from("messages")
        .select("*")
        .or(pairFilter(me.id, peer.id))
        .in("type", ["image", "audio", "gif", "sticker"])
        .not("deleted_for", "cs", `{${me.id}}`)
        .eq("deleted_for_everyone", false)
        .order("created_at", { ascending: false })
        .limit(500),
      supabase
        .from("messages")
        .select("*")
        .or(pairFilter(me.id, peer.id))
        .eq("type", "text")
        .not("deleted_for", "cs", `{${me.id}}`)
        .eq("deleted_for_everyone", false)
        .order("created_at", { ascending: false })
        .limit(500),
    ]);
    setGalleryLoading(false);
    if (media.error || links.error) {
      alert("Could not load this chat's media gallery. Please try again.");
      setGalleryOpen(false);
      return;
    }
    setGalleryMessages([...(media.data ?? []), ...(links.data ?? [])] as Message[]);
  };

  const galleryMedia = galleryMessages.filter((message) => ["image", "gif", "sticker"].includes(message.type));
  const galleryAudio = galleryMessages.filter((message) => message.type === "audio");
  const galleryLinks = galleryMessages.flatMap((message) => {
    if (message.type !== "text" || !message.content) return [];
    return extractMessageLinks(message.content).map(({ url }) => ({ message, url }));
  });
  const jumpToGalleryMessage = (message: Message) => {
    setGalleryOpen(false);
    window.setTimeout(() => {
      if (msgs.some((item) => item.id === message.id)) {
        messageElements.current.get(message.id)?.scrollIntoView({ block: "center", behavior: "smooth" });
      } else {
        openSearchResult(message);
      }
    }, 0);
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
    if (error) {
      const errorText = `${error.message} ${error.details ?? ""}`.toLowerCase();
      if (row.view_once && errorText.includes("view_once") && /column|schema cache|field/.test(errorText)) {
        alert("View-once photos are not enabled in the database yet. Apply drizzle/migrations/0007_view_once_media.sql in Lovable Cloud, then try again.");
      } else {
        console.error("Message failed to send:", error);
        alert(`Message failed to send: ${error.message}`);
      }
      return false;
    }
    setReply(null);
    emitMsg(data as Message);
    return true;
  };

  const sendText = () => {
    const t = text.trim();
    if (!t) return;
    if (editing) {
      void saveEdit(t);
      return;
    }
    setText("");
    insert({ type: "text", content: t });
  };

  const saveEdit = async (content: string) => {
    if (!editing || content === editing.content) {
      setEditing(null);
      setText("");
      return;
    }
    setSavingEdit(true);
    const { data, error } = await supabase
      .from("messages")
      .update({ content })
      .eq("id", editing.id)
      .eq("sender_id", me.id)
      .select()
      .single();
    setSavingEdit(false);
    if (error) return alert("Could not edit this message. Please try again.");
    setMsgs((list) => list.map((message) => (message.id === editing.id ? (data as Message) : message)));
    emitMsg(data as Message);
    setEditing(null);
    setText("");
  };

  const upload = async (blob: Blob, ext: string) => {
    const path = `${me.id}/${peer.id}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
    const { error } = await supabase.storage.from("chat-media").upload(path, blob, { contentType: blob.type });
    if (error) { alert("Upload failed."); return null; }
    return path;
  };

  const cancelPendingImages = () => {
    pendingImageUrls.current.forEach((url) => URL.revokeObjectURL(url));
    pendingImageUrls.current.clear();
    setPendingImages([]);
  };

  const chooseImages = (files: File[]) => {
    cancelPendingImages();
    const selected = files.slice(0, 20).map((file) => {
      const previewUrl = URL.createObjectURL(file);
      pendingImageUrls.current.add(previewUrl);
      return { file, previewUrl };
    });
    setPendingImages(selected);
  };

  const sendImages = async (viewOnce: boolean) => {
    const selected = [...pendingImages];
    if (!selected.length) return;
    setUploading(true);
    const failed: File[] = [];
    for (const { file } of selected) {
      const path = await upload(file, file.name.split(".").pop() || "jpg");
      if (!path || !(await insert({ type: "image", media_url: path, ...(viewOnce ? { view_once: true } : {}) }))) failed.push(file);
    }
    setUploading(false);
    pendingImageUrls.current.forEach((url) => URL.revokeObjectURL(url));
    pendingImageUrls.current.clear();
    const remaining = failed.map((file) => {
      const previewUrl = URL.createObjectURL(file);
      pendingImageUrls.current.add(previewUrl);
      return { file, previewUrl };
    });
    setPendingImages(remaining);
  };

  const sendVoice = async (blob: Blob, secs: number, mime: string) => {
    setUploading(true);
    const path = await upload(blob, mime.includes("mp4") ? "m4a" : mime.includes("ogg") ? "ogg" : "webm");
    setUploading(false);
    if (path) insert({ type: "audio", media_url: path, content: String(Math.round(secs)) });
  };

  const sendGiphy = (kind: "gif" | "sticker", item: { url: string; preview: string; title: string }) => {
    setGiphyOpen(false);
    insert({ type: kind, content: JSON.stringify(item) });
  };

  const getAttachmentFile = async (message: Message, url?: string, title?: string) => {
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
      throw new Error("Attachment not found");
    }
    return new File([blob], filename, { type: blob.type || "application/octet-stream" });
  };

  const saveFile = (file: File) => {
    const objectUrl = URL.createObjectURL(file);
    const link = document.createElement("a");
    link.href = objectUrl;
    link.download = file.name;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
  };

  const downloadAttachment = async (message: Message, url?: string, title?: string) => {
    try {
      saveFile(await getAttachmentFile(message, url, title));
    } catch {
      alert("Could not download this attachment. Please try again.");
    }
  };

  const shareAttachment = async (message: Message, url?: string, title?: string) => {
    try {
      const file = await getAttachmentFile(message, url, title);
      if (typeof navigator.share !== "function") {
        saveFile(file);
        return;
      }
      const shareData = { files: [file], title: title || file.name };
      if (typeof navigator.canShare === "function" && !navigator.canShare(shareData)) {
        saveFile(file);
        return;
      }
      await navigator.share(shareData);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      if (error instanceof TypeError) {
        try {
          saveFile(await getAttachmentFile(message, url, title));
          return;
        } catch {
          alert("Could not share or save this attachment. Please try again.");
          return;
        }
      }
      alert("Could not share this attachment. Please try again.");
    }
  };

  const viewImage = async (message: Message) => {
    if (!message.media_url) return;
    const url = await signedUrl(message.media_url);
    if (!url) return alert("Could not open this image. Please try again.");
    setViewer(url);
  };

  const openViewOnceImage = async (message: Message) => {
    if (!message.view_once || message.view_once_opened_at || message.sender_id === me.id) return;
    const { data, error } = await supabase.rpc("open_view_once_message", { p_message_id: message.id });
    if (error) {
      alert("Could not open this photo. Please try again.");
      return;
    }
    if (!data) {
      setMsgs((list) => list.map((item) => item.id === message.id ? { ...item, view_once_opened_at: new Date().toISOString() } : item));
      alert("This view-once photo has already been opened.");
      return;
    }
    setMsgs((list) => list.map((item) => item.id === message.id ? { ...item, view_once_opened_at: new Date().toISOString() } : item));
    const { data: signed, error: signError } = await supabase.storage.from("chat-media").createSignedUrl(data, 60);
    if (signError || !signed?.signedUrl) {
      alert("This photo was opened but could not be displayed.");
      return;
    }
    setViewer(signed.signedUrl);
  };
  const markAudioPlayed = (id: string) => {
    if (playedAudioRef.current.has(id)) return;
    const next = new Set(playedAudioRef.current).add(id);
    playedAudioRef.current = next;
    setPlayedAudio(next);
    try {
      localStorage.setItem(`played-audio:${me.id}`, JSON.stringify([...next]));
    } catch {
      alert("Voice note played, but its played status could not be saved on this device.");
    }
  };

  const deleteForMe = (m: Message) => supabase.from("messages").update({ deleted_for: [...(m.deleted_for ?? []), me.id] }).eq("id", m.id).then();
  const deleteForAll = async (m: Message) => {
    const { error } = await supabase.from("messages").update({ deleted_for_everyone: true, content: null, media_url: null }).eq("id", m.id);
    // Also remove the uploaded file, so a deleted photo/voice note does not stay in storage.
    if (!error && m.media_url?.startsWith(`${me.id}/`)) void supabase.storage.from("chat-media").remove([m.media_url]);
  };

  // ---- selection / clear / forward ----
  const toggleSel = (id: string) =>
    setSel((s) => {
      if (!s) return s;
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const startSel = (id: string) => setSel(new Set([id]));
  const cancelPress = () => {
    clearTimeout(pressTimer.current);
    if (longPressTriggered.current) {
      window.setTimeout(() => { longPressTriggered.current = false; }, 0);
    }
  };
  const consumeLongPressClick = (event: React.MouseEvent) => {
    if (!longPressTriggered.current) return;
    event.preventDefault();
    event.stopPropagation();
    longPressTriggered.current = false;
  };
  const showReactionError = (action: "save" | "remove", error: { code: string; message: string }) => {
    console.error(`Could not ${action} message reaction:`, error);
    const missingTable =
      error.code === "42P01" ||
      error.code === "PGRST205" ||
      (/message_reactions/i.test(error.message) && /(schema cache|does not exist|could not find)/i.test(error.message));
    if (missingTable) {
      alert("Message reactions are not enabled in the database yet. Apply drizzle/migrations/0008_message_reactions.sql in Lovable Cloud, then try again.");
      return;
    }
    alert(`Could not ${action} your reaction: ${error.message}`);
  };
  const toggleReaction = async (message: Message, emoji: string) => {
    const existing = reactions.find((reaction) => reaction.message_id === message.id && reaction.user_id === me.id);
    if (existing?.emoji === emoji) {
      const { error } = await supabase
        .from("message_reactions")
        .delete()
        .eq("message_id", message.id)
        .eq("user_id", me.id);
      if (error) {
        showReactionError("remove", error);
        return;
      }
      setReactions((current) => current.filter((reaction) => !(reaction.message_id === message.id && reaction.user_id === me.id)));
      return;
    }
    const { data, error } = await supabase
      .from("message_reactions")
      .upsert({ message_id: message.id, user_id: me.id, emoji }, { onConflict: "message_id,user_id" })
      .select()
      .single();
    if (error) {
      showReactionError("save", error);
      return;
    }
    setReactions((current) => [
      ...current.filter((reaction) => !(reaction.message_id === message.id && reaction.user_id === me.id)),
      data,
    ]);
  };
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
  const hideForEveryone = async (rows: { id: string; sender_id: string; receiver_id: string; deleted_for: string[] | null }[]) => {
    for (let i = 0; i < rows.length; i += 15) {
      const results = await Promise.all(
        rows.slice(i, i + 15).map((r) =>
          supabase
            .from("messages")
            .update({
              deleted_for: [...new Set([...(r.deleted_for ?? []), r.sender_id, r.receiver_id])],
              deleted_for_everyone: true,
              content: null,
              media_url: null,
            })
            .eq("id", r.id),
        ),
      );
      if (results.some((r) => r.error)) return false;
    }
    return true;
  };
  const doClearForMe = async () => {
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
  const doClearForEveryone = async () => {
    setBusyOp(true);
    const { data, error } = await supabase
      .from("messages")
      .select("id, sender_id, receiver_id, deleted_for")
      .or(pairFilter(me.id, peer.id));
    const ok = !error && (await hideForEveryone((data ?? []) as { id: string; sender_id: string; receiver_id: string; deleted_for: string[] | null }[]));
    setBusyOp(false);
    if (!ok) return alert("Could not clear chat for everyone. Please try again.");
    setMsgs((list) =>
      list.map((m) => ({
        ...m,
        deleted_for: [...new Set([...(m.deleted_for ?? []), me.id, peer.id])],
        deleted_for_everyone: true,
        content: null,
        media_url: null,
      })),
    );
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

  const byId = useMemo(() => new Map(msgs.map((m) => [m.id, m])), [msgs]);
  const rows = useMemo(() => {
    const out: { m: Message; day: string | null }[] = [];
    let prevDay = "";
    for (const m of msgs) {
      if (!visible(m) || (m.type === "call" && m.deleted_for_everyone)) continue;
      const day = dayLabel(m.created_at);
      out.push({ m, day: day !== prevDay ? day : null });
      prevDay = day;
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `visible` only depends on me.id
  }, [msgs, me.id]);
  const reactionsByMessage = useMemo(() => {
    const map = new Map<string, MessageReaction[]>();
    for (const reaction of reactions) {
      const list = map.get(reaction.message_id);
      if (list) list.push(reaction);
      else map.set(reaction.message_id, [reaction]);
    }
    return map;
  }, [reactions]);
  const actions = useStableActions<RowActions>({
    register: (id, element) => {
      if (element) messageElements.current.set(id, element);
      else messageElements.current.delete(id);
    },
    toggleSel,
    startSel,
    reply: (m) => { setEditing(null); setText(""); setReply(m); },
    edit: (m) => { setReply(null); setEditing(m); setText(m.content ?? ""); },
    react: (m, emoji) => void toggleReaction(m, emoji),
    setMenu: (id) => setOpenMessageMenu(id),
    setPicker: (id) => setReactionPickerMessage(id),
    openViewOnce: (m) => void openViewOnceImage(m),
    viewImage: (m) => void viewImage(m),
    share: (m, url, title) => void shareAttachment(m, url, title),
    download: (m, url, title) => void downloadAttachment(m, url, title),
    deleteForMe: (m) => void deleteForMe(m),
    deleteForAll: (m) => void deleteForAll(m),
    openViewer: (url) => setViewer(url),
    audioPlayed: markAudioPlayed,
    pressStart: (id) => {
      pressTimer.current = window.setTimeout(() => {
        longPressTriggered.current = true;
        setOpenMessageMenu(id);
      }, 500);
    },
    cancelPress,
    consumeLongPressClick,
  });
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
          <Avatar p={peer} size={40} online={online} away={away} />
          <span className="min-w-0 flex-1">
            <span className="block truncate font-medium">{peer.display_name}</span>
            {peer.status_text && <span className="block truncate text-xs text-muted-foreground">{peer.status_text}</span>}
            <span className={cn("block line-clamp-1 text-xs leading-4", typing ? "text-primary" : "text-muted-foreground")}>{status}</span>
          </span>
        </button>
        <button disabled={busy} onClick={() => startCall(peer, true)} className="flex h-11 w-11 items-center justify-center rounded-full text-muted-foreground active:bg-muted disabled:opacity-40 md:hover:bg-muted" aria-label="Video call"><Video className="h-5 w-5" /></button>
        <button disabled={busy} onClick={() => startCall(peer, false)} className="flex h-11 w-11 items-center justify-center rounded-full text-muted-foreground active:bg-muted disabled:opacity-40 md:hover:bg-muted" aria-label="Voice call"><Phone className="h-5 w-5" /></button>
        <button onClick={() => void openGallery()} className="flex h-11 w-11 items-center justify-center rounded-full text-muted-foreground active:bg-muted md:hover:bg-muted" aria-label="Shared media gallery" title="Shared media, audio and links"><Images className="h-5 w-5" /></button>
        <DropdownMenu>
          <DropdownMenuTrigger className="flex h-11 w-11 items-center justify-center rounded-full text-muted-foreground active:bg-muted md:hover:bg-muted" aria-label="Chat menu"><MoreVertical className="h-5 w-5" /></DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => { setSearchQuery(""); setSearchResults([]); setSearchOpen(true); }}><Search className="mr-2 h-4 w-4" />Search messages</DropdownMenuItem>
            <DropdownMenuItem onClick={() => setSel(new Set())}><ListChecks className="mr-2 h-4 w-4" />Select messages</DropdownMenuItem>
            <DropdownMenuItem onClick={() => setConfirm("clear")} className="text-destructive"><Trash2 className="mr-2 h-4 w-4" />Clear chat</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </header>
      )}

      <div ref={scroller} onScroll={onScroll} className="flex-1 overflow-y-auto overscroll-contain px-3 py-4 md:px-[8%]">
        {loading && hasMore && <div className="py-2 text-center text-xs text-muted-foreground">Loading…</div>}
        {rows.map(({ m, day }) => (
          <MessageRow
            key={m.id}
            m={m}
            day={day}
            mine={m.sender_id === me.id}
            rep={m.reply_to ? byId.get(m.reply_to) : undefined}
            selecting={!!sel}
            selected={!!sel?.has(m.id)}
            reactions={reactionsByMessage.get(m.id)}
            played={playedAudio.has(m.id)}
            menuOpen={openMessageMenu === m.id}
            pickerOpen={reactionPickerMessage === m.id}
            meId={me.id}
            peerName={peer.display_name}
            actions={actions}
          />
        ))}
        {typing && (
          <div className="my-1 flex">
            <div className="flex gap-1 rounded-xl rounded-tl-sm bg-bubble-in px-3 py-3 shadow-sm">
              {[0, 1, 2].map((i) => <span key={i} className="h-2 w-2 animate-bounce rounded-full bg-muted-foreground/60" style={{ animationDelay: `${i * 0.15}s` }} />)}
            </div>
          </div>
        )}
      </div>

      {(reply || editing) && (
        <div className="flex items-center gap-2 border-t bg-card px-3 py-2">
          <div className="min-w-0 flex-1 rounded-md border-l-4 border-primary bg-muted px-2 py-1 text-xs">
            <div className="font-medium text-primary">{editing ? "Editing message" : reply!.sender_id === me.id ? "You" : peer.display_name}</div>
            <div className="truncate text-muted-foreground">{editing ? editing.content : preview(reply!, "")}</div>
          </div>
          <button onClick={() => { setReply(null); setEditing(null); setText(""); }} className="p-1 text-muted-foreground" aria-label="Cancel reply or edit"><X className="h-4 w-4" /></button>
        </div>
      )}

      <div className={cn("flex items-end gap-2 bg-chat-bg px-2 py-2 md:px-4", sel && "hidden")} style={{ paddingBottom: "max(0.5rem, env(safe-area-inset-bottom))" }}>
        <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={(e) => { const files = Array.from(e.target.files || []).slice(0, 20); if (files.length) chooseImages(files); e.target.value = ""; }} />
        {text ? null : (
          <>
            <button onClick={() => fileRef.current?.click()} disabled={uploading} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-muted-foreground active:bg-muted disabled:opacity-50" aria-label="Send photo">
              <ImageIcon className="h-5 w-5" />
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
          <button disabled={savingEdit} onClick={sendText} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground disabled:opacity-50" aria-label={editing ? "Save edit" : "Send"}>
            {editing ? <Check className="h-5 w-5" /> : <Send className="h-5 w-5" />}
          </button>
        ) : (
          <VoiceRecorder onSend={sendVoice} />
        )}
      </div>

      {pendingImages.length > 0 && (
        <Modal onClose={() => !uploading && cancelPendingImages()}>
          <h3 className="text-base font-semibold">Send {pendingImages.length === 1 ? "photo" : `${pendingImages.length} photos`}?</h3>
          <p className="mt-1 text-sm text-muted-foreground">Choose how {pendingImages.length === 1 ? "this photo is" : "these photos are"} sent to {peer.display_name}.</p>
          <div className="mt-4 grid max-h-56 grid-cols-3 gap-2 overflow-y-auto">
            {pendingImages.map(({ file, previewUrl }) => (
              <img key={`${file.name}:${file.size}:${previewUrl}`} src={previewUrl} alt={file.name} className="aspect-square w-full rounded-lg object-cover" />
            ))}
          </div>
          <div className="mt-5 flex flex-col gap-2">
            <button type="button" disabled={uploading} onClick={() => void sendImages(false)} className="rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground disabled:opacity-60">{uploading ? "Sending…" : "Send normally"}</button>
            <button type="button" disabled={uploading} onClick={() => void sendImages(true)} className="flex items-center justify-center gap-2 rounded-lg border px-4 py-2.5 text-sm font-medium disabled:opacity-60"><Clock3 className="h-4 w-4" />{uploading ? "Sending…" : "Send as view once"}</button>
            <button type="button" disabled={uploading} onClick={cancelPendingImages} className="rounded-lg px-4 py-2 text-sm text-muted-foreground disabled:opacity-60">Cancel</button>
          </div>
        </Modal>
      )}

      {confirm && (
        <Modal onClose={() => !busyOp && setConfirm(null)}>
          {confirm === "clear" ? (
            <>
              <h3 className="text-base font-semibold">Clear this chat?</h3>
              <p className="mt-1 text-sm text-muted-foreground">Choose whether to clear messages just for you or for both of you.</p>
              <div className="mt-5 flex flex-col gap-2">
                <button disabled={busyOp} onClick={doClearForMe} className="rounded-lg border px-4 py-2.5 text-sm font-medium disabled:opacity-60">{busyOp ? "Clearing…" : "Clear chat for me"}</button>
                <button disabled={busyOp} onClick={doClearForEveryone} className="rounded-lg border border-destructive px-4 py-2.5 text-sm font-medium text-destructive disabled:opacity-60">{busyOp ? "Clearing…" : "Clear chat for everyone"}</button>
                <button disabled={busyOp} onClick={() => setConfirm(null)} className="rounded-lg px-4 py-2 text-sm text-muted-foreground">Cancel</button>
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

      {searchOpen && (
        <Modal onClose={() => !searching && setSearchOpen(false)}>
          <h3 className="text-base font-semibold">Search this chat</h3>
          <form onSubmit={(event) => void searchMessages(event)} className="mt-3 flex gap-2">
            <input
              autoFocus
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="Search messages"
              aria-label="Search messages"
              className="min-w-0 flex-1 rounded-lg border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
            />
            <button type="submit" disabled={searching || !searchQuery.trim()} className="rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50">
              {searching ? "Searching…" : "Search"}
            </button>
          </form>
          <ul className="mt-3 max-h-72 divide-y overflow-y-auto">
            {searchResults.map((message) => (
              <li key={message.id}>
                <button type="button" onClick={() => openSearchResult(message)} className="w-full px-2 py-2.5 text-left hover:bg-muted">
                  <span className="flex items-center justify-between gap-2 text-xs">
                    <span className="font-medium">{message.sender_id === me.id ? "You" : peer.display_name}</span>
                    <span className="shrink-0 text-muted-foreground">{fmtTime(message.created_at)}</span>
                  </span>
                  <span className="mt-1 block whitespace-pre-wrap break-words text-sm text-muted-foreground">{message.content}</span>
                </button>
              </li>
            ))}
            {!searching && searchQuery.trim() && searchResults.length === 0 && <li className="px-2 py-4 text-center text-sm text-muted-foreground">No matching messages found.</li>}
          </ul>
          {searchResults.length === 50 && <p className="mt-2 text-center text-xs text-muted-foreground">Showing the 50 most recent matches.</p>}
          <button type="button" disabled={searching} onClick={() => setSearchOpen(false)} className="mt-3 w-full rounded-lg px-4 py-2 text-sm text-muted-foreground disabled:opacity-50">Close</button>
        </Modal>
      )}

      {galleryOpen && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4" onClick={() => setGalleryOpen(false)}>
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="shared-gallery-title"
            className="flex max-h-[90dvh] w-full max-w-3xl flex-col overflow-hidden rounded-t-2xl bg-card shadow-xl sm:rounded-2xl"
            style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
            onClick={(event) => event.stopPropagation()}
          >
            <header className="flex items-center gap-3 border-b px-4 py-3">
              <div className="min-w-0 flex-1">
                <h3 id="shared-gallery-title" className="truncate font-semibold">{peer.display_name}</h3>
                <p className="text-xs text-muted-foreground">Shared media, audio and links</p>
              </div>
              <button type="button" onClick={() => setGalleryOpen(false)} className="flex h-10 w-10 items-center justify-center rounded-full text-muted-foreground hover:bg-muted" aria-label="Close media gallery"><X className="h-5 w-5" /></button>
            </header>
            <div className="flex border-b px-3" role="tablist" aria-label="Shared items">
              {([
                ["media", "Media", galleryMedia.length],
                ["audio", "Audio", galleryAudio.length],
                ["links", "Links", galleryLinks.length],
              ] as const).map(([tab, label, count]) => (
                <button key={tab} type="button" role="tab" aria-selected={galleryTab === tab} onClick={() => setGalleryTab(tab)} className={cn("flex h-11 flex-1 items-center justify-center gap-1.5 border-b-2 text-sm font-medium", galleryTab === tab ? "border-primary text-primary" : "border-transparent text-muted-foreground")}>
                  {label}<span className="text-xs opacity-70">{count}</span>
                </button>
              ))}
            </div>
            <div className="min-h-48 flex-1 overflow-y-auto p-3 sm:p-4">
              {galleryLoading ? (
                <p className="py-12 text-center text-sm text-muted-foreground">Loading shared items…</p>
              ) : galleryTab === "media" ? (
                galleryMedia.length ? (
                  <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-4 sm:gap-2 md:grid-cols-5">
                    {galleryMedia.map((message) => {
                      const attachment = parseAttachment(message.content);
                      const isViewOnce = message.type === "image" && message.view_once && message.sender_id !== me.id;
                      return (
                        <button
                          key={message.id}
                          type="button"
                          onClick={() => {
                            if (isViewOnce) {
                              if (!message.view_once_opened_at) void openViewOnceImage(message);
                            } else if (message.type === "image" && message.media_url) void viewImage(message);
                            else if (attachment?.url) setViewer(attachment.url);
                          }}
                          className="relative aspect-square overflow-hidden rounded-md bg-muted text-left"
                          aria-label={isViewOnce ? (message.view_once_opened_at ? "View-once photo already opened" : "Open view-once photo") : `View shared ${message.type}`}
                        >
                          {isViewOnce ? (
                            <span className="flex h-full flex-col items-center justify-center gap-1 p-2 text-center text-xs text-muted-foreground">
                              <Clock3 className="h-5 w-5 text-primary" />
                              {message.view_once_opened_at ? "Opened" : "View once"}
                            </span>
                          ) : message.type === "image" && message.media_url ? (
                            <ImageThumb path={message.media_url} onOpen={setViewer} />
                          ) : attachment?.url ? (
                            <img src={attachment.url} alt={attachment.title || message.type} className="h-full w-full object-cover" />
                          ) : null}
                          <span className="absolute inset-x-0 bottom-0 truncate bg-black/50 px-1.5 py-1 text-[10px] text-white">{fmtTime(message.created_at)}</span>
                        </button>
                      );
                    })}
                  </div>
                ) : <p className="py-12 text-center text-sm text-muted-foreground">No shared media yet.</p>
              ) : galleryTab === "audio" ? (
                galleryAudio.length ? (
                  <ul className="divide-y">
                    {galleryAudio.map((message) => (
                      <li key={message.id} className="flex items-center justify-between gap-2 py-2">
                        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{message.sender_id === me.id ? "You" : peer.display_name} · {fmtTime(message.created_at)}</span>
                        <AudioPlayer path={message.media_url!} duration={Number(message.content) || 0} played={playedAudio.has(message.id)} onPlayed={() => markAudioPlayed(message.id)} />
                      </li>
                    ))}
                  </ul>
                ) : <p className="py-12 text-center text-sm text-muted-foreground">No voice notes yet.</p>
              ) : (
                galleryLinks.length ? (
                  <ul className="divide-y">
                    {galleryLinks.map(({ message, url }, index) => (
                      <li key={`${message.id}:${index}`} className="flex items-center gap-3 py-3">
                        <Link2 className="h-5 w-5 shrink-0 text-primary" />
                        <div className="min-w-0 flex-1">
                          <a href={url} target="_blank" rel="noreferrer" className="block truncate text-sm text-primary hover:underline">{url}</a>
                          <button type="button" onClick={() => jumpToGalleryMessage(message)} className="mt-1 text-xs text-muted-foreground hover:underline">
                            {message.sender_id === me.id ? "You" : peer.display_name} · {fmtTime(message.created_at)}
                          </button>
                        </div>
                      </li>
                    ))}
                  </ul>
                ) : <p className="py-12 text-center text-sm text-muted-foreground">No links shared yet.</p>
              )}
              {!galleryLoading && galleryMessages.length >= 1000 && <p className="mt-3 text-center text-xs text-muted-foreground">Showing the latest shared items.</p>}
            </div>
          </section>
        </div>
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
        <div className="fixed inset-0 z-40 flex items-center justify-center overflow-hidden bg-call-bg/95 p-4" onClick={() => setViewer(null)}>
          <button onClick={() => setViewer(null)} className="absolute right-4 z-10 flex h-11 w-11 items-center justify-center rounded-full text-call-fg" style={{ top: "max(1rem, env(safe-area-inset-top))" }} aria-label="Close"><X className="h-6 w-6" /></button>
          <div
            ref={imageViewport}
            className="flex h-full w-full touch-none select-none items-center justify-center overflow-hidden"
            onClick={(event) => event.stopPropagation()}
            onPointerDown={imagePointerDown}
            onPointerMove={imagePointerMove}
            onPointerUp={imagePointerUp}
            onPointerCancel={imagePointerUp}
          >
            <img
              ref={imageElement}
              src={viewer}
              alt="Full size"
              draggable={false}
              className="max-h-full max-w-full rounded-lg object-contain"
              style={{
                transform: `translate3d(${imageTransform.x}px, ${imageTransform.y}px, 0) scale(${imageTransform.scale})`,
                transformOrigin: "center",
                pointerEvents: "none",
              }}
            />
          </div>
        </div>
      )}
      {giphyOpen && <GiphyPicker onClose={() => setGiphyOpen(false)} onSelect={(item, kind) => sendGiphy(kind, item)} />}
    </div>
  );
});

type RowActions = {
  register: (id: string, element: HTMLDivElement | null) => void;
  toggleSel: (id: string) => void;
  startSel: (id: string) => void;
  reply: (m: Message) => void;
  edit: (m: Message) => void;
  react: (m: Message, emoji: string) => void;
  setMenu: (id: string | null) => void;
  setPicker: (id: string | null) => void;
  openViewOnce: (m: Message) => void;
  viewImage: (m: Message) => void;
  share: (m: Message, url?: string, title?: string) => void;
  download: (m: Message, url?: string, title?: string) => void;
  deleteForMe: (m: Message) => void;
  deleteForAll: (m: Message) => void;
  openViewer: (url: string) => void;
  audioPlayed: (id: string) => void;
  pressStart: (id: string) => void;
  cancelPress: () => void;
  consumeLongPressClick: (event: React.MouseEvent) => void;
};

/** Returns an object whose functions keep the same identity but always call the latest implementation. */
function useStableActions<T extends object>(impl: T): T {
  const latest = useRef(impl);
  latest.current = impl;
  const [stable] = useState(
    () =>
      Object.fromEntries(
        Object.keys(impl).map((key) => [key, (...args: unknown[]) => (latest.current[key as keyof T] as (...a: unknown[]) => unknown)(...args)]),
      ) as T,
  );
  return stable;
}

type RowProps = {
  m: Message;
  day: string | null;
  mine: boolean;
  rep: Message | undefined;
  selecting: boolean;
  selected: boolean;
  reactions: MessageReaction[] | undefined;
  played: boolean;
  menuOpen: boolean;
  pickerOpen: boolean;
  meId: string;
  peerName: string;
  actions: RowActions;
};

// Memoized so typing, timers and new messages only re-render the bubbles that actually changed.
const MessageRow = memo(function MessageRow({ m, day, mine, rep, selecting, selected, reactions, played, menuOpen, pickerOpen, meId, peerName, actions }: RowProps) {
  const attachment = useMemo(() => parseAttachment(m.content), [m.content]);
  const reactionGroups = useMemo(() => {
    const groups = new Map<string, { emoji: string; count: number; byMe: boolean }>();
    for (const reaction of reactions ?? []) {
      const group = groups.get(reaction.emoji) ?? { emoji: reaction.emoji, count: 0, byMe: false };
      group.count += 1;
      group.byMe ||= reaction.user_id === meId;
      groups.set(reaction.emoji, group);
    }
    return [...groups.values()];
  }, [reactions, meId]);
  return (
    <>
      {day && (
        <div className="my-3 flex justify-center">
          <span className="rounded-lg bg-card px-3 py-1 text-xs text-muted-foreground shadow-sm">{day}</span>
        </div>
      )}
      {m.type === "call" ? (
        <div ref={(element) => actions.register(m.id, element)} className={cn("group my-2 flex items-center justify-center gap-2", selected && "bg-primary/10")} onClick={selecting ? () => actions.toggleSel(m.id) : undefined}>
          {selecting && <Tick on={selected} />}
          <span className={cn("flex items-center gap-2 rounded-lg bg-card px-3 py-1.5 text-xs shadow-sm", m.content?.startsWith("Missed") && "text-destructive")}>
            {m.content?.startsWith("Missed") ? <PhoneMissed className="h-3.5 w-3.5" /> : m.content?.startsWith("Video") ? <Video className="h-3.5 w-3.5" /> : <Phone className="h-3.5 w-3.5" />}
            {m.content} · {fmtTime(m.created_at)}
          </span>
          {!selecting && (
            <DropdownMenu>
              <DropdownMenuTrigger onClick={(event) => event.stopPropagation()} className="flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground opacity-0 hover:bg-muted group-hover:opacity-100 focus:opacity-100 max-md:opacity-60" aria-label="Call entry options">
                <ChevronDown className="h-4 w-4" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="center">
                <DropdownMenuItem onClick={() => actions.reply(m)}><Reply className="mr-2 h-4 w-4" />Reply</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      ) : (
        <Popover open={pickerOpen} onOpenChange={(open) => actions.setPicker(open ? m.id : null)}>
          <PopoverAnchor asChild>
            <div
              ref={(element) => actions.register(m.id, element)}
              className={cn("group my-0.5 flex items-center gap-2 [-webkit-touch-callout:none]", mine ? "justify-end" : "justify-start", selected && "bg-primary/10", selecting && "cursor-pointer")}
              onClick={selecting ? () => actions.toggleSel(m.id) : undefined}
              onClickCapture={actions.consumeLongPressClick}
              onPointerDown={!selecting && !m.deleted_for_everyone ? () => actions.pressStart(m.id) : undefined}
              onPointerUp={actions.cancelPress}
              onPointerLeave={actions.cancelPress}
              onPointerCancel={actions.cancelPress}
              onPointerMove={actions.cancelPress}
            >
          {selecting && <div className={cn(mine && "order-last")}><Tick on={selected} /></div>}
          <div className={cn("relative max-w-[80%] rounded-xl px-2 pb-1 pt-1.5 shadow-sm md:max-w-[65%]", mine ? "rounded-tr-sm bg-bubble-out" : "rounded-tl-sm bg-bubble-in")}>
            {!m.deleted_for_everyone && (
              <DropdownMenu open={menuOpen} onOpenChange={(open) => actions.setMenu(open ? m.id : null)}>
                <DropdownMenuTrigger className="absolute right-0 top-0 z-10 flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground opacity-0 transition group-hover:opacity-100 focus:opacity-100 data-[state=open]:opacity-100 max-md:opacity-60" aria-label="Message options">
                  <ChevronDown className="h-4 w-4" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align={mine ? "end" : "start"} onCloseAutoFocus={() => actions.setMenu(null)}>
                  <div role="group" aria-label="React to message" className="flex items-center justify-between gap-1 border-b px-1 pb-1">
                    {QUICK_REACTIONS.map((emoji) => (
                      <DropdownMenuItem
                        key={emoji}
                        onSelect={() => actions.react(m, emoji)}
                        className="h-9 w-9 justify-center p-0 text-xl"
                        aria-label={`React ${emoji}`}
                      >
                        {emoji}
                      </DropdownMenuItem>
                    ))}
                  </div>
                  <DropdownMenuItem onSelect={() => actions.setPicker(m.id)}>
                    <Smile className="mr-1 h-4 w-4" />More emojis…
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => actions.reply(m)}><Reply className="mr-2 h-4 w-4" />Reply</DropdownMenuItem>
                  {mine && m.type === "text" && <DropdownMenuItem onClick={() => actions.edit(m)}><Pencil className="mr-2 h-4 w-4" />Edit message</DropdownMenuItem>}
                  {m.type === "image" && m.media_url && m.view_once && !mine && !m.view_once_opened_at && <DropdownMenuItem onClick={() => actions.openViewOnce(m)}><Clock3 className="mr-2 h-4 w-4" />Open view-once photo</DropdownMenuItem>}
                  {m.type === "image" && m.media_url && (!m.view_once || mine) && <DropdownMenuItem onClick={() => actions.viewImage(m)}><ImageIcon className="mr-2 h-4 w-4" />View image</DropdownMenuItem>}
                  {(m.media_url || attachment?.url) && (!m.view_once || mine) && <DropdownMenuItem onClick={() => actions.share(m, attachment?.url, attachment?.title)}><Share className="mr-2 h-4 w-4" />Share</DropdownMenuItem>}
                  {(m.media_url || attachment?.url) && (!m.view_once || mine) && <DropdownMenuItem onClick={() => actions.download(m, attachment?.url, attachment?.title)}><Download className="mr-2 h-4 w-4" />Download</DropdownMenuItem>}
                  <DropdownMenuItem onClick={() => actions.startSel(m.id)}><ListChecks className="mr-2 h-4 w-4" />Select</DropdownMenuItem>
                  <DropdownMenuItem onClick={() => actions.deleteForMe(m)}><Trash2 className="mr-2 h-4 w-4" />Delete for me</DropdownMenuItem>
                  {mine && <DropdownMenuItem onClick={() => actions.deleteForAll(m)} className="text-destructive"><Trash2 className="mr-2 h-4 w-4" />Delete for everyone</DropdownMenuItem>}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            {rep && !m.deleted_for_everyone && (
              <div className="mb-1 rounded-md border-l-4 border-primary bg-foreground/5 px-2 py-1 text-xs">
                <div className="font-medium text-primary">{rep.sender_id === meId ? "You" : peerName}</div>
                <div className="truncate text-muted-foreground">{preview(rep, "")}</div>
              </div>
            )}
            {m.deleted_for_everyone ? (
              <p className="px-1 text-sm italic text-muted-foreground">🚫 This message was deleted</p>
            ) : m.type === "image" && m.media_url && m.view_once && !mine && m.view_once_opened_at ? (
              <p className="flex items-center gap-2 px-2 py-2 text-sm italic text-muted-foreground"><Clock3 className="h-4 w-4" />This photo was opened</p>
            ) : m.type === "image" && m.media_url && m.view_once && !mine ? (
              <button type="button" onClick={() => actions.openViewOnce(m)} className="flex min-w-52 items-center gap-3 rounded-lg bg-primary/10 px-3 py-3 text-sm hover:bg-primary/20">
                <Clock3 className="h-5 w-5 shrink-0 text-primary" />
                <span className="text-left"><strong className="block">View once photo</strong><span className="text-xs text-muted-foreground">Open this photo one time</span></span>
              </button>
            ) : m.type === "image" && m.media_url ? (
              <ImageThumb path={m.media_url} onOpen={actions.openViewer} />
            ) : m.type === "audio" && m.media_url ? (
              <AudioPlayer path={m.media_url} duration={Number(m.content) || 0} played={played} onPlayed={() => actions.audioPlayed(m.id)} />
            ) : m.type === "location" && attachment?.mapsUrl ? (
              <a href={attachment.mapsUrl} target="_blank" rel="noreferrer" className="flex min-w-52 items-center gap-3 rounded-lg bg-primary/10 px-3 py-3 text-sm hover:bg-primary/20">
                <MapPin className="h-5 w-5 shrink-0 text-primary" />
                <span><strong className="block">Current location</strong><span className="text-xs text-muted-foreground">Open in Google Maps</span></span>
              </a>
            ) : (m.type === "gif" || m.type === "sticker") && attachment?.url ? (
              <button onClick={() => actions.openViewer(attachment.url!)} className="block overflow-hidden rounded-lg" aria-label={`View ${m.type}`}>
                <img src={attachment.url} alt={attachment.title || m.type} className="max-h-72 max-w-64 object-cover" />
              </button>
            ) : (
              <p className="whitespace-pre-wrap break-words px-1 text-[15px] leading-snug">{renderLinkedText(m.content ?? "")}</p>
            )}
            <div className="mt-1 flex items-center justify-end gap-1 pl-1 text-[11px] text-muted-foreground">
              <span className="whitespace-nowrap">{fmtTime(m.created_at)}</span>
              {mine && !m.deleted_for_everyone && (m.status === "sent" ? <Check className="h-3.5 w-3.5" /> : <CheckCheck className={cn("h-3.5 w-3.5", m.status === "read" && "text-tick-read")} />)}
            </div>
            {!m.deleted_for_everyone && reactionGroups.length > 0 && (
              <div className="mt-1 flex flex-wrap gap-1" aria-label="Message reactions">
                {reactionGroups.map(({ emoji, count, byMe }) => (
                  <button
                    key={emoji}
                    type="button"
                    onClick={() => actions.react(m, emoji)}
                    className={cn("rounded-full border px-1.5 py-0.5 text-xs", byMe ? "border-primary/50 bg-primary/10" : "border-border bg-background/60")}
                    aria-label={`${emoji}, ${count} ${count === 1 ? "reaction" : "reactions"}${byMe ? ", reacted by you" : ""}`}
                  >
                    {emoji} {count}
                  </button>
                ))}
              </div>
            )}
          </div>
            </div>
          </PopoverAnchor>
          <PopoverContent
            side="top"
            align={mine ? "end" : "start"}
            sideOffset={8}
            className="w-auto overflow-hidden p-0"
            onOpenAutoFocus={(event) => event.preventDefault()}
          >
            <Suspense fallback={<div className="flex h-[400px] w-[min(360px,calc(100vw-2rem))] items-center justify-center text-sm text-muted-foreground">Loading…</div>}>
            <EmojiPicker
              onEmojiClick={(emoji) => {
                actions.setPicker(null);
                actions.react(m, emoji.emoji);
              }}
              emojiStyle={"native" as EmojiStyle}
              width="min(360px, calc(100vw - 2rem))"
              height={400}
              previewConfig={{ showPreview: false }}
            />
            </Suspense>
          </PopoverContent>
        </Popover>
      )}
    </>
  );
});

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
