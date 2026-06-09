// Server-side proxy to API-Football (api-sports.io).
// Keeps the API key in a Vercel env var (APIFOOTBALL_KEY) — never shipped to the
// browser or committed to this public repo. Also lets us cache responses on the
// Vercel CDN to preserve the request quota.
//
// Client usage:  /api/football?path=/standings&league=1&season=2026
//                /api/football?path=/status            (account/quota check)

const KEY = process.env.APIFOOTBALL_KEY;
const BASE = "https://v3.football.api-sports.io";

// Only these endpoints may be proxied (prevents the proxy being abused as an open key).
const ALLOW = new Set([
  "/status",
  "/standings",
  "/fixtures",
  "/fixtures/events",
  "/fixtures/lineups",
  "/fixtures/statistics",
  "/fixtures/players",
  "/players",
  "/players/squads",
  "/teams",
  "/teams/statistics",
  "/leagues",
]);

module.exports = async (req, res) => {
  if (!KEY) { res.status(503).json({ error: "api key not configured" }); return; }
  try {
    const u = new URL(req.url, "http://internal");
    let path = u.searchParams.get("path") || "";
    if (!path.startsWith("/")) path = "/" + path;
    if (!ALLOW.has(path)) { res.status(400).json({ error: "path not allowed", path: path }); return; }

    u.searchParams.delete("path");
    const qs = u.searchParams.toString();
    const target = BASE + path + (qs ? "?" + qs : "");

    const r = await fetch(target, { headers: { "x-apisports-key": KEY } });
    const body = await r.text();
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    // Cache on the CDN: short freshness, long stale-while-revalidate to spare quota.
    res.setHeader("Cache-Control", "public, s-maxage=30, stale-while-revalidate=300");
    res.status(r.status).send(body);
  } catch (e) {
    res.status(502).json({ error: "proxy error" });
  }
};
