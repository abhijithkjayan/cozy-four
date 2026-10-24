// Private Cloudflare R2 bucket for the NAUGHTY stickers, reached over the S3 API with SigV4.
// Secrets (server only): Account_ID, S3_API (the bucket's S3 API URL, https://<account>.r2.cloudflarestorage.com/<bucket>),
// R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY; optional R2_BUCKET (if S3_API has no bucket) and R2_PREFIX.
// The browser never talks to R2: stickers are listed by a server fn and streamed through /naughty/<key>.

export const NAUGHTY_PATH = "/naughty/";
const MEDIA = /\.(gif|webp|png|jpe?g)$/i;
const TYPES: Record<string, string> = { gif: "image/gif", webp: "image/webp", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg" };

type R2Config = { account: string; accessKey: string; secretKey: string; bucket: string; prefix: string };

// Secret names are matched loosely ("Account_ID", "ACCOUNT ID", "account-id" all work).
const norm = (name: string) => name.toUpperCase().replace(/[^A-Z0-9]/g, "");
function env(...names: string[]) {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  const wanted = names.map(norm);
  for (const [name, value] of Object.entries(process.env)) {
    if (value?.trim() && wanted.includes(norm(name))) return value.trim();
  }
  return "";
}

function readConfig(): { cfg: R2Config | null; missing: string[] } {
  let api: URL | null = null;
  const rawApi = env("S3_API", "R2_S3_API", "S3_API_URL", "R2_ENDPOINT");
  try { if (rawApi) api = new URL(/^https?:\/\//i.test(rawApi) ? rawApi : `https://${rawApi}`); } catch { /* not a URL */ }
  const account = env("Account_ID", "R2_ACCOUNT_ID", "CLOUDFLARE_ACCOUNT_ID") || (api?.hostname.endsWith(".r2.cloudflarestorage.com") ? api.hostname.split(".")[0]! : "");
  const accessKey = env("R2_ACCESS_KEY_ID", "ACCESS_KEY_ID", "R2_ACCESS_KEY");
  const secretKey = env("R2_SECRET_ACCESS_KEY", "SECRET_ACCESS_KEY", "R2_SECRET_KEY");
  const bucket = env("R2_BUCKET", "BUCKET", "R2_BUCKET_NAME", "BUCKET_NAME") || decodeURIComponent(api?.pathname.split("/").filter(Boolean)[0] ?? "");
  const missing = [
    !account && "account ID (Account_ID, or S3_API URL)",
    !accessKey && "R2_ACCESS_KEY_ID",
    !secretKey && "R2_SECRET_ACCESS_KEY",
    !bucket && "bucket name (R2_BUCKET, or S3_API URL ending in /<bucket>)",
  ].filter((m): m is string => !!m);
  if (missing.length) return { cfg: null, missing };
  const prefix = env("R2_PREFIX").replace(/^\/+/, "");
  return { cfg: { account, accessKey, secretKey, bucket, prefix }, missing };
}

const config = () => readConfig().cfg;

/** Why R2 isn't usable: the missing pieces plus the related secret NAMES the server can see (never values). */
function configProblem() {
  const { missing } = readConfig();
  const seen = Object.keys(process.env).filter((n) => /R2|S3|ACCOUNT|BUCKET|ACCESS|SECRET/i.test(n) && !/SUPABASE|LOVABLE|GIPHY|KLIPY|TURN/i.test(n));
  return `R2 is not configured. Missing: ${missing.join(", ")}. Secrets seen: ${seen.length ? seen.join(", ") : "none"}.`;
}

const enc = new TextEncoder();
const hex = (buf: ArrayBuffer) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
const sha256 = async (s: string) => hex(await crypto.subtle.digest("SHA-256", enc.encode(s)));
async function hmac(key: ArrayBuffer, s: string) {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", k, enc.encode(s));
}
// RFC 3986 encoding as SigV4 expects it.
const rfc3986 = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** Signed GET against the bucket. `key` "" targets the bucket itself (used for listing). */
async function r2Get(cfg: R2Config, key: string, query: Record<string, string> = {}): Promise<Response> {
  const host = `${cfg.account}.r2.cloudflarestorage.com`;
  const path = `/${[cfg.bucket, ...(key ? key.split("/") : [])].map(rfc3986).join("/")}`;
  const qs = Object.keys(query).sort().map((k) => `${rfc3986(k)}=${rfc3986(query[k]!)}`).join("&");
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
  const day = amzDate.slice(0, 8);
  const scope = `${day}/auto/s3/aws4_request`;
  const payload = "UNSIGNED-PAYLOAD";
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
  const canonical = ["GET", path, qs, `host:${host}\nx-amz-content-sha256:${payload}\nx-amz-date:${amzDate}\n`, signedHeaders, payload].join("\n");
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, await sha256(canonical)].join("\n");
  let signingKey = await hmac(enc.encode(`AWS4${cfg.secretKey}`).buffer as ArrayBuffer, day);
  for (const part of ["auto", "s3", "aws4_request"]) signingKey = await hmac(signingKey, part);
  const signature = hex(await hmac(signingKey, toSign));
  return fetch(`https://${host}${path}${qs ? `?${qs}` : ""}`, {
    headers: {
      "x-amz-content-sha256": payload,
      "x-amz-date": amzDate,
      Authorization: `AWS4-HMAC-SHA256 Credential=${cfg.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
  });
}

const unxml = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

// The bucket only changes when new GIFs are uploaded, so the key list is cached briefly per isolate.
let cached: { at: number; keys: string[] } | null = null;
type Listing = { keys: string[]; error?: string };
const CACHE_MS = 5 * 60 * 1000;

/** Every sticker key in the bucket (under R2_PREFIX), sorted, plus a reason when listing failed. */
export async function listNaughtyKeys(): Promise<Listing> {
  const cfg = config();
  if (!cfg) return { keys: [], error: configProblem() };
  if (cached && Date.now() - cached.at < CACHE_MS) return { keys: cached.keys };
  const keys: string[] = [];
  let token = "";
  for (let i = 0; i < 50; i++) {
    const res = await r2Get(cfg, "", { "list-type": "2", "max-keys": "1000", ...(cfg.prefix ? { prefix: cfg.prefix } : {}), ...(token ? { "continuation-token": token } : {}) });
    if (!res.ok) {
      const body = await res.text();
      console.error(`R2 list failed [${res.status}]: ${body}`);
      const code = /<Code>([^<]*)<\/Code>/.exec(body)?.[1] ?? "";
      return { keys, error: `R2 list failed (${res.status}${code ? ` ${code}` : ""}) for bucket "${cfg.bucket}".` };
    }
    const xml = await res.text();
    for (const m of xml.matchAll(/<Key>([\s\S]*?)<\/Key>/g)) {
      const key = unxml(m[1]!);
      if (MEDIA.test(key)) keys.push(key);
    }
    token = /<IsTruncated>true<\/IsTruncated>/.test(xml) ? unxml(/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml)?.[1] ?? "") : "";
    if (!token) break;
  }
  keys.sort();
  cached = { at: Date.now(), keys };
  return { keys };
}

/** Key relative to R2_PREFIX, used for folder tags and the public /naughty/ path. */
export function relativeKey(key: string) {
  const prefix = config()?.prefix ?? "";
  return prefix && key.startsWith(prefix) ? key.slice(prefix.length).replace(/^\/+/, "") : key;
}

export const naughtyUrl = (key: string) => NAUGHTY_PATH + relativeKey(key).split("/").map(encodeURIComponent).join("/");

/** Streams one sticker from R2 for GET /naughty/<key>. */
export async function serveNaughty(request: Request): Promise<Response> {
  const cfg = config();
  const rel = decodeURIComponent(new URL(request.url).pathname.slice(NAUGHTY_PATH.length));
  if (!cfg || request.method !== "GET" || !MEDIA.test(rel) || rel.split("/").some((p) => !p || p === "." || p === "..")) {
    return new Response("Not found", { status: 404 });
  }
  const key = cfg.prefix ? `${cfg.prefix.replace(/\/+$/, "")}/${rel}` : rel;
  const res = await r2Get(cfg, key);
  if (!res.ok || !res.body) {
    const body = await res.text().catch(() => "");
    console.error(`R2 get failed [${res.status}] ${key}: ${body}`);
    const code = /<Code>([^<]*)<\/Code>/.exec(body)?.[1] ?? "";
    return new Response(`R2 ${res.status} ${code}`.trim(), { status: res.status === 404 ? 404 : 502 });
  }
  const ext = rel.slice(rel.lastIndexOf(".") + 1).toLowerCase();
  return new Response(res.body, {
    headers: {
      "content-type": TYPES[ext] ?? "application/octet-stream",
      "cache-control": "private, max-age=604800, immutable",
      "x-robots-tag": "noindex",
    },
  });
}
