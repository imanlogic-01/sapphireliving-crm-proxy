// ============================================================================
// Sapphire Living Care — GoCardless Webhook Event Store + Normalizer
// ----------------------------------------------------------------------------
// Receives raw GoCardless webhook events (POST /api/crm/webhook), normalizes
// them into the app's notification/alert format, and holds them in an in-memory
// ring buffer that the frontend polls (GET /api/crm/webhook/events?since=).
//
// The normalizer maps GoCardless `resource_type` + `action` onto the event ids
// used by the dashboard's webhook listener registry (see webhookSettings.tsx):
//   mandates  + cancelled  -> mandate.cancelled   (critical)
//   payments  + failed     -> payment.failed       (critical)
//   payments  + paid_out   -> payment.paid_out     (success)
//   ...etc
//
// The handler does NOT block on CRM lookups — it stores mandate/payment IDs
// and the frontend enriches them against tenancies it already has loaded
// (tenancies carry goCardlessMandateId / goCardlessPaymentId).
//
// SIGNATURE VERIFICATION:
//   If a `gocardlessWebhookSecret` is configured (api/crm.config.json or env),
//   the GoCardless `Webhook-Signature` header (t=...,v1=...) is verified with
//   HMAC-SHA256. If no secret is configured, verification is skipped so the
//   endpoint works in development. In production, SET THE SECRET.
//
// This module is plain ESM JS — runs in Node / Vite middleware / serverless.
// In-memory only: on a serverless cold start the buffer resets. For durable
// history, persist to the CRM (a future enhancement); the live CRM of record
// remains the source of truth for tenancy/payment state.
// ============================================================================

import crypto from "node:crypto";

/** @typedef {{id:string,eventType:string,category:string,severity:string,title:string,message:string,mandateId?:string,paymentId?:string,customerId?:string,amount?:number,reason?:string,timestamp:string,relatedEntityType?:string,relatedEntityId?:string,raw:unknown}} NormalizedEvent */

let /** @type {NormalizedEvent[]} */ store = [];
const MAX_EVENTS = 200;

/**
 * Map a single raw GoCardless event into the app's normalized format.
 * @param {any} ev
 * @returns {NormalizedEvent}
 */
