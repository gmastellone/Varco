# Varco Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Varco, a private, self-hosted file-transfer service (WeTransfer-style) on a single Cloudflare Worker backed by Backblaze B2, with presigned-PUT uploads, streaming-proxy downloads, and system-generated per-file passwords.

**Architecture:** One Cloudflare Worker (Hono router) serves both the API and the static frontend via the `assets` binding. Uploads go browser → B2 directly via a presigned S3 v4 PUT URL (Worker never touches file bytes). Downloads go B2 → Worker → browser as a pass-through `ReadableStream` (Worker never buffers). All metadata lives in Workers KV with native TTL for expiry; a daily cron sweeps B2 for objects whose KV record has expired.

**Tech Stack:** TypeScript, Hono, aws4fetch, Cloudflare Workers KV, Cloudflare Workers `assets`, vitest for tests, vanilla HTML/CSS/JS (native ES modules, no bundler) for the frontend.

**Spec:** [docs/superpowers/specs/2026-09-05-varco.md](../specs/2026-09-05-varco.md) — read it alongside this plan; the constraints marked VINCOLANTE there are non-negotiable.

## Global Constraints

- Single Cloudflare Worker serves both API and static assets (`assets` in wrangler.toml) — no separate Pages project.
- Router: Hono. S3 signing: aws4fetch — never the AWS SDK.
- Frontend: vanilla HTML/CSS/JS, no framework, no build step (native `<script type="module">` is allowed since it needs no bundler).
- Upload: Worker only issues a presigned single PUT URL (no multipart); the file body never passes through the Worker.
- Download: Worker does `fetch()` against B2 and returns `response.body` as a pass-through stream — never `arrayBuffer()`, never a redirect to a presigned GET.
- Passwords are system-generated (never user-chosen), high entropy, hashed with a single salted SHA-256 — never PBKDF2/bcrypt/scrypt.
- Every request handler must stay well under the ~10ms CPU budget of the Workers free plan: no heavy libraries, no unnecessary synchronous work, no large payload parsing.
- No file-type/MIME-specific logic anywhere (Varco is generic by definition).
- Download-side errors are generic: never let a response distinguish "token doesn't exist" from "wrong password".
- Never log a password or token in plaintext, in any environment.

---

### Task 1: Project scaffolding

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `wrangler.toml`
- Create: `.dev.vars.example`
- Create: `.gitignore`
- Create: `src/index.ts` (placeholder, replaced fully in Task 8)
- Create: `src/types.ts`

**Interfaces:**
- Produces: an `npm install`-able project with working `npm run typecheck` and `npm test` commands that every later task relies on. Also produces the `Bindings` interface in `src/types.ts` (`{ FILES_KV: KVNamespace; ASSETS: Fetcher; B2_KEY_ID: string; B2_APP_KEY: string; B2_BUCKET: string; B2_ENDPOINT: string; B2_REGION: string }`), which every route, `lib/b2.ts`, and `lib/cleanup.ts` imports from here on.

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "varco",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "@cloudflare/workers-types": "^4.20240909.0",
    "typescript": "^5.6.2",
    "vitest": "^2.1.1",
    "wrangler": "^3.78.10"
  },
  "dependencies": {
    "aws4fetch": "^1.0.20",
    "hono": "^4.6.3"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022"],
    "module": "ES2022",
    "moduleResolution": "Bundler",
    "types": ["@cloudflare/workers-types"],
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src", "public", "tests", "vitest.config.ts"]
}
```

- [ ] **Step 3: Create `vitest.config.ts`**

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    passWithNoTests: true,
  },
});
```

`passWithNoTests: true` is required so Step 11 below (`npm test` exiting 0 with zero test files present) actually holds — without it, vitest 2.x exits 1 when no tests are found.

- [ ] **Step 4: Create `wrangler.toml`**

```toml
name = "varco"
main = "src/index.ts"
compatibility_date = "2024-11-01"

[assets]
directory = "./public"
binding = "ASSETS"

[[kv_namespaces]]
binding = "FILES_KV"
id = "REPLACE_WITH_KV_NAMESPACE_ID"

[triggers]
crons = ["0 3 * * *"]

[vars]
B2_BUCKET = "REPLACE_WITH_BUCKET_NAME"
B2_ENDPOINT = "https://REPLACE_WITH_YOUR_ENDPOINT"
B2_REGION = "REPLACE_WITH_REGION"
```

Note: `B2_KEY_ID` and `B2_APP_KEY` are secrets and must **not** go here — they are set via `wrangler secret put` in production and via `.dev.vars` locally (see Task 12 / README).

- [ ] **Step 5: Create `.dev.vars.example`**

```
B2_KEY_ID=your-application-key-id
B2_APP_KEY=your-application-key
B2_BUCKET=your-bucket-name
B2_ENDPOINT=https://s3.us-west-004.backblazeb2.com
B2_REGION=us-west-004
```

- [ ] **Step 6: Create `.gitignore`**

```
node_modules/
.wrangler/
.dev.vars
dist/
*.log
```

- [ ] **Step 7: Create a placeholder `src/index.ts`**

```typescript
export default {
  async fetch(): Promise<Response> {
    return new Response("not implemented yet", { status: 501 });
  },
};
```

- [ ] **Step 8: Create `src/types.ts`**

```typescript
export interface Bindings {
  FILES_KV: KVNamespace;
  ASSETS: Fetcher;
  B2_KEY_ID: string;
  B2_APP_KEY: string;
  B2_BUCKET: string;
  B2_ENDPOINT: string;
  B2_REGION: string;
}
```

- [ ] **Step 9: Install dependencies**

Run: `npm install`
Expected: exits 0, creates `package-lock.json` and `node_modules/`.

- [ ] **Step 10: Verify typecheck runs clean**

Run: `npm run typecheck`
Expected: exits 0, no errors.

- [ ] **Step 11: Verify the test runner works with zero tests**

Run: `npm test`
Expected: exits 0 (vitest reports "no test files found" or similar — that's fine, later tasks add tests).

- [ ] **Step 12: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts wrangler.toml .dev.vars.example .gitignore src/index.ts src/types.ts
git commit -m "chore: scaffold Varco project (Hono + Workers + vitest)"
```

---

### Task 2: `lib/crypto.ts` — password generation, hashing, constant-time compare

**Files:**
- Create: `src/lib/crypto.ts`
- Test: `tests/lib/crypto.test.ts`

**Interfaces:**
- Produces:
  - `generatePassword(): string` — 12-char high-entropy password from an unambiguous alphabet
  - `generateToken(): string` — 64-char hex (32 random bytes), used for download tokens, invite tokens, fileId
  - `generateSalt(): string` — 32-char hex (16 random bytes)
  - `sha256Hex(input: string): Promise<string>` — hex-encoded SHA-256
  - `hashPassword(password: string, salt: string): Promise<string>` — `sha256Hex(salt + password)`
  - `constantTimeEqual(a: string, b: string): boolean`

- [ ] **Step 1: Write the failing tests**

Create `tests/lib/crypto.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import {
  generatePassword,
  generateToken,
  generateSalt,
  sha256Hex,
  hashPassword,
  constantTimeEqual,
} from "../../src/lib/crypto";

describe("generatePassword", () => {
  it("returns a 12-character string", () => {
    expect(generatePassword()).toHaveLength(12);
  });

  it("only uses unambiguous alphabet characters", () => {
    const password = generatePassword();
    expect(password).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789]+$/);
  });

  it("generates different passwords across calls", () => {
    const passwords = new Set(Array.from({ length: 20 }, () => generatePassword()));
    expect(passwords.size).toBe(20);
  });
});

describe("generateToken", () => {
  it("returns a 64-character hex string (32 bytes)", () => {
    const token = generateToken();
    expect(token).toHaveLength(64);
    expect(token).toMatch(/^[0-9a-f]+$/);
  });

  it("generates different tokens across calls", () => {
    expect(generateToken()).not.toBe(generateToken());
  });
});

describe("generateSalt", () => {
  it("returns a 32-character hex string (16 bytes)", () => {
    const salt = generateSalt();
    expect(salt).toHaveLength(32);
    expect(salt).toMatch(/^[0-9a-f]+$/);
  });
});

