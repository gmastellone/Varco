import { Hono } from "hono";
import type { Bindings } from "../types";
import {
  getFileRecord,
  incrementDownloadCount,
  getFailCount,
  incrementFailCount,
  resetFailCount,
} from "../lib/kv";
import { hashPassword, constantTimeEqual } from "../lib/crypto";
import { fetchObject, b2ConfigFromEnv } from "../lib/b2";

const MAX_FAILED_ATTEMPTS = 5;

// Small HTML error pages for the POST /d/:token error branches. Now that the
// download page (public/download.html) submits as a real form navigation
// with no JS in the loop, a non-2xx response here becomes the page the
// browser actually displays, not JSON consumed by fetch(), so it needs to be
// a page in the project's existing style, with a way back to retry.
//
// Security note: the 404 branch below is reached both for "token doesn't
// exist" and "wrong password on a real token" (see the no-oracle comment
// further down), and both call this same function with the same message —
// that indistinguishability must be preserved by any future edit here.
function escapeHtmlAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function errorPage(token: string, message: string): string {
  const retryHref = `/d/${escapeHtmlAttr(token)}`;
  return `<!doctype html>
<html lang="it">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Varco — Scarica file</title>
    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
    <link rel="stylesheet" href="/style.css" />
  </head>
  <body>
    <div class="page">
      <div class="brand">
        <svg width="22" height="22" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M9 6 L4 6 L4 26 L9 26" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" />
          <path d="M23 6 L28 6 L28 26 L23 26" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" />
          <rect x="14.5" y="11" width="3" height="10" rx="1.5" fill="var(--color-accent)" />
        </svg>
        <h1>Scarica file</h1>
      </div>
      <div class="card">
        <p class="message error">${message}</p>
        <a href="${retryHref}">Riprova</a>
      </div>
    </div>
  </body>
</html>`;
}

// Builds a Content-Disposition header that survives non-ASCII filenames.
// Plain interpolation of the raw filename is emitted as raw UTF-8 bytes,
// which browsers then decode as ISO-8859-1 (mojibake, e.g. "città.pdf" ->
// "cittÃ .pdf") and which workerd logs a runtime error for. filename* per
// RFC 5987 is what modern browsers actually use for the real name; filename=
// is just a same-request-cycle-safe ASCII fallback for older clients, so it
// only needs to be a valid header value, not pretty.
function asciiFallbackFilename(filename: string): string {
  const stripped = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return stripped.trim().length > 0 ? stripped : "download";
}

function rfc5987Encode(value: string): string {
  // encodeURIComponent leaves `' ( ) *` unescaped, which RFC 5987's
  // attr-char grammar does not permit — percent-encode those too.
  return encodeURIComponent(value).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

function contentDispositionHeader(filename: string): string {
  const fallback = asciiFallbackFilename(filename);
  return `attachment; filename="${fallback}"; filename*=UTF-8''${rfc5987Encode(filename)}`;
}

export const downloadRoute = new Hono<{ Bindings: Bindings }>();

downloadRoute.get("/d/:token", async (c) => {
  return c.env.ASSETS.fetch(new URL("/download.html", c.req.url));
});

downloadRoute.post("/d/:token", async (c) => {
  const token = c.req.param("token");

  const failCount = await getFailCount(c.env.FILES_KV, token);
  if (failCount >= MAX_FAILED_ATTEMPTS) {
    return c.html(errorPage(token, "Troppi tentativi. Riprova più tardi."), 429);
  }

  const record = await getFileRecord(c.env.FILES_KV, token);
  // The download page now submits as a plain HTML form POST (native
  // navigation, so the browser can stream the response straight to disk
  // instead of buffering it in JS) rather than a JS fetch() with a JSON
  // body, so the body arrives as application/x-www-form-urlencoded.
  const body = await c.req.parseBody().catch(() => null);
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
    return c.html(errorPage(token, "Password errata o link non valido."), 404);
  }

  const isExpired = record.expiresAt <= Date.now();
  const isExhausted = record.maxDownloads !== undefined && record.downloadCount >= record.maxDownloads;
  if (isExpired || isExhausted) {
    return c.html(errorPage(token, "Questo link non è più disponibile."), 410);
  }

  const b2Response = await fetchObject(b2ConfigFromEnv(c.env), record.key);
  if (!b2Response.ok || !b2Response.body) {
    return c.html(errorPage(token, "Password errata o link non valido."), 404);
  }

  c.executionCtx.waitUntil(
    Promise.all([incrementDownloadCount(c.env.FILES_KV, token, record), resetFailCount(c.env.FILES_KV, token)])
  );

  const headers: Record<string, string> = {
    "Content-Disposition": contentDispositionHeader(record.filename),
    "Content-Type": "application/octet-stream",
  };
  const contentLength = b2Response.headers.get("Content-Length");
  if (contentLength) {
    headers["Content-Length"] = contentLength;
  }

  return new Response(b2Response.body, {
    status: 200,
    headers,
  });
});
