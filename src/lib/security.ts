import { useEffect, useRef, useState } from "react";
import { supabase, wipeLocalCaches } from "@/lib/supabase";

export const IDLE_LIMIT_MS = 60 * 1000; // auto logout after 1 minute of no activity
export const IDLE_LOGOUT_DISABLED_KEY = "idle-logout-disabled";
const IDLE_LOGOUT_TAPS_KEY = "idle-logout-taps";
const IDLE_LOGOUT_TAPS_TO_DISABLE = 5;

// Set paused=true while a call is running so a long call is not cut off.
export const idleState = { paused: false };

const GLOBAL_LOGOUT_TOPIC = "app:global-logout";
let globalLogoutChannel: ReturnType<typeof supabase.channel> | null = null;
let globalLogoutReady = false;

export function useGlobalLogout() {
  useEffect(() => {
    const channel = supabase
      .channel(GLOBAL_LOGOUT_TOPIC)
      .on("broadcast", { event: "logout" }, ({ payload }: { payload: { action?: string } }) => {
        if (payload?.action === "manual" && !readIdleLogoutDisabled()) void secureLogout();
      });
    globalLogoutChannel = channel;
    channel.subscribe((status) => {
      if (globalLogoutChannel === channel) globalLogoutReady = status === "SUBSCRIBED";
    });

    return () => {
      if (globalLogoutChannel === channel) {
        globalLogoutChannel = null;
        globalLogoutReady = false;
      }
      void supabase.removeChannel(channel);
    };
  }, []);
}

async function broadcastManualLogout() {
  const channel = globalLogoutReady ? globalLogoutChannel : null;
  if (channel) {
    const result = await Promise.race([
      channel.send({ type: "broadcast", event: "logout", payload: { action: "manual" } }),
      new Promise<"timeout">((resolve) => window.setTimeout(() => resolve("timeout"), 1500)),
    ]);
    if (result === "timeout" || result !== "ok") {
      console.error("Could not broadcast the manual logout to all connected users.");
    }
    return;
  }

  const temporaryChannel = supabase.channel(GLOBAL_LOGOUT_TOPIC);
  let sent = false;
  await Promise.race([
    new Promise<void>((resolve) => {
      temporaryChannel.subscribe((status) => {
        if (status === "SUBSCRIBED" && !sent) {
          sent = true;
          void temporaryChannel
            .send({ type: "broadcast", event: "logout", payload: { action: "manual" } })
            .then((result) => {
              if (result !== "ok") console.error("Could not broadcast the manual logout to all connected users.");
              resolve();
            });
        } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
          resolve();
        }
      });
    }),
    new Promise<void>((resolve) => window.setTimeout(resolve, 1500)),
  ]);
  void supabase.removeChannel(temporaryChannel);
}

export async function secureLogout(broadcastGlobally = false) {
  if (broadcastGlobally) await broadcastManualLogout();
  wipeLocalCaches();
  try { sessionStorage.clear(); } catch {}
  try { await supabase.auth.signOut(); } catch {}
  try { if ("Notification" in window) (navigator as any).serviceWorker?.getRegistrations?.().then((r: any[]) => r.forEach((x) => x.unregister())); } catch {}
}

/** Logs the user out after 1 min without touching the app. Returns the seconds remaining. */
export function useIdleLogout() {
  const last = useRef(Date.now());
  const disabledRef = useRef(readIdleLogoutDisabled());
  const tapCount = useRef(readIdleLogoutTaps());
  const [left, setLeft] = useState(Math.ceil(IDLE_LIMIT_MS / 1000));
  const [disabled, setDisabled] = useState(disabledRef.current);

  useEffect(() => {
    const mark = () => {
      last.current = Date.now();
      setLeft(Math.ceil(IDLE_LIMIT_MS / 1000));
    };
    let lastMove = 0;
    const throttled = () => { const n = Date.now(); if (n - lastMove > 1000) { lastMove = n; mark(); } };
    const strong = ["pointerdown", "keydown", "touchstart", "click", "wheel"];
    strong.forEach((e) => window.addEventListener(e, mark, { passive: true }));
    window.addEventListener("pointermove", throttled, { passive: true });
    window.addEventListener("scroll", throttled, { passive: true, capture: true });

    const check = () => {
      if (disabledRef.current) return;
      if (idleState.paused) { mark(); return; }
      const idle = Date.now() - last.current;
      if (idle >= IDLE_LIMIT_MS) { secureLogout(); return; }
      setLeft(Math.ceil((IDLE_LIMIT_MS - idle) / 1000));
    };
    const t = setInterval(check, 1000);
    // Timers are paused in background tabs, so re-check the moment the user comes back
    // Log out as soon as the tab is hidden/minimised (short grace so the photo picker doesn't trigger it)
    let hiddenAt = 0;
    let hideTimer: number | undefined;
    const onVis = () => {
      if (document.visibilityState === "hidden") {
        if (disabledRef.current || idleState.paused) return;
        hiddenAt = Date.now();
        hideTimer = window.setTimeout(() => { if (document.visibilityState === "hidden" && !idleState.paused && !disabledRef.current) secureLogout(); }, 3000);
      } else {
        clearTimeout(hideTimer);
        if (hiddenAt && Date.now() - hiddenAt > 3000 && !idleState.paused && !disabledRef.current) { secureLogout(); return; }
        hiddenAt = 0;
        check();
      }
    };
    const onHide = () => { if (!idleState.paused && !disabledRef.current) secureLogout(); };
    window.addEventListener("pagehide", onHide);
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("focus", onVis);
    return () => {
      clearInterval(t);
      strong.forEach((e) => window.removeEventListener(e, mark));
      window.removeEventListener("pointermove", throttled);
      window.removeEventListener("scroll", throttled, true);
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("focus", onVis);
      window.removeEventListener("pagehide", onHide);
      clearTimeout(hideTimer);
    };
  }, []);

  const tapCountdown = () => {
    if (disabledRef.current) {
      last.current = Date.now();
      tapCount.current = 0;
      disabledRef.current = false;
      setDisabled(false);
      setLeft(Math.ceil(IDLE_LIMIT_MS / 1000));
      try {
        sessionStorage.removeItem(IDLE_LOGOUT_DISABLED_KEY);
        sessionStorage.removeItem(IDLE_LOGOUT_TAPS_KEY);
      } catch {
        // Keep the enabled state for this mounted session if sessionStorage is unavailable.
      }
      return;
    }
    tapCount.current += 1;
    try {
      sessionStorage.setItem(IDLE_LOGOUT_TAPS_KEY, String(tapCount.current));
    } catch {
      // Keep the tap count for this mounted session if sessionStorage is unavailable.
    }
    if (tapCount.current < IDLE_LOGOUT_TAPS_TO_DISABLE) return;
    disabledRef.current = true;
    setDisabled(true);
    try {
      sessionStorage.setItem(IDLE_LOGOUT_DISABLED_KEY, "1");
    } catch {
      // Keep the disabled state for this mounted session if sessionStorage is unavailable.
    }
  };

  return { left, disabled, tapCountdown };
}

function readIdleLogoutDisabled() {
  try {
    return sessionStorage.getItem(IDLE_LOGOUT_DISABLED_KEY) === "1";
  } catch {
    return false;
  }
}

function readIdleLogoutTaps() {
  try {
    const taps = Number(sessionStorage.getItem(IDLE_LOGOUT_TAPS_KEY) || 0);
    return Number.isFinite(taps) ? Math.min(Math.max(0, taps), IDLE_LOGOUT_TAPS_TO_DISABLE) : 0;
  } catch {
    return 0;
  }
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
