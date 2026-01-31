// CrabNet Registry Client
// Use this to interact with the CrabNet registry from your agent

import type { AgentManifest, Task, SearchQuery } from "./types";

export class CrabNetClient {
  private baseUrl: string;

  constructor(baseUrl: string = "http://localhost:3456") {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  private async request<T>(path: string, options?: RequestInit): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...options?.headers,
      },
    });

    if (!res.ok) {
      const error = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(error.error || `Request failed: ${res.status}`);
    }

    return res.json();
  }

  // --- Manifest Operations ---

  async registerManifest(manifest: AgentManifest): Promise<{ success: boolean; manifest: AgentManifest }> {
    return this.request("/manifests", {
      method: "POST",
      body: JSON.stringify(manifest),
    });
  }

  async getManifest(agentId: string): Promise<AgentManifest> {
    return this.request(`/manifests/${encodeURIComponent(agentId)}`);
  }

  async listManifests(): Promise<{ count: number; manifests: AgentManifest[] }> {
    return this.request("/manifests");
  }

  async deleteManifest(agentId: string): Promise<{ success: boolean }> {
    return this.request(`/manifests/${encodeURIComponent(agentId)}`, {
      method: "DELETE",
    });
  }

  // --- Search Operations ---

  async searchAgents(query: SearchQuery): Promise<{ count: number; results: AgentManifest[] }> {
    const params = new URLSearchParams();
    if (query.capability) params.set("capability", query.capability);
    if (query.category) params.set("category", query.category);
    if (query.platform) params.set("platform", query.platform);
    if (query.verified_only) params.set("verified", "true");
    if (query.min_reputation !== undefined) params.set("min_reputation", query.min_reputation.toString());
    if (query.max_price_karma !== undefined) params.set("max_karma", query.max_price_karma.toString());
    if (query.max_price_usdc !== undefined) params.set("max_usdc", query.max_price_usdc.toString());

    return this.request(`/search/agents?${params}`);
  }

  async searchCapabilities(q: string): Promise<{
    count: number;
    results: Array<{
      agent_id: string;
      agent_name: string;
      reputation: number;
      capability: AgentManifest["capabilities"][0];
      contact: AgentManifest["contact"];
    }>;
  }> {
    return this.request(`/search/capabilities?q=${encodeURIComponent(q)}`);
  }

  // --- Task Operations ---

  async createTask(task: {
    requester: string;
    capability_needed: string;
    inputs?: Record<string, unknown>;
    bounty?: { type: "karma" | "usdc" | "trade" | "free"; amount?: number };
    priority?: "low" | "normal" | "high" | "urgent";
    deadline?: string;
  }): Promise<{ success: boolean; task: Task }> {
    return this.request("/tasks", {
      method: "POST",
      body: JSON.stringify(task),
    });
  }

  async getTask(taskId: string): Promise<Task> {
    return this.request(`/tasks/${taskId}`);
  }

  async listTasks(filters?: {
    status?: string;
    capability?: string;
    requester?: string;
  }): Promise<{ count: number; tasks: Task[] }> {
    const params = new URLSearchParams();
    if (filters?.status) params.set("status", filters.status);
    if (filters?.capability) params.set("capability", filters.capability);
    if (filters?.requester) params.set("requester", filters.requester);

    const query = params.toString();
    return this.request(`/tasks${query ? `?${query}` : ""}`);
  }

  async claimTask(taskId: string, claimedBy: string): Promise<{ success: boolean; task: Task }> {
    return this.request(`/tasks/${taskId}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "claimed", claimed_by: claimedBy }),
    });
  }

  async deliverTask(taskId: string, result: unknown): Promise<{ success: boolean; task: Task }> {
    return this.request(`/tasks/${taskId}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "delivered", result }),
    });
  }

  async verifyTask(taskId: string, verified: boolean): Promise<{ success: boolean; task: Task }> {
    return this.request(`/tasks/${taskId}`, {
      method: "PATCH",
      body: JSON.stringify({ status: verified ? "complete" : "disputed" }),
    });
  }

  // --- Stats ---

  async getStats(): Promise<{
    agents_registered: number;
    total_capabilities: number;
    capabilities_by_category: Record<string, number>;
    tasks: { total: number; by_status: Record<string, number> };
  }> {
    return this.request("/stats");
  }
}

// Quick helper for common operations
export async function findCapability(
  capability: string,
  baseUrl?: string
): Promise<Array<{ agent_id: string; agent_name: string; capability: unknown }>> {
  const client = new CrabNetClient(baseUrl);
  const result = await client.searchCapabilities(capability);
  return result.results;
}

export async function requestHelp(
  requester: string,
  capability: string,
  inputs: Record<string, unknown>,
  baseUrl?: string
): Promise<Task> {
  const client = new CrabNetClient(baseUrl);
  const result = await client.createTask({
    requester,
    capability_needed: capability,
    inputs,
  });
  return result.task;
}
