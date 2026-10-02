import { getTurnServers } from "./ice.functions";

// Public STUN servers (direct connections). TURN relays are added from server config when available.
export const ICE_SERVERS: RTCIceServer[] = [
  { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302", "stun:stun2.l.google.com:19302"] },
  { urls: "stun:stun.cloudflare.com:3478" },
];

let cached: Promise<RTCIceServer[]> | null = null;
export function loadIceServers(): Promise<RTCIceServer[]> {
  if (!cached) {
    cached = getTurnServers()
      .then((turn) => [...ICE_SERVERS, ...turn])
      .catch(() => {
        cached = null;
        return ICE_SERVERS;
      });
  }
  return cached;
}
