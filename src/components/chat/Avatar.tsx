import { cn } from "@/lib/utils";
import type { Profile } from "@/lib/supabase";

export function Avatar({ p, online, away, size = 44 }: { p: Profile; online?: boolean | undefined; away?: boolean | undefined; size?: number }) {
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      {p.avatar_url ? (
        <img src={p.avatar_url} alt="" className="h-full w-full rounded-full object-cover" />
      ) : (
        <div
          className="flex h-full w-full items-center justify-center rounded-full bg-accent font-semibold text-accent-foreground"
          style={{ fontSize: size * 0.36 }}
        >
          {p.display_name.slice(0, 1).toUpperCase()}
          {p.display_name.slice(-1)}
        </div>
      )}
      {(online !== undefined || away !== undefined) && (
        <span
          className={cn(
            "absolute bottom-0 right-0 h-3 w-3 rounded-full border-2 border-card",
            online ? "bg-emerald-500" : away ? "bg-amber-400" : "bg-neutral-400",
          )}
        />
      )}
    </div>
  );
}
