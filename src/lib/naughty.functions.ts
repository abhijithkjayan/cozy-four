import { createServerFn } from "@tanstack/react-start";
import { listNaughtyKeys, naughtyUrl, relativeKey } from "./r2";

// NAUGHTY stickers from the private R2 bucket. Top-level folders become tags; `query` matches file paths.
const PER_PAGE = 48;

type Sticker = { id: string; title: string; url: string };

export const naughtyStickers = createServerFn({ method: "GET" })
  .validator((input: { query?: string; folder?: string; page?: number }) => ({
    query: String(input.query || "").trim().toLowerCase().slice(0, 100),
    folder: String(input.folder || "").slice(0, 200),
    page: Math.min(Math.max(0, Math.floor(Number(input.page) || 0)), 1000),
  }))
  .handler(async ({ data }): Promise<{ items: Sticker[]; folders: string[]; total: number }> => {
    const keys = (await listNaughtyKeys().catch(() => [])).map((key) => ({ key, rel: relativeKey(key) }));
    const folders = [...new Set(keys.map(({ rel }) => (rel.includes("/") ? rel.split("/")[0]! : "")).filter(Boolean))];
    const matches = keys.filter(({ rel }) =>
      (!data.folder || rel.startsWith(`${data.folder}/`)) && (!data.query || rel.toLowerCase().includes(data.query)));
    const items = matches.slice(data.page * PER_PAGE, (data.page + 1) * PER_PAGE).map(({ key, rel }) => ({
      id: `r2-${rel}`,
      title: rel.slice(rel.lastIndexOf("/") + 1).replace(/\.[^.]+$/, "").replace(/[_-]+/g, " "),
      url: naughtyUrl(key),
    }));
    return { items, folders, total: matches.length };
  });
