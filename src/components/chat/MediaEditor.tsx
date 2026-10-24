import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Check, Crop, LoaderCircle, Pencil, RotateCw, Type, Undo2, X } from "lucide-react";
import { cn } from "@/lib/utils";

// Edit a photo (crop, rotate, draw, text) or trim a video before it is sent.
// Everything happens in the browser; onSave receives the new file to upload instead of the original.
export function MediaEditor({ file, onCancel, onSave }: { file: File; onCancel: () => void; onSave: (file: File) => void }) {
  return file.type.startsWith("video/") ? (
    <VideoTrimmer file={file} onCancel={onCancel} onSave={onSave} />
  ) : (
    <ImageEditor file={file} onCancel={onCancel} onSave={onSave} />
  );
}

const COLORS = ["#ffffff", "#000000", "#ef4444", "#f59e0b", "#22c55e", "#3b82f6", "#ec4899"];

function EditorShell({ title, busy, onCancel, onDone, children, footer }: { title: string; busy: boolean; onCancel: () => void; onDone: () => void; children: React.ReactNode; footer: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-[60] flex flex-col bg-black text-white" style={{ paddingTop: "env(safe-area-inset-top)", paddingBottom: "env(safe-area-inset-bottom)" }}>
      <div className="flex h-14 shrink-0 items-center gap-2 px-2">
        <button type="button" onClick={onCancel} disabled={busy} className="flex h-11 w-11 items-center justify-center rounded-full hover:bg-white/10 disabled:opacity-40" aria-label="Cancel editing"><X className="h-5 w-5" /></button>
        <div className="flex-1 text-sm font-medium">{title}</div>
        <button type="button" onClick={onDone} disabled={busy} className="flex h-10 items-center gap-1.5 rounded-full bg-primary px-4 text-sm font-medium text-primary-foreground disabled:opacity-60">
          {busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}Done
        </button>
      </div>
      <div className="relative min-h-0 flex-1">{children}</div>
      <div className="shrink-0 px-3 pb-3 pt-2">{footer}</div>
    </div>
  );
}

// ---------------- Photo editor ----------------

type Point = { x: number; y: number };
type Stroke = { kind: "stroke"; color: string; width: number; points: Point[] };
type TextMark = { kind: "text"; color: string; size: number; x: number; y: number; text: string };
type Mark = Stroke | TextMark;
type Rect = { x: number; y: number; w: number; h: number };
type Mode = "crop" | "draw" | "text";

/** Rotates a point 90° clockwise inside an image that is `height` tall before rotating. */
const rotatePoint = (p: Point, height: number): Point => ({ x: height - p.y, y: p.x });

