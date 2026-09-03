// ============================================================================
// Sapphire Living Care — CRM auth token manager
// ----------------------------------------------------------------------------
// Resolves a Bearer token for CRM API calls. Two modes are supported:
//
//   1. static-token (default) — the Private Integration token is used directly
//      as the Bearer token. No token exchange is performed.
//
//   2. oauth-client-credentials — exchanges client_id + client_secret for a
//      short-lived access token via the OAuth token endpoint. Tokens are
//      cached in-memory and auto-refreshed ~60s before expiry.
//
// Credentials are read from environment variables ONLY in this deployment —
// never from the frontend, and there is no checked-in config file. No secret
// is ever logged or sent to the browser.
//
// This module runs server-side (Node / serverless). It is plain ESM JS so it
// imports cleanly from api/_proxy-core.mjs.
// ============================================================================

let cachedConfig = null;

/**
 * Load the server-side CRM config from environment variables only.
 * The config (and especially any token/secret) is held only in server memory.
 */
export function loadCrmConfig() {
  if (cachedConfig) return cachedConfig;

  cachedConfig = {
    authMode: process.env.CRM_AUTH_MODE || "static-token",
    staticToken:
      process.env.CRM_STATIC_TOKEN || process.env.CRM_API_KEY || "",
    crmBaseUrl: process.env.CRM_BASE_URL || "",
    tokenUrl: process.env.CRM_TOKEN_URL || "",
    locationId: process.env.LOCATION_ID || "",
    clientId: process.env.CRM_CLIENT_ID || "",
    clientSecret: process.env.CRM_CLIENT_SECRET || "",
    scope: process.env.CRM_SCOPE || "",
    apiVersion: process.env.CRM_API_VERSION || "",
    allowedOrigin: process.env.CRM_ALLOWED_ORIGIN || "*",
    // Optional GoCardless webhook signing secret (for verifying
    // Webhook-Signature headers on POST /api/crm/webhook). If unset,
    // signature verification is skipped — set it in production.
    gocardlessWebhookSecret: process.env.GOCARDLESS_WEBHOOK_SECRET || "",
  };

  return cachedConfig;
}

/** True when enough credentials are present to attempt live CRM calls. */
export function isCrmConfigured() {
  const c = loadCrmConfig();
  if (!c.crmBaseUrl || !c.locationId) return false;
  if (c.authMode === "static-token") return Boolean(c.staticToken);
  if (c.authMode === "oauth-client-credentials") {
    return Boolean(c.clientId && c.clientSecret && c.tokenUrl);
  }
  // Unknown mode: treat as unconfigured.
  return false;
}

// --- OAuth token cache (only used in oauth-client-credentials mode) ----------
let tokenCache = null; // { accessToken, expiresAt (ms), scope }

function isTokenValid() {
  if (!tokenCache) return false;
  // Refresh 60s before actual expiry to avoid edge races.
  return Date.now() < tokenCache.expiresAt - 60_000;
}

/**
 * Exchange client_id + client_secret for a Bearer token via
 * client_credentials grant. Returns { accessToken, expiresAt, scope }.
 * Only used when authMode === "oauth-client-credentials".
 */
async function fetchNewToken() {
  const cfg = loadCrmConfig();
  if (!cfg.tokenUrl || !cfg.clientId || !cfg.clientSecret) {
    throw new Error("OAuth client_credentials not configured (tokenUrl/clientId/clientSecret).");
  }

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
  });
  if (cfg.scope) body.set("scope", cfg.scope);

  const res = await fetch(cfg.tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`OAuth token request failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  const accessToken = data.access_token;
  if (!accessToken) {
    throw new Error(`OAuth token response missing access_token: ${JSON.stringify(data)}`);
  }
  // expires_in is seconds; default to 30 min if absent.
  const expiresIn = Number(data.expires_in ?? 1800);
  return {
    accessToken,
    expiresAt: Date.now() + expiresIn * 1000,
    scope: data.scope ?? cfg.scope,
  };
}

let inflight = null;

/**
 * Return a valid Bearer token.
 *
 * In static-token mode this returns the configured token directly — no
 * network call, no token exchange, no caching needed.
 *
 * In oauth-client-credentials mode it fetches/refreshes the token, caching it
 * in-memory with auto-refresh ~60s before expiry. Concurrent callers share the
 * same in-flight promise to avoid stampede.
 */
export async function getBearerToken() {
  const cfg = loadCrmConfig();

  // Static-token mode: use the Private Integration token directly.
  if (cfg.authMode === "static-token") {
    return cfg.staticToken;
  }

  // OAuth client_credentials mode.
  if (isTokenValid()) return tokenCache.accessToken;
  if (inflight) return inflight;

  inflight = (async () => {
    try {
      tokenCache = await fetchNewToken();
      return tokenCache.accessToken;
    } finally {
      inflight = null;
    }
  })();

  return inflight;
}

/** Clear the cached token (e.g. on a 401 to force re-auth). No-op in static mode. */
export function invalidateToken() {
  tokenCache = null;
}
