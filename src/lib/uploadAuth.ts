import type { Context } from "hono";
import type { Bindings } from "../types";
import { getInviteRecord, type InviteRecord } from "./kv";

export type UploadAuth =
  | { kind: "owner"; email: string }
  | { kind: "invite"; token: string; invite: InviteRecord };

// Trusts Cf-Access-Authenticated-User-Email on presence: it's injected by
// Cloudflare Access only on routes protected by an Allow policy, which is
// the only policy type that actually attaches the header (Bypass policies
// do not, even with a valid session on a sibling Application — see
// src/routes/upload.ts). Falls back to the invite token for guest paths,
// which are kept outside Access entirely.
export async function resolveUploadAuth(
  c: Context<{ Bindings: Bindings }>
): Promise<UploadAuth | null> {
  const uploaderEmail = c.req.header("Cf-Access-Authenticated-User-Email");
  if (uploaderEmail) return { kind: "owner", email: uploaderEmail };

  const inviteToken = c.req.query("invite");
  if (!inviteToken) return null;
  const invite = await getInviteRecord(c.env.FILES_KV, inviteToken);
  if (!invite || invite.remainingFiles <= 0) return null;
  return { kind: "invite", token: inviteToken, invite };
}
