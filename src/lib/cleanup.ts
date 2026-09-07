import type { Bindings } from "../types";
import { listAllFileRecords } from "./kv";
import { listObjects, deleteObject, b2ConfigFromEnv } from "./b2";

// KV list() is eventually consistent (Cloudflare documents up to ~60s of
// lag), so an object uploaded moments before the sweep runs may not yet be
// visible in listAllFileRecords even though it's already live in B2.
// Anything younger than this is left alone; a still-genuine orphan will be
// caught by tomorrow's run.
const MIN_ORPHAN_AGE_MS = 60 * 60 * 1000; // 1 hour

export async function cleanupOrphanedObjects(env: Bindings): Promise<{ deleted: string[] }> {
  const liveRecords = await listAllFileRecords(env.FILES_KV);
  const liveKeys = new Set(liveRecords.map((r) => r.key));

  const config = b2ConfigFromEnv(env);
  const objects = await listObjects(config, "f/");

  // Sanity valve: zero live KV records while B2 genuinely holds objects is
  // far more likely a misconfigured/misbound FILES_KV (e.g. a deploy config
  // mistake) than an account that's truly empty of live files yet somehow
  // has B2 objects. Don't interpret that as "everything is orphaned" and
  // wipe the bucket — skip deletion for this run entirely. A brand-new,
  // never-used deploy (zero records AND zero objects) does not trip this,
  // since there's nothing to potentially delete either way.
  if (liveRecords.length === 0 && objects.length > 0) {
    console.warn(
      `cleanupOrphanedObjects: FILES_KV has 0 live records but B2 lists ${objects.length} object(s) under "f/" — skipping deletion this run as a likely misconfiguration.`
    );
    return { deleted: [] };
  }

  const now = Date.now();
  const deleted: string[] = [];
  for (const { key, lastModified } of objects) {
    if (liveKeys.has(key)) continue;
    if (now - lastModified.getTime() < MIN_ORPHAN_AGE_MS) continue;
    await deleteObject(config, key);
    deleted.push(key);
  }
  return { deleted };
}
