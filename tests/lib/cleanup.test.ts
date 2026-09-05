import { describe, it, expect, afterEach, vi } from "vitest";
import { createMockKv } from "../helpers/mockKv";
import { putFileRecord, type FileRecord } from "../../src/lib/kv";
import { cleanupOrphanedObjects } from "../../src/lib/cleanup";
import type { Bindings } from "../../src/types";

function makeEnv(kv: ReturnType<typeof createMockKv>): Bindings {
  return {
    FILES_KV: kv as unknown as KVNamespace,
    ASSETS: {} as unknown as Fetcher,
    B2_KEY_ID: "k",
    B2_APP_KEY: "s",
    B2_BUCKET: "varco-test",
    B2_ENDPOINT: "https://s3.us-west-004.backblazeb2.com",
    B2_REGION: "r",
  };
}

function makeRecord(overrides: Partial<FileRecord> = {}): FileRecord {
  return {
    fileId: "id",
    key: "f/2026/09/id/file.bin",
    filename: "file.bin",
    size: 1,
    hash: "h",
    salt: "s",
    expiresAt: Date.now() + 86400000,
    downloadCount: 0,
    ...overrides,
  };
}

// aws4fetch's AwsClient.fetch() signs the request and hands the resulting
// Request object to global fetch as a single argument (not a plain URL
// string plus a separate init) — see tests/lib/b2.test.ts for the same
// note. So the method must be read off the Request instance, not off a
// (possibly undefined) `init` parameter.
function requestInfo(input: RequestInfo | URL, init?: RequestInit): { url: string; method: string } {
  if (input instanceof Request) {
    return { url: input.url, method: input.method };
  }
  return { url: String(input), method: init?.method ?? "GET" };
}

describe("cleanupOrphanedObjects", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("deletes B2 objects that have no matching live KV record", async () => {
    const kv = createMockKv();
    await putFileRecord(kv as unknown as KVNamespace, "tok1", makeRecord({ key: "f/2026/09/a/keep.bin" }), 86400);

    const listXml =
      '<?xml version="1.0"?><ListBucketResult><IsTruncated>false</IsTruncated>' +
      "<Contents><Key>f/2026/09/a/keep.bin</Key></Contents>" +
      "<Contents><Key>f/2026/09/b/orphan.bin</Key></Contents></ListBucketResult>";

    const deleteCalls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const { url, method } = requestInfo(input, init);
        if (method === "DELETE") {
          deleteCalls.push(url);
          return new Response(null, { status: 204 });
        }
        return new Response(listXml, { status: 200 });
      })
    );

    const result = await cleanupOrphanedObjects(makeEnv(kv));

    expect(result.deleted).toEqual(["f/2026/09/b/orphan.bin"]);
    expect(deleteCalls.some((u) => u.includes("orphan.bin"))).toBe(true);
    expect(deleteCalls.some((u) => u.includes("keep.bin"))).toBe(false);
  });

  it("deletes nothing when every B2 object has a live record", async () => {
    const kv = createMockKv();
    await putFileRecord(kv as unknown as KVNamespace, "tok1", makeRecord({ key: "f/2026/09/a/keep.bin" }), 86400);

    const listXml =
      '<?xml version="1.0"?><ListBucketResult><IsTruncated>false</IsTruncated>' +
      "<Contents><Key>f/2026/09/a/keep.bin</Key></Contents></ListBucketResult>";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(listXml, { status: 200 })));

    const result = await cleanupOrphanedObjects(makeEnv(kv));
    expect(result.deleted).toEqual([]);
  });
});
