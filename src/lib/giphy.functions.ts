import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

// GIFs/stickers are combined from KLIPY (connector gateway) and Giphy, interleaved and de-duplicated.
// Empty query = trending. Both use their most permissive setting (Giphy rating "r", KLIPY content
// filter off) so romantic and adult (18+) results are included. `page` starts at 0 for "Load more".
const GATEWAY_URL = "https://connector-gateway.lovable.dev/klipy";
const PER_PAGE = 50;

type Out = {
  id: string;
  title: string;
  images: { fixed_width: { url: string }; fixed_width_small: { url: string }; original: { url: string } };
  // RedGifs clips are MP4 videos: `video` is what plays, images hold the poster.
  video?: string;
  redgifsId?: string;
};
type Variant = { url?: string };
type KlipyItem = { id: number | string; title?: string; file?: Record<string, Record<string, Variant>> };
type GiphyItem = { id: string; title: string; images: { fixed_width: Variant; fixed_width_small: Variant; original: Variant; downsized?: Variant } };

const pick = (file: KlipyItem["file"], sizes: string[]) => {
  if (!file) return "";
  for (const k of [...sizes, ...Object.keys(file)]) {
    const f = file[k];
    const url = f?.["gif"]?.url || f?.["webp"]?.url;
    if (url) return url;
  }
  return "";
};

async function fromKlipy(query: string, kind: "gif" | "sticker", page: number): Promise<Out[]> {
  const lovableKey = process.env["LOVABLE_API_KEY"];
  const klipyKey = process.env["KLIPY_API_KEY"];
  if (!lovableKey || !klipyKey) return [];
  const media = kind === "sticker" ? "stickers" : "gifs";
  const params = new URLSearchParams({
    customer_id: "ontario-isp",
    per_page: String(PER_PAGE),
    page: String(page + 1),
    content_filter: "off",
    ...(query ? { q: query } : {}),
  });
  const res = await fetch(`${GATEWAY_URL}/${media}/${query ? "search" : "trending"}?${params}`, {
    headers: { Authorization: `Bearer ${lovableKey}`, "X-Connection-Api-Key": klipyKey },
  });
  if (!res.ok) { console.error(`KLIPY failed [${res.status}]: ${await res.text()}`); return []; }
  const body = (await res.json()) as { result?: boolean; data?: { data?: KlipyItem[] } };
  if (!body.result) return [];
  return (body.data?.data ?? []).map((item) => {
    const full = pick(item.file, ["hd", "md", "400", "320"]);
    const mid = pick(item.file, ["md", "sm", "320", "240"]);
    const small = pick(item.file, ["sm", "xs", "240", "md"]);
    return { id: `k-${item.id}`, title: item.title ?? "", images: { fixed_width: { url: mid || full }, fixed_width_small: { url: small || mid }, original: { url: mid || full } } };
  }).filter((i) => i.images.original.url);
}

async function fromGiphy(query: string, kind: "gif" | "sticker", page: number): Promise<Out[]> {
  const key = process.env["GIPHY_API_KEY"];
  if (!key) return [];
  const base = kind === "sticker" ? "stickers" : "gifs";
  const params = new URLSearchParams({
    api_key: key,
    limit: String(PER_PAGE),
    offset: String(page * PER_PAGE),
    rating: "r",
    ...(query ? { q: query } : {}),
  });
  const res = await fetch(`https://api.giphy.com/v1/${base}/${query ? "search" : "trending"}?${params}`);
  if (!res.ok) { console.error(`Giphy failed [${res.status}]`); return []; }
  const body = (await res.json()) as { data?: GiphyItem[] };
  return (body.data ?? []).map((g) => ({
    id: `g-${g.id}`,
    title: g.title,
    images: {
      fixed_width: { url: g.images.fixed_width?.url ?? "" },
      fixed_width_small: { url: g.images.fixed_width_small?.url ?? g.images.fixed_width?.url ?? "" },
      original: { url: g.images.downsized?.url || g.images.original?.url || "" },
    },
  })).filter((i) => i.images.original.url);
}

// --- RedGifs (explicit clips, mixed into the GIF results). Its media links only work for the
// IP address and browser they were requested for, so every call passes the viewer's IP and
// user agent (user-addr / user-agent); links fetched for the server itself would fail with 403.
const REDGIFS_API = "https://api.redgifs.com/v2";
let redgifsToken: { value: string; agent: string; at: number } | null = null;
// After a 429 the server waits out RedGifs' requested delay instead of retrying straight away.
let redgifsBlockedUntil = 0;
type Viewer = { ip: string; agent: string };

function viewer(): Viewer {
  try {
    const headers = getRequest().headers;
    const ip =
      headers.get("cf-connecting-ip") ||
      headers.get("x-real-ip") ||
      headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
      "";
    return { ip, agent: headers.get("user-agent") || "Mozilla/5.0" };
  } catch {
    return { ip: "", agent: "Mozilla/5.0" };
  }
}

