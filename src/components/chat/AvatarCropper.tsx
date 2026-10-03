import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

const VIEW = 260;

/** Lets the user drag and zoom a photo inside a circle, then returns a square JPEG data URL. */
export function AvatarCropper({ file, onCancel, onDone }: { file: File | null; onCancel: () => void; onDone: (dataUrl: string) => void }) {
  const [src, setSrc] = useState<string | null>(null);
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; px: number; py: number } | null>(null);

  useEffect(() => {
    if (!file) return;
    const url = URL.createObjectURL(file);
    setSrc(url); setZoom(1); setPos({ x: 0, y: 0 }); setImg(null);
    const i = new Image();
    i.onload = () => setImg(i);
    i.src = url;
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const base = img ? VIEW / Math.min(img.width, img.height) : 1;
  const scale = base * zoom;
  const w = img ? img.width * scale : VIEW;
  const h = img ? img.height * scale : VIEW;
  const clamp = (p: { x: number; y: number }, ww = w, hh = h) => ({
    x: Math.min(0, Math.max(VIEW - ww, p.x)),
    y: Math.min(0, Math.max(VIEW - hh, p.y)),
  });

  useEffect(() => {
    if (img) setPos({ x: (VIEW - img.width * base) / 2, y: (VIEW - img.height * base) / 2 });
  }, [img, base]);

  const changeZoom = (z: number) => {
    if (!img) return;
    const nw = img.width * base * z, nh = img.height * base * z;
    const cx = VIEW / 2, cy = VIEW / 2;
    const r = nw / w;
    setZoom(z);
    setPos(clamp({ x: cx - (cx - pos.x) * r, y: cy - (cy - pos.y) * r }, nw, nh));
  };

  const save = () => {
    if (!img) return;
    const out = 256, c = document.createElement("canvas");
    c.width = c.height = out;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(img, -pos.x / scale, -pos.y / scale, VIEW / scale, VIEW / scale, 0, 0, out, out);
    onDone(c.toDataURL("image/jpeg", 0.85));
  };

  return (
    <Dialog open={!!file} onOpenChange={(o) => !o && onCancel()}>
      <DialogContent className="w-[calc(100%-2rem)] max-w-sm">
        <DialogHeader>
          <DialogTitle>Adjust photo</DialogTitle>
          <DialogDescription>Drag to move, use the slider to zoom.</DialogDescription>
        </DialogHeader>
        <div
          className="relative mx-auto touch-none select-none overflow-hidden rounded-full bg-muted"
          style={{ width: VIEW, height: VIEW, cursor: "grab" }}
          onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); drag.current = { x: e.clientX, y: e.clientY, px: pos.x, py: pos.y }; }}
          onPointerMove={(e) => { const d = drag.current; if (d) setPos(clamp({ x: d.px + e.clientX - d.x, y: d.py + e.clientY - d.y })); }}
          onPointerUp={() => { drag.current = null; }}
        >
          {src && img && (
            <img src={src} alt="" draggable={false} className="pointer-events-none absolute max-w-none" style={{ left: pos.x, top: pos.y, width: w, height: h }} />
          )}
        </div>
        <input type="range" min={1} max={4} step={0.01} value={zoom} onChange={(e) => changeZoom(Number(e.target.value))} aria-label="Zoom" className="w-full accent-primary" />
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onCancel}>Cancel</Button>
          <Button onClick={save} disabled={!img}>Save photo</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
