# Fix plan: calls, Telegram sending, chat scroll and lazy loading

- Date: 2026-11-27. Repo: `D:\Ontario ISP` (GitHub `abhijithkjayan/cozy-four`, branch `live`). Level: L3.
- Planner: Fable (diagnosis and plan only). Executor: Sonnet Medium, following this file literally.
- Status: **approved by the owner on 2026-11-27**, not started. Tick each box as a step passes its check.

## 1. Summary for the owner

**Goal:** calls connect reliably, "Send to Telegram" works for large files and stickers, alerts stop going missing, and the chat scrolls without jumping, with photos and videos loaded only when needed.

**What was found (all confirmed by reading the code and the installed realtime library, `@supabase/realtime-js` 2.117.2):**

| # | Area | Fault | Effect |
|---|---|---|---|
| 1 | Calls | Signal sending caches a "channel ready" promise. After any network drop the code removes the channel inside its own status callback, which re-enters itself, and a new send can be handed the old half-closed channel whose `subscribe()` never reports back. | Offers, answers and ICE messages silently stop. The other phone never rings or the call sits on "Connecting…". |
| 2 | Calls | The retry path makes every waiting signal call `subscribe()` on the same channel; only the first one is answered. | Most signals of that call are lost. |
| 3 | Calls | Nothing is sent until the relay list has loaded, with no time limit, and the ring timeout only starts after that. One bad relay address makes `RTCPeerConnection` throw and ends every call instantly with no message. | Stuck "Ringing…" or calls that close at once. |
| 4 | Calls | A relay (TURN) server is only used if server secrets are set. Without one, calls between phones on mobile data or strict networks cannot connect. Whether the secrets are set cannot be seen from the code. | "Connecting…" then the call drops. **Needs an owner action, see section 2.** |
| 5 | Calls | Remote video is added to a stream the page is already playing (Safari shows no picture). Switch-camera opens the second camera before closing the first (fails on most phones). Failed calls close silently. Ringtone is locked on iPhones until a tap. Blocking `alert()` freezes the call. | Black video, dead switch button, no explanation. |
| 6 | Telegram | The server reads the whole file into memory two or three times (chunks, Blob, form). A Cloudflare Worker has 128 MB. | Videos over roughly 35 MB fail. |
| 7 | Telegram | NAUGHTY stickers have an app-only link (`/naughty/...`), which is rejected. WebP stickers are refused by `sendAnimation`. | "This message has no file to send" / "Telegram did not accept the file". |
| 8 | Telegram | A nudge sends 10 messages at the same instant, which trips Telegram's flood limit; later alerts are then refused. No retry, no timeout. | Missing alerts after a nudge. |
| 9 | Telegram | On logout the profile is marked offline after sign-out, so the database refuses it. The account looks online for up to a minute. | Alerts for messages sent in that minute are skipped. |
| 10 | Chat | "Stay at bottom" is only updated when a new message arrives. A tick, edit or delete arriving while reading old messages jumps the chat to the bottom. Photos have no reserved size, so the chat shifts as they load and does not open at the true bottom. | Jumpy scroll. |
| 11 | Chat | Every photo, video and voice note asks for its own signed link at once and videos preload. Deleted-for-me messages are filtered in the browser, so cleared chats load pages of nothing. | Slow opening, wasted data. |
| 12 | Chat | Jumping to an old search result or pin inserts that one message and leaves a silent gap in the history. | Missing messages until reload. |
| 13 | Chat | Messages sent while the live connection was down are never fetched afterwards. | Messages appear only after a reload. |
| 14 | UI | The chat header has up to six 44 px buttons; on a 360 px phone the name gets about 30 px. | Name cut off. |

**Phases:** 1 relay servers, 2 call signalling and call screen, 3 Telegram, 4 lazy media, 5 chat scroll and reconnect, 6 header, 7 final checks. Effort: about 10 files, one new test file, no database change, no new dependency.

**Risks:** calls and Telegram cannot be tested from this computer (the app only has the live database, and local sign-in against live data is not allowed). Type check, lint, build and unit tests are run here; the owner tests calls and Telegram on two phones after publishing (section 9).

## 2. Owner decisions and actions

1. **Relay server for calls (needed for fault 4).** Recommended: Cloudflare Realtime TURN. Free for the first 1,000 GB a month, then $0.05 per GB.
   1. Open `https://dash.cloudflare.com/?to=/:account/calls`, create a TURN key.
   2. Copy the **TURN Token ID** and the **API token**.
   3. In Lovable, open the project, Cloud, Secrets, and add `CF_TURN_KEY_ID` (the Token ID) and `CF_TURN_API_TOKEN` (the API token).
   If `TURN_URLS`, `TURN_USERNAME` and `TURN_CREDENTIAL` are already set there, they keep working and this step is optional.
   Without either, the code fixes still land, but calls across mobile networks will keep failing and the app will now say so.
2. **Skills:** none needed; this plan carries the exact code. Optional at the end: `code-review` (about 15k to 25k tokens, estimate). Cheaper alternative: skip it.
3. **Commit and publish** stay with the owner. The executor does not commit, push or deploy.

## 3. Out of scope (do not change)

- Idle and hidden-tab logout rules, account names, passwords, the watched-account rules.
- Database schema, RLS, migrations, `src/routeTree.gen.ts`, anything under `src/integrations/supabase/` (generated).
- Message list virtualisation, new dependencies, replacing the remaining `alert()` calls outside calls.
- Incoming calls while the app is closed or logged out (needs push notifications; not possible with the current logout rules).

## 4. Noticed, not changed (owner to decide later)

- `src/lib/accounts.functions.ts` holds the four passwords in source, and `ensureAccounts` can be called without signing in and resets them to those values.
- Realtime channels (`call:<id>`, `typing:...`) are public: any signed-in client can listen or send on them.

## 5. Rules for the executor

- Follow steps in order. One step = edit, then its check. If a check fails twice, or a "before" block does not match the file, stop and write the step, expected, found and output at the bottom of this file under "Errors", then end with the Fable hand-over message.
- No git commit, push, merge or rebase. No deploy. Do not run `npm run dev` and sign in: the only database is live.
- Use the Edit tool with the exact "before" text. Line numbers are as of commit `3a257c0` and shift as you edit.
- Rollback for any file: `git restore --source=HEAD -- <file>` (working tree only), and delete new files `src/lib/telegram-upload.ts`, `tests/telegram-upload.test.ts`.

## Phase 0. Baseline

- [ ] **0.1** Run `npx tsc --noEmit`, `npm run lint`, `npm run build`. Record for each: pass/fail and the error count, in the "Baseline" section at the bottom. Later checks mean "no new errors compared with this baseline".
- [ ] **0.2** Run `node -v`. If 22.6 or newer, the test command is `node --experimental-strip-types --test tests/telegram-upload.test.ts`. Otherwise it is `npx --yes tsx --test tests/telegram-upload.test.ts`. Record which.

## Phase 1. Relay servers (faults 3, 4)

- [ ] **1.1** Replace the whole of `src/lib/ice.functions.ts` with:

```ts
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export type IceServer = { urls: string[]; username?: string; credential?: string };

// Only real STUN/TURN addresses reach the browser: one bad entry makes RTCPeerConnection throw,
// which ended every call. Port 53 is blocked by browsers and only slows the connection down.
const cleanUrls = (urls: unknown): string[] =>
  (Array.isArray(urls) ? urls : [urls])
    .map((u) => String(u ?? "").trim())
    .filter((u) => /^(stuns?|turns?):\S+$/i.test(u) && !/:53(\?|$)/.test(u));

function cleanServer(raw: unknown): IceServer | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as { urls?: unknown; username?: unknown; credential?: unknown };
  const urls = cleanUrls(s.urls);
  if (!urls.length) return null;
  if (!urls.some((u) => /^turns?:/i.test(u))) return { urls };
  if (typeof s.username !== "string" || typeof s.credential !== "string" || !s.username || !s.credential) return null;
  return { urls, username: s.username, credential: s.credential };
}

// Cloudflare Realtime TURN: short-lived credentials made from a TURN key
// (secrets CF_TURN_KEY_ID + CF_TURN_API_TOKEN). They last 24 hours, so credentials handed out
// now still work at the end of a long call.
async function cloudflareServers(): Promise<IceServer[]> {
  const keyId = process.env["CF_TURN_KEY_ID"]?.trim();
  const apiToken = process.env["CF_TURN_API_TOKEN"]?.trim();
  if (!keyId || !apiToken) return [];
  try {
    const res = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(keyId)}/credentials/generate-ice-servers`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ ttl: 86400 }),
        signal: AbortSignal.timeout(5000),
      },
    );
    if (!res.ok) {
      console.error("Cloudflare TURN credentials failed:", res.status, await res.text());
      return [];
    }
    const body = (await res.json()) as { iceServers?: unknown };
    const list = Array.isArray(body.iceServers) ? body.iceServers : body.iceServers ? [body.iceServers] : [];
    return list.map(cleanServer).filter((s): s is IceServer => !!s);
  } catch (error) {
    console.error("Cloudflare TURN credentials failed:", error);
    return [];
  }
}

// A fixed TURN server: TURN_URLS (comma-separated), TURN_USERNAME, TURN_CREDENTIAL.
function staticServers(): IceServer[] {
  const server = cleanServer({
    urls: (process.env["TURN_URLS"] ?? "").split(","),
    username: process.env["TURN_USERNAME"],
    credential: process.env["TURN_CREDENTIAL"],
  });
  return server ? [server] : [];
}

// Relay servers for calls. A relay is what lets a call connect when either phone is on mobile data
// or a network that blocks direct calls. Signed-in users only, so relay credentials are not public.
export const getTurnServers = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async (): Promise<IceServer[]> => {
    const servers = [...(await cloudflareServers()), ...staticServers()];
    if (!servers.some((s) => s.username))
      console.warn("Calls: no TURN relay is configured (CF_TURN_KEY_ID + CF_TURN_API_TOKEN, or TURN_URLS + TURN_USERNAME + TURN_CREDENTIAL).");
    return servers;
  });
```

- [ ] **1.2** Replace the whole of `src/lib/ice.ts` with:

```ts
import { getTurnServers } from "./ice.functions";

// Public STUN servers (direct connections). TURN relays are added from server config when available.
export const ICE_SERVERS: RTCIceServer[] = [
  { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
  { urls: "stun:stun.cloudflare.com:3478" },
];

export type IceConfig = { servers: RTCIceServer[]; relay: boolean };

// Relay credentials last 24 hours; ask again well before that.
const FRESH_MS = 6 * 60 * 60 * 1000;
// A call must never wait on this request: after this long it starts with what it has.
const WAIT_MS = 4000;

let cached: { at: number; config: IceConfig } | null = null;
let pending: Promise<IceConfig> | null = null;

const direct = (): IceConfig => ({ servers: ICE_SERVERS, relay: false });

function refresh(): Promise<IceConfig> {
  pending ??= getTurnServers()
    .then((turn) => {
      const relayServers = turn as RTCIceServer[];
      const config: IceConfig = {
        servers: [...ICE_SERVERS, ...relayServers],
        relay: relayServers.some((s) => [s.urls].flat().some((u) => /^turns?:/i.test(u))),
      };
      cached = { at: Date.now(), config };
      return config;
    })
    .catch((error: unknown) => {
      console.warn("Could not load relay servers for calls:", error);
      return cached?.config ?? direct();
    })
    .finally(() => {
      pending = null;
    });
  return pending;
}

/** ICE servers for a call. Uses the saved list while fresh and never waits longer than WAIT_MS. */
export function loadIceConfig(): Promise<IceConfig> {
  if (cached && Date.now() - cached.at < FRESH_MS) return Promise.resolve(cached.config);
  const fallback = cached?.config ?? direct();
  return Promise.race([
    refresh(),
    new Promise<IceConfig>((resolve) => setTimeout(() => resolve(fallback), WAIT_MS)),
  ]);
}

/** Fetches the list ahead of time (when the app opens), so starting a call is instant. */
export const warmIceConfig = () => void loadIceConfig();
```

Check for 1.1 and 1.2: done together with step 2.14 (the old `loadIceServers` import in `Calls.tsx` breaks the type check until then).

## Phase 2. Call signalling and call screen (faults 1, 2, 3, 5). File: `src/components/chat/Calls.tsx`

- [ ] **2.1** In `src/lib/tones.ts`, after the `messageTone` function, add:

```ts
/** Call from a tap: phones only let sound start after the user has touched the page. */
export function primeAudio() {
  try {
    const c = ac();
    if (c.state === "suspended") void c.resume();
  } catch {}
}
```

- [ ] **2.2** Imports. Before:

```ts
import { loadIceServers } from "@/lib/ice";
import { startRing, stopRing, notify } from "@/lib/tones";
```

After:

```ts
import { ICE_SERVERS, loadIceConfig, warmIceConfig } from "@/lib/ice";
import { startRing, stopRing, notify, primeAudio } from "@/lib/tones";
```

- [ ] **2.3** Refs. Before:

```ts
  const facing = useRef<"user" | "environment">("user");
  const channels = useRef(new Map<string, Promise<RealtimeChannel>>());
```

After:

```ts
  const facing = useRef<"user" | "environment">("user");
  const [mirrored, setMirrored] = useState(true);
  const channels = useRef(new Map<string, RealtimeChannel>());
  const relayAvailable = useRef(false);
  const restartSdp = useRef<string | null>(null);
```

- [ ] **2.4** Replace the whole `send` block (starts `const send = useCallback(async (to: string, s: Omit<Sig, "from">) => {`, ends `}, [me.id]);`, lines 78 to 104) with:

```ts
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
```

- [ ] **2.5** In `cleanup`. Before:

```ts
    pendingIce.current = [];
    startedAt.current = null;
```

After:

```ts
    pendingIce.current = [];
    restartSdp.current = null;
    facing.current = "user";
    startedAt.current = null;
```

Then in the same function append ` setMirrored(true);` to the end of the line that starts `    setMuted(false); setCamOff(false); setLoud(true);`.

- [ ] **2.6** Directly after the `finish` block (after its closing `}, [cleanup, send]);`) add:

```ts
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
```

- [ ] **2.7** Replace the whole `buildPc` block (starts `const buildPc = async (i: Info) => {`, ends with `return p;` and `};`, lines 161 to 200) with:

```ts
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
        goActive();
        void logRoute(p);
      } else if (c === "failed" || iceState === "failed") {
        restart();
        giveUpIfDown(20000);
      } else if (c === "disconnected" || iceState === "disconnected") {
        // Often a change of network (Wi-Fi to mobile data): try a new route after a short wait.
        window.setTimeout(() => {
          if (pc.current === p && p.iceConnectionState === "disconnected") restart();
        }, 3000);
        giveUpIfDown(20000);
      }
    };
    p.onconnectionstatechange = onState;
    p.oniceconnectionstatechange = onState;
    local.current!.getTracks().forEach((t) => p.addTrack(t, local.current!));
    pc.current = p;
    return p;
  };