function mapEvent(ev) {
  const resourceType = ev?.resource_type || "unknown";
  const action = ev?.action || "unknown";
  const eventId = String(ev?.id || `evt-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const createdAt = ev?.created_at || new Date().toISOString();
  const links = ev?.links || {};
  const details = ev?.details || {};

  let category = "System";
  let severity = "info";
  let title = `${resourceType} ${action}`;
  let message = "";
  let relatedEntityType = undefined;
  let relatedEntityId = undefined;
  let mandateId = links.mandate;
  let paymentId = links.payment;
  let customerId = links.customer;
  let amount = ev?.amount ?? details.amount;
  let reason = details.reason_code || details.cause || details.description;

  const money = (pence) =>
    typeof pence === "number" ? `£${(pence / 100).toFixed(2)}` : "";

  if (resourceType === "mandates") {
    category = "GoCardless Mandate";
    relatedEntityType = "tenant";
    relatedEntityId = mandateId || customerId;
    switch (action) {
      case "created":
        severity = "success"; title = "Direct Debit Mandate Created";
        message = `Mandate ${mandateId || ""} set up.`; break;
      case "submitted":
        severity = "info"; title = "Mandate Submitted";
        message = `Mandate ${mandateId || ""} submitted to the banks.`; break;
      case "active":
        severity = "success"; title = "Mandate Active";
        message = `Mandate ${mandateId || ""} approved — ready to collect.`; break;
      case "failed":
        severity = "critical"; title = "Mandate Failed";
        message = `Mandate ${mandateId || ""} setup failed${reason ? " — " + reason : ""}.`; break;
      case "cancelled":
        severity = "critical"; title = "Direct Debit Cancelled";
        message = `Mandate ${mandateId || ""} cancelled by customer${reason ? " — " + reason : ""}.`; break;
      case "expired":
        severity = "warning"; title = "Mandate Expired";
        message = `Mandate ${mandateId || ""} expired without a replacement.`; break;
      case "replaced":
        severity = "info"; title = "Mandate Replaced";
        message = `Mandate ${mandateId || ""} replaced by a new mandate.`; break;
      default:
        severity = "info"; title = `Mandate ${action}`;
        message = `Mandate ${mandateId || ""}: ${action}.`;
    }
  } else if (resourceType === "payments") {
    category = "GoCardless Payment";
    relatedEntityType = "payment";
    relatedEntityId = paymentId || mandateId;
    const amt = money(amount);
    switch (action) {
      case "created":
        severity = "info"; title = "Payment Created";
        message = `Payment ${paymentId || ""} scheduled${amt ? " for " + amt : ""}.`; break;
      case "submitted":
        severity = "info"; title = "Payment Submitted";
        message = `Payment ${paymentId || ""} submitted${amt ? " (" + amt + ")" : ""}.`; break;
      case "confirmed":
        severity = "info"; title = "Payment Confirmed";
        message = `Payment ${paymentId || ""} confirmed${amt ? " (" + amt + ")" : ""}.`; break;
      case "paid_out":
        severity = "success"; title = "Payment Received";
        message = `Payment ${paymentId || ""} paid out${amt ? " (" + amt + ")" : ""}.`; break;
      case "failed":
        severity = "critical"; title = "Payment Failed";
        message = `Payment ${paymentId || ""}${amt ? " " + amt : ""} failed${reason ? " — " + reason : ""}.`; break;
      case "cancelled":
        severity = "warning"; title = "Payment Cancelled";
        message = `Payment ${paymentId || ""} cancelled.`; break;
      case "charged_back":
        severity = "critical"; title = "Chargeback";
        message = `Payment ${paymentId || ""} charged back${amt ? " (" + amt + ")" : ""}.`; break;
      default:
        severity = "info"; title = `Payment ${action}`;
        message = `Payment ${paymentId || ""}: ${action}.`;
    }
  } else {
    category = "System";
    severity = "info";
    title = `${resourceType} ${action}`;
    try {
      message = JSON.stringify(ev).slice(0, 240);
    } catch {
      message = `${resourceType}.${action}`;
    }
  }

  return {
    id: eventId,
    eventType: `${resourceType}.${action}`,
    category,
    severity,
    title,
    message,
    mandateId,
    paymentId,
    customerId,
    amount: typeof amount === "number" ? amount : undefined,
    reason,
    timestamp: createdAt,
    relatedEntityType,
    relatedEntityId,
    raw: ev,
  };
}

/**
 * Verify the GoCardless `Webhook-Signature` header.
 * Header format: `t=<unix-seconds>,v1=<hex-hmac-sha256>`.
 * HMAC is computed over `<timestamp>.<rawBody>`.
 * If no secret is configured, verification is skipped (returns true) so the
 * endpoint is usable in development. SET THE SECRET IN PRODUCTION.
 *
 * @param {string} rawBody
 * @param {string|undefined} signatureHeader
 * @param {string|undefined} secret
 * @returns {boolean}
 */
export function verifyGoCardlessSignature(rawBody, signatureHeader, secret) {
  if (!secret) return true; // dev mode — no secret configured
  if (!signatureHeader) return false;
  /** @type {Record<string,string>} */
  const parts = {};
  for (const seg of signatureHeader.split(",")) {
    const idx = seg.indexOf("=");
    if (idx > 0) parts[seg.slice(0, idx).trim()] = seg.slice(idx + 1).trim();
  }
  const t = parts.t;
  const v1 = parts.v1;
  if (!t || !v1) return false;
  const expected = crypto
    .createHmac("sha256", secret)
    .update(`${t}.${rawBody}`)
    .digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(v1);
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/**
 * Ingest a GoCardless webhook payload.
 * Accepts `{ events: [...] }`, a bare array, or a single event object.
 * @param {unknown} payload
 * @returns {{ ingested: number, events: NormalizedEvent[] }}
 */
export function ingestGoCardlessWebhook(payload) {
  /** @type {any[]} */
  let events = [];
  if (Array.isArray(payload)) events = payload;
  else if (payload && Array.isArray(payload.events)) events = payload.events;
  else if (payload && (payload.resource_type || payload.action))
    events = [payload];

  const normalized = events.map(mapEvent);
  for (const e of normalized) store.unshift(e);
  if (store.length > MAX_EVENTS) store = store.slice(0, MAX_EVENTS);
  return { ingested: normalized.length, events: normalized };
}

/**
 * Return events newer than `since` (ms epoch). Newest first.
 * @param {number} since
 * @returns {NormalizedEvent[]}
 */
export function getWebhookEvents(since = 0) {
  return store.filter((e) => new Date(e.timestamp).getTime() > since);
}

/** Aggregate counts by severity for the Settings dashboard. */
export function getWebhookStats() {
  /** @type {Record<string, number>} */
  const counts = { critical: 0, warning: 0, info: 0, success: 0, total: store.length };
  for (const e of store) counts[e.severity] = (counts[e.severity] || 0) + 1;
  return counts;
}
