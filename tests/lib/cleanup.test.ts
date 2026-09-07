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
      "<Contents><Key>f/2026/09/a/keep.bin</Key><LastModified>2020-01-01T00:00:00.000Z</LastModified></Contents>" +
      "<Contents><Key>f/2026/09/b/orphan.bin</Key><LastModified>2020-01-01T00:00:00.000Z</LastModified></Contents></ListBucketResult>";

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
      "<Contents><Key>f/2026/09/a/keep.bin</Key><LastModified>2020-01-01T00:00:00.000Z</LastModified></Contents></ListBucketResult>";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(listXml, { status: 200 })));

    const result = await cleanupOrphanedObjects(makeEnv(kv));
    expect(result.deleted).toEqual([]);
  });

  it("does not delete an orphaned object younger than the 1-hour minimum age", async () => {
    const kv = createMockKv();
    // No live records at all, but we still want the sanity valve (zero live
    // records + objects present) to NOT be the reason nothing is deleted —
    // so give it one live record to keep that guard from tripping, and
    // isolate the min-age behavior under test.
    await putFileRecord(kv as unknown as KVNamespace, "tok1", makeRecord({ key: "f/2026/09/a/keep.bin" }), 86400);

    const recentIso = new Date(Date.now() - 5 * 60 * 1000).toISOString(); // 5 minutes ago
    const listXml =
      '<?xml version="1.0"?><ListBucketResult><IsTruncated>false</IsTruncated>' +
      `<Contents><Key>f/2026/09/a/keep.bin</Key><LastModified>2020-01-01T00:00:00.000Z</LastModified></Contents>` +
      `<Contents><Key>f/2026/09/b/fresh-orphan.bin</Key><LastModified>${recentIso}</LastModified></Contents></ListBucketResult>`;

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

    expect(result.deleted).toEqual([]);
    expect(deleteCalls.some((u) => u.includes("fresh-orphan.bin"))).toBe(false);
  });

  it("skips all deletions when KV has zero live records but B2 has objects (sanity valve)", async () => {
    const kv = createMockKv(); // no records ever written

    const listXml =
      '<?xml version="1.0"?><ListBucketResult><IsTruncated>false</IsTruncated>' +
      "<Contents><Key>f/2026/09/a/one.bin</Key><LastModified>2020-01-01T00:00:00.000Z</LastModified></Contents>" +
      "<Contents><Key>f/2026/09/b/two.bin</Key><LastModified>2020-01-01T00:00:00.000Z</LastModified></Contents></ListBucketResult>";

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

    expect(result.deleted).toEqual([]);
    expect(deleteCalls).toEqual([]);
  });

  it("recognizes live files with special characters as live, not orphaned (raw key <-> percent-encoded/XML-escaped B2 report)", async () => {
    const kv = createMockKv();
    // One filename that needs URL percent-encoding (space + accented
    // letter), one that needs XML entity-unescaping ("&"). record.key
    // holds the raw filename in both cases; the mocked ListObjectsV2
    // response reports what B2 would actually send on the wire: the
    // percent-encoded segment is decoded once by B2's own HTTP layer back
    // to raw UTF-8 (so <Key> is raw for that one), while "&" must be
    // XML-entity-escaped inside the XML itself.
    await putFileRecord(
      kv as unknown as KVNamespace,
      "tok1",
      makeRecord({ key: "f/2026/09/a/città file.pdf", filename: "città file.pdf" }),
      86400
    );
    await putFileRecord(
      kv as unknown as KVNamespace,
      "tok2",
      makeRecord({ key: "f/2026/09/b/R&D report.pdf", filename: "R&D report.pdf" }),
      86400
    );

    const listXml =
      '<?xml version="1.0"?><ListBucketResult><IsTruncated>false</IsTruncated>' +
      "<Contents><Key>f/2026/09/a/città file.pdf</Key><LastModified>2020-01-01T00:00:00.000Z</LastModified></Contents>" +
      "<Contents><Key>f/2026/09/b/R&amp;D report.pdf</Key><LastModified>2020-01-01T00:00:00.000Z</LastModified></Contents></ListBucketResult>";

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

    expect(result.deleted).toEqual([]);
    expect(deleteCalls).toEqual([]);
  });

  it("does not trip the sanity valve when both KV and B2 are genuinely empty", async () => {
    const kv = createMockKv(); // no records ever written

    const listXml =
      '<?xml version="1.0"?><ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>';
    vi.stubGlobal("fetch", vi.fn(async () => new Response(listXml, { status: 200 })));

    const result = await cleanupOrphanedObjects(makeEnv(kv));
    expect(result.deleted).toEqual([]);
  });
});
