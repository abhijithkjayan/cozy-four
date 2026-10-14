import { createServerFn } from "@tanstack/react-start";

// GIFs and stickers come from KLIPY via the connector gateway; results are mapped to the shape the picker expects.
const GATEWAY_URL = "https://connector-gateway.lovable.dev/klipy";

type Variant = { url?: string };
type KlipyItem = { id: number | string; title?: string; file?: Record<string, Record<string, Variant>> };

const pick = (file: KlipyItem["file"], sizes: string[]) => {
  if (!file) return "";
  const keys = [...sizes, ...Object.keys(file)];
  for (const k of keys) {
    const f = file[k];
    const url = f?.gif?.url || f?.webp?.url;
    if (url) return url;
  }
  return "";
};

export const giphySearch = createServerFn({ method: "GET" })
  .validator((input: { query: string; kind: "gif" | "sticker" }) => ({
    query: String(input.query || "").slice(0, 100),
    kind: input.kind === "sticker" ? ("sticker" as const) : ("gif" as const),
  }))
  .handler(async ({ data }) => {
    const lovableKey = process.env.LOVABLE_API_KEY;
    const klipyKey = process.env.KLIPY_API_KEY;
    if (!lovableKey || !klipyKey) throw new Error("GIFs are not configured on the server.");
    const media = data.kind === "sticker" ? "stickers" : "gifs";
    const params = new URLSearchParams({ q: data.query || "funny", customer_id: "ontario-isp", per_page: "24" });
    const response = await fetch(`${GATEWAY_URL}/${media}/search?${params}`, {
      headers: { Authorization: `Bearer ${lovableKey}`, "X-Connection-Api-Key": klipyKey },
    });
    if (!response.ok) {
      const body = await response.text();
      console.error(`KLIPY request failed [${response.status}]: ${body}`);
      throw new Error(`KLIPY request failed [${response.status}]`);
    }
    const body = (await response.json()) as { result?: boolean; data?: { data?: KlipyItem[] } };
    if (!body.result) throw new Error("KLIPY returned an error.");
    return (body.data?.data ?? [])
      .map((item) => {
        const full = pick(item.file, ["hd", "md", "400", "320"]);
        const mid = pick(item.file, ["md", "sm", "320", "240"]);
        const small = pick(item.file, ["sm", "xs", "240", "md"]);
        return {
          id: String(item.id),
          title: item.title ?? "",
          images: { fixed_width: { url: mid || full }, fixed_width_small: { url: small || mid }, original: { url: mid || full } },
        };
      })
      .filter((i) => i.images.original.url);
  });
