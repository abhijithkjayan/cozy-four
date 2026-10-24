import { useEffect, useState } from "react";
import { LoaderCircle, Play, Search, X } from "lucide-react";
import { extraGifSearch, giphySearch, redgifsSearch } from "@/lib/giphy.functions";
import { freshRedgifs, RedgifsHttpError, searchRedgifsDirect } from "@/lib/redgifs-client";

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

export type PickedGif = {
  url: string;
  preview: string;
  title: string;
  video?: boolean;
  redgifsId?: string;
};

type GiphyPickerProps = {
  onSelect: (item: PickedGif, kind: "gif" | "sticker") => void;
  onClose: () => void;
};

type Tab = "gif" | "got" | "sticker";
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
  { label: "Nude", q: "nude" },
  { label: "Erotic", q: "erotic" },
  { label: "Naked couple", q: "naked couple" },
  { label: "Striptease", q: "striptease" },
  { label: "POV", q: "pov" },
  { label: "Lesbian", q: "lesbian" },
  { label: "Hardcore", q: "hardcore" },
  { label: "Blowjob", q: "blowjob" },
  { label: "Anal", q: "anal" },
  { label: "Creampie", q: "creampie" },
  { label: "Cumshot", q: "cumshot" },
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
  { label: "Movie kiss", q: "movie kiss" },
  { label: "Movie romance", q: "romantic movie scene" },
  { label: "Movie love scene", q: "movie love scene" },
  { label: "Funny", q: "funny" },
  { label: "Reactions", q: "reaction" },
];
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

/** RedGifs results, from the device first and the server if the device can't reach RedGifs. */
async function loadAdult(query: string, page: number): Promise<{ items: GiphyItem[]; error: string | null }> {
  try {
    return { items: await searchRedgifsDirect(query, page), error: null };
  } catch (error) {
    if (error instanceof RedgifsHttpError) return { items: [], error: error.message };
    const fallback = await redgifsSearch({ data: { query, page } }).catch((e: unknown) => ({
      items: [],
      error: e instanceof Error ? e.message : "unreachable",
    }));
    return { items: fallback.items as GiphyItem[], error: fallback.error };
  }
}

/** Preview tile; a clip whose preview link was refused asks once for a fresh one. */
function TileImage({ tile }: { tile: Tile }) {
  const [src, setSrc] = useState(tile.thumb);
  const [retried, setRetried] = useState(false);
  const onError = () => {
    if (retried || !tile.send.redgifsId) return;
    setRetried(true);
    void freshRedgifs(tile.send.redgifsId).then((fresh) => {
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

  const [adultNote, setAdultNote] = useState<string | null>(null);
  const fetchPage = async (pageNumber: number): Promise<Tile[]> => {
    const q = tab === "got" ? query || GOT_ALL : query || DEFAULT_QUERY;
    const [result, adult, extra] = await Promise.all([
      giphySearch({ data: { query: q, kind: tab === "sticker" ? "sticker" : "gif", page: pageNumber, adult: false } }),
      tab === "gif" ? loadAdult(q, pageNumber) : Promise.resolve({ items: [] as GiphyItem[], error: null }),
      tab === "gif"
        ? extraGifSearch({ data: { query: q, page: pageNumber } })
        : Promise.resolve({ items: [] as GiphyItem[], errors: [] as string[] }),
    ]);
    if (pageNumber === 0) setAdultNote([adult.error, ...extra.errors].filter(Boolean).join("; ") || null);
    // Adult results first in each round so they aren't buried under ordinary GIFs.
    const base = result.items as GiphyItem[];
    const adultItems = [...adult.items, ...(extra.items as GiphyItem[])];
    const mixed: GiphyItem[] = [];
    for (let a = 0, b = 0; a < adultItems.length || b < base.length; a++, b += 2) {
      const clip = adultItems[a];
      if (clip) mixed.push(clip);
      mixed.push(...base.slice(b, b + 2));
    }
    return mixed.map(toTile);
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

  const tags = tab === "gif" ? TAGS : tab === "got" ? GOT_TAGS : TAGS.slice(0, 13);

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-3 sm:items-center" onClick={onClose}>
      <div className="flex max-h-[min(80vh,620px)] w-full max-w-lg flex-col overflow-hidden rounded-2xl bg-card shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex shrink-0 items-center gap-3 border-b px-4 py-3">
          <div className="flex-1 font-semibold">GIFs & stickers</div>
          <button onClick={onClose} className="flex h-9 w-9 items-center justify-center rounded-full text-muted-foreground hover:bg-muted" aria-label="Close GIF picker"><X className="h-5 w-5" /></button>
        </div>
        <div className="flex shrink-0 gap-1 border-b px-4 pt-2">
          {([["gif", "GIFs"], ["got", "Game of Thrones"], ["sticker", "Stickers"]] as const).map(([value, label]) => (
            <button key={value} onClick={() => switchTab(value)} className={`border-b-2 px-3 py-2 text-sm font-medium ${tab === value ? "border-primary text-primary" : "border-transparent text-muted-foreground"}`}>{label}</button>
          ))}
        </div>
            <form onSubmit={(e) => { e.preventDefault(); setQuery(input.trim()); }} className="m-3 flex shrink-0 items-center gap-2 rounded-lg bg-muted px-3">
              <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
              <input value={input} onChange={(e) => setInput(e.target.value)} className="min-w-0 flex-1 bg-transparent py-2 text-sm outline-none" placeholder="Search GIFs" aria-label="Search GIFs" />
            </form>
            <div className="flex shrink-0 gap-2 overflow-x-auto border-b px-3 pb-3 pt-0.5 [scrollbar-width:none]">
              {tags.map((t) => (
                <button key={t.label} type="button" onClick={() => { setInput(t.q); setQuery(t.q); }} className={`shrink-0 whitespace-nowrap rounded-full px-3 py-1.5 text-xs font-medium ${query === t.q ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:bg-muted/70"}`}>{t.label}</button>
              ))}
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3 pt-3">
              {adultNote && !loading && (
                <p className="mb-2 rounded-md bg-muted px-2 py-1.5 text-xs text-muted-foreground">
                  Some adult GIF sources are unavailable ({adultNote}). Showing available results.
                </p>
              )}
              {loading && <div className="flex justify-center py-8 text-muted-foreground"><LoaderCircle className="h-6 w-6 animate-spin" /></div>}
              {error && <p className="px-3 py-8 text-center text-sm text-muted-foreground">{error}</p>}
              {!loading && !error && !items.length && <p className="px-3 py-8 text-center text-sm text-muted-foreground">No results.</p>}
              {!loading && !error && <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                {items.map((item) => (
                  <button key={item.id} onClick={() => onSelect(item.send, tab === "sticker" ? "sticker" : "gif")} className="relative aspect-square overflow-hidden rounded-lg bg-muted focus:outline-none focus:ring-2 focus:ring-ring" aria-label={`Send ${item.title || "GIF"}`}>
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
        <div className="px-4 pb-3 text-right text-[10px] text-muted-foreground">
          {tab === "gif" ? "Powered by KLIPY, GIPHY, RedGifs, Rule34 & Fluxpoint" : "Powered by KLIPY & GIPHY"}
        </div>
      </div>
    </div>
  );
}
