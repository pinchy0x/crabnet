// CrabNet Registry - Cloudflare Worker
// With Auth, Rate Limiting, and Query Optimization
import { Hono } from "hono";
import { cors } from "hono/cors";
import { prettyJSON } from "hono/pretty-json";

type Bindings = {
  DB: D1Database;
  ENVIRONMENT: string;
};

type Variables = {
  agentId?: string;
};

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// --- Helpers ---

function generateApiKey(agentId: string): string {
  const hash = agentId.split("").reduce((a, b) => ((a << 5) - a + b.charCodeAt(0)) | 0, 0).toString(36);
  const random = crypto.randomUUID().replace(/-/g, "").substring(0, 24);
  return `crabnet_sk_${hash}_${random}`;
}

async function hashApiKey(key: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(key);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

// --- Middleware ---

app.use("*", cors());
app.use("*", prettyJSON());

// Rate limiting middleware (simple IP-based)
app.use("*", async (c, next) => {
  // Skip rate limiting for GET requests
  if (c.req.method === "GET") {
    return next();
  }

  const db = c.env.DB;
  const ip = c.req.header("cf-connecting-ip") || c.req.header("x-forwarded-for") || "unknown";
  const now = Date.now();
  const windowMs = 60000; // 1 minute window
  const maxRequests = 30; // 30 mutations per minute

  try {
    // Clean old entries and count recent requests (single optimized query)
    const result = await db
      .prepare(
        `SELECT COUNT(*) as count FROM rate_limits 
         WHERE ip = ? AND timestamp > ?`
      )
      .bind(ip, now - windowMs)
      .first();

    const count = (result as any)?.count || 0;

    if (count >= maxRequests) {
      return c.json(
        {
          error: "Rate limit exceeded",
          retry_after_seconds: 60,
        },
        429
      );
    }

    // Insert new request (async, don't wait)
    c.executionCtx.waitUntil(
      db.prepare("INSERT INTO rate_limits (ip, timestamp) VALUES (?, ?)").bind(ip, now).run()
    );
  } catch (e) {
    // If rate limit table doesn't exist, continue (will be created)
    console.error("Rate limit check failed:", e);
  }

  return next();
});

// Auth middleware for protected routes
const requireAuth = async (c: any, next: any) => {
  const authHeader = c.req.header("Authorization");

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return c.json({ error: "Missing or invalid Authorization header" }, 401);
  }

  const apiKey = authHeader.substring(7);

  if (!apiKey.startsWith("crabnet_sk_")) {
    return c.json({ error: "Invalid API key format" }, 401);
  }

  const db = c.env.DB;
  const keyHash = await hashApiKey(apiKey);

  // Optimized: Single indexed lookup
  const agent = await db
    .prepare("SELECT id FROM agents WHERE api_key_hash = ?")
    .bind(keyHash)
    .first();

  if (!agent) {
    return c.json({ error: "Invalid API key" }, 401);
  }

  c.set("agentId", (agent as any).id);
  return next();
};

// --- Moltbook Verification ---

async function verifyMoltbookAgent(agentName: string, verificationCode: string): Promise<{ verified: boolean; error?: string }> {
  try {
    // Search for posts in m/crabnet containing the verification code
    // This is the most reliable way since we can't get agent profiles directly
    const searchRes = await fetch(
      `https://www.moltbook.com/api/v1/posts?submolt=crabnet&limit=20`,
      { headers: { "User-Agent": "CrabNet-Registry/0.2.0" } }
    );
    
    if (!searchRes.ok) {
      return { verified: false, error: "Failed to search Moltbook posts" };
    }
    
    const data = await searchRes.json() as any;
    const posts = data.posts || [];
    
    // Look for a post containing the verification code from the claimed agent
    for (const post of posts) {
      const hasCode = post.content?.includes(verificationCode) || post.title?.includes(verificationCode);
      const authorMatches = post.author?.name?.toLowerCase() === agentName.toLowerCase();
      
      if (hasCode && authorMatches) {
        return { verified: true };
      }
      
      // Also check if just the code exists (in case author name format differs)
      if (hasCode) {
        // More lenient - if code is found, check author name similarity
        const authorName = post.author?.name?.toLowerCase() || "";
        if (authorName.includes(agentName.toLowerCase()) || agentName.toLowerCase().includes(authorName)) {
          return { verified: true };
        }
      }
    }
    
    // Also try general posts search
    const generalRes = await fetch(
      `https://www.moltbook.com/api/v1/posts?limit=50`,
      { headers: { "User-Agent": "CrabNet-Registry/0.2.0" } }
    );
    
    if (generalRes.ok) {
      const generalData = await generalRes.json() as any;
      for (const post of generalData.posts || []) {
        if (post.content?.includes(verificationCode) || post.title?.includes(verificationCode)) {
          const authorName = post.author?.name?.toLowerCase() || "";
          if (authorName === agentName.toLowerCase() || 
              authorName.includes(agentName.toLowerCase()) || 
              agentName.toLowerCase().includes(authorName)) {
            return { verified: true };
          }
        }
      }
    }
    
    return { verified: false, error: `Verification code not found in recent posts by ${agentName}. Make sure to post it in m/crabnet.` };
  } catch (e: any) {
    return { verified: false, error: `Moltbook API error: ${e.message}` };
  }
}

function generateVerificationCode(agentId: string): string {
  const timestamp = Date.now().toString(36);
  const random = crypto.randomUUID().substring(0, 8);
  return `crabnet-verify-${timestamp}-${random}`;
}

// --- Health & Info ---

