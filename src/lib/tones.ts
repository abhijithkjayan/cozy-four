let ctx: AudioContext | null = null;
const ac = () => (ctx ??= new (window.AudioContext || (window as any).webkitAudioContext)());

function beep(freq: number, dur: number, at = 0, vol = 0.12) {
  const c = ac();
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

export function notify(title: string, body: string) {
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  if (document.visibilityState === "visible" && document.hasFocus()) return;
  try { new Notification(title, { body, icon: "/icon.svg" }); } catch {}
}
