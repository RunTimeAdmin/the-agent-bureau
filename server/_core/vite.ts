import express, { type Express } from "express";
import fs from "fs";
import { type Server } from "http";
import { nanoid } from "nanoid";
import path from "path";
import { createServer as createViteServer } from "vite";
import viteConfig from "../../vite.config";

export async function setupVite(app: Express, server: Server) {
  const serverOptions = {
    middlewareMode: true,
    hmr: { server },
    allowedHosts: true as const,
  };

  const vite = await createViteServer({
    ...viteConfig,
    configFile: false,
    server: serverOptions,
    appType: "custom",
  });

  app.use(vite.middlewares);
  app.use("*", async (req, res, next) => {
    const url = req.originalUrl;

    try {
      const clientTemplate = path.resolve(
        import.meta.dirname,
        "../..",
        "client",
        "index.html"
      );

      // always reload the index.html file from disk incase it changes
      let template = await fs.promises.readFile(clientTemplate, "utf-8");
      template = template.replace(
        `src="/src/main.tsx"`,
        `src="/src/main.tsx?v=${nanoid()}"`
      );
      const page = await vite.transformIndexHtml(url, template);
      const pathname = new URL(url, "http://route.invalid").pathname;
      if (
        pathname.startsWith("/api/") ||
        pathname.startsWith("/assets/") ||
        /\.[a-z0-9]+$/i.test(pathname)
      ) {
        res.status(404).end("Not found");
        return;
      }
      const renderer = await vite.ssrLoadModule("/src/prerender.tsx");
      const rendered = renderer.renderDocument(page, pathname);
      res
        .status(rendered.status)
        .set({ "Content-Type": "text/html", "Cache-Control": "no-store" })
        .end(rendered.html);
    } catch (e) {
      vite.ssrFixStacktrace(e as Error);
      next(e);
    }
  });
}

export function serveStatic(app: Express) {
  const distPath =
    process.env.NODE_ENV === "development"
      ? path.resolve(import.meta.dirname, "../..", "dist", "public")
      : path.resolve(import.meta.dirname, "public");
  if (!fs.existsSync(distPath)) {
    console.error(
      `Could not find the build directory: ${distPath}, make sure to build the client first`
    );
  }

  const pages: Record<string, string> = {
    "/": "index.html",
    "/privacy": "privacy.html",
    "/terms": "terms.html",
    "/inbox": "inbox.html",
  };
  for (const [route, file] of Object.entries(pages)) {
    app.get(route, (_req, res) => {
      if (route === "/inbox") res.set("X-Robots-Tag", "noindex, nofollow");
      res
        .set("Cache-Control", "no-store")
        .sendFile(path.resolve(distPath, file));
    });
  }
  app.use(express.static(distPath, { index: false }));
  app.use("*", (_req, res) => {
    res
      .status(404)
      .set("X-Robots-Tag", "noindex")
      .sendFile(path.resolve(distPath, "404.html"));
  });
}
