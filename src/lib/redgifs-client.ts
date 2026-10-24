// RedGifs straight from the viewer's browser. Searching from the server hit RedGifs' rate limit,
// which counts per IP address and the server shares Cloudflare's addresses with many other sites
// (HTTP 429 "RateLimited"). From the device each person gets their own limit, and media links,
// which only work for the IP and browser that asked for them, play without any extra steps.
// If the browser can't reach the API (blocked network, CORS), callers fall back to the server.
import { redgifsUrl } from "@/lib/giphy.functions";

const API = "https://api.redgifs.com/v2";
const TOKEN_KEY = "redgifs-token";
const TOKEN_MAX_AGE_MS = 12 * 60 * 60 * 1000;
const PER_PAGE = 50;

export type RedgifsItem = {
  id: string;
  title: string;
  images: { fixed_width: { url: string }; fixed_width_small: { url: string }; original: { url: string } };
  video: string;
  redgifsId: string;
};

type RedgifsGif = { id: string; tags?: string[]; urls?: { sd?: string; hd?: string; poster?: string; thumbnail?: string } };

let memoryToken: { value: string; at: number } | null = null;

function readStoredToken() {
  if (memoryToken) return memoryToken;
  try {
    const raw = sessionStorage.getItem(TOKEN_KEY);
    if (raw) memoryToken = JSON.parse(raw) as { value: string; at: number };
  } catch {
    /* Storage can be unavailable; the token then lives in memory only. */
  }
  return memoryToken;
}

async function token(fresh = false) {
  const stored = fresh ? null : readStoredToken();
  if (stored && Date.now() - stored.at < TOKEN_MAX_AGE_MS) return stored.value;
  const res = await fetch(`${API}/auth/temporary`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as { token?: string };
  if (!body.token) throw new Error("no token");
  memoryToken = { value: body.token, at: Date.now() };
  try {
    sessionStorage.setItem(TOKEN_KEY, JSON.stringify(memoryToken));
  } catch {
    /* See readStoredToken. */
  }
  return body.token;
}

async function call(path: string) {
  let res = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${await token()}` } });
  if (res.status === 401) res = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${await token(true)}` } });
  if (!res.ok) {
    const detail = (await res.text()).replace(/\s+/g, " ").slice(0, 160);
    throw new RedgifsHttpError(`HTTP ${res.status}${detail ? `: ${detail}` : ""}`);
  }
  return res.json() as Promise<unknown>;
}

/** RedGifs answered with an error (as opposed to the browser not reaching it at all). */
export class RedgifsHttpError extends Error {}

const toItem = (g: RedgifsGif): RedgifsItem => {
  const poster = g.urls?.thumbnail || g.urls?.poster || "";
  const video = g.urls?.sd || g.urls?.hd || "";
  return {
    id: `r-${g.id}`,
    title: (g.tags ?? []).slice(0, 3).join(", "),
    images: { fixed_width: { url: poster }, fixed_width_small: { url: poster }, original: { url: video } },
    video,
    redgifsId: g.id,
  };
};

export async function searchRedgifsDirect(query: string, page: number): Promise<RedgifsItem[]> {
  const params = new URLSearchParams({
    search_text: query || "couple",
    order: "trending",
    count: String(PER_PAGE),
    page: String(page + 1),
  });
  const body = (await call(`/gifs/search?${params}`)) as { gifs?: RedgifsGif[] };
  return (body.gifs ?? []).map(toItem).filter((g) => g.video);
}

export async function redgifsGifDirect(id: string): Promise<{ video: string; poster: string } | null> {
  const body = (await call(`/gifs/${encodeURIComponent(id.toLowerCase())}`)) as { gif?: RedgifsGif };
  if (!body.gif) return null;
  const item = toItem(body.gif);
  return { video: item.video, poster: item.images.fixed_width.url };
}

/** Fresh link for a clip: from the device first, then the server. */
export async function freshRedgifs(id: string) {
  try {
    const direct = await redgifsGifDirect(id);
    if (direct) return direct;
  } catch {
    /* Fall back to the server below. */
  }
  return redgifsUrl({ data: { id } }).catch(() => null);
}
