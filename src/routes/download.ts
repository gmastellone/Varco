import { Hono } from "hono";
import type { Bindings } from "../types";
import { getFileRecord, incrementDownloadCount, getFailCount, incrementFailCount } from "../lib/kv";
import { hashPassword, constantTimeEqual } from "../lib/crypto";
import { fetchObject, b2ConfigFromEnv } from "../lib/b2";

const MAX_FAILED_ATTEMPTS = 5;

export const downloadRoute = new Hono<{ Bindings: Bindings }>();

downloadRoute.get("/d/:token", async (c) => {
  return c.env.ASSETS.fetch(new URL("/download.html", c.req.url));
});

downloadRoute.post("/d/:token", async (c) => {
  const token = c.req.param("token");

  const failCount = await getFailCount(c.env.FILES_KV, token);
  if (failCount >= MAX_FAILED_ATTEMPTS) {
    return c.json({ error: "too many attempts" }, 429);
  }

  const record = await getFileRecord(c.env.FILES_KV, token);
  const body = await c.req.json().catch(() => null);
  const password = typeof body?.password === "string" ? body.password : "";

  // Always hash, even for a nonexistent token (using a fixed dummy salt), so
  // a missing record can't be distinguished from a wrong password by timing
  // alone — the SHA-256 call happens on every request regardless of which
  // branch we're about to take.
  const salt = record?.salt ?? "no-such-token-dummy-salt";
  const computedHash = await hashPassword(password, salt);
  const passwordMatches = record ? constantTimeEqual(computedHash, record.hash) : false;

  if (!record || !passwordMatches) {
    // Increment the fail counter for missing tokens too, so a wrong-password
    // response and a nonexistent-token response are indistinguishable even
    // under repeated probing (no existence oracle via the lockout state).
    // The 429 decision is made solely by the failCount check at the top of
    // this handler (based on the count *before* this request), so every
    // failed attempt itself still reports the same generic 404 — only a
    // subsequent request, once the count has reached the threshold, sees
    // the lockout response.
    await incrementFailCount(c.env.FILES_KV, token);
    return c.json({ error: "not found" }, 404);
  }

  const isExpired = record.expiresAt <= Date.now();
  const isExhausted = record.maxDownloads !== undefined && record.downloadCount >= record.maxDownloads;
  if (isExpired || isExhausted) {
    return c.json({ error: "gone" }, 410);
  }

  const b2Response = await fetchObject(b2ConfigFromEnv(c.env), record.key);
  if (!b2Response.ok || !b2Response.body) {
    return c.json({ error: "not found" }, 404);
  }

  c.executionCtx.waitUntil(incrementDownloadCount(c.env.FILES_KV, token, record));

  return new Response(b2Response.body, {
    status: 200,
    headers: {
      "Content-Disposition": `attachment; filename="${record.filename.replace(/"/g, "")}"`,
      "Content-Length": b2Response.headers.get("Content-Length") ?? "",
      "Content-Type": "application/octet-stream",
    },
  });
});
