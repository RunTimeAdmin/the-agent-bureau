import "dotenv/config";
import express from "express";
import { createServer } from "http";
import path from "node:path";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { MAX_TRPC_BATCH } from "@shared/transformer";
import { createAgentApi } from "../agentApi";
import { BUREAU_FILE_KEYS } from "../bureauFileKeys";
import { pingDb, runMigrations, schemaReady } from "../db";
import { jobStatus, startSchedules } from "../schedules";
import { parsePublicKey } from "../outcomeProof";
import { appRouter } from "../routers";
import { createContext } from "./context";
import { ENV } from "./env";
import { serveStatic, setupVite } from "./vite";

// Prod only: a content security policy tight enough to stop injected or
// framed content, but allowing the same-origin bundle, inline style attributes
// (Radix, Framer Motion) and the Google Fonts stylesheet the app loads.
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data:",
  "connect-src 'self'",
].join("; ");

function securityHeaders(): express.RequestHandler {
  return (_req, res, next) => {
    res.set({
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "strict-origin-when-cross-origin",
      "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    });
    // CSP and HSTS only in production: a strict CSP would break Vite's dev
    // server, and HSTS is meaningless over local http.
    if (ENV.isProduction) {
      res.set({
        "Content-Security-Policy": CONTENT_SECURITY_POLICY,
        "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
      });
    }
    next();
  };
}

async function startServer() {
  const app = express();
  const server = createServer(app);
  // Don't advertise the framework.
  app.disable("x-powered-by");
  app.use(securityHeaders());
  // Hosts such as Hostinger put the app behind a reverse proxy. Take the client
  // address from X-Forwarded-For only when the proxy is on a loopback or
  // private address, so visitors cannot spoof it from the internet.
  app.set("trust proxy", "loopback, linklocal, uniquelocal");
  // Agent mode parses its own JSON so bad bodies get JSON errors, not HTML.
  app.use("/api/agent/v1", createAgentApi());
  // The largest request is a 4,000-character inquiry; there are no uploads.
  app.use(express.json({ limit: "100kb" }));
  app.use(express.urlencoded({ limit: "100kb", extended: true }));
  // Liveness: the process is up. Stays ok even without a database, because the
  // public pages are still served then.
  app.get("/api/health", (_req, res) => res.json({ status: "ok" }));
  // The keys agents' files are signed with (docs/agent-file.md), so a
  // subscriber can check a file without trusting the file itself. Only keys
  // that parse are served, and any page may read them.
  const fileKeys = Object.entries(BUREAU_FILE_KEYS)
    .filter(([, publicKey]) => {
      try {
        parsePublicKey(publicKey);
        return true;
      } catch {
        return false;
      }
    })
    .map(([key_id, public_key]) => ({ key_id, public_key }));
  app.get("/.well-known/agent-bureau-file-keys.json", (_req, res) => {
    res.set({
      "Cache-Control": "public, max-age=300",
      "Access-Control-Allow-Origin": "*",
    });
    res.json({ keys: fileKeys });
  });
  // Readiness: the database answers and the Bureau schema is present. Use this,
  // not /api/health, to gate traffic that needs the database (games, inquiries,
  // the inbox). A boot migration failure leaves the server answering but the
  // tables missing, so checking the schema, not just connectivity, is what
  // keeps that case out of rotation.
  app.get("/api/ready", async (_req, res) => {
    const db = await pingDb();
    const schema = db ? await schemaReady() : false;
    const ready = db && schema;
    res
      .status(ready ? 200 : 503)
      .json({ status: ready ? "ready" : "degraded", checks: { db, schema } });
  });
  // How the commands the server runs on a timer last ended (server/schedules.ts):
  // "ok", or "attention" with the problem, for the monitor that watches /api/ready.
  app.get("/api/jobs", (_req, res) => {
    res.set("Cache-Control", "no-store");
    res.json(jobStatus(process.env.NODE_ENV === "production" && Boolean(ENV.databaseUrl)));
  });
  // tRPC API
  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext,
      // Cap batched calls so one request cannot fan out into many queries.
      maxBatchSize: MAX_TRPC_BATCH,
    })
  );
  // development mode uses Vite, production mode uses static files
  if (process.env.NODE_ENV === "development") {
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

  // Production runs from dist/, where the build copies drizzle/.
  const migrationsFolder =
    process.env.NODE_ENV === "development"
      ? path.resolve(import.meta.dirname, "../..", "drizzle")
      : path.resolve(import.meta.dirname, "drizzle");
  try {
    if (await runMigrations(migrationsFolder)) {
      console.log("Database migrations are up to date");
    }
  } catch (error) {
    // Keep serving the public pages; inquiries fail until the schema is fixed.
    const cause = error instanceof Error ? error.cause : undefined;
    console.error(
      "[Database] Migration failed:",
      error instanceof Error ? error.message : error,
      cause instanceof Error ? `(cause: ${cause.message})` : ""
    );
  }

  const port = Number(process.env.PORT || "3000");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid PORT");
  server.on("error", error => { console.error("Server failed:", error.message); process.exit(1); });
  server.listen(port, "0.0.0.0", () => console.log(`Server listening on port ${port}`));
  // Lapsed disputes and expired sources take their lines down without a hand-run command.
  if (process.env.NODE_ENV === "production" && ENV.databaseUrl) startSchedules();
}

startServer().catch(error => { console.error(error); process.exit(1); });
