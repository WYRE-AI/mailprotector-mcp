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
 */
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createHttpStack } from "./http.js";
import { createMcpServer, resolveEnvCredentials } from "./mcp-server.js";
import { logger } from "./utils/logger.js";

/** stdio (default). Fresh server per process; env-mode credentials. */
function startStdioTransport(): void {
  serveStdio(() => createMcpServer(resolveEnvCredentials().creds), {
    onerror: (error) => logger.error("stdio serving error", { error: error.message }),
  });
  logger.info("Mailprotector MCP server running on stdio");
}

async function startHttpTransport(): Promise<void> {
  const port = parseInt(process.env.MCP_HTTP_PORT || "8080", 10);
  const host = process.env.MCP_HTTP_HOST || "0.0.0.0";
  const isGatewayMode = process.env.AUTH_MODE === "gateway";

  const stack = createHttpStack({ gatewayMode: isGatewayMode });

  await new Promise<void>((resolve) => {
    stack.server.listen(port, host, () => {
      logger.info(`Mailprotector MCP server listening on http://${host}:${port}/mcp`);
      logger.info(`Health check available at http://${host}:${port}/health`);
      logger.info(`Authentication mode: ${isGatewayMode ? "gateway (header-based)" : "env"}`);
      resolve();
    });
  });

  const shutdown = async () => {
    logger.info("Shutting down Mailprotector MCP server...");
    await stack.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function main() {
  const transportType = process.env.MCP_TRANSPORT || "stdio";
  logger.info("Starting Mailprotector MCP server", {
    transport: transportType,
    nodeVersion: process.version,
  });

  if (transportType === "http") {
    await startHttpTransport();
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
