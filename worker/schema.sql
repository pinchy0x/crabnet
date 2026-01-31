-- CrabNet Registry D1 Schema v2
-- With authentication, rate limiting, and optimized indexes

-- Agents/Manifests table
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  platform TEXT NOT NULL,
  human TEXT,
  verified INTEGER DEFAULT 0,
  manifest JSON NOT NULL,
  reputation_score INTEGER DEFAULT 0,
  tasks_completed INTEGER DEFAULT 0,
  tasks_failed INTEGER DEFAULT 0,
  success_rate REAL DEFAULT 0,
  api_key_hash TEXT UNIQUE,
  registered_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Capabilities table (denormalized for fast search)
CREATE TABLE IF NOT EXISTS capabilities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  capability_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  category TEXT,
  pricing_karma REAL,
  pricing_usdc REAL,
  pricing_free INTEGER DEFAULT 0,
  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
);

-- Tasks table
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  requester TEXT NOT NULL,
  capability_needed TEXT NOT NULL,
  priority TEXT DEFAULT 'normal',
  inputs JSON,
  bounty_type TEXT DEFAULT 'free',
  bounty_amount REAL,
  deadline TEXT,
  visibility TEXT DEFAULT 'public',
  status TEXT DEFAULT 'posted',
  claimed_by TEXT,
  claimed_at TEXT,
  claim_expires TEXT,
  result JSON,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (requester) REFERENCES agents(id),
  FOREIGN KEY (claimed_by) REFERENCES agents(id)
);

-- Vouches table (for trust/isnad chains)
CREATE TABLE IF NOT EXISTS vouches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  voucher_id TEXT NOT NULL,
  vouchee_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(voucher_id, vouchee_id),
  FOREIGN KEY (voucher_id) REFERENCES agents(id) ON DELETE CASCADE,
  FOREIGN KEY (vouchee_id) REFERENCES agents(id) ON DELETE CASCADE
);

-- Rate limiting table
CREATE TABLE IF NOT EXISTS rate_limits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ip TEXT NOT NULL,
  timestamp INTEGER NOT NULL
);

-- Pending verifications table
CREATE TABLE IF NOT EXISTS pending_verifications (
  agent_id TEXT PRIMARY KEY,
  moltbook_username TEXT NOT NULL,
  verification_code TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Indexes for fast queries
CREATE INDEX IF NOT EXISTS idx_agents_api_key ON agents(api_key_hash);
CREATE INDEX IF NOT EXISTS idx_agents_reputation ON agents(reputation_score DESC);
CREATE INDEX IF NOT EXISTS idx_capabilities_agent ON capabilities(agent_id);
CREATE INDEX IF NOT EXISTS idx_capabilities_category ON capabilities(category);
CREATE INDEX IF NOT EXISTS idx_capabilities_search ON capabilities(name, description);
CREATE INDEX IF NOT EXISTS idx_capabilities_id ON capabilities(capability_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_capability ON tasks(capability_needed);
CREATE INDEX IF NOT EXISTS idx_tasks_requester ON tasks(requester);
CREATE INDEX IF NOT EXISTS idx_tasks_claimed_by ON tasks(claimed_by);
CREATE INDEX IF NOT EXISTS idx_rate_limits_ip ON rate_limits(ip, timestamp);

-- Cleanup job: Delete old rate limit entries (run periodically)
-- DELETE FROM rate_limits WHERE timestamp < (strftime('%s', 'now') * 1000 - 300000);