function ImageEditor({ file, onCancel, onSave }: { file: File; onCancel: () => void; onSave: (file: File) => void }) {
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [turns, setTurns] = useState(0); // quarter turns clockwise
  const [marks, setMarks] = useState<Mark[]>([]);
  const [crop, setCrop] = useState<Rect | null>(null);
  const [square, setSquare] = useState(false);
  const [mode, setMode] = useState<Mode>("draw");
  const [color, setColor] = useState(COLORS[2]!);
  const [textDraft, setTextDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [view, setView] = useState({ scale: 1, left: 0, top: 0 });
  const drag = useRef<{ type: "stroke" } | { type: "text"; index: number; dx: number; dy: number } | { type: "crop"; handle: string; start: Point; rect: Rect } | null>(null);

  useEffect(() => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => setImage(img);
    img.src = url;
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const W = image ? (turns % 2 ? image.naturalHeight : image.naturalWidth) : 1;
  const H = image ? (turns % 2 ? image.naturalWidth : image.naturalHeight) : 1;
  const area = crop ?? { x: 0, y: 0, w: W, h: H };

  // Paints the rotated photo with its marks onto any 2D context, in image pixels.
  const paint = (ctx: CanvasRenderingContext2D, img: HTMLImageElement) => {
    ctx.save();
    ctx.translate(W / 2, H / 2);
    ctx.rotate((turns * Math.PI) / 2);
    ctx.drawImage(img, -img.naturalWidth / 2, -img.naturalHeight / 2);
    ctx.restore();
    for (const mark of marks) {
      if (mark.kind === "stroke") {
        ctx.strokeStyle = mark.color;
        ctx.lineWidth = mark.width;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.beginPath();
        mark.points.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
        if (mark.points.length === 1) ctx.lineTo(mark.points[0]!.x + 0.1, mark.points[0]!.y);
        ctx.stroke();
      } else {
        ctx.font = `bold ${mark.size}px system-ui, sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.lineWidth = mark.size / 8;
        ctx.strokeStyle = mark.color === "#000000" ? "#ffffff" : "#000000";
        ctx.strokeText(mark.text, mark.x, mark.y);
        ctx.fillStyle = mark.color;
        ctx.fillText(mark.text, mark.x, mark.y);
      }
    }
  };

  // Fit the whole rotated photo in the screen area and redraw.
  useLayoutEffect(() => {
    const el = wrap.current;
    const c = canvas.current;
    if (!el || !c || !image) return;
    const draw = () => {
      const scale = Math.min(el.clientWidth / W, el.clientHeight / H);
      const dpr = window.devicePixelRatio || 1;
      c.width = Math.round(W * scale * dpr);
      c.height = Math.round(H * scale * dpr);
      c.style.width = `${W * scale}px`;
      c.style.height = `${H * scale}px`;
      const left = (el.clientWidth - W * scale) / 2;
      const top = (el.clientHeight - H * scale) / 2;
      c.style.left = `${left}px`;
      c.style.top = `${top}px`;
      setView((v) => (v.scale === scale && v.left === left && v.top === top ? v : { scale, left, top }));
      const ctx = c.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(scale * dpr, 0, 0, scale * dpr, 0, 0);
      paint(ctx, image);
    };
    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(el);
    return () => observer.disconnect();
  });

  const toImage = (event: ReactPointerEvent): Point => {
    const rect = canvas.current!.getBoundingClientRect();
    return {
      x: Math.min(W, Math.max(0, (event.clientX - rect.left) / view.scale)),
      y: Math.min(H, Math.max(0, (event.clientY - rect.top) / view.scale)),
    };
  };

  const textIndexAt = (p: Point) => {
    for (let i = marks.length - 1; i >= 0; i--) {
      const m = marks[i]!;
      if (m.kind === "text" && Math.abs(p.x - m.x) < (m.size * m.text.length) / 3 + m.size && Math.abs(p.y - m.y) < m.size) return i;
    }
    return -1;
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!image || textDraft !== null) return;
    (event.target as Element).setPointerCapture?.(event.pointerId);
    const p = toImage(event);
    if (mode === "draw") {
      drag.current = { type: "stroke" };
      setMarks((list) => [...list, { kind: "stroke", color, width: Math.max(W, H) / 120, points: [p] }]);
    } else if (mode === "text") {
      const index = textIndexAt(p);
      if (index >= 0) {
        const m = marks[index] as TextMark;
        drag.current = { type: "text", index, dx: m.x - p.x, dy: m.y - p.y };
      }
    } else {
      // Only the crop box (move) and its corner handles (resize) can be dragged.
      const handle = (event.target as HTMLElement).dataset["handle"];
      if (handle) drag.current = { type: "crop", handle, start: p, rect: area };
    }
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const p = toImage(event);
    if (d.type === "stroke") {
      setMarks((list) => {
        const last = list[list.length - 1];
        if (!last || last.kind !== "stroke") return list;
        return [...list.slice(0, -1), { ...last, points: [...last.points, p] }];
      });
    } else if (d.type === "text") {
      setMarks((list) => list.map((m, i) => (i === d.index && m.kind === "text" ? { ...m, x: p.x + d.dx, y: p.y + d.dy } : m)));
    } else {
      const r = d.rect;
      const min = Math.max(W, H) / 20;
      let { x, y, w, h } = r;
      if (d.handle === "move") {
        x = Math.min(Math.max(0, r.x + p.x - d.start.x), W - r.w);
        y = Math.min(Math.max(0, r.y + p.y - d.start.y), H - r.h);
      } else {
        const right = d.handle.includes("e") ? p.x : r.x + r.w;
        const bottom = d.handle.includes("s") ? p.y : r.y + r.h;
        const leftX = d.handle.includes("w") ? p.x : r.x;
        const topY = d.handle.includes("n") ? p.y : r.y;
        x = Math.min(leftX, right - min);
        y = Math.min(topY, bottom - min);
        w = Math.max(min, right - x);
        h = Math.max(min, bottom - y);
        if (square) {
          const side = Math.min(Math.max(w, h), W - x, H - y);
          w = side;
          h = side;
        }
      }
      setCrop({ x, y, w, h });
    }
  };

  const onPointerUp = () => {
    drag.current = null;
  };

  const rotate = () => {
    // Turn the marks and crop with the photo so they stay where they were drawn.
    setMarks((list) =>
      list.map((m) =>
        m.kind === "stroke" ? { ...m, points: m.points.map((p) => rotatePoint(p, H)) } : { ...m, ...rotatePoint({ x: m.x, y: m.y }, H) },
      ),
    );
    setCrop((c) => (c ? { x: H - c.y - c.h, y: c.x, w: c.h, h: c.w } : c));
    setTurns((t) => (t + 1) % 4);
  };

  const startCrop = () => {
    setMode("crop");
    if (!crop) setCrop({ x: W * 0.05, y: H * 0.05, w: W * 0.9, h: H * 0.9 });
  };

  const toggleSquare = () => {
    const next = !square;
    setSquare(next);
    if (next) {
      const side = Math.min(area.w, area.h);
      setCrop({ x: area.x + (area.w - side) / 2, y: area.y + (area.h - side) / 2, w: side, h: side });
    }
  };

  const addText = () => {
    const text = textDraft?.trim();
    setTextDraft(null);
    if (!text) return;
    setMarks((list) => [...list, { kind: "text", color, size: Math.max(W, H) / 16, x: area.x + area.w / 2, y: area.y + area.h / 2, text }]);
  };

  const save = async () => {
    if (!image) return;
    if (!marks.length && !turns && !crop) return onCancel();
    setBusy(true);
    const full = document.createElement("canvas");
    full.width = W;
    full.height = H;
    const fullCtx = full.getContext("2d");
    if (!fullCtx) return setBusy(false);
    paint(fullCtx, image);
    const out = document.createElement("canvas");
    out.width = Math.round(area.w);
    out.height = Math.round(area.h);
    out.getContext("2d")?.drawImage(full, area.x, area.y, area.w, area.h, 0, 0, out.width, out.height);
    const blob = await new Promise<Blob | null>((resolve) => out.toBlob(resolve, "image/jpeg", 0.92));
    setBusy(false);
    if (!blob) return alert("Could not save the edited photo.");
    onSave(new File([blob], `${file.name.replace(/\.[^.]+$/, "") || "photo"}-edited.jpg`, { type: "image/jpeg" }));
  };

  const s = view.scale;
  const tool = (active: boolean) => cn("flex h-11 flex-1 flex-col items-center justify-center gap-0.5 rounded-lg text-[11px]", active ? "bg-white/20" : "hover:bg-white/10");

  return (
    <EditorShell
      title="Edit photo"
      busy={busy}
      onCancel={onCancel}
      onDone={() => void save()}
      footer={
        <div className="space-y-2">
          {mode !== "crop" ? (
            <div className="flex items-center justify-center gap-2">
              {COLORS.map((c) => (
                <button key={c} type="button" onClick={() => setColor(c)} className={cn("h-7 w-7 rounded-full border-2", color === c ? "border-white" : "border-white/30")} style={{ background: c }} aria-label={`Colour ${c}`} />
              ))}
              <button type="button" onClick={() => setMarks((list) => list.slice(0, -1))} disabled={!marks.length} className="ml-2 flex h-9 w-9 items-center justify-center rounded-full hover:bg-white/10 disabled:opacity-30" aria-label="Undo"><Undo2 className="h-5 w-5" /></button>
            </div>
          ) : (
            <div className="flex items-center justify-center gap-2 text-xs">
              <button type="button" onClick={toggleSquare} className={cn("rounded-full px-3 py-1.5", square ? "bg-white text-black" : "bg-white/15")}>Square</button>
              <button type="button" onClick={() => { setCrop(null); setSquare(false); setMode("draw"); }} className="rounded-full bg-white/15 px-3 py-1.5">Reset crop</button>
            </div>
          )}
          <div className="flex gap-2">
            <button type="button" onClick={startCrop} className={tool(mode === "crop")}><Crop className="h-5 w-5" />Crop</button>
            <button type="button" onClick={rotate} className={tool(false)}><RotateCw className="h-5 w-5" />Rotate</button>
            <button type="button" onClick={() => setMode("draw")} className={tool(mode === "draw")}><Pencil className="h-5 w-5" />Draw</button>
            <button type="button" onClick={() => { setMode("text"); setTextDraft(""); }} className={tool(mode === "text")}><Type className="h-5 w-5" />Text</button>
          </div>
        </div>
      }
    >
      <div ref={wrap} className="absolute inset-0 touch-none select-none overflow-hidden" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}>
        {!image && <div className="flex h-full items-center justify-center"><LoaderCircle className="h-6 w-6 animate-spin" /></div>}
        <canvas ref={canvas} className="absolute" />
        {image && mode === "crop" && crop && (
          <div className="pointer-events-none absolute" style={{ left: view.left, top: view.top, width: W * s, height: H * s }}>
            <div
              data-handle="move"
              className="pointer-events-auto absolute cursor-move border-2 border-white shadow-[0_0_0_9999px_rgba(0,0,0,0.55)]"
              style={{ left: crop.x * s, top: crop.y * s, width: crop.w * s, height: crop.h * s }}
            >
              {["nw", "ne", "sw", "se"].map((h) => (
                <span
                  key={h}
                  data-handle={h}
                  className={cn("absolute h-7 w-7 rounded-full border-2 border-white bg-black/40", h.includes("n") ? "-top-3.5" : "-bottom-3.5", h.includes("w") ? "-left-3.5" : "-right-3.5")}
                />
              ))}
            </div>
          </div>
        )}
        {textDraft !== null && (
          <form
            className="absolute inset-x-3 top-1/3 flex gap-2"
            onPointerDown={(e) => e.stopPropagation()}
            onSubmit={(e) => { e.preventDefault(); addText(); }}
          >
            <input autoFocus value={textDraft} onChange={(e) => setTextDraft(e.target.value)} maxLength={80} placeholder="Type text…" className="min-w-0 flex-1 rounded-lg bg-white/90 px-3 py-2 text-base text-black outline-none" style={{ color }} />
            <button type="submit" className="rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground">Add</button>
            <button type="button" onClick={() => setTextDraft(null)} className="rounded-lg bg-white/15 px-3 text-sm">Cancel</button>
          </form>
        )}
        {mode === "text" && textDraft === null && marks.some((m) => m.kind === "text") && (
          <p className="pointer-events-none absolute inset-x-0 top-2 text-center text-xs text-white/70">Drag text to move it</p>
        )}
      </div>
    </EditorShell>
  );
}

// ---------------- Video trimmer ----------------

const fmt = (secs: number) => `${Math.floor(secs / 60)}:${String(Math.floor(secs % 60)).padStart(2, "0")}`;

const MIN_CLIP_SECS = 0.5;

/** One bar with two handles (start and end), like WhatsApp's trimmer. Drag the middle to move the whole selection. */
function RangeBar({ duration, start, end, disabled, onChange }: { duration: number; start: number; end: number; disabled: boolean; onChange: (start: number, end: number) => void }) {
  const bar = useRef<HTMLDivElement>(null);
  const drag = useRef<{ part: "start" | "end" | "both"; at: number; start: number; end: number } | null>(null);
  const pct = (secs: number) => (duration ? (secs / duration) * 100 : 0);
  const secsAt = (clientX: number) => {
    const rect = bar.current!.getBoundingClientRect();
    return Math.min(duration, Math.max(0, ((clientX - rect.left) / rect.width) * duration));
  };
  const onDown = (part: "start" | "end" | "both") => (event: ReactPointerEvent) => {
    if (disabled) return;
    event.stopPropagation();
    (event.currentTarget as Element).setPointerCapture(event.pointerId);
    drag.current = { part, at: secsAt(event.clientX), start, end };
  };
  const onMove = (event: ReactPointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const t = secsAt(event.clientX);
    if (d.part === "start") onChange(Math.min(t, d.end - MIN_CLIP_SECS), d.end);
    else if (d.part === "end") onChange(d.start, Math.max(t, d.start + MIN_CLIP_SECS));
    else {
      const shift = Math.min(Math.max(t - d.at, -d.start), duration - d.end);
      onChange(d.start + shift, d.end + shift);
    }
  };
  const onUp = () => {
    drag.current = null;
  };
  const nudge = (part: "start" | "end") => (event: React.KeyboardEvent) => {
    const step = event.key === "ArrowLeft" ? -0.1 : event.key === "ArrowRight" ? 0.1 : 0;
    if (!step || disabled) return;
    event.preventDefault();
    if (part === "start") onChange(Math.min(Math.max(0, start + step), end - MIN_CLIP_SECS), end);
    else onChange(start, Math.max(Math.min(duration, end + step), start + MIN_CLIP_SECS));
  };
  const handle = "absolute top-1/2 h-10 w-5 -translate-y-1/2 rounded-md bg-primary shadow touch-none focus:outline-none focus:ring-2 focus:ring-white";
  return (
    <div ref={bar} className={cn("relative mx-2.5 h-10 touch-none select-none", disabled && "opacity-50")} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
      <div className="absolute inset-x-0 top-1/2 h-2 -translate-y-1/2 rounded-full bg-white/25" />
      <div
        className="absolute top-1/2 h-10 -translate-y-1/2 cursor-grab border-y-4 border-primary bg-primary/25"
        style={{ left: `${pct(start)}%`, width: `${pct(end) - pct(start)}%` }}
        onPointerDown={onDown("both")}
      />
      <span role="slider" tabIndex={0} aria-label="Start" aria-valuemin={0} aria-valuemax={duration} aria-valuenow={start} className={cn(handle, "-translate-x-full")} style={{ left: `${pct(start)}%` }} onPointerDown={onDown("start")} onKeyDown={nudge("start")} />
      <span role="slider" tabIndex={0} aria-label="End" aria-valuemin={0} aria-valuemax={duration} aria-valuenow={end} className={handle} style={{ left: `${pct(end)}%` }} onPointerDown={onDown("end")} onKeyDown={nudge("end")} />
    </div>
  );
}

function pickRecorderType() {
  if (typeof MediaRecorder === "undefined") return null;
  for (const type of ["video/mp4;codecs=avc1,mp4a", "video/mp4", "video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"]) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return null;
}

function VideoTrimmer({ file, onCancel, onSave }: { file: File; onCancel: () => void; onSave: (file: File) => void }) {
  const [url] = useState(() => URL.createObjectURL(file));
  const video = useRef<HTMLVideoElement>(null);
  const [duration, setDuration] = useState(0);
  const [start, setStart] = useState(0);
  const [end, setEnd] = useState(0);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const cancelled = useRef(false);

  useEffect(() => () => URL.revokeObjectURL(url), [url]);

  // Preview loops inside the chosen range.
  const onTimeUpdate = () => {
    const v = video.current;
    if (!v || busy) return;
    if (v.currentTime >= end || v.currentTime < start - 0.25) v.currentTime = start;
  };

  const setRange = (nextStart: number, nextEnd: number) => {
    setStart(nextStart);
    setEnd(nextEnd);
    if (video.current) video.current.currentTime = nextStart;
  };

  const save = async () => {
    const v = video.current;
    if (!v || !duration) return;
    if (start <= 0.05 && end >= duration - 0.05) return onCancel(); // nothing trimmed
    const type = pickRecorderType();
    const canvasEl = document.createElement("canvas");
    if (!type || !("captureStream" in canvasEl)) {
      alert("Trimming isn't supported in this browser. You can still send the full video.");
      return;
    }
    setBusy(true);
    cancelled.current = false;
    // Re-record the chosen range in real time: frames via a canvas, sound via Web Audio.
    const scale = Math.min(1, 1280 / Math.max(v.videoWidth, v.videoHeight));
    canvasEl.width = Math.round(v.videoWidth * scale) || 640;
    canvasEl.height = Math.round(v.videoHeight * scale) || 360;
    const ctx = canvasEl.getContext("2d");
    const stream = canvasEl.captureStream(30);
    let audio: AudioContext | null = null;
    try {
      audio = new AudioContext();
      const source = audio.createMediaElementSource(v);
      const dest = audio.createMediaStreamDestination();
      source.connect(dest);
      dest.stream.getAudioTracks().forEach((track) => stream.addTrack(track));
    } catch {
      /* No sound track (or Web Audio unavailable): record picture only. */
    }
    const chunks: Blob[] = [];
    const recorder = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 2_500_000 });
    recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    const finished = new Promise<void>((resolve) => (recorder.onstop = () => resolve()));
    v.pause();
    v.muted = false;
    v.loop = false;
    v.currentTime = start;
    await new Promise((resolve) => v.addEventListener("seeked", resolve, { once: true }));
    let frame = 0;
    const drawFrame = () => {
      ctx?.drawImage(v, 0, 0, canvasEl.width, canvasEl.height);
      setProgress(Math.min(1, (v.currentTime - start) / (end - start)));
      if (cancelled.current || v.currentTime >= end || v.ended) {
        v.pause();
        if (recorder.state !== "inactive") recorder.stop();
        return;
      }
      frame = requestAnimationFrame(drawFrame);
    };
    recorder.start(250);
    await v.play();
    drawFrame();
    await finished;
    cancelAnimationFrame(frame);
    stream.getTracks().forEach((track) => track.stop());
    void audio?.close();
    v.muted = true;
    setBusy(false);
    setProgress(0);
    if (cancelled.current) return;
    const blob = new Blob(chunks, { type: type.split(";")[0] ?? type });
    if (!blob.size) return alert("Could not trim this video.");
    const ext = type.startsWith("video/mp4") ? "mp4" : "webm";
    onSave(new File([blob], `${file.name.replace(/\.[^.]+$/, "") || "video"}-trimmed.${ext}`, { type: blob.type }));
  };

  const cancel = () => {
    if (busy) {
      cancelled.current = true;
      return;
    }
    onCancel();
  };

  return (
    <EditorShell
      title={busy ? `Trimming… ${Math.round(progress * 100)}%` : "Trim video"}
      busy={busy}
      onCancel={cancel}
      onDone={() => void save()}
      footer={
        <div className="space-y-2 text-xs">
          <div className="flex justify-between text-white/80">
            <span>Start {fmt(start)}</span>
            <span>{fmt(Math.max(0, end - start))} selected</span>
            <span>End {fmt(end)}</span>
          </div>
          <RangeBar
            duration={duration}
            start={start}
            end={end}
            disabled={busy || !duration}
            onChange={(nextStart, nextEnd) => setRange(nextStart, nextEnd)}
          />
          {busy && <p className="text-center text-white/70">Plays through the selected part once to cut it. Keep this screen open.</p>}
        </div>
      }
    >
      <video
        ref={video}
        src={url}
        playsInline
        muted
        autoPlay
        loop
        onLoadedMetadata={(e) => {
          const d = Number.isFinite(e.currentTarget.duration) ? e.currentTarget.duration : 0;
          setDuration(d);
          setEnd(d);
        }}
        onTimeUpdate={onTimeUpdate}
        className="absolute inset-0 h-full w-full object-contain"
      />
    </EditorShell>
  );
}
