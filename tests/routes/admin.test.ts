import { describe, it, expect, beforeEach } from "vitest";
import { createMockKv, type MockKv } from "../helpers/mockKv";
import { adminRoute } from "../../src/routes/admin";
import type { Bindings } from "../../src/types";

function makeEnv(kv: MockKv): Bindings {
  return {
    FILES_KV: kv as unknown as KVNamespace,
    ASSETS: {} as unknown as Fetcher,
    B2_KEY_ID: "k",
    B2_APP_KEY: "s",
    B2_BUCKET: "b",
    B2_ENDPOINT: "https://example.com",
    B2_REGION: "r",
  };
}

describe("POST /api/invite", () => {
  let kv: MockKv;

  beforeEach(() => {
    kv = createMockKv();
  });

  it("rejects requests without the Cf-Access header", async () => {
    const res = await adminRoute.request(
      "/api/invite",
      { method: "POST", body: JSON.stringify({ label: "x", maxFiles: 1, ttlHours: 24 }) },
      makeEnv(kv)
    );
    expect(res.status).toBe(403);
  });

  it("rejects a malformed body", async () => {
    const res = await adminRoute.request(
      "/api/invite",
      {
        method: "POST",
        headers: { "Cf-Access-Authenticated-User-Email": "me@example.com" },
        body: JSON.stringify({ label: "" }),
      },
      makeEnv(kv)
    );
    expect(res.status).toBe(400);
  });

  it("creates an invite and returns a ready-to-share link", async () => {
    const res = await adminRoute.request(
      "/api/invite",
      {
        method: "POST",
        headers: { "Cf-Access-Authenticated-User-Email": "me@example.com" },
        body: JSON.stringify({ label: "friend", maxFiles: 3, ttlHours: 48 }),
      },
      makeEnv(kv)
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.inviteUrl).toMatch(/^\/\?invite=[0-9a-f]{64}$/);

    const token = json.inviteUrl.split("=")[1];
    const stored = await kv.get(`invite:${token}`, "json");
    expect(stored.remainingFiles).toBe(3);
    expect(stored.label).toBe("friend");
  });
});
