// Vercel's Node.js serverless function signature is (req, res) — the same
// shape sapphireCrmProxyMiddleware already uses, so no translation layer
// is needed. This file's only job is to give Vercel something to route
// /api/crm/* requests to.
export { sapphireCrmProxyMiddleware as default } from "../proxy-server.mjs";