```

- [ ] **2.8** In `beginConnecting`. Before: `    timeout.current = window.setTimeout(() => finish(true), 45000);` After: `    timeout.current = window.setTimeout(giveUp, 45000);`

- [ ] **2.9** Replace the whole `startCall` block (starts `const startCall = useCallback(async (peer: Profile, video: boolean) => {`, ends `}, [me.id, send, finish]);`, keep the eslint-disable comment line above the closing line) with:

```ts
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
```

- [ ] **2.10** In `accept`, three edits.

Before:

```ts
      alert("Camera/microphone permission is needed.");
      return decline();
```

After:

```ts
      toast.error(i.video ? "Allow the camera and microphone to answer." : "Allow the microphone to answer.");
      return decline();
```

Before: `      send(i.peer.id, { kind: "answer", callId: i.id, sdp: ans });` (the one inside `accept`, followed by `beginConnecting();`)
After: `      void send(i.peer.id, { kind: "answer", callId: i.id, sdp: p.localDescription?.toJSON() ?? ans });`

Before (the `catch` at the end of `accept`):

```ts
    } catch {
      finish(true);
    }
  };

  const decline = () => {
```

After:

```ts
    } catch (error) {
      console.error("[call] could not answer the call:", error);
      toast.error("Could not answer the call.");
      void finish(true);
    }
  };

  const decline = () => {
```

- [ ] **2.11** In the "Incoming signalling" effect, four edits.

(a) Before: `    const onSignal = async ({ payload }: { payload: unknown }) => {`
After: `    const handleSignal = async ({ payload }: { payload: unknown }) => {`

(b) Before:

```ts
          if (s.restart && conn) {
            await conn.setRemoteDescription(s.sdp!);
            const ans = await conn.createAnswer();
            await conn.setLocalDescription(ans);
            send(s.from, { kind: "answer", callId: s.callId, sdp: ans });
          } else if (conn?.localDescription?.type === "answer") {
```

After:

```ts
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
```

(c) Before: `          if (!crossed) return send(s.from, { kind: "busy", callId: s.callId });`
After:

```ts
          if (!crossed) {
            void send(s.from, { kind: "busy", callId: s.callId });
            return;
          }
```

(d) Replace everything from the comment line `    // Phones drop this connection when the app is in the background. Rejoin, or calls never reach us.` down to and including the effect's cleanup (`      if (ch) supabase.removeChannel(ch);` and the `    };` after it) with:

```ts
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
```

The lines `// eslint-disable-next-line react-hooks/exhaustive-deps` and `}, [me.id]);` that follow stay.

- [ ] **2.12** Directly after the line `  useEffect(() => { idleState.paused = phase !== "idle"; return () => { idleState.paused = false; }; }, [phase]);` add:

```ts
  // Get the relay list ready before the first call, and unlock sound on the first tap
  // (iPhones keep the ringtone silent until the page has been touched).
  useEffect(() => {
    warmIceConfig();
    window.addEventListener("click", primeAudio, { once: true, capture: true });
    return () => window.removeEventListener("click", primeAudio, { capture: true });
  }, []);
```

- [ ] **2.13** Replace the whole `switchCam` block (starts `const switchCam = async () => {`, ends `};` after `} catch {}`) with:

```ts
  const switchCam = async () => {
    const stream = local.current;
    if (!stream) return;
    const previous = facing.current;
    const next = previous === "user" ? "environment" : "user";
    const open = async (mode: "user" | "environment") =>
      (await navigator.mediaDevices.getUserMedia({ video: { facingMode: mode } })).getVideoTracks()[0];
    // Most phones cannot open the second camera while the first is still on.
    stream.getVideoTracks().forEach((t) => { t.stop(); stream.removeTrack(t); });
    let track: MediaStreamTrack | undefined;
    let mode = next;
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
```

Then in the JSX of the local `<video ref={localVid} …>`: before `facing.current === "user" && "-scale-x-100"`, after `mirrored && "-scale-x-100"`.

- [ ] **2.14 Check.** `npx tsc --noEmit`: no new errors against the baseline. `npm run lint`: no new errors. Search `Calls.tsx` for `loadIceServers`, `alert(` and `Promise<RealtimeChannel>`: each must return nothing.

## Phase 3. Telegram (faults 6, 7, 8, 9)

- [ ] **3.1** Create `src/lib/telegram-upload.ts`:

```ts
// Builds the multipart/form-data request that uploads one file to the Telegram Bot API.
// No project imports here, so the unit test can load this file on its own.

export type UploadFile = { body: ReadableStream<Uint8Array>; size: number; type: string };
export type UploadRequest = { body: BodyInit; headers: Record<string, string> };

type FixedLengthStreamCtor = new (length: number) => {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
};

/** The bytes that go before and after the file in a multipart body. */
export function multipartFrame(fields: Record<string, string>, fileField: string, filename: string, contentType: string) {
  const boundary = `----upload${crypto.randomUUID().replace(/-/g, "")}`;
  // Header values: plain ASCII, no quotes or line breaks.
  const safe = (value: string) => value.replace(/[^\x20-\x7E]|["\\]/g, "_");
  let head = "";
  for (const [name, value] of Object.entries(fields)) {
    head += `--${boundary}\r\nContent-Disposition: form-data; name="${safe(name)}"\r\n\r\n${value}\r\n`;
  }
  head += `--${boundary}\r\nContent-Disposition: form-data; name="${safe(fileField)}"; filename="${safe(filename)}"\r\nContent-Type: ${safe(contentType) || "application/octet-stream"}\r\n\r\n`;
  const encoder = new TextEncoder();
  return { boundary, prefix: encoder.encode(head), suffix: encoder.encode(`\r\n--${boundary}--\r\n`) };
}

/**
 * On Cloudflare Workers the file is streamed straight through with a known length, so a 50 MB
 * video never sits in the Worker's 128 MB of memory. Holding it there two or three times over
 * (chunks, Blob, form) is what made large files fail. Elsewhere (local development) it is
 * buffered, which is fine there.
 */
export async function telegramUpload(fields: Record<string, string>, fileField: string, filename: string, file: UploadFile): Promise<UploadRequest> {
  const Fixed = (globalThis as { FixedLengthStream?: FixedLengthStreamCtor }).FixedLengthStream;
  if (!Fixed || !(file.size > 0)) {
    const form = new FormData();
    for (const [name, value] of Object.entries(fields)) form.append(name, value);
    form.append(fileField, new Blob([await new Response(file.body).arrayBuffer()], { type: file.type }), filename);
    return { body: form, headers: {} };
  }
  const { boundary, prefix, suffix } = multipartFrame(fields, fileField, filename, file.type);
  const { readable, writable } = new Fixed(prefix.byteLength + file.size + suffix.byteLength);
  void (async () => {
    const head = writable.getWriter();
    await head.write(prefix);
    head.releaseLock();
    await file.body.pipeTo(writable, { preventClose: true });
    const tail = writable.getWriter();
    await tail.write(suffix);
    await tail.close();
  })().catch((error: unknown) => {
    // Telegram closed the upload early (its answer says why), or storage failed part-way.
    console.error("Telegram upload stream stopped:", error);
    void writable.abort(error).catch(() => {});
  });
  return { body: readable, headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
}
```

- [ ] **3.2** Create `tests/telegram-upload.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { multipartFrame, telegramUpload } from "../src/lib/telegram-upload.ts";

const bytes = (n: number) => Uint8Array.from({ length: n }, (_, i) => i % 251);
const streamOf = (data: Uint8Array) => new Blob([data]).stream() as ReadableStream<Uint8Array>;

test("multipart frame parses back to the same fields and file", async () => {
  const data = bytes(70_000);
  const { boundary, prefix, suffix } = multipartFrame({ chat_id: "-100123" }, "video", 'clip "1".mp4', "video/mp4");
  const form = await new Response(new Blob([prefix, data, suffix]), {
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
  }).formData();
  assert.equal(form.get("chat_id"), "-100123");
  const file = form.get("video") as File;
  assert.equal(file.name, "clip _1_.mp4");
  assert.equal(file.type, "video/mp4");
  assert.deepEqual(new Uint8Array(await file.arrayBuffer()), data);
});

test("streams with the exact declared length when FixedLengthStream exists (Cloudflare Workers)", async () => {
  let declared = 0;
  (globalThis as Record<string, unknown>)["FixedLengthStream"] = class {
    readable: ReadableStream<Uint8Array>;
    writable: WritableStream<Uint8Array>;
    constructor(length: number) {
      declared = length;
      const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
      this.readable = readable;
      this.writable = writable;
    }
  };
  try {
    const data = bytes(200_000);
    const request = await telegramUpload({ chat_id: "42" }, "document", "a.bin", {
      body: streamOf(data),
      size: data.byteLength,
      type: "application/octet-stream",
    });
    const sent = new Uint8Array(await new Response(request.body as ReadableStream).arrayBuffer());
    assert.equal(sent.byteLength, declared);
    const form = await new Response(sent, { headers: request.headers }).formData();
    assert.equal(form.get("chat_id"), "42");
    assert.deepEqual(new Uint8Array(await (form.get("document") as File).arrayBuffer()), data);
  } finally {
    delete (globalThis as Record<string, unknown>)["FixedLengthStream"];
  }
});

test("buffers into FormData where FixedLengthStream is missing (local development)", async () => {
  const data = bytes(1000);
  const request = await telegramUpload({ chat_id: "42" }, "photo", "p.jpg", {
    body: streamOf(data),
    size: data.byteLength,
    type: "image/jpeg",
  });
  assert.ok(request.body instanceof FormData);
  assert.deepEqual(new Uint8Array(await (request.body.get("photo") as File).arrayBuffer()), data);
});
```

Check: run the test command from step 0.2. Expected: `# pass 3`, `# fail 0`.

- [ ] **3.3** `src/lib/telegram.functions.ts`, imports. Before:

```ts
import { TELEGRAM_FILE_MAX_BYTES, TELEGRAM_TARGET_BYTES, telegramRoutes } from "@/lib/telegram-media";
```

After:

```ts
import { TELEGRAM_FILE_MAX_BYTES, TELEGRAM_TARGET_BYTES, telegramRoutes } from "@/lib/telegram-media";
import { telegramUpload, type UploadFile } from "@/lib/telegram-upload";
import { NAUGHTY_PATH, serveNaughty } from "@/lib/r2";
```

- [ ] **3.4** Same file. Before: `const lastNudgeByUser = new Map<string, number>();` After:

```ts
const lastNudgeByUser = new Map<string, number>();
const NUDGE_MESSAGES = 10;
// Telegram allows about one message a second to the same chat.
const NUDGE_GAP_MS = 1050;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
```

- [ ] **3.5** Same file. Replace the whole `sendTelegram` function (starts `async function sendTelegram(text: string, chatId = …) {`, ends `  return response.ok;` and `}`) with:

```ts
async function sendTelegram(text: string, chatId = process.env["T_CHAT_ID"] || DEFAULT_CHAT_ID) {
  const token = process.env["T_BOT"];
  if (!token) {
    console.error("Telegram alert skipped: T_BOT is not configured.");
    return false;
  }
  // Telegram answers 429 with a wait time when messages come too fast, and requests can fail on
  // the way. One short wait and a second try gets the alert through.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
        signal: AbortSignal.timeout(10_000),
      });
      if (response.ok) return true;
      const body = await response.text();
      console.error("Telegram alert failed:", response.status, body);
      if (response.status !== 429 || attempt > 0) return false;
      let retryAfter = 1;
      try {
        retryAfter = Number(JSON.parse(body).parameters?.retry_after) || 1;
      } catch {
        // keep one second
      }
      if (retryAfter > 5) return false;
      await wait(retryAfter * 1000 + 250);
    } catch (error) {
      console.error("Telegram alert failed:", error);
      if (attempt > 0) return false;
      await wait(500);
    }
  }
  return false;
}
```

- [ ] **3.6** Same file, the nudge. Before:

```ts
      const results = await Promise.all(
        Array.from({ length: 10 }, () => sendTelegram(`🚨 Nudge from ${name}`)),
      );
      return { sent: results.every(Boolean) };
```

After:

```ts
      // One after another. Ten at the same instant trips Telegram's flood limit, which then also
      // refuses the ordinary alerts that follow.
      let delivered = 0;
      for (let i = 0; i < NUDGE_MESSAGES; i++) {
        if (!(await sendTelegram(`🚨 Nudge from ${name}`))) break;
        delivered++;
        if (i < NUDGE_MESSAGES - 1) await wait(NUDGE_GAP_MS);
      }
      return { sent: delivered > 0 };
```

- [ ] **3.7** Same file. Replace everything from the comment line `/** Sends a chat photo/video/file (or GIF link) to the Telegram channel. Caller must be able to read the message (RLS). */` to the end of the file with:

```ts
/** Sends a chat photo/video/file (or GIF/sticker) to the Telegram channel. Caller must be able to read the message (RLS). */
export const shareToTelegram = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  // `url` is still accepted from older app copies but no longer used: the link is read from the message itself.
  .validator((input: { messageId: string; url?: string; compressedPath?: string }) => ({
    messageId: String(input.messageId),
    compressedPath: input.compressedPath ? String(input.compressedPath) : undefined,
  }))
  .handler(async ({ data, context }) => {
    const token = process.env["T_BOT"];
    if (!token) throw new Error("Telegram bot is not configured.");
    const chatId = process.env["T_CHAT_ID"] || DEFAULT_CHAT_ID;
    const { data: msg, error } = await context.supabase
      .from("messages")
      .select("id, type, media_url, content, view_once, view_once_opened_at, receiver_id, deleted_for_everyone")
      .eq("id", data.messageId)
      .maybeSingle();
    if (error || !msg || msg.deleted_for_everyone) throw new Error("Message not found.");
    if (msg.view_once) {
      // Only the watched account may share view-once media it received and opened
      // (senders are told so when they send it).
      const { data: caller } = await context.supabase
        .from("profiles")
        .select("user_id")
        .eq("id", context.userId)
        .maybeSingle();
      const kept = caller?.user_id === WATCHED_USER_ID && msg.receiver_id === context.userId && !!msg.view_once_opened_at;
      if (!kept) throw new Error("View-once media can't be shared.");
    }

    type Failure = { status: number; reason: string } | null;
    // Returns null on success, otherwise Telegram's own explanation.
    const send = async (method: string, init: RequestInit): Promise<Failure> => {
      let res: Response;
      try {
        res = await fetch(`https://api.telegram.org/bot${token}/${method}`, { ...init, method: "POST" });
      } catch (cause) {
        console.error(`Telegram ${method} failed:`, cause);
        return { status: 0, reason: "could not reach Telegram" };
      }
      if (res.ok) {
        await res.body?.cancel();
        return null;
      }
      const body = await res.text();
      console.error(`Telegram ${method} failed:`, res.status, body);
      try {
        return { status: res.status, reason: String(JSON.parse(body).description) };
      } catch {
        return { status: res.status, reason: `HTTP ${res.status}` };
      }
    };

    // An upload needs the file's exact size. When the server does not state one (or the body is
    // compressed on the way, so the stated size is wrong), read it, up to the limit, to find out.
    const sized = async (res: Response, limit: number): Promise<UploadFile | null> => {
      if (!res.ok || !res.body) {
        await res.body?.cancel();
        return null;
      }
      const type = res.headers.get("content-type") ?? "";
      const declared = res.headers.get("content-encoding") ? 0 : Number(res.headers.get("content-length")) || 0;
      if (declared > 0) return { body: res.body, size: declared, type };
      const reader = res.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > limit) {
          await reader.cancel();
          return { body: new Blob([]).stream(), size: total, type };
        }
        chunks.push(value);
      }
      const blob = new Blob(chunks as BlobPart[], { type });
      return { body: blob.stream(), size: blob.size, type };
    };

    // `open` is called once per attempt, because a stream can only be read once.
    const upload = async (open: () => Promise<UploadFile | null>, filename: string, limit: number, messageType: string): Promise<"sent" | "too-big"> => {
      let file = await open();
      if (!file) throw new Error("Could not read this file from storage.");
      if (file.size > limit) {
        await file.body.cancel();
        return "too-big";
      }
      const { size, type } = file;
      let failure: Failure = null;
      // Each route falls through to the next, ending with a plain file.
      for (const route of telegramRoutes(messageType, type, filename, size)) {
        file ??= await open();
        if (!file) throw new Error("Could not read this file from storage.");
        const request = await telegramUpload({ chat_id: chatId }, route.field, filename, file);
        file = null;
        failure = await send(route.method, request);
        if (!failure) return "sent";
        // Only a 400 is about this file. Anything else (bad token, bot not in channel) won't change on retry.
        if (failure.status !== 400) break;
      }
      throw new Error(`Telegram did not accept the file: ${failure?.reason ?? "unknown error"}`);
    };

    const lastSegment = (path: string, fallback: string) => {
      try {
        return decodeURIComponent(path.split("/").pop() || "") || fallback;
      } catch {
        return fallback;
      }
    };

    // GIFs and stickers from the picker have no stored file, only a link kept in the message.
    if (!msg.media_url) {
      if (msg.type !== "gif" && msg.type !== "sticker") throw new Error("This message has no file to send.");
      let link = "";
      try {
        link = String((JSON.parse(msg.content ?? "") as { url?: unknown }).url ?? "");
      } catch {
        // not JSON: no link
      }
      // NAUGHTY stickers live in the private bucket, which Telegram cannot reach: upload the file itself.
      if (link.startsWith(NAUGHTY_PATH)) {
        const result = await upload(
          async () => sized(await serveNaughty(new Request(new URL(link, "https://app.invalid"))), TELEGRAM_FILE_MAX_BYTES),
          lastSegment(link, `sticker-${msg.id}`),
          TELEGRAM_FILE_MAX_BYTES,
          "image",
        );
        if (result === "too-big") throw new Error("This sticker is over Telegram's 50 MB limit.");
        return { sent: true };
      }
      let host = "";
      try {
        const parsed = new URL(link);
        if (parsed.protocol === "https:") host = parsed.hostname;
      } catch {
        // not a link
      }
      // Public web addresses only (a name with a dot, not a bare number or a local name).
      if (!/^(?=.*[a-z])[a-z0-9.-]+\.[a-z]{2,}$/i.test(host)) throw new Error("This message has no file to send.");
      // Telegram fetches a public link itself. That works for GIF and MP4.
      const failure = await send("sendAnimation", {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, animation: link }),
      });
      if (!failure) return { sent: true };
      if (failure.status !== 400) throw new Error(`Telegram did not accept the file: ${failure.reason}`);
      // Anything else (WebP stickers, files Telegram could not fetch) is downloaded here and uploaded.
      const result = await upload(
        async () => sized(await fetch(link, { signal: AbortSignal.timeout(20_000) }), TELEGRAM_FILE_MAX_BYTES),
        lastSegment(new URL(link).pathname, `media-${msg.id}`),
        TELEGRAM_FILE_MAX_BYTES,
        "image",
      );
      if (result === "too-big") throw new Error("This file is over Telegram's 50 MB limit.");
      return { sent: true };
    }

    // Stored media is uploaded directly. Sending Telegram a link instead caps photos at 5 MB and
    // other files at 20 MB, and sendDocument by link only works for GIF, PDF and ZIP.
    // A compressed copy is the caller's own temporary upload of this message's media.
    if (data.compressedPath && (!data.compressedPath.startsWith(`${context.userId}/`) || data.compressedPath.includes("..")))
      throw new Error("Invalid compressed file.");
    const mediaPath = data.compressedPath ?? msg.media_url;
    const { data: signed } = await context.supabase.storage.from("chat-media").createSignedUrl(mediaPath, 600);
    if (!signed?.signedUrl) throw new Error("Could not read this file from storage.");
    const signedUrl = signed.signedUrl;
    // Too big for Telegram: the browser shrinks it and calls again with compressedPath.
    const limit = data.compressedPath ? TELEGRAM_FILE_MAX_BYTES : TELEGRAM_TARGET_BYTES;
    const result = await upload(async () => sized(await fetch(signedUrl), limit), lastSegment(mediaPath, `media-${msg.id}`), limit, msg.type);
    if (result === "too-big") {
      if (data.compressedPath) throw new Error("The compressed file is still over Telegram's 50 MB limit.");
      return { sent: false, needsCompression: true };
    }
    return { sent: true };
  });
