import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { Mic, MicOff, Phone, PhoneOff, RefreshCcw, Video, VideoOff, Volume2, Volume1 } from "lucide-react";
import { supabase, type Profile, emitMsg, type Message } from "@/lib/supabase";
import { ICE_SERVERS } from "@/lib/ice";
import { startRing, stopRing, notify } from "@/lib/tones";
import { fmtDur } from "@/lib/format";
import { Avatar } from "./Avatar";
import { cn } from "@/lib/utils";

type Sig = {
  kind: "offer" | "answer" | "ice" | "end" | "decline" | "busy" | "cancel";
  callId: string;
  from: string;
  video?: boolean;
  sdp?: RTCSessionDescriptionInit;
  cand?: RTCIceCandidateInit;
};
type Info = { id: string; peer: Profile; video: boolean; role: "caller" | "callee"; offer?: RTCSessionDescriptionInit | undefined };
type Phase = "idle" | "outgoing" | "incoming" | "active";

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

  const pc = useRef<RTCPeerConnection | null>(null);
  const local = useRef<MediaStream | null>(null);
  const remote = useRef<MediaStream | null>(null);
  const pendingIce = useRef<RTCIceCandidateInit[]>([]);
  const infoRef = useRef<Info | null>(null);
  const phaseRef = useRef<Phase>("idle");
  const startedAt = useRef<number | null>(null);
  const timeout = useRef<number | undefined>(undefined);
  const facing = useRef<"user" | "environment">("user");
  const channels = useRef(new Map<string, Promise<RealtimeChannel>>());
  const localVid = useRef<HTMLVideoElement>(null);
  const remoteVid = useRef<HTMLVideoElement>(null);
  const profilesRef = useRef(profiles);
  profilesRef.current = profiles;

  const setP = (p: Phase) => { phaseRef.current = p; setPhase(p); };
  const setI = (i: Info | null) => { infoRef.current = i; setInfo(i); };

  const send = useCallback(async (to: string, s: Omit<Sig, "from">) => {
    let ch = channels.current.get(to);
    if (!ch) {
      ch = new Promise<RealtimeChannel>((res) => {
        const c = supabase.channel(`call:${to}`);
        c.subscribe((st) => st === "SUBSCRIBED" && res(c));
      });
      channels.current.set(to, ch);
    }
    (await ch).send({ type: "broadcast", event: "signal", payload: { ...s, from: me.id } });
  }, [me.id]);

  const cleanup = useCallback(() => {
    stopRing();
    clearTimeout(timeout.current);
    local.current?.getTracks().forEach((t) => t.stop());
    pc.current?.close();
    pc.current = null;
    local.current = null;
    remote.current = null;
    pendingIce.current = [];
    startedAt.current = null;
    setMuted(false); setCamOff(false); setLoud(true); setHasRemoteVideo(false); setElapsed(0);
    setI(null);
    setP("idle");
  }, []);

  const logCall = async (i: Info, connected: boolean) => {
    const dur = startedAt.current ? (Date.now() - startedAt.current) / 1000 : 0;
    const content = connected ? `${i.video ? "Video" : "Voice"} call • ${fmtDur(dur)}` : `Missed ${i.video ? "video" : "voice"} call`;
    await supabase.from("calls").update({ status: connected ? "ended" : "missed", ended_at: new Date().toISOString() }).eq("id", i.id);
    const { data } = await supabase.from("messages").insert({ sender_id: me.id, receiver_id: i.peer.id, type: "call", content }).select().single();
    if (data) emitMsg(data as Message);
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

  const buildPc = (i: Info) => {
    const p = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    remote.current = new MediaStream();
    p.onicecandidate = (e) => e.candidate && send(i.peer.id, { kind: "ice", callId: i.id, cand: e.candidate.toJSON() });
    p.ontrack = (e) => {
      remote.current!.addTrack(e.track);
      if (e.track.kind === "video") setHasRemoteVideo(true);
      if (remoteVid.current) remoteVid.current.srcObject = remote.current;
    };
    p.onconnectionstatechange = () => {
      if (p.connectionState === "failed") finish(true);
    };
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
    stopRing();
    clearTimeout(timeout.current);
    startedAt.current = Date.now();
    setP("active");
  };

  const startCall = useCallback(async (peer: Profile, video: boolean) => {
    if (phaseRef.current !== "idle") return;
    try {
      local.current = await getMedia(video);
    } catch {
      alert("Camera/microphone permission is needed to call.");
      return;
    }
    const { data } = await supabase.from("calls").insert({ caller_id: me.id, receiver_id: peer.id, type: video ? "video" : "voice" }).select().single();
    const i: Info = { id: data?.id ?? crypto.randomUUID(), peer, video, role: "caller" };
    setI(i);
    setP("outgoing");
    setCamOff(false);
    const p = buildPc(i);
    const offer = await p.createOffer();
    await p.setLocalDescription(offer);
    send(peer.id, { kind: "offer", callId: i.id, video, sdp: offer });
    startRing(true);
    timeout.current = window.setTimeout(() => finish(true), 35000);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me.id, send, finish]);

  const accept = async () => {
    const i = infoRef.current;
    if (!i?.offer) return;
    stopRing();
    try {
      local.current = await getMedia(i.video);
    } catch {
      alert("Camera/microphone permission is needed.");
      return decline();
    }
    const p = buildPc(i);
    await p.setRemoteDescription(i.offer);
    await flushIce();
    const ans = await p.createAnswer();
    await p.setLocalDescription(ans);
    send(i.peer.id, { kind: "answer", callId: i.id, sdp: ans });
    supabase.from("calls").update({ status: "active" }).eq("id", i.id).then();
    goActive();
  };

  const decline = () => {
    const i = infoRef.current;
    if (i) send(i.peer.id, { kind: "decline", callId: i.id });
    cleanup();
  };

  // Incoming signalling
  useEffect(() => {
    const ch = supabase.channel(`call:${me.id}`);
    ch.on("broadcast", { event: "signal" }, async ({ payload }) => {
      const s = payload as Sig;
      const cur = infoRef.current;
      if (s.kind === "offer") {
        if (cur) return send(s.from, { kind: "busy", callId: s.callId });
        const peer = profilesRef.current.find((p) => p.id === s.from);
        if (!peer) return;
        setI({ id: s.callId, peer, video: !!s.video, role: "callee", offer: s.sdp });
        setP("incoming");
        startRing(false);
        notify(peer.display_name, `Incoming ${s.video ? "video" : "voice"} call`);
        return;
      }
      if (!cur || cur.id !== s.callId) return;
      switch (s.kind) {
        case "answer":
          await pc.current?.setRemoteDescription(s.sdp!);
          await flushIce();
          goActive();
          break;
        case "ice":
          if (pc.current?.remoteDescription) await pc.current.addIceCandidate(s.cand!).catch(() => {});
          else pendingIce.current.push(s.cand!);
          break;
        case "decline":
        case "busy":
        case "end":
          finish(false);
          break;
        case "cancel":
          if (cur.role === "callee") notify(cur.peer.display_name, "Missed call");
          cleanup();
          break;
      }
    });
    ch.subscribe();
    return () => { supabase.removeChannel(ch); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me.id]);

  useEffect(() => {
    if (phase === "idle") return;
    if (localVid.current && local.current) localVid.current.srcObject = local.current;
    if (remoteVid.current && remote.current) remoteVid.current.srcObject = remote.current;
  }, [phase, hasRemoteVideo]);

  useEffect(() => {
    if (phase !== "active") return;
    const t = setInterval(() => startedAt.current && setElapsed((Date.now() - startedAt.current) / 1000), 500);
    return () => clearInterval(t);
  }, [phase]);

  // Keep the phone screen awake during a call
  useEffect(() => {
    if (phase === "idle" || !("wakeLock" in navigator)) return;
    let lock: { release: () => Promise<void> } | null = null;
    (navigator as any).wakeLock.request("screen").then((l: any) => (lock = l)).catch(() => {});
    return () => { lock?.release().catch(() => {}); };
  }, [phase]);

  useEffect(() => {
    if (remoteVid.current) remoteVid.current.volume = loud ? 1 : 0.35;
  }, [loud, phase]);

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

  const showVideo = info?.video && phase !== "incoming";

  return (
    <Ctx.Provider value={{ startCall, busy: phase !== "idle" }}>
      {children}
      {info && phase !== "idle" && (
        <div className="fixed inset-0 z-50 flex flex-col bg-call-bg text-call-fg">
          <video ref={remoteVid} autoPlay playsInline className={cn("absolute inset-0 h-full w-full object-cover", !(showVideo && hasRemoteVideo) && "invisible")} />
          {showVideo && (
            <video ref={localVid} autoPlay playsInline muted style={{ top: "max(1rem, env(safe-area-inset-top))" }} className={cn("absolute right-4 z-10 h-40 w-28 rounded-xl object-cover shadow-lg sm:h-48 sm:w-36", camOff && "opacity-0", facing.current === "user" && "-scale-x-100")} />
          )}
          <div className={cn("relative z-10 flex flex-1 flex-col items-center pt-24", showVideo && hasRemoteVideo && "justify-start")}>
            {!(showVideo && hasRemoteVideo) && <Avatar p={info.peer} size={112} />}
            <h2 className="mt-5 text-2xl font-semibold drop-shadow">{info.peer.display_name}</h2>
            <p className="mt-1 text-sm opacity-75 drop-shadow">
              {phase === "incoming" ? `Incoming ${info.video ? "video" : "voice"} call` : phase === "outgoing" ? "Ringing…" : fmtDur(elapsed)}
            </p>
          </div>
          <div className="relative z-10 pb-[max(2rem,env(safe-area-inset-bottom))]">
            {phase === "incoming" ? (
              <div className="flex justify-center gap-16 sm:gap-20">
                <CallBtn label="Decline" onClick={decline} className="bg-destructive"><PhoneOff /></CallBtn>
                <CallBtn label="Accept" onClick={accept} className="bg-primary">{info.video ? <Video /> : <Phone />}</CallBtn>
              </div>
            ) : (
              <div className="flex flex-wrap justify-center gap-x-4 gap-y-3 px-3">
                <CallBtn label={muted ? "Unmute" : "Mute"} onClick={toggleMute} active={muted}>{muted ? <MicOff /> : <Mic />}</CallBtn>
                {info.video && <CallBtn label={camOff ? "Camera on" : "Camera off"} onClick={toggleCam} active={camOff}>{camOff ? <VideoOff /> : <Video />}</CallBtn>}
                {info.video && <CallBtn label="Switch" onClick={switchCam}><RefreshCcw /></CallBtn>}
                <CallBtn label="Speaker" onClick={() => setLoud(!loud)} active={!loud}>{loud ? <Volume2 /> : <Volume1 />}</CallBtn>
                <CallBtn label="End" onClick={() => finish(true)} className="bg-destructive"><PhoneOff /></CallBtn>
              </div>
            )}
          </div>
        </div>
      )}
    </Ctx.Provider>
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
