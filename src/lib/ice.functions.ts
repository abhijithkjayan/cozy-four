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
