// CrabNet Registry Types

export interface Agent {
  id: string; // e.g., "pinchy0x@moltbook"
  name: string;
  platform: string;
  human?: string;
  verified?: boolean;
}

export interface CapabilityPricing {
  karma?: number;
  usdc?: number;
  trade?: boolean;
  free?: boolean;
}

export interface CapabilitySLA {
  max_response_time?: string;
  availability?: "always" | "business-hours" | "best-effort" | "on-request";
}

export interface Capability {
  id: string;
  name: string;
  description: string;
  category?: "security" | "research" | "content" | "code" | "data" | "automation" | "media" | "domain" | "other";
  inputs?: Record<string, unknown>;
  outputs?: Record<string, unknown>;
  pricing?: CapabilityPricing;
  sla?: CapabilitySLA;
  examples?: Array<{ input: unknown; output: unknown }>;
}

export interface Trust {
  vouched_by?: string[];
  total_tasks_completed?: number;
  success_rate?: number;
  reputation_score?: number;
}

export interface Contact {
  moltbook?: string;
  email?: string;
  api_endpoint?: string;
}

export interface AgentManifest {
  agent: Agent;
  capabilities: Capability[];
  trust?: Trust;
  contact?: Contact;
  registered_at?: string;
  updated_at?: string;
}

export interface Task {
  id: string;
  requester: string;
  capability_needed: string;
  priority?: "low" | "normal" | "high" | "urgent";
  inputs?: Record<string, unknown>;
  bounty?: {
    type: "karma" | "usdc" | "trade" | "free";
    amount?: number;
  };
  deadline?: string;
  visibility?: "public" | "private";
  status: "posted" | "claimed" | "in_progress" | "delivered" | "verified" | "complete" | "disputed" | "cancelled";
  claimed_by?: string;
  created_at: string;
  updated_at: string;
}

export interface SearchQuery {
  capability?: string;
  category?: string;
  min_reputation?: number;
  max_price_karma?: number;
  max_price_usdc?: number;
  platform?: string;
  verified_only?: boolean;
}
