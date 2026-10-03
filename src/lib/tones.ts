let ctx: AudioContext | null = null;
const ac = () => (ctx ??= new (window.AudioContext || (window as any).webkitAudioContext)());

function beep(freq: number, dur: number, at = 0, vol = 0.12) {
  const c = ac();
  if (c.state === "suspended") void c.resume();
  const o = c.createOscillator();
  const g = c.createGain();
  o.frequency.value = freq;
  o.type = "sine";
  g.gain.setValueAtTime(0, c.currentTime + at);
  g.gain.linearRampToValueAtTime(vol, c.currentTime + at + 0.02);
  g.gain.linearRampToValueAtTime(0, c.currentTime + at + dur);
  o.connect(g).connect(c.destination);
  o.start(c.currentTime + at);
  o.stop(c.currentTime + at + dur + 0.05);
}

export function messageTone() {
  try { beep(880, 0.12); beep(1320, 0.14, 0.12); } catch {}
}

let ringTimer: number | null = null;
export function startRing(outgoing = false) {
  stopRing();
  const ring = () => {
    try {
      if (outgoing) beep(440, 1.2, 0, 0.06);
      else { beep(660, 0.3); beep(880, 0.3, 0.35); beep(660, 0.3, 0.7); }
    } catch {}
  };
  ring();
  ringTimer = window.setInterval(ring, outgoing ? 3000 : 2200);
}
export function stopRing() {
  if (ringTimer) clearInterval(ringTimer);
  ringTimer = null;
}

const NOTIFICATIONS_OFF_KEY = "notifications-off";

/** True when the browser allows notifications and the user hasn't switched them off in the app. */
export function notificationsEnabled() {
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return false;
  try { return localStorage.getItem(NOTIFICATIONS_OFF_KEY) !== "1"; } catch { return true; }
}

/** True when the user switched alerts off in the app (mutes popups and message sounds). */
export function alertsMuted() {
  try { return localStorage.getItem(NOTIFICATIONS_OFF_KEY) === "1"; } catch { return false; }
}

export function setNotificationsOff(off: boolean) {
  try {
    if (off) localStorage.setItem(NOTIFICATIONS_OFF_KEY, "1");
    else localStorage.removeItem(NOTIFICATIONS_OFF_KEY);
  } catch {}
}

/** (Re-)registers the service worker that shows notifications and focuses the app when one is clicked. */
export async function registerNotificationWorker() {
  if (!("serviceWorker" in navigator)) return;
  try {
    await navigator.serviceWorker.register("/notification-sw.js");
    await navigator.serviceWorker.ready;
  } catch (error) {
    console.error("Could not register the notification service worker:", error);
  }
}

/** Shows a system notification. `tag` groups notifications per chat; each new one still pops up. */
export async function notify(title: string, body: string, tag?: string): Promise<boolean> {
  if (!notificationsEnabled()) return false;
  const options: NotificationOptions & { renotify?: boolean } = { body, icon: "/icon-192.png", badge: "/icon-192.png" };
  if (tag) {
    options.tag = tag;
    options.renotify = true;
  }

  try {
    const registration = "serviceWorker" in navigator
      ? await navigator.serviceWorker.getRegistration("/")
      : undefined;
    if (registration) {
      await registration.showNotification(title, options);
      return true;
    }
  } catch (error) {
    console.error("Could not show a service worker notification:", error);
  }

  try {
    new Notification(title, options);
    return true;
  } catch (error) {
    console.error("Could not show a browser notification:", error);
    return false;
  }
}
