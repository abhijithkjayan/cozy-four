import { useEffect, useRef, useState } from "react";
import { supabase, wipeLocalCaches } from "@/lib/supabase";

export const IDLE_LIMIT_MS = 5 * 60 * 1000; // auto logout after 5 minutes of no activity
const WARN_MS = 60 * 1000;

// Set paused=true while a call is running so a long call is not cut off.
export const idleState = { paused: false };

export async function secureLogout() {
  wipeLocalCaches();
  try { sessionStorage.clear(); } catch {}
  try { await supabase.auth.signOut(); } catch {}
  try { if ("Notification" in window) (navigator as any).serviceWorker?.getRegistrations?.().then((r: any[]) => r.forEach((x) => x.unregister())); } catch {}
}

/** Logs the user out after 5 min without touching the app. Returns seconds left once the last minute starts. */
export function useIdleLogout() {
  const last = useRef(Date.now());
  const [left, setLeft] = useState<number | null>(null);

  useEffect(() => {
    const mark = () => { last.current = Date.now(); };
    let lastMove = 0;
    const throttled = () => { const n = Date.now(); if (n - lastMove > 1000) { lastMove = n; mark(); } };
    const strong = ["pointerdown", "keydown", "touchstart", "click", "wheel"];
    strong.forEach((e) => window.addEventListener(e, mark, { passive: true }));
    window.addEventListener("pointermove", throttled, { passive: true });
    window.addEventListener("scroll", throttled, { passive: true, capture: true });

    const check = () => {
      if (idleState.paused) { mark(); setLeft(null); return; }
      const idle = Date.now() - last.current;
      if (idle >= IDLE_LIMIT_MS) { secureLogout(); return; }
      setLeft(idle >= IDLE_LIMIT_MS - WARN_MS ? Math.ceil((IDLE_LIMIT_MS - idle) / 1000) : null);
    };
    const t = setInterval(check, 1000);
    // Timers are paused in background tabs, so re-check the moment the user comes back
    const onVis = () => { if (document.visibilityState === "visible") check(); };
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("focus", onVis);
    return () => {
      clearInterval(t);
      strong.forEach((e) => window.removeEventListener(e, mark));
      window.removeEventListener("pointermove", throttled);
      window.removeEventListener("scroll", throttled, true);
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("focus", onVis);
    };
  }, []);

  return { left, stay: () => { last.current = Date.now(); setLeft(null); } };
}

/** Resize + centre-crop a chosen image to a small square JPEG data URL (keeps profile photos tiny). */
export function imageToAvatar(file: File, size = 256): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const s = Math.min(img.width, img.height);
      const c = document.createElement("canvas");
      c.width = c.height = size;
      const ctx = c.getContext("2d");
      if (!ctx) return reject(new Error("canvas"));
      ctx.drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, size, size);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL("image/jpeg", 0.8));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("image")); };
    img.src = url;
  });
}
