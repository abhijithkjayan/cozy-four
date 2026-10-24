import { useEffect, useState } from "react";
import { LoaderCircle, Play, Search, X } from "lucide-react";
import { giphySearch, redgifsUrl } from "@/lib/giphy.functions";

type GiphyItem = {
  id: string;
  title: string;
  video?: string;
  redgifsId?: string;
  images: {
    fixed_width: { url: string };
    fixed_width_small: { url: string };
    original: { url: string };
  };
};

export type PickedGif = { url: string; preview: string; title: string; video?: boolean; redgifsId?: string };

type GiphyPickerProps = {
  onSelect: (item: PickedGif, kind: "gif" | "sticker") => void;
  onClose: () => void;
};

type Tab = "gif" | "sticker";
// One grid item for every source: a still or animated preview, plus what gets sent.
type Tile = { id: string; title: string; thumb: string; video: boolean; send: PickedGif };

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
  { label: "Sexy", q: "sexy" },
  { label: "Seductive", q: "seductive" },
  { label: "Hot", q: "hot" },
  { label: "Naughty", q: "naughty" },
  { label: "Passionate", q: "passionate" },
  { label: "Sensual", q: "sensual" },
  { label: "Make out", q: "make out" },
  { label: "Making love", q: "making love" },
  { label: "Bed", q: "couple in bed" },
  { label: "Lingerie", q: "lingerie" },
  { label: "Teasing", q: "tease" },
  { label: "Shower", q: "shower" },
  { label: "Morning", q: "morning sex" },
  { label: "Rough", q: "rough" },
  { label: "Oral", q: "oral" },
  { label: "Riding", q: "riding" },
  { label: "Amateur couple", q: "amateur couple" },
  { label: "Funny", q: "funny" },
  { label: "Reactions", q: "reaction" },
];

const toTile = (item: GiphyItem): Tile =>
  item.video
    ? {
        id: item.id,
        title: item.title,
        thumb: item.images.fixed_width.url,
        video: true,
        send: { url: item.video, preview: item.images.fixed_width.url, title: item.title, video: true, ...(item.redgifsId ? { redgifsId: item.redgifsId } : {}) },
      }
    : {
        id: item.id,
        title: item.title,
        thumb: item.images.fixed_width.url,
        video: false,
        send: { url: item.images.original.url, preview: item.images.fixed_width_small.url, title: item.title },
      };

/** Preview tile; a clip whose preview link was refused asks once for a fresh one. */
function TileImage({ tile }: { tile: Tile }) {
  const [src, setSrc] = useState(tile.thumb);
  const [retried, setRetried] = useState(false);
  const onError = () => {
    if (retried || !tile.send.redgifsId) return;
    setRetried(true);
    void redgifsUrl({ data: { id: tile.send.redgifsId } }).then((fresh) => {
      if (!fresh) return;
      setSrc(fresh.poster);
      tile.send.url = fresh.video;
      tile.send.preview = fresh.poster;
    });
  };
  return src ? <img src={src} alt={tile.title || "GIF"} loading="lazy" onError={onError} className="h-full w-full object-cover" /> : null;
}

export function GiphyPicker({ onSelect, onClose }: GiphyPickerProps) {
  const [tab, setTab] = useState<Tab>("gif");
  const [query, setQuery] = useState("");
  const [input, setInput] = useState("");
  const [items, setItems] = useState<Tile[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);

  const fetchPage = async (pageNumber: number): Promise<Tile[]> => {
    const q = query || DEFAULT_QUERY;
    return ((await giphySearch({ data: { query: q, kind: tab, page: pageNumber } })) as GiphyItem[]).map(toTile);
  };

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    setPage(0);
    setHasMore(true);
    fetchPage(0)
      .then((tiles) => {
        if (!active) return;
        setItems(tiles);
        setHasMore(tiles.length > 0);
      })
      .catch(() => active && setError("Could not load GIFs."))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fetchPage only depends on query and tab
  }, [query, tab]);

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

  const switchTab = (value: Tab) => {
    setTab(value);
    setInput("");
    setQuery("");
    setItems([]);
  };

  const tags = tab === "gif" ? TAGS : TAGS.slice(0, 13);

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-3 sm:items-center" onClick={onClose}>
      <div className="flex max-h-[min(80vh,620px)] w-full max-w-lg flex-col overflow-hidden rounded-2xl bg-card shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3 border-b px-4 py-3">
          <div className="flex-1 font-semibold">GIFs & stickers</div>
          <button onClick={onClose} className="flex h-9 w-9 items-center justify-center rounded-full text-muted-foreground hover:bg-muted" aria-label="Close GIF picker"><X className="h-5 w-5" /></button>
        </div>
        <div className="flex gap-1 border-b px-4 pt-2">
          {([["gif", "GIFs"], ["sticker", "Stickers"]] as const).map(([value, label]) => (
            <button key={value} onClick={() => switchTab(value)} className={`border-b-2 px-3 py-2 text-sm font-medium ${tab === value ? "border-primary text-primary" : "border-transparent text-muted-foreground"}`}>{label}</button>
          ))}
        </div>
            <form onSubmit={(e) => { e.preventDefault(); setQuery(input.trim()); }} className="m-3 flex items-center gap-2 rounded-lg bg-muted px-3">
              <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
              <input value={input} onChange={(e) => setInput(e.target.value)} className="min-w-0 flex-1 bg-transparent py-2 text-sm outline-none" placeholder="Search GIFs" aria-label="Search GIFs" />
            </form>
            <div className="-mt-1 flex gap-1.5 overflow-x-auto px-3 pb-2">
              {tags.map((t) => (
                <button key={t.label} type="button" onClick={() => { setInput(t.q); setQuery(t.q); }} className={`shrink-0 rounded-full px-3 py-1 text-xs font-medium ${query === t.q ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:bg-muted/70"}`}>{t.label}</button>
              ))}
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
              {loading && <div className="flex justify-center py-8 text-muted-foreground"><LoaderCircle className="h-6 w-6 animate-spin" /></div>}
              {error && <p className="px-3 py-8 text-center text-sm text-muted-foreground">{error}</p>}
              {!loading && !error && !items.length && <p className="px-3 py-8 text-center text-sm text-muted-foreground">No results.</p>}
              {!loading && !error && <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                {items.map((item) => (
                  <button key={item.id} onClick={() => onSelect(item.send, tab)} className="relative aspect-square overflow-hidden rounded-lg bg-muted focus:outline-none focus:ring-2 focus:ring-ring" aria-label={`Send ${item.title || "GIF"}`}>
                    <TileImage tile={item} />
                    {item.video && <span className="absolute bottom-1 right-1 flex h-5 w-5 items-center justify-center rounded-full bg-black/60 text-white"><Play className="h-3 w-3" /></span>}
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
        <div className="px-4 pb-3 text-right text-[10px] text-muted-foreground">{tab === "gif" ? "Powered by KLIPY, GIPHY & RedGifs" : "Powered by KLIPY & GIPHY"}</div>
      </div>
    </div>
  );
}