```

- [ ] **3.8** `src/lib/security.ts`, in `secureLogout`. Before:

```ts
  try { sessionStorage.clear(); } catch {}
  try { await supabase.auth.signOut(); } catch {}
```

After:

```ts
  try { sessionStorage.clear(); } catch {}
  // Mark offline while still signed in. After sign-out the database refuses the update, the account
  // looked online for another minute, and Telegram alerts for messages sent in that minute were skipped.
  try {
    const { data } = await supabase.auth.getSession();
    const uid = data.session?.user.id;
    if (uid) {
      await Promise.race([
        supabase.from("profiles").update({ is_online: false }).eq("id", uid).then(() => undefined, () => undefined),
        new Promise<void>((resolve) => window.setTimeout(resolve, 1500)),
      ]);
    }
  } catch {}
  try { await supabase.auth.signOut(); } catch {}
```

- [ ] **3.9 Check.** Test command from 0.2: `# pass 3`. `npx tsc --noEmit` and `npm run lint`: no new errors. Security: confirm `shareToTelegram` no longer reads `data.url` (search the file for `data.url`: nothing).

## Phase 4. Lazy media (fault 11, part of 10)

- [ ] **4.1** `src/lib/supabase.ts`. Before:

```ts
const urlCache = new Map<string, { url: string; exp: number }>();
export async function signedUrl(path: string) {
  const c = urlCache.get(path);
```

