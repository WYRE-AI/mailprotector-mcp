/**
 * Shared MCP server factory for Mailprotector.
 *
 * This module is **side-effect free** (importing it never starts a transport)
 * so it can be reused by every entrypoint. One factory serves BOTH protocol
 * eras via the v2 SDK serving entries: legacy 2025-era clients (classic
 * `initialize` handshake) statelessly per request, and modern 2026-07-28
 * envelope clients natively.
 *
 * Statelessness is a protocol invariant here: `tools/list` returns the same
 * module-scope TOOLS array (by reference, deterministic order) for every
 * caller, every era, every request. No sessions, no per-user variance.
 */
import { Server } from "@modelcontextprotocol/server";
import type { McpServerFactory } from "@modelcontextprotocol/server";
import { MailprotectorClient } from "@wyre-technology/node-mailprotector";
import { handleToolCall } from "./handlers/index.js";
import { errorResult } from "./handlers/results.js";
import { TOOLS } from "./tools.js";
import { logger } from "./utils/logger.js";

export const SERVER_NAME = "mailprotector-mcp";
export const SERVER_VERSION = "1.0.0";

export interface MailprotectorCredentials {
  apiKey: string;
  /** The MSP's reseller id — the default scope for scoped tools. */
  resellerId: number;
  /** API host override (env mode only). Default https://emailservice.io. */
  baseUrl?: string;
}

/** Exact gateway header names (integration contract) — lowercased by Node on receipt. */
export const GATEWAY_HEADERS = [
  "X-Mailprotector-Api-Key",
  "X-Mailprotector-Reseller-Id",
] as const;

/**
 * Build validated credentials from raw values. Returns `{ creds }` on
 * success or `{ error }` naming exactly what is missing or malformed.
 * Shared by every transport (env vars, Node HTTP gateway headers).
 */
export function buildCredentials(
  apiKey: string | undefined,
  resellerIdRaw: string | undefined,
  baseUrl?: string
): { creds?: MailprotectorCredentials; error?: string } {
  const missing: string[] = [];
  if (!apiKey) missing.push("X-Mailprotector-Api-Key");
  if (!resellerIdRaw) missing.push("X-Mailprotector-Reseller-Id");
  if (missing.length > 0) {
    return {
      error:
        `Missing credentials: ${missing.join(", ")} ` +
        "(or MAILPROTECTOR_API_KEY / MAILPROTECTOR_RESELLER_ID in env mode)",
    };
  }
  const resellerId = Number(resellerIdRaw);
  if (!Number.isInteger(resellerId) || resellerId <= 0) {
    return {
      error:
        "Invalid credentials: X-Mailprotector-Reseller-Id (MAILPROTECTOR_RESELLER_ID) " +
        "must be a positive integer",
    };
  }
  return {
    creds: {
      apiKey: apiKey as string,
      resellerId,
      ...(baseUrl ? { baseUrl } : {}),
    },
  };
}

/** Resolve per-request gateway credentials from a (lowercased) header accessor. */
export function resolveGatewayCredentials(
  getHeader: (lowerName: string) => string | undefined
): { creds?: MailprotectorCredentials; error?: string } {
  return buildCredentials(
    getHeader("x-mailprotector-api-key"),
    getHeader("x-mailprotector-reseller-id")
  );
}

/** Resolve env-mode credentials from MAILPROTECTOR_* environment variables. */
export function resolveEnvCredentials(
  env: Record<string, string | undefined> = process.env
): { creds?: MailprotectorCredentials; error?: string } {
  return buildCredentials(
    env.MAILPROTECTOR_API_KEY,
    env.MAILPROTECTOR_RESELLER_ID,
    env.MAILPROTECTOR_BASE_URL
  );
}

/**
 * Bind createMcpServer into the McpServerFactory shape the v2 HTTP serving
 * entry (createMcpHandler) consumes. The factory runs once per HTTP request —
 * the fresh-instance-per-request stateless idiom — for BOTH protocol eras.
 *
 * In gateway mode the request's headers are read from ctx.requestInfo,
 * keeping credentials bound per request. Missing headers are answered 401 by
 * the HTTP layer BEFORE serving ever starts — the factory itself never
 * throws (a throwing factory would surface as a 500).
 */
export function makeMcpServerFactory(options: { gatewayMode: boolean }): McpServerFactory {
  return (ctx) => {
    if (options.gatewayMode) {
      const { creds } = resolveGatewayCredentials(
        (name) => ctx.requestInfo?.headers.get(name) ?? undefined
      );
      return createMcpServer(creds);
    }
    const { creds } = resolveEnvCredentials();
    return createMcpServer(creds);
  };
}

// ── Pure request-handler bodies (exported for tests) ───────────────────────

export function listToolsResult(): { tools: typeof TOOLS } {
  // By reference, never rebuilt/sorted/filtered — deterministic for every caller.
  return { tools: TOOLS };
}

/**
 * Create a fresh MCP server. Called once for stdio, per-request for HTTP.
 * Credentials may be absent (e.g. env mode without vars): `tools/list` still
 * serves the full deterministic surface; `tools/call` answers a clear
 * isError result instead of throwing.
 */
export function createMcpServer(credentials?: MailprotectorCredentials): Server {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } }
  );

  let client: MailprotectorClient | undefined;

  server.setRequestHandler("tools/list", async () => listToolsResult());

  server.setRequestHandler("tools/call", async (request, ctx) => {
    const { name, arguments: args } = request.params;
    logger.debug("Tool call received", { tool: name });

    if (!credentials) {
      return errorResult(
        "Missing Mailprotector credentials. Set MAILPROTECTOR_API_KEY and " +
          "MAILPROTECTOR_RESELLER_ID (env mode) or send the X-Mailprotector-Api-Key / " +
          "X-Mailprotector-Reseller-Id gateway headers."
      );
    }
    try {
      client ??= new MailprotectorClient({
        apiKey: credentials.apiKey,
        ...(credentials.baseUrl ? { baseUrl: credentials.baseUrl } : {}),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return errorResult(`Invalid Mailprotector credentials: ${message}`);
    }

    return handleToolCall(
      client,
      credentials.resellerId,
      name,
      (args ?? {}) as Record<string, unknown>,
      {
        // Resolved per request: the envelope-declared capabilities on
        // 2026-07-28 requests, the initialize-declared set on 2025-era
        // connections, undefined on the stateless legacy path — where the
        // elicitation helpers correctly report `unavailable`.
        clientCapabilities: server.getClientCapabilities(),
        inputResponses: ctx.mcpReq.inputResponses,
      }
    );
  });

  return server;
}
