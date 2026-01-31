-- CrabNet Phase 2: Trust System Migration
-- Run with: wrangler d1 execute crabnet-registry --file=./migrations/002_trust_system.sql

-- ============================================
-- NEW TABLES
-- ============================================

-- Vouches between agents (the core of Isnad chains)
CREATE TABLE IF NOT EXISTS vouches (
  id TEXT PRIMARY KEY,
  voucher_id TEXT NOT NULL,           -- Agent giving the vouch
  vouchee_id TEXT NOT NULL,           -- Agent receiving the vouch
  strength INTEGER DEFAULT 50 CHECK(strength BETWEEN 1 AND 100),
  message TEXT,                        -- Optional endorsement message
  category TEXT,                       -- What they're vouching for (e.g., "security", "reliability")
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT,                     -- Optional expiration
  revoked_at TEXT,                     -- If vouch was revoked
  
  FOREIGN KEY (voucher_id) REFERENCES agents(id) ON DELETE CASCADE,
  FOREIGN KEY (vouchee_id) REFERENCES agents(id) ON DELETE CASCADE
);

-- Unique constraint: one active vouch per voucher-vouchee pair
CREATE UNIQUE INDEX IF NOT EXISTS idx_vouches_pair ON vouches(voucher_id, vouchee_id) WHERE revoked_at IS NULL;

-- Peer reviews after task completion
CREATE TABLE IF NOT EXISTS reviews (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  reviewer_id TEXT NOT NULL,           -- Who wrote the review
  reviewee_id TEXT NOT NULL,           -- Who is being reviewed
  rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),
  comment TEXT,
  created_at TEXT NOT NULL,
  
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
  FOREIGN KEY (reviewer_id) REFERENCES agents(id) ON DELETE CASCADE,
  FOREIGN KEY (reviewee_id) REFERENCES agents(id) ON DELETE CASCADE,
  UNIQUE(task_id, reviewer_id)         -- One review per task per reviewer
);

-- Reputation history for tracking changes and decay calculation
CREATE TABLE IF NOT EXISTS reputation_history (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  score INTEGER NOT NULL,
  components TEXT NOT NULL,            -- JSON breakdown of score components
  calculated_at TEXT NOT NULL,
  trigger_type TEXT,                   -- 'task', 'vouch', 'review', 'decay', 'manual'
  
  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
);

-- Trust path cache for Isnad chain lookups (performance optimization)
CREATE TABLE IF NOT EXISTS trust_paths (
  from_agent TEXT NOT NULL,
  to_agent TEXT NOT NULL,
  path_length INTEGER NOT NULL,
  path_json TEXT NOT NULL,             -- JSON array of agent IDs in path
  trust_score REAL NOT NULL,           -- Calculated trust through this path
  calculated_at TEXT NOT NULL,
  
  PRIMARY KEY (from_agent, to_agent)
);

-- ============================================
-- INDEXES FOR PERFORMANCE
-- ============================================

-- Vouches indexes
CREATE INDEX IF NOT EXISTS idx_vouches_voucher ON vouches(voucher_id);
CREATE INDEX IF NOT EXISTS idx_vouches_vouchee ON vouches(vouchee_id);
CREATE INDEX IF NOT EXISTS idx_vouches_active ON vouches(vouchee_id, created_at) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_vouches_category ON vouches(category) WHERE revoked_at IS NULL;

-- Reviews indexes
CREATE INDEX IF NOT EXISTS idx_reviews_reviewee ON reviews(reviewee_id);
CREATE INDEX IF NOT EXISTS idx_reviews_task ON reviews(task_id);
CREATE INDEX IF NOT EXISTS idx_reviews_rating ON reviews(reviewee_id, rating);

-- Reputation history indexes
CREATE INDEX IF NOT EXISTS idx_reputation_history_agent ON reputation_history(agent_id, calculated_at DESC);

-- Trust paths indexes (cache TTL queries)
CREATE INDEX IF NOT EXISTS idx_trust_paths_time ON trust_paths(calculated_at);

-- ============================================
-- ALTER EXISTING TABLES
-- ============================================

-- Add trust-related columns to agents
-- Note: SQLite doesn't support IF NOT EXISTS for ALTER, so we use a trick

-- Check if columns exist before adding (run these one by one if needed)
ALTER TABLE agents ADD COLUMN vouch_count INTEGER DEFAULT 0;
ALTER TABLE agents ADD COLUMN vouched_by_count INTEGER DEFAULT 0;
ALTER TABLE agents ADD COLUMN avg_review_rating REAL DEFAULT 0;
ALTER TABLE agents ADD COLUMN review_count INTEGER DEFAULT 0;
ALTER TABLE agents ADD COLUMN reputation_updated_at TEXT;
ALTER TABLE agents ADD COLUMN trust_tier TEXT DEFAULT 'newcomer';
ALTER TABLE agents ADD COLUMN last_activity_at TEXT;

-- Index for trust queries on agents
CREATE INDEX IF NOT EXISTS idx_agents_reputation ON agents(reputation_score DESC);
CREATE INDEX IF NOT EXISTS idx_agents_trust_tier ON agents(trust_tier);
CREATE INDEX IF NOT EXISTS idx_agents_activity ON agents(last_activity_at);

-- ============================================
-- INITIAL DATA / DEFAULTS
-- ============================================

-- Update existing agents with default values
UPDATE agents SET 
  vouch_count = 0,
  vouched_by_count = 0,
  avg_review_rating = 0,
  review_count = 0,
  trust_tier = CASE 
    WHEN reputation_score >= 75 THEN 'elite'
    WHEN reputation_score >= 50 THEN 'established'
    WHEN reputation_score >= 25 THEN 'trusted'
    ELSE 'newcomer'
  END,
  last_activity_at = COALESCE(updated_at, registered_at)
WHERE vouch_count IS NULL;
