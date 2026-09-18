import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { createMockKv, type MockKv } from "../helpers/mockKv";
import { multipartRoute } from "../../src/routes/multipart";
import type { Bindings } from "../../src/types";
import { putInviteRecord, type InviteRecord } from "../../src/lib/kv";
import { hashPassword } from "../../src/lib/crypto";

function makeEnv(kv: MockKv): Bindings {
  return {
    FILES_KV: kv as unknown as KVNamespace,
    ASSETS: {} as unknown as Fetcher,
    B2_KEY_ID: "test-key",
    B2_APP_KEY: "test-secret",
    B2_BUCKET: "varco-test",
    B2_ENDPOINT: "https://s3.us-west-004.backblazeb2.com",
    B2_REGION: "us-west-004",
  };
}

const CREATE_MULTIPART_XML =
  '<?xml version="1.0"?><InitiateMultipartUploadResult><UploadId>up-test</UploadId></InitiateMultipartUploadResult>';

function stubB2Fetch(handler: (input: RequestInfo | URL, init?: RequestInit) => Response | Promise<Response>) {
  vi.stubGlobal("fetch", vi.fn(handler));
}

async function initUpload(
  kv: MockKv,
  headers: Record<string, string>,
  body: Record<string, unknown> = { filename: "big.zip", size: 250 * 1024 * 1024, expiresInDays: 7 },
  path = "/api/upload/multipart/init"
) {
  stubB2Fetch(async () => new Response(CREATE_MULTIPART_XML, { status: 200 }));
  const res = await multipartRoute.request(path, { method: "POST", headers, body: JSON.stringify(body) }, makeEnv(kv));
  vi.unstubAllGlobals();
  return res;
}

