import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createMockKv, type MockKv } from "../helpers/mockKv";
import { downloadRoute } from "../../src/routes/download";
import type { Bindings } from "../../src/types";
import { putFileRecord, getFailCount, type FileRecord } from "../../src/lib/kv";
import { generateSalt, hashPassword } from "../../src/lib/crypto";

function makeEnv(kv: MockKv): Bindings {
  return {
    FILES_KV: kv as unknown as KVNamespace,
    ASSETS: {
      fetch: async () => new Response("<html>download page</html>", { status: 200 }),
    } as unknown as Fetcher,
    B2_KEY_ID: "test-key",
    B2_APP_KEY: "test-secret",
    B2_BUCKET: "varco-test",
    B2_ENDPOINT: "https://s3.us-west-004.backblazeb2.com",
    B2_REGION: "us-west-004",
  };
}

function makeExecutionCtx() {
  const promises: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (p: Promise<unknown>) => {
      promises.push(p);
    },
    passThroughOnException: () => {},
  } as unknown as ExecutionContext;
  return { ctx, flush: () => Promise.all(promises) };
}

async function makeRecord(password: string, overrides: Partial<FileRecord> = {}): Promise<FileRecord> {
  const salt = generateSalt();
  const hash = await hashPassword(password, salt);
  return {
    fileId: "file123",
    key: "f/2026/09/file123/report.pdf",
    filename: "report.pdf",
    size: 1024,
    hash,
    salt,
    expiresAt: Date.now() + 7 * 86400 * 1000,
    downloadCount: 0,
    ...overrides,
  };
}

describe("GET /d/:token", () => {
  it("serves the generic download page regardless of token validity", async () => {
    const kv = createMockKv();
    const res = await downloadRoute.request("/d/does-not-exist", {}, makeEnv(kv));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("download page");
  });
});

