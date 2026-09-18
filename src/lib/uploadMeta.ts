export interface UploadRequestBody {
  filename: string;
  size: number;
  expiresInDays: number;
  maxDownloads?: number;
}

// Rejects path separators and control characters so a filename can never be
// used to escape the `f/` prefix of the B2 object key (which would make the
// object invisible to the cron cleanup's `prefix: "f/"` listing). Also
// rejects empty or whitespace-only names. `#`/`?`, which could otherwise
// truncate/reinterpret the key when it's turned into a request URL, are
// handled at that point: b2.ts's objectUrl() percent-encodes each path
// segment before constructing the URL. The key stored here (and in KV) is
// always the raw, unencoded filename so it matches what B2's ListObjectsV2
// reports (raw UTF-8 keys), which is what the cron cleanup compares against.
const UNSAFE_FILENAME_CHARS = /[/\\\x00-\x1f]/;

// A filename of exactly "." or ".." is otherwise indistinguishable from a
// normal filename to UNSAFE_FILENAME_CHARS, but the WHATWG URL constructor
// applies dot-segment path normalization when objectUrl() builds the
// request URL: a trailing "/." segment collapses away, and a trailing "/.."
// segment resolves UP a level to the shared f/<year>/<month>/ prefix — the
// same prefix every other upload from that month lands under, regardless of
// fileId. That lets two uploads named ".." collide (the second overwrites
// the first in B2), and either case also breaks the record.key <->
// listObjects() match the cron cleanup relies on. Reject both outright.
const RESERVED_DOT_SEGMENTS = new Set([".", ".."]);

export function isValidFilename(filename: string): boolean {
  return (
    filename.trim().length > 0 &&
    !UNSAFE_FILENAME_CHARS.test(filename) &&
    !RESERVED_DOT_SEGMENTS.has(filename)
  );
}

export function isValidUploadBody(body: unknown): body is UploadRequestBody {
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

export function objectKey(fileId: string, filename: string): string {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  // The key stores the raw filename (not percent-encoded). isValidFilename
  // already rejects `/`, `\`, and control characters, so the filename can't
  // escape the `f/` prefix. Encoding for the wire happens in b2.ts's
  // objectUrl(), not here — keeping record.key raw is what lets the cron
  // cleanup's key comparison against B2's ListObjectsV2 output (which
  // reports raw, undecoded keys) actually match.
  return `f/${year}/${month}/${fileId}/${filename}`;
}
