import { createServerFn } from "@tanstack/react-start";

// GIFs/stickers are combined from KLIPY (connector gateway) and Giphy, interleaved and de-duplicated.
// Empty query = trending. Giphy uses rating "r" so romance/kiss results are included.
// `page` starts at 0 for "Load more".
const GATEWAY_URL = "https://connector-gateway.lovable.dev/klipy";
const PER_PAGE = 50;

type Out = {
  id: string;
  title: string;
  images: { fixed_width: { url: string }; fixed_width_small: { url: string }; original: { url: string } };
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


export const giphySearch = createServerFn({ method: "GET" })
  .validator((input: { query: string; kind: "gif" | "sticker"; page?: number }) => ({
    query: String(input.query || "").trim().slice(0, 100),
    kind: input.kind === "sticker" ? ("sticker" as const) : ("gif" as const),
    page: Math.min(Math.max(0, Math.floor(Number(input.page) || 0)), 40),
  }))
  .handler(async ({ data }): Promise<{ items: Out[] }> => {
    const [a, b] = await Promise.all([
      fromKlipy(data.query, data.kind, data.page).catch(() => []),
      fromGiphy(data.query, data.kind, data.page).catch(() => []),
    ]);
    const out: Out[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      for (const item of [a[i], b[i]]) {
        if (item && !seen.has(item.images.original.url)) { seen.add(item.images.original.url); out.push(item); }
      }
    }
    return { items: out };
  });
