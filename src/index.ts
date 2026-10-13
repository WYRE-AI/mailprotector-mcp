#!/usr/bin/env node
/**
 * Mailprotector MCP server — router surface (22 first-class tools + routed
 * long tail via mailprotector_execute_tool).
 *
 * Transports:
 * - stdio (default): local Claude Desktop / CLI usage. `serveStdio` owns the
 *   era decision: a 2025-era `initialize` pins the connection legacy; modern
 *   2026-07-28 envelope openings are served natively.
 * - http: hosted deployment. `createMcpHandler({ legacy: 'stateless' })` is
 *   the dual-era posture — 2025-era traffic answered per-request statelessly,
 *   modern envelope traffic natively. NEVER `legacy: 'reject'`.
 *
 * Credentials via environment variables (env mode):
 * - MAILPROTECTOR_API_KEY / MAILPROTECTOR_RESELLER_ID (+ optional MAILPROTECTOR_BASE_URL)
 * Or via gateway headers (AUTH_MODE=gateway):
 * - X-Mailprotector-Api-Key / X-Mailprotector-Reseller-Id
 * Gateway mode never falls back to MAILPROTECTOR_* env credentials.
 *
 * HTTP transport refuses to start unless CONDUIT_S2S_SECRET is a real secret
 * (known placeholders are rejected). MCP_ALLOW_INSECURE_DEV=1 is a local-only
 * escape hatch: it logs a warning, skips X-Gateway-S2S, and binds 127.0.0.1.
 * A configured secret honors MCP_HTTP_HOST. /health and /healthz stay
 * unauthenticated. stdio does not use S2S auth.
 */
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { startHttpTransport } from "./http.js";
import { createMcpServer, resolveEnvCredentials } from "./mcp-server.js";
import { logger } from "./utils/logger.js";

/** stdio (default). Fresh server per process; env-mode credentials. */
function startStdioTransport(): void {
  serveStdio(() => createMcpServer(resolveEnvCredentials().creds), {
    onerror: (error) => logger.error("stdio serving error", { error: error.message }),
  });
  logger.info("Mailprotector MCP server running on stdio");
}

async function main() {
  const transportType = process.env.MCP_TRANSPORT || "stdio";
  logger.info("Starting Mailprotector MCP server", {
    transport: transportType,
    nodeVersion: process.version,
  });

  if (transportType === "http") {
    const stack = await startHttpTransport();
    const shutdown = async () => {
      logger.info("Shutting down Mailprotector MCP server...");
      await stack.close();
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  } else {
    startStdioTransport();
  }
}

main().catch((error) => {
  logger.error("Fatal startup error", {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});
