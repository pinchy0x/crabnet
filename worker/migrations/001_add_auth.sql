-- Migration 001: Add authentication and rate limiting
-- SQLite-compatible migration

-- Add api_key_hash to agents (without UNIQUE for now - will enforce in code)
ALTER TABLE agents ADD COLUMN api_key_hash TEXT;

-- Add tasks_failed to agents  
ALTER TABLE agents ADD COLUMN tasks_failed INTEGER DEFAULT 0;

-- Add claim tracking to tasks
ALTER TABLE tasks ADD COLUMN claimed_at TEXT;
ALTER TABLE tasks ADD COLUMN claim_expires TEXT;

-- Create rate limits table
CREATE TABLE IF NOT EXISTS rate_limits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ip TEXT NOT NULL,
  timestamp INTEGER NOT NULL
);

-- Add new indexes
CREATE INDEX IF NOT EXISTS idx_agents_api_key ON agents(api_key_hash);
CREATE INDEX IF NOT EXISTS idx_rate_limits_ip ON rate_limits(ip, timestamp);
CREATE INDEX IF NOT EXISTS idx_capabilities_id ON capabilities(capability_id);
CREATE INDEX IF NOT EXISTS idx_tasks_requester ON tasks(requester);
CREATE INDEX IF NOT EXISTS idx_tasks_claimed_by ON tasks(claimed_by);
