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
