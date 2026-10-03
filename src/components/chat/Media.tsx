import { useEffect, useRef, useState } from "react";
import { Pause, Play } from "lucide-react";
import { signedUrl } from "@/lib/supabase";
import { fmtDur } from "@/lib/format";

export function useSigned(path: string | null) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!path) return;
    let on = true;
    signedUrl(path).then((u) => on && setUrl(u));
    return () => { on = false; };
  }, [path]);
  return url;
}

export function ImageThumb({ path, onOpen }: { path: string; onOpen: (url: string) => void }) {
  const url = useSigned(path);
  return url ? (
    <img
      src={url}
      alt="Photo"
      onClick={() => onOpen(url)}
      className="max-h-72 w-full max-w-64 cursor-pointer rounded-lg object-cover"
    />
  ) : (
    <div className="h-48 w-56 animate-pulse rounded-lg bg-muted" />
  );
}

export function AudioPlayer({ path, duration }: { path: string; duration: number }) {
  const url = useSigned(path);
  const ref = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [t, setT] = useState(0);
  const bars = useRef(Array.from({ length: 28 }, (_, i) => 0.3 + Math.abs(Math.sin(i * 1.7 + path.length)) * 0.7));
  const total = duration || 1;
  const pct = Math.min(1, t / total);

  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  useEffect(() => () => { if (blobUrl) URL.revokeObjectURL(blobUrl); }, [blobUrl]);

  // Some browsers refuse the stored file's type; load it locally and retry once.
  const fallback = async () => {
    if (!url || blobUrl) return false;
    try {
      const b = await (await fetch(url)).blob();
      const u = URL.createObjectURL(b);
      setBlobUrl(u);
      const a = ref.current;
      if (!a) return false;
      a.src = u;
      a.load();
      await a.play();
      return true;
    } catch { return false; }
  };

  const toggle = async () => {
    const a = ref.current;
    if (!a) return;
    if (!a.paused) return a.pause();
    document.querySelectorAll("audio").forEach((o) => { if (o !== a) o.pause(); });
    try { await a.play(); }
    catch { if (!(await fallback())) alert("This voice note can't be played on this device."); }
  };

  return (
    <div className="flex w-60 items-center gap-3 py-1">
      <audio
        ref={ref}
        src={url ?? undefined}
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => { setPlaying(false); setT(0); }}
        onTimeUpdate={(e) => setT(e.currentTarget.currentTime)}
      />
      <button
        onClick={toggle}
        disabled={!url}
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground"
        aria-label={playing ? "Pause" : "Play"}
      >
        {playing ? <Pause className="h-4 w-4" /> : <Play className="ml-0.5 h-4 w-4" />}
      </button>
      <div className="flex-1">
        <div
          className="flex h-7 cursor-pointer items-center gap-[2px]"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            if (ref.current) ref.current.currentTime = ((e.clientX - r.left) / r.width) * total;
          }}
        >
          {bars.current.map((h, i) => (
            <span
              key={i}
              className={i / bars.current.length < pct ? "bg-primary" : "bg-muted-foreground/35"}
              style={{ height: `${h * 100}%`, width: 3, borderRadius: 2 }}
            />
          ))}
        </div>
        <div className="text-[11px] text-muted-foreground">{fmtDur(playing || t ? t : total)}</div>
      </div>
    </div>
  );
}
