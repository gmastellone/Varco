import { Hono } from "hono";
import type { Bindings } from "../types";
import { generateToken, generateSalt, generatePassword, hashPassword } from "../lib/crypto";
import { getInviteRecord, decrementInviteRemaining, putFileRecord, type FileRecord } from "../lib/kv";
import { presignPutUrl, b2ConfigFromEnv } from "../lib/b2";

interface UploadRequestBody {
  filename: string;
  size: number;
  expiresInDays: number;
  maxDownloads?: number;
}

// Rejects path separators and control characters so a filename can never be
// used to escape the `f/` prefix of the B2 object key (which would make the
// object invisible to the cron cleanup's `prefix: "f/"` listing). Also
// rejects empty or whitespace-only names. `#`/`?`, which could otherwise
// truncate/reinterpret the key, are handled by the encodeURIComponent()
// call in objectKey() below (defense in depth).
const UNSAFE_FILENAME_CHARS = /[/\\\x00-\x1f]/;

function isValidFilename(filename: string): boolean {
  return filename.trim().length > 0 && !UNSAFE_FILENAME_CHARS.test(filename);
}

function isValidUploadBody(body: unknown): body is UploadRequestBody {
  if (typeof body !== "object" || body === null) return false;
  const b = body as Record<string, unknown>;
  return (
    typeof b.filename === "string" &&
    b.filename.length > 0 &&
    isValidFilename(b.filename) &&
    typeof b.size === "number" &&
    b.size > 0 &&
    typeof b.expiresInDays === "number" &&
    b.expiresInDays > 0 &&
    (b.maxDownloads === undefined || typeof b.maxDownloads === "number")
  );
}

function objectKey(fileId: string, filename: string): string {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  // Defense in depth: even though isValidUploadBody already rejects path
  // separators and control characters, encode the filename before it goes
  // into the object key so a future validation gap can't produce a key
  // outside the `f/` prefix.
  return `f/${year}/${month}/${fileId}/${encodeURIComponent(filename)}`;
}

export const uploadRoute = new Hono<{ Bindings: Bindings }>();

uploadRoute.post("/api/upload", async (c) => {
  const uploaderEmail = c.req.header("Cf-Access-Authenticated-User-Email");
  const inviteToken = c.req.query("invite");

  let invite: Awaited<ReturnType<typeof getInviteRecord>> = null;
  if (!uploaderEmail) {
    if (!inviteToken) {
      return c.json({ error: "unauthorized" }, 403);
    }
    invite = await getInviteRecord(c.env.FILES_KV, inviteToken);
    if (!invite || invite.remainingFiles <= 0) {
      return c.json({ error: "unauthorized" }, 403);
    }
  }

  const body = await c.req.json().catch(() => null);
  if (!isValidUploadBody(body)) {
    return c.json({ error: "invalid request" }, 400);
  }

  if (invite && inviteToken) {
    await decrementInviteRemaining(c.env.FILES_KV, inviteToken, invite);
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
    ...(uploaderEmail ? { uploaderEmail } : {}),
    ...(inviteToken ? { inviteToken } : {}),
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
});
