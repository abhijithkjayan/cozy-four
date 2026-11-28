import { useEffect, useRef, useState } from "react";
import { Pause, Play } from "lucide-react";
import { signedUrl } from "@/lib/supabase";
import { fmtDur } from "@/lib/format";

/** True once the element has come into view; stays true afterwards. */
export function useNearView<T extends Element>() {
  const ref = useRef<T>(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || near) return;
    if (typeof IntersectionObserver === "undefined") {
      setNear(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setNear(true);
          observer.disconnect();
        }
      },
      { rootMargin: "300px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [near]);
  return [ref, near] as const;
}

/** The signed link for a stored file. With `enabled` false nothing is requested yet. */
export function useSigned(path: string | null, enabled = true) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!path || !enabled) return;
    let on = true;
    signedUrl(path).then((u) => on && setUrl(u));
    return () => { on = false; };
  }, [path, enabled]);
  return url;
}

// Photos and videos get their box from the start, so the chat does not jump when they finish loading.
const MEDIA_BOX = "h-64 w-64 max-w-full overflow-hidden rounded-lg";

export function ImageThumb({ path, onOpen }: { path: string; onOpen: (url: string) => void }) {
  const [ref, near] = useNearView<HTMLDivElement>();
  const url = useSigned(path, near);
  const [loaded, setLoaded] = useState(false);
  return (
    <div ref={ref} className={`${MEDIA_BOX} bg-muted ${loaded ? "" : "animate-pulse"}`}>
      {url && (
        <img
          src={url}
          alt="Photo"
          loading="lazy"
          decoding="async"
          onLoad={() => setLoaded(true)}
          onClick={() => onOpen(url)}
          className={`h-full w-full cursor-pointer object-cover transition-opacity duration-200 ${loaded ? "opacity-100" : "opacity-0"}`}
        />
      )}
    </div>
  );
}

export function AudioPlayer({ path, duration, played, onPlayed }: { path: string; duration: number; played: boolean; onPlayed: () => void }) {
  const [box, near] = useNearView<HTMLDivElement>();
  const url = useSigned(path, near);
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
    <div ref={box} className="flex w-60 items-center gap-3 py-1">
      {/* The length comes with the message, so nothing is downloaded until Play is pressed. */}
      <audio
        ref={ref}
        src={url ?? undefined}
        preload="none"
        onPlay={() => { setPlaying(true); onPlayed(); }}
        onPause={() => setPlaying(false)}
        onEnded={() => { setPlaying(false); setT(0); }}
        onTimeUpdate={(e) => setT(e.currentTarget.currentTime)}
      />
      <button
        onClick={toggle}
        disabled={!url}
        className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-primary-foreground ${played ? "bg-tick-read" : "bg-primary"}`}
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
              className={i / bars.current.length < pct ? (played ? "bg-tick-read" : "bg-primary") : "bg-muted-foreground/35"}
              style={{ height: `${h * 100}%`, width: 3, borderRadius: 2 }}
            />
          ))}
        </div>
        <div className="text-[11px] text-muted-foreground">{fmtDur(playing || t ? t : total)}</div>
      </div>
    </div>
  );
}

export function VideoPlayer({ path }: { path: string }) {
  const [ref, near] = useNearView<HTMLDivElement>();
  const url = useSigned(path, near);
  return (
    <div ref={ref} className={`${MEDIA_BOX} bg-black/80 ${url ? "" : "animate-pulse"}`}>
      {/* "#t=0.1" makes phones show the first frame instead of a black box. */}
      {url && <video src={`${url}#t=0.1`} controls playsInline preload="metadata" className="h-full w-full object-contain" />}
    </div>
  );
}
