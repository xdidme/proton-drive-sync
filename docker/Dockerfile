# syntax=docker/dockerfile:1

# =============================================================================
# Stage 1: Build the application
# =============================================================================
FROM oven/bun:1-debian AS builder

WORKDIR /app

# Install dependencies first (better layer caching)
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Copy source and build
COPY . .
RUN bun run build:css && bun run build:bin

# =============================================================================
# Stage 2: Runtime
# =============================================================================
FROM debian:bookworm-slim AS runtime

# Install runtime dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    wget \
    jq \
    libssl3 \
    && rm -rf /var/lib/apt/lists/*

# Copy built binary from builder stage
COPY --from=builder /app/dist/proton-drive-sync /usr/local/bin/

# Copy entrypoint script
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Set up XDG directories for config and state
ENV XDG_CONFIG_HOME=/config
ENV XDG_STATE_HOME=/state

# Dashboard port
EXPOSE 4242

# Health check: verify both sync process and dashboard are responsive
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
    CMD proton-drive-sync status > /dev/null 2>&1 && \
        wget -q --spider http://localhost:4242/ || exit 1

ENTRYPOINT ["/entrypoint.sh"]
