// Global penalty-game leaderboard backed by a Vercel KV / Upstash Redis store.
// Zero-dependency: talks to the Upstash REST API directly via fetch, so the
// project stays a build-free static site with a single serverless function.
//
// Required env vars (auto-injected when you connect a KV/Redis store to the
// project in the Vercel dashboard). Both naming conventions are supported:
//   KV_REST_API_URL    / KV_REST_API_TOKEN        (Vercel KV / Marketplace)
//   UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN  (direct Upstash)

const KEY = "pen:scores";
const REST_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REST_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const SEP = "";

async function redis(cmd) {
  const r = await fetch(REST_URL, {
    method: "POST",
    headers: { Authorization: "Bearer " + REST_TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify(cmd),
  });
  if (!r.ok) throw new Error("redis http " + r.status);
  const j = await r.json();
  if (j && j.error) throw new Error(j.error);
  return j ? j.result : null;
}

// Upstash ZRANGE ... WITHSCORES returns a flat array [member, score, member, score, ...]
function shape(arr) {
  const out = [];
  if (Array.isArray(arr)) {
    for (let i = 0; i < arr.length; i += 2) {
      const member = String(arr[i] == null ? "" : arr[i]);
      out.push({ name: member.split(SEP)[0] || "YOU", score: Number(arr[i + 1]) || 0 });
    }
  }
  return out;
}

async function topFive() {
  return shape(await redis(["ZRANGE", KEY, "0", "4", "REV", "WITHSCORES"]));
}

module.exports = async (req, res) => {
  if (!REST_URL || !REST_TOKEN) {
    res.status(503).json({ error: "leaderboard store not configured" });
    return;
  }
  try {
    if (req.method === "GET") {
      res.setHeader("Cache-Control", "no-store");
      res.status(200).json({ scores: await topFive() });
      return;
    }
    if (req.method === "POST") {
      let body = req.body;
      if (typeof body === "string") { try { body = JSON.parse(body || "{}"); } catch (e) { body = {}; } }
      if (!body || typeof body !== "object") body = {};

      const name = String(body.name == null ? "" : body.name)
        .replace(/[^\x20-\x7E]/g, "").trim().slice(0, 10).toUpperCase() || "YOU";
      let score = Math.floor(Number(body.score));
      if (!Number.isFinite(score) || score <= 0) {
        res.status(400).json({ error: "invalid score" });
        return;
      }
      score = Math.min(score, 999);

      const member = name + SEP + Date.now() + SEP + Math.random().toString(36).slice(2, 7);
      await redis(["ZADD", KEY, String(score), member]);
      // Keep only the highest 50 entries to bound storage.
      await redis(["ZREMRANGEBYRANK", KEY, "0", "-51"]);

      res.status(200).json({ scores: await topFive() });
      return;
    }
    res.setHeader("Allow", "GET, POST");
    res.status(405).json({ error: "method not allowed" });
  } catch (e) {
    res.status(500).json({ error: "leaderboard unavailable" });
  }
};
