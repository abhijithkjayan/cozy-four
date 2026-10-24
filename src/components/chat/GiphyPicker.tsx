import { useEffect, useState } from "react";
import { LoaderCircle, Search, TriangleAlert, X } from "lucide-react";
import { giphySearch } from "@/lib/giphy.functions";
import { naughtyStickers } from "@/lib/naughty.functions";

type GiphyItem = {
  id: string;
  title: string;
  images: {
    fixed_width: { url: string };
    fixed_width_small: { url: string };
    original: { url: string };
  };
};

export type PickedGif = { url: string; preview: string; title: string };

type GiphyPickerProps = {
  userId: string;
  onSelect: (item: PickedGif, kind: "gif" | "sticker") => void;
  onClose: () => void;
};

type Tab = "gif" | "got" | "others" | "sticker" | "naughty";
// One grid item for every source: a still or animated preview, plus what gets sent.
type Tile = { id: string; title: string; thumb: string; send: PickedGif };

const DEFAULT_QUERY = "";
const TAGS = [
  { label: "Trending", q: "" },
  { label: "Kiss", q: "kiss" },
  { label: "Couple", q: "couple" },
  { label: "Intimacy", q: "passionate kiss" },
  { label: "Romance", q: "romance" },
  { label: "Romantic", q: "romantic couple" },
  { label: "Love", q: "love" },
  { label: "Hug", q: "hug" },
  { label: "Cuddle", q: "cuddle" },
  { label: "Miss you", q: "miss you" },
  { label: "Good night", q: "good night love" },
  { label: "Flirty", q: "flirty" },
  { label: "Wink", q: "wink" },
  { label: "Movie kiss", q: "movie kiss" },
  { label: "Movie romance", q: "romantic movie scene" },
  { label: "Movie love scene", q: "movie love scene" },
  { label: "Funny", q: "funny" },
  { label: "Reactions", q: "reaction" },
];
// Others tab: the theme tags, opening on the first one.
const OTHERS_TAGS = TAGS.filter((t) => t.q);
const OTHERS_DEFAULT = OTHERS_TAGS[0]?.q ?? "kiss";

// Game of Thrones tab (GIPHY and KLIPY only). Empty query = the whole series.
const GOT_ALL = "game of thrones";
const GOT_TAGS = [
  { label: "All", q: "" },
  { label: "Daenerys", q: "daenerys targaryen" },
  { label: "Jon Snow", q: "jon snow" },
  { label: "Tyrion", q: "tyrion lannister" },
  { label: "Cersei", q: "cersei lannister" },
  { label: "Arya", q: "arya stark" },
  { label: "Sansa", q: "sansa stark" },
  { label: "Jaime", q: "jaime lannister" },
  { label: "Khal Drogo", q: "khal drogo" },
  { label: "Dragons", q: "game of thrones dragon" },
  { label: "Night King", q: "night king" },
  { label: "Winter is coming", q: "winter is coming" },
  { label: "Shame", q: "game of thrones shame" },
  { label: "Hodor", q: "hodor" },
  { label: "Joffrey", q: "joffrey" },
  { label: "Bran", q: "bran stark" },
  { label: "Ned Stark", q: "ned stark" },
  { label: "Brienne", q: "brienne of tarth" },
  { label: "The Hound", q: "the hound game of thrones" },
  { label: "Iron Throne", q: "iron throne" },
  { label: "Battle", q: "game of thrones battle" },
  { label: "Love", q: "game of thrones love" },
  { label: "Kiss", q: "game of thrones kiss" },
  { label: "House of the Dragon", q: "house of the dragon" },
];

const toTile = (item: GiphyItem): Tile => ({
  id: item.id,
  title: item.title,
  thumb: item.images.fixed_width.url,
  send: { url: item.images.original.url, preview: item.images.fixed_width_small.url, title: item.title },
});

/** Preview tile; one that can't load stays blank instead of showing a broken image. */
function TileImage({ tile }: { tile: Tile }) {
  const [src, setSrc] = useState(tile.thumb);
  return src ? <img src={src} alt={tile.title || "GIF"} loading="lazy" onError={() => setSrc("")} className="h-full w-full object-cover" /> : null;
}

