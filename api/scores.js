// Global penalty-game leaderboard backed by Vercel Redis (node-redis over REDIS_URL).
// Stays a single serverless function on an otherwise static site.
//
// Requires the REDIS_URL env var, injected when a Redis store is connected to the
// project in the Vercel dashboard.

const { createClient } = require("redis");

const KEY = "pen:scores";
const SEP = ""; // delimiter between display name and uniqueness suffix in a member

let client; // reused across warm invocations
async function getClient() {
  if (client && client.isOpen) return client;
  client = createClient({ url: process.env.REDIS_URL });
  client.on("error", () => {}); // swallow late errors so the lambda doesn't crash
  await client.connect();
  return client;
}

async function topFive(c) {
  const rows = await c.zRangeWithScores(KEY, 0, 4, { REV: true }); // highest first: [{value, score}]
  return rows.map((r) => ({
    name: String(r.value).split(SEP)[0] || "YOU",
    score: Number(r.score) || 0,
  }));
}

module.exports = async (req, res) => {
  if (!process.env.REDIS_URL) {
    res.status(503).json({ error: "leaderboard store not configured" });
    return;
  }
  try {
    const c = await getClient();

    if (req.method === "GET") {
      res.setHeader("Cache-Control", "no-store");
      res.status(200).json({ scores: await topFive(c) });
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
      await c.zAdd(KEY, { score: score, value: member });
      await c.zRemRangeByRank(KEY, 0, -51); // keep only the highest 50 entries

      res.status(200).json({ scores: await topFive(c) });
      return;
    }

    res.setHeader("Allow", "GET, POST");
    res.status(405).json({ error: "method not allowed" });
  } catch (e) {
    res.status(500).json({ error: "leaderboard unavailable" });
  }
};
