import { Hono, type Context } from "hono";
import type { Bindings } from "../types";
import { generateToken, generateSalt, generatePassword, hashPassword } from "../lib/crypto";
import { decrementInviteRemaining, putFileRecord, type FileRecord } from "../lib/kv";
import { presignPutUrl, b2ConfigFromEnv } from "../lib/b2";
import { isValidUploadBody, objectKey } from "../lib/uploadMeta";
import { resolveUploadAuth } from "../lib/uploadAuth";

export const uploadRoute = new Hono<{ Bindings: Bindings }>();

// Registered on two paths sharing one handler:
//
// - /api/upload        — the fixed-user flow. Sits behind a Cloudflare
//   Access "Allow" policy (owner only), which is what actually attaches
//   Cf-Access-Authenticated-User-Email to the request.
// - /api/guest-upload  — the invited-guest flow (?invite=<token>). Left
//   completely outside any Cloudflare Access Application.
//
// These deliberately do NOT share a path prefix (unlike an earlier
// /api/upload vs /api/upload/invite split). Verified live that a
// Cloudflare Access destination configured as an "exact" path (no trailing
// "*") still matches as a PREFIX — "api/upload" protects "/api/upload" AND
// everything nested under it, e.g. "/api/upload/invite". There is no way to
// declare a truly exact, non-prefix destination in Access, so the only way
// to keep a route outside Access is to give it a path that isn't a
// descendant of any Access-protected one at all.
//
// (Earlier still, a Bypass policy was tried for the guest path instead of
// keeping it outside Access — that doesn't work either: Bypass never
// attaches the identity header, which doesn't matter for guests, but a
// Bypass destination is still subject to the same prefix-matching
// footgun, and more importantly a Bypass policy for a *narrower* path can
// still be shadowed by an Allow policy's *broader* prefix elsewhere in the
// same zone. Staying outside Access's path space entirely is the only
// mechanism that doesn't depend on getting evaluation order right.)
//
// The handler itself doesn't care which path was hit: it still checks for
// the header first, then falls back to the invite token, so hitting either
// path with either kind of credential works.
const handleUpload = async (c: Context<{ Bindings: Bindings }>) => {
  const auth = await resolveUploadAuth(c);
  if (!auth) {
    return c.json({ error: "unauthorized" }, 403);
  }

  const body = await c.req.json().catch(() => null);
  if (!isValidUploadBody(body)) {
    return c.json({ error: "invalid request" }, 400);
  }

  if (auth.kind === "invite") {
    await decrementInviteRemaining(c.env.FILES_KV, auth.token, auth.invite);
  }

  const fileId = generateToken();
  const downloadToken = generateToken();
  const password = generatePassword();
  const salt = generateSalt();
  const hash = await hashPassword(password, salt);
  const key = objectKey(fileId, body.filename);

  const ttlSeconds = Math.round(body.expiresInDays * 86400);
  const expiresAt = Date.now() + ttlSeconds * 1000;

  const record: FileRecord = {
    fileId,
    key,
    filename: body.filename,
    size: body.size,
    ...(auth.kind === "owner" ? { uploaderEmail: auth.email } : {}),
    ...(auth.kind === "invite" ? { inviteToken: auth.token } : {}),
    hash,
    salt,
    expiresAt,
    ...(body.maxDownloads !== undefined ? { maxDownloads: body.maxDownloads } : {}),
    downloadCount: 0,
  };

  await putFileRecord(c.env.FILES_KV, downloadToken, record, ttlSeconds);

  const uploadUrl = await presignPutUrl(b2ConfigFromEnv(c.env), key);

  return c.json({
    uploadUrl,
    downloadUrl: `/d/${downloadToken}`,
    password,
  });
};

uploadRoute.post("/api/upload", handleUpload);
uploadRoute.post("/api/guest-upload", handleUpload);
