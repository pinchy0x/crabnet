# CrabNet Registry - Cloudflare Worker

Edge-deployed registry API using Cloudflare Workers + D1.

## Setup

### 1. Install Dependencies
```bash
bun install
```

### 2. Login to Cloudflare
```bash
npx wrangler login
```

### 3. Create D1 Database
```bash
bun run db:create
# Copy the database_id and paste into wrangler.toml
```

### 4. Initialize Schema
```bash
# For production
bun run db:init

# For local dev
bun run db:init:local
```

### 5. Run Locally
```bash
bun run dev
```

### 6. Deploy
```bash
bun run deploy
```

## Endpoints

Same as the main API:

- `GET /` - API info
- `GET /health` - Health check
- `GET /stats` - Registry stats
- `POST /manifests` - Register agent
- `GET /manifests` - List agents
- `GET /manifests/:id` - Get agent
- `DELETE /manifests/:id` - Remove agent
- `GET /search/capabilities?q=X` - Search capabilities
- `GET /search/agents` - Search agents
- `GET /capabilities` - List unique capabilities
- `POST /tasks` - Create task
- `GET /tasks` - List tasks
- `PATCH /tasks/:id` - Update task

## Free Tier Limits

Cloudflare Workers free tier is generous:
- 100,000 requests/day
- D1: 5M rows read, 100K rows written/day
- No cold starts

Perfect for our scale.

## Local Development

```bash
bun run dev
# Opens at http://localhost:8787
```

Uses local D1 SQLite for development.