export function GiphyPicker({ userId, onSelect, onClose }: GiphyPickerProps) {
  const [tab, setTab] = useState<Tab>("gif");
  const [query, setQuery] = useState("");
  const [input, setInput] = useState("");
  const [items, setItems] = useState<Tile[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  // NAUGHTY stickers come from the private R2 bucket; the tab shows a warning every time it is opened.
  const [naughtyWarn, setNaughtyWarn] = useState(false);
  const [naughtyFolders, setNaughtyFolders] = useState<string[]>([]);
  const [prevTab, setPrevTab] = useState<Tab>("gif");

  const fetchPage = async (pageNumber: number): Promise<Tile[]> => {
    if (tab === "naughty") {
      const folder = query.startsWith("folder:") ? query.slice(7) : "";
      const result = await naughtyStickers({ data: { query: folder ? "" : query, folder, page: pageNumber } });
      setNaughtyFolders(result.folders);
      return result.items.map((s) => ({ id: s.id, title: s.title, thumb: s.url, send: { url: s.url, preview: s.url, title: s.title } }));
    }
    const q = tab === "got" ? query || GOT_ALL : tab === "others" ? query || OTHERS_DEFAULT : query || DEFAULT_QUERY;
    const result = await giphySearch({ data: { query: q, kind: tab === "sticker" ? "sticker" : "gif", page: pageNumber } });
    return (result.items as GiphyItem[]).map(toTile);
  };

  useEffect(() => {
    if (tab === "naughty" && naughtyWarn) return;
    let active = true;
    setError(null);
    setPage(0);
    setHasMore(true);
    setLoading(true);
    fetchPage(0)
      .then((tiles) => {
        if (!active) return;
        setItems(tiles);
        setHasMore(tiles.length > 0);
      })
      .catch(() => active && setError(tab === "naughty" ? "Could not load NAUGHTY stickers." : "Could not load GIFs."))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fetchPage depends on query, tab, and userId
  }, [query, tab, userId, naughtyWarn]);

  const loadMore = () => {
    if (loadingMore) return;
    const next = page + 1;
    setLoadingMore(true);
    fetchPage(next)
      .then((fresh) => {
        setItems((current) => {
          const seen = new Set(current.map((item) => item.id));
          return [...current, ...fresh.filter((item) => !seen.has(item.id))];
        });
        setPage(next);
        setHasMore(fresh.length > 0);
      })
      .catch(() => setHasMore(false))
      .finally(() => setLoadingMore(false));
  };

  const updateTab = (value: Tab) => {
    setTab(value);
    setInput("");
    setQuery(value === "others" ? OTHERS_DEFAULT : "");
    setItems([]);
  };

  const switchTab = (value: Tab) => {
    if (value === "naughty") {
      if (tab !== "naughty") setPrevTab(tab);
      setNaughtyWarn(true);
    }
    updateTab(value);
  };

  // GIFs is trending + search only; the theme tags live under Others.
  const tags = tab === "gif" ? [] : tab === "got" ? GOT_TAGS : tab === "others" ? OTHERS_TAGS
    : tab === "naughty" ? (naughtyFolders.length > 1 ? [{ label: "All", q: "" }, ...naughtyFolders.map((f) => ({ label: f, q: `folder:${f}` }))] : [])
    : TAGS.slice(0, 13);

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-3 sm:items-center" onClick={onClose}>
      <div className="flex max-h-[min(80vh,620px)] w-full max-w-lg flex-col overflow-hidden rounded-2xl bg-card shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex shrink-0 items-center gap-3 border-b px-4 py-3">
          <div className="flex-1 font-semibold">GIFs & stickers</div>
          <button onClick={onClose} className="flex h-9 w-9 items-center justify-center rounded-full text-muted-foreground hover:bg-muted" aria-label="Close GIF picker"><X className="h-5 w-5" /></button>
        </div>
        <div className="flex shrink-0 gap-1 border-b px-4 pt-2">
          {([["gif", "GIFs"], ["got", "GOT"], ["others", "Others"], ["sticker", "Stickers"], ["naughty", "NAUGHTY"]] as const).map(([value, label]) => {
            const active = tab === value;
            const naughty = value === "naughty";
            return <button key={value} onClick={() => switchTab(value)} className={`border-b-2 px-3 py-2 text-sm font-medium ${active ? (naughty ? "border-destructive text-destructive" : "border-primary text-primary") : naughty ? "border-transparent text-destructive/80" : "border-transparent text-muted-foreground"}`}>{label}</button>;
          })}
        </div>
        {tab === "naughty" && naughtyWarn ? (
          <div role="alertdialog" aria-labelledby="naughty-warn-title" className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-10 text-center">
            <TriangleAlert className="h-12 w-12 text-destructive" />
            <div id="naughty-warn-title" className="text-xl font-extrabold tracking-wide text-destructive">NAUGHTY</div>
            <p className="text-base font-semibold">HANDLE at Your RISK</p>
            <p className="max-w-xs text-sm text-muted-foreground">Explicit 18+ stickers. Open only if you are an adult and the person you are chatting with is fine with it.</p>
            <div className="mt-2 flex gap-2">
              <button type="button" onClick={() => { setNaughtyWarn(false); updateTab(prevTab); }} className="rounded-lg bg-muted px-4 py-2 text-sm font-medium text-muted-foreground hover:bg-muted/70">Go back</button>
              <button type="button" onClick={() => setNaughtyWarn(false)} className="rounded-lg bg-destructive px-4 py-2 text-sm font-semibold text-destructive-foreground hover:bg-destructive/90">I understand, show</button>
            </div>
          </div>
        ) : (<>
            <form onSubmit={(e) => { e.preventDefault(); setQuery(input.trim()); }} className="m-3 flex shrink-0 items-center gap-2 rounded-lg bg-muted px-3">
              <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
              <input value={input} onChange={(e) => setInput(e.target.value)} className="min-w-0 flex-1 bg-transparent py-2 text-sm outline-none" placeholder={tab === "naughty" ? "Search NAUGHTY stickers" : "Search GIFs"} aria-label={tab === "naughty" ? "Search NAUGHTY stickers" : "Search GIFs"} />
            </form>
            {tags.length > 0 && <div className="flex shrink-0 gap-2 overflow-x-auto border-b px-3 pb-3 pt-0.5 [scrollbar-width:none]">
              {tags.map((t) => (
                <button key={t.label} type="button" onClick={() => { setInput(t.q); setQuery(t.q); }} className={`shrink-0 whitespace-nowrap rounded-full px-3 py-1.5 text-xs font-medium ${query === t.q ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:bg-muted/70"}`}>{t.label}</button>
              ))}
            </div>}
            <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3 pt-3">
              {loading && <div className="flex justify-center py-8 text-muted-foreground"><LoaderCircle className="h-6 w-6 animate-spin" /></div>}
              {!loading && !error && tab === "naughty" && items.length === 0 && (
                <p role="status" className="py-8 text-center text-sm text-muted-foreground">No NAUGHTY stickers found.</p>
              )}
              {!loading && error && (
                <p role="status" className="py-8 text-center text-sm text-muted-foreground">
                  {error}
                </p>
              )}
              {!loading && !error && <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                {items.map((item) => (
                  <button key={item.id} onClick={() => onSelect(item.send, tab === "sticker" || tab === "naughty" ? "sticker" : "gif")} className="relative aspect-square overflow-hidden rounded-lg bg-muted focus:outline-none focus:ring-2 focus:ring-ring" aria-label={`Send ${item.title || "GIF"}`}>
                    <TileImage tile={item} />
                  </button>
                ))}
              </div>}
              {!loading && !error && items.length > 0 && hasMore && (
                <button type="button" onClick={loadMore} disabled={loadingMore} className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg bg-muted py-2 text-sm font-medium text-muted-foreground hover:bg-muted/70 disabled:opacity-60">
                  {loadingMore && <LoaderCircle className="h-4 w-4 animate-spin" />}
                  {loadingMore ? "Loading…" : "Load more"}
                </button>
              )}
            </div>
        </>)}
        <div className="px-4 pb-3 text-right text-[10px] text-muted-foreground">
          {tab === "naughty" ? "NAUGHTY · HANDLE at Your RISK" : "Powered by KLIPY & GIPHY"}
        </div>
      </div>
    </div>
  );
}