async function redgifsFetch(path: string, who: Viewer, retry = true): Promise<Response> {
  const waitSecs = Math.ceil((redgifsBlockedUntil - Date.now()) / 1000);
  if (waitSecs > 0) throw new Error(`rate limited, try again in ${waitSecs}s`);
  const headers = { "User-Agent": who.agent, Referer: "https://www.redgifs.com/", Origin: "https://www.redgifs.com" };
  if (!redgifsToken || redgifsToken.agent !== who.agent || Date.now() - redgifsToken.at > 12 * 60 * 60 * 1000) {
    const res = await fetch(`${REDGIFS_API}/auth/temporary`, { headers });
    if (!res.ok) throw new Error(`RedGifs auth failed [${res.status}]: ${await res.text()}`);
    const body = (await res.json()) as { token?: string };
    if (!body.token) throw new Error("RedGifs auth returned no token");
    redgifsToken = { value: body.token, agent: who.agent, at: Date.now() };
  }
  const sep = path.includes("?") ? "&" : "?";
  const forViewer = new URLSearchParams({ "user-agent": who.agent, ...(who.ip ? { "user-addr": who.ip } : {}) });
  const res = await fetch(`${REDGIFS_API}${path}${sep}${forViewer}`, {
    headers: { ...headers, Authorization: `Bearer ${redgifsToken.value}` },
  });
  if ((res.status === 401 || res.status === 403) && retry) {
    redgifsToken = null;
    return redgifsFetch(path, who, false);
  }
  if (res.status === 429) {
    const body = (await res.clone().json().catch(() => null)) as { error?: { delay?: number } } | null;
    redgifsBlockedUntil = Date.now() + Math.min(Math.max(Number(body?.error?.delay) || 60, 10), 600) * 1000;
  }
  return res;
}

type RedgifsGif = { id: string; tags?: string[]; urls?: { sd?: string; hd?: string; poster?: string; thumbnail?: string } };

const fromRedgifsGif = (g: RedgifsGif): Out => {
  const poster = g.urls?.thumbnail || g.urls?.poster || "";
  return {
    id: `r-${g.id}`,
    title: (g.tags ?? []).slice(0, 3).join(", "),
    images: { fixed_width: { url: poster }, fixed_width_small: { url: poster }, original: { url: g.urls?.sd || g.urls?.hd || "" } },
    video: g.urls?.sd || g.urls?.hd || "",
    redgifsId: g.id,
  };
};

async function fromRedgifs(query: string, page: number): Promise<Out[]> {
  const params = new URLSearchParams({
    search_text: query || "couple",
    order: query ? "top" : "trending",
    count: String(PER_PAGE),
    page: String(page + 1),
  });
  const res = await redgifsFetch(`/gifs/search?${params}`, viewer());
  if (!res.ok) {
    const detail = (await res.text()).replace(/\s+/g, " ").slice(0, 160);
    throw new Error(`HTTP ${res.status}${detail ? `: ${detail}` : ""}`);
  }
  const body = (await res.json()) as { gifs?: RedgifsGif[] };
  return (body.gifs ?? []).map(fromRedgifsGif).filter((g) => g.video);
}

/** Server fallback when the browser can't reach RedGifs itself (see redgifs-client.ts). */
export const redgifsSearch = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .validator((input: { query: string; page?: number }) => ({
    query: String(input.query || "").trim().slice(0, 100),
    page: Math.min(Math.max(0, Math.floor(Number(input.page) || 0)), 40),
  }))
  .handler(async ({ data }): Promise<{ items: Out[]; error: string | null }> => {
    try {
      return { items: await fromRedgifs(data.query, data.page), error: null };
    } catch (error) {
      console.error("RedGifs search failed:", error);
      return { items: [], error: error instanceof Error ? error.message : String(error) };
    }
  });

/** Fresh playable link (for this viewer) for a RedGifs clip, e.g. when a saved one has expired. */
export const redgifsUrl = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .validator((input: { id: string }) => ({ id: String(input.id || "").replace(/[^a-z0-9]/gi, "").slice(0, 80) }))
  .handler(async ({ data }) => {
    if (!data.id) return null;
    try {
      const res = await redgifsFetch(`/gifs/${data.id.toLowerCase()}`, viewer());
      if (!res.ok) { console.error(`RedGifs gif failed [${res.status}]`); return null; }
      const body = (await res.json()) as { gif?: RedgifsGif };
      if (!body.gif) return null;
      const item = fromRedgifsGif(body.gif);
      return { video: item.video ?? "", poster: item.images.fixed_width.url };
    } catch (error) {
      console.error("RedGifs gif failed:", error);
      return null;
    }
  });

export const giphySearch = createServerFn({ method: "GET" })
  // adult: false leaves RedGifs out (e.g. the Game of Thrones tab, which is GIPHY/KLIPY only).
  .validator((input: { query: string; kind: "gif" | "sticker"; page?: number; adult?: boolean }) => ({
    query: String(input.query || "").trim().slice(0, 100),
    kind: input.kind === "sticker" ? ("sticker" as const) : ("gif" as const),
    page: Math.min(Math.max(0, Math.floor(Number(input.page) || 0)), 40),
    adult: input.adult !== false,
  }))
  .handler(async ({ data }): Promise<{ items: Out[]; redgifsError: string | null }> => {
    let redgifsError: string | null = null;
    const [a, b, c] = await Promise.all([
      fromKlipy(data.query, data.kind, data.page).catch(() => []),
      fromGiphy(data.query, data.kind, data.page).catch(() => []),
      data.kind === "gif" && data.adult
        ? fromRedgifs(data.query, data.page).catch((error: unknown) => {
            console.error("RedGifs search failed:", error);
            redgifsError = error instanceof Error ? error.message : String(error);
            return [] as Out[];
          })
        : Promise.resolve([] as Out[]),
    ]);
    const out: Out[] = [];
    const seen = new Set<string>();
    // Adult clips first in each round so they aren't buried under ordinary GIFs.
    for (let i = 0; i < Math.max(a.length, b.length, c.length); i++) {
      for (const item of [c[i], a[i], b[i]]) {
        if (item && !seen.has(item.images.original.url)) { seen.add(item.images.original.url); out.push(item); }
      }
    }
    return { items: out, redgifsError };
  });

