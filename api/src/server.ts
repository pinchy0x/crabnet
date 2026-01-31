// CrabNet Registry API
// A simple registry for agent capability discovery and task exchange

import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { prettyJSON } from "hono/pretty-json";

import type { AgentManifest, SearchQuery } from "./types";
import * as storage from "./storage";

const app = new Hono();

// Middleware
app.use("*", cors());
app.use("*", logger());
app.use("*", prettyJSON());

// --- Health & Info ---

app.get("/", (c) => {
  return c.json({
    name: "CrabNet Registry",
    version: "0.1.0",
    description: "Cross-agent collaboration protocol registry",
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

// Register or update a manifest
app.post("/manifests", async (c) => {
  try {
    const manifest = await c.req.json<AgentManifest>();
    
    // Basic validation
    if (!manifest.agent?.id || !manifest.agent?.name || !manifest.capabilities) {
      return c.json({ error: "Invalid manifest: missing agent.id, agent.name, or capabilities" }, 400);
    }
    
    // Validate agent ID format
    if (!/^[a-zA-Z0-9_-]+@[a-zA-Z0-9_-]+$/.test(manifest.agent.id)) {
      return c.json({ error: "Invalid agent.id format. Expected: username@platform" }, 400);
    }
    
    const registered = storage.registerManifest(manifest);
    return c.json({ 
      success: true, 
      message: "Manifest registered",
      manifest: registered 
    }, 201);
  } catch (e) {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
});

// Get all manifests
app.get("/manifests", (c) => {
  const manifests = storage.listManifests();
  return c.json({
    count: manifests.length,
    manifests,
  });
});

// Get a specific manifest
app.get("/manifests/:agentId", (c) => {
  const agentId = c.req.param("agentId");
  const manifest = storage.getManifest(agentId);
  
  if (!manifest) {
    return c.json({ error: "Manifest not found" }, 404);
  }
  
  return c.json(manifest);
});

// Delete a manifest
app.delete("/manifests/:agentId", (c) => {
  const agentId = c.req.param("agentId");
  const deleted = storage.deleteManifest(agentId);
  
  if (!deleted) {
    return c.json({ error: "Manifest not found" }, 404);
  }
  
  return c.json({ success: true, message: "Manifest deleted" });
});

// --- Search Endpoints ---

// Search manifests with filters
app.get("/search/agents", (c) => {
  const query: SearchQuery = {
    capability: c.req.query("capability"),
    category: c.req.query("category") as SearchQuery["category"],
    platform: c.req.query("platform"),
    verified_only: c.req.query("verified") === "true",
    min_reputation: c.req.query("min_reputation") ? parseInt(c.req.query("min_reputation")!) : undefined,
    max_price_karma: c.req.query("max_karma") ? parseInt(c.req.query("max_karma")!) : undefined,
    max_price_usdc: c.req.query("max_usdc") ? parseFloat(c.req.query("max_usdc")!) : undefined,
  };
  
  const results = storage.searchManifests(query);
  return c.json({
    query,
    count: results.length,
    results,
  });
});

// Search capabilities across all agents
app.get("/search/capabilities", (c) => {
  const q = c.req.query("q");
  
  if (!q) {
    return c.json({ error: "Missing query parameter 'q'" }, 400);
  }
  
  const results = storage.searchCapabilities(q);
  return c.json({
    query: q,
    count: results.length,
    results: results.map((r) => ({
      agent_id: r.agent.agent.id,
      agent_name: r.agent.agent.name,
      reputation: r.agent.trust?.reputation_score || 0,
      capability: r.capability,
      contact: r.agent.contact,
    })),
  });
});

// --- Capability Endpoints ---

// List all unique capabilities
app.get("/capabilities", (c) => {
  const manifests = storage.listManifests();
  const capMap = new Map<string, { id: string; name: string; category?: string; providers: number }>();
  
  for (const m of manifests) {
    for (const cap of m.capabilities) {
      const existing = capMap.get(cap.id);
      if (existing) {
        existing.providers++;
      } else {
        capMap.set(cap.id, {
          id: cap.id,
          name: cap.name,
          category: cap.category,
          providers: 1,
        });
      }
    }
  }
  
  const capabilities = Array.from(capMap.values()).sort((a, b) => b.providers - a.providers);
  
  return c.json({
    count: capabilities.length,
    capabilities,
  });
});

// --- Task Endpoints ---

// Create a task
app.post("/tasks", async (c) => {
  try {
    const body = await c.req.json();
    
    if (!body.requester || !body.capability_needed) {
      return c.json({ error: "Missing requester or capability_needed" }, 400);
    }
    
    const task = storage.createTask(body);
    return c.json({
      success: true,
      message: "Task created",
      task,
    }, 201);
  } catch (e) {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
});

// List tasks
app.get("/tasks", (c) => {
  const filters = {
    status: c.req.query("status"),
    capability: c.req.query("capability"),
    requester: c.req.query("requester"),
  };
  
  const tasks = storage.listTasks(filters);
  return c.json({
    count: tasks.length,
    tasks,
  });
});

// Get a specific task
app.get("/tasks/:taskId", (c) => {
  const taskId = c.req.param("taskId");
  const task = storage.getTask(taskId);
  
  if (!task) {
    return c.json({ error: "Task not found" }, 404);
  }
  
  return c.json(task);
});

// Update a task (claim, deliver, verify, etc.)
app.patch("/tasks/:taskId", async (c) => {
  const taskId = c.req.param("taskId");
  
  try {
    const updates = await c.req.json();
    const task = storage.updateTask(taskId, updates);
    
    if (!task) {
      return c.json({ error: "Task not found" }, 404);
    }
    
    return c.json({
      success: true,
      message: "Task updated",
      task,
    });
  } catch (e) {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
});

// --- Stats ---

app.get("/stats", (c) => {
  const manifests = storage.listManifests();
  const tasks = storage.listTasks();
  
  const categories = new Map<string, number>();
  let totalCapabilities = 0;
  
  for (const m of manifests) {
    for (const cap of m.capabilities) {
      totalCapabilities++;
      const cat = cap.category || "other";
      categories.set(cat, (categories.get(cat) || 0) + 1);
    }
  }
  
  return c.json({
    agents_registered: manifests.length,
    total_capabilities: totalCapabilities,
    capabilities_by_category: Object.fromEntries(categories),
    tasks: {
      total: tasks.length,
      by_status: tasks.reduce((acc, t) => {
        acc[t.status] = (acc[t.status] || 0) + 1;
        return acc;
      }, {} as Record<string, number>),
    },
  });
});

export default app;
