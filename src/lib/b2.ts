import { AwsClient } from "aws4fetch";
import type { Bindings } from "../types";

export interface B2Config {
  keyId: string;
  appKey: string;
  bucket: string;
  endpoint: string;
  region: string;
}

export function b2ConfigFromEnv(env: Bindings): B2Config {
  return {
    keyId: env.B2_KEY_ID,
    appKey: env.B2_APP_KEY,
    bucket: env.B2_BUCKET,
    endpoint: env.B2_ENDPOINT,
    region: env.B2_REGION,
  };
}

const DEFAULT_PUT_EXPIRES_SECONDS = 6 * 3600;

function client(config: B2Config): AwsClient {
  return new AwsClient({
    accessKeyId: config.keyId,
    secretAccessKey: config.appKey,
    service: "s3",
    region: config.region,
    // aws4fetch retries 500/429 responses with exponential backoff by
    // default (10 retries, up to ~25s of cumulative sleep). That sleep is
    // wall-clock latency, not Workers CPU time, but a request left hanging
    // that long is still bad for a download/upload the client is waiting
    // on. Fail fast instead; callers (routes, cron cleanup) can add their
    // own bounded retry later if B2 turns out to need it in practice.
    retries: 0,
  });
}

function objectUrl(config: B2Config, key: string): URL {
  const base = config.endpoint.replace(/\/+$/, "");
  // Percent-encode each path segment independently so `/` is preserved as a
  // literal path separator (never becomes %2F) while characters within a
  // segment (spaces, non-ASCII, `#`, `?`, ...) are properly escaped. This is
  // the only place a B2 object key gets encoded — record.key itself (as
  // stored in KV) is always the raw, unencoded filename; encoding it before
  // this point would make the wire-level `%XX` sequences pass through the
  // URL constructor unchanged (it doesn't double-encode valid escapes),
  // which caused stored keys to permanently diverge from the raw keys B2's
  // ListObjectsV2 reports.
  const encodedKey = key
    .split("/")
    .map(encodeURIComponent)
    .join("/");
  return new URL(`${base}/${config.bucket}/${encodedKey}`);
}

export async function presignPutUrl(
  config: B2Config,
  key: string,
  expiresInSeconds: number = DEFAULT_PUT_EXPIRES_SECONDS
): Promise<string> {
  const url = objectUrl(config, key);
  url.searchParams.set("X-Amz-Expires", String(expiresInSeconds));
  const signed = await client(config).sign(url.toString(), {
    method: "PUT",
    aws: { signQuery: true },
  });
  return signed.url;
}

export async function fetchObject(config: B2Config, key: string): Promise<Response> {
  const url = objectUrl(config, key);
  return client(config).fetch(url.toString(), { method: "GET" });
}

export async function deleteObject(config: B2Config, key: string): Promise<void> {
  const url = objectUrl(config, key);
  const response = await client(config).fetch(url.toString(), { method: "DELETE" });
  if (!response.ok && response.status !== 404) {
    throw new Error(`B2 delete failed for ${key}: ${response.status}`);
  }
}

export interface B2ObjectInfo {
  key: string;
  lastModified: Date;
}

export async function listObjects(config: B2Config, prefix: string): Promise<B2ObjectInfo[]> {
  const objects: B2ObjectInfo[] = [];
  let continuationToken: string | undefined;

  do {
    const url = new URL(`${config.endpoint.replace(/\/+$/, "")}/${config.bucket}`);
    url.searchParams.set("list-type", "2");
    url.searchParams.set("prefix", prefix);
    if (continuationToken) url.searchParams.set("continuation-token", continuationToken);

    const response = await client(config).fetch(url.toString(), { method: "GET" });
    if (!response.ok) {
      throw new Error(`B2 list failed: ${response.status}`);
    }
    const xml = await response.text();
    // Each object's metadata (Key, LastModified, ...) lives inside its own
    // <Contents> block. Match blocks first, then extract fields from within
    // each one, so a key is never paired with a neighboring entry's
    // LastModified (which a flat whole-document regex scan would risk).
    for (const match of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const block = match[1];
      const keyMatch = block.match(/<Key>([^<]*)<\/Key>/);
      if (!keyMatch) continue;
      const lastModifiedMatch = block.match(/<LastModified>([^<]*)<\/LastModified>/);
      objects.push({
        key: keyMatch[1],
        lastModified: new Date(lastModifiedMatch ? lastModifiedMatch[1] : 0),
      });
    }
    const truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
    const tokenMatch = xml.match(/<NextContinuationToken>([^<]*)<\/NextContinuationToken>/);
    continuationToken = truncated && tokenMatch ? tokenMatch[1] : undefined;
  } while (continuationToken);

  return objects;
}