After:

```ts
const urlCache = new Map<string, { url: string; exp: number }>();
let presigning: Promise<void> = Promise.resolve();

/** Signs many media paths in one request and remembers them: a page of messages costs one request, not one per photo. */
export function presign(paths: string[]) {
  presigning = presigning
    .then(async () => {
      const wanted = [...new Set(paths)].filter((path) => (urlCache.get(path)?.exp ?? 0) <= Date.now());
      if (!wanted.length) return;
      const { data } = await supabase.storage.from("chat-media").createSignedUrls(wanted, 3600);
      for (const row of data ?? []) {
        if (row.path && row.signedUrl) urlCache.set(row.path, { url: row.signedUrl, exp: Date.now() + 3500_000 });
      }
    })
    .catch(() => {});
  return presigning;
}

export async function signedUrl(path: string) {
  // A batch may be signing this very path right now.
  await presigning;
  const c = urlCache.get(path);
```

Then, at the end of the same file's `bus` section, after `export const emitMsg = …;` add:

```ts
/** Tells open screens that the live connection came back, so they fetch what they missed. */
export const emitResync = () => bus.dispatchEvent(new Event("resync"));
```

- [ ] **4.2** Replace the whole of `src/components/chat/Media.tsx` with:

```tsx
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
```

- [ ] **4.3** `src/components/chat/Conversation.tsx`, three edits.

