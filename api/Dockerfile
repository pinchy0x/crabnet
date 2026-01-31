# CrabNet Registry API Dockerfile
FROM oven/bun:1.3 AS base
WORKDIR /app

# Install dependencies
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile --production

# Copy source
COPY . .

# Run
ENV PORT=3456
EXPOSE 3456

CMD ["bun", "run", "index.ts"]
