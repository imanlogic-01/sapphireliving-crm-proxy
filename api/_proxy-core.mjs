// ============================================================================
// Sapphire Living Care — CRM Proxy Core (framework-agnostic)
// ----------------------------------------------------------------------------
// Strips the `/api/crm` prefix and forwards the remaining path + query string
// to the CRM API (CRM_BASE_URL), attaching:
//   Authorization: Bearer <token>
//   Content-Type:  application/json
//   Version:       <apiVersion>           (if configured)
//   locationId:    injected from LOCATION_ID —
//                    GET/PUT/PATCH -> query param
//                    POST          -> request body
//                    DELETE        -> omitted entirely
//                  (confirmed against the live CRM; PUT/DELETE previously
//                  broke when locationId was injected into the body for
//                  every method — fixed here.)
//
// Credentials are read from the server-side config (api/crm.config.json) and/or
// environment variables ONLY — never from the frontend. The token is obtained
// via api/oauth-token-manager.mjs. No secret is ever returned to the browser.
// The CRM response is forwarded unchanged (status, headers, body). CORS is
// applied for browser callers.
//
// This module is plain ESM JS so it runs in:
//   - Node (standalone server / Vite middleware)  -> see ./proxy-server.mjs
//   - Edge / serverless runtimes                  -> see ./crm/[...path].js
// ============================================================================

import {
  loadCrmConfig,
  isCrmConfigured,
  getBearerToken,
  invalidateToken,
} from "./oauth-token-manager.mjs";
import {
  ingestGoCardlessWebhook,
  verifyGoCardlessSignature,
  getWebhookEvents,
  getWebhookStats,
} from "./webhook-store.mjs";

const CRM_PREFIX = "/api/crm";
const WEBHOOK_INGEST_PATH = `${CRM_PREFIX}/webhook`;
const WEBHOOK_EVENTS_PATH = `${CRM_PREFIX}/webhook/events`;
const WEBHOOK_STATS_PATH = `${CRM_PREFIX}/webhook/stats`;

function corsHeaders(origin) {
  const cfg = loadCrmConfig();
  const allow = cfg.allowedOrigin || origin || "*";
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Max-Age": "86400",
  };
}

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(), ...extra },
  });
}

/**
 * Health probe used by the frontend to auto-detect live mode.
 * Returns live:true only when the proxy is configured (base url + location id
 * + either a static key or OAuth client_id/secret). Never leaks secrets.
 */
export function healthResponse() {
  const cfg = loadCrmConfig();
  const live = isCrmConfigured();
  const auth = cfg.authMode === "oauth-client-credentials"
    ? "oauth-client-credentials"
    : cfg.authMode === "static-token"
      ? "static-token"
      : "unset";
  return json({
    status: live ? "ok" : "misconfigured",
    live,
    mode: live ? "live" : "demo",
    locationId: cfg.locationId ? "set" : "unset",
    auth,
  });
}

/**
 * Core proxy handler. Accepts a Web Request and returns a Web Response.
 * Works on Cloudflare Workers, Vercel Node/Edge, Netlify Functions, Deno, etc.
 */
