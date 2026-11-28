// Builds the multipart/form-data request that uploads one file to the Telegram Bot API.
// No project imports here, so the unit test can load this file on its own.

export type UploadFile = { body: ReadableStream<Uint8Array>; size: number; type: string };
export type UploadRequest = { body: BodyInit; headers: Record<string, string> };

type FixedLengthStreamCtor = new (length: number) => {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
};

/** The bytes that go before and after the file in a multipart body. */
export function multipartFrame(fields: Record<string, string>, fileField: string, filename: string, contentType: string) {
  const boundary = `----upload${crypto.randomUUID().replace(/-/g, "")}`;
  // Header values: plain ASCII, no quotes or line breaks.
  const safe = (value: string) => value.replace(/[^\x20-\x7E]|["\\]/g, "_");
  let head = "";
  for (const [name, value] of Object.entries(fields)) {
    head += `--${boundary}\r\nContent-Disposition: form-data; name="${safe(name)}"\r\n\r\n${value}\r\n`;
  }
  head += `--${boundary}\r\nContent-Disposition: form-data; name="${safe(fileField)}"; filename="${safe(filename)}"\r\nContent-Type: ${safe(contentType) || "application/octet-stream"}\r\n\r\n`;
  const encoder = new TextEncoder();
  return { boundary, prefix: encoder.encode(head), suffix: encoder.encode(`\r\n--${boundary}--\r\n`) };
}

/**
 * On Cloudflare Workers the file is streamed straight through with a known length, so a 50 MB
 * video never sits in the Worker's 128 MB of memory. Holding it there two or three times over
 * (chunks, Blob, form) is what made large files fail. Elsewhere (local development) it is
 * buffered, which is fine there.
 */
export async function telegramUpload(fields: Record<string, string>, fileField: string, filename: string, file: UploadFile): Promise<UploadRequest> {
  const Fixed = (globalThis as { FixedLengthStream?: FixedLengthStreamCtor }).FixedLengthStream;
  if (!Fixed || !(file.size > 0)) {
    const form = new FormData();
    for (const [name, value] of Object.entries(fields)) form.append(name, value);
    form.append(fileField, new Blob([await new Response(file.body).arrayBuffer()], { type: file.type }), filename);
    return { body: form, headers: {} };
  }
  const { boundary, prefix, suffix } = multipartFrame(fields, fileField, filename, file.type);
  const { readable, writable } = new Fixed(prefix.byteLength + file.size + suffix.byteLength);
  void (async () => {
    const head = writable.getWriter();
    await head.write(prefix);
    head.releaseLock();
    await file.body.pipeTo(writable, { preventClose: true });
    const tail = writable.getWriter();
    await tail.write(suffix);
    await tail.close();
  })().catch((error: unknown) => {
    // Telegram closed the upload early (its answer says why), or storage failed part-way.
    console.error("Telegram upload stream stopped:", error);
    void writable.abort(error).catch(() => {});
  });
  return { body: readable, headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
}
