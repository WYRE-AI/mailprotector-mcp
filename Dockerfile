# Multi-stage build for efficient container size.
# Build with: docker build --platform linux/amd64 --build-arg NODE_AUTH_TOKEN=$(gh auth token) -t mailprotector-mcp .
FROM node:26-alpine AS builder

# Build arguments
ARG VERSION="unknown"
ARG COMMIT_SHA="unknown"
ARG BUILD_DATE="unknown"
ARG NODE_AUTH_TOKEN

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies with GitHub Packages auth for @wyre-technology/* scope.
# --ignore-scripts prevents lifecycle scripts from running before source is copied.
RUN echo "@wyre-technology:registry=https://npm.pkg.github.com" > .npmrc && \
    echo "//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}" >> .npmrc && \
    npm ci --ignore-scripts && \
    rm -f .npmrc

# Copy source code
COPY . .

# Build the application
RUN npm run build

# Prune dev dependencies in the builder so the production stage copies a
# runtime-only node_modules (no re-install, no registry auth needed).
RUN npm prune --omit=dev && npm cache clean --force

# Production stage
FROM node:26-alpine AS production

# Pull latest Alpine package fixes even when the base layer is cached
RUN apk -U upgrade --no-cache

# Create a non-root user for security
RUN addgroup -g 1001 -S mcp && \
    adduser -S mcp -u 1001 -G mcp

WORKDIR /app

# Copy package files and built application from the builder stage
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules

# Remove the npm CLI from the production image — the runtime only needs `node`,
# and npm's bundled dependencies regularly trip vulnerability scanners.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx && \
    chown -R mcp:mcp /app

# Switch to non-root user
USER mcp

# Expose port for HTTP transport
EXPOSE 8080

# Health check against the HTTP endpoint
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:8080/health || exit 1

# Set environment variables. AUTH_MODE=gateway is the fleet default: the image
# ships for hosting behind the WYRE gateway, which injects per-request
# credential headers. Set AUTH_MODE=env for local env-var credentials.
ENV NODE_ENV=production
ENV LOG_LEVEL=info
ENV MCP_TRANSPORT=http
ENV MCP_HTTP_PORT=8080
ENV MCP_HTTP_HOST=0.0.0.0
ENV AUTH_MODE=gateway

# Start the application directly (HTTP transport doesn't need the stdio guard)
CMD ["node", "dist/index.js"]

# Re-declare build arguments in this stage so the labels below resolve
ARG VERSION="unknown"
ARG COMMIT_SHA="unknown"
ARG BUILD_DATE="unknown"

# Labels for metadata
LABEL maintainer="engineering@wyre.ai"
LABEL version="${VERSION}"
LABEL org.opencontainers.image.title="mailprotector-mcp"
LABEL org.opencontainers.image.description="Model Context Protocol server for Mailprotector email security"
LABEL org.opencontainers.image.version="${VERSION}"
LABEL org.opencontainers.image.created="${BUILD_DATE}"
LABEL org.opencontainers.image.revision="${COMMIT_SHA}"
LABEL org.opencontainers.image.source="https://github.com/wyre-technology/mailprotector-mcp"
LABEL org.opencontainers.image.documentation="https://github.com/wyre-technology/mailprotector-mcp/blob/main/README.md"
LABEL org.opencontainers.image.url="https://github.com/wyre-technology/mailprotector-mcp/pkgs/container/mailprotector-mcp"
LABEL org.opencontainers.image.vendor="Wyre Technology"
LABEL org.opencontainers.image.licenses="Apache-2.0"

# MCP Registry ownership annotation (must match `name` in server.json)
LABEL io.modelcontextprotocol.server.name="io.github.wyre-technology/mailprotector-mcp"
