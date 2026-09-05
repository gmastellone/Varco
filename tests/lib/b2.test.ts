import { describe, it, expect, vi, afterEach } from "vitest";
import {
  presignPutUrl,
  fetchObject,
  deleteObject,
  listObjectKeys,
  b2ConfigFromEnv,
  type B2Config,
} from "../../src/lib/b2";
import type { Bindings } from "../../src/types";

const config: B2Config = {
  keyId: "test-key-id",
  appKey: "test-app-key",
  bucket: "varco-test",
  endpoint: "https://s3.us-west-004.backblazeb2.com",
  region: "us-west-004",
};

// aws4fetch's AwsClient.fetch() signs the request and hands the resulting
// Request object to global fetch (not a plain URL string). A bare Request
// stringifies to "[object Request]", so tests must read `.url` off it when
// `input` turns out to be a Request instance.
function requestUrl(input: RequestInfo | URL): string {
  return input instanceof Request ? input.url : String(input);
}

describe("b2ConfigFromEnv", () => {
  it("maps Worker bindings to a B2Config", () => {
    const env: Bindings = {
      FILES_KV: {} as unknown as KVNamespace,
      ASSETS: {} as unknown as Fetcher,
      B2_KEY_ID: "k",
      B2_APP_KEY: "s",
      B2_BUCKET: "bucket",
      B2_ENDPOINT: "https://example.com",
      B2_REGION: "r",
    };
    expect(b2ConfigFromEnv(env)).toEqual({
      keyId: "k",
      appKey: "s",
      bucket: "bucket",
      endpoint: "https://example.com",
      region: "r",
    });
  });
});

describe("presignPutUrl", () => {
  it("produces a query-signed PUT URL scoped to the given key", async () => {
    const url = await presignPutUrl(config, "f/2026/09/abc/report.pdf", 3600);
    const parsed = new URL(url);
    expect(parsed.pathname).toBe("/varco-test/f/2026/09/abc/report.pdf");
    expect(parsed.searchParams.get("X-Amz-Expires")).toBe("3600");
    expect(parsed.searchParams.has("X-Amz-Signature")).toBe(true);
    expect(parsed.searchParams.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
  });

  it("uses a 6-hour default expiry when none is given", async () => {
    const url = await presignPutUrl(config, "f/2026/09/abc/report.pdf");
    const parsed = new URL(url);
    expect(parsed.searchParams.get("X-Amz-Expires")).toBe(String(6 * 3600));
  });
});

describe("fetchObject / deleteObject / listObjectKeys", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetchObject issues a signed GET to the object URL and returns the raw response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        expect(requestUrl(input)).toContain("/varco-test/f/2026/09/abc/report.pdf");
        return new Response("file-bytes", { status: 200 });
      })
    );

    const response = await fetchObject(config, "f/2026/09/abc/report.pdf");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("file-bytes");
  });

  it("deleteObject resolves without throwing on a 2xx response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })));
    await expect(deleteObject(config, "f/2026/09/abc/report.pdf")).resolves.toBeUndefined();
  });

  it("deleteObject throws on a non-2xx, non-404 response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 500 })));
    await expect(deleteObject(config, "f/2026/09/abc/report.pdf")).rejects.toThrow();
  });

  it("listObjectKeys parses keys from a single-page XML response", async () => {
    const xml =
      '<?xml version="1.0"?><ListBucketResult><IsTruncated>false</IsTruncated>' +
      "<Contents><Key>f/2026/09/a/one.pdf</Key></Contents>" +
      "<Contents><Key>f/2026/09/b/two.pdf</Key></Contents></ListBucketResult>";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(xml, { status: 200 })));

    const keys = await listObjectKeys(config, "f/");
    expect(keys).toEqual(["f/2026/09/a/one.pdf", "f/2026/09/b/two.pdf"]);
  });

  it("listObjectKeys follows pagination via the continuation token", async () => {
    const page1 =
      '<?xml version="1.0"?><ListBucketResult><IsTruncated>true</IsTruncated>' +
      "<NextContinuationToken>tok1</NextContinuationToken>" +
      "<Contents><Key>f/a</Key></Contents></ListBucketResult>";
    const page2 =
      '<?xml version="1.0"?><ListBucketResult><IsTruncated>false</IsTruncated>' +
      "<Contents><Key>f/b</Key></Contents></ListBucketResult>";
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        call += 1;
        return new Response(call === 1 ? page1 : page2, { status: 200 });
      })
    );

    const keys = await listObjectKeys(config, "f/");
    expect(keys).toEqual(["f/a", "f/b"]);
    expect(call).toBe(2);
  });
});
