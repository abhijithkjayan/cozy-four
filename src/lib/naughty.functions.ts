import { createServerFn } from "@tanstack/react-start";
import { listNaughtyKeys, naughtyUrl, relativeKey } from "./r2";

// NAUGHTY stickers from the private R2 bucket. Each top-level folder is its own tab ("/" = files at the
// bucket root); `query` matches file paths inside the open folder.
const PER_PAGE = 48;
export const ROOT_FOLDER = "/";

type Sticker = { id: string; title: string; url: string };
type Result = { items: Sticker[]; folders: string[]; folder: string; total: number; error?: string };

export const naughtyStickers = createServerFn({ method: "GET" })
  .validator((input: { query?: string; folder?: string; page?: number }) => ({
    query: String(input.query || "").trim().toLowerCase().slice(0, 100),
    folder: String(input.folder || "").slice(0, 200),
    page: Math.min(Math.max(0, Math.floor(Number(input.page) || 0)), 1000),
  }))
  .handler(async ({ data }): Promise<Result> => {
    const listed = await listNaughtyKeys().catch((e: unknown) => ({ keys: [], error: `R2 list failed: ${String(e)}` }));
    const keys = listed.keys.map((key) => ({ key, rel: relativeKey(key), dir: "" }));
    for (const k of keys) k.dir = k.rel.includes("/") ? k.rel.split("/")[0]! : ROOT_FOLDER;
    const folders = [...new Set(keys.map((k) => k.dir))].sort((a, b) => (a === ROOT_FOLDER ? 1 : b === ROOT_FOLDER ? -1 : a.localeCompare(b)));
    const folder = folders.includes(data.folder) ? data.folder : (folders[0] ?? "");
    const matches = keys.filter((k) => k.dir === folder && (!data.query || k.rel.toLowerCase().includes(data.query)));
    const items = matches.slice(data.page * PER_PAGE, (data.page + 1) * PER_PAGE).map(({ key, rel }) => ({
      id: `r2-${rel}`,
      title: rel.slice(rel.lastIndexOf("/") + 1).replace(/\.[^.]+$/, "").replace(/[_-]+/g, " "),
      url: naughtyUrl(key),
    }));
    return { items, folders, folder, total: matches.length, ...(listed.error ? { error: listed.error } : {}) };
  });
