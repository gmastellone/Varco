import { Hono, type Context } from "hono";
import type { Bindings } from "../types";
import { generateToken, generateSalt, generatePassword, hashPassword } from "../lib/crypto";
import {
  decrementInviteRemaining,
  putFileRecord,
  getPendingUpload,
  putPendingUpload,
  deletePendingUpload,
  type FileRecord,
  type PendingUpload,
} from "../lib/kv";
import {
  b2ConfigFromEnv,
  createMultipartUpload,
  presignUploadPartUrl,
  completeMultipartUpload,
  abortMultipartUpload,
  listUploadedParts,
  type MultipartPart,
} from "../lib/b2";
import { isValidUploadBody, objectKey } from "../lib/uploadMeta";
import { resolveUploadAuth, type UploadAuth } from "../lib/uploadAuth";

// 100MB per part: for a multi-GB transfer on a slow/unreliable connection,
// this bounds how much work a single failed part throws away (a few
// minutes, not hours) while keeping the part count reasonable (a 4GB file
// is ~40 parts; the S3-compatible API caps at 10000).
const PART_SIZE_BYTES = 100 * 1024 * 1024;
const MAX_PARTS = 10_000;

// Generous TTL so an interrupted transfer can be resumed the next day (or
// later) without losing the metadata needed to keep going — the whole point
// of multipart being resumable in the first place.
const PENDING_UPLOAD_TTL_SECONDS = 7 * 24 * 3600;

function ownsPendingUpload(pending: PendingUpload, auth: UploadAuth): boolean {
  if (auth.kind === "owner") return pending.uploaderEmail === auth.email;
  return pending.inviteToken === auth.token;
}

interface TokenBody {
  multipartToken: string;
}

function isValidTokenBody(body: unknown): body is TokenBody {
  if (typeof body !== "object" || body === null) return false;
  const b = body as Record<string, unknown>;
  return typeof b.multipartToken === "string" && b.multipartToken.length > 0;
}

interface PartUrlBody extends TokenBody {
  partNumber: number;
}

function isValidPartUrlBody(body: unknown): body is PartUrlBody {
  if (!isValidTokenBody(body)) return false;
  const b = body as unknown as Record<string, unknown>;
  return typeof b.partNumber === "number" && Number.isInteger(b.partNumber) && b.partNumber > 0;
}

interface CompleteBody extends TokenBody {
  parts: MultipartPart[];
}

function isValidCompleteBody(body: unknown): body is CompleteBody {
  if (!isValidTokenBody(body)) return false;
  const b = body as unknown as Record<string, unknown>;
  return (
    Array.isArray(b.parts) &&
    b.parts.every(
      (p): p is MultipartPart =>
        typeof p === "object" &&
        p !== null &&
        typeof (p as Record<string, unknown>).partNumber === "number" &&
        typeof (p as Record<string, unknown>).eTag === "string" &&
        (p as Record<string, unknown>).eTag !== ""
    )
  );
}

export const multipartRoute = new Hono<{ Bindings: Bindings }>();

async function handleInit(c: Context<{ Bindings: Bindings }>) {
  const auth = await resolveUploadAuth(c);
  if (!auth) {
    return c.json({ error: "unauthorized" }, 403);
  }

  const body = await c.req.json().catch(() => null);
  if (!isValidUploadBody(body)) {
    return c.json({ error: "invalid request" }, 400);
  }

  const partCount = Math.max(1, Math.ceil(body.size / PART_SIZE_BYTES));
  if (partCount > MAX_PARTS) {
    return c.json({ error: "file too large" }, 400);
  }

  const fileId = generateToken();
  const key = objectKey(fileId, body.filename);
  const config = b2ConfigFromEnv(c.env);
  const uploadId = await createMultipartUpload(config, key);

  const multipartToken = generateToken();
  const pending: PendingUpload = {
    fileId,
    key,
    uploadId,
    filename: body.filename,
    size: body.size,
    partSize: PART_SIZE_BYTES,
    partCount,
    expiresInDays: body.expiresInDays,
    ...(body.maxDownloads !== undefined ? { maxDownloads: body.maxDownloads } : {}),
    ...(auth.kind === "owner" ? { uploaderEmail: auth.email } : {}),
    ...(auth.kind === "invite" ? { inviteToken: auth.token } : {}),
    createdAt: Date.now(),
  };
  await putPendingUpload(c.env.FILES_KV, multipartToken, pending, PENDING_UPLOAD_TTL_SECONDS);

  return c.json({ multipartToken, partSize: PART_SIZE_BYTES, partCount });
}

async function handlePartUrl(c: Context<{ Bindings: Bindings }>) {
  const auth = await resolveUploadAuth(c);
  if (!auth) {
    return c.json({ error: "unauthorized" }, 403);
  }

  const body = await c.req.json().catch(() => null);
  if (!isValidPartUrlBody(body)) {
    return c.json({ error: "invalid request" }, 400);
  }

  const pending = await getPendingUpload(c.env.FILES_KV, body.multipartToken);
  if (!pending || !ownsPendingUpload(pending, auth)) {
    return c.json({ error: "not found" }, 404);
  }
  if (body.partNumber > pending.partCount) {
    return c.json({ error: "invalid part number" }, 400);
  }

  const config = b2ConfigFromEnv(c.env);
  const url = await presignUploadPartUrl(config, pending.key, pending.uploadId, body.partNumber);
  return c.json({ url });
}

