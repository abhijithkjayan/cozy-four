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
