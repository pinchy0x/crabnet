// Simple file-based storage for CrabNet Registry
// Can be swapped for a real DB later (Turso, Supabase, etc.)

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import type { AgentManifest, Task, SearchQuery } from "./types";

const DATA_DIR = join(import.meta.dir, "../../data");
const MANIFESTS_FILE = join(DATA_DIR, "manifests.json");
const TASKS_FILE = join(DATA_DIR, "tasks.json");

// Ensure data directory exists
if (!existsSync(DATA_DIR)) {
  mkdirSync(DATA_DIR, { recursive: true });
}

// --- Manifest Storage ---

function loadManifests(): Record<string, AgentManifest> {
  if (!existsSync(MANIFESTS_FILE)) {
    return {};
  }
  try {
    return JSON.parse(readFileSync(MANIFESTS_FILE, "utf-8"));
  } catch {
    return {};
  }
}

function saveManifests(manifests: Record<string, AgentManifest>): void {
  writeFileSync(MANIFESTS_FILE, JSON.stringify(manifests, null, 2));
}

export function registerManifest(manifest: AgentManifest): AgentManifest {
  const manifests = loadManifests();
  const now = new Date().toISOString();
  
  const existing = manifests[manifest.agent.id];
  manifest.registered_at = existing?.registered_at || now;
  manifest.updated_at = now;
  
  manifests[manifest.agent.id] = manifest;
  saveManifests(manifests);
  
  return manifest;
}

export function getManifest(agentId: string): AgentManifest | null {
  const manifests = loadManifests();
  return manifests[agentId] || null;
}

export function deleteManifest(agentId: string): boolean {
  const manifests = loadManifests();
  if (!manifests[agentId]) return false;
  delete manifests[agentId];
  saveManifests(manifests);
  return true;
}

export function listManifests(): AgentManifest[] {
  const manifests = loadManifests();
  return Object.values(manifests);
}

export function searchManifests(query: SearchQuery): AgentManifest[] {
  const manifests = listManifests();
  
  return manifests.filter((m) => {
    // Filter by platform
    if (query.platform && m.agent.platform !== query.platform) return false;
    
    // Filter by verified
    if (query.verified_only && !m.agent.verified) return false;
    
    // Filter by minimum reputation
    if (query.min_reputation && (m.trust?.reputation_score || 0) < query.min_reputation) return false;
    
    // Filter by capability
    if (query.capability) {
      const hasCapability = m.capabilities.some(
        (c) => c.id === query.capability || 
               c.name.toLowerCase().includes(query.capability!.toLowerCase()) ||
               c.description.toLowerCase().includes(query.capability!.toLowerCase())
      );
      if (!hasCapability) return false;
    }
    
    // Filter by category
    if (query.category) {
      const hasCategory = m.capabilities.some((c) => c.category === query.category);
      if (!hasCategory) return false;
    }
    
    // Filter by max price (karma)
    if (query.max_price_karma !== undefined) {
      const affordable = m.capabilities.some(
        (c) => c.pricing?.free || (c.pricing?.karma !== undefined && c.pricing.karma <= query.max_price_karma!)
      );
      if (!affordable) return false;
    }
    
    // Filter by max price (usdc)
    if (query.max_price_usdc !== undefined) {
      const affordable = m.capabilities.some(
        (c) => c.pricing?.free || (c.pricing?.usdc !== undefined && c.pricing.usdc <= query.max_price_usdc!)
      );
      if (!affordable) return false;
    }
    
    return true;
  });
}

export function searchCapabilities(query: string): Array<{ agent: AgentManifest; capability: Capability }> {
  const manifests = listManifests();
  const results: Array<{ agent: AgentManifest; capability: Capability }> = [];
  
  const q = query.toLowerCase();
  
  for (const manifest of manifests) {
    for (const cap of manifest.capabilities) {
      if (
        cap.id.toLowerCase().includes(q) ||
        cap.name.toLowerCase().includes(q) ||
        cap.description.toLowerCase().includes(q) ||
        cap.category?.toLowerCase().includes(q)
      ) {
        results.push({ agent: manifest, capability: cap });
      }
    }
  }
  
  // Sort by reputation
  results.sort((a, b) => (b.agent.trust?.reputation_score || 0) - (a.agent.trust?.reputation_score || 0));
  
  return results;
}

// --- Task Storage ---

function loadTasks(): Record<string, Task> {
  if (!existsSync(TASKS_FILE)) {
    return {};
  }
  try {
    return JSON.parse(readFileSync(TASKS_FILE, "utf-8"));
  } catch {
    return {};
  }
}

function saveTasks(tasks: Record<string, Task>): void {
  writeFileSync(TASKS_FILE, JSON.stringify(tasks, null, 2));
}

export function createTask(task: Omit<Task, "id" | "status" | "created_at" | "updated_at">): Task {
  const tasks = loadTasks();
  const now = new Date().toISOString();
  
  const newTask: Task = {
    ...task,
    id: crypto.randomUUID(),
    status: "posted",
    created_at: now,
    updated_at: now,
  };
  
  tasks[newTask.id] = newTask;
  saveTasks(tasks);
  
  return newTask;
}

export function getTask(taskId: string): Task | null {
  const tasks = loadTasks();
  return tasks[taskId] || null;
}

export function updateTask(taskId: string, updates: Partial<Task>): Task | null {
  const tasks = loadTasks();
  if (!tasks[taskId]) return null;
  
  tasks[taskId] = {
    ...tasks[taskId],
    ...updates,
    updated_at: new Date().toISOString(),
  };
  
  saveTasks(tasks);
  return tasks[taskId];
}

export function listTasks(filters?: { status?: string; capability?: string; requester?: string }): Task[] {
  const tasks = Object.values(loadTasks());
  
  return tasks.filter((t) => {
    if (filters?.status && t.status !== filters.status) return false;
    if (filters?.capability && t.capability_needed !== filters.capability) return false;
    if (filters?.requester && t.requester !== filters.requester) return false;
    return true;
  });
}

// Import Capability type for the searchCapabilities function
import type { Capability } from "./types";
