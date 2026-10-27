import "dotenv/config";
import express from "express";
import { createServer } from "http";
import path from "node:path";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { createAgentApi } from "../agentApi";
import { runMigrations } from "../db";
import { appRouter } from "../routers";
import { createContext } from "./context";
import { serveStatic, setupVite } from "./vite";

async function startServer() {
  const app = express();
  const server = createServer(app);
  // Hosts such as Hostinger put the app behind a reverse proxy. Take the client
  // address from X-Forwarded-For only when the proxy is on a loopback or
  // private address, so visitors cannot spoof it from the internet.
  app.set("trust proxy", "loopback, linklocal, uniquelocal");
  // Agent mode parses its own JSON so bad bodies get JSON errors, not HTML.
  app.use("/api/agent/v1", createAgentApi());
  // The largest request is a 4,000-character inquiry; there are no uploads.
  app.use(express.json({ limit: "100kb" }));
  app.use(express.urlencoded({ limit: "100kb", extended: true }));
  app.get("/api/health", (_req, res) => res.json({ status: "ok" }));
  // tRPC API
  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext,
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
}

startServer().catch(error => { console.error(error); process.exit(1); });
