import test from "node:test";
import assert from "node:assert/strict";
import { multipartFrame, telegramUpload } from "../src/lib/telegram-upload.ts";

const bytes = (n: number) => Uint8Array.from({ length: n }, (_, i) => i % 251);
const streamOf = (data: Uint8Array) => new Blob([data]).stream() as ReadableStream<Uint8Array>;

test("multipart frame parses back to the same fields and file", async () => {
  const data = bytes(70_000);
  const { boundary, prefix, suffix } = multipartFrame({ chat_id: "-100123" }, "video", 'clip "1".mp4', "video/mp4");
  const form = await new Response(new Blob([prefix, data, suffix]), {
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
  }).formData();
  assert.equal(form.get("chat_id"), "-100123");
  const file = form.get("video") as File;
  assert.equal(file.name, "clip _1_.mp4");
  assert.equal(file.type, "video/mp4");
  assert.deepEqual(new Uint8Array(await file.arrayBuffer()), data);
});

test("streams with the exact declared length when FixedLengthStream exists (Cloudflare Workers)", async () => {
  let declared = 0;
  (globalThis as Record<string, unknown>)["FixedLengthStream"] = class {
    readable: ReadableStream<Uint8Array>;
    writable: WritableStream<Uint8Array>;
    constructor(length: number) {
      declared = length;
      const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
      this.readable = readable;
      this.writable = writable;
    }
  };
  try {
    const data = bytes(200_000);
    const request = await telegramUpload({ chat_id: "42" }, "document", "a.bin", {
      body: streamOf(data),
      size: data.byteLength,
      type: "application/octet-stream",
    });
    const sent = new Uint8Array(await new Response(request.body as ReadableStream).arrayBuffer());
    assert.equal(sent.byteLength, declared);
    const form = await new Response(sent, { headers: request.headers }).formData();
    assert.equal(form.get("chat_id"), "42");
    assert.deepEqual(new Uint8Array(await (form.get("document") as File).arrayBuffer()), data);
  } finally {
    delete (globalThis as Record<string, unknown>)["FixedLengthStream"];
  }
});

test("buffers into FormData where FixedLengthStream is missing (local development)", async () => {
  const data = bytes(1000);
  const request = await telegramUpload({ chat_id: "42" }, "photo", "p.jpg", {
    body: streamOf(data),
    size: data.byteLength,
    type: "image/jpeg",
  });
  assert.ok(request.body instanceof FormData);
  assert.deepEqual(new Uint8Array(await (request.body.get("photo") as File).arrayBuffer()), data);
});
