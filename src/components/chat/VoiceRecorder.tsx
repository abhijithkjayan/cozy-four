import { useEffect, useRef, useState } from "react";
import { Mic, Send, Trash2 } from "lucide-react";
import { fmtDur } from "@/lib/format";

export function VoiceRecorder({ onSend }: { onSend: (blob: Blob, secs: number, mime: string) => void }) {
  const [rec, setRec] = useState(false);
  const [secs, setSecs] = useState(0);
  const mr = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const start = useRef(0);
  const cancel = useRef(false);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => { clearInterval(timer.current); mr.current?.stream.getTracks().forEach((t) => t.stop()); }, []);

  const begin = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg"].find((m) => MediaRecorder.isTypeSupported(m)) ?? "";
      const r = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      chunks.current = [];
      cancel.current = false;
      r.ondataavailable = (e) => e.data.size && chunks.current.push(e.data);
      r.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        const dur = (Date.now() - start.current) / 1000;
        if (!cancel.current && dur > 0.5) {
          const type = r.mimeType || "audio/webm";
          onSend(new Blob(chunks.current, { type }), dur, type);
        }
      };
      r.start();
      mr.current = r;
      start.current = Date.now();
      setSecs(0);
      setRec(true);
      timer.current = window.setInterval(() => setSecs((Date.now() - start.current) / 1000), 200);
    } catch {
      alert("Microphone access is needed to record voice notes.");
    }
  };

  const stop = (discard: boolean) => {
    cancel.current = discard;
    clearInterval(timer.current);
    mr.current?.stop();
    mr.current = null;
    setRec(false);
  };

  if (!rec)
    return (
      <button onClick={begin} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground" aria-label="Record voice note">
        <Mic className="h-5 w-5" />
      </button>
    );

  return (
    <div className="flex flex-1 items-center gap-3">
      <button onClick={() => stop(true)} className="p-2 text-muted-foreground hover:text-destructive" aria-label="Discard">
        <Trash2 className="h-5 w-5" />
      </button>
      <div className="flex flex-1 items-center gap-2 rounded-full bg-card px-4 py-2.5">
        <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-destructive" />
        <span className="text-sm tabular-nums">{fmtDur(secs)}</span>
        <div className="ml-2 h-1 flex-1 overflow-hidden rounded bg-muted">
          <div className="h-full bg-primary transition-all" style={{ width: `${Math.min(100, (secs / 120) * 100)}%` }} />
        </div>
      </div>
      <button onClick={() => stop(false)} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground" aria-label="Send voice note">
        <Send className="h-5 w-5" />
      </button>
    </div>
  );
}
