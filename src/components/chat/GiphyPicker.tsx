import { useEffect, useState } from "react";
import { LoaderCircle, Play, Search, X } from "lucide-react";
import { giphySearch, redgifsSearch } from "@/lib/giphy.functions";
import { freshRedgifs } from "@/lib/redgifs-client";

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

type Tab = "gif" | "adult" | "got" | "others" | "sticker";
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
const ADULT_TAGS = [
  { label: "Trending", q: "" },
  { label: "Sex", q: "sex" },
  { label: "Porn", q: "porn" },
  ...TAGS.filter((t) =>
    [
      "Sexy",
      "Nude",
      "Erotic",
      "Naked couple",
      "Striptease",
      "POV",
      "Lesbian",
      "Hardcore",
      "Blowjob",
      "Anal",
      "Creampie",
      "Cumshot",
      "Seductive",
      "Hot",
      "Naughty",
      "Passionate",
      "Sensual",
      "Make out",
      "Making love",
      "Bed",
      "Lingerie",
      "Teasing",
      "Shower",
      "Morning",
      "Rough",
      "Oral",
      "Riding",
      "Amateur couple",
    ].includes(t.label),
  ),
];
const ADULT_DEFAULT = "nude";
// Others tab keeps the non-adult theme tags, opening on the first one.
const OTHERS_TAGS = TAGS.filter((t) => t.q && !ADULT_TAGS.includes(t));
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
  // Server only: RedGifs' CORS blocks its search for browsers on other sites.
  const result = await redgifsSearch({ data: { query, page } }).catch((e: unknown) => ({
    items: [],
    error: e instanceof Error ? e.message : "unreachable",
  }));
  return { items: result.items as GiphyItem[], error: result.error };
}

/** Preview tile; a clip whose preview link was refused asks once for a fresh one. */
function TileImage({ tile }: { tile: Tile }) {
  const [src, setSrc] = useState(tile.thumb);
  const [retried, setRetried] = useState(false);
  const onError = () => {
    // A tile that still can't load stays blank instead of showing a broken image.
    if (retried || !tile.send.redgifsId) return setSrc("");
    setRetried(true);
    void freshRedgifs(tile.send.redgifsId).then((fresh) => {
      if (!fresh) return setSrc("");
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

  const [adultAccessConfirmed, setAdultAccessConfirmed] = useState(false);
  const [showAdultNotice, setShowAdultNotice] = useState(false);
  const fetchPage = async (pageNumber: number): Promise<Tile[]> => {
    const q = tab === "got" ? query || GOT_ALL : tab === "others" ? query || OTHERS_DEFAULT : tab === "adult" ? query || ADULT_DEFAULT : query || DEFAULT_QUERY;
    const withAdult = tab === "adult";
    const [result, adult] = await Promise.all([
      withAdult
        ? Promise.resolve({ items: [] as GiphyItem[] })
        : giphySearch({ data: { query: q, kind: tab === "sticker" ? "sticker" : "gif", page: pageNumber, adult: false } }),
      withAdult ? loadAdult(q, pageNumber) : Promise.resolve({ items: [] as GiphyItem[], error: null }),
    ]);
    if (pageNumber === 0 && adult.error) console.warn("RedGifs:", adult.error);
    return ((withAdult ? adult.items : result.items) as GiphyItem[]).map(toTile);
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

  const updateTab = (value: Tab) => {
    setTab(value);
    setInput("");
    setQuery(value === "others" ? OTHERS_DEFAULT : value === "adult" ? ADULT_DEFAULT : "");
    setItems([]);
  };

  const switchTab = (value: Tab) => {
    if (value === "adult" && !adultAccessConfirmed) {
      setShowAdultNotice(true);
      return;
    }
    updateTab(value);
  };

  const confirmAdultAccess = () => {
    setAdultAccessConfirmed(true);
    setShowAdultNotice(false);
    updateTab("adult");
  };

  // GIFs is trending + search only; the theme tags live under Others.
  const tags = tab === "adult" ? ADULT_TAGS : tab === "gif" ? [] : tab === "got" ? GOT_TAGS : tab === "others" ? OTHERS_TAGS : TAGS.slice(0, 13);

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-3 sm:items-center" onClick={onClose}>
      <div className="flex max-h-[min(80vh,620px)] w-full max-w-lg flex-col overflow-hidden rounded-2xl bg-card shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex shrink-0 items-center gap-3 border-b px-4 py-3">
          <div className="flex-1 font-semibold">GIFs & stickers</div>
          <button onClick={onClose} className="flex h-9 w-9 items-center justify-center rounded-full text-muted-foreground hover:bg-muted" aria-label="Close GIF picker"><X className="h-5 w-5" /></button>
        </div>
        <div className="flex shrink-0 gap-1 border-b px-4 pt-2">
          {([["gif", "GIFs"], ["adult", "Naughty"], ["got", "GOT"], ["others", "Others"], ["sticker", "Stickers"]] as const).map(([value, label]) => (
            <button key={value} onClick={() => switchTab(value)} className={`border-b-2 px-3 py-2 text-sm font-medium ${tab === value ? "border-primary text-primary" : "border-transparent text-muted-foreground"}`}>{label}</button>
          ))}
        </div>
            <form onSubmit={(e) => { e.preventDefault(); setQuery(input.trim()); }} className="m-3 flex shrink-0 items-center gap-2 rounded-lg bg-muted px-3">
              <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
              <input value={input} onChange={(e) => setInput(e.target.value)} className="min-w-0 flex-1 bg-transparent py-2 text-sm outline-none" placeholder="Search GIFs" aria-label="Search GIFs" />
            </form>
            {tags.length > 0 && <div className="flex shrink-0 gap-2 overflow-x-auto border-b px-3 pb-3 pt-0.5 [scrollbar-width:none]">
              {tags.map((t) => (
                <button key={t.label} type="button" onClick={() => { setInput(t.q); setQuery(t.q); }} className={`shrink-0 whitespace-nowrap rounded-full px-3 py-1.5 text-xs font-medium ${query === t.q ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:bg-muted/70"}`}>{t.label}</button>
              ))}
            </div>}
            <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3 pt-3">
              {loading && <div className="flex justify-center py-8 text-muted-foreground"><LoaderCircle className="h-6 w-6 animate-spin" /></div>}
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
          {tab === "adult" ? "Powered by RedGifs" : "Powered by KLIPY & GIPHY"}
        </div>
      </div>
      {showAdultNotice && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-4" onClick={(event) => event.stopPropagation()}>
          <section role="dialog" aria-modal="true" aria-labelledby="adult-gif-notice-title" className="w-full max-w-sm rounded-2xl bg-card p-5 shadow-xl">
            <h2 id="adult-gif-notice-title" className="text-lg font-semibold">Adult content (18+)</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              This library loads mature GIFs from an external provider. Continue only if you are at least 18 years old.
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" onClick={() => setShowAdultNotice(false)} className="rounded-lg px-3 py-2 text-sm text-muted-foreground hover:bg-muted">
                Go back
              </button>
              <button type="button" onClick={confirmAdultAccess} className="rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground">
                I am 18 or older
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
