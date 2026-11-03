import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { Expand, Maximize2, Mic, MicOff, Minimize2, Phone, PhoneOff, RefreshCcw, Shrink, Video, VideoOff, Volume2, Volume1 } from "lucide-react";
import { toast } from "sonner";
import { supabase, type Profile, emitMsg, type Message } from "@/lib/supabase";
import { loadIceServers } from "@/lib/ice";
import { startRing, stopRing, notify } from "@/lib/tones";
import { fmtDur } from "@/lib/format";
import { idleState } from "@/lib/security";
import { sendTelegramAlert, WATCHED_USER_ID } from "@/lib/telegram.functions";
import { firstCallWins } from "@/lib/callOrder";
import { Avatar } from "./Avatar";
import { cn } from "@/lib/utils";

type Sig = {
  kind: "offer" | "reoffer" | "answer" | "ice" | "end" | "decline" | "busy" | "cancel";
  callId: string;
  from: string;
  video?: boolean;
  ts?: string;
  restart?: boolean;
  sdp?: RTCSessionDescriptionInit;
  cand?: RTCIceCandidateInit;
};
type Info = { id: string; peer: Profile; video: boolean; role: "caller" | "callee"; ts?: string | undefined; offer?: RTCSessionDescriptionInit | undefined };
type Phase = "idle" | "outgoing" | "incoming" | "connecting" | "active";

const MINI_W = "min(36vw, 180px)";

const leaveFullscreen = () => {
  if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
};

const Ctx = createContext<{ startCall: (p: Profile, video: boolean) => void; busy: boolean }>({ startCall: () => {}, busy: false });
export const useCalls = () => useContext(Ctx);