describe("POST /d/:token", () => {
  let kv: MockKv;

  beforeEach(() => {
    kv = createMockKv();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns a generic 404 for an unknown token", async () => {
    const res = await downloadRoute.request(
      "/d/unknown",
      { method: "POST", body: new URLSearchParams({ password: "whatever" }) },
      makeEnv(kv)
    );
    expect(res.status).toBe(404);
  });

  it("returns the same generic 404 for a wrong password on a real token", async () => {
    const record = await makeRecord("correct-horse");
    await putFileRecord(kv as unknown as KVNamespace, "tok1", record, 7 * 86400);

    const res = await downloadRoute.request(
      "/d/tok1",
      { method: "POST", body: new URLSearchParams({ password: "wrong" }) },
      makeEnv(kv)
    );
    expect(res.status).toBe(404);
  });

  it("returns an HTML error page, and it is byte-for-byte identical for a wrong password vs. a nonexistent token", async () => {
    const record = await makeRecord("correct-horse");
    await putFileRecord(kv as unknown as KVNamespace, "tok1", record, 7 * 86400);

    const wrongPasswordRes = await downloadRoute.request(
      "/d/tok1",
      { method: "POST", body: new URLSearchParams({ password: "wrong" }) },
      makeEnv(kv)
    );
    const nonexistentTokenRes = await downloadRoute.request(
      "/d/tok1",
      { method: "POST", body: new URLSearchParams({ password: "whatever" }) },
      makeEnv(createMockKv())
    );

    expect(wrongPasswordRes.status).toBe(404);
    expect(nonexistentTokenRes.status).toBe(404);
    expect(wrongPasswordRes.headers.get("Content-Type")).toContain("text/html");

    const wrongPasswordHtml = (await wrongPasswordRes.text()).replace(/\/d\/tok1/g, "/d/TOKEN");
    const nonexistentTokenHtml = (await nonexistentTokenRes.text()).replace(/\/d\/tok1/g, "/d/TOKEN");
    // The only thing that may legitimately differ is the requested token
    // echoed back into the "retry" link — which the caller already knows,
    // since it's the token they put in the URL — never anything derived
    // from whether the token/password was actually valid.
    expect(wrongPasswordHtml).toBe(nonexistentTokenHtml);
    expect(wrongPasswordHtml).toContain("Password errata o link non valido.");
  });

  it("locks out after 5 failed attempts on a real token, then rejects the correct password too", async () => {
    const record = await makeRecord("correct-horse");
    await putFileRecord(kv as unknown as KVNamespace, "tok1", record, 7 * 86400);

    for (let i = 0; i < 5; i++) {
      const res = await downloadRoute.request(
        "/d/tok1",
        { method: "POST", body: new URLSearchParams({ password: "wrong" }) },
        makeEnv(kv)
      );
      expect(res.status).toBe(404);
    }
    const locked = await downloadRoute.request(
      "/d/tok1",
      { method: "POST", body: new URLSearchParams({ password: "correct-horse" }) },
      makeEnv(kv)
    );
    expect(locked.status).toBe(429);
  });

  it("also locks out a nonexistent token after 5 attempts (no existence oracle)", async () => {
    for (let i = 0; i < 5; i++) {
      await downloadRoute.request(
        "/d/fake-token",
        { method: "POST", body: new URLSearchParams({ password: "whatever" }) },
        makeEnv(kv)
      );
    }
    const locked = await downloadRoute.request(
      "/d/fake-token",
      { method: "POST", body: new URLSearchParams({ password: "whatever" }) },
      makeEnv(kv)
    );
    expect(locked.status).toBe(429);
  });

  it("returns 410 when the file is past its download limit", async () => {
    const record = await makeRecord("correct-horse", { maxDownloads: 1, downloadCount: 1 });
    await putFileRecord(kv as unknown as KVNamespace, "tok1", record, 7 * 86400);

    const res = await downloadRoute.request(
      "/d/tok1",
      { method: "POST", body: new URLSearchParams({ password: "correct-horse" }) },
      makeEnv(kv)
    );
    expect(res.status).toBe(410);
  });

  it("streams the file body and sets Content-Disposition on success", async () => {
    const record = await makeRecord("correct-horse");
    await putFileRecord(kv as unknown as KVNamespace, "tok1", record, 7 * 86400);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("file-bytes", { status: 200, headers: { "Content-Length": "10" } }))
    );

    const { ctx } = makeExecutionCtx();
    const res = await downloadRoute.request(
      "/d/tok1",
      { method: "POST", body: new URLSearchParams({ password: "correct-horse" }) },
      makeEnv(kv),
      ctx
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Disposition")).toContain('filename="report.pdf"');
    expect(await res.text()).toBe("file-bytes");
  });

  it("increments downloadCount after a successful download", async () => {
    const record = await makeRecord("correct-horse");
    await putFileRecord(kv as unknown as KVNamespace, "tok1", record, 7 * 86400);

    vi.stubGlobal("fetch", vi.fn(async () => new Response("bytes", { status: 200 })));

    const { ctx, flush } = makeExecutionCtx();
    await downloadRoute.request(
      "/d/tok1",
      { method: "POST", body: new URLSearchParams({ password: "correct-horse" }) },
      makeEnv(kv),
      ctx
    );
    await flush();

    const updated = await kv.get("file:tok1", "json");
    expect(updated.downloadCount).toBe(1);
  });

  it("RFC 5987-encodes a non-ASCII filename in Content-Disposition", async () => {
    const record = await makeRecord("correct-horse", { filename: "città.pdf" });
    await putFileRecord(kv as unknown as KVNamespace, "tok1", record, 7 * 86400);

    vi.stubGlobal("fetch", vi.fn(async () => new Response("bytes", { status: 200 })));

    const { ctx } = makeExecutionCtx();
    const res = await downloadRoute.request(
      "/d/tok1",
      { method: "POST", body: new URLSearchParams({ password: "correct-horse" }) },
      makeEnv(kv),
      ctx
    );
    const disposition = res.headers.get("Content-Disposition") ?? "";
    expect(disposition).toContain("filename*=UTF-8''citt%C3%A0.pdf");
    // The quoted ASCII fallback must remain a well-formed header value even
    // though it isn't the "real" filename browsers will actually use.
    expect(disposition).toMatch(/filename="[\x20-\x7e]*"/);
  });

  it("omits Content-Length entirely when B2 doesn't provide one", async () => {
    const record = await makeRecord("correct-horse");
    await putFileRecord(kv as unknown as KVNamespace, "tok1", record, 7 * 86400);

    vi.stubGlobal("fetch", vi.fn(async () => new Response("bytes", { status: 200 })));

    const { ctx } = makeExecutionCtx();
    const res = await downloadRoute.request(
      "/d/tok1",
      { method: "POST", body: new URLSearchParams({ password: "correct-horse" }) },
      makeEnv(kv),
      ctx
    );
    expect(res.headers.has("Content-Length")).toBe(false);
  });

  it("resets the fail counter after a successful download", async () => {
    const record = await makeRecord("correct-horse");
    await putFileRecord(kv as unknown as KVNamespace, "tok1", record, 7 * 86400);

    // Two wrong attempts first, to build up a nonzero fail count.
    await downloadRoute.request(
      "/d/tok1",
      { method: "POST", body: new URLSearchParams({ password: "wrong" }) },
      makeEnv(kv)
    );
    await downloadRoute.request(
      "/d/tok1",
      { method: "POST", body: new URLSearchParams({ password: "wrong" }) },
      makeEnv(kv)
    );
    expect(await getFailCount(kv as unknown as KVNamespace, "tok1")).toBe(2);

    vi.stubGlobal("fetch", vi.fn(async () => new Response("bytes", { status: 200 })));
    const { ctx, flush } = makeExecutionCtx();
    const res = await downloadRoute.request(
      "/d/tok1",
      { method: "POST", body: new URLSearchParams({ password: "correct-horse" }) },
      makeEnv(kv),
      ctx
    );
    expect(res.status).toBe(200);
    await flush();

    expect(await getFailCount(kv as unknown as KVNamespace, "tok1")).toBe(0);
  });
});
