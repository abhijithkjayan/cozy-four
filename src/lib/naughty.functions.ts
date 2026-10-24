import { createServerFn } from "@tanstack/react-start";
import { listNaughtyKeys, naughtyUrl, relativeKey } from "./r2";

// NAUGHTY stickers from the private R2 bucket. Each folder is its own tab ("/" = files at the bucket root);
// `query` matches file names inside the open folder, or across every folder when folder is ALL_FOLDERS.
const PER_PAGE = 48;
export const ROOT_FOLDER = "/";
export const ALL_FOLDERS = "*";
// Tab order for the bucket folders; any other folder follows these alphabetically.
const FOLDER_ORDER = ["He", "She", "Kiss", "Front", "Doggy", "Climax", "Close", "Body", "Oil", "Misc"];
const rank = (f: string) => {
  const i = FOLDER_ORDER.findIndex((o) => o.toLowerCase() === f.toLowerCase());
  return f === ROOT_FOLDER ? FOLDER_ORDER.length + 1 : i < 0 ? FOLDER_ORDER.length : i;
};
// A file belongs to the first folder in its path named in FOLDER_ORDER (so they may sit inside a parent
// folder), else to its top-level folder.
function folderOf(rel: string) {
  const dirs = rel.split("/").slice(0, -1);
  const named = dirs.find((d) => rank(d) < FOLDER_ORDER.length);
  return named ? FOLDER_ORDER[rank(named)]! : (dirs[0] ?? ROOT_FOLDER);
}

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
    for (const k of keys) k.dir = folderOf(k.rel);
    const folders = [...new Set(keys.map((k) => k.dir))].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
    const folder = data.folder === ALL_FOLDERS || folders.includes(data.folder) ? data.folder : (folders[0] ?? "");
    const name = (rel: string) => rel.slice(rel.lastIndexOf("/") + 1).toLowerCase().replace(/[_-]+/g, " ");
    const matches = keys.filter((k) => (folder === ALL_FOLDERS || k.dir === folder) && (!data.query || name(k.rel).includes(data.query.replace(/[_-]+/g, " "))));
    const items = matches.slice(data.page * PER_PAGE, (data.page + 1) * PER_PAGE).map(({ key, rel }) => ({
      id: `r2-${rel}`,
      title: rel.slice(rel.lastIndexOf("/") + 1).replace(/\.[^.]+$/, "").replace(/[_-]+/g, " "),
      url: naughtyUrl(key),
    }));
    return { items, folders, folder, total: matches.length, ...(listed.error ? { error: listed.error } : {}) };
  });
