// api/crm-proxy.js
// Plain filename, no brackets, no dynamic-route ambiguity — routing is
// handled explicitly via vercel.json instead.
export { sapphireCrmProxyMiddleware as default } from "./proxy-server.mjs";