describe("multipart upload routes", () => {
  let kv: MockKv;
  const ownerHeaders = { "Cf-Access-Authenticated-User-Email": "me@example.com" };

  beforeEach(() => {
    kv = createMockKv();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("POST /api/upload/multipart/init", () => {
    it("rejects requests with no auth header and no invite token", async () => {
      const res = await initUpload(kv, {});
      expect(res.status).toBe(403);
    });

    it("creates a B2 multipart upload and returns a token with the correct part count", async () => {
      const res = await initUpload(kv, ownerHeaders, {
        filename: "big.zip",
        size: 250 * 1024 * 1024, // 250MB at 100MB/part -> 3 parts
        expiresInDays: 7,
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as any;
      expect(json.multipartToken).toMatch(/^[0-9a-f]{64}$/);
      expect(json.partSize).toBe(100 * 1024 * 1024);
      expect(json.partCount).toBe(3);
    });

    it("rejects a malformed body", async () => {
      const res = await initUpload(kv, ownerHeaders, { filename: "" });
      expect(res.status).toBe(400);
    });

    it("also works on the invite-prefixed path with a valid invite token", async () => {
      const invite: InviteRecord = {
        label: "friend",
        maxFiles: 1,
        remainingFiles: 1,
        createdAt: Date.now(),
        expiresAt: Date.now() + 3600_000,
      };
      await putInviteRecord(kv as unknown as KVNamespace, "inv1", invite, 3600);

      const res = await initUpload(
        kv,
        {},
        { filename: "big.zip", size: 10 * 1024 * 1024, expiresInDays: 7 },
        "/api/guest-upload/multipart/init?invite=inv1"
      );
      expect(res.status).toBe(200);
      const json = (await res.json()) as any;
      expect(json.partCount).toBe(1);
    });

    it("does not decrement the invite's remaining count at init time", async () => {
      const invite: InviteRecord = {
        label: "friend",
        maxFiles: 1,
        remainingFiles: 1,
        createdAt: Date.now(),
        expiresAt: Date.now() + 3600_000,
      };
      await putInviteRecord(kv as unknown as KVNamespace, "inv1", invite, 3600);

      await initUpload(kv, {}, { filename: "big.zip", size: 10, expiresInDays: 7 }, "/api/guest-upload/multipart/init?invite=inv1");

      const stored = await kv.get("invite:inv1", "json");
      expect(stored.remainingFiles).toBe(1);
    });
  });

  describe("POST /api/upload/multipart/part-url", () => {
    it("returns 404 for an unknown multipartToken", async () => {
      const res = await multipartRoute.request(
        "/api/upload/multipart/part-url",
        { method: "POST", headers: ownerHeaders, body: JSON.stringify({ multipartToken: "nope", partNumber: 1 }) },
        makeEnv(kv)
      );
      expect(res.status).toBe(404);
    });

    it("returns 404 when a different identity requests someone else's pending upload", async () => {
      const initRes = await initUpload(kv, ownerHeaders);
      const { multipartToken } = (await initRes.json()) as any;

      const res = await multipartRoute.request(
        "/api/upload/multipart/part-url",
        {
          method: "POST",
          headers: { "Cf-Access-Authenticated-User-Email": "someone-else@example.com" },
          body: JSON.stringify({ multipartToken, partNumber: 1 }),
        },
        makeEnv(kv)
      );
      expect(res.status).toBe(404);
    });

    it("rejects a part number beyond partCount", async () => {
      const initRes = await initUpload(kv, ownerHeaders, {
        filename: "big.zip",
        size: 10 * 1024 * 1024,
        expiresInDays: 7,
      });
      const { multipartToken } = (await initRes.json()) as any;

      const res = await multipartRoute.request(
        "/api/upload/multipart/part-url",
        { method: "POST", headers: ownerHeaders, body: JSON.stringify({ multipartToken, partNumber: 2 }) },
        makeEnv(kv)
      );
      expect(res.status).toBe(400);
    });

    it("returns a presigned PUT URL scoped to the part and uploadId", async () => {
      const initRes = await initUpload(kv, ownerHeaders, {
        filename: "big.zip",
        size: 250 * 1024 * 1024,
        expiresInDays: 7,
      });
      const { multipartToken } = (await initRes.json()) as any;

      const res = await multipartRoute.request(
        "/api/upload/multipart/part-url",
        { method: "POST", headers: ownerHeaders, body: JSON.stringify({ multipartToken, partNumber: 2 }) },
        makeEnv(kv)
      );
      expect(res.status).toBe(200);
      const json = (await res.json()) as any;
      const parsed = new URL(json.url);
      expect(parsed.searchParams.get("partNumber")).toBe("2");
      expect(parsed.searchParams.get("uploadId")).toBe("up-test");
      expect(parsed.searchParams.has("X-Amz-Signature")).toBe(true);
    });
  });

  describe("POST /api/upload/multipart/list-parts", () => {
    it("returns the pending upload metadata plus parts already on B2", async () => {
      const initRes = await initUpload(kv, ownerHeaders, {
        filename: "big.zip",
        size: 250 * 1024 * 1024,
        expiresInDays: 7,
      });
      const { multipartToken } = (await initRes.json()) as any;

      stubB2Fetch(
        async () =>
          new Response(
            '<?xml version="1.0"?><ListPartsResult><IsTruncated>false</IsTruncated>' +
              '<Part><PartNumber>1</PartNumber><ETag>"e1"</ETag><Size>104857600</Size></Part></ListPartsResult>',
            { status: 200 }
          )
      );
      const res = await multipartRoute.request(
        "/api/upload/multipart/list-parts",
        { method: "POST", headers: ownerHeaders, body: JSON.stringify({ multipartToken }) },
        makeEnv(kv)
      );
      expect(res.status).toBe(200);
      const json = (await res.json()) as any;
      expect(json.filename).toBe("big.zip");
      expect(json.partCount).toBe(3);
      expect(json.parts).toEqual([{ partNumber: 1, eTag: '"e1"', size: 104857600 }]);
    });
  });

  describe("POST /api/upload/multipart/complete", () => {
    it("rejects when the submitted part count doesn't match partCount", async () => {
      const initRes = await initUpload(kv, ownerHeaders, {
        filename: "big.zip",
        size: 250 * 1024 * 1024,
        expiresInDays: 7,
      });
      const { multipartToken } = (await initRes.json()) as any;

      const res = await multipartRoute.request(
        "/api/upload/multipart/complete",
        {
          method: "POST",
          headers: ownerHeaders,
          body: JSON.stringify({ multipartToken, parts: [{ partNumber: 1, eTag: '"e1"' }] }),
        },
        makeEnv(kv)
      );
      expect(res.status).toBe(400);
    });

    it("completes on B2, creates a file record, and returns a download link + password", async () => {
      const initRes = await initUpload(kv, ownerHeaders, {
        filename: "big.zip",
        size: 10 * 1024 * 1024,
        expiresInDays: 7,
      });
      const { multipartToken } = (await initRes.json()) as any;

      stubB2Fetch(async () => new Response("<CompleteMultipartUploadResult/>", { status: 200 }));
      const res = await multipartRoute.request(
        "/api/upload/multipart/complete",
        {
          method: "POST",
          headers: ownerHeaders,
          body: JSON.stringify({ multipartToken, parts: [{ partNumber: 1, eTag: '"e1"' }] }),
        },
        makeEnv(kv)
      );
      expect(res.status).toBe(200);
      const json = (await res.json()) as any;
      expect(json.downloadUrl).toMatch(/^\/d\/[0-9a-f]{64}$/);
      expect(json.password).toHaveLength(12);

      const token = json.downloadUrl.split("/").pop();
      const record = await kv.get(`file:${token}`, "json");
      expect(record.filename).toBe("big.zip");
      expect(record.uploaderEmail).toBe("me@example.com");
      expect(record.key.startsWith("f/")).toBe(true);
      expect(record.hash).toBe(await hashPassword(json.password, record.salt));

      // The pending-upload bookkeeping record is cleaned up once finalized.
      expect(await kv.get(`pending:${multipartToken}`, "json")).toBeNull();
    });

    it("decrements the invite's remaining count only on successful completion", async () => {
      const invite: InviteRecord = {
        label: "friend",
        maxFiles: 1,
        remainingFiles: 1,
        createdAt: Date.now(),
        expiresAt: Date.now() + 3600_000,
      };
      await putInviteRecord(kv as unknown as KVNamespace, "inv1", invite, 3600);

      const initRes = await initUpload(
        kv,
        {},
        { filename: "big.zip", size: 10, expiresInDays: 7 },
        "/api/guest-upload/multipart/init?invite=inv1"
      );
      const { multipartToken } = (await initRes.json()) as any;

      stubB2Fetch(async () => new Response("<CompleteMultipartUploadResult/>", { status: 200 }));
      const res = await multipartRoute.request(
        "/api/guest-upload/multipart/complete?invite=inv1",
        {
          method: "POST",
          body: JSON.stringify({ multipartToken, parts: [{ partNumber: 1, eTag: '"e1"' }] }),
        },
        makeEnv(kv)
      );
      expect(res.status).toBe(200);

      const updatedInvite = await kv.get("invite:inv1", "json");
      expect(updatedInvite.remainingFiles).toBe(0);
    });
  });

  describe("POST /api/upload/multipart/abort", () => {
    it("aborts the B2 multipart upload and deletes the pending record", async () => {
      const initRes = await initUpload(kv, ownerHeaders, {
        filename: "big.zip",
        size: 10 * 1024 * 1024,
        expiresInDays: 7,
      });
      const { multipartToken } = (await initRes.json()) as any;

      let abortCalled = false;
      stubB2Fetch(async (input) => {
        abortCalled = true;
        expect(String(input instanceof Request ? input.url : input)).toContain("uploadId=up-test");
        return new Response(null, { status: 204 });
      });
      const res = await multipartRoute.request(
        "/api/upload/multipart/abort",
        { method: "POST", headers: ownerHeaders, body: JSON.stringify({ multipartToken }) },
        makeEnv(kv)
      );
      expect(res.status).toBe(200);
      expect(abortCalled).toBe(true);
      expect(await kv.get(`pending:${multipartToken}`, "json")).toBeNull();
    });
  });
});
