import { useEffect, useState } from "react";
import { LoaderCircle, Search, X } from "lucide-react";

type GiphyItem = {
  id: string;
  title: string;
  images: {
    fixed_width: { url: string };
    fixed_width_small: { url: string };
    original: { url: string };
  };
};

type GiphyPickerProps = {
  onSelect: (item: { url: string; preview: string; title: string }, kind: "gif" | "sticker") => void;
  onClose: () => void;
};

const DEFAULT_QUERY = "game of thrones";

export function GiphyPicker({ onSelect, onClose }: GiphyPickerProps) {
  const [tab, setTab] = useState<"gif" | "sticker">("gif");
  const [query, setQuery] = useState(DEFAULT_QUERY);
  const [items, setItems] = useState<GiphyItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const key = import.meta.env["VITE_GIPHY_API_KEY"];
    if (!key) {
      setError("Giphy is not configured yet.");
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    const endpoint = tab === "sticker" ? "stickers/search" : "gifs/search";
    const params = new URLSearchParams({ api_key: key, q: query || DEFAULT_QUERY, limit: "24", rating: "pg-13" });
    fetch(`https://api.giphy.com/v1/${endpoint}?${params}`, { signal: controller.signal })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("Giphy request failed"))))
      .then((body: { data: GiphyItem[] }) => setItems(body.data ?? []))
      .catch((e: unknown) => { if ((e as Error).name !== "AbortError") setError("Could not load Giphy results."); })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [query, tab]);

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-3 sm:items-center" onClick={onClose}>
      <div className="flex max-h-[min(80vh,620px)] w-full max-w-lg flex-col overflow-hidden rounded-2xl bg-card shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3 border-b px-4 py-3">
          <div className="flex-1 font-semibold">GIFs & stickers</div>
          <button onClick={onClose} className="flex h-9 w-9 items-center justify-center rounded-full text-muted-foreground hover:bg-muted" aria-label="Close GIF picker"><X className="h-5 w-5" /></button>
        </div>
        <div className="flex gap-1 border-b px-4 pt-2">
          {(["gif", "sticker"] as const).map((value) => (
            <button key={value} onClick={() => setTab(value)} className={`border-b-2 px-3 py-2 text-sm font-medium capitalize ${tab === value ? "border-primary text-primary" : "border-transparent text-muted-foreground"}`}>{value}s</button>
          ))}
        </div>
        <form onSubmit={(e) => { e.preventDefault(); setQuery((q) => q.trim() || DEFAULT_QUERY); }} className="m-3 flex items-center gap-2 rounded-lg bg-muted px-3">
          <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} className="min-w-0 flex-1 bg-transparent py-2 text-sm outline-none" placeholder="Search Giphy" aria-label="Search Giphy" />
        </form>
        <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
          {loading && <div className="flex justify-center py-8 text-muted-foreground"><LoaderCircle className="h-6 w-6 animate-spin" /></div>}
          {error && <p className="px-3 py-8 text-center text-sm text-muted-foreground">{error}</p>}
          {!loading && !error && <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
            {items.map((item) => (
              <button key={item.id} onClick={() => onSelect({ url: item.images.original.url, preview: item.images.fixed_width_small.url, title: item.title }, tab)} className="aspect-square overflow-hidden rounded-lg bg-muted focus:outline-none focus:ring-2 focus:ring-ring" aria-label={`Send ${item.title || tab}`}>
                <img src={item.images.fixed_width.url} alt={item.title || tab} loading="lazy" className="h-full w-full object-cover" />
              </button>
            ))}
          </div>}
        </div>
        <div className="px-4 pb-3 text-right text-[10px] text-muted-foreground">Powered by GIPHY</div>
      </div>
    </div>
  );
}