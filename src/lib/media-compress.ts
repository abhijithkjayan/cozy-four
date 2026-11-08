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
// When a video must fit a size limit, resolution drops before bits per pixel go below this.
const VIDEO_MIN_BITS_PER_PIXEL = 0.07;
const VIDEO_MIN_SHORT_EDGE = 360;

export type CompressProgress = (fraction: number) => void;

const renamed = (file: File, blob: Blob, extension: string) =>
  new File([blob], `${file.name.replace(/\.[^.]+$/, "") || "media"}.${extension}`, {
    type: blob.type,
    lastModified: file.lastModified,
  });

const canvasBlob = (canvas: HTMLCanvasElement, type: string, quality: number) =>
  new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));

async function compressImage(file: File): Promise<File> {
  if (file.size < IMAGE_MIN_BYTES || !["image/jpeg", "image/png", "image/webp"].includes(file.type))
    return file;
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
    const blob = await canvasBlob(
      canvas,
      target,
      file.type === "image/png" ? 1 : JPEG_WEBP_QUALITY,
    );
    // Browsers without a WebP encoder silently return a different format.
    if (!blob || blob.type !== target) return file;
    return renamed(file, blob, target === "image/jpeg" ? "jpg" : "webp");
  } finally {
    bitmap.close();
  }
}

async function compressVideo(file: File, onProgress?: CompressProgress): Promise<File> {
  if (file.size > VIDEO_MAX_INPUT_BYTES || typeof VideoEncoder === "undefined") return file;
  const { ALL_FORMATS, BlobSource, BufferTarget, Conversion, Input, Mp4OutputFormat, Output } =
    await import("mediabunny");
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryVideoTrack();
    // Re-encoding HDR to the 8-bit output would visibly change its colours.
    if (!track || (await track.hasHighDynamicRange())) return file;
    const duration = await input.computeDuration();
    if (!(duration > 0)) return file;
    const { averagePacketRate } = await track.computePacketStats(120);
    const fps = averagePacketRate > 0 ? averagePacketRate : 30;
    const targetBitrate = Math.round(
      track.displayWidth * track.displayHeight * fps * VIDEO_BITS_PER_PIXEL,
    );
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

async function fitImage(file: File, maxBytes: number): Promise<File> {
  // A canvas would keep only the first frame of an animation.
  if (file.type === "image/gif") throw new Error("This GIF is too large to send to Telegram.");
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  try {
    for (const edge of [IMAGE_MAX_EDGE, 3072, 2048]) {
      const scale = Math.min(1, edge / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(bitmap.width * scale);
      canvas.height = Math.round(bitmap.height * scale);
      const context = canvas.getContext("2d");
      if (!context) break;
      context.imageSmoothingQuality = "high";
      // JPEG has no transparency, so a white background stops clear areas turning black.
      context.fillStyle = "#fff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      for (const quality of [JPEG_WEBP_QUALITY, 0.85, 0.75]) {
        const blob = await canvasBlob(canvas, "image/jpeg", quality);
        if (blob && blob.size <= maxBytes) return renamed(file, blob, "jpg");
      }
    }
  } finally {
    bitmap.close();
  }
  throw new Error("Could not shrink this photo enough for Telegram.");
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
      const videoBitrate = Math.round(totalBitrate - audioBitrate);
      if (audioTrack && audioBitrate === 0)
        throw new Error("This recording is too long to fit Telegram's 50 MB limit.");
      if (videoTrack && videoBitrate < 150_000)
        throw new Error("This video is too long to fit Telegram's 50 MB limit.");

      let video;
      if (videoTrack) {
        const { displayWidth, displayHeight } = videoTrack;
        const { averagePacketRate } = await videoTrack.computePacketStats(120);
        const fps = averagePacketRate > 0 ? averagePacketRate : 30;
        // Fewer pixels at a sane bitrate look better than full resolution starved of bits.
        const wanted = Math.sqrt(
          videoBitrate / (displayWidth * displayHeight * fps * VIDEO_MIN_BITS_PER_PIXEL),
        );
        const scale = Math.min(
          1,
          Math.max(wanted, VIDEO_MIN_SHORT_EDGE / Math.min(displayWidth, displayHeight)),
        );
        // H.264 needs even dimensions on both sides.
        const even = (size: number) => Math.round((size * scale) / 2) * 2;
        video = {
          codec: "avc" as const,
          bitrate: videoBitrate,
          width: even(displayWidth),
          height: even(displayHeight),
          fit: "fill" as const,
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
  throw new Error("Could not shrink this file enough for Telegram.");
}

/** Shrinks a file to at most maxBytes. Unlike compressMedia this must succeed, so it throws when it can't. */
export function fitMediaToSize(
  file: File,
  maxBytes: number,
  onProgress?: CompressProgress,
): Promise<File> {
  if (file.size <= maxBytes) return Promise.resolve(file);
  return file.type.startsWith("image/")
    ? fitImage(file, maxBytes)
    : fitAudioVideo(file, maxBytes, onProgress);
}

/** Returns a smaller copy of a photo or video, or the original file when compressing wouldn't help. */
export async function compressMedia(file: File, onProgress?: CompressProgress): Promise<File> {
  try {
    const result = file.type.startsWith("video/")
      ? await compressVideo(file, onProgress)
      : await compressImage(file);
    return result.size > 0 && result.size <= file.size * REQUIRED_RATIO ? result : file;
  } catch (error) {
    console.warn("Media compression skipped:", error);
    return file;
  }
}