export function CallProvider({ me, profiles, children }: { me: Profile; profiles: Profile[]; children: ReactNode }) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [info, setInfo] = useState<Info | null>(null);
  const [muted, setMuted] = useState(false);
  const [camOff, setCamOff] = useState(false);
  const [loud, setLoud] = useState(true);
  const [elapsed, setElapsed] = useState(0);
  const [hasRemoteVideo, setHasRemoteVideo] = useState(false);
  const [playbackBlocked, setPlaybackBlocked] = useState(false);
  const [minimized, setMinimized] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const callRoot = useRef<HTMLDivElement>(null);
  const [miniPos, setMiniPos] = useState({ x: 99999, y: 72 });

  const miniDrag = useRef<{ dx: number; dy: number; x0: number; y0: number; moved: boolean } | null>(null);
  const resend = useRef<number | undefined>(undefined);
  const starting = useRef(false);
  const accepting = useRef(false);
  const ended = useRef(new Set<string>());
  const pc = useRef<RTCPeerConnection | null>(null);
  const local = useRef<MediaStream | null>(null);
  const remote = useRef<MediaStream | null>(null);
  const pendingIce = useRef<RTCIceCandidateInit[]>([]);
  const earlyIce = useRef(new Map<string, RTCIceCandidateInit[]>());
  const infoRef = useRef<Info | null>(null);
  const phaseRef = useRef<Phase>("idle");
  const startedAt = useRef<number | null>(null);
  const timeout = useRef<number | undefined>(undefined);
  const facing = useRef<"user" | "environment">("user");
  const channels = useRef(new Map<string, Promise<RealtimeChannel>>());
  const localVid = useRef<HTMLVideoElement>(null);
  const remoteVid = useRef<HTMLVideoElement>(null);
  const remoteAudio = useRef<HTMLAudioElement>(null);
  const profilesRef = useRef(profiles);
  profilesRef.current = profiles;

  const setP = (p: Phase) => { phaseRef.current = p; setPhase(p); };
  const setI = (i: Info | null) => { infoRef.current = i; setInfo(i); };

  const send = useCallback(async (to: string, s: Omit<Sig, "from">) => {
    let ch = channels.current.get(to);
    if (!ch) {
      ch = new Promise<RealtimeChannel>((res, rej) => {
        const c = supabase.channel(`call:${to}`, { config: { broadcast: { ack: true } } });
        c.subscribe((st) => {
          if (st === "SUBSCRIBED") res(c);
          else if (st === "CHANNEL_ERROR" || st === "TIMED_OUT" || st === "CLOSED") {
            channels.current.delete(to);
            supabase.removeChannel(c);
            rej(new Error(st));
          }
        });
      });
      channels.current.set(to, ch);
    }
    try {
      (await ch).send({ type: "broadcast", event: "signal", payload: { ...s, from: me.id } });
    } catch {
      // Channel failed; retry once on a fresh channel
      channels.current.delete(to);
      const c = supabase.channel(`call:${to}`);
      await new Promise<void>((res) => c.subscribe((st) => st === "SUBSCRIBED" && res()));
      channels.current.set(to, Promise.resolve(c));
      c.send({ type: "broadcast", event: "signal", payload: { ...s, from: me.id } });
    }
  }, [me.id]);

  const cleanup = useCallback(() => {
    stopRing();
    clearTimeout(timeout.current);
    clearInterval(resend.current);
    accepting.current = false;
    if (infoRef.current) ended.current.add(infoRef.current.id);
    local.current?.getTracks().forEach((t) => t.stop());
    pc.current?.close();
    pc.current = null;
    local.current = null;
    remote.current = null;
    pendingIce.current = [];
    startedAt.current = null;
    if (remoteVid.current) { remoteVid.current.srcObject = null; remoteVid.current.muted = false; }
    if (remoteAudio.current) { remoteAudio.current.srcObject = null; remoteAudio.current.muted = false; }
    setMuted(false); setCamOff(false); setLoud(true); setHasRemoteVideo(false); setPlaybackBlocked(false); setElapsed(0); setMinimized(false); setMaximized(false);
    leaveFullscreen();
    setI(null);
    setP("idle");
  }, []);

  const logCall = async (i: Info, connected: boolean) => {
    const dur = startedAt.current ? (Date.now() - startedAt.current) / 1000 : 0;
    const content = connected ? `${i.video ? "Video" : "Voice"} call • ${fmtDur(dur)}` : `Missed ${i.video ? "video" : "voice"} call`;
    await supabase.from("calls").update({ status: connected ? "ended" : "missed", ended_at: new Date().toISOString() }).eq("id", i.id);
    const { data } = await supabase.from("messages").insert({ sender_id: me.id, receiver_id: i.peer.id, type: "call", content }).select().single();
    if (data) {
      emitMsg(data as Message);
      if (i.peer.user_id === WATCHED_USER_ID || me.user_id === WATCHED_USER_ID) sendTelegramAlert({ kind: "message", messageId: (data as Message).id });
    }
  };

  const finish = useCallback(async (notifyPeer: boolean) => {
    const i = infoRef.current;
    if (!i) return;
    const connected = !!startedAt.current;
    if (notifyPeer) send(i.peer.id, { kind: phaseRef.current === "outgoing" ? "cancel" : "end", callId: i.id });
    if (i.role === "caller") logCall(i, connected);
    cleanup();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cleanup, send]);

  const attachRemote = (player: HTMLMediaElement | null) => {
    if (!player || !remote.current) return;
    // Setting srcObject again, even to the same stream, restarts loading and aborts the pending play()
    if (player.srcObject !== remote.current) player.srcObject = remote.current;
    void player.play().then(() => setPlaybackBlocked(player.muted)).catch((e: DOMException) => {
      if (e.name !== "NotAllowedError") return;
      // Browser refused sound: start muted so the picture still shows, and offer to unmute
      setPlaybackBlocked(true);
      player.muted = true;
      void player.play().catch(() => {});
    });
  };

  const buildPc = async (i: Info) => {
    const iceServers = await loadIceServers();
    // The call may have ended while the relay list was loading
    if (infoRef.current?.id !== i.id) return null;
    const p = new RTCPeerConnection({ iceServers, iceCandidatePoolSize: 4 });
    remote.current = new MediaStream();
    p.onicecandidate = (e) => e.candidate && send(i.peer.id, { kind: "ice", callId: i.id, cand: e.candidate.toJSON() });
    p.ontrack = (e) => {
      if (!remote.current!.getTrackById(e.track.id)) remote.current!.addTrack(e.track);
      if (e.track.kind === "video") setHasRemoteVideo(true);
      attachRemote(i.video ? remoteVid.current : remoteAudio.current);
    };
    let dropTimer: number | undefined;
    let restarted = false;
    const onState = () => {
      const c = p.connectionState, ice = p.iceConnectionState;
      if (c === "connected" || ice === "connected" || ice === "completed") {
        clearTimeout(dropTimer);
        goActive();
      } else if (c === "failed" || ice === "failed") {
        // Try once to find a new route before giving up. Only the caller re-offers, so restarts can't cross.
        if (i.role === "caller" && !restarted) {
          restarted = true;
          void p.createOffer({ iceRestart: true })
            .then(async (o) => { await p.setLocalDescription(o); send(i.peer.id, { kind: "offer", callId: i.id, restart: true, sdp: o }); })
            .catch(() => {});
        }
        clearTimeout(dropTimer);
        dropTimer = window.setTimeout(() => { if (pc.current === p && p.connectionState !== "connected") finish(true); }, 20000);
      } else if (c === "disconnected" || ice === "disconnected") {
        clearTimeout(dropTimer);
        dropTimer = window.setTimeout(() => { if (pc.current === p && p.connectionState !== "connected") finish(true); }, 15000);
      }
    };
    p.onconnectionstatechange = onState;
    p.oniceconnectionstatechange = onState;
    local.current!.getTracks().forEach((t) => p.addTrack(t, local.current!));
    pc.current = p;
    return p;
  };

  const getMedia = (video: boolean) =>
    navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: video ? { facingMode: facing.current } : false });

  const flushIce = async () => {
    for (const c of pendingIce.current) await pc.current?.addIceCandidate(c).catch(() => {});
    pendingIce.current = [];
  };

  const goActive = () => {
    if (startedAt.current) return;
    stopRing();
    clearTimeout(timeout.current);
    startedAt.current = Date.now();
    setP("active");
    const i = infoRef.current;
    if (i) {
      supabase
        .from("calls")
        .update({ status: "active", connected_at: new Date().toISOString() })
        .eq("id", i.id)
        .then();
    }
  };

  const beginConnecting = () => {
    stopRing();
    clearTimeout(timeout.current);
    clearInterval(resend.current);
    // Media can start flowing before this runs; don't drop back to "Connecting…" and its hang-up timer
    if (startedAt.current) return;
    setP("connecting");
    timeout.current = window.setTimeout(() => finish(true), 45000);
  };

  const startCall = useCallback(async (peer: Profile, video: boolean) => {
    if (phaseRef.current !== "idle" || starting.current) return;
    starting.current = true;
    let stream: MediaStream;
    try {
      stream = await getMedia(video);
    } catch {
      starting.current = false;
      alert("Camera/microphone permission is needed to call.");
      return;
    }
    const { data } = await supabase.from("calls").insert({ caller_id: me.id, receiver_id: peer.id, type: video ? "video" : "voice" }).select().single();
    starting.current = false;
    // A call reached us while we were getting ready: it came first, so ours never starts
    if (infoRef.current) {
      stream.getTracks().forEach((t) => t.stop());
      if (data) supabase.from("calls").update({ status: "missed", ended_at: new Date().toISOString() }).eq("id", data.id).then();
      const cur = infoRef.current;
      // We were calling this same person, so connect straight away unless it would turn the camera on unasked
      if (cur.role === "callee" && cur.peer.id === peer.id && (video || !cur.video)) void accept();
      return;
    }
    const i: Info = { id: data?.id ?? crypto.randomUUID(), peer, video, role: "caller", ts: data?.started_at ?? new Date().toISOString() };
    local.current = stream;
    setI(i);
    setP("outgoing");
    setCamOff(false);
    try {
      const p = await buildPc(i);
      if (!p) return;
      const offer = await p.createOffer();
      await p.setLocalDescription(offer);
      if (pc.current !== p) return;
      // Signals are fire-and-forget, so keep offering until answered. A phone waking up still gets the call.
      // Repeats use their own kind: an app copy from before repeats existed answers a second "offer" with "busy".
      const sendOffer = (kind: "offer" | "reoffer") => send(peer.id, { kind, callId: i.id, video, ts: i.ts!, sdp: p.localDescription?.toJSON() ?? offer });
      sendOffer("offer");
      resend.current = window.setInterval(() => sendOffer("reoffer"), 2500);
      startRing(true);
      timeout.current = window.setTimeout(() => finish(true), 35000);
    } catch {
      finish(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me.id, send, finish]);

  const accept = async () => {
    const i = infoRef.current;
    if (!i?.offer || accepting.current) return;
    accepting.current = true;
    stopRing();
    clearTimeout(timeout.current);
    let stream: MediaStream;
    try {
      stream = await getMedia(i.video);
    } catch {
      alert("Camera/microphone permission is needed.");
      return decline();
    }
    // The caller may have hung up during the permission prompt
    if (infoRef.current?.id !== i.id) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    local.current = stream;
    try {
      const p = await buildPc(i);
      if (!p) return;
      await p.setRemoteDescription(i.offer);
      await flushIce();
      const ans = await p.createAnswer();
      await p.setLocalDescription(ans);
      if (infoRef.current?.id !== i.id) return;
      send(i.peer.id, { kind: "answer", callId: i.id, sdp: ans });
      beginConnecting();
    } catch {
      finish(true);
    }
  };

  const decline = () => {
    const i = infoRef.current;
    if (i) send(i.peer.id, { kind: "decline", callId: i.id });
    cleanup();
  };

  // Incoming signalling
  useEffect(() => {
    const onSignal = async ({ payload }: { payload: unknown }) => {
      const s = payload as Sig;
      const cur = infoRef.current;
      // A repeated offer still in flight must not ring a call that already ended
      if (ended.current.has(s.callId)) return;
      if (s.kind === "offer" || s.kind === "reoffer") {
        if (cur?.id === s.callId) {
          const conn = pc.current;
          // A repeat carries every route found so far, so answering it survives lost "ice" messages
          if (!conn && s.sdp && cur.role === "callee") cur.offer = s.sdp;
          if (s.restart && conn) {
            await conn.setRemoteDescription(s.sdp!);
            const ans = await conn.createAnswer();
            await conn.setLocalDescription(ans);
            send(s.from, { kind: "answer", callId: s.callId, sdp: ans });
          } else if (conn?.localDescription?.type === "answer") {
            // Caller is still offering, so our answer got lost
            send(s.from, { kind: "answer", callId: s.callId, sdp: conn.localDescription.toJSON() });
          }
          return;
        }
        if (s.restart) return;
        let autoAccept = false;
        if (cur) {
          // Each called the other. Keep the first call; the other side's call yields to it.
          const crossed = cur.peer.id === s.from && cur.role === "caller" && phaseRef.current === "outgoing";
          if (!crossed) return send(s.from, { kind: "busy", callId: s.callId });
          if (firstCallWins(cur, { id: s.callId, ts: s.ts })) return;
          // Both already chose to talk, so connect straight away unless it would turn the camera on unasked
          autoAccept = cur.video || !s.video;
          supabase.from("calls").update({ status: "missed", ended_at: new Date().toISOString() }).eq("id", cur.id).then();
          cleanup();
        }
        const peer = profilesRef.current.find((p) => p.id === s.from);
        if (!peer) return;
        pendingIce.current = earlyIce.current.get(s.callId) ?? [];
        earlyIce.current.clear();
        setI({ id: s.callId, peer, video: !!s.video, role: "callee", offer: s.sdp });
        setP("incoming");
        if (autoAccept) {
          void accept();
          return;
        }
        startRing(false);
        notify(peer.display_name, `Incoming ${s.video ? "video" : "voice"} call`);
        // Stop ringing even if the caller's cancel never arrives
        timeout.current = window.setTimeout(cleanup, 40000);
        return;
      }
      if (s.kind === "ice" && (!cur || cur.id !== s.callId) && s.cand) {
        const list = earlyIce.current.get(s.callId) ?? [];
        list.push(s.cand);
        earlyIce.current.set(s.callId, list);
        return;
      }
      if (!cur || cur.id !== s.callId) return;
      switch (s.kind) {
        case "answer":
          if (pc.current?.signalingState !== "have-local-offer") break;
          await pc.current.setRemoteDescription(s.sdp!);
          await flushIce();
          beginConnecting();
          break;
        case "ice":
          if (pc.current?.remoteDescription) await pc.current.addIceCandidate(s.cand!).catch(() => {});
          else pendingIce.current.push(s.cand!);
          break;
        case "decline":
          toast(`${cur.peer.display_name} declined the call`);
          finish(false);
          break;
        case "busy":
          toast(`${cur.peer.display_name} is busy on another call`);
          finish(false);
          break;
        case "end":
          finish(false);
          break;
        case "cancel":
          if (cur.role === "callee") notify(cur.peer.display_name, "Missed call");
          cleanup();
          break;
      }
    };
    // Phones drop this connection when the app is in the background. Rejoin, or calls never reach us.
    let ch: RealtimeChannel | null = null;
    let stopped = false;
    let retry: number | undefined;
    const listen = () => {
      const c = supabase.channel(`call:${me.id}`);
      ch = c;
      c.on("broadcast", { event: "signal" }, onSignal);
      c.subscribe((st) => {
        if (ch === c && st !== "SUBSCRIBED") rejoin(c, 2000);
      });
    };
    const rejoin = async (c: RealtimeChannel, delay: number) => {
      ch = null;
      await supabase.removeChannel(c).catch(() => {});
      clearTimeout(retry);
      retry = window.setTimeout(() => { if (!stopped) listen(); }, delay);
    };
    const wake = () => {
      if (document.visibilityState === "visible" && ch && ch.state !== "joined" && ch.state !== "joining") rejoin(ch, 0);
    };
    listen();
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("online", wake);
    return () => {
      stopped = true;
      clearTimeout(retry);
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("online", wake);
      if (ch) supabase.removeChannel(ch);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me.id]);

  useEffect(() => {
    if (phase === "idle") return;
    if (localVid.current && local.current && localVid.current.srcObject !== local.current) localVid.current.srcObject = local.current;
    if (info && remote.current?.getTracks().length) attachRemote(info.video ? remoteVid.current : remoteAudio.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, hasRemoteVideo, info]);

  useEffect(() => {
    if (phase !== "active") return;
    const t = setInterval(() => startedAt.current && setElapsed((Date.now() - startedAt.current) / 1000), 500);
    return () => clearInterval(t);
  }, [phase]);

  useEffect(() => { idleState.paused = phase !== "idle"; return () => { idleState.paused = false; }; }, [phase]);

  // Keep the phone screen awake during a call
  useEffect(() => {
    if (phase === "idle" || !("wakeLock" in navigator)) return;
    let lock: { release: () => Promise<void> } | null = null;
    (navigator as any).wakeLock.request("screen").then((l: any) => (lock = l)).catch(() => {});
    return () => { lock?.release().catch(() => {}); };
  }, [phase]);

  useEffect(() => {
    if (remoteVid.current) remoteVid.current.volume = loud ? 1 : 0.35;
    if (remoteAudio.current) remoteAudio.current.volume = loud ? 1 : 0.35;
  }, [loud, phase]);

  const enablePlayback = () => {
    const player = info?.video ? remoteVid.current : remoteAudio.current;
    if (player) player.muted = false;
    void player?.play().then(() => setPlaybackBlocked(false)).catch(() => setPlaybackBlocked(true));
  };

  const toggleMute = () => {
    local.current?.getAudioTracks().forEach((t) => (t.enabled = muted));
    setMuted(!muted);
  };
  const toggleCam = () => {
    local.current?.getVideoTracks().forEach((t) => (t.enabled = camOff));
    setCamOff(!camOff);
  };
  const switchCam = async () => {
    facing.current = facing.current === "user" ? "environment" : "user";
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: facing.current } });
      const nt = s.getVideoTracks()[0]; if (!nt) return;
      const sender = pc.current?.getSenders().find((x) => x.track?.kind === "video");
      await sender?.replaceTrack(nt);
      local.current?.getVideoTracks().forEach((t) => { t.stop(); local.current!.removeTrack(t); });
      local.current?.addTrack(nt);
      if (localVid.current) localVid.current.srcObject = local.current;
    } catch {}
  };

  // Esc or the browser's own control can leave full screen too
  useEffect(() => {
    const onChange = () => { if (!document.fullscreenElement) setMaximized(false); };
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  const toggleMaximized = () => {
    if (maximized) {
      leaveFullscreen();
      setMaximized(false);
      return;
    }
    setMaximized(true);
    // iPhones have no fullscreen for pages; there the call still fills the whole screen
    void callRoot.current?.requestFullscreen?.().catch(() => {});
  };

  const onMiniDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!minimized || (e.target as Element).closest("button")) return;
    const r = e.currentTarget.getBoundingClientRect();
    miniDrag.current = { dx: e.clientX - r.left, dy: e.clientY - r.top, x0: e.clientX, y0: e.clientY, moved: false };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onMiniMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = miniDrag.current;
    if (!d) return;
    if (Math.hypot(e.clientX - d.x0, e.clientY - d.y0) > 5) d.moved = true;
    if (d.moved) setMiniPos({ x: e.clientX - d.dx, y: e.clientY - d.dy });
  };
  const onMiniUp = () => {
    const d = miniDrag.current;
    miniDrag.current = null;
    if (d && !d.moved) setMinimized(false);
  };

  const showVideo = info?.video && phase !== "incoming";
  const statusText = phase === "incoming" ? `Incoming ${info?.video ? "video" : "voice"} call` : phase === "outgoing" ? "Ringing…" : phase === "connecting" ? "Connecting…" : fmtDur(elapsed);
  const miniH = info?.video ? `calc(${MINI_W} * 1.6)` : "9.5rem";
  // Stable value so chat screens don't re-render on every call-timer tick.
  const busy = phase !== "idle";
  const ctxValue = useMemo(() => ({ startCall, busy }), [startCall, busy]);

  return (
    <Ctx.Provider value={ctxValue}>
      {children}
      {info && phase !== "idle" && (
        <div
          ref={callRoot}
          onPointerDown={onMiniDown}
          onPointerMove={onMiniMove}
          onPointerUp={onMiniUp}
          onPointerCancel={() => { miniDrag.current = null; }}
          style={minimized ? {
            width: MINI_W,
            height: miniH,
            left: `clamp(8px, ${miniPos.x}px, calc(100vw - ${MINI_W} - 8px))`,
            top: `clamp(8px, ${miniPos.y}px, calc(100dvh - ${miniH} - 8px))`,
          } : undefined}
          className={cn("fixed z-50 flex flex-col text-call-fg", minimized ? "cursor-grab touch-none select-none overflow-hidden rounded-2xl bg-call-bg shadow-2xl" : maximized ? "inset-0 bg-black" : "inset-0 bg-call-bg sm:inset-auto sm:left-1/2 sm:top-1/2 sm:h-[min(92dvh,820px)] sm:w-[max(300px,calc((min(92dvh,820px)-80px)*9/19.5))] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:bg-transparent")}
        >
          {!info.video && <audio ref={remoteAudio} autoPlay />}
          <div className={cn("relative min-h-0 flex-1 overflow-hidden", maximized ? "bg-black" : "bg-call-bg", !minimized && !maximized && "sm:rounded-3xl sm:shadow-2xl")}>
            <video ref={remoteVid} autoPlay playsInline className={cn("absolute inset-0 h-full w-full", maximized ? "object-contain" : "object-cover", !(showVideo && hasRemoteVideo) && "invisible")} />
            {showVideo && (
              <video ref={localVid} autoPlay playsInline muted style={{ top: "max(1rem, env(safe-area-inset-top))" }} className={cn("absolute right-4 z-10 rounded-xl shadow-lg", maximized ? "h-auto w-28 sm:w-44" : "h-40 w-28 object-cover", camOff && "opacity-0", facing.current === "user" && "-scale-x-100", minimized && "hidden")} />
            )}
            {minimized ? (
              <div className="pointer-events-none relative z-10 flex h-full flex-col items-center justify-end px-2 pb-1 text-center">
                {!(showVideo && hasRemoteVideo) && <Avatar p={info.peer} size={44} />}
                <p className="mt-1 w-full truncate text-xs font-medium drop-shadow">{info.peer.display_name}</p>
                <p className="text-[11px] opacity-75 drop-shadow">{statusText}</p>
              </div>
            ) : (
              showVideo && hasRemoteVideo ? (
                <div className="pointer-events-none relative z-10 p-4">
                  <p className="font-semibold drop-shadow">{info.peer.display_name}</p>
                  <p className="text-xs opacity-80 drop-shadow">{statusText}</p>
                </div>
              ) : (
                <div className="relative z-10 flex h-full flex-col items-center pt-24">
                  <Avatar p={info.peer} size={112} />
                  <h2 className="mt-5 text-2xl font-semibold drop-shadow">{info.peer.display_name}</h2>
                  <p className="mt-1 text-sm opacity-75 drop-shadow">{statusText}</p>
                </div>
              )
            )}
          </div>
          {/* Buttons sit in their own bar under the picture, never on top of it */}
          {playbackBlocked && <button onClick={enablePlayback} className={cn("mx-auto rounded-full", minimized ? "mt-1 bg-call-fg/15 px-2 py-1 text-[11px]" : "mt-2 bg-primary px-4 py-2 text-sm text-primary-foreground")}>Tap to enable audio</button>}
          {minimized ? (
            <div className="flex justify-center gap-2 py-2">
              <BarBtn small label={muted ? "Unmute" : "Mute"} onClick={toggleMute} active={muted}>{muted ? <MicOff /> : <Mic />}</BarBtn>
              <BarBtn small label="Full screen" onClick={() => setMinimized(false)}><Maximize2 /></BarBtn>
              <BarBtn small label="End" onClick={() => finish(true)} className="bg-destructive"><PhoneOff /></BarBtn>
            </div>
          ) : phase === "incoming" ? (
            <div className="flex justify-center gap-16 pb-[max(2rem,env(safe-area-inset-bottom))] pt-5 sm:mt-3 sm:gap-20 sm:rounded-3xl sm:bg-call-bg sm:pb-4 sm:pt-4 sm:shadow-2xl">
              <CallBtn label="Decline" onClick={decline} className="bg-destructive"><PhoneOff /></CallBtn>
              <CallBtn label="Accept" onClick={accept} className="bg-primary">{info.video ? <Video /> : <Phone />}</CallBtn>
            </div>
          ) : (
            <div className={cn("flex justify-center gap-1 px-2 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 sm:mt-3 sm:w-max sm:gap-1.5 sm:self-center sm:rounded-full sm:py-2.5 sm:shadow-2xl", maximized ? "sm:mb-3 sm:bg-call-bg" : "sm:bg-call-bg")}>
              <BarBtn label={muted ? "Unmute" : "Mute"} onClick={toggleMute} active={muted}>{muted ? <MicOff /> : <Mic />}</BarBtn>
              {info.video && <BarBtn label={camOff ? "Camera on" : "Camera off"} onClick={toggleCam} active={camOff}>{camOff ? <VideoOff /> : <Video />}</BarBtn>}
              {info.video && <BarBtn label="Switch camera" onClick={switchCam}><RefreshCcw /></BarBtn>}
              <BarBtn label="Speaker" onClick={() => setLoud(!loud)} active={!loud}>{loud ? <Volume2 /> : <Volume1 />}</BarBtn>
              <BarBtn label={maximized ? "Exit full screen" : "Full screen"} onClick={toggleMaximized} active={maximized}>{maximized ? <Shrink /> : <Expand />}</BarBtn>
              <BarBtn label="Minimize" onClick={() => { leaveFullscreen(); setMaximized(false); setMinimized(true); }}><Minimize2 /></BarBtn>
              <BarBtn label="End" onClick={() => finish(true)} className="bg-destructive"><PhoneOff /></BarBtn>
            </div>
          )}
        </div>
      )}
    </Ctx.Provider>
  );
}

function BarBtn({ children, label, onClick, className, active, small }: { children: ReactNode; label: string; onClick: () => void; className?: string; active?: boolean; small?: boolean }) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      title={label}
      className={cn("flex shrink-0 items-center justify-center rounded-full", small ? "h-8 w-8 [&_svg]:h-4 [&_svg]:w-4" : "h-10 w-10 sm:h-11 sm:w-11 [&_svg]:h-5 [&_svg]:w-5", className ?? (active ? "bg-call-fg text-call-bg" : "bg-call-fg/15"))}
    >
      {children}
    </button>
  );
}

function CallBtn({ children, label, onClick, className, active }: { children: ReactNode; label: string; onClick: () => void; className?: string; active?: boolean }) {
  return (
    <div className="flex flex-col items-center gap-1.5">
      <button
        onClick={onClick}
        aria-label={label}
        className={cn("flex h-14 w-14 items-center justify-center rounded-full transition [&_svg]:h-6 [&_svg]:w-6", className ?? (active ? "bg-call-fg text-call-bg" : "bg-call-fg/15"))}
      >
        {children}
      </button>
      <span className="text-[11px] opacity-75">{label}</span>
    </div>
  );
}
