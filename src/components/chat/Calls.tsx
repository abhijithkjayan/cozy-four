import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { Expand, Maximize2, Mic, MicOff, Minimize2, Phone, PhoneOff, RefreshCcw, Shrink, Video, VideoOff, Volume2, Volume1 } from "lucide-react";
import { toast } from "sonner";
import { supabase, type Profile, emitMsg, type Message } from "@/lib/supabase";
import { ICE_SERVERS, loadIceConfig, warmIceConfig } from "@/lib/ice";
import { startRing, stopRing, notify, primeAudio } from "@/lib/tones";
import { fmtDur } from "@/lib/format";
import { beforeLogout, idleState } from "@/lib/security";
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

// Without a size the browser picks 640x480, which looks soft when the call fills a phone screen.
const cameraConstraints = (facingMode: "user" | "environment"): MediaTrackConstraints => ({
  facingMode,
  width: { ideal: 1280 },
  height: { ideal: 720 },
  frameRate: { ideal: 30, max: 30 },
});

// Browsers start video calls at a low bitrate. Allow up to 2.5 Mbps; WebRTC still lowers it
// by itself on a weak connection, dropping the frame rate before the sharpness.
async function raiseVideoBitrate(sender: RTCRtpSender) {
  try {
    const params = sender.getParameters() as RTCRtpSendParameters & { degradationPreference?: string };
    if (!params.encodings?.length) params.encodings = [{}];
    for (const encoding of params.encodings) encoding.maxBitrate = 2_500_000;
    params.degradationPreference = "maintain-resolution";
    await sender.setParameters(params);
  } catch (error) {
    console.warn("[call] could not raise the video bitrate:", error);
  }
}

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
  // A wide picture (other phone held sideways, or a laptop) is shown whole instead of cropped and stretched.
  const [remoteLandscape, setRemoteLandscape] = useState(false);
  const [playbackBlocked, setPlaybackBlocked] = useState(false);
  // The connection dropped mid-call and is being looked for again.
  const [reconnecting, setReconnecting] = useState(false);
  const [minimized, setMinimized] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const [controlsShown, setControlsShown] = useState(true);
  const controlsTimer = useRef<number | undefined>(undefined);
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
  const [mirrored, setMirrored] = useState(true);
  const channels = useRef(new Map<string, RealtimeChannel>());
  const relayAvailable = useRef(false);
  const restartSdp = useRef<string | null>(null);
  const localVid = useRef<HTMLVideoElement>(null);
  const remoteVid = useRef<HTMLVideoElement>(null);
  const remoteAudio = useRef<HTMLAudioElement>(null);
  const profilesRef = useRef(profiles);
  profilesRef.current = profiles;

  const setP = (p: Phase) => { phaseRef.current = p; setPhase(p); };
  const setI = (i: Info | null) => { infoRef.current = i; setInfo(i); };

  // One lasting channel per person we signal. It is never removed while signed in: the realtime
  // client rejoins it by itself after a network drop, and send() goes over HTTP while it is not
  // joined. (Removing it from its own status callback re-entered itself, and a new send could be
  // handed the old channel, whose subscribe() never reports back: signals then stopped for good.)
  const outChannel = useCallback((to: string) => {
    let c = channels.current.get(to);
    if (!c) {
      c = supabase.channel(`call:${to}`, { config: { broadcast: { ack: true } } });
      c.subscribe();
      channels.current.set(to, c);
    }
    return c;
  }, []);

  // Delivers one signal. Returns false when it could not be handed to the server.
  // A signal may arrive twice (socket and HTTP); every kind is safe to receive twice.
  const send = useCallback(async (to: string, s: Omit<Sig, "from">): Promise<boolean> => {
    const payload = { ...s, from: me.id };
    const c = outChannel(to);
    try {
      // Joined: over the socket, confirmed by the server. Not joined: the library posts it over HTTP.
      if ((await c.send({ type: "broadcast", event: "signal", payload }, { timeout: 4000 })) === "ok") return true;
    } catch {
      // fall through to HTTP
    }
    try {
      // The socket looked open but did not answer (a phone that just woke up): post over HTTP.
      await c.httpSend("signal", payload, { timeout: 4000 });
      return true;
    } catch (error) {
      console.warn(`[call] could not deliver the "${s.kind}" signal:`, error);
      return false;
    }
  }, [me.id, outChannel]);

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
    restartSdp.current = null;
    facing.current = "user";
    startedAt.current = null;
    if (remoteVid.current) { remoteVid.current.srcObject = null; remoteVid.current.muted = false; }
    if (remoteAudio.current) { remoteAudio.current.srcObject = null; remoteAudio.current.muted = false; }
    setMuted(false); setCamOff(false); setLoud(true); setHasRemoteVideo(false); setRemoteLandscape(false); setReconnecting(false); setPlaybackBlocked(false); setElapsed(0); setMinimized(false); setMaximized(false); setMirrored(true);
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

  const failNotice = () => {
    toast.error(
      relayAvailable.current
        ? "Call could not connect. Check the internet connection on both phones and try again."
        : "Call could not connect. No relay server is set up, so calls over mobile data or strict Wi-Fi fail.",
    );
  };

  // Ends a call that lost or never found its connection, and says why.
  const giveUp = () => {
    if (!infoRef.current) return;
    if (startedAt.current) toast.error("Call ended: the connection was lost.");
    else failNotice();
    void finish(true);
  };

  // Records how the call connected (direct or through the relay): the first thing to check when calls fail.
  const logRoute = async (p: RTCPeerConnection) => {
    try {
      const stats = await p.getStats();
      stats.forEach((report) => {
        if (report.type !== "candidate-pair" || report.state !== "succeeded" || !report.nominated) return;
        const localType = stats.get(report.localCandidateId)?.candidateType;
        const remoteType = stats.get(report.remoteCandidateId)?.candidateType;
        const relayed = localType === "relay" || remoteType === "relay";
        console.info(`[call] connected: local ${localType}, remote ${remoteType} (${relayed ? "through the relay" : "direct"})`);
      });
    } catch {
      // diagnostics only
    }
  };

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
    const ice = await loadIceConfig();
    // The call may have ended while the relay list was loading
    if (infoRef.current?.id !== i.id) return null;
    relayAvailable.current = ice.relay;
    let p: RTCPeerConnection;
    try {
      p = new RTCPeerConnection({ iceServers: ice.servers, iceCandidatePoolSize: 4 });
    } catch (error) {
      // A bad relay address must not stop every call: fall back to direct connections.
      console.error("[call] the browser rejected the relay configuration:", error);
      relayAvailable.current = false;
      p = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    }
    remote.current = new MediaStream();
    p.onicecandidate = (e) => {
      if (e.candidate) void send(i.peer.id, { kind: "ice", callId: i.id, cand: e.candidate.toJSON() });
    };
    p.ontrack = (e) => {
      // Use the browser's own stream when it gives one: Safari does not show a track that is
      // added later to a stream it is already playing.
      const stream = e.streams[0];
      if (stream) remote.current = stream;
      else if (!remote.current!.getTrackById(e.track.id)) remote.current!.addTrack(e.track);
      if (e.track.kind === "video") setHasRemoteVideo(true);
      attachRemote(i.video ? remoteVid.current : remoteAudio.current);
    };
    let dropTimer: number | undefined;
    let restarts = 0;
    const giveUpIfDown = (ms: number) => {
      clearTimeout(dropTimer);
      dropTimer = window.setTimeout(() => {
        if (pc.current === p && p.connectionState !== "connected") giveUp();
      }, ms);
    };
    // Look for a new route. Only the caller re-offers, so two restarts can never cross.
    const restart = () => {
      if (i.role !== "caller" || restarts >= 3 || pc.current !== p || p.signalingState !== "stable") return;
      restarts++;
      void p
        .createOffer({ iceRestart: true })
        .then(async (o) => {
          await p.setLocalDescription(o);
          const sendRestart = () => void send(i.peer.id, { kind: "offer", callId: i.id, restart: true, sdp: p.localDescription?.toJSON() ?? o });
          sendRestart();
          // Repeat until answered, like the first offer. The "answer" handler stops it.
          clearInterval(resend.current);
          resend.current = window.setInterval(() => {
            if (pc.current === p && p.signalingState === "have-local-offer") sendRestart();
            else clearInterval(resend.current);
          }, 2500);
        })
        .catch((error) => console.warn("[call] could not restart the connection:", error));
    };
    const onState = () => {
      const c = p.connectionState, iceState = p.iceConnectionState;
      if (c === "connected" || iceState === "connected" || iceState === "completed") {
        clearTimeout(dropTimer);
        setReconnecting(false);
        goActive();
        void logRoute(p);
      } else if (c === "failed" || iceState === "failed") {
        if (startedAt.current) setReconnecting(true);
        restart();
        giveUpIfDown(20000);
      } else if (c === "disconnected" || iceState === "disconnected") {
        if (startedAt.current) setReconnecting(true);
        // Often a change of network (Wi-Fi to mobile data): try a new route after a short wait.
        window.setTimeout(() => {
          if (pc.current === p && p.iceConnectionState === "disconnected") restart();
          // Short mobile hiccups recover by themselves; searching for a new route too early adds a gap.
        }, 6000);
        giveUpIfDown(20000);
      }
    };
    p.onconnectionstatechange = onState;
    p.oniceconnectionstatechange = onState;
    local.current!.getTracks().forEach((t) => {
      // Tells the encoder this is a live camera, so it keeps the picture smooth rather than blocky.
      if (t.kind === "video" && "contentHint" in t) t.contentHint = "motion";
      // Voice: the encoder favours keeping speech clear over music-like quality.
      if (t.kind === "audio" && "contentHint" in t) t.contentHint = "speech";
      const sender = p.addTrack(t, local.current!);
      if (t.kind === "video") void raiseVideoBitrate(sender);
    });
    pc.current = p;
    return p;
  };

  const getMedia = (video: boolean) =>
    navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: video ? cameraConstraints(facing.current) : false });

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
    // Some browsers only accept the bitrate once the call is connected.
    const videoSender = pc.current?.getSenders().find((x) => x.track?.kind === "video");
    if (videoSender) void raiseVideoBitrate(videoSender);
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
    timeout.current = window.setTimeout(giveUp, 45000);
  };

  const startCall = useCallback(async (peer: Profile, video: boolean) => {
    if (phaseRef.current !== "idle" || starting.current) return;
    starting.current = true;
    // The permission prompt can cover the page for a while; that must not count as leaving the app.
    idleState.paused = true;
    let stream: MediaStream;
    try {
      stream = await getMedia(video);
    } catch {
      starting.current = false;
      idleState.paused = phaseRef.current !== "idle";
      toast.error(video ? "Allow the camera and microphone to make a video call." : "Allow the microphone to make a call.");
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
    startRing(true);
    // Set before the connection is prepared, so a call that cannot even be set up still ends by itself.
    timeout.current = window.setTimeout(() => {
      if (phaseRef.current === "outgoing") toast(`${peer.display_name} did not answer`);
      void finish(true);
    }, 35000);
    try {
      const p = await buildPc(i);
      if (!p) return;
      const offer = await p.createOffer();
      await p.setLocalDescription(offer);
      if (pc.current !== p) return;
      // Signals are fire-and-forget, so keep offering until answered. A phone waking up still gets the call.
      // Repeats use their own kind: an app copy from before repeats existed answers a second "offer" with "busy".
      const sendOffer = (kind: "offer" | "reoffer") => void send(peer.id, { kind, callId: i.id, video, ts: i.ts!, sdp: p.localDescription?.toJSON() ?? offer });
      sendOffer("offer");
      resend.current = window.setInterval(() => sendOffer("reoffer"), 2500);
    } catch (error) {
      console.error("[call] could not start the call:", error);
      toast.error("Could not start the call. Please try again.");
      void finish(true);
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
      toast.error(i.video ? "Allow the camera and microphone to answer." : "Allow the microphone to answer.");
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
      void send(i.peer.id, { kind: "answer", callId: i.id, sdp: p.localDescription?.toJSON() ?? ans });
      beginConnecting();
    } catch (error) {
      console.error("[call] could not answer the call:", error);
      toast.error("Could not answer the call.");
      void finish(true);
    }
  };

  const decline = () => {
    const i = infoRef.current;
    if (i) send(i.peer.id, { kind: "decline", callId: i.id });
    cleanup();
  };

  // Incoming signalling
  useEffect(() => {
    const handleSignal = async ({ payload }: { payload: unknown }) => {
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
            // A repeat of a restart we already answered: just answer again.
            if (restartSdp.current === s.sdp?.sdp && conn.signalingState === "stable" && conn.localDescription?.type === "answer") {
              void send(s.from, { kind: "answer", callId: s.callId, sdp: conn.localDescription.toJSON() });
              return;
            }
            restartSdp.current = s.sdp?.sdp ?? null;
            await conn.setRemoteDescription(s.sdp!);
            const ans = await conn.createAnswer();
            await conn.setLocalDescription(ans);
            void send(s.from, { kind: "answer", callId: s.callId, sdp: conn.localDescription?.toJSON() ?? ans });
          } else if (conn?.localDescription?.type === "answer") {
            // Caller is still offering, so our answer got lost
            send(s.from, { kind: "answer", callId: s.callId, sdp: conn.localDescription.toJSON() });
          }
          return;
        }
        if (s.restart) return;
        let autoAccept = false;
        if (cur) {
          const samePeer = cur.peer.id === s.from;
          // Each called the other. Keep the first call; the other side's call yields to it.
          const crossed = samePeer && cur.role === "caller" && phaseRef.current === "outgoing";
          if (samePeer && !crossed) {
            // The same person is calling again, so their side of the old call is gone (they lost the
            // connection, closed the app or logged out). End the old call here and ring the new one,
            // instead of answering "busy on another call".
            await finish(false);
          } else if (!crossed) {
            void send(s.from, { kind: "busy", callId: s.callId });
            return;
          } else {
            if (firstCallWins(cur, { id: s.callId, ts: s.ts })) return;
            // Both already chose to talk, so connect straight away unless it would turn the camera on unasked
            autoAccept = cur.video || !s.video;
            supabase.from("calls").update({ status: "missed", ended_at: new Date().toISOString() }).eq("id", cur.id).then();
            cleanup();
          }
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
    const onSignal = (message: { payload: unknown }) => {
      handleSignal(message).catch((error) => console.error("[call] could not handle a signal:", error));
    };
    // One lasting channel. The realtime client rejoins it by itself after a network drop; removing
    // and re-creating it here raced with that and could leave nobody listening for calls.
    const ch = supabase.channel(`call:${me.id}`);
    ch.on("broadcast", { event: "signal" }, onSignal);
    ch.subscribe((st, error) => {
      if (st === "CHANNEL_ERROR" || st === "TIMED_OUT") console.warn(`[call] listening channel ${st}; it rejoins by itself`, error ?? "");
    });
    const sending = channels.current;
    return () => {
      void supabase.removeChannel(ch);
      sending.forEach((c) => void supabase.removeChannel(c));
      sending.clear();
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

  // Logging out, closing the tab or leaving the page ends the call for the other phone straight
  // away. Without this it showed a frozen black picture until its own timeout ran out.
  const leaveCall = useCallback(async () => {
    const i = infoRef.current;
    if (!i) return;
    const signal = send(i.peer.id, { kind: phaseRef.current === "outgoing" ? "cancel" : "end", callId: i.id });
    void finish(false);
    await Promise.race([signal, new Promise((resolve) => window.setTimeout(resolve, 1200))]);
  }, [send, finish]);
  useEffect(() => {
    const task = async () => { await leaveCall(); };
    beforeLogout.add(task);
    // Capture runs before the realtime client closes its connection on the same event.
    const onHide = () => void leaveCall();
    window.addEventListener("pagehide", onHide, { capture: true });
    return () => {
      beforeLogout.delete(task);
      window.removeEventListener("pagehide", onHide, { capture: true });
    };
  }, [leaveCall]);

  // Get the relay list ready before the first call, and unlock sound on the first tap
  // (iPhones keep the ringtone silent until the page has been touched).
  useEffect(() => {
    warmIceConfig();
    window.addEventListener("click", primeAudio, { once: true, capture: true });
    return () => window.removeEventListener("click", primeAudio, { capture: true });
  }, []);

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

  const onRemoteSize = (e: { currentTarget: HTMLVideoElement }) => {
    const v = e.currentTarget;
    if (v.videoWidth && v.videoHeight) setRemoteLandscape(v.videoWidth > v.videoHeight * 1.1);
  };

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
    const stream = local.current;
    if (!stream) return;
    const previous = facing.current;
    const next = previous === "user" ? "environment" : "user";
    const open = async (mode: "user" | "environment") =>
      (await navigator.mediaDevices.getUserMedia({ video: cameraConstraints(mode) })).getVideoTracks()[0];
    // Most phones cannot open the second camera while the first is still on.
    stream.getVideoTracks().forEach((t) => { t.stop(); stream.removeTrack(t); });
    let track: MediaStreamTrack | undefined;
    let mode: "user" | "environment" = next;
    try {
      track = await open(next);
    } catch {
      mode = previous;
      toast.error("Could not switch the camera.");
      try { track = await open(previous); } catch { /* no camera left */ }
    }
    if (!track) return;
    track.enabled = !camOff;
    stream.addTrack(track);
    await pc.current?.getSenders().find((x) => x.track?.kind === "video")?.replaceTrack(track).catch(() => {});
    facing.current = mode;
    setMirrored(mode === "user");
    if (localVid.current) localVid.current.srcObject = stream;
  };

  // Esc or the browser's own control can leave full screen too
  useEffect(() => {
    const onChange = () => { if (!document.fullscreenElement) setMaximized(false); };
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  // Once video is playing, buttons fade out when idle; moving the mouse or tapping brings them back
  const fadeControls = phase === "active" && hasRemoteVideo && !minimized;
  const wakeControls = () => {
    setControlsShown(true);
    clearTimeout(controlsTimer.current);
    if (fadeControls) controlsTimer.current = window.setTimeout(() => setControlsShown(false), 4000);
  };
  useEffect(() => {
    wakeControls();
    return () => clearTimeout(controlsTimer.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fadeControls]);

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
  // While reconnecting the last frame freezes or goes black, so show the photo and status instead.
  const remoteShown = !!showVideo && hasRemoteVideo && !reconnecting;
  const statusText = phase === "incoming" ? `Incoming ${info?.video ? "video" : "voice"} call` : phase === "outgoing" ? "Ringing…" : phase === "connecting" ? "Connecting…" : reconnecting ? "Reconnecting…" : fmtDur(elapsed);
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
          onPointerDown={(e) => { onMiniDown(e); wakeControls(); }}
          onPointerMove={(e) => { onMiniMove(e); wakeControls(); }}
          onPointerUp={onMiniUp}
          onPointerCancel={() => { miniDrag.current = null; }}
          style={minimized ? {
            width: MINI_W,
            height: miniH,
            left: `clamp(8px, ${miniPos.x}px, calc(100vw - ${MINI_W} - 8px))`,
            top: `clamp(8px, ${miniPos.y}px, calc(100dvh - ${miniH} - 8px))`,
          } : undefined}
          className={cn("fixed z-50 flex flex-col text-call-fg", minimized ? "cursor-grab touch-none select-none overflow-hidden rounded-2xl bg-call-bg shadow-2xl" : maximized ? "inset-0 bg-black" : "inset-0 bg-call-bg sm:inset-auto sm:left-1/2 sm:top-1/2 sm:aspect-[9/19.5] sm:h-[min(92dvh,820px)] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:overflow-hidden sm:rounded-3xl sm:shadow-2xl")}
        >
          {!info.video && <audio ref={remoteAudio} autoPlay />}
          <div className="relative min-h-0 flex-1 overflow-hidden">
            <video ref={remoteVid} autoPlay playsInline onLoadedMetadata={onRemoteSize} onResize={onRemoteSize} className={cn("absolute inset-0 h-full w-full", maximized || remoteLandscape ? "object-contain" : "object-cover", !(remoteShown) && "invisible")} />
            {showVideo && (
              <video ref={localVid} autoPlay playsInline muted style={{ top: "max(1rem, env(safe-area-inset-top))" }} className={cn("absolute right-4 z-10 rounded-xl shadow-lg", maximized ? "h-auto w-28 sm:w-44" : "h-40 w-28 object-cover", camOff && "opacity-0", mirrored && "-scale-x-100", minimized && "hidden")} />
            )}
            {minimized ? (
              <div className="pointer-events-none relative z-10 flex h-full flex-col items-center justify-end px-2 pb-10 text-center">
                {!(remoteShown) && <Avatar p={info.peer} size={44} />}
                <p className="mt-1 w-full truncate text-xs font-medium drop-shadow">{info.peer.display_name}</p>
                <p className="text-[11px] opacity-75 drop-shadow">{statusText}</p>
              </div>
            ) : (
              remoteShown ? (
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
          {playbackBlocked && <button onClick={enablePlayback} className={cn("absolute left-1/2 z-20 w-max -translate-x-1/2 rounded-full bg-black/40 text-white backdrop-blur-sm", minimized ? "bottom-9 px-2 py-0.5 text-[10px]" : "bottom-16 px-3 py-1.5 text-xs")}>Tap to enable audio</button>}
          {minimized ? (
            <div className="absolute bottom-1.5 left-1/2 z-20 flex w-max -translate-x-1/2 gap-1.5">
              <BarBtn small label={muted ? "Unmute" : "Mute"} onClick={toggleMute} active={muted}>{muted ? <MicOff /> : <Mic />}</BarBtn>
              <BarBtn small label="Expand" onClick={() => setMinimized(false)}><Maximize2 /></BarBtn>
              <BarBtn small label="End" onClick={() => finish(true)} className="bg-destructive/70 text-white"><PhoneOff /></BarBtn>
            </div>
          ) : phase === "incoming" ? (
            <div className="flex justify-center gap-16 pb-[max(2rem,env(safe-area-inset-bottom))] pt-5 sm:gap-20">
              <CallBtn label="Decline" onClick={decline} className="bg-destructive"><PhoneOff /></CallBtn>
              <CallBtn label="Accept" onClick={accept} className="bg-primary">{info.video ? <Video /> : <Phone />}</CallBtn>
            </div>
          ) : (
            <div style={{ bottom: "max(0.75rem, env(safe-area-inset-bottom))" }} className={cn("absolute left-1/2 z-20 flex w-max -translate-x-1/2 gap-1.5 transition-opacity duration-300", !controlsShown && "pointer-events-none opacity-0")}>
              <BarBtn label={muted ? "Unmute" : "Mute"} onClick={toggleMute} active={muted}>{muted ? <MicOff /> : <Mic />}</BarBtn>
              {info.video && <BarBtn label={camOff ? "Camera on" : "Camera off"} onClick={toggleCam} active={camOff}>{camOff ? <VideoOff /> : <Video />}</BarBtn>}
              {info.video && <BarBtn label="Switch camera" onClick={switchCam}><RefreshCcw /></BarBtn>}
              <BarBtn label="Speaker" onClick={() => setLoud(!loud)} active={!loud}>{loud ? <Volume2 /> : <Volume1 />}</BarBtn>
              {info.video && <BarBtn label={maximized ? "Exit full screen" : "Full screen"} onClick={toggleMaximized} active={maximized}>{maximized ? <Shrink /> : <Expand />}</BarBtn>}
              <BarBtn label="Minimize" onClick={() => { leaveFullscreen(); setMaximized(false); setMinimized(true); }}><Minimize2 /></BarBtn>
              <BarBtn label="End" onClick={() => finish(true)} className="bg-destructive/70 text-white"><PhoneOff /></BarBtn>
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
      className={cn("flex shrink-0 items-center justify-center rounded-full backdrop-blur-sm transition-colors", small ? "h-7 w-7 [&_svg]:h-3.5 [&_svg]:w-3.5" : "h-9 w-9 [&_svg]:h-4 [&_svg]:w-4", className ?? (active ? "bg-white/70 text-black" : "bg-black/25 text-white hover:bg-black/40"))}
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
