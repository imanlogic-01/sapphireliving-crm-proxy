// ============================================================================
// Sapphire Living Care — Standalone Node CRM Proxy + Vite Middleware
// ----------------------------------------------------------------------------
// Two ways to run the same proxy:
//
//   1. Standalone dev server (no Vite):
//        node api/proxy-server.mjs
//      Serves the proxy at http://localhost:8787/api/crm/*
//
//   2. Vite dev-server middleware (recommended for local dev with the UI):
//        import { sapphireCrmProxyMiddleware } from "./api/proxy-server.mjs";
//        // in vite.config.ts:
//        plugins: [react(), {
//          name: "sapphire-crm-proxy",
//          configureServer(server) {
//            server.middlewares.use("/api", sapphireCrmProxyMiddleware);
//          },
//        }]
//      See vite.proxy.config.ts for a ready-to-use drop-in config.
//
// Environment variables (set in a local .env or your shell):
//   CRM_BASE_URL, CRM_API_KEY, LOCATION_ID, CRM_API_VERSION?, CRM_ALLOWED_ORIGIN?
// ============================================================================

import http from "node:http";
import { handleCrmProxy } from "./_proxy-core.mjs";

/** Read the full request body as a string. */
function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => resolve(""));
  });
}

/**
 * Connect/Express-style middleware. Mount it at "/api" so it handles
 * /api/crm/* and /api/health. Converts Node IncomingMessage/ServerResponse
 * into a Web Request, delegates to the shared core, and writes the response back.
 */
export async function sapphireCrmProxyMiddleware(req, res) {
  try {
    const host = req.headers.host || "localhost";
    const proto = req.headers["x-forwarded-proto"] || "http";
    const fullUrl = `${proto}://${host}${req.url}`;
    const body = ["GET", "HEAD"].includes(req.method || "GET")
      ? undefined
      : await readBody(req);
    const webReq = new Request(fullUrl, {
      method: req.method || "GET",
      headers: new Headers(req.headers),
      body,
    });
    const webRes = await handleCrmProxy(webReq);
    res.statusCode = webRes.status;
    webRes.headers.forEach((v, k) => res.setHeader(k, v));
    const buf = Buffer.from(await webRes.arrayBuffer());
    res.end(buf);
  } catch (e) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "Proxy error", detail: String(e && e.message ? e.message : e) }));
  }
}

/** Standalone server entrypoint: `node api/proxy-server.mjs` */
if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT) || 8787;
  const server = http.createServer((req, res) => {
    if (req.url && req.url.startsWith("/api")) {
      return sapphireCrmProxyMiddleware(req, res);
    }
    res.statusCode = 404;
    res.end("Not found. Proxy serves /api/crm/* and /api/health.");
  });
  server.listen(port, () => {
    // Never log secrets.
    console.log(`Sapphire CRM proxy listening on http://localhost:${port}/api/crm`);
    console.log(`Health: http://localhost:${port}/api/crm/_health`);
  });
}
