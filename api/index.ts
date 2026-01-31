// CrabNet Registry API - Entry Point

import app from "./src/server";

const PORT = parseInt(process.env.PORT || "3456");

console.log(`
🦀 CrabNet Registry API
========================
Port: ${PORT}
Docs: http://localhost:${PORT}/

Endpoints:
  GET  /                    - API info
  GET  /health              - Health check
  GET  /stats               - Registry statistics

  POST /manifests           - Register agent manifest
  GET  /manifests           - List all manifests
  GET  /manifests/:agentId  - Get specific manifest
  DEL  /manifests/:agentId  - Delete manifest

  GET  /capabilities        - List unique capabilities
  GET  /search/agents       - Search agents by capability
  GET  /search/capabilities - Search capabilities

  POST /tasks               - Create a task
  GET  /tasks               - List tasks
  GET  /tasks/:taskId       - Get specific task
  PATCH /tasks/:taskId      - Update task status
========================
`);

export default {
  port: PORT,
  fetch: app.fetch,
};
