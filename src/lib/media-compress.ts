// Shrinks photos and videos in the browser, before upload and before sending to Telegram.
import { TELEGRAM_TARGET_BYTES } from "@/lib/telegram-media";

// Files above these sizes are compressed when sent in chat, unless the sender opts out.
const CHAT_PHOTO_LIMIT_BYTES = 2_000_000;
const CHAT_VIDEO_LIMIT_BYTES = 50_000_000;
// Larger canvases fail on iPhones.
const IMAGE_MAX_EDGE = 4096;
const VIDEO_MAX_LONG_EDGE = 1920;
// Bits per pixel for H.264 that stays visually clean: about 6 Mbps for 1080p at 30 fps.
const VIDEO_BITS_PER_PIXEL = 0.1;
// When a video must fit a size limit, resolution drops before bits per pixel go below this.
const VIDEO_MIN_BITS_PER_PIXEL = 0.07;
const VIDEO_MIN_SHORT_EDGE = 360;
// How far below the target size to look for dimensions that match the source ratio.
const RATIO_SEARCH_PIXELS = 24;

export type CompressProgress = (fraction: number) => void;

const renamed = (file: File, blob: Blob, extension: string) =>
  new File([blob], `${file.name.replace(/\.[^.]+$/, "") || "media"}.${extension}`, {
    type: blob.type,
    lastModified: file.lastModified,
  });

const canvasBlob = (canvas: HTMLCanvasElement, type: string, quality: number) =>
  new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));

/**
 * The output size at about `scale`, with the width-to-height ratio of the source.
 * Rounding each side on its own would stretch the picture, so this looks just below the
 * target for the whole-pixel size that matches the source ratio best. `step` is the
 * multiple both sides must be: 2 for H.264, 1 for images.
 */
function sizeKeepingRatio(width: number, height: number, scale: number, step = 1) {
  const short = Math.min(width, height);
  const ratio = Math.max(width, height) / short;
  const target = Math.max(step, Math.floor((short * scale) / step) * step);
  let best = { short: target, long: Math.round((target * ratio) / step) * step };
  let bestError = Infinity;
  for (let s = target; s >= Math.max(step, target - RATIO_SEARCH_PIXELS); s -= step) {
    const long = Math.round((s * ratio) / step) * step;
    const error = Math.abs(long / s - ratio);
    if (error < bestError) {
      best = { short: s, long };
      bestError = error;
    }
    if (error === 0) break;
  }
  return width >= height
    ? { width: best.long, height: best.short }
    : { width: best.short, height: best.long };
}

async function fitImage(
  file: File,
  maxBytes: number,
  edges: number[],
  qualities: number[],
): Promise<File> {
  // A canvas would keep only the first frame of an animation.
  if (file.type === "image/gif") throw new Error("This GIF is too large to compress.");
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  try {
    for (const edge of edges) {
      const scale = Math.min(1, edge / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement("canvas");
      const size = sizeKeepingRatio(bitmap.width, bitmap.height, scale);
      canvas.width = size.width;
      canvas.height = size.height;
      const context = canvas.getContext("2d");
      if (!context) break;
      context.imageSmoothingQuality = "high";
      // JPEG has no transparency, so a white background stops clear areas turning black.
      context.fillStyle = "#fff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      for (const quality of qualities) {
        const blob = await canvasBlob(canvas, "image/jpeg", quality);
        if (blob && blob.size <= maxBytes) return renamed(file, blob, "jpg");
      }
    }
  } finally {
    bitmap.close();
  }
  throw new Error("Could not shrink this photo enough.");
}

