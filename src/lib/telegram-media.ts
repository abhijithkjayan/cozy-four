// Telegram's limits for files uploaded directly by a bot.
export const TELEGRAM_PHOTO_MAX_BYTES = 10 * 1024 * 1024;
export const TELEGRAM_FILE_MAX_BYTES = 50 * 1024 * 1024;

export type TelegramRoute = { method: string; field: string };

const DOCUMENT: TelegramRoute = { method: "sendDocument", field: "document" };

/**
 * The Bot API methods to try for a stored file, best first. The last route is always
 * sendDocument, which accepts any file type up to the 50 MB limit.
 */
export function telegramRoutes(messageType: string, mime: string, filename: string, size: number): TelegramRoute[] {
  const type = (mime.split(";")[0] ?? "").trim().toLowerCase();
  const extension = filename.split(".").pop()?.toLowerCase() ?? "";
  const is = (mimes: string[], extensions: string[]) => mimes.includes(type) || extensions.includes(extension);

  let typed: TelegramRoute | undefined;
  if (is(["image/gif"], ["gif"])) typed = { method: "sendAnimation", field: "animation" };
  else if (messageType === "image") {
    if (size <= TELEGRAM_PHOTO_MAX_BYTES && is(["image/jpeg", "image/png", "image/webp"], ["jpg", "jpeg", "png", "webp"]))
      typed = { method: "sendPhoto", field: "photo" };
  } else if (messageType === "video") {
    if (is(["video/mp4", "video/quicktime"], ["mp4", "mov", "m4v"])) typed = { method: "sendVideo", field: "video" };
  } else if (messageType === "audio") {
    if (is(["audio/ogg"], ["ogg", "oga"])) typed = { method: "sendVoice", field: "voice" };
    else if (is(["audio/mpeg", "audio/mp3", "audio/mp4", "audio/x-m4a"], ["mp3", "m4a"])) typed = { method: "sendAudio", field: "audio" };
  }
  return typed ? [typed, DOCUMENT] : [DOCUMENT];
}
