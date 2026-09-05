import { describe, it, expect, beforeEach } from "vitest";
import { createMockKv, type MockKv } from "../helpers/mockKv";
import { uploadRoute } from "../../src/routes/upload";
import type { Bindings } from "../../src/types";
import { putInviteRecord, type InviteRecord } from "../../src/lib/kv";

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

describe("POST /api/upload", () => {
  let kv: MockKv;

  beforeEach(() => {
    kv = createMockKv();
  });

  it("rejects requests with no auth header and no invite token", async () => {
    const res = await uploadRoute.request(
      "/api/upload",
      { method: "POST", body: JSON.stringify({ filename: "a.txt", size: 10, expiresInDays: 7 }) },
      makeEnv(kv)
    );
    expect(res.status).toBe(403);
  });

  it("accepts a fixed user identified via the Cf-Access header", async () => {
    const res = await uploadRoute.request(
      "/api/upload",
      {
        method: "POST",
        headers: { "Cf-Access-Authenticated-User-Email": "me@example.com" },
        body: JSON.stringify({ filename: "a.txt", size: 10, expiresInDays: 7 }),
      },
      makeEnv(kv)
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.downloadUrl).toMatch(/^\/d\/[0-9a-f]{64}$/);
    expect(json.password).toHaveLength(12);
    expect(json.uploadUrl).toContain("varco-test");
  });

  it("rejects an unknown invite token", async () => {
    const res = await uploadRoute.request(
      "/api/upload?invite=nope",
      { method: "POST", body: JSON.stringify({ filename: "a.txt", size: 10, expiresInDays: 7 }) },
      makeEnv(kv)
    );
    expect(res.status).toBe(403);
  });

  it("accepts and decrements a valid invite token", async () => {
    const invite: InviteRecord = {
      label: "friend",
      maxFiles: 2,
      remainingFiles: 2,
      createdAt: Date.now(),
      expiresAt: Date.now() + 3600_000,
    };
    await putInviteRecord(kv as unknown as KVNamespace, "inv1", invite, 3600);

    const res = await uploadRoute.request(
      "/api/upload?invite=inv1",
      { method: "POST", body: JSON.stringify({ filename: "a.txt", size: 10, expiresInDays: 7 }) },
      makeEnv(kv)
    );
    expect(res.status).toBe(200);

    const updatedInvite = await kv.get("invite:inv1", "json");
    expect(updatedInvite.remainingFiles).toBe(1);
  });

  it("rejects an exhausted invite token", async () => {
    const invite: InviteRecord = {
      label: "friend",
      maxFiles: 1,
      remainingFiles: 0,
      createdAt: Date.now(),
      expiresAt: Date.now() + 3600_000,
    };
    await putInviteRecord(kv as unknown as KVNamespace, "inv1", invite, 3600);

    const res = await uploadRoute.request(
      "/api/upload?invite=inv1",
      { method: "POST", body: JSON.stringify({ filename: "a.txt", size: 10, expiresInDays: 7 }) },
      makeEnv(kv)
    );
    expect(res.status).toBe(403);
  });

  it("rejects a malformed body", async () => {
    const res = await uploadRoute.request(
      "/api/upload",
      {
        method: "POST",
        headers: { "Cf-Access-Authenticated-User-Email": "me@example.com" },
        body: JSON.stringify({ filename: "" }),
      },
      makeEnv(kv)
    );
    expect(res.status).toBe(400);
  });

  it("stores a file record whose hash matches the returned password", async () => {
    const res = await uploadRoute.request(
      "/api/upload",
      {
        method: "POST",
        headers: { "Cf-Access-Authenticated-User-Email": "me@example.com" },
        body: JSON.stringify({ filename: "a.txt", size: 10, expiresInDays: 7 }),
      },
      makeEnv(kv)
    );
    const json = await res.json();
    const token = json.downloadUrl.split("/").pop();
    const record = await kv.get(`file:${token}`, "json");
    expect(record.filename).toBe("a.txt");
    expect(record.uploaderEmail).toBe("me@example.com");
  });
});
