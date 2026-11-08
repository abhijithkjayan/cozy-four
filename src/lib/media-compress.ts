// Shrinks photos and videos in the browser before upload, keeping them visually unchanged.
// Every path falls back to the original file: compression must never lose or block media.

// A result is only used if it saves at least 10%, so already-efficient files aren't re-encoded for nothing.
const REQUIRED_RATIO = 0.9;
const IMAGE_MIN_BYTES = 200 * 1024;
// Larger canvases fail on iPhones. 4096px is still well above what Telegram or a chat view displays.
const IMAGE_MAX_EDGE = 4096;
const JPEG_WEBP_QUALITY = 0.92;
// Video is held in memory while it is encoded.
const VIDEO_MAX_INPUT_BYTES = 1024 * 1024 * 1024;
// Bits per pixel for H.264 that stays visually clean: about 6 Mbps for 1080p at 30 fps.
const VIDEO_BITS_PER_PIXEL = 0.1;
const AUDIO_BITRATE = 192_000;

export type CompressProgress = (fraction: number) => void;

const renamed = (file: File, blob: Blob, extension: string) =>
  new File([blob], `${file.name.replace(/\.[^.]+$/, "") || "media"}.${extension}`, {
    type: blob.type,
    lastModified: file.lastModified,
  });

const canvasBlob = (canvas: HTMLCanvasElement, type: string, quality: number) =>
  new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));

async function compressImage(file: File): Promise<File> {
  if (file.size < IMAGE_MIN_BYTES || !["image/jpeg", "image/png", "image/webp"].includes(file.type)) return file;
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  try {
    const scale = Math.min(1, IMAGE_MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const context = canvas.getContext("2d");
    if (!context) return file;
    context.imageSmoothingQuality = "high";
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);

    // PNGs are often screenshots or have transparency, so they only go to lossless WebP (quality 1).
    const target = file.type === "image/jpeg" ? "image/jpeg" : "image/webp";
    const blob = await canvasBlob(canvas, target, file.type === "image/png" ? 1 : JPEG_WEBP_QUALITY);
    // Browsers without a WebP encoder silently return a different format.
    if (!blob || blob.type !== target) return file;
    return renamed(file, blob, target === "image/jpeg" ? "jpg" : "webp");
  } finally {
    bitmap.close();
  }
}

async function compressVideo(file: File, onProgress?: CompressProgress): Promise<File> {
  if (file.size > VIDEO_MAX_INPUT_BYTES || typeof VideoEncoder === "undefined") return file;
  const { ALL_FORMATS, BlobSource, BufferTarget, Conversion, Input, Mp4OutputFormat, Output } = await import("mediabunny");
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryVideoTrack();
    // Re-encoding HDR to the 8-bit output would visibly change its colours.
    if (!track || (await track.hasHighDynamicRange())) return file;
    const duration = await input.computeDuration();
    if (!(duration > 0)) return file;
    const { averagePacketRate } = await track.computePacketStats(120);
    const fps = averagePacketRate > 0 ? averagePacketRate : 30;
    const targetBitrate = Math.round(track.displayWidth * track.displayHeight * fps * VIDEO_BITS_PER_PIXEL);
    // Already at or near the target: encoding again would cost quality and save little.
    if ((file.size * 8) / duration < targetBitrate * 1.25) return file;

    const target = new BufferTarget();
    const output = new Output({ format: new Mp4OutputFormat({ fastStart: "in-memory" }), target });
    const conversion = await Conversion.init({
      input,
      output,
      video: { codec: "avc", bitrate: targetBitrate, forceTranscode: true },
      audio: { codec: "aac", bitrate: AUDIO_BITRATE },
      showWarnings: false,
    });
    // A dropped track would mean silent or missing video, so the original is kept instead.
    if (!conversion.isValid || conversion.discardedTracks.length) return file;
    if (onProgress) conversion.onProgress = onProgress;
    await conversion.execute();
    if (!target.buffer) return file;
    return renamed(file, new Blob([target.buffer], { type: "video/mp4" }), "mp4");
  } finally {
    input.dispose();
  }
}

/** Returns a smaller copy of a photo or video, or the original file when compressing wouldn't help. */
export async function compressMedia(file: File, onProgress?: CompressProgress): Promise<File> {
  try {
    const result = file.type.startsWith("video/") ? await compressVideo(file, onProgress) : await compressImage(file);
    return result.size > 0 && result.size <= file.size * REQUIRED_RATIO ? result : file;
  } catch (error) {
    console.warn("Media compression skipped:", error);
    return file;
  }
}