(a) Import line 4. Before: `import { supabase, type Message, type Profile, bus, emitMsg, pairFilter, signedUrl } from "@/lib/supabase";`
After: `import { supabase, type Message, type Profile, bus, emitMsg, pairFilter, presign, signedUrl } from "@/lib/supabase";`

(b) Import line 13. Before: `import { AudioPlayer, ImageThumb, useSigned, VideoPlayer } from "./Media";`
After: `import { AudioPlayer, ImageThumb, useNearView, useSigned, VideoPlayer } from "./Media";`

(c) `GalleryThumb` near the end of the file. Before:

```tsx
  const url = useSigned(path);
  if (!url) return <span className="block h-full w-full animate-pulse bg-muted" />;
```

After:

```tsx
  // The gallery can hold hundreds of items: sign and load each one only when it scrolls into view.
  const [ref, near] = useNearView<HTMLSpanElement>();
  const url = useSigned(path, near);
  if (!url) return <span ref={ref} className="block h-full w-full animate-pulse bg-muted" />;
```

(d) GIF/sticker bubble in `MessageRow`. Before:

```tsx
                <img src={attachment.url} alt={attachment.title || m.type} className="max-h-72 max-w-64 object-cover" />
```

After:

```tsx
                <img src={attachment.url} alt={attachment.title || m.type} loading="lazy" decoding="async" className="h-56 w-56 max-w-full object-contain" />
```

- [ ] **4.4 Check.** `npx tsc --noEmit` and `npm run lint`: no new errors.

## Phase 5. Chat scroll, history and reconnect (faults 10, 11, 12, 13). File: `src/components/chat/Conversation.tsx` unless stated

- [ ] **5.1** State and refs. Before: `  const [msgs, setMsgs] = useState<Message[]>([]);`
After:

```ts
  const [msgs, setMsgs] = useState<Message[]>([]);
  const msgsRef = useRef<Message[]>([]);
  msgsRef.current = msgs;
```

Before: `  const scroller = useRef<HTMLDivElement>(null);`
After:

```ts
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
```

- [ ] **5.2** Directly above `const load = useCallback(async (before?: string) => {` add:

```ts
  const loadReactions = useCallback(async (ids: string[]) => {
    // In batches: hundreds of ids in one request make its address too long.
    for (let i = 0; i < ids.length; i += 100) {
      const batch = ids.slice(i, i + 100);
      const { data: reactionRows, error: reactionError } = await supabase.from("message_reactions").select("*").in("message_id", batch);
      if (reactionError) {
        console.error("Could not load message reactions:", reactionError);
        return;
      }
      setReactions((current) => [...current.filter((reaction) => !batch.includes(reaction.message_id)), ...(reactionRows ?? [])]);
    }
  }, []);
```

- [ ] **5.3** In `load`. Before:

```ts
    let q = supabase.from("messages").select("*").or(pairFilter(me.id, peer.id)).order("created_at", { ascending: false }).limit(PAGE);
    if (before) q = q.lt("created_at", before);
    const { data } = await q;
    const rows = ((data ?? []) as Message[]).reverse();
    setHasMore(rows.length === PAGE);
```

After:

```ts
    // Messages already deleted for me are left out by the database, so a page is a full page of
    // real messages (a cleared chat used to load page after page of hidden ones).
    let q = supabase.from("messages").select("*").or(pairFilter(me.id, peer.id)).not("deleted_for", "cs", `{${me.id}}`).order("created_at", { ascending: false }).limit(PAGE);
    if (before) q = q.lt("created_at", before);
    const { data, error } = await q;
    if (error) {
      console.error("Could not load messages:", error);
      loadingRef.current = false;
      setLoading(false);
      if (!before) toast.error("Could not load this chat. Check your connection.");
      return;
    }
    const rows = ((data ?? []) as Message[]).reverse();
    setHasMore(rows.length === PAGE);
    // One request signs every photo, video and voice note on this page.
    void presign(rows.flatMap((row) => (row.media_url && !row.view_once ? [row.media_url] : [])));
```

Then, still in `load`, replace the block that starts `    if (rows.length) {` and ends with its closing `    }` (the reactions query, 15 lines) with the single line:

```ts
    await loadReactions(rows.map((message) => message.id));
```

- [ ] **5.4** After the "Live updates" effect (the one ending `}, [peer.id, me.id, markRead]);`) add:

```ts
  // After the live connection drops and comes back, fetch what was missed while it was down.
  useEffect(() => {
    const resync = async () => {
      const { data } = await supabase.from("messages").select("*").or(pairFilter(me.id, peer.id)).not("deleted_for", "cs", `{${me.id}}`).order("created_at", { ascending: false }).limit(PAGE);
      const known = new Map(msgsRef.current.map((m) => [m.id, m]));
      for (const row of ((data ?? []) as Message[]).reverse()) {
        const old = known.get(row.id);
        const changed = !old || old.status !== row.status || old.content !== row.content || old.deleted_for_everyone !== row.deleted_for_everyone || old.pinned_at !== row.pinned_at || old.view_once_opened_at !== row.view_once_opened_at;
        if (changed) emitMsg(row);
      }
    };
    const run = () => void resync();
    bus.addEventListener("resync", run);
    return () => bus.removeEventListener("resync", run);
  }, [me.id, peer.id]);
```

- [ ] **5.5** After the `useLayoutEffect(() => { … }, [msgs]);` block that handles `pendingScrollId` and `prevHeight` (leave that block unchanged) add:

```ts
  // Photos finishing loading, the typing dots and the keyboard opening all change heights without
  // any new message. While the user is at the bottom, stay there.
  useEffect(() => {
    const el = scroller.current;
    const inner = content.current;
    if (!el || !inner || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (keepBottom.current && !pendingScrollId.current) el.scrollTop = el.scrollHeight;
    });
    observer.observe(inner);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
```

- [ ] **5.6** Replace the whole `onScroll` block. Before:

```ts
  const onScroll = () => {
    const el = scroller.current;
    // Start fetching older messages well before the top so scrolling up doesn't stall.
    if (el && el.scrollTop < Math.max(600, el.clientHeight * 1.5) && hasMore && !loadingRef.current && msgs.length) void load(msgs[0]!.created_at);
    if (el) {
      const fromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      setShowDown(fromBottom > 300);
      if (fromBottom < 150) setNewBelow(0);
    }
  };
```

After:

```ts
  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const fromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    // Follow the newest message only while the user is actually at the bottom. This used to change
    // only when a message arrived, so a tick, an edit or a delete while reading older messages
    // jumped the chat to the bottom.
    keepBottom.current = fromBottom < 150;
    // Start fetching older messages well before the top so scrolling up doesn't stall.
    if (el.scrollTop < Math.max(600, el.clientHeight * 1.5) && hasMore && !loadingRef.current && msgs.length) void load(msgs[0]!.created_at);
    setShowDown(fromBottom > 300);
    if (fromBottom < 150) setNewBelow(0);
  };
```

