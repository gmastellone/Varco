export interface FileRecord {
  fileId: string;
  key: string;
  filename: string;
  size: number;
  uploaderEmail?: string;
  inviteToken?: string;
  hash: string;
  salt: string;
  expiresAt: number;
  maxDownloads?: number;
  downloadCount: number;
}

export interface InviteRecord {
  label: string;
  maxFiles: number;
  remainingFiles: number;
  createdAt: number;
  expiresAt: number;
}

// Bookkeeping for an in-progress multipart upload, keyed by an opaque token
// handed to the client at /api/upload/multipart/init time. Holds the upload
// metadata (filename, size, expiry, who's uploading) so later calls
// (part-url, complete) never have to re-trust anything the client resends —
// they just look it up here by token. TTL'd generously (see
// PENDING_UPLOAD_TTL_SECONDS in the multipart route) so a stalled transfer
// can be resumed the next day without losing its metadata.
export interface PendingUpload {
  fileId: string;
  key: string;
  uploadId: string;
  filename: string;
  size: number;
  partSize: number;
  partCount: number;
  expiresInDays: number;
  maxDownloads?: number;
  uploaderEmail?: string;
  inviteToken?: string;
  createdAt: number;
}

const MIN_KV_TTL_SECONDS = 60;

function fileKvKey(token: string): string {
  return `file:${token}`;
}

function inviteKvKey(token: string): string {
  return `invite:${token}`;
}

function failKvKey(token: string): string {
  return `fail:${token}`;
}

function pendingUploadKvKey(token: string): string {
  return `pending:${token}`;
}

function ttlFromExpiresAt(expiresAt: number): number {
  const seconds = Math.ceil((expiresAt - Date.now()) / 1000);
  return Math.max(seconds, MIN_KV_TTL_SECONDS);
}

export async function getFileRecord(kv: KVNamespace, token: string): Promise<FileRecord | null> {
  return kv.get<FileRecord>(fileKvKey(token), "json");
}

export async function putFileRecord(
  kv: KVNamespace,
  token: string,
  record: FileRecord,
  expirationTtl: number
): Promise<void> {
  await kv.put(fileKvKey(token), JSON.stringify(record), {
    expirationTtl: Math.max(expirationTtl, MIN_KV_TTL_SECONDS),
  });
}

export async function incrementDownloadCount(
  kv: KVNamespace,
  token: string,
  record: FileRecord
): Promise<void> {
  const updated: FileRecord = { ...record, downloadCount: record.downloadCount + 1 };
  await kv.put(fileKvKey(token), JSON.stringify(updated), {
    expirationTtl: ttlFromExpiresAt(record.expiresAt),
  });
}

export async function getInviteRecord(kv: KVNamespace, token: string): Promise<InviteRecord | null> {
  return kv.get<InviteRecord>(inviteKvKey(token), "json");
}

export async function putInviteRecord(
  kv: KVNamespace,
  token: string,
  record: InviteRecord,
  expirationTtl: number
): Promise<void> {
  await kv.put(inviteKvKey(token), JSON.stringify(record), {
    expirationTtl: Math.max(expirationTtl, MIN_KV_TTL_SECONDS),
  });
}

export async function decrementInviteRemaining(
  kv: KVNamespace,
  token: string,
  record: InviteRecord
): Promise<void> {
  const updated: InviteRecord = { ...record, remainingFiles: record.remainingFiles - 1 };
  await kv.put(inviteKvKey(token), JSON.stringify(updated), {
    expirationTtl: ttlFromExpiresAt(record.expiresAt),
  });
}

export async function getFailCount(kv: KVNamespace, token: string): Promise<number> {
  const value = await kv.get(failKvKey(token));
  return value ? parseInt(value, 10) : 0;
}

export async function incrementFailCount(kv: KVNamespace, token: string): Promise<number> {
  const current = await getFailCount(kv, token);
  const next = current + 1;
  await kv.put(failKvKey(token), String(next), { expirationTtl: 3600 });
  return next;
}

export async function resetFailCount(kv: KVNamespace, token: string): Promise<void> {
  await kv.delete(failKvKey(token));
}

export async function getPendingUpload(kv: KVNamespace, token: string): Promise<PendingUpload | null> {
  return kv.get<PendingUpload>(pendingUploadKvKey(token), "json");
}

export async function putPendingUpload(
  kv: KVNamespace,
  token: string,
  record: PendingUpload,
  expirationTtl: number
): Promise<void> {
  await kv.put(pendingUploadKvKey(token), JSON.stringify(record), {
    expirationTtl: Math.max(expirationTtl, MIN_KV_TTL_SECONDS),
  });
}

export async function deletePendingUpload(kv: KVNamespace, token: string): Promise<void> {
  await kv.delete(pendingUploadKvKey(token));
}

export async function listAllFileRecords(kv: KVNamespace): Promise<FileRecord[]> {
  const records: FileRecord[] = [];
  let cursor: string | undefined;
  do {
    const page = await kv.list({ prefix: "file:", cursor });
    for (const entry of page.keys) {
      const record = await kv.get<FileRecord>(entry.name, "json");
      if (record) records.push(record);
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return records;
}
