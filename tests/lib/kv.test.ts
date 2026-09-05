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