- [ ] **5.7** Replace the whole `openSearchResult` block. Before:

```ts
  const openSearchResult = (message: Message) => {
    if (msgs.some((item) => item.id === message.id)) {
      messageElements.current.get(message.id)?.scrollIntoView({ block: "center" });
      setSearchOpen(false);
      return;
    }
    keepBottom.current = false;
    pendingScrollId.current = message.id;
    setMsgs((current) => {
      const next = current.some((item) => item.id === message.id) ? current : [...current, message];
      return next.sort((a, b) => a.created_at.localeCompare(b.created_at));
    });
    setSearchOpen(false);
  };
```

After:

```ts
  // Jumping to an older message (search, pin, gallery) loads everything between it and the messages
  // already shown. Inserting only that one message left a silent gap in the middle of the chat.
  const loadBackTo = async (target: Message) => {
    if (loadingRef.current) return false;
    loadingRef.current = true;
    setLoading(true);
    const older: Message[] = [];
    let before = msgsRef.current[0]?.created_at ?? new Date(Date.now() + 60_000).toISOString();
    let reached = false;
    for (let page = 0; page < 4 && !reached; page++) {
      const { data, error } = await supabase.from("messages").select("*").or(pairFilter(me.id, peer.id)).not("deleted_for", "cs", `{${me.id}}`).lt("created_at", before).gte("created_at", target.created_at).order("created_at", { ascending: false }).limit(500);
      if (error) break;
      const rows = (data ?? []) as Message[];
      older.push(...rows);
      if (rows.length < 500) reached = true;
      else before = rows[rows.length - 1]!.created_at;
    }
    loadingRef.current = false;
    setLoading(false);
    if (!reached) {
      toast("That message is too far back to jump to. Scroll up to reach it.");
      return false;
    }
    older.reverse();
    keepBottom.current = false;
    pendingScrollId.current = target.id;
    void presign(older.flatMap((row) => (row.media_url && !row.view_once ? [row.media_url] : [])));
    setMsgs((current) => {
      const have = new Set(current.map((item) => item.id));
      return [...older.filter((item) => !have.has(item.id)), ...current];
    });
    void loadReactions(older.map((item) => item.id));
    return true;
  };

  const openSearchResult = (message: Message) => {
    setSearchOpen(false);
    if (msgs.some((item) => item.id === message.id)) {
      messageElements.current.get(message.id)?.scrollIntoView({ block: "center" });
      flashMessage(message.id);
      return;
    }
    void loadBackTo(message).then((ok) => { if (ok) flashMessage(message.id); });
  };
```

- [ ] **5.8** Replace the whole `jumpToPinned` block. Before:

```ts
  const jumpToPinned = (message: Message) => {
    if (msgs.some((item) => item.id === message.id)) {
      messageElements.current.get(message.id)?.scrollIntoView({ block: "center", behavior: "smooth" });
    } else {
      keepBottom.current = false;
      pendingScrollId.current = message.id;
      setMsgs((current) => [...current, message].sort((a, b) => a.created_at.localeCompare(b.created_at)));
    }
    flashMessage(message.id);
  };
```

After:

```ts
  const jumpToPinned = (message: Message) => {
    if (msgs.some((item) => item.id === message.id)) {
      messageElements.current.get(message.id)?.scrollIntoView({ block: "center", behavior: "smooth" });
      flashMessage(message.id);
    } else {
      void loadBackTo(message).then((ok) => { if (ok) flashMessage(message.id); });
    }
  };
```

- [ ] **5.9** JSX, the message list. Before:

```tsx
      <div ref={scroller} onScroll={onScroll} className="h-full overflow-y-auto overflow-x-hidden overscroll-contain px-3 py-4 md:px-[8%]">
        {rows.map(({ m, day, first }) => (
```

After (scroll anchoring is switched off because this code already keeps the position itself when older messages are added; with both active the list can shift twice):

```tsx
      <div ref={scroller} onScroll={onScroll} className="h-full overflow-y-auto overflow-x-hidden overscroll-contain px-3 py-4 [overflow-anchor:none] md:px-[8%]">
        <div ref={content}>
        {rows.map(({ m, day, first }) => (
```

Before:

```tsx
        )}
      </div>
      {(showDown || newBelow > 0) && (
```

After:

```tsx
        )}
        </div>
      </div>
      {(showDown || newBelow > 0) && (
```

- [ ] **5.10** JSX, the composer. Delete this whole line (the resize observer from 5.5 now keeps the chat at the bottom when the keyboard opens, and only when the user was at the bottom):

```tsx
          onFocus={() => setTimeout(() => { const el = scroller.current; if (el) el.scrollTop = el.scrollHeight; }, 300)}
```

- [ ] **5.11** `src/components/chat/ChatApp.tsx`, four edits.

(a) Import. Before: `import { supabase, type Message, type Profile, emitMsg, bus, hideChatForMe, pairFilter } from "@/lib/supabase";`
After: `import { supabase, type Message, type Profile, emitMsg, emitResync, bus, hideChatForMe, pairFilter } from "@/lib/supabase";`

(b) Directly above the comment line `  // Load profiles & previews` add:

```ts
  // Last message and unread count for every chat. Runs at the start and again whenever the live connection comes back.
  const loadPreviews = useCallback(async (others: Profile[]) => {
    const l: Record<string, Message | undefined> = {};
    const u: Record<string, number> = {};
    await Promise.all(
      others.map(async (p) => {
        const [{ data: m }, { count }] = await Promise.all([
          supabase.from("messages").select("*").or(pairFilter(userId, p.id)).not("deleted_for", "cs", `{${userId}}`).order("created_at", { ascending: false }).limit(1),
          supabase.from("messages").select("id", { count: "exact", head: true }).eq("sender_id", p.id).eq("receiver_id", userId).neq("status", "read").neq("type", "call"),
        ]);
        l[p.id] = (m?.[0] as Message) ?? undefined;
        // The open chat is being read right now, so it has nothing unread.
        u[p.id] = selRef.current === p.id && document.visibilityState === "visible" ? 0 : count ?? 0;
      }),
    );
    setLast(l);
    setUnread(u);
    // mark everything received as delivered
    supabase.from("messages").update({ status: "delivered", delivered_at: new Date().toISOString() }).eq("receiver_id", userId).eq("status", "sent").then();
  }, [userId]);
```

(c) In the "Load profiles & previews" effect. Before (from `const l: Record…` to the delivered update, inclusive):

```ts
      const l: Record<string, Message | undefined> = {};
      const u: Record<string, number> = {};
      await Promise.all(
        others.map(async (p) => {
          const [{ data: m }, { count }] = await Promise.all([
            supabase.from("messages").select("*").or(pairFilter(userId, p.id)).not("deleted_for", "cs", `{${userId}}`).order("created_at", { ascending: false }).limit(1),
            supabase.from("messages").select("id", { count: "exact", head: true }).eq("sender_id", p.id).eq("receiver_id", userId).neq("status", "read").neq("type", "call"),
          ]);
          l[p.id] = (m?.[0] as Message) ?? undefined;
          u[p.id] = count ?? 0;
        }),
      );
      setLast(l);
      setUnread(u);
      // mark everything received as delivered
      supabase.from("messages").update({ status: "delivered", delivered_at: new Date().toISOString() }).eq("receiver_id", userId).eq("status", "sent").then();
    })();
  }, [userId]);
```

After:

```ts
      await loadPreviews(others);
    })();
  }, [userId, loadPreviews]);
```

(d) In the "Message stream" effect. Before:

```ts
    const ch = supabase
      .channel("messages-" + meId)
```

After:

