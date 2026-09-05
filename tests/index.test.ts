import { describe, it, expect, vi } from "vitest";
import app from "../src/index";
import { createMockKv } from "./helpers/mockKv";
import type { Bindings } from "../src/types";

function makeEnv(): Bindings {
  return {
    FILES_KV: createMockKv() as unknown as KVNamespace,
    ASSETS: {
      fetch: async (req: Request) => new Response(`served:${new URL(req.url).pathname}`, { status: 200 }),
    } as unknown as Fetcher,
    B2_KEY_ID: "k",
    B2_APP_KEY: "s",
    B2_BUCKET: "b",
    B2_ENDPOINT: "https://example.com",
    B2_REGION: "r",
  };
}

describe("app routing", () => {
  it("serves admin.html for GET /admin", async () => {
    const res = await app.fetch(new Request("https://varco.example.com/admin"), makeEnv());
    expect(await res.text()).toBe("served:/admin.html");
  });

  it("rejects an /api/* request carrying a foreign Origin header", async () => {
    const res = await app.fetch(
      new Request("https://varco.example.com/api/invite", {
        method: "POST",
        headers: {
          Origin: "https://evil.example.com",
          "Cf-Access-Authenticated-User-Email": "me@example.com",
        },
        body: JSON.stringify({ label: "x", maxFiles: 1, ttlHours: 1 }),
      }),
      makeEnv()
    );
    expect(res.status).toBe(403);
  });

  it("allows an /api/* request whose Origin matches the Worker's own origin", async () => {
    const res = await app.fetch(
      new Request("https://varco.example.com/api/invite", {
        method: "POST",
        headers: {
          Origin: "https://varco.example.com",
          "Cf-Access-Authenticated-User-Email": "me@example.com",
        },
        body: JSON.stringify({ label: "x", maxFiles: 1, ttlHours: 1 }),
      }),
      makeEnv()
    );
    expect(res.status).toBe(200);
  });

  it("runs the scheduled cleanup handler via waitUntil", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            '<?xml version="1.0"?><ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>',
            { status: 200 }
          )
      )
    );
    const promises: Promise<unknown>[] = [];
    const ctx = {
      waitUntil: (p: Promise<unknown>) => {
        promises.push(p);
      },
      passThroughOnException: () => {},
    } as unknown as ExecutionContext;

    await app.scheduled?.({} as ScheduledController, makeEnv(), ctx);
    await Promise.all(promises);
    vi.unstubAllGlobals();
  });
});