async function fitAudioVideo(
  file: File,
  maxBytes: number,
  onProgress?: CompressProgress,
): Promise<File> {
  const { ALL_FORMATS, BlobSource, BufferTarget, Conversion, Input, Mp4OutputFormat, Output } =
    await import("mediabunny");
  // Encoders overshoot their bitrate, so each retry aims lower by as much as the last attempt missed.
  let budget = 0.94;
  for (let attempt = 0; attempt < 4; attempt++) {
    const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
    try {
      const videoTrack = await input.getPrimaryVideoTrack();
      const audioTrack = await input.getPrimaryAudioTrack();
      if (!videoTrack && !audioTrack) throw new Error("This file can't be compressed.");
      const duration = await input.computeDuration();
      if (!(duration > 0)) throw new Error("This file can't be compressed.");
      const totalBitrate = (maxBytes * 8 * budget) / duration;
      // Windows' AAC encoder only accepts these bitrates.
      const audioOnlyBitrate =
        [192_000, 160_000, 128_000, 96_000].find((bitrate) => bitrate <= totalBitrate) ?? 0;
      const audioBitrate = !audioTrack
        ? 0
        : !videoTrack
          ? audioOnlyBitrate
          : totalBitrate < 1_000_000
            ? 96_000
            : 128_000;
      const videoBudget = Math.round(totalBitrate - audioBitrate);
      if (audioTrack && audioBitrate === 0)
        throw new Error("This recording is too long to fit the 50 MB limit.");
      if (videoTrack && videoBudget < 150_000)
        throw new Error("This video is too long to fit the 50 MB limit.");

      let video;
      if (videoTrack) {
        const { displayWidth, displayHeight } = videoTrack;
        const { averagePacketRate } = await videoTrack.computePacketStats(120);
        const fps = averagePacketRate > 0 ? averagePacketRate : 30;
        // Fewer pixels at a sane bitrate look better than full resolution starved of bits.
        const wanted = Math.sqrt(
          videoBudget / (displayWidth * displayHeight * fps * VIDEO_MIN_BITS_PER_PIXEL),
        );
        const scale = Math.min(
          1,
          VIDEO_MAX_LONG_EDGE / Math.max(displayWidth, displayHeight),
          Math.max(wanted, VIDEO_MIN_SHORT_EDGE / Math.min(displayWidth, displayHeight)),
        );
        // H.264 needs even dimensions on both sides.
        const { width, height } = sizeKeepingRatio(displayWidth, displayHeight, scale, 2);
        video = {
          codec: "avc" as const,
          // More bits than this add size without visible gain.
          bitrate: Math.min(videoBudget, Math.round(width * height * fps * VIDEO_BITS_PER_PIXEL)),
          width,
          height,
          // Never stretches. When no even size matches exactly, under a pixel is trimmed instead.
          fit: "cover" as const,
          forceTranscode: true,
        };
      }

      const target = new BufferTarget();
      const output = new Output({
        format: new Mp4OutputFormat({ fastStart: "in-memory" }),
        target,
      });
      const conversion = await Conversion.init({
        input,
        output,
        ...(video ? { video } : {}),
        ...(audioTrack
          ? { audio: { codec: "aac" as const, bitrate: audioBitrate, forceTranscode: true } }
          : {}),
        showWarnings: false,
      });
      // A dropped track would mean silent or missing video.
      if (!conversion.isValid || conversion.discardedTracks.length)
        throw new Error("This browser can't compress this file. Try Chrome on a computer.");
      if (onProgress) conversion.onProgress = onProgress;
      await conversion.execute();
      if (target.buffer && target.buffer.byteLength <= maxBytes) {
        return videoTrack
          ? renamed(file, new Blob([target.buffer], { type: "video/mp4" }), "mp4")
          : renamed(file, new Blob([target.buffer], { type: "audio/mp4" }), "m4a");
      }
      if (target.buffer) budget *= (maxBytes / target.buffer.byteLength) * 0.92;
    } finally {
      input.dispose();
    }
  }
  throw new Error("Could not shrink this file enough.");
}

/** Shrinks a file to at most maxBytes for Telegram. Throws when it can't, so the sender sees why. */
export function fitMediaToSize(
  file: File,
  maxBytes: number,
  onProgress?: CompressProgress,
): Promise<File> {
  if (file.size <= maxBytes) return Promise.resolve(file);
  return file.type.startsWith("image/")
    ? fitImage(file, maxBytes, [IMAGE_MAX_EDGE, 3072, 2048], [0.92, 0.85, 0.75])
    : fitAudioVideo(file, maxBytes, onProgress);
}

/** Whether a file chosen for a chat is large enough to be compressed by default. */
export function needsChatCompression(file: File) {
  if (file.type.startsWith("video/")) return file.size > CHAT_VIDEO_LIMIT_BYTES;
  return (
    file.type.startsWith("image/") &&
    file.type !== "image/gif" &&
    file.size > CHAT_PHOTO_LIMIT_BYTES
  );
}

/** Compresses a large chat file. Returns the original if that fails, so media is never lost. */
export async function compressForChat(file: File, onProgress?: CompressProgress): Promise<File> {
  try {
    const result = file.type.startsWith("video/")
      ? await fitAudioVideo(file, TELEGRAM_TARGET_BYTES, onProgress)
      : await fitImage(file, CHAT_PHOTO_LIMIT_BYTES, [2560, 2048, 1600], [0.85, 0.75, 0.65]);
    return result.size > 0 && result.size < file.size ? result : file;
  } catch (error) {
    console.warn("Media compression skipped:", error);
    return file;
  }
}
