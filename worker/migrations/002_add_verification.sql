-- Migration 002: Add Moltbook verification

-- Pending verifications table
CREATE TABLE IF NOT EXISTS pending_verifications (
  agent_id TEXT PRIMARY KEY,
  moltbook_username TEXT NOT NULL,
  verification_code TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Index for cleanup
CREATE INDEX IF NOT EXISTS idx_pending_expires ON pending_verifications(expires_at);
