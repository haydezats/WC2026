// Server-side proxy to API-Football (api-sports.io).
// Keeps the API key in a Vercel env var (APIFOOTBALL_KEY) — never shipped to the
// browser or committed to this public repo. Adds a shared Redis cache (same store
// as the leaderboard) to preserve the request quota, plus CDN caching.
//
// Client usage:  /api/football?path=/standings&league=1&season=2026
//                /api/football?path=/fixtures/lineups&fixture=1489369
//                /api/football?path=/status            (account/quota check)

const { createClient } = require("redis");

const KEY = process.env.APIFOOTBALL_KEY;
const BASE = "https://v3.football.api-sports.io";

// Only these endpoints may be proxied (prevents the proxy being abused as an open key).
const ALLOW = new Set([
  "/status", "/standings", "/fixtures", "/fixtures/events", "/fixtures/lineups",
  "/fixtures/statistics", "/fixtures/players", "/players", "/players/squads",
  "/teams", "/teams/statistics", "/leagues", "/predictions", "/odds", "/venues",
]);

// Cache TTL (seconds) by endpoint. Lineups are static once posted → cache long when
// they contain data, short while still empty (so we re-check as kickoff approaches).
function ttlFor(path, hasData) {
  if (path.indexOf("lineups") >= 0) return hasData ? 21600 : 45;
  if (path === "/predictions") return 3600; // updated hourly upstream
  if (path === "/odds") return 1800;
  if (path === "/venues") return 86400;
  if (path.indexOf("events") >= 0 || path.indexOf("players") >= 0) return hasData ? 600 : 30;
  if (path === "/standings" || path === "/fixtures" || path === "/fixtures/statistics") return 30;
  if (path === "/teams" || path === "/leagues" || path === "/players/squads") return 3600;
  return 60;
}

let rc;
async function redis() {
  if (rc && rc.isOpen) return rc;
  if (!process.env.REDIS_URL) return null;
  rc = createClient({ url: process.env.REDIS_URL });
  rc.on("error", () => {});
  await rc.connect();
  return rc;
}

module.exports = async (req, res) => {
  if (!KEY) { res.status(503).json({ error: "api key not configured" }); return; }
  try {
    const u = new URL(req.url, "http://internal");
    let path = u.searchParams.get("path") || "";
    if (!path.startsWith("/")) path = "/" + path;
    if (!ALLOW.has(path)) { res.status(400).json({ error: "path not allowed", path: path }); return; }

    u.searchParams.delete("path");
    u.searchParams.sort();
    const qs = u.searchParams.toString();
    const target = BASE + path + (qs ? "?" + qs : "");
    const cacheKey = "fb:" + path + "?" + qs;

    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "public, s-maxage=15, stale-while-revalidate=120");

    const client = await redis().catch(() => null);
    if (client) {
      try {
        const hit = await client.get(cacheKey);
        if (hit) { res.setHeader("x-fb-cache", "HIT"); res.status(200).send(hit); return; }
      } catch (e) {}
    }

    const r = await fetch(target, { headers: { "x-apisports-key": KEY } });
    const body = await r.text();

    if (client && r.ok) {
      try {
        const j = JSON.parse(body);
        const apiErr = j.errors && !Array.isArray(j.errors) && Object.keys(j.errors).length;
        if (!apiErr) {
          const hasData = (j.results > 0) || (Array.isArray(j.response) && j.response.length > 0);
          await client.set(cacheKey, body, { EX: ttlFor(path, hasData) });
        }
      } catch (e) {}
    }
    res.setHeader("x-fb-cache", "MISS");
    res.status(r.status).send(body);
  } catch (e) {
    res.status(502).json({ error: "proxy error" });
  }
};