describe("sha256Hex", () => {
  it("matches the known SHA-256 test vector for 'abc'", async () => {
    expect(await sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
  });
});

describe("hashPassword", () => {
  it("hashes salt concatenated with password", async () => {
    const direct = await sha256Hex("saltvaluepassword123");
    const viaHelper = await hashPassword("password123", "saltvalue");
    expect(viaHelper).toBe(direct);
  });
});

describe("constantTimeEqual", () => {
  it("returns true for identical strings", () => {
    expect(constantTimeEqual("abcdef", "abcdef")).toBe(true);
  });

  it("returns false for different strings of equal length", () => {
    expect(constantTimeEqual("abcdef", "abcxef")).toBe(false);
  });

  it("returns false for strings of different length", () => {
    expect(constantTimeEqual("abc", "abcd")).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/lib/crypto.test.ts`
Expected: FAIL — `src/lib/crypto.ts` does not exist yet (module not found).

- [ ] **Step 3: Implement `src/lib/crypto.ts`**

```typescript
const PASSWORD_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
const PASSWORD_LENGTH = 12;

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomHex(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return toHex(bytes.buffer);
}

export function generatePassword(): string {
  const bytes = new Uint8Array(PASSWORD_LENGTH);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < PASSWORD_LENGTH; i++) {
    out += PASSWORD_ALPHABET[bytes[i] % PASSWORD_ALPHABET.length];
  }
  return out;
}

export function generateToken(): string {
  return randomHex(32);
}

export function generateSalt(): string {
  return randomHex(16);
}

export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return toHex(digest);
}

export async function hashPassword(password: string, salt: string): Promise<string> {
  return sha256Hex(salt + password);
}

export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    let dummy = 0;
    for (let i = 0; i < a.length; i++) dummy |= a.charCodeAt(i);
    return dummy === -1; // always false; keeps a full pass over `a` for timing consistency
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/lib/crypto.test.ts`
Expected: PASS (all tests green).

- [ ] **Step 5: Commit**

```bash
git add src/lib/crypto.ts tests/lib/crypto.test.ts
git commit -m "feat: add crypto helpers (password/token/salt generation, SHA-256, constant-time compare)"
```

---

### Task 3: `lib/kv.ts` — typed KV helpers + mock KV test helper

**Files:**
- Create: `src/lib/kv.ts`
- Create: `tests/helpers/mockKv.ts`
- Test: `tests/lib/kv.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - Types: `FileRecord`, `InviteRecord`
  - `getFileRecord(kv, token): Promise<FileRecord | null>`
  - `putFileRecord(kv, token, record, expirationTtl): Promise<void>`
  - `incrementDownloadCount(kv, token, record): Promise<void>`
  - `getInviteRecord(kv, token): Promise<InviteRecord | null>`
  - `putInviteRecord(kv, token, record, expirationTtl): Promise<void>`
  - `decrementInviteRemaining(kv, token, record): Promise<void>`
  - `getFailCount(kv, token): Promise<number>`
  - `incrementFailCount(kv, token): Promise<number>`
  - `listAllFileRecords(kv): Promise<FileRecord[]>`
  - Test helper: `createMockKv()` from `tests/helpers/mockKv.ts` — an in-memory object implementing `get`/`put`/`delete`/`list` with TTL expiry, reused by every later test that needs a `KVNamespace`.

- [ ] **Step 1: Create the mock KV test helper**

Create `tests/helpers/mockKv.ts`:

```typescript
interface StoredEntry {
  value: string;
  expiresAtMs?: number;
}

export function createMockKv() {
  const store = new Map<string, StoredEntry>();

  function isExpired(entry: StoredEntry): boolean {
    return entry.expiresAtMs !== undefined && entry.expiresAtMs <= Date.now();
  }

  return {
    async get(key: string, type?: string) {
      const entry = store.get(key);
      if (!entry || isExpired(entry)) return null;
      return type === "json" ? JSON.parse(entry.value) : entry.value;
    },
    async put(key: string, value: string, opts?: { expirationTtl?: number }) {
      const expiresAtMs = opts?.expirationTtl ? Date.now() + opts.expirationTtl * 1000 : undefined;
      store.set(key, { value, expiresAtMs });
    },
    async delete(key: string) {
      store.delete(key);
    },
    async list(opts?: { prefix?: string; cursor?: string }) {
      const prefix = opts?.prefix ?? "";
      const keys = [...store.keys()]
        .filter((k) => k.startsWith(prefix) && !isExpired(store.get(k)!))
        .map((name) => ({ name }));
      return { keys, list_complete: true, cursor: undefined as string | undefined };
    },
    _raw: store,
  };
}

export type MockKv = ReturnType<typeof createMockKv>;
```

- [ ] **Step 2: Write the failing tests**

Create `tests/lib/kv.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { createMockKv } from "../helpers/mockKv";
import {
  getFileRecord,
  putFileRecord,
  incrementDownloadCount,
  getInviteRecord,
  putInviteRecord,
  decrementInviteRemaining,
  getFailCount,
  incrementFailCount,
  listAllFileRecords,
  type FileRecord,
  type InviteRecord,
} from "../../src/lib/kv";

function makeFileRecord(overrides: Partial<FileRecord> = {}): FileRecord {
  return {
    fileId: "file123",
    key: "f/2026/09/file123/report.pdf",
    filename: "report.pdf",
    size: 1024,
    hash: "deadbeef",
    salt: "salt1234",
    expiresAt: Date.now() + 7 * 86400 * 1000,
    downloadCount: 0,
    ...overrides,
  };
}

function makeInviteRecord(overrides: Partial<InviteRecord> = {}): InviteRecord {
  return {
    label: "friend",
    maxFiles: 3,
    remainingFiles: 3,
    createdAt: Date.now(),
    expiresAt: Date.now() + 3600 * 1000,
    ...overrides,
  };
}

describe("file records", () => {
  it("round-trips a record through put/get", async () => {
    const kv = createMockKv() as any;
    const record = makeFileRecord();
    await putFileRecord(kv, "tok1", record, 7 * 86400);
    expect(await getFileRecord(kv, "tok1")).toEqual(record);
  });

  it("returns null for a missing token", async () => {
    const kv = createMockKv() as any;
    expect(await getFileRecord(kv, "missing")).toBeNull();
  });

  it("increments downloadCount while preserving other fields", async () => {
    const kv = createMockKv() as any;
    const record = makeFileRecord({ downloadCount: 2 });
    await putFileRecord(kv, "tok1", record, 7 * 86400);
    await incrementDownloadCount(kv, "tok1", record);
    const updated = await getFileRecord(kv, "tok1");
    expect(updated?.downloadCount).toBe(3);
    expect(updated?.filename).toBe("report.pdf");
  });
});

describe("invite records", () => {
  it("round-trips a record through put/get", async () => {
    const kv = createMockKv() as any;
    const record = makeInviteRecord();
    await putInviteRecord(kv, "inv1", record, 3600);
    expect(await getInviteRecord(kv, "inv1")).toEqual(record);
  });

  it("decrements remainingFiles while preserving other fields", async () => {
    const kv = createMockKv() as any;
    const record = makeInviteRecord({ remainingFiles: 2 });
    await putInviteRecord(kv, "inv1", record, 3600);
    await decrementInviteRemaining(kv, "inv1", record);
    const updated = await getInviteRecord(kv, "inv1");
    expect(updated?.remainingFiles).toBe(1);
    expect(updated?.label).toBe("friend");
  });
});

describe("fail counter", () => {
  it("starts at zero for an unseen token", async () => {
    const kv = createMockKv() as any;
    expect(await getFailCount(kv, "tok1")).toBe(0);
  });

  it("increments across repeated calls and returns the running count", async () => {
    const kv = createMockKv() as any;
    await incrementFailCount(kv, "tok1");
    await incrementFailCount(kv, "tok1");
    const count = await incrementFailCount(kv, "tok1");
    expect(count).toBe(3);
  });
});

describe("listAllFileRecords", () => {
  it("returns every stored file record and ignores invite records", async () => {
    const kv = createMockKv() as any;
    await putFileRecord(kv, "tok1", makeFileRecord({ fileId: "a" }), 86400);
    await putFileRecord(kv, "tok2", makeFileRecord({ fileId: "b" }), 86400);
    await putInviteRecord(kv, "inv1", makeInviteRecord(), 3600);

    const records = await listAllFileRecords(kv);
    expect(records.map((r) => r.fileId).sort()).toEqual(["a", "b"]);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run tests/lib/kv.test.ts`
Expected: FAIL — `src/lib/kv.ts` does not exist yet.

- [ ] **Step 4: Implement `src/lib/kv.ts`**

```typescript
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
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/lib/kv.test.ts`
Expected: PASS (all tests green).

- [ ] **Step 6: Commit**

```bash
git add src/lib/kv.ts tests/helpers/mockKv.ts tests/lib/kv.test.ts
git commit -m "feat: add typed KV helpers for file/invite records and fail counter"
```

---

### Task 4: `lib/b2.ts` — presign PUT, streaming GET, delete, list via aws4fetch

**Files:**
- Create: `src/lib/b2.ts`
- Test: `tests/lib/b2.test.ts`

**Interfaces:**
- Consumes: `Bindings` (Task 1's `src/types.ts`).
- Produces:
  - Type: `B2Config { keyId, appKey, bucket, endpoint, region }`
  - `presignPutUrl(config, key, expiresInSeconds?): Promise<string>`
  - `fetchObject(config, key): Promise<Response>`
  - `deleteObject(config, key): Promise<void>`
  - `listObjectKeys(config, prefix): Promise<string[]>`
  - `b2ConfigFromEnv(env: Bindings): B2Config` — the single shared mapping from Worker bindings to B2 connection config; Tasks 5, 6, and 8 import this instead of redefining it.

- [ ] **Step 1: Write the failing tests**

Create `tests/lib/b2.test.ts`:

```typescript
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  presignPutUrl,
  fetchObject,
  deleteObject,
  listObjectKeys,
  b2ConfigFromEnv,
  type B2Config,
} from "../../src/lib/b2";
import type { Bindings } from "../../src/types";

const config: B2Config = {
  keyId: "test-key-id",
  appKey: "test-app-key",
  bucket: "varco-test",
  endpoint: "https://s3.us-west-004.backblazeb2.com",
  region: "us-west-004",
};

describe("b2ConfigFromEnv", () => {
  it("maps Worker bindings to a B2Config", () => {
    const env: Bindings = {
      FILES_KV: {} as unknown as KVNamespace,
      ASSETS: {} as unknown as Fetcher,
      B2_KEY_ID: "k",
      B2_APP_KEY: "s",
      B2_BUCKET: "bucket",
      B2_ENDPOINT: "https://example.com",
      B2_REGION: "r",
    };
    expect(b2ConfigFromEnv(env)).toEqual({
      keyId: "k",
      appKey: "s",
      bucket: "bucket",
      endpoint: "https://example.com",
      region: "r",
    });
  });
});

describe("presignPutUrl", () => {
  it("produces a query-signed PUT URL scoped to the given key", async () => {
    const url = await presignPutUrl(config, "f/2026/09/abc/report.pdf", 3600);
    const parsed = new URL(url);
    expect(parsed.pathname).toBe("/varco-test/f/2026/09/abc/report.pdf");
    expect(parsed.searchParams.get("X-Amz-Expires")).toBe("3600");
    expect(parsed.searchParams.has("X-Amz-Signature")).toBe(true);
    expect(parsed.searchParams.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
  });

  it("uses a 6-hour default expiry when none is given", async () => {
    const url = await presignPutUrl(config, "f/2026/09/abc/report.pdf");
    const parsed = new URL(url);
    expect(parsed.searchParams.get("X-Amz-Expires")).toBe(String(6 * 3600));
  });
});

describe("fetchObject / deleteObject / listObjectKeys", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetchObject issues a signed GET to the object URL and returns the raw response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        expect(String(input)).toContain("/varco-test/f/2026/09/abc/report.pdf");
        return new Response("file-bytes", { status: 200 });
      })
    );

    const response = await fetchObject(config, "f/2026/09/abc/report.pdf");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("file-bytes");
  });

  it("deleteObject resolves without throwing on a 2xx response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })));
    await expect(deleteObject(config, "f/2026/09/abc/report.pdf")).resolves.toBeUndefined();
  });

  it("deleteObject throws on a non-2xx, non-404 response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 500 })));
    await expect(deleteObject(config, "f/2026/09/abc/report.pdf")).rejects.toThrow();
  });

  it("listObjectKeys parses keys from a single-page XML response", async () => {
    const xml =
      '<?xml version="1.0"?><ListBucketResult><IsTruncated>false</IsTruncated>' +
      "<Contents><Key>f/2026/09/a/one.pdf</Key></Contents>" +
      "<Contents><Key>f/2026/09/b/two.pdf</Key></Contents></ListBucketResult>";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(xml, { status: 200 })));

    const keys = await listObjectKeys(config, "f/");
    expect(keys).toEqual(["f/2026/09/a/one.pdf", "f/2026/09/b/two.pdf"]);
  });

  it("listObjectKeys follows pagination via the continuation token", async () => {
    const page1 =
      '<?xml version="1.0"?><ListBucketResult><IsTruncated>true</IsTruncated>' +
      "<NextContinuationToken>tok1</NextContinuationToken>" +
      "<Contents><Key>f/a</Key></Contents></ListBucketResult>";
    const page2 =
      '<?xml version="1.0"?><ListBucketResult><IsTruncated>false</IsTruncated>' +
      "<Contents><Key>f/b</Key></Contents></ListBucketResult>";
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        call += 1;
        return new Response(call === 1 ? page1 : page2, { status: 200 });
      })
    );

    const keys = await listObjectKeys(config, "f/");
    expect(keys).toEqual(["f/a", "f/b"]);
    expect(call).toBe(2);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/lib/b2.test.ts`
Expected: FAIL — `src/lib/b2.ts` does not exist yet.

- [ ] **Step 3: Implement `src/lib/b2.ts`**

```typescript
import { AwsClient } from "aws4fetch";
import type { Bindings } from "../types";

export interface B2Config {
  keyId: string;
  appKey: string;
  bucket: string;
  endpoint: string;
  region: string;
}

export function b2ConfigFromEnv(env: Bindings): B2Config {
  return {
    keyId: env.B2_KEY_ID,
    appKey: env.B2_APP_KEY,
    bucket: env.B2_BUCKET,
    endpoint: env.B2_ENDPOINT,
    region: env.B2_REGION,
  };
}

const DEFAULT_PUT_EXPIRES_SECONDS = 6 * 3600;

function client(config: B2Config): AwsClient {
  return new AwsClient({
    accessKeyId: config.keyId,
    secretAccessKey: config.appKey,
    service: "s3",
    region: config.region,
    // aws4fetch retries 500/429 responses with exponential backoff by
    // default (10 retries, up to ~25s of cumulative sleep). That sleep is
    // wall-clock latency, not Workers CPU time, but a request left hanging
    // that long is still bad for a download/upload the client is waiting
    // on. Fail fast instead; callers (routes, cron cleanup) can add their
    // own bounded retry later if B2 turns out to need it in practice.
    retries: 0,
  });
}

function objectUrl(config: B2Config, key: string): URL {
  const base = config.endpoint.replace(/\/+$/, "");
  return new URL(`${base}/${config.bucket}/${key}`);
}

export async function presignPutUrl(
  config: B2Config,
  key: string,
  expiresInSeconds: number = DEFAULT_PUT_EXPIRES_SECONDS
): Promise<string> {
  const url = objectUrl(config, key);
  url.searchParams.set("X-Amz-Expires", String(expiresInSeconds));
  const signed = await client(config).sign(url.toString(), {
    method: "PUT",
    aws: { signQuery: true },
  });
  return signed.url;
}

export async function fetchObject(config: B2Config, key: string): Promise<Response> {
  const url = objectUrl(config, key);
  return client(config).fetch(url.toString(), { method: "GET" });
}

export async function deleteObject(config: B2Config, key: string): Promise<void> {
  const url = objectUrl(config, key);
  const response = await client(config).fetch(url.toString(), { method: "DELETE" });
  if (!response.ok && response.status !== 404) {
    throw new Error(`B2 delete failed for ${key}: ${response.status}`);
  }
}

export async function listObjectKeys(config: B2Config, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let continuationToken: string | undefined;

  do {
    const url = new URL(`${config.endpoint.replace(/\/+$/, "")}/${config.bucket}`);
    url.searchParams.set("list-type", "2");
    url.searchParams.set("prefix", prefix);
    if (continuationToken) url.searchParams.set("continuation-token", continuationToken);

    const response = await client(config).fetch(url.toString(), { method: "GET" });
    if (!response.ok) {
      throw new Error(`B2 list failed: ${response.status}`);
    }
    const xml = await response.text();
    for (const match of xml.matchAll(/<Key>([^<]*)<\/Key>/g)) {
      keys.push(match[1]);
    }
    const truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
    const tokenMatch = xml.match(/<NextContinuationToken>([^<]*)<\/NextContinuationToken>/);
    continuationToken = truncated && tokenMatch ? tokenMatch[1] : undefined;
  } while (continuationToken);

  return keys;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/lib/b2.test.ts`
Expected: PASS. (`presignPutUrl` performs no network call — `AwsClient.sign` only computes the SigV4 signature locally — so it needs no fetch stub. The other three functions call `client(config).fetch(...)`; since `client()` constructs a fresh `AwsClient` on every call, it always resolves `fetch` from `globalThis` at call time, so `vi.stubGlobal("fetch", ...)` reliably intercepts it.)

- [ ] **Step 5: Commit**

```bash
git add src/lib/b2.ts tests/lib/b2.test.ts
git commit -m "feat: add B2 client (presigned PUT, streaming GET, delete, list) via aws4fetch"
```

---

### Task 5: shared types + `routes/upload.ts`

**Files:**
- Create: `src/routes/upload.ts`
- Test: `tests/routes/upload.test.ts`

**Interfaces:**
- Consumes: `generateToken`, `generateSalt`, `generatePassword`, `hashPassword` (Task 2); `getInviteRecord`, `decrementInviteRemaining`, `putFileRecord`, `FileRecord` (Task 3); `presignPutUrl`, `b2ConfigFromEnv`, `B2Config` (Task 4); `Bindings` (Task 1); `createMockKv` test helper (Task 3).
- Produces: `uploadRoute: Hono<{ Bindings: Bindings }>` mounted at `POST /api/upload`.

- [ ] **Step 1: Write the failing tests**

Create `tests/routes/upload.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { createMockKv, type MockKv } from "../helpers/mockKv";
import { uploadRoute } from "../../src/routes/upload";
import type { Bindings } from "../../src/types";
import { putInviteRecord, type InviteRecord } from "../../src/lib/kv";

function makeEnv(kv: MockKv): Bindings {
  return {
    FILES_KV: kv as unknown as KVNamespace,
    ASSETS: {} as unknown as Fetcher,
    B2_KEY_ID: "test-key",
    B2_APP_KEY: "test-secret",
    B2_BUCKET: "varco-test",
    B2_ENDPOINT: "https://s3.us-west-004.backblazeb2.com",
    B2_REGION: "us-west-004",
  };
}

describe("POST /api/upload", () => {
  let kv: MockKv;

  beforeEach(() => {
    kv = createMockKv();
  });

  it("rejects requests with no auth header and no invite token", async () => {
    const res = await uploadRoute.request(
      "/api/upload",
      { method: "POST", body: JSON.stringify({ filename: "a.txt", size: 10, expiresInDays: 7 }) },
      makeEnv(kv)
    );
    expect(res.status).toBe(403);
  });

  it("accepts a fixed user identified via the Cf-Access header", async () => {
    const res = await uploadRoute.request(
      "/api/upload",
      {
        method: "POST",
        headers: { "Cf-Access-Authenticated-User-Email": "me@example.com" },
        body: JSON.stringify({ filename: "a.txt", size: 10, expiresInDays: 7 }),
      },
      makeEnv(kv)
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.downloadUrl).toMatch(/^\/d\/[0-9a-f]{64}$/);
    expect(json.password).toHaveLength(12);
    expect(json.uploadUrl).toContain("varco-test");
  });

  it("rejects an unknown invite token", async () => {
    const res = await uploadRoute.request(
      "/api/upload?invite=nope",
      { method: "POST", body: JSON.stringify({ filename: "a.txt", size: 10, expiresInDays: 7 }) },
      makeEnv(kv)
    );
    expect(res.status).toBe(403);
  });

  it("accepts and decrements a valid invite token", async () => {
    const invite: InviteRecord = {
      label: "friend",
      maxFiles: 2,
      remainingFiles: 2,
      createdAt: Date.now(),
      expiresAt: Date.now() + 3600_000,
    };
    await putInviteRecord(kv as unknown as KVNamespace, "inv1", invite, 3600);

    const res = await uploadRoute.request(
      "/api/upload?invite=inv1",
      { method: "POST", body: JSON.stringify({ filename: "a.txt", size: 10, expiresInDays: 7 }) },
      makeEnv(kv)
    );
    expect(res.status).toBe(200);

    const updatedInvite = await kv.get("invite:inv1", "json");
    expect(updatedInvite.remainingFiles).toBe(1);
  });

  it("rejects an exhausted invite token", async () => {
    const invite: InviteRecord = {
      label: "friend",
      maxFiles: 1,
      remainingFiles: 0,
      createdAt: Date.now(),
      expiresAt: Date.now() + 3600_000,
    };
    await putInviteRecord(kv as unknown as KVNamespace, "inv1", invite, 3600);

    const res = await uploadRoute.request(
      "/api/upload?invite=inv1",
      { method: "POST", body: JSON.stringify({ filename: "a.txt", size: 10, expiresInDays: 7 }) },
      makeEnv(kv)
    );
    expect(res.status).toBe(403);
  });

  it("rejects a malformed body", async () => {
    const res = await uploadRoute.request(
      "/api/upload",
      {
        method: "POST",
        headers: { "Cf-Access-Authenticated-User-Email": "me@example.com" },
        body: JSON.stringify({ filename: "" }),
      },
      makeEnv(kv)
    );
    expect(res.status).toBe(400);
  });

  it("stores a file record whose hash matches the returned password", async () => {
    const res = await uploadRoute.request(
      "/api/upload",
      {
        method: "POST",
        headers: { "Cf-Access-Authenticated-User-Email": "me@example.com" },
        body: JSON.stringify({ filename: "a.txt", size: 10, expiresInDays: 7 }),
      },
      makeEnv(kv)
    );
    const json = (await res.json()) as any;
    const token = json.downloadUrl.split("/").pop();
    const record = await kv.get(`file:${token}`, "json");
    expect(record.filename).toBe("a.txt");
    expect(record.uploaderEmail).toBe("me@example.com");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/routes/upload.test.ts`
Expected: FAIL — `src/routes/upload.ts` does not exist yet.

- [ ] **Step 3: Implement `src/routes/upload.ts`**

```typescript
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

function isValidUploadBody(body: unknown): body is UploadRequestBody {
  if (typeof body !== "object" || body === null) return false;
  const b = body as Record<string, unknown>;
  return (
    typeof b.filename === "string" &&
    b.filename.length > 0 &&
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
  return `f/${year}/${month}/${fileId}/${filename}`;
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/routes/upload.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/routes/upload.ts tests/routes/upload.test.ts
git commit -m "feat: add POST /api/upload (fixed-user and invite auth, presigned PUT)"
```

---

### Task 6: `routes/download.ts`

**Files:**
- Create: `src/routes/download.ts`
- Test: `tests/routes/download.test.ts`

**Interfaces:**
- Consumes: `getFileRecord`, `incrementDownloadCount`, `getFailCount`, `incrementFailCount` (Task 3); `hashPassword`, `constantTimeEqual` (Task 2); `fetchObject`, `b2ConfigFromEnv` (Task 4); `Bindings` (Task 1); `createMockKv` (Task 3).
- Produces: `downloadRoute: Hono<{ Bindings: Bindings }>` mounted at `GET /d/:token` and `POST /d/:token`.

- [ ] **Step 1: Write the failing tests**

Create `tests/routes/download.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createMockKv, type MockKv } from "../helpers/mockKv";
import { downloadRoute } from "../../src/routes/download";
import type { Bindings } from "../../src/types";
import { putFileRecord, type FileRecord } from "../../src/lib/kv";
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
      { method: "POST", body: JSON.stringify({ password: "whatever" }) },
      makeEnv(kv)
    );
    expect(res.status).toBe(404);
  });

  it("returns the same generic 404 for a wrong password on a real token", async () => {
    const record = await makeRecord("correct-horse");
    await putFileRecord(kv as unknown as KVNamespace, "tok1", record, 7 * 86400);

    const res = await downloadRoute.request(
      "/d/tok1",
      { method: "POST", body: JSON.stringify({ password: "wrong" }) },
      makeEnv(kv)
    );
    expect(res.status).toBe(404);
  });

  it("locks out after 5 failed attempts on a real token, then rejects the correct password too", async () => {
    const record = await makeRecord("correct-horse");
    await putFileRecord(kv as unknown as KVNamespace, "tok1", record, 7 * 86400);

    for (let i = 0; i < 5; i++) {
      const res = await downloadRoute.request(
        "/d/tok1",
        { method: "POST", body: JSON.stringify({ password: "wrong" }) },
        makeEnv(kv)
      );
      expect(res.status).toBe(404);
    }
    const locked = await downloadRoute.request(
      "/d/tok1",
      { method: "POST", body: JSON.stringify({ password: "correct-horse" }) },
      makeEnv(kv)
    );
    expect(locked.status).toBe(429);
  });

  it("also locks out a nonexistent token after 5 attempts (no existence oracle)", async () => {
    for (let i = 0; i < 5; i++) {
      await downloadRoute.request(
        "/d/fake-token",
        { method: "POST", body: JSON.stringify({ password: "whatever" }) },
        makeEnv(kv)
      );
    }
    const locked = await downloadRoute.request(
      "/d/fake-token",
      { method: "POST", body: JSON.stringify({ password: "whatever" }) },
      makeEnv(kv)
    );
    expect(locked.status).toBe(429);
  });

  it("returns 410 when the file is past its download limit", async () => {
    const record = await makeRecord("correct-horse", { maxDownloads: 1, downloadCount: 1 });
    await putFileRecord(kv as unknown as KVNamespace, "tok1", record, 7 * 86400);

    const res = await downloadRoute.request(
      "/d/tok1",
      { method: "POST", body: JSON.stringify({ password: "correct-horse" }) },
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
      { method: "POST", body: JSON.stringify({ password: "correct-horse" }) },
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
      { method: "POST", body: JSON.stringify({ password: "correct-horse" }) },
      makeEnv(kv),
      ctx
    );
    await flush();

    const updated = await kv.get("file:tok1", "json");
    expect(updated.downloadCount).toBe(1);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/routes/download.test.ts`
Expected: FAIL — `src/routes/download.ts` does not exist yet.

- [ ] **Step 3: Implement `src/routes/download.ts`**

```typescript
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

  // Hash unconditionally, even when there's no record: computing against a
  // dummy salt keeps a nonexistent-token request costing the same SHA-256
  // work as a real-token wrong-password request, closing a timing
  // side-channel that would otherwise reveal token existence.
  const salt = record?.salt ?? "no-such-token-dummy-salt-000000";
  const computedHash = await hashPassword(password, salt);
  const passwordMatches = record ? constantTimeEqual(computedHash, record.hash) : false;

  if (!record || !passwordMatches) {
    // Increment the fail counter for missing tokens too, so a wrong-password
    // response and a nonexistent-token response are indistinguishable even
    // under repeated probing. The ONLY lockout check is the pre-request
    // `failCount >= MAX_FAILED_ATTEMPTS` gate above — do not add a second
    // check here keyed off this increment's return value: incrementing
    // then re-checking `>= MAX_FAILED_ATTEMPTS` fires 429 one request too
    // early (on the 5th failed attempt itself, not starting with the 6th).
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/routes/download.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/routes/download.ts tests/routes/download.test.ts
git commit -m "feat: add GET/POST /d/:token (generic errors, lockout, streaming download)"
```

---

### Task 7: `routes/admin.ts`

**Files:**
- Create: `src/routes/admin.ts`
- Test: `tests/routes/admin.test.ts`

**Interfaces:**
- Consumes: `generateToken` (Task 2); `putInviteRecord`, `InviteRecord` (Task 3); `Bindings` (Task 5).
- Produces: `adminRoute: Hono<{ Bindings: Bindings }>` mounted at `POST /api/invite`.

- [ ] **Step 1: Write the failing tests**

Create `tests/routes/admin.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/routes/admin.test.ts`
Expected: FAIL — `src/routes/admin.ts` does not exist yet.

- [ ] **Step 3: Implement `src/routes/admin.ts`**

```typescript
import { Hono } from "hono";
import type { Bindings } from "../types";
import { generateToken } from "../lib/crypto";
import { putInviteRecord, type InviteRecord } from "../lib/kv";

interface InviteRequestBody {
  label: string;
  maxFiles: number;
  ttlHours: number;
}

function isValidInviteBody(body: unknown): body is InviteRequestBody {
  if (typeof body !== "object" || body === null) return false;
  const b = body as Record<string, unknown>;
  return (
    typeof b.label === "string" &&
    b.label.length > 0 &&
    typeof b.maxFiles === "number" &&
    b.maxFiles > 0 &&
    typeof b.ttlHours === "number" &&
    b.ttlHours > 0
  );
}

export const adminRoute = new Hono<{ Bindings: Bindings }>();

adminRoute.post("/api/invite", async (c) => {
  const callerEmail = c.req.header("Cf-Access-Authenticated-User-Email");
  if (!callerEmail) {
    return c.json({ error: "unauthorized" }, 403);
  }

  const body = await c.req.json().catch(() => null);
  if (!isValidInviteBody(body)) {
    return c.json({ error: "invalid request" }, 400);
  }

  const token = generateToken();
  const ttlSeconds = Math.round(body.ttlHours * 3600);
  const record: InviteRecord = {
    label: body.label,
    maxFiles: body.maxFiles,
    remainingFiles: body.maxFiles,
    createdAt: Date.now(),
    expiresAt: Date.now() + ttlSeconds * 1000,
  };

  await putInviteRecord(c.env.FILES_KV, token, record, ttlSeconds);

  return c.json({ inviteUrl: `/?invite=${token}` });
});
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/routes/admin.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/routes/admin.ts tests/routes/admin.test.ts
git commit -m "feat: add POST /api/invite for generating time-boxed upload invites"
```

---

### Task 8: `lib/cleanup.ts` + full `index.ts` wiring (CORS, routes, `/admin`, cron)

**Files:**
- Create: `src/lib/cleanup.ts`
- Modify: `src/index.ts` (replace the Task 1 placeholder)
- Test: `tests/lib/cleanup.test.ts`
- Test: `tests/index.test.ts`

**Interfaces:**
- Consumes: `listAllFileRecords` (Task 3); `listObjectKeys`, `deleteObject`, `b2ConfigFromEnv` (Task 4); `uploadRoute` (Task 5); `downloadRoute` (Task 6); `adminRoute` (Task 7); `Bindings` (Task 1).
- Produces:
  - `cleanupOrphanedObjects(env): Promise<{ deleted: string[] }>`
  - The final `src/index.ts` default export: `{ fetch, scheduled }`.

- [ ] **Step 1: Write the failing test for cleanup**

Create `tests/lib/cleanup.test.ts`:

```typescript
import { describe, it, expect, afterEach, vi } from "vitest";
import { createMockKv } from "../helpers/mockKv";
import { putFileRecord, type FileRecord } from "../../src/lib/kv";
import { cleanupOrphanedObjects } from "../../src/lib/cleanup";
import type { Bindings } from "../../src/types";

function makeEnv(kv: ReturnType<typeof createMockKv>): Bindings {
  return {
    FILES_KV: kv as unknown as KVNamespace,
    ASSETS: {} as unknown as Fetcher,
    B2_KEY_ID: "k",
    B2_APP_KEY: "s",
    B2_BUCKET: "varco-test",
    B2_ENDPOINT: "https://s3.us-west-004.backblazeb2.com",
    B2_REGION: "r",
  };
}

function makeRecord(overrides: Partial<FileRecord> = {}): FileRecord {
  return {
    fileId: "id",
    key: "f/2026/09/id/file.bin",
    filename: "file.bin",
    size: 1,
    hash: "h",
    salt: "s",
    expiresAt: Date.now() + 86400000,
    downloadCount: 0,
    ...overrides,
  };
}

describe("cleanupOrphanedObjects", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("deletes B2 objects that have no matching live KV record", async () => {
    const kv = createMockKv();
    await putFileRecord(kv as unknown as KVNamespace, "tok1", makeRecord({ key: "f/2026/09/a/keep.bin" }), 86400);

    const listXml =
      '<?xml version="1.0"?><ListBucketResult><IsTruncated>false</IsTruncated>' +
      "<Contents><Key>f/2026/09/a/keep.bin</Key></Contents>" +
      "<Contents><Key>f/2026/09/b/orphan.bin</Key></Contents></ListBucketResult>";

    const deleteCalls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (init?.method === "DELETE") {
          deleteCalls.push(url);
          return new Response(null, { status: 204 });
        }
        return new Response(listXml, { status: 200 });
      })
    );

    const result = await cleanupOrphanedObjects(makeEnv(kv));

    expect(result.deleted).toEqual(["f/2026/09/b/orphan.bin"]);
    expect(deleteCalls.some((u) => u.includes("orphan.bin"))).toBe(true);
    expect(deleteCalls.some((u) => u.includes("keep.bin"))).toBe(false);
  });

  it("deletes nothing when every B2 object has a live record", async () => {
    const kv = createMockKv();
    await putFileRecord(kv as unknown as KVNamespace, "tok1", makeRecord({ key: "f/2026/09/a/keep.bin" }), 86400);

    const listXml =
      '<?xml version="1.0"?><ListBucketResult><IsTruncated>false</IsTruncated>' +
      "<Contents><Key>f/2026/09/a/keep.bin</Key></Contents></ListBucketResult>";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(listXml, { status: 200 })));

    const result = await cleanupOrphanedObjects(makeEnv(kv));
    expect(result.deleted).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/lib/cleanup.test.ts`
Expected: FAIL — `src/lib/cleanup.ts` does not exist yet.

- [ ] **Step 3: Implement `src/lib/cleanup.ts`**

```typescript
import type { Bindings } from "../types";
import { listAllFileRecords } from "./kv";
import { listObjectKeys, deleteObject, b2ConfigFromEnv } from "./b2";

export async function cleanupOrphanedObjects(env: Bindings): Promise<{ deleted: string[] }> {
  const liveRecords = await listAllFileRecords(env.FILES_KV);
  const liveKeys = new Set(liveRecords.map((r) => r.key));

  const config = b2ConfigFromEnv(env);
  const objectKeys = await listObjectKeys(config, "f/");

  const deleted: string[] = [];
  for (const key of objectKeys) {
    if (!liveKeys.has(key)) {
      await deleteObject(config, key);
      deleted.push(key);
    }
  }
  return { deleted };
}
```

- [ ] **Step 4: Run the cleanup test to verify it passes**

Run: `npx vitest run tests/lib/cleanup.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing test for the wired app**

Create `tests/index.test.ts`:

```typescript
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
```

- [ ] **Step 6: Run the index test to verify it fails**

Run: `npx vitest run tests/index.test.ts`
Expected: FAIL — the placeholder `src/index.ts` from Task 1 has no routing or `scheduled` handler.

- [ ] **Step 7: Replace `src/index.ts` with the full wiring**

```typescript
import { Hono } from "hono";
import type { Bindings } from "./types";
import { uploadRoute } from "./routes/upload";
import { downloadRoute } from "./routes/download";
import { adminRoute } from "./routes/admin";
import { cleanupOrphanedObjects } from "./lib/cleanup";

const app = new Hono<{ Bindings: Bindings }>();

app.use("/api/*", async (c, next) => {
  const origin = c.req.header("Origin");
  if (origin && origin !== new URL(c.req.url).origin) {
    return c.json({ error: "forbidden origin" }, 403);
  }
  await next();
});

app.route("/", uploadRoute);
app.route("/", downloadRoute);
app.route("/", adminRoute);

app.get("/admin", async (c) => {
  return c.env.ASSETS.fetch(new URL("/admin.html", c.req.url));
});

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledController, env: Bindings, ctx: ExecutionContext) {
    ctx.waitUntil(cleanupOrphanedObjects(env));
  },
};
```

- [ ] **Step 8: Run the index test to verify it passes**

Run: `npx vitest run tests/index.test.ts`
Expected: PASS.

- [ ] **Step 9: Run the full test suite so far**

Run: `npm test`
Expected: PASS — all suites from Tasks 2-8 green.

- [ ] **Step 10: Commit**

```bash
git add src/lib/cleanup.ts src/index.ts tests/lib/cleanup.test.ts tests/index.test.ts
git commit -m "feat: wire Hono app (CORS guard, routes, /admin, cron cleanup)"
```

---

### Task 9: Frontend — shared styles + upload page

**Files:**
- Create: `public/style.css`
- Create: `public/index.html`
- Create: `public/upload.js`
- Test: `tests/public/upload.test.ts`

**Interfaces:**
- Produces: `formatBytes(bytes: number): string` and `buildShareText(downloadUrl: string, password: string): string`, exported from `public/upload.js` for unit testing; the rest of `upload.js` wires the DOM and is verified manually (Step 6).

- [ ] **Step 1: Create `public/style.css`**

```css
:root {
  --bg: #f7f7f8;
  --surface: #ffffff;
  --text: #1a1a1a;
  --muted: #6b6b6b;
  --border: #dcdcdc;
  --accent: #2563eb;
  --accent-text: #ffffff;
  --danger: #b3261e;
  --success: #1a7f37;
}

@media (prefers-color-scheme: dark) {
  :root {
    --bg: #121212;
    --surface: #1c1c1e;
    --text: #f2f2f2;
    --muted: #a0a0a0;
    --border: #333333;
    --accent: #3b82f6;
    --accent-text: #0b0b0b;
    --danger: #ff6b6b;
    --success: #4ade80;
  }
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  padding: 0;
  background: var(--bg);
  color: var(--text);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
}

.page {
  max-width: 480px;
  margin: 0 auto;
  padding: 2rem 1.25rem;
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
}

h1 {
  font-size: 1.4rem;
  margin: 0;
}

.card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 1.25rem;
}

.dropzone {
  border: 2px dashed var(--border);
  border-radius: 12px;
  padding: 2.5rem 1rem;
  text-align: center;
  color: var(--muted);
  cursor: pointer;
  transition: border-color 0.15s ease, color 0.15s ease;
}

.dropzone.dragover {
  border-color: var(--accent);
  color: var(--accent);
}

label {
  display: block;
  font-size: 0.85rem;
  color: var(--muted);
  margin-bottom: 0.35rem;
}

input[type="number"],
input[type="password"],
input[type="text"] {
  width: 100%;
  padding: 0.6rem 0.7rem;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
  color: var(--text);
  font-size: 1rem;
}

.field {
  margin-bottom: 1rem;
}

button {
  width: 100%;
  padding: 0.75rem 1rem;
  border: none;
  border-radius: 8px;
  background: var(--accent);
  color: var(--accent-text);
  font-size: 1rem;
  font-weight: 600;
  cursor: pointer;
}

button.secondary {
  background: transparent;
  border: 1px solid var(--border);
  color: var(--text);
  margin-top: 0.5rem;
}

button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

progress {
  width: 100%;
  height: 10px;
  margin-top: 0.75rem;
}

.result-row {
  display: flex;
  gap: 0.5rem;
  align-items: center;
  margin-bottom: 0.75rem;
}

.result-row code {
  flex: 1;
  overflow-wrap: anywhere;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 0.5rem 0.6rem;
  font-size: 0.9rem;
}

.result-row button {
  width: auto;
  padding: 0.5rem 0.8rem;
}

.message {
  font-size: 0.9rem;
  min-height: 1.2em;
}

.message.error {
  color: var(--danger);
}

.message.success {
  color: var(--success);
}

[hidden] {
  display: none !important;
}
```

- [ ] **Step 2: Write the failing test for the pure helpers**

Create `tests/public/upload.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { formatBytes, buildShareText } from "../../public/upload.js";

describe("formatBytes", () => {
  it("formats bytes under 1024 as-is", () => {
    expect(formatBytes(500)).toBe("500 B");
  });

  it("formats kilobytes", () => {
    expect(formatBytes(2048)).toBe("2.0 KB");
  });

  it("formats megabytes", () => {
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
  });
});

describe("buildShareText", () => {
  it("combines the link and password into a pasteable message", () => {
    expect(buildShareText("https://varco.example.com/d/tok", "abc123")).toBe(
      "File: https://varco.example.com/d/tok\nPassword: abc123"
    );
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run tests/public/upload.test.ts`
Expected: FAIL — `public/upload.js` does not exist yet.

- [ ] **Step 4: Create `public/upload.js`**

```javascript
export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}

export function buildShareText(downloadUrl, password) {
  return `File: ${downloadUrl}\nPassword: ${password}`;
}

function initUploadPage() {
  const dropzone = document.getElementById("dropzone");
  const fileInput = document.getElementById("file-input");
  const expiresInput = document.getElementById("expires-input");
  const maxDownloadsInput = document.getElementById("max-downloads-input");
  const uploadButton = document.getElementById("upload-button");
  const progressBar = document.getElementById("progress-bar");
  const messageEl = document.getElementById("message");
  const resultPanel = document.getElementById("result-panel");
  const downloadUrlEl = document.getElementById("download-url");
  const passwordEl = document.getElementById("password");
  const copyLinkButton = document.getElementById("copy-link");
  const copyPasswordButton = document.getElementById("copy-password");
  const copyBothButton = document.getElementById("copy-both");

  const inviteToken = new URLSearchParams(window.location.search).get("invite");
  let selectedFile = null;

  function setMessage(text, kind) {
    messageEl.textContent = text;
    messageEl.className = kind ? `message ${kind}` : "message";
  }

  function selectFile(file) {
    selectedFile = file;
    dropzone.textContent = `${file.name} (${formatBytes(file.size)})`;
    uploadButton.disabled = false;
  }

  dropzone.addEventListener("click", () => fileInput.click());

  dropzone.addEventListener("dragover", (event) => {
    event.preventDefault();
    dropzone.classList.add("dragover");
  });

  dropzone.addEventListener("dragleave", () => {
    dropzone.classList.remove("dragover");
  });

  dropzone.addEventListener("drop", (event) => {
    event.preventDefault();
    dropzone.classList.remove("dragover");
    const file = event.dataTransfer?.files?.[0];
    if (file) selectFile(file);
  });

  fileInput.addEventListener("change", () => {
    const file = fileInput.files?.[0];
    if (file) selectFile(file);
  });

  async function copyToClipboard(text) {
    await navigator.clipboard.writeText(text);
  }

  copyLinkButton.addEventListener("click", () => copyToClipboard(downloadUrlEl.textContent ?? ""));
  copyPasswordButton.addEventListener("click", () => copyToClipboard(passwordEl.textContent ?? ""));
  copyBothButton.addEventListener("click", () =>
    copyToClipboard(buildShareText(downloadUrlEl.textContent ?? "", passwordEl.textContent ?? ""))
  );

  uploadButton.addEventListener("click", async () => {
    if (!selectedFile) return;
    uploadButton.disabled = true;
    setMessage("Preparazione upload...", "");
    progressBar.hidden = false;
    progressBar.value = 0;

    const expiresInDays = Number(expiresInput.value || "7");
    const maxDownloadsRaw = maxDownloadsInput.value.trim();
    const payload = {
      filename: selectedFile.name,
      size: selectedFile.size,
      expiresInDays,
      ...(maxDownloadsRaw ? { maxDownloads: Number(maxDownloadsRaw) } : {}),
    };

    try {
      const query = inviteToken ? `?invite=${encodeURIComponent(inviteToken)}` : "";
      const prepareResponse = await fetch(`/api/upload${query}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!prepareResponse.ok) {
        throw new Error("Impossibile preparare l'upload");
      }

      const { uploadUrl, downloadUrl, password } = await prepareResponse.json();

      await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("PUT", uploadUrl);
        xhr.upload.onprogress = (event) => {
          if (event.lengthComputable) {
            progressBar.value = (event.loaded / event.total) * 100;
          }
        };
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) resolve(undefined);
          else reject(new Error(`Upload fallito (${xhr.status})`));
        };
        xhr.onerror = () => reject(new Error("Upload fallito"));
        xhr.send(selectedFile);
      });

      downloadUrlEl.textContent = `${window.location.origin}${downloadUrl}`;
      passwordEl.textContent = password;
      resultPanel.hidden = false;
      setMessage("Upload completato.", "success");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Errore imprevisto", "error");
    } finally {
      uploadButton.disabled = false;
      progressBar.hidden = true;
    }
  });
}

if (typeof document !== "undefined") {
  document.addEventListener("DOMContentLoaded", initUploadPage);
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/public/upload.test.ts`
Expected: PASS. (The `typeof document !== "undefined"` guard means importing this module under vitest's Node environment only exercises the two exported pure functions — it never touches the DOM.)

- [ ] **Step 6: Create `public/index.html`**

```html
<!doctype html>
<html lang="it">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Varco</title>
    <link rel="stylesheet" href="/style.css" />
  </head>
  <body>
    <div class="page">
      <h1>Varco</h1>
      <div class="card">
        <div id="dropzone" class="dropzone">Trascina un file qui, o clicca per selezionarlo</div>
        <input type="file" id="file-input" hidden />

        <div class="field" style="margin-top: 1rem">
          <label for="expires-input">Scadenza (giorni)</label>
          <input type="number" id="expires-input" value="7" min="1" />
        </div>

        <div class="field">
          <label for="max-downloads-input">Numero massimo di download (opzionale)</label>
          <input type="number" id="max-downloads-input" min="1" placeholder="illimitati" />
        </div>

        <button id="upload-button" disabled>Carica</button>
        <progress id="progress-bar" value="0" max="100" hidden></progress>
        <p id="message" class="message"></p>
      </div>

      <div id="result-panel" class="card" hidden>
        <div class="result-row">
          <code id="download-url"></code>
          <button id="copy-link" class="secondary">Copia link</button>
        </div>
        <div class="result-row">
          <code id="password"></code>
          <button id="copy-password" class="secondary">Copia password</button>
        </div>
        <button id="copy-both">Copia entrambi</button>
      </div>
    </div>
    <script type="module" src="/upload.js"></script>
  </body>
</html>
```

- [ ] **Step 7: Manual verification (requires Task 12's `wrangler dev` setup with real or dummy B2 vars)**

Run: `npm run dev`, open `http://localhost:8787/`.
Verify: dropzone accepts a click and a drag-and-drop file; the expiry field defaults to 7; the upload button stays disabled until a file is chosen. Full end-to-end upload verification (through to B2) happens in Task 13 once real credentials are configured.

- [ ] **Step 8: Commit**

```bash
git add public/style.css public/index.html public/upload.js tests/public/upload.test.ts
git commit -m "feat: add upload page (drag & drop, progress bar, copy-to-clipboard)"
```

---

### Task 10: Frontend — download page

**Files:**
- Create: `public/download.html`
- Create: `public/download.js`
- Test: `tests/public/download.test.ts`

**Interfaces:**
- Produces: `extractFilename(contentDisposition: string | null): string`, exported from `public/download.js` for unit testing.

- [ ] **Step 1: Write the failing test**

Create `tests/public/download.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { extractFilename } from "../../public/download.js";

describe("extractFilename", () => {
  it("extracts the filename from a Content-Disposition header", () => {
    expect(extractFilename('attachment; filename="report.pdf"')).toBe("report.pdf");
  });

  it("falls back to a default name when the header is missing", () => {
    expect(extractFilename(null)).toBe("download");
  });

  it("falls back to a default name when no filename is present", () => {
    expect(extractFilename("attachment")).toBe("download");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/public/download.test.ts`
Expected: FAIL — `public/download.js` does not exist yet.

- [ ] **Step 3: Create `public/download.js`**

```javascript
export function extractFilename(contentDisposition) {
  if (!contentDisposition) return "download";
  const match = contentDisposition.match(/filename="([^"]*)"/);
  return match ? match[1] : "download";
}

function initDownloadPage() {
  const form = document.getElementById("download-form");
  const passwordInput = document.getElementById("password-input");
  const submitButton = document.getElementById("submit-button");
  const messageEl = document.getElementById("message");

  function setMessage(text, kind) {
    messageEl.textContent = text;
    messageEl.className = kind ? `message ${kind}` : "message";
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    submitButton.disabled = true;
    setMessage("Verifica in corso...", "");

    try {
      const response = await fetch(window.location.pathname, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: passwordInput.value }),
      });

      if (response.status === 429) {
        setMessage("Troppi tentativi. Riprova più tardi.", "error");
        return;
      }
      if (response.status === 410) {
        setMessage("Questo link non è più disponibile.", "error");
        return;
      }
      if (!response.ok) {
        setMessage("Password errata o link non valido.", "error");
        return;
      }

      const blob = await response.blob();
      const filename = extractFilename(response.headers.get("Content-Disposition"));
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(objectUrl);

      setMessage("Download avviato.", "success");
    } catch (error) {
      setMessage("Errore di rete. Riprova.", "error");
    } finally {
      submitButton.disabled = false;
    }
  });
}

if (typeof document !== "undefined") {
  document.addEventListener("DOMContentLoaded", initDownloadPage);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/public/download.test.ts`
Expected: PASS.

- [ ] **Step 5: Create `public/download.html`**

```html
<!doctype html>
<html lang="it">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Varco — Scarica file</title>
    <link rel="stylesheet" href="/style.css" />
  </head>
  <body>
    <div class="page">
      <h1>Scarica file</h1>
      <div class="card">
        <form id="download-form">
          <div class="field">
            <label for="password-input">Password</label>
            <input type="password" id="password-input" required autofocus />
          </div>
          <button id="submit-button" type="submit">Scarica</button>
        </form>
        <p id="message" class="message"></p>
      </div>
    </div>
    <script type="module" src="/download.js"></script>
  </body>
</html>
```

- [ ] **Step 6: Manual verification**

Run: `npm run dev`, open `http://localhost:8787/d/anything`.
Verify: the page shows only a password field and a "Scarica" button, with no file information visible, regardless of whether the token is real.

- [ ] **Step 7: Commit**

```bash
git add public/download.html public/download.js tests/public/download.test.ts
git commit -m "feat: add download page (password form, blob-based native download, generic errors)"
```

---

### Task 11: Frontend — admin page

**Files:**
- Create: `public/admin.html`
- Create: `public/admin.js`

**Interfaces:**
- Consumes: `POST /api/invite` response shape `{ inviteUrl: string }` (Task 7).
- Produces: nothing consumed by later tasks (this is the last frontend page).

- [ ] **Step 1: Create `public/admin.js`**

```javascript
function initAdminPage() {
  const form = document.getElementById("invite-form");
  const labelInput = document.getElementById("label-input");
  const maxFilesInput = document.getElementById("max-files-input");
  const ttlInput = document.getElementById("ttl-input");
  const submitButton = document.getElementById("submit-button");
  const messageEl = document.getElementById("message");
  const resultPanel = document.getElementById("result-panel");
  const inviteUrlEl = document.getElementById("invite-url");
  const copyButton = document.getElementById("copy-url");

  function setMessage(text, kind) {
    messageEl.textContent = text;
    messageEl.className = kind ? `message ${kind}` : "message";
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    submitButton.disabled = true;
    setMessage("Creazione invito...", "");

    try {
      const response = await fetch("/api/invite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          label: labelInput.value,
          maxFiles: Number(maxFilesInput.value),
          ttlHours: Number(ttlInput.value),
        }),
      });

      if (!response.ok) {
        throw new Error("Impossibile creare l'invito");
      }

      const { inviteUrl } = await response.json();
      inviteUrlEl.textContent = `${window.location.origin}${inviteUrl}`;
      resultPanel.hidden = false;
      setMessage("Invito creato.", "success");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Errore imprevisto", "error");
    } finally {
      submitButton.disabled = false;
    }
  });

  copyButton.addEventListener("click", () => {
    navigator.clipboard.writeText(inviteUrlEl.textContent ?? "");
  });
}

if (typeof document !== "undefined") {
  document.addEventListener("DOMContentLoaded", initAdminPage);
}
```

- [ ] **Step 2: Create `public/admin.html`**

```html
<!doctype html>
<html lang="it">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Varco — Admin</title>
    <link rel="stylesheet" href="/style.css" />
  </head>
  <body>
    <div class="page">
      <h1>Genera invito</h1>
      <div class="card">
        <form id="invite-form">
          <div class="field">
            <label for="label-input">Etichetta</label>
            <input type="text" id="label-input" required placeholder="es. Mario" />
          </div>
          <div class="field">
            <label for="max-files-input">Numero massimo di file</label>
            <input type="number" id="max-files-input" min="1" value="1" required />
          </div>
          <div class="field">
            <label for="ttl-input">Validità (ore)</label>
            <input type="number" id="ttl-input" min="1" value="48" required />
          </div>
          <button id="submit-button" type="submit">Genera invito</button>
        </form>
        <p id="message" class="message"></p>
      </div>

      <div id="result-panel" class="card" hidden>
        <div class="result-row">
          <code id="invite-url"></code>
          <button id="copy-url" class="secondary">Copia</button>
        </div>
      </div>
    </div>
    <script type="module" src="/admin.js"></script>
  </body>
</html>
```

- [ ] **Step 3: Manual verification**

Run: `npm run dev`, open `http://localhost:8787/admin` with a request header `Cf-Access-Authenticated-User-Email: you@example.com` (simulate via a browser extension or `curl` during local dev, since Cloudflare Access itself only runs in the deployed environment — see Task 12 README for the real setup). Verify: submitting the form shows a copyable link in the form `/?invite=<token>`.

- [ ] **Step 4: Commit**

```bash
git add public/admin.html public/admin.js
git commit -m "feat: add admin page for generating upload invites"
```

---

### Task 12: `README.md`

**Files:**
- Create: `README.md`

**Interfaces:**
- Consumes: nothing (documentation only).

- [ ] **Step 1: Write `README.md`**

```markdown
# Varco

Servizio privato di file transfer, self-hosted su un singolo Cloudflare Worker e Backblaze B2. Upload via presigned PUT direttamente su B2 (il file non passa mai dal Worker), download in streaming pass-through (mai un redirect, mai un buffer in memoria).

## Come partire

Tre percorsi, dal più automatico al più manuale. In tutti e tre restano comunque fuori: creare bucket e Application Key su B2 (punti 1-2 sotto — provider diverso da Cloudflare, nessun ponte automatico) e configurare Cloudflare Access (punto 6 — dashboard Zero Trust, non esposto né da wrangler né dal bottone di deploy).

### Opzione A — Deploy in un click, zero clone locale

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/<TUO-USER>/<TUO-REPO>)

*(Sostituisci `<TUO-USER>/<TUO-REPO>` con il percorso reale della tua repo GitHub una volta pubblicata.)*

Cliccando il bottone:
1. Cloudflare ti chiede di autenticarti (o creare un account) e di **collegare/forkare questa repo** nel tuo account GitHub — è così che Cloudflare Workers Builds si aggancia per i deploy automatici sui push futuri.
2. Ti mostra i valori non sensibili già presenti in `wrangler.toml` sotto `[vars]` (`B2_BUCKET`, `B2_ENDPOINT`, `B2_REGION`) come campi modificabili prima del deploy — compilali con i valori del tuo bucket B2 (punto 1 sotto).
3. Dovrebbe proporti la creazione del KV namespace dichiarato in `[[kv_namespaces]]` come parte del flusso guidato. Se non lo fa, crealo tu (`npx wrangler kv namespace create FILES_KV` da locale, oppure via `./setup.sh`, oppure a mano dal dashboard) e incolla l'id in `wrangler.toml` prima di rilanciare il deploy.
4. Esegue il deploy.

**Dopo il deploy**, aggiungi i due valori sensibili — impossibile farlo dentro il flusso del bottone, perché i secret non vivono mai in `wrangler.toml`: vai su dashboard Cloudflare → Workers & Pages → il tuo worker → **Settings → Variables and Secrets → Add variable**, tipo **Encrypted**, per `B2_KEY_ID` e `B2_APP_KEY`. Poi configura Cloudflare Access (punto 6). Zero terminale in tutto questo percorso.

### Opzione B — `setup.sh`, bootstrap locale guidato

Dopo aver creato bucket e Application Key B2 (punti 1-2, non automatizzabili da qui), clona la repo ed esegui `./setup.sh` — installa/verifica wrangler, gestisce il login Cloudflare, crea il KV namespace, chiede i valori B2 e scrive `wrangler.toml`/`.dev.vars`, e offre di impostare i secret e fare il deploy. Copre i punti 3-5 e 7 qui sotto. Restano manuali solo i punti 1, 2 e 6.

### Opzione C — passo-passo manuale

La sezione seguente descrive ogni passo a mano, per chi preferisce non usare né il bottone né lo script, o deve capire cosa fanno.

### 1. Bucket Backblaze B2

1. Nel [pannello B2](https://secure.backblaze.com/b2_buckets.htm), crea un bucket **privato** (`allPrivate`).
2. Nelle impostazioni del bucket, attiva **Default Encryption → SSE-B2**.
3. Aggiungi una **Lifecycle Rule** come rete di sicurezza (il cron del Worker cancella già gli oggetti orfani, questa regola è un backstop):
   - "Keep only the last version of the file" con **"days after uploading"** impostato a qualche giorno oltre alla scadenza massima che offri (es. se offri fino a 30 giorni di scadenza, imposta la lifecycle rule a 35-40 giorni), così un oggetto che sfugge al cron viene comunque rimosso da B2 stessa.
4. Annota l'**endpoint S3** del bucket (es. `https://s3.us-west-004.backblazeb2.com`) e la **region** (es. `us-west-004`) — visibili nella pagina dei dettagli del bucket.

### 2. Application Key B2 (S3-compatible)

1. Vai su **App Keys** nel pannello B2.
2. Crea una nuova Application Key limitata al **singolo bucket** di Varco, con permessi di lettura/scrittura/eliminazione sugli oggetti. **Non usare la master key.**
3. Annota `keyID` e `applicationKey`: sono rispettivamente `B2_KEY_ID` e `B2_APP_KEY`.

### 3. KV Namespace

```bash
npx wrangler kv namespace create FILES_KV
```

Copia l'`id` restituito in `wrangler.toml`, sotto `[[kv_namespaces]]`.

### 4. Variabili locali

```bash
cp .dev.vars.example .dev.vars
```

Compila `.dev.vars` con i valori di B2 (chiave, bucket, endpoint, region). Questo file è in `.gitignore` e non va mai committato.

### 5. Secrets in produzione

`B2_BUCKET`, `B2_ENDPOINT`, `B2_REGION` sono già in `wrangler.toml` sotto `[vars]` (non sensibili). `B2_KEY_ID` e `B2_APP_KEY` sono segreti e vanno impostati con:

```bash
npx wrangler secret put B2_KEY_ID
npx wrangler secret put B2_APP_KEY
```

### 6. Cloudflare Access (Zero Trust)

Nel dashboard Cloudflare Zero Trust → Access → Applications, crea due applicazioni **self-hosted** puntate al dominio del Worker:

- **Applicazione 1** — path `/admin*`. Policy: solo il tuo account (email o gruppo). Protegge la pagina di generazione inviti.
- **Applicazione 2** — path `/api/invite`. Stessa policy della precedente (Access valuta i path indipendentemente dagli asset statici: assicurati che la policy copra sia `/admin` sia `/admin.html`, dato che quest'ultimo è servito come asset statico).

Per gli **utenti fissi** che possono caricare file (`/api/upload` senza invito), crea una terza applicazione Access sul path `/api/upload` con una policy che include la whitelist di email fidate. Cloudflare Access inietta l'header `Cf-Access-Authenticated-User-Email` dopo un login riuscito: il Worker si fida della sua sola presenza, l'autenticazione vera è già avvenuta a monte.

Non serve proteggere `/`, `/d/:token`, `/download.html` — sono pubblici per design (l'autenticazione lì è la password per-file).

### 7. Deploy

```bash
npm install
npm run deploy
```

## Sviluppo locale

```bash
npm run dev
```

Nota: Cloudflare Access non è simulabile localmente in modo nativo — durante lo sviluppo locale l'header `Cf-Access-Authenticated-User-Email` va impostato manualmente (es. con un'estensione browser o `curl -H`) per testare i percorsi da "utente fisso".

## Test

```bash
npm test
```

## Come funziona (in breve)

- **Upload**: il Worker genera un URL S3 v4 presigned per una singola `PUT` su B2 (fino a 5GB, niente multipart) e lo restituisce al browser, che carica il file direttamente su B2 via `XMLHttpRequest`.
- **Download**: il Worker fa `fetch()` verso B2 e inoltra `response.body` come stream al client, senza mai bufferizzare l'intero file in memoria.
- **Password**: generate dal Worker (12 caratteri, alfabeto ad alta entropia), mai scelte dall'utente. Salvate solo come `SHA-256(salt + password)` — un singolo hash veloce è sufficiente perché l'entropia della password (~64 bit) rende il brute force infeasibile a prescindere, ed evita di sforare il budget di CPU del piano free.
- **Pulizia**: KV elimina da sé i metadata scaduti (TTL nativo); un cron giornaliero confronta gli oggetti su B2 con i record KV ancora vivi e cancella quelli orfani. La lifecycle rule di B2 (punto 1) è il backstop nel caso il cron fallisca.

## Budget CPU

Ogni handler è pensato per restare ben sotto i 10ms di CPU del piano Workers Free: nessuna libreria pesante, nessun parsing di payload grandi, hash singolo SHA-256 invece di funzioni lente come bcrypt/PBKDF2/scrypt.
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: add setup and architecture README"
```

---

### Task 13: `setup.sh` — self-configuring bootstrap script

**Files:**
- Create: `setup.sh`

**Interfaces:**
- Consumes: the exact placeholder strings Task 1 wrote into `wrangler.toml` (`REPLACE_WITH_KV_NAMESPACE_ID`, `REPLACE_WITH_BUCKET_NAME`, `https://REPLACE_WITH_YOUR_ENDPOINT`, `REPLACE_WITH_REGION`) and the five-variable shape of `.dev.vars.example` (Task 1); the README's numbered setup sections (Task 12) for the messages it prints about what remains manual.
- Produces: an idempotent, interactive shell script the user runs themselves (`./setup.sh`) — never run it yourself, it drives an interactive Cloudflare browser login and prompts for the user's own B2 credentials.

This script is a convenience wrapper around steps already documented in the README (Task 12): it installs/verifies `wrangler` via the existing `npm install`, drives `wrangler login`, creates the `FILES_KV` KV namespace and patches its id into `wrangler.toml`, prompts for B2 connection details and writes them into `wrangler.toml`'s `[vars]` and into `.dev.vars`, optionally pushes the two B2 secrets to Cloudflare, and optionally runs `wrangler deploy`. It does **not** attempt to create the B2 bucket/Application Key (README steps 1-2) or configure Cloudflare Access (README step 6) — those stay manual and the script says so at the end.

- [ ] **Step 1: Create `setup.sh`**

```bash
#!/usr/bin/env bash
# Varco — self-configuring setup script.
# Bootstraps Cloudflare resources (KV namespace, secrets, deploy) and
# collects Backblaze B2 connection details. Safe to re-run (idempotent):
# it skips steps that are already done (existing KV id, existing login).
#
# What this script does NOT do (must be done by hand first / separately):
#   - create the B2 bucket or its Application Key (README, step 1-2)
#   - configure Cloudflare Access on /admin, /api/invite, /api/upload (README, step 6)
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

info() { printf '\n\033[1;34m==>\033[0m %s\n' "$1"; }
warn() { printf '\033[1;33mATTENZIONE:\033[0m %s\n' "$1"; }
ok()   { printf '\033[1;32m✓\033[0m %s\n' "$1"; }

if ! command -v npm >/dev/null 2>&1; then
  echo "npm non trovato. Installa Node.js (https://nodejs.org) e rilancia questo script." >&2
  exit 1
fi

info "Installazione dipendenze npm (include la CLI wrangler)..."
npm install
ok "Dipendenze installate."

WRANGLER="npx wrangler"

info "Verifica login Cloudflare..."
if $WRANGLER whoami >/dev/null 2>&1; then
  ok "Già autenticato su Cloudflare."
else
  info "Apro il login Cloudflare nel browser..."
  $WRANGLER login
  ok "Login completato."
fi

if grep -q 'REPLACE_WITH_KV_NAMESPACE_ID' wrangler.toml; then
  info "Creazione KV namespace FILES_KV..."
  KV_OUTPUT=$($WRANGLER kv namespace create FILES_KV)
  echo "$KV_OUTPUT"
  KV_ID=$(echo "$KV_OUTPUT" | grep -oE '[0-9a-f]{32}' | head -n1 || true)
  if [ -z "$KV_ID" ]; then
    warn "Impossibile estrarre automaticamente l'id del namespace. Copialo manualmente dall'output sopra dentro wrangler.toml (sotto [[kv_namespaces]])."
  else
    sed -i.bak "s/REPLACE_WITH_KV_NAMESPACE_ID/${KV_ID}/" wrangler.toml && rm -f wrangler.toml.bak
    ok "wrangler.toml aggiornato con l'id del KV namespace."
  fi
else
  ok "KV namespace già configurato in wrangler.toml."
fi

info "Configurazione Backblaze B2"
echo "Se non hai ancora creato bucket e Application Key su B2, segui prima i passi 1-2 del README."
read -rp "B2 bucket name: " B2_BUCKET_VAL
read -rp "B2 endpoint (es. https://s3.us-west-004.backblazeb2.com): " B2_ENDPOINT_VAL
read -rp "B2 region (es. us-west-004): " B2_REGION_VAL
read -rp "B2 Application Key ID: " B2_KEY_ID_VAL
read -rsp "B2 Application Key (input nascosto): " B2_APP_KEY_VAL
echo

sed -i.bak \
  -e "s#REPLACE_WITH_BUCKET_NAME#${B2_BUCKET_VAL}#" \
  -e "s#https://REPLACE_WITH_YOUR_ENDPOINT#${B2_ENDPOINT_VAL}#" \
  -e "s#REPLACE_WITH_REGION#${B2_REGION_VAL}#" \
  wrangler.toml && rm -f wrangler.toml.bak
ok "wrangler.toml aggiornato con i valori B2 non sensibili."

cat > .dev.vars <<EOF
B2_KEY_ID=${B2_KEY_ID_VAL}
B2_APP_KEY=${B2_APP_KEY_VAL}
B2_BUCKET=${B2_BUCKET_VAL}
B2_ENDPOINT=${B2_ENDPOINT_VAL}
B2_REGION=${B2_REGION_VAL}
EOF
ok ".dev.vars scritto per lo sviluppo locale (è già in .gitignore)."

read -rp "Impostare B2_KEY_ID e B2_APP_KEY come secret su Cloudflare per il deploy? [y/N] " PUSH_SECRETS
if [[ "$PUSH_SECRETS" =~ ^[Yy]$ ]]; then
  printf '%s' "$B2_KEY_ID_VAL" | $WRANGLER secret put B2_KEY_ID
  printf '%s' "$B2_APP_KEY_VAL" | $WRANGLER secret put B2_APP_KEY
  ok "Secret impostati su Cloudflare."
else
  warn "Ricorda di impostarli prima del deploy con: npx wrangler secret put B2_KEY_ID  (e B2_APP_KEY)"
fi

read -rp "Eseguire 'wrangler deploy' ora? [y/N] " DO_DEPLOY
if [[ "$DO_DEPLOY" =~ ^[Yy]$ ]]; then
  $WRANGLER deploy
else
  ok "Setup completato. Esegui 'npm run deploy' quando sei pronto."
fi

info "Passi manuali rimanenti (non automatizzabili da qui):"
echo "  - Cloudflare Access (Zero Trust) su /admin, /api/invite, /api/upload — vedi README punto 6."
echo "  - SSE-B2 e lifecycle rule sul bucket B2, se non ancora fatto — vedi README punto 1."
```

- [ ] **Step 2: Make it executable**

Run: `chmod +x setup.sh`
Expected: exits 0; `ls -l setup.sh` shows the executable bit set.

- [ ] **Step 3: Syntax-check the script**

Run: `bash -n setup.sh`
Expected: exits 0 with no output (pure shell syntax validation — this does not run the script, which would otherwise require a real Cloudflare login and real B2 credentials).

- [ ] **Step 4: Commit**

```bash
git add setup.sh
git commit -m "feat: add self-configuring setup script for Cloudflare and B2"
```

---

### Task 14: Final integration check

**Files:**
- None created — this task only runs verification commands across the whole project.

**Interfaces:**
- Consumes: everything from Tasks 1-13.

- [ ] **Step 1: Typecheck the whole project**

Run: `npm run typecheck`
Expected: exits 0, no errors across `src/`, `public/`, `tests/`.

- [ ] **Step 2: Run the full test suite**

Run: `npm test`
Expected: every suite from Tasks 2-10 passes (crypto, kv, b2, upload route, download route, admin route, cleanup, index routing, upload/download frontend helpers).

- [ ] **Step 3: Dry-run the Worker bundle**

Run: `npx wrangler deploy --dry-run --outdir=/tmp/varco-dryrun`
Expected: exits 0 — confirms `src/index.ts` bundles cleanly with its `assets` and `kv_namespaces` bindings and the cron trigger, without actually deploying.

- [ ] **Step 4: Manual smoke test against real B2 credentials**

This step needs real Backblaze B2 credentials (README, steps 1-2 — create the bucket and Application Key by hand) in `.dev.vars` and a real KV namespace id in `wrangler.toml`. Run `./setup.sh` (Task 13) to fill both in interactively, or do it by hand per the README. Either way, this cannot be automated in CI.

Run: `npm run dev`, then in the browser at `http://localhost:8787/`:
1. Upload a small test file as a "fixed user" (set `Cf-Access-Authenticated-User-Email` manually per the README's local-dev note).
2. Copy the resulting download link and password.
3. Open the download link in a private/incognito window, enter the password, confirm the file downloads correctly and matches the original (e.g. compare checksums).
4. Retry the download with a wrong password 5 times, confirm the 6th attempt (even with the correct password) returns a temporary-lockout error.
5. In the B2 dashboard, confirm the object exists under `f/{year}/{month}/{fileId}/{filename}`.
6. Generate an invite from `/admin`, open the resulting `/?invite=...` link in a fresh browser profile (no Access session), confirm the upload flow works identically to the fixed-user flow.

- [ ] **Step 5: Confirm no secrets are logged**

While running the manual smoke test, check the `wrangler dev` terminal output.
Expected: no password, token, or B2 credential ever appears in the console output.

This task has no commit step — it is a verification pass over work already committed in Tasks 1-12.
