import { useState } from "react";
import { cn } from "@/lib/utils";

// Same image set the emoji picker uses, so reactions look identical on every device (WhatsApp-style).
const CDN = "https://cdn.jsdelivr.net/npm/emoji-datasource-apple/img/apple/64/";

const toUnified = (emoji: string) => [...emoji].map((char) => char.codePointAt(0)!.toString(16)).join("-");

/** Renders an emoji as an Apple-style image; falls back to the device's native emoji if no image exists. */
export function AppleEmoji({ emoji, size = 20, className }: { emoji: string; size?: number; className?: string }) {
  // 0 = exact image, 1 = image without variation selector (some files omit fe0f), 2 = native text
  const [attempt, setAttempt] = useState(0);
  const unified = toUnified(emoji);
  if (attempt === 2 || (attempt === 1 && !unified.includes("-fe0f"))) {
    return <span className={className} style={{ fontSize: size * 0.85, lineHeight: 1 }}>{emoji}</span>;
  }
  const file = attempt === 0 ? unified : unified.replace(/-fe0f/g, "");
  return (
    <img
      src={`${CDN}${file}.png`}
      alt={emoji}
      width={size}
      height={size}
      draggable={false}
      loading="lazy"
      onError={() => setAttempt((current) => current + 1)}
      className={cn("inline-block shrink-0 select-none", className)}
    />
  );
}