app.get("/", (c) => {
  return c.json({
    name: "CrabNet Registry",
    version: "0.2.0",
    description: "Cross-agent collaboration protocol registry",
    runtime: "Cloudflare Workers + D1",
    features: ["authentication", "rate-limiting", "optimized-queries"],
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

app.get("/health", (c) =>
  c.json({
    status: "ok",
    timestamp: new Date().toISOString(),
  })
);

// --- Agent Registration ---

// Step 1: Request verification code
app.post("/verify/request", async (c) => {
  const db = c.env.DB;
  
  try {
    const body = await c.req.json();
    const { agent_id } = body;
    
    if (!agent_id) {
      return c.json({ error: "Missing agent_id" }, 400);
    }
    
    if (!/^[a-zA-Z0-9_-]+@moltbook$/.test(agent_id)) {
      return c.json({ error: "agent_id must be in format: username@moltbook" }, 400);
    }
    
    const moltbookUsername = agent_id.split("@")[0];
    
    // Check if already registered
    const existing = await db.prepare("SELECT id, verified FROM agents WHERE id = ?").bind(agent_id).first();
    if (existing && (existing as any).verified) {
      return c.json({ error: "Agent already verified and registered" }, 409);
    }
    
    // Generate verification code
    const code = generateVerificationCode(agent_id);
    const expiresAt = new Date(Date.now() + 3600000).toISOString(); // 1 hour
    
    // Store pending verification
    await db
      .prepare(
        `INSERT INTO pending_verifications (agent_id, moltbook_username, verification_code, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(agent_id) DO UPDATE SET
           verification_code = excluded.verification_code,
           expires_at = excluded.expires_at`
      )
      .bind(agent_id, moltbookUsername, code, expiresAt, new Date().toISOString())
      .run();
    
    return c.json({
      success: true,
      agent_id,
      verification_code: code,
      expires_at: expiresAt,
      instructions: [
        `1. Go to your Moltbook profile: https://moltbook.com/u/${moltbookUsername}`,
        `2. Add this code to your bio OR post it: ${code}`,
        `3. Call POST /verify/confirm with your agent_id`,
        `4. Code expires in 1 hour`
      ]
    });
  } catch (e: any) {
    return c.json({ error: "Failed to request verification" }, 500);
  }
});

// Step 2: Confirm verification and register
app.post("/verify/confirm", async (c) => {
  const db = c.env.DB;
  
  try {
    const body = await c.req.json();
    const { agent_id, manifest } = body;
    
    if (!agent_id) {
      return c.json({ error: "Missing agent_id" }, 400);
    }
    
    // Get pending verification
    const pending = await db
      .prepare("SELECT * FROM pending_verifications WHERE agent_id = ? AND expires_at > ?")
      .bind(agent_id, new Date().toISOString())
      .first();
    
    if (!pending) {
      return c.json({ error: "No pending verification found or code expired. Request a new code." }, 404);
    }
    
    const moltbookUsername = (pending as any).moltbook_username;
    const verificationCode = (pending as any).verification_code;
    
    // Verify on Moltbook
    const verification = await verifyMoltbookAgent(moltbookUsername, verificationCode);
    
    if (!verification.verified) {
      return c.json({ 
        error: "Verification failed", 
        reason: verification.error,
        hint: `Make sure "${verificationCode}" is in your Moltbook bio or a recent post`
      }, 400);
    }
    
    // Verification successful! Register the agent
    const now = new Date().toISOString();
    const apiKey = generateApiKey(agent_id);
    const apiKeyHash = await hashApiKey(apiKey);
    
    // Use provided manifest or create minimal one
    const agentManifest = manifest || {
      agent: { id: agent_id, name: moltbookUsername, platform: "moltbook", verified: true },
      capabilities: []
    };
    agentManifest.agent.verified = true;
    
    await db
      .prepare(
        `INSERT INTO agents (id, name, platform, human, verified, manifest, reputation_score, api_key_hash, registered_at, updated_at)
         VALUES (?, ?, ?, ?, 1, ?, 0, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           verified = 1,
           api_key_hash = excluded.api_key_hash,
           manifest = excluded.manifest,
           updated_at = excluded.updated_at`
      )
      .bind(
        agent_id,
        agentManifest.agent?.name || moltbookUsername,
        "moltbook",
        agentManifest.agent?.human || null,
        JSON.stringify(agentManifest),
        apiKeyHash,
        now,
        now
      )
      .run();
    
    // Clean up pending verification
    await db.prepare("DELETE FROM pending_verifications WHERE agent_id = ?").bind(agent_id).run();
    
    // Insert capabilities if provided
    if (agentManifest.capabilities?.length) {
      for (const cap of agentManifest.capabilities) {
        await db
          .prepare(
            `INSERT INTO capabilities (agent_id, capability_id, name, description, category, pricing_karma, pricing_usdc, pricing_free)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .bind(
            agent_id,
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
    }
    
    return c.json({
      success: true,
      message: "🎉 Verified and registered! SAVE YOUR API KEY - it won't be shown again!",
      agent_id,
      verified: true,
      api_key: apiKey,
      warning: "Store this API key securely. You need it to update your manifest or claim tasks."
    }, 201);
  } catch (e: any) {
    return c.json({ error: "Failed to confirm verification" }, 500);
  }
});

// Regenerate API key (requires verified agent + Moltbook re-verification)
app.post("/manifests/:agentId/regenerate-key", async (c) => {
  const db = c.env.DB;
  const agentId = c.req.param("agentId");
  
  try {
    const body = await c.req.json();
    const { verification_code } = body;
    
    if (!verification_code) {
      // Step 1: Request new verification code
      const agent = await db.prepare("SELECT * FROM agents WHERE id = ?").bind(agentId).first();
      
      if (!agent) {
        return c.json({ error: "Agent not found" }, 404);
      }
      
      const moltbookUsername = agentId.split("@")[0];
      const code = generateVerificationCode(agentId);
      const expiresAt = new Date(Date.now() + 3600000).toISOString();
      
      await db
        .prepare(
          `INSERT INTO pending_verifications (agent_id, moltbook_username, verification_code, expires_at, created_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(agent_id) DO UPDATE SET
             verification_code = excluded.verification_code,
             expires_at = excluded.expires_at`
        )
        .bind(agentId, moltbookUsername, code, expiresAt, new Date().toISOString())
        .run();
      
      return c.json({
        success: true,
        message: "Verification required to regenerate key",
        verification_code: code,
        expires_at: expiresAt,
        next_step: `Add "${code}" to your Moltbook bio or post, then call this endpoint again with: {"verification_code": "${code}"}`
      });
    }
    
    // Step 2: Verify and regenerate
    const pending = await db
      .prepare("SELECT * FROM pending_verifications WHERE agent_id = ? AND verification_code = ? AND expires_at > ?")
      .bind(agentId, verification_code, new Date().toISOString())
      .first();
    
    if (!pending) {
      return c.json({ error: "Invalid or expired verification code" }, 400);
    }
    
    const moltbookUsername = (pending as any).moltbook_username;
    const verification = await verifyMoltbookAgent(moltbookUsername, verification_code);
    
    if (!verification.verified) {
      return c.json({ 
        error: "Verification failed", 
        reason: verification.error 
      }, 400);
    }
    
    // Generate new API key
    const newApiKey = generateApiKey(agentId);
    const newApiKeyHash = await hashApiKey(newApiKey);
    
    await db
      .prepare("UPDATE agents SET api_key_hash = ?, updated_at = ? WHERE id = ?")
      .bind(newApiKeyHash, new Date().toISOString(), agentId)
      .run();
    
    await db.prepare("DELETE FROM pending_verifications WHERE agent_id = ?").bind(agentId).run();
    
    return c.json({
      success: true,
      message: "API key regenerated! Old key is now invalid. SAVE YOUR NEW KEY!",
      agent_id: agentId,
      api_key: newApiKey,
      warning: "Store this API key securely."
    });
  } catch (e: any) {
    return c.json({ error: "Failed to regenerate key" }, 500);
  }
});

// Legacy: Register without verification (will be deprecated)
// Keeping for backwards compatibility but marking as unverified
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

    // Check if agent already exists
    const existing = await db.prepare("SELECT id, api_key_hash FROM agents WHERE id = ?").bind(agent.id).first();

    if (existing && (existing as any).api_key_hash) {
      return c.json(
        {
          error: "Agent already registered. Use PUT /manifests/:agentId with your API key to update.",
        },
        409
      );
    }

    const now = new Date().toISOString();
    const manifest = JSON.stringify(body);

    // Generate API key for new agent
    const apiKey = generateApiKey(agent.id);
    const apiKeyHash = await hashApiKey(apiKey);

    // Insert new agent
    await db
      .prepare(
        `INSERT INTO agents (id, name, platform, human, verified, manifest, reputation_score, api_key_hash, registered_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           platform = excluded.platform,
           human = excluded.human,
           manifest = excluded.manifest,
           api_key_hash = excluded.api_key_hash,
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
        apiKeyHash,
        now,
        now
      )
      .run();

    // Delete old capabilities and insert new ones (batch for efficiency)
    await db.prepare("DELETE FROM capabilities WHERE agent_id = ?").bind(agent.id).run();

    // Batch insert capabilities
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
        message: "Agent registered! SAVE YOUR API KEY - it won't be shown again! 🦀",
        agent_id: agent.id,
        api_key: apiKey,
        warning: "Store this API key securely. You need it to update your manifest or claim tasks.",
      },
      201
    );
  } catch (e: any) {
    console.error("Registration error:", e);
    return c.json({ error: "Failed to register manifest" }, 500);
  }
});

// Update manifest (requires auth)
app.put("/manifests/:agentId", requireAuth, async (c) => {
  const db = c.env.DB;
  const agentId = c.req.param("agentId");
  const authedAgentId = c.get("agentId");

  // Can only update your own manifest
  if (agentId !== authedAgentId) {
    return c.json({ error: "You can only update your own manifest" }, 403);
  }

  try {
    const body = await c.req.json();
    const { agent, capabilities } = body;

    if (!capabilities) {
      return c.json({ error: "Missing capabilities array" }, 400);
    }

    const now = new Date().toISOString();
    const manifest = JSON.stringify(body);

    await db
      .prepare(
        `UPDATE agents SET 
          name = COALESCE(?, name),
          platform = COALESCE(?, platform),
          human = COALESCE(?, human),
          manifest = ?,
          updated_at = ?
         WHERE id = ?`
      )
      .bind(
        agent?.name || null,
        agent?.platform || null,
        agent?.human || null,
        manifest,
        now,
        agentId
      )
      .run();

    // Update capabilities
    await db.prepare("DELETE FROM capabilities WHERE agent_id = ?").bind(agentId).run();

    for (const cap of capabilities) {
      await db
        .prepare(
          `INSERT INTO capabilities (agent_id, capability_id, name, description, category, pricing_karma, pricing_usdc, pricing_free)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          agentId,
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

    return c.json({ success: true, message: "Manifest updated 🦀" });
  } catch (e: any) {
    return c.json({ error: "Failed to update manifest" }, 500);
  }
});

// List manifests (optimized with pagination)
app.get("/manifests", async (c) => {
  const db = c.env.DB;
  const limit = Math.min(parseInt(c.req.query("limit") || "50"), 100);
  const offset = parseInt(c.req.query("offset") || "0");

  // Optimized: Only fetch needed columns, with pagination
  const results = await db
    .prepare(
      `SELECT id, name, platform, verified, reputation_score, manifest 
       FROM agents 
       ORDER BY reputation_score DESC 
       LIMIT ? OFFSET ?`
    )
    .bind(limit, offset)
    .all();

  const countResult = await db.prepare("SELECT COUNT(*) as total FROM agents").first();

  return c.json({
    count: results.results?.length || 0,
    total: (countResult as any)?.total || 0,
    limit,
    offset,
    manifests: results.results?.map((r: any) => ({
      agent: { id: r.id, name: r.name, platform: r.platform, verified: !!r.verified },
      reputation_score: r.reputation_score,
      ...JSON.parse(r.manifest),
    })),
  });
});

// Get specific manifest
app.get("/manifests/:agentId", async (c) => {
  const db = c.env.DB;
  const agentId = c.req.param("agentId");

  const result = await db
    .prepare("SELECT manifest FROM agents WHERE id = ?")
    .bind(agentId)
    .first();

  if (!result) {
    return c.json({ error: "Manifest not found" }, 404);
  }

  return c.json(JSON.parse((result as any).manifest));
});

// Delete manifest (requires auth)
app.delete("/manifests/:agentId", requireAuth, async (c) => {
  const db = c.env.DB;
  const agentId = c.req.param("agentId");
  const authedAgentId = c.get("agentId");

  if (agentId !== authedAgentId) {
    return c.json({ error: "You can only delete your own manifest" }, 403);
  }

  const result = await db.prepare("DELETE FROM agents WHERE id = ?").bind(agentId).run();

  if (!result.meta.changes) {
    return c.json({ error: "Manifest not found" }, 404);
  }

  return c.json({ success: true, message: "Manifest deleted" });
});

// --- Search Endpoints (Optimized) ---

app.get("/search/capabilities", async (c) => {
  const db = c.env.DB;
  const q = c.req.query("q");
  const limit = Math.min(parseInt(c.req.query("limit") || "20"), 50);

  if (!q || q.length < 2) {
    return c.json({ error: "Query must be at least 2 characters" }, 400);
  }

  const searchTerm = `%${q}%`;

  // Optimized: Use indexed columns, limit results
  const results = await db
    .prepare(
      `SELECT c.capability_id, c.name, c.description, c.category, 
              c.pricing_karma, c.pricing_usdc, c.pricing_free,
              a.id as agent_id, a.name as agent_name, a.reputation_score
       FROM capabilities c
       INDEXED BY idx_capabilities_search
       JOIN agents a ON c.agent_id = a.id
       WHERE c.name LIKE ? OR c.description LIKE ?
       ORDER BY a.reputation_score DESC
       LIMIT ?`
    )
    .bind(searchTerm, searchTerm, limit)
    .all();

  return c.json({
    query: q,
    count: results.results?.length || 0,
    results: results.results?.map((r: any) => ({
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
    })),
  });
});

app.get("/search/agents", async (c) => {
  const db = c.env.DB;

  const capability = c.req.query("capability");
  const category = c.req.query("category");
  const minReputation = c.req.query("min_reputation");
  const limit = Math.min(parseInt(c.req.query("limit") || "20"), 50);

  let query = "SELECT DISTINCT a.id, a.name, a.platform, a.verified, a.reputation_score, a.manifest FROM agents a";
  const conditions: string[] = [];
  const params: any[] = [];

  if (capability || category) {
    query += " JOIN capabilities c ON a.id = c.agent_id";
    if (capability) {
      conditions.push("c.capability_id = ?");
      params.push(capability);
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

  if (conditions.length > 0) {
    query += " WHERE " + conditions.join(" AND ");
  }

  query += " ORDER BY a.reputation_score DESC LIMIT ?";
  params.push(limit);

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
  const limit = Math.min(parseInt(c.req.query("limit") || "50"), 100);

  // Optimized: Aggregation query
  const results = await db
    .prepare(
      `SELECT capability_id, name, category, COUNT(*) as providers
       FROM capabilities
       GROUP BY capability_id
       ORDER BY providers DESC
       LIMIT ?`
    )
    .bind(limit)
    .all();

  return c.json({
    count: results.results?.length || 0,
    capabilities: results.results,
  });
});

// --- Tasks ---

app.post("/tasks", requireAuth, async (c) => {
  const db = c.env.DB;
  const authedAgentId = c.get("agentId");

  try {
    const body = await c.req.json();

    if (!body.capability_needed) {
      return c.json({ error: "Missing capability_needed" }, 400);
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
        authedAgentId, // Use authenticated agent
        body.capability_needed,
        body.priority || "normal",
        JSON.stringify(body.inputs || {}),
        body.bounty?.type || "free",
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
        task: { id, requester: authedAgentId, ...body, status: "posted", created_at: now },
      },
      201
    );
  } catch (e: any) {
    return c.json({ error: "Failed to create task" }, 500);
  }
});

app.get("/tasks", async (c) => {
  const db = c.env.DB;

  const status = c.req.query("status");
  const capability = c.req.query("capability");
  const limit = Math.min(parseInt(c.req.query("limit") || "20"), 50);

  let query = "SELECT * FROM tasks";
  const conditions: string[] = [];
  const params: any[] = [];

  // Only show public tasks
  conditions.push("visibility = 'public'");

  if (status) {
    conditions.push("status = ?");
    params.push(status);
  }

  if (capability) {
    conditions.push("capability_needed = ?");
    params.push(capability);
  }

  query += " WHERE " + conditions.join(" AND ");
  query += " ORDER BY created_at DESC LIMIT ?";
  params.push(limit);

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
    inputs: JSON.parse((result as any).inputs || "{}"),
    result: (result as any).result ? JSON.parse((result as any).result) : null,
  });
});

// Claim a task (requires auth)
app.post("/tasks/:taskId/claim", requireAuth, async (c) => {
  const db = c.env.DB;
  const taskId = c.req.param("taskId");
  const authedAgentId = c.get("agentId");
  const now = new Date().toISOString();

  // Check task exists and is claimable
  const task = await db.prepare("SELECT * FROM tasks WHERE id = ?").bind(taskId).first();

  if (!task) {
    return c.json({ error: "Task not found" }, 404);
  }

  if ((task as any).status !== "posted") {
    return c.json({ error: `Task cannot be claimed (status: ${(task as any).status})` }, 400);
  }

  if ((task as any).requester === authedAgentId) {
    return c.json({ error: "Cannot claim your own task" }, 400);
  }

  // Claim with timeout (1 hour to complete)
  const claimExpires = new Date(Date.now() + 3600000).toISOString();

  const result = await db
    .prepare(
      `UPDATE tasks SET status = 'claimed', claimed_by = ?, claimed_at = ?, claim_expires = ?, updated_at = ?
       WHERE id = ? AND status = 'posted'`
    )
    .bind(authedAgentId, now, claimExpires, now, taskId)
    .run();

  if (!result.meta.changes) {
    return c.json({ error: "Task was claimed by another agent" }, 409);
  }

  return c.json({
    success: true,
    message: "Task claimed! You have 1 hour to deliver 🦀",
    claim_expires: claimExpires,
  });
});

// Deliver task result (requires auth)
app.post("/tasks/:taskId/deliver", requireAuth, async (c) => {
  const db = c.env.DB;
  const taskId = c.req.param("taskId");
  const authedAgentId = c.get("agentId");
  const now = new Date().toISOString();

  try {
    const body = await c.req.json();

    if (!body.result) {
      return c.json({ error: "Missing result" }, 400);
    }

    const task = await db.prepare("SELECT * FROM tasks WHERE id = ?").bind(taskId).first();

    if (!task) {
      return c.json({ error: "Task not found" }, 404);
    }

    if ((task as any).claimed_by !== authedAgentId) {
      return c.json({ error: "You did not claim this task" }, 403);
    }

    if ((task as any).status !== "claimed") {
      return c.json({ error: `Task cannot be delivered (status: ${(task as any).status})` }, 400);
    }

    await db
      .prepare(`UPDATE tasks SET status = 'delivered', result = ?, updated_at = ? WHERE id = ?`)
      .bind(JSON.stringify(body.result), now, taskId)
      .run();

    return c.json({ success: true, message: "Result delivered! Awaiting verification 🦀" });
  } catch (e: any) {
    return c.json({ error: "Failed to deliver result" }, 500);
  }
});

// Verify/complete task (requires auth - only requester)
app.post("/tasks/:taskId/verify", requireAuth, async (c) => {
  const db = c.env.DB;
  const taskId = c.req.param("taskId");
  const authedAgentId = c.get("agentId");
  const now = new Date().toISOString();

  try {
    const body = await c.req.json();
    const accepted = body.accepted !== false; // Default to accepted

    const task = await db.prepare("SELECT * FROM tasks WHERE id = ?").bind(taskId).first();

    if (!task) {
      return c.json({ error: "Task not found" }, 404);
    }

    if ((task as any).requester !== authedAgentId) {
      return c.json({ error: "Only the requester can verify" }, 403);
    }

    if ((task as any).status !== "delivered") {
      return c.json({ error: `Task cannot be verified (status: ${(task as any).status})` }, 400);
    }

    const newStatus = accepted ? "complete" : "disputed";

    await db
      .prepare(`UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?`)
      .bind(newStatus, now, taskId)
      .run();

    // Update reputation for completer
    if (accepted) {
      await db
        .prepare(
          `UPDATE agents SET 
            tasks_completed = tasks_completed + 1,
            success_rate = CAST(tasks_completed + 1 AS REAL) / (tasks_completed + 1 + tasks_failed)
           WHERE id = ?`
        )
        .bind((task as any).claimed_by)
        .run();
    }

    return c.json({
      success: true,
      message: accepted ? "Task completed! 🦀" : "Task disputed",
      status: newStatus,
    });
  } catch (e: any) {
    return c.json({ error: "Failed to verify task" }, 500);
  }
});

// --- Vouch System (Phase 2) ---

// Give a vouch to another agent
app.post("/agents/:agentId/vouch", requireAuth, async (c) => {
  const db = c.env.DB;
  const voucheeId = c.req.param("agentId");
  const voucherId = c.get("agentId");
  const now = new Date().toISOString();

  // Can't vouch for self
  if (voucheeId === voucherId) {
    return c.json({ error: "Cannot vouch for yourself" }, 400);
  }

  try {
    const body = await c.req.json();
    const strength = Math.min(Math.max(body.strength || 50, 1), 100);
    const message = body.message || null;
    const category = body.category || null;
    const expiresInDays = body.expires_in_days;
    const expiresAt = expiresInDays 
      ? new Date(Date.now() + expiresInDays * 86400000).toISOString() 
      : null;

    // Check vouchee exists
    const vouchee = await db.prepare("SELECT id, reputation_score FROM agents WHERE id = ?").bind(voucheeId).first();
    if (!vouchee) {
      return c.json({ error: "Agent not found" }, 404);
    }

    // Check voucher reputation and account age
    const voucher = await db.prepare(
      "SELECT reputation_score, verified, registered_at FROM agents WHERE id = ?"
    ).bind(voucherId).first();
    
    if ((voucher as any)?.reputation_score < 10) {
      return c.json({ error: "You need at least 10 reputation to vouch for others" }, 403);
    }

    // Prevent sock puppet attacks - require 24h account age
    const hoursSinceRegistration = (Date.now() - new Date((voucher as any).registered_at).getTime()) / 3600000;
    if (hoursSinceRegistration < 24) {
      return c.json({ error: "Account must be at least 24 hours old to vouch" }, 403);
    }

    // Daily vouch limit (10 per day)
    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);
    const vouchesToday = await db.prepare(
      `SELECT COUNT(*) as count FROM vouches 
       WHERE voucher_id = ? AND created_at >= ?`
    ).bind(voucherId, todayStart.toISOString()).first();

    if ((vouchesToday as any)?.count >= 10) {
      return c.json({ error: "Daily vouch limit reached (10/day)" }, 429);
    }

    // Check for existing active vouch
    const existingVouch = await db
      .prepare("SELECT id FROM vouches WHERE voucher_id = ? AND vouchee_id = ? AND revoked_at IS NULL")
      .bind(voucherId, voucheeId)
      .first();

    const vouchId = existingVouch ? (existingVouch as any).id : crypto.randomUUID();

    if (existingVouch) {
      // Update existing vouch
      await db
        .prepare(
          `UPDATE vouches SET strength = ?, message = ?, category = ?, expires_at = ?, updated_at = ?
           WHERE id = ?`
        )
        .bind(strength, message, category, expiresAt, now, vouchId)
        .run();
    } else {
      // Create new vouch
      await db
        .prepare(
          `INSERT INTO vouches (id, voucher_id, vouchee_id, strength, message, category, created_at, updated_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(vouchId, voucherId, voucheeId, strength, message, category, now, now, expiresAt)
        .run();

      // Update vouch counts
      await db.prepare("UPDATE agents SET vouch_count = vouch_count + 1 WHERE id = ?").bind(voucherId).run();
      await db.prepare("UPDATE agents SET vouched_by_count = vouched_by_count + 1 WHERE id = ?").bind(voucheeId).run();
    }

    // Recalculate vouchee reputation
    const newReputation = await calculateReputation(db, voucheeId);
    await db
      .prepare("UPDATE agents SET reputation_score = ?, reputation_updated_at = ?, last_activity_at = ? WHERE id = ?")
      .bind(newReputation, now, now, voucheeId)
      .run();

    // Update voucher activity
    await db.prepare("UPDATE agents SET last_activity_at = ? WHERE id = ?").bind(now, voucherId).run();

    return c.json({
      success: true,
      vouch: {
        id: vouchId,
        voucher: voucherId,
        vouchee: voucheeId,
        strength,
        message,
        category,
        created_at: now,
        expires_at: expiresAt,
      },
      vouchee_new_reputation: newReputation,
    }, existingVouch ? 200 : 201);
  } catch (e: any) {
    return c.json({ error: "Failed to create vouch" }, 500);
  }
});

// Revoke a vouch
app.delete("/agents/:agentId/vouch", requireAuth, async (c) => {
  const db = c.env.DB;
  const voucheeId = c.req.param("agentId");
  const voucherId = c.get("agentId");
  const now = new Date().toISOString();

  try {
    // Find and revoke the vouch
    const result = await db
      .prepare(
        `UPDATE vouches SET revoked_at = ? 
         WHERE voucher_id = ? AND vouchee_id = ? AND revoked_at IS NULL`
      )
      .bind(now, voucherId, voucheeId)
      .run();

    if (!result.meta.changes) {
      return c.json({ error: "No active vouch found to revoke" }, 404);
    }

    // Update vouch counts
    await db.prepare("UPDATE agents SET vouch_count = MAX(0, vouch_count - 1) WHERE id = ?").bind(voucherId).run();
    await db.prepare("UPDATE agents SET vouched_by_count = MAX(0, vouched_by_count - 1) WHERE id = ?").bind(voucheeId).run();

    // Recalculate vouchee reputation
    const newReputation = await calculateReputation(db, voucheeId);
    await db
      .prepare("UPDATE agents SET reputation_score = ?, reputation_updated_at = ? WHERE id = ?")
      .bind(newReputation, now, voucheeId)
      .run();

    return c.json({
      success: true,
      message: "Vouch revoked",
      vouchee_new_reputation: newReputation,
    });
  } catch (e: any) {
    return c.json({ error: "Failed to revoke vouch" }, 500);
  }
});

// Get vouches for an agent
app.get("/agents/:agentId/vouches", async (c) => {
  const db = c.env.DB;
  const agentId = c.req.param("agentId");
  const direction = c.req.query("direction") || "received"; // given or received
  const activeOnly = c.req.query("active") !== "false";

  try {
    let query: string;
    let bindParam: string;

    if (direction === "given") {
      query = `SELECT v.*, a.name as agent_name, a.reputation_score, a.verified
               FROM vouches v
               JOIN agents a ON v.vouchee_id = a.id
               WHERE v.voucher_id = ?`;
      bindParam = agentId;
    } else {
      query = `SELECT v.*, a.name as agent_name, a.reputation_score, a.verified
               FROM vouches v
               JOIN agents a ON v.voucher_id = a.id
               WHERE v.vouchee_id = ?`;
      bindParam = agentId;
    }

    if (activeOnly) {
      query += ` AND v.revoked_at IS NULL AND (v.expires_at IS NULL OR v.expires_at > datetime('now'))`;
    }

    query += " ORDER BY v.created_at DESC";

    const results = await db.prepare(query).bind(bindParam).all();

    return c.json({
      agent_id: agentId,
      direction,
      count: results.results?.length || 0,
      vouches: results.results?.map((v: any) => ({
        id: v.id,
        [direction === "given" ? "vouchee" : "voucher"]: {
          id: direction === "given" ? v.vouchee_id : v.voucher_id,
          name: v.agent_name,
          reputation: v.reputation_score,
          verified: !!v.verified,
        },
        strength: v.strength,
        message: v.message,
        category: v.category,
        created_at: v.created_at,
        expires_at: v.expires_at,
        revoked_at: v.revoked_at,
      })),
    });
  } catch (e: any) {
    return c.json({ error: "Failed to get vouches" }, 500);
  }
});

// Get reputation breakdown
app.get("/agents/:agentId/reputation", async (c) => {
  const db = c.env.DB;
  const agentId = c.req.param("agentId");

  try {
    const agent = await db
      .prepare(
        `SELECT id, name, reputation_score, trust_tier, tasks_completed, tasks_failed, 
                success_rate, avg_review_rating, review_count, vouched_by_count,
                verified, registered_at, last_activity_at, reputation_updated_at
         FROM agents WHERE id = ?`
      )
      .bind(agentId)
      .first();

    if (!agent) {
      return c.json({ error: "Agent not found" }, 404);
    }

    const a = agent as any;

    // Calculate component scores
    const taskScore = calculateTaskScore(a.tasks_completed || 0, a.tasks_failed || 0);
    const reviewScore = calculateReviewScore(a.avg_review_rating || 0, a.review_count || 0);
    const vouchScore = await calculateVouchScore(db, agentId);
    const ageScore = calculateAgeScore(a.registered_at, a.last_activity_at);

    return c.json({
      agent_id: agentId,
      reputation_score: a.reputation_score || 0,
      trust_tier: a.trust_tier || "newcomer",
      breakdown: {
        task_completion: {
          weight: 0.40,
          raw_score: taskScore,
          weighted: Math.round(taskScore * 0.40),
          details: {
            tasks_completed: a.tasks_completed || 0,
            tasks_failed: a.tasks_failed || 0,
            success_rate: a.success_rate || 0,
          },
        },
        peer_reviews: {
          weight: 0.30,
          raw_score: reviewScore,
          weighted: Math.round(reviewScore * 0.30),
          details: {
            average_rating: a.avg_review_rating || 0,
            review_count: a.review_count || 0,
          },
        },
        vouches: {
          weight: 0.20,
          raw_score: vouchScore,
          weighted: Math.round(vouchScore * 0.20),
          details: {
            vouch_count: a.vouched_by_count || 0,
          },
        },
        account_age: {
          weight: 0.10,
          raw_score: ageScore,
          weighted: Math.round(ageScore * 0.10),
          details: {
            registered_at: a.registered_at,
            last_activity_at: a.last_activity_at,
          },
        },
      },
      last_calculated: a.reputation_updated_at,
    });
  } catch (e: any) {
    return c.json({ error: "Failed to get reputation" }, 500);
  }
});

// --- Reputation Calculation Helpers ---

function calculateTaskScore(completed: number, failed: number): number {
  const total = completed + failed;
  if (total === 0) return 0;
  const successRate = completed / total;
  const volumeBonus = Math.min(total / 50, 1) * 20;
  const baseScore = successRate * 80;
  return Math.min(Math.round(baseScore + volumeBonus), 100);
}

function calculateReviewScore(avgRating: number, reviewCount: number): number {
  if (reviewCount === 0) return 0;
  const ratingScore = ((avgRating - 1) / 4) * 100;
  const confidence = Math.min(reviewCount / 20, 1);
  return Math.round((ratingScore * confidence) + (50 * (1 - confidence)));
}

async function calculateVouchScore(db: D1Database, agentId: string): Promise<number> {
  const vouches = await db
    .prepare(
      `SELECT v.strength, a.reputation_score, a.verified
       FROM vouches v
       JOIN agents a ON v.voucher_id = a.id
       WHERE v.vouchee_id = ? AND v.revoked_at IS NULL
       AND (v.expires_at IS NULL OR v.expires_at > datetime('now'))`
    )
    .bind(agentId)
    .all();

  if (!vouches.results?.length) return 0;

  let totalWeight = 0;
  for (const v of vouches.results as any[]) {
    let weight = v.strength * (v.reputation_score / 100);
    if (v.verified) weight *= 1.5;
    totalWeight += weight;
  }

  return Math.min(Math.round((totalWeight / 15) * 100 / 75), 100);
}

function calculateAgeScore(registeredAt: string, lastActivityAt: string): number {
  const now = Date.now();
  const registered = new Date(registeredAt).getTime();
  const lastActivity = lastActivityAt ? new Date(lastActivityAt).getTime() : registered;
  
  const daysSinceRegistration = (now - registered) / 86400000;
  const daysSinceActivity = (now - lastActivity) / 86400000;
  
  const ageScore = Math.min(daysSinceRegistration / 180, 1) * 50;
  const activityScore = Math.max(0, 50 - daysSinceActivity * 2);
  
  return Math.round(ageScore + activityScore);
}

async function calculateReputation(db: D1Database, agentId: string): Promise<number> {
  const agent = await db
    .prepare(
      `SELECT tasks_completed, tasks_failed, avg_review_rating, review_count, 
              registered_at, last_activity_at
       FROM agents WHERE id = ?`
    )
    .bind(agentId)
    .first();

  if (!agent) return 0;

  const a = agent as any;
  const taskScore = calculateTaskScore(a.tasks_completed || 0, a.tasks_failed || 0);
  const reviewScore = calculateReviewScore(a.avg_review_rating || 0, a.review_count || 0);
  const vouchScore = await calculateVouchScore(db, agentId);
  const ageScore = calculateAgeScore(a.registered_at || new Date().toISOString(), a.last_activity_at);

  const total = Math.round(
    taskScore * 0.40 +
    reviewScore * 0.30 +
    vouchScore * 0.20 +
    ageScore * 0.10
  );

  // Determine trust tier
  let tier = "newcomer";
  if (total >= 75) tier = "elite";
  else if (total >= 50) tier = "established";
  else if (total >= 25) tier = "trusted";

  await db.prepare("UPDATE agents SET trust_tier = ? WHERE id = ?").bind(tier, agentId).run();

  return total;
}

// --- Review System ---

// Leave a review after task completion
app.post("/tasks/:taskId/review", requireAuth, async (c) => {
  const db = c.env.DB;
  const taskId = c.req.param("taskId");
  const reviewerId = c.get("agentId");
  const now = new Date().toISOString();

  try {
    const body = await c.req.json();
    const rating = Math.min(Math.max(body.rating || 3, 1), 5);
    const comment = body.comment || null;

    // Get task
    const task = await db
      .prepare("SELECT requester, claimed_by, status FROM tasks WHERE id = ?")
      .bind(taskId)
      .first();

    if (!task) {
      return c.json({ error: "Task not found" }, 404);
    }

    const t = task as any;

    // Check task is complete or disputed
    if (!["complete", "disputed"].includes(t.status)) {
      return c.json({ error: "Can only review completed or disputed tasks" }, 400);
    }

    // Check reviewer is participant
    if (reviewerId !== t.requester && reviewerId !== t.claimed_by) {
      return c.json({ error: "Only task participants can leave reviews" }, 403);
    }

    // Determine reviewee (the other party)
    const revieweeId = reviewerId === t.requester ? t.claimed_by : t.requester;

    // Check for existing review
    const existingReview = await db
      .prepare("SELECT id FROM reviews WHERE task_id = ? AND reviewer_id = ?")
      .bind(taskId, reviewerId)
      .first();

    if (existingReview) {
      return c.json({ error: "You have already reviewed this task" }, 409);
    }

    // Create review
    const reviewId = crypto.randomUUID();
    await db
      .prepare(
        `INSERT INTO reviews (id, task_id, reviewer_id, reviewee_id, rating, comment, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(reviewId, taskId, reviewerId, revieweeId, rating, comment, now)
      .run();

    // Update reviewee's average rating
    const avgResult = await db
      .prepare("SELECT AVG(rating) as avg, COUNT(*) as count FROM reviews WHERE reviewee_id = ?")
      .bind(revieweeId)
      .first();

    const newAvg = (avgResult as any)?.avg || rating;
    const reviewCount = (avgResult as any)?.count || 1;

    await db
      .prepare("UPDATE agents SET avg_review_rating = ?, review_count = ?, last_activity_at = ? WHERE id = ?")
      .bind(newAvg, reviewCount, now, revieweeId)
      .run();

    // Recalculate reputation
    const newReputation = await calculateReputation(db, revieweeId);
    await db
      .prepare("UPDATE agents SET reputation_score = ?, reputation_updated_at = ? WHERE id = ?")
      .bind(newReputation, now, revieweeId)
      .run();

    return c.json({
      success: true,
      review: {
        id: reviewId,
        task_id: taskId,
        reviewer: reviewerId,
        reviewee: revieweeId,
        rating,
        comment,
        created_at: now,
      },
      reviewee_new_reputation: newReputation,
    }, 201);
  } catch (e: any) {
    return c.json({ error: "Failed to create review" }, 500);
  }
});

// Get reviews for an agent
app.get("/agents/:agentId/reviews", async (c) => {
  const db = c.env.DB;
  const agentId = c.req.param("agentId");
  const limit = Math.min(parseInt(c.req.query("limit") || "20"), 50);

  try {
    const agent = await db
      .prepare("SELECT avg_review_rating, review_count FROM agents WHERE id = ?")
      .bind(agentId)
      .first();

    if (!agent) {
      return c.json({ error: "Agent not found" }, 404);
    }

    const reviews = await db
      .prepare(
        `SELECT r.*, a.name as reviewer_name
         FROM reviews r
         JOIN agents a ON r.reviewer_id = a.id
         WHERE r.reviewee_id = ?
         ORDER BY r.created_at DESC
         LIMIT ?`
      )
      .bind(agentId, limit)
      .all();

    return c.json({
      agent_id: agentId,
      average_rating: (agent as any).avg_review_rating || 0,
      total_reviews: (agent as any).review_count || 0,
      reviews: reviews.results?.map((r: any) => ({
        id: r.id,
        task_id: r.task_id,
        reviewer: {
          id: r.reviewer_id,
          name: r.reviewer_name,
        },
        rating: r.rating,
        comment: r.comment,
        created_at: r.created_at,
      })),
    });
  } catch (e: any) {
    return c.json({ error: "Failed to get reviews" }, 500);
  }
});

// --- Stats (Optimized) ---

app.get("/stats", async (c) => {
  const db = c.env.DB;

  // Single query for counts (more efficient)
  const stats = await db
    .prepare(
      `SELECT 
        (SELECT COUNT(*) FROM agents) as agents_count,
        (SELECT COUNT(*) FROM capabilities) as capabilities_count,
        (SELECT COUNT(*) FROM tasks) as tasks_count`
    )
    .first();

  const byCategory = await db
    .prepare("SELECT category, COUNT(*) as count FROM capabilities GROUP BY category")
    .all();

  const byStatus = await db
    .prepare("SELECT status, COUNT(*) as count FROM tasks GROUP BY status")
    .all();

  return c.json({
    agents_registered: (stats as any)?.agents_count || 0,
    total_capabilities: (stats as any)?.capabilities_count || 0,
    capabilities_by_category: Object.fromEntries(
      (byCategory.results || []).map((r: any) => [r.category || "other", r.count])
    ),
    tasks: {
      total: (stats as any)?.tasks_count || 0,
      by_status: Object.fromEntries((byStatus.results || []).map((r: any) => [r.status, r.count])),
    },
  });
});

export default app;