async function handleListParts(c: Context<{ Bindings: Bindings }>) {
  const auth = await resolveUploadAuth(c);
  if (!auth) {
    return c.json({ error: "unauthorized" }, 403);
  }

  const body = await c.req.json().catch(() => null);
  if (!isValidTokenBody(body)) {
    return c.json({ error: "invalid request" }, 400);
  }

  const pending = await getPendingUpload(c.env.FILES_KV, body.multipartToken);
  if (!pending || !ownsPendingUpload(pending, auth)) {
    return c.json({ error: "not found" }, 404);
  }

  const config = b2ConfigFromEnv(c.env);
  const parts = await listUploadedParts(config, pending.key, pending.uploadId);

  return c.json({
    filename: pending.filename,
    size: pending.size,
    partSize: pending.partSize,
    partCount: pending.partCount,
    parts,
  });
}

async function handleComplete(c: Context<{ Bindings: Bindings }>) {
  const auth = await resolveUploadAuth(c);
  if (!auth) {
    return c.json({ error: "unauthorized" }, 403);
  }

  const body = await c.req.json().catch(() => null);
  if (!isValidCompleteBody(body)) {
    return c.json({ error: "invalid request" }, 400);
  }

  const pending = await getPendingUpload(c.env.FILES_KV, body.multipartToken);
  if (!pending || !ownsPendingUpload(pending, auth)) {
    return c.json({ error: "not found" }, 404);
  }
  if (body.parts.length !== pending.partCount) {
    return c.json({ error: "missing parts" }, 400);
  }

  const config = b2ConfigFromEnv(c.env);
  await completeMultipartUpload(config, pending.key, pending.uploadId, body.parts);

  // Only spend the invite's quota once the upload has actually landed on
  // B2 — unlike the single-PUT flow (which decrements at prepare time,
  // before any bytes move), a multipart transfer can span hours and fail
  // partway through, and a guest shouldn't lose their one shot at it for
  // that.
  if (auth.kind === "invite") {
    await decrementInviteRemaining(c.env.FILES_KV, auth.token, auth.invite);
  }

  const downloadToken = generateToken();
  const password = generatePassword();
  const salt = generateSalt();
  const hash = await hashPassword(password, salt);
  const ttlSeconds = Math.round(pending.expiresInDays * 86400);
  const expiresAt = Date.now() + ttlSeconds * 1000;

  const record: FileRecord = {
    fileId: pending.fileId,
    key: pending.key,
    filename: pending.filename,
    size: pending.size,
    ...(pending.uploaderEmail ? { uploaderEmail: pending.uploaderEmail } : {}),
    ...(pending.inviteToken ? { inviteToken: pending.inviteToken } : {}),
    hash,
    salt,
    expiresAt,
    ...(pending.maxDownloads !== undefined ? { maxDownloads: pending.maxDownloads } : {}),
    downloadCount: 0,
  };

  await putFileRecord(c.env.FILES_KV, downloadToken, record, ttlSeconds);
  await deletePendingUpload(c.env.FILES_KV, body.multipartToken);

  return c.json({ downloadUrl: `/d/${downloadToken}`, password });
}

async function handleAbort(c: Context<{ Bindings: Bindings }>) {
  const auth = await resolveUploadAuth(c);
  if (!auth) {
    return c.json({ error: "unauthorized" }, 403);
  }

  const body = await c.req.json().catch(() => null);
  if (!isValidTokenBody(body)) {
    return c.json({ error: "invalid request" }, 400);
  }

  const pending = await getPendingUpload(c.env.FILES_KV, body.multipartToken);
  if (!pending || !ownsPendingUpload(pending, auth)) {
    return c.json({ error: "not found" }, 404);
  }

  const config = b2ConfigFromEnv(c.env);
  await abortMultipartUpload(config, pending.key, pending.uploadId);
  await deletePendingUpload(c.env.FILES_KV, body.multipartToken);

  return c.json({ ok: true });
}

// Same dual-path pattern as src/routes/upload.ts: the owner path sits under
// Cloudflare Access ("Allow" policy), the invite path is kept outside
// Access entirely — under /api/guest-upload/*, not /api/upload/*, because a
// Cloudflare Access "exact" path destination ("api/upload", no trailing
// "*") turns out to match as a PREFIX, silently pulling in any nested path
// like "/api/upload/invite/multipart/*" (verified live). Registered as full
// literal paths (not a mounted sub-app) to match the rest of the
// codebase's routing style.
for (const prefix of ["/api/upload/multipart", "/api/guest-upload/multipart"]) {
  multipartRoute.post(`${prefix}/init`, handleInit);
  multipartRoute.post(`${prefix}/part-url`, handlePartUrl);
  multipartRoute.post(`${prefix}/list-parts`, handleListParts);
  multipartRoute.post(`${prefix}/complete`, handleComplete);
  multipartRoute.post(`${prefix}/abort`, handleAbort);
}