export async function handleCrmProxy(req) {
  const url = new URL(req.url);
  const path = url.pathname;

  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: corsHeaders(req.headers.get("origin") || undefined),
    });
  }

  // Health probe (served by the proxy itself, never forwarded)
  if (
    path === `${CRM_PREFIX}/_health` ||
    path === `${CRM_PREFIX}/health` ||
    path === "/api/health"
  ) {
    return healthResponse();
  }

  // --- GoCardless webhook ingest + stream -------------------------------
  // These routes are served by the proxy itself (not forwarded to the CRM).
  if (path === WEBHOOK_INGEST_PATH) {
    return handleWebhookIngest(req);
  }
  if (path === WEBHOOK_EVENTS_PATH) {
    return handleWebhookEvents(req);
  }
  if (path === WEBHOOK_STATS_PATH) {
    return json(getWebhookStats());
  }

  const cfg = loadCrmConfig();
  if (!isCrmConfigured()) {
    return json(
      {
        error:
          "CRM proxy not configured. Set CRM_BASE_URL, CRM_STATIC_TOKEN (or CRM_CLIENT_ID/CRM_CLIENT_SECRET), LOCATION_ID env vars.",
      },
      503,
    );
  }

  // Strip the /api/crm prefix -> remaining path is the real CRM path.
  let stripped = path;
  if (stripped.startsWith(CRM_PREFIX)) stripped = stripped.slice(CRM_PREFIX.length);
  if (!stripped.startsWith("/")) stripped = "/" + stripped;

  const base = (cfg.crmBaseUrl || "").replace(/\/+$/, "");
  const target = new URL(base + stripped);

  // Carry over query string, excluding "path" — the vercel.json rewrite
  // (source: /api/crm/:path*, destination: /api/crm-proxy) auto-appends the
  // unused wildcard segment as a "?path=..." query param on the underlying
  // request. Confirmed via live proxy debug logs: GHL rejects any
  // unrecognized query param on the search endpoint with a 422
  // "property path should not exist", which this was silently causing.
  const INTERNAL_QUERY_PARAMS = new Set(["path"]);
  url.searchParams.forEach((v, k) => {
    if (!INTERNAL_QUERY_PARAMS.has(k)) {
      target.searchParams.set(k, v);
    }
  });

  // Inject locationId as a query param for GET, PUT, and PATCH — confirmed
  // against the live CRM. POST wants it in the body instead (below). DELETE
  // must not receive locationId anywhere, or the request fails.
  if (
    cfg.locationId &&
    (req.method === "GET" || req.method === "PUT" || req.method === "PATCH")
  ) {
    if (
      !target.searchParams.has("locationId") &&
      !target.searchParams.has("location_id")
    ) {
      target.searchParams.set("locationId", cfg.locationId);
    }
  }

  // Obtain a Bearer token (OAuth client_credentials, cached + auto-refreshed,
  // or the static Private Integration token).
  let bearer;
  try {
    bearer = await getBearerToken();
  } catch (e) {
    return json(
      {
        error: "Unable to obtain CRM access token",
        detail: String(e && e.message ? e.message : e),
      },
      502,
    );
  }

  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json",
    Authorization: `Bearer ${bearer}`,
  };
  if (cfg.apiVersion) headers.Version = cfg.apiVersion;

  let body;
  if (req.method !== "GET" && req.method !== "HEAD") {
    const raw = await req.text();
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        // Only POST wants locationId in the body. PUT/PATCH already got it
        // as a query param above; DELETE must not receive it at all.
        if (
          cfg.locationId &&
          req.method === "POST" &&
          parsed &&
          typeof parsed === "object" &&
          !Array.isArray(parsed)
        ) {
          if (!("locationId" in parsed) && !("location_id" in parsed)) {
            parsed.locationId = cfg.locationId;
          }
        }
        body = JSON.stringify(parsed);
      } catch {
        body = raw; // forward non-JSON bodies unchanged
      }
    }
  }

  let upstream;
  try {
    upstream = await fetch(target.toString(), {
      method: req.method,
      headers,
      body,
    });
  } catch (e) {
    return json(
      { error: "Upstream CRM unreachable", detail: String(e && e.message ? e.message : e) },
      502,
    );
  }

  // On 401, invalidate the cached token so the next call re-authenticates.
  if (upstream.status === 401) {
    invalidateToken();
  }

  // Forward the CRM response, adding CORS headers. fetch() already
  // transparently decompressed the body, but upstream.headers still reports
  // the original Content-Encoding (and a now-wrong Content-Length) from GHL.
  // Forwarding those stale headers alongside the already-decompressed body
  // makes the browser try to re-decompress plain data and fail with
  // ERR_CONTENT_DECODING_FAILED. Strip both so the browser trusts the actual
  // bytes it receives.
  const respHeaders = new Headers(upstream.headers);
  respHeaders.delete("content-encoding");
  respHeaders.delete("content-length");
  Object.entries(corsHeaders(req.headers.get("origin") || undefined)).forEach(
    ([k, v]) => respHeaders.set(k, v),
  );
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: respHeaders,
  });
}

// ============================================================================
// GoCardless webhook ingest + event stream handlers
// ----------------------------------------------------------------------------

/**
 * POST /api/crm/webhook — GoCardless webhook endpoint.
 * Verifies the Webhook-Signature header (when a secret is configured), then
 * normalizes + stores each event so the frontend poller can surface them as
 * notifications and critical alerts.
 */
async function handleWebhookIngest(req) {
  const rawBody = (await req.text()) || "";
  const cfg = loadCrmConfig();
  const secret =
    process.env.GOCARDLESS_WEBHOOK_SECRET || cfg.gocardlessWebhookSecret;

  const signature = req.headers.get("webhook-signature");
  if (!verifyGoCardlessSignature(rawBody, signature, secret)) {
    return json({ error: "Invalid webhook signature" }, 401);
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const { ingested, events } = ingestGoCardlessWebhook(payload);
  return json({ received: ingested, events }, 200);
}

/**
 * GET /api/crm/webhook/events?since=<ms-epoch>
 * Returns normalized events newer than `since`, newest first. The frontend
 * polls this to stream webhook events into the notification + alert engine.
 */
async function handleWebhookEvents(req) {
  const url = new URL(req.url);
  const since = Number(url.searchParams.get("since") || 0);
  return json({ events: getWebhookEvents(since) });
}