```ts
    let dropped = false;
    const ch = supabase
      .channel("messages-" + meId)
```

Before:

```ts
        if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          console.error("Message realtime subscription failed:", status, error);
        }
      });
```

After:

```ts
        if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          console.error("Message realtime subscription failed:", status, error);
          dropped = true;
        } else if (status === "SUBSCRIBED" && dropped) {
          // Back after a drop: messages sent meanwhile were never delivered here, so fetch them.
          dropped = false;
          void loadPreviews(allRef.current.filter((p) => p.id !== meId));
          emitResync();
        }
      });
```

Before (the end of that effect): `  }, [me?.id, mutedRef]);` After: `  }, [me?.id, mutedRef, loadPreviews]);`

- [ ] **5.12 Check.** `npx tsc --noEmit` and `npm run lint`: no new errors. In `Conversation.tsx`, search for `onFocus={() => setTimeout`: nothing. Search for `ref={content}`: one match.

## Phase 6. Chat header on phones (fault 14). File: `src/components/chat/Conversation.tsx`

- [ ] **6.1** The non-selection header (the `<header>` that contains `onClick={onBack}`). Before: `className="box-content flex h-16 shrink-0 items-center gap-2 border-b bg-card px-2 pt-[env(safe-area-inset-top)] md:gap-3 md:px-4"` After: `className="box-content flex h-16 shrink-0 items-center gap-1 border-b bg-card px-2 pt-[env(safe-area-inset-top)] md:gap-3 md:px-4"`

- [ ] **6.2** In that same header only, for the nudge button, the video call button, the voice call button and the chat menu `DropdownMenuTrigger` (four elements): in the `className`, replace the text `flex h-11 w-11 items-center` with `flex h-10 w-10 items-center md:h-11 md:w-11`. Do not change the Back button or the selection header. Check: the non-selection header then contains `h-10 w-10` exactly four times.

- [ ] **6.3** The gallery button. Before:

```tsx
        <button onClick={() => void openGallery()} className="flex h-11 w-11 items-center justify-center rounded-full text-muted-foreground active:bg-muted md:hover:bg-muted" aria-label="Shared media gallery" title="Shared media, audio and links"><Images className="h-5 w-5" /></button>
```

After (hidden on phones, where it moves into the menu):

```tsx
        <button onClick={() => void openGallery()} className="hidden h-11 w-11 items-center justify-center rounded-full text-muted-foreground active:bg-muted md:flex md:hover:bg-muted" aria-label="Shared media gallery" title="Shared media, audio and links"><Images className="h-5 w-5" /></button>
```

- [ ] **6.4** The chat menu. Before:

```tsx
            <DropdownMenuItem onClick={() => { setSearchQuery(""); setSearchResults([]); setSearchOpen(true); }}><Search className="mr-2 h-4 w-4" />Search messages</DropdownMenuItem>
```

After:

```tsx
            <DropdownMenuItem className="md:hidden" onClick={() => void openGallery()}><Images className="mr-2 h-4 w-4" />Media, audio and links</DropdownMenuItem>
            <DropdownMenuItem onClick={() => { setSearchQuery(""); setSearchResults([]); setSearchOpen(true); }}><Search className="mr-2 h-4 w-4" />Search messages</DropdownMenuItem>
```

## Phase 7. Final checks

- [ ] **7.1** `npx tsc --noEmit`: no new errors against the baseline.
- [ ] **7.2** `npm run lint`: no new errors.
- [ ] **7.3** Test command from 0.2: `# pass 3`, `# fail 0`.
- [ ] **7.4** `npm run build`: succeeds (same result as baseline or better).
- [ ] **7.5** `git status --short`: only these paths changed or added: `src/lib/ice.ts`, `src/lib/ice.functions.ts`, `src/lib/tones.ts`, `src/lib/supabase.ts`, `src/lib/security.ts`, `src/lib/telegram.functions.ts`, `src/lib/telegram-upload.ts` (new), `src/components/chat/Calls.tsx`, `src/components/chat/Media.tsx`, `src/components/chat/Conversation.tsx`, `src/components/chat/ChatApp.tsx`, `tests/telegram-upload.test.ts` (new), `docs/plans/` (this file), plus `src/routeTree.gen.ts`, which was already modified before this work and must be left as it is.
- [ ] **7.6** Security pass: no secret values in code or logs; `getTurnServers` and `shareToTelegram` both keep `requireSupabaseAuth`; the only new outbound requests are to `rtc.live.cloudflare.com`, `api.telegram.org` and the link stored in the user's own message.
- [ ] **7.7** Fill in "Result" at the bottom. Report to the owner with the label `BUILDING DONE. Next: commit` only if 7.1 to 7.6 all passed; otherwise say what stopped.

## 8. Acceptance criteria

1. Type check, lint, build and the three unit tests pass (no new errors against the baseline).
2. `Calls.tsx` never removes a channel from inside a status callback and never awaits a cached "subscribed" promise.
3. A call's ring timeout starts when the call screen appears; relay loading can delay the offer by at most 4 seconds.
4. A failed call always shows a message, and names the missing relay when none is configured.
5. `shareToTelegram` never holds a whole stored file in memory when `FixedLengthStream` exists.
6. A message status change while scrolled up does not move the scroll position (by code: `keepBottom` is set in `onScroll`).

## 9. Owner test list after publishing (two phones, two accounts)

1. Voice call and video call with both phones on Wi-Fi. Then with one phone on mobile data. Then both on mobile data (needs the relay from section 2).
2. During a video call: switch camera, mute, minimise, end. Decline a call. Let a call ring out.
3. If a call fails, note the message shown. In a desktop browser the console line `[call] connected: local …, remote …` shows whether the relay was used.
4. Send to Telegram: a photo, a 30 to 45 MB video, a GIF, a sticker, a NAUGHTY sticker.
5. Send two nudges 15 seconds apart, then a normal message: the message alert must still arrive.
6. Open a long chat: it opens at the newest message, scrolling up loads older messages without jumping, photos appear as they come into view.
7. Scroll up, have the other phone read a message (tick changes): the view must not move.
8. Search for an old message and open it: the messages between it and today are all there.
9. Turn Wi-Fi off for 20 seconds while the other phone sends two messages, then on: both appear without reloading.

## Baseline (executor fills in at step 0)

- tsc: pass (0 errors).
- lint: fails on 12,109 prettier line-ending (CRLF) errors that exist in every file; ignoring those, 26 problems (counted with `npx eslint . -f json`, rule not `prettier/prettier`). "No new errors" is checked against that 26.
- build: pass.
- test command: Node v26.13.0, so `node --test tests/telegram-upload.test.ts`.
- Executor note: new code avoids empty `catch {}` blocks (lint `no-empty`) by putting a comment inside.

## Errors (executor fills in if a step fails twice)

## Result (executor fills in at step 7.7)

- 2026-11-27, built on Opus 5.5 at the owner's explicit request (instead of Sonnet). Phases 1 to 6 applied as written. One fix during the build: `let mode` in `switchCam` needed the type `"user" | "environment"`.
- tsc: pass. Unit tests: 3 pass, 0 fail. Lint: 26 problems excluding prettier line endings, same as the baseline (no new kinds). Build: pass.
- Client bundle checked: no `rtc.live.cloudflare.com`, `api.telegram.org` or R2 host in `.output/public`, so the server-only code and secret handling stayed on the server.
- Changed files match the 7.5 list. `src/routeTree.gen.ts` was already modified before this work and was left as it was.
- Not verified here: calls, Telegram sending and scrolling on real devices (no local database). The owner's test list is in section 9.
- Not committed or published.
