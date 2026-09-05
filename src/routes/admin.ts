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
