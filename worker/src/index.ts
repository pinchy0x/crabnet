// CrabNet Registry - Cloudflare Worker
import { Hono } from "hono";
import { cors } from "hono/cors";
import { prettyJSON } from "hono/pretty-json";

type Bindings = {
  DB: D1Database;
  ENVIRONMENT: string;
};

const app = new Hono<{ Bindings: Bindings }>();

// Middleware
app.use("*", cors());
app.use("*", prettyJSON());

// --- Health & Info ---

app.get("/", (c) => {
  return c.json({
    name: "CrabNet Registry",
    version: "0.1.0",
    description: "Cross-agent collaboration protocol registry",
    runtime: "Cloudflare Workers + D1",
    endpoints: {
      manifests: "/manifests",
      capabilities: "/capabilities",
      tasks: "/tasks",
      search: "/search",
    },
    docs: "https://github.com/pinchy0x/crabnet",
    moltbook: "https://moltbook.com/m/crabnet",
  });
});

app.get("/health", (c) => c.json({ status: "ok", timestamp: new Date().toISOString() }));

// --- Manifest Endpoints ---

app.post("/manifests", async (c) => {
  const db = c.env.DB;

  try {
    const body = await c.req.json();
    const { agent, capabilities, trust, contact } = body;

    if (!agent?.id || !agent?.name || !capabilities) {
      return c.json({ error: "Invalid manifest: missing agent.id, agent.name, or capabilities" }, 400);
    }

    if (!/^[a-zA-Z0-9_-]+@[a-zA-Z0-9_-]+$/.test(agent.id)) {
      return c.json({ error: "Invalid agent.id format. Expected: username@platform" }, 400);
    }

    const now = new Date().toISOString();
    const manifest = JSON.stringify(body);

    // Upsert agent
    await db
      .prepare(
        `INSERT INTO agents (id, name, platform, human, verified, manifest, reputation_score, registered_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           platform = excluded.platform,
           human = excluded.human,
           verified = excluded.verified,
           manifest = excluded.manifest,
           updated_at = excluded.updated_at`
      )
      .bind(
        agent.id,
        agent.name,
        agent.platform,
        agent.human || null,
        agent.verified ? 1 : 0,
        manifest,
        trust?.reputation_score || 0,
        now,
        now
      )
      .run();

    // Delete old capabilities and insert new ones
    await db.prepare("DELETE FROM capabilities WHERE agent_id = ?").bind(agent.id).run();

    for (const cap of capabilities) {
      await db
        .prepare(
          `INSERT INTO capabilities (agent_id, capability_id, name, description, category, pricing_karma, pricing_usdc, pricing_free)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          agent.id,
          cap.id,
          cap.name,
          cap.description || null,
          cap.category || null,
          cap.pricing?.karma || null,
          cap.pricing?.usdc || null,
          cap.pricing?.free ? 1 : 0
        )
        .run();
    }

    return c.json(
      {
        success: true,
        message: "Manifest registered 🦀",
        agent_id: agent.id,
      },
      201
    );
  } catch (e: any) {
    return c.json({ error: e.message || "Failed to register manifest" }, 500);
  }
});

app.get("/manifests", async (c) => {
  const db = c.env.DB;
  const results = await db.prepare("SELECT id, name, platform, verified, reputation_score, manifest FROM agents").all();

  return c.json({
    count: results.results?.length || 0,
    manifests: results.results?.map((r: any) => ({
      agent: { id: r.id, name: r.name, platform: r.platform, verified: !!r.verified },
      reputation_score: r.reputation_score,
      ...JSON.parse(r.manifest),
    })),
  });
});

app.get("/manifests/:agentId", async (c) => {
  const db = c.env.DB;
  const agentId = c.req.param("agentId");

  const result = await db.prepare("SELECT manifest FROM agents WHERE id = ?").bind(agentId).first();

  if (!result) {
    return c.json({ error: "Manifest not found" }, 404);
  }

  return c.json(JSON.parse(result.manifest as string));
});

app.delete("/manifests/:agentId", async (c) => {
  const db = c.env.DB;
  const agentId = c.req.param("agentId");

  const result = await db.prepare("DELETE FROM agents WHERE id = ?").bind(agentId).run();

  if (!result.meta.changes) {
    return c.json({ error: "Manifest not found" }, 404);
  }

  return c.json({ success: true, message: "Manifest deleted" });
});

// --- Search Endpoints ---

app.get("/search/capabilities", async (c) => {
  const db = c.env.DB;
  const q = c.req.query("q");

  if (!q) {
    return c.json({ error: "Missing query parameter 'q'" }, 400);
  }

  const searchTerm = `%${q}%`;
  const results = await db
    .prepare(
      `SELECT c.*, a.name as agent_name, a.reputation_score, a.manifest
       FROM capabilities c
       JOIN agents a ON c.agent_id = a.id
       WHERE c.name LIKE ? OR c.description LIKE ? OR c.capability_id LIKE ?
       ORDER BY a.reputation_score DESC
       LIMIT 50`
    )
    .bind(searchTerm, searchTerm, searchTerm)
    .all();

  return c.json({
    query: q,
    count: results.results?.length || 0,
    results: results.results?.map((r: any) => {
      const manifest = JSON.parse(r.manifest);
      return {
        agent_id: r.agent_id,
        agent_name: r.agent_name,
        reputation: r.reputation_score,
        capability: {
          id: r.capability_id,
          name: r.name,
          description: r.description,
          category: r.category,
          pricing: {
            karma: r.pricing_karma,
            usdc: r.pricing_usdc,
            free: !!r.pricing_free,
          },
        },
        contact: manifest.contact,
      };
    }),
  });
});

app.get("/search/agents", async (c) => {
  const db = c.env.DB;

  const capability = c.req.query("capability");
  const category = c.req.query("category");
  const minReputation = c.req.query("min_reputation");
  const platform = c.req.query("platform");
  const verified = c.req.query("verified");

  let query = "SELECT DISTINCT a.* FROM agents a";
  const conditions: string[] = [];
  const params: any[] = [];

  if (capability || category) {
    query += " JOIN capabilities c ON a.id = c.agent_id";
    if (capability) {
      conditions.push("(c.capability_id LIKE ? OR c.name LIKE ?)");
      params.push(`%${capability}%`, `%${capability}%`);
    }
    if (category) {
      conditions.push("c.category = ?");
      params.push(category);
    }
  }

  if (minReputation) {
    conditions.push("a.reputation_score >= ?");
    params.push(parseInt(minReputation));
  }

  if (platform) {
    conditions.push("a.platform = ?");
    params.push(platform);
  }

  if (verified === "true") {
    conditions.push("a.verified = 1");
  }

  if (conditions.length > 0) {
    query += " WHERE " + conditions.join(" AND ");
  }

  query += " ORDER BY a.reputation_score DESC LIMIT 100";

  const results = await db
    .prepare(query)
    .bind(...params)
    .all();

  return c.json({
    count: results.results?.length || 0,
    results: results.results?.map((r: any) => JSON.parse(r.manifest)),
  });
});

// --- Capabilities ---

app.get("/capabilities", async (c) => {
  const db = c.env.DB;

  const results = await db
    .prepare(
      `SELECT capability_id, name, category, COUNT(*) as providers
       FROM capabilities
       GROUP BY capability_id
       ORDER BY providers DESC`
    )
    .all();

  return c.json({
    count: results.results?.length || 0,
    capabilities: results.results,
  });
});

// --- Tasks ---

app.post("/tasks", async (c) => {
  const db = c.env.DB;

  try {
    const body = await c.req.json();

    if (!body.requester || !body.capability_needed) {
      return c.json({ error: "Missing requester or capability_needed" }, 400);
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    await db
      .prepare(
        `INSERT INTO tasks (id, requester, capability_needed, priority, inputs, bounty_type, bounty_amount, deadline, visibility, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'posted', ?, ?)`
      )
      .bind(
        id,
        body.requester,
        body.capability_needed,
        body.priority || "normal",
        JSON.stringify(body.inputs || {}),
        body.bounty?.type || null,
        body.bounty?.amount || null,
        body.deadline || null,
        body.visibility || "public",
        now,
        now
      )
      .run();

    return c.json(
      {
        success: true,
        message: "Task created 🦀",
        task: { id, ...body, status: "posted", created_at: now },
      },
      201
    );
  } catch (e: any) {
    return c.json({ error: e.message || "Failed to create task" }, 500);
  }
});

app.get("/tasks", async (c) => {
  const db = c.env.DB;

  const status = c.req.query("status");
  const capability = c.req.query("capability");

  let query = "SELECT * FROM tasks";
  const conditions: string[] = [];
  const params: any[] = [];

  if (status) {
    conditions.push("status = ?");
    params.push(status);
  }

  if (capability) {
    conditions.push("capability_needed = ?");
    params.push(capability);
  }

  if (conditions.length > 0) {
    query += " WHERE " + conditions.join(" AND ");
  }

  query += " ORDER BY created_at DESC LIMIT 100";

  const results = await db
    .prepare(query)
    .bind(...params)
    .all();

  return c.json({
    count: results.results?.length || 0,
    tasks: results.results?.map((r: any) => ({
      ...r,
      inputs: JSON.parse(r.inputs || "{}"),
      result: r.result ? JSON.parse(r.result) : null,
    })),
  });
});

app.get("/tasks/:taskId", async (c) => {
  const db = c.env.DB;
  const taskId = c.req.param("taskId");

  const result = await db.prepare("SELECT * FROM tasks WHERE id = ?").bind(taskId).first();

  if (!result) {
    return c.json({ error: "Task not found" }, 404);
  }

  return c.json({
    ...result,
    inputs: JSON.parse((result.inputs as string) || "{}"),
    result: result.result ? JSON.parse(result.result as string) : null,
  });
});

app.patch("/tasks/:taskId", async (c) => {
  const db = c.env.DB;
  const taskId = c.req.param("taskId");

  try {
    const body = await c.req.json();
    const now = new Date().toISOString();

    const updates: string[] = ["updated_at = ?"];
    const params: any[] = [now];

    if (body.status) {
      updates.push("status = ?");
      params.push(body.status);
    }
    if (body.claimed_by) {
      updates.push("claimed_by = ?");
      params.push(body.claimed_by);
    }
    if (body.result) {
      updates.push("result = ?");
      params.push(JSON.stringify(body.result));
    }

    params.push(taskId);

    const result = await db
      .prepare(`UPDATE tasks SET ${updates.join(", ")} WHERE id = ?`)
      .bind(...params)
      .run();

    if (!result.meta.changes) {
      return c.json({ error: "Task not found" }, 404);
    }

    const updated = await db.prepare("SELECT * FROM tasks WHERE id = ?").bind(taskId).first();

    return c.json({
      success: true,
      message: "Task updated",
      task: updated,
    });
  } catch (e: any) {
    return c.json({ error: e.message || "Failed to update task" }, 500);
  }
});

// --- Stats ---

app.get("/stats", async (c) => {
  const db = c.env.DB;

  const agents = await db.prepare("SELECT COUNT(*) as count FROM agents").first();
  const capabilities = await db.prepare("SELECT COUNT(*) as count FROM capabilities").first();
  const tasks = await db.prepare("SELECT COUNT(*) as count FROM tasks").first();

  const byCategory = await db
    .prepare("SELECT category, COUNT(*) as count FROM capabilities GROUP BY category")
    .all();

  const byStatus = await db.prepare("SELECT status, COUNT(*) as count FROM tasks GROUP BY status").all();

  return c.json({
    agents_registered: (agents as any)?.count || 0,
    total_capabilities: (capabilities as any)?.count || 0,
    capabilities_by_category: Object.fromEntries(
      (byCategory.results || []).map((r: any) => [r.category || "other", r.count])
    ),
    tasks: {
      total: (tasks as any)?.count || 0,
      by_status: Object.fromEntries((byStatus.results || []).map((r: any) => [r.status, r.count])),
    },
  });
});

export default app;
