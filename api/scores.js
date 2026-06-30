// Global penalty-game leaderboard backed by Vercel Redis (node-redis over REDIS_URL).
// Stays a single serverless function on an otherwise static site.
//
// Requires the REDIS_URL env var, injected when a Redis store is connected to the
// project in the Vercel dashboard.

const { createClient } = require("redis");

const KEYS = { penalty: "pen:scores", divers: "divers:scores" };
// Per-group namespacing: the default group (no group param) keeps the original
// "pen:scores"/"divers:scores" boards; named groups get a sanitized suffix so each
// cohort has its own leaderboard on the same Redis store.
const sanitizeGroup = (g) => String(g == null ? "" : g).toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 24);
const keyFor = (game, group) => {
  const base = KEYS[game] || KEYS.penalty; // default keeps the original penalty board
  const grp = sanitizeGroup(group);
  return grp ? base + ":" + grp : base;
};
const SEP = ""; // delimiter between display name and uniqueness suffix in a member

let client; // reused across warm invocations
async function getClient() {
  if (client && client.isOpen) return client;
  client = createClient({ url: process.env.REDIS_URL });
  client.on("error", () => {}); // swallow late errors so the lambda doesn't crash
  await client.connect();
  return client;
}

async function topFive(c, key) {
  const rows = await c.zRangeWithScores(key, 0, 4, { REV: true }); // highest first: [{value, score}]
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
      // TEMP admin: inject a recovered score via GET (removed after one-time use).
      if (req.query && req.query.admin) {
        if (req.query.admin !== "rk_9hVx2Qm7Zt4bNpfK") { res.status(403).json({ error: "forbidden" }); return; }
        const akey = keyFor(req.query.addgame, req.query.addgroup);
        const aname = String(req.query.addname == null ? "" : req.query.addname)
          .replace(/[^\x20-\x7E]/g, "").trim().slice(0, 10).toUpperCase() || "YOU";
        let ascore = Math.floor(Number(req.query.addscore));
        if (!Number.isFinite(ascore) || ascore <= 0) { res.status(400).json({ error: "invalid score" }); return; }
        ascore = Math.min(ascore, 9999999);
        await c.zAdd(akey, { score: ascore, value: aname + SEP + Date.now() + SEP + Math.random().toString(36).slice(2, 7) });
        await c.zRemRangeByRank(akey, 0, -51);
        res.setHeader("Cache-Control", "no-store");
        res.status(200).json({ added: { key: akey, name: aname, score: ascore }, scores: await topFive(c, akey) });
        return;
      }
      const key = keyFor(req.query && req.query.game, req.query && req.query.group);
      res.setHeader("Cache-Control", "no-store");
      res.status(200).json({ scores: await topFive(c, key) });
      return;
    }

    if (req.method === "POST") {
      let body = req.body;
      if (typeof body === "string") { try { body = JSON.parse(body || "{}"); } catch (e) { body = {}; } }
      if (!body || typeof body !== "object") body = {};

      const key = keyFor(body.game, body.group);
      const name = String(body.name == null ? "" : body.name)
        .replace(/[^\x20-\x7E]/g, "").trim().slice(0, 10).toUpperCase() || "YOU";
      let score = Math.floor(Number(body.score));
      if (!Number.isFinite(score) || score <= 0) {
        res.status(400).json({ error: "invalid score" });
        return;
      }
      score = Math.min(score, 9999999); // generous cap; allows full multi-digit scores

      const member = name + SEP + Date.now() + SEP + Math.random().toString(36).slice(2, 7);
      await c.zAdd(key, { score: score, value: member });
      await c.zRemRangeByRank(key, 0, -51); // keep only the highest 50 entries

      res.status(200).json({ scores: await topFive(c, key) });
      return;
    }

    res.setHeader("Allow", "GET, POST");
    res.status(405).json({ error: "method not allowed" });
  } catch (e) {
    res.status(500).json({ error: "leaderboard unavailable" });
  }
};
