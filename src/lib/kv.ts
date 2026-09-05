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
