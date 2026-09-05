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
  return c.env.ASSETS.fetch(new Request(new URL("/admin.html", c.req.url)));
});

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledController, env: Bindings, ctx: ExecutionContext) {
    ctx.waitUntil(cleanupOrphanedObjects(env));
  },
};
