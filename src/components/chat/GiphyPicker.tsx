import { useEffect, useState } from "react";
import { LoaderCircle, Play, Search, X } from "lucide-react";
import { giphySearch, redgifsSearch, type AdultGif } from "@/lib/giphy.functions";

type GiphyItem = {
  id: string;
  title: string;
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

type Tab = "gif" | "sticker" | "adult";
// One grid item for every source: a still or animated preview, plus what gets sent.
type Tile = { id: string; title: string; thumb: string; video: boolean; send: PickedGif };

const DEFAULT_QUERY = "";
const ADULT_OK_KEY = "gif-adult-ok";
const TAGS = [
  { label: "Trending", q: "" },
  { label: "Kiss", q: "kiss" },
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
  { label: "Sexy 18+", q: "sexy" },
  { label: "Seductive 18+", q: "seductive" },
  { label: "Hot 18+", q: "hot" },
  { label: "Naughty 18+", q: "naughty" },
  { label: "Make out 18+", q: "make out" },
  { label: "Bed 18+", q: "couple in bed" },
  { label: "Lingerie 18+", q: "lingerie" },
  { label: "Funny", q: "funny" },
  { label: "Reactions", q: "reaction" },
];
// Explicit tab (RedGifs). Empty query = trending couple clips.
const ADULT_TAGS = [
  { label: "Trending", q: "" },
  { label: "Couple", q: "couple" },
  { label: "Passionate", q: "passionate" },
  { label: "Romantic", q: "romantic" },
  { label: "Sensual", q: "sensual" },
  { label: "Kissing", q: "kissing" },
  { label: "Making love", q: "making love" },
  { label: "Teasing", q: "tease" },
  { label: "Lingerie", q: "lingerie" },
  { label: "Shower", q: "shower" },
  { label: "Morning", q: "morning sex" },
  { label: "Rough", q: "rough" },
  { label: "Oral", q: "oral" },
  { label: "Riding", q: "riding" },
  { label: "Amateur couple", q: "amateur couple" },
];

const fromGiphy = (item: GiphyItem): Tile => ({
  id: item.id,
  title: item.title,
  thumb: item.images.fixed_width.url,
  video: false,
  send: { url: item.images.original.url, preview: item.images.fixed_width_small.url, title: item.title },
});
const fromAdult = (item: AdultGif): Tile => ({
  id: `r-${item.id}`,
  title: item.title,
  thumb: item.poster,
  video: true,
  send: { url: item.video, preview: item.poster, title: item.title, video: true, redgifsId: item.id },
});

const readAdultOk = () => {
  try {
    return localStorage.getItem(ADULT_OK_KEY) === "1";
  } catch {
    return false;
  }
};

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
  const [adultOk, setAdultOk] = useState(readAdultOk);
  const showAdultGate = tab === "adult" && !adultOk;

  const fetchPage = async (pageNumber: number): Promise<Tile[]> => {
    const q = query || DEFAULT_QUERY;
    if (tab === "adult") return (await redgifsSearch({ data: { query: q, page: pageNumber } })).map(fromAdult);
    return ((await giphySearch({ data: { query: q, kind: tab, page: pageNumber } })) as GiphyItem[]).map(fromGiphy);
  };

  useEffect(() => {
    if (showAdultGate) return;
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
  }, [query, tab, showAdultGate]);

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

  const allowAdult = () => {
    try {
      localStorage.setItem(ADULT_OK_KEY, "1");
    } catch {
      /* Storage can be unavailable; the answer then lasts for this visit. */
    }
    setAdultOk(true);
  };

  const tags = tab === "adult" ? ADULT_TAGS : TAGS;
  const sourceName = tab === "adult" ? "RedGifs" : "KLIPY";

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-3 sm:items-center" onClick={onClose}>
      <div className="flex max-h-[min(80vh,620px)] w-full max-w-lg flex-col overflow-hidden rounded-2xl bg-card shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3 border-b px-4 py-3">
          <div className="flex-1 font-semibold">GIFs & stickers</div>
          <button onClick={onClose} className="flex h-9 w-9 items-center justify-center rounded-full text-muted-foreground hover:bg-muted" aria-label="Close GIF picker"><X className="h-5 w-5" /></button>
        </div>
        <div className="flex gap-1 border-b px-4 pt-2">
          {([["gif", "GIFs"], ["sticker", "Stickers"], ["adult", "18+"]] as const).map(([value, label]) => (
            <button key={value} onClick={() => switchTab(value)} className={`border-b-2 px-3 py-2 text-sm font-medium ${tab === value ? "border-primary text-primary" : "border-transparent text-muted-foreground"}`}>{label}</button>
          ))}
        </div>
        {showAdultGate ? (
          <div className="flex flex-col items-center gap-3 px-6 py-10 text-center">
            <p className="font-medium">Explicit content</p>
            <p className="text-sm text-muted-foreground">This tab shows explicit adult (18+) clips from RedGifs. Only continue if you are 18 or older.</p>
            <button type="button" onClick={allowAdult} className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground">I'm 18+, show it</button>
          </div>
        ) : (
          <>
            <form onSubmit={(e) => { e.preventDefault(); setQuery(input.trim()); }} className="m-3 flex items-center gap-2 rounded-lg bg-muted px-3">
              <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
              <input value={input} onChange={(e) => setInput(e.target.value)} className="min-w-0 flex-1 bg-transparent py-2 text-sm outline-none" placeholder={`Search ${sourceName}`} aria-label={`Search ${sourceName}`} />
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
                  <button key={item.id} onClick={() => onSelect(item.send, tab === "sticker" ? "sticker" : "gif")} className="relative aspect-square overflow-hidden rounded-lg bg-muted focus:outline-none focus:ring-2 focus:ring-ring" aria-label={`Send ${item.title || "GIF"}`}>
                    {item.thumb && <img src={item.thumb} alt={item.title || "GIF"} loading="lazy" className="h-full w-full object-cover" />}
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
          </>
        )}
        <div className="px-4 pb-3 text-right text-[10px] text-muted-foreground">{tab === "adult" ? "Powered by RedGifs" : "Powered by KLIPY & GIPHY"}</div>
      </div>
    </div>
  );
}
