/**
 * Node HTTP stack: /mcp (dual-era via createMcpHandler), /health, CORS, the
 * X-Gateway-S2S gate, and the gateway credential 401 gate. Extracted from the
 * entrypoint so tests exercise the REAL routing (not a hand-mirrored replica).
 */
import { createServer, type IncomingMessage, type Server as NodeHttpServer, type ServerResponse } from "node:http";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import {
  GATEWAY_HEADERS,
  SERVER_VERSION,
  makeMcpServerFactory,
  resolveGatewayCredentials,
} from "./mcp-server.js";
import { logger } from "./utils/logger.js";
import { verifyS2sHeader, S2S_HEADER } from "./s2s-verify.js";

/**
 * HTTP transport fails closed (CWE-306).
 *
 * An empty CONDUIT_S2S_SECRET used to skip the X-Gateway-S2S check. Startup
 * now refuses to listen unless the secret is set and is not a known
 * placeholder. MCP_ALLOW_INSECURE_DEV=1 is the only bypass: it logs a
 * warning, does not enforce S2S, and binds 127.0.0.1. A non-loopback
 * MCP_HTTP_HOST is refused in that mode.
 *
 * A real secret honors MCP_HTTP_HOST, including 0.0.0.0. When that variable
 * is unset the process keeps the historical 0.0.0.0 bind so container
 * deploys stay reachable. The secret value is never logged.
 *
 * Gateway mode requires X-Mailprotector-Api-Key and X-Mailprotector-Reseller-Id
 * on every /mcp request and does not fall back to MAILPROTECTOR_* in the
 * environment. /health and /healthz stay unauthenticated and do not read
 * credentials. The stdio transport does not use S2S auth.
 */

/** Public example values. A copied placeholder must not verify as a real secret. */
const KNOWN_PLACEHOLDER_SECRETS = new Set([
  "replace-with-a-real-secret",
  "your-s2s-secret",
  "your-secret",
  "changeme",
  "change-me",
  "placeholder",
  "secret",
  "example",
  "replace-me",
  "s2s-secret",
]);

const LOOPBACK_HOST = "127.0.0.1";

const MISSING_S2S_SECRET_ERROR =
  "Refusing to start HTTP transport: CONDUIT_S2S_SECRET is empty. " +
  "Set CONDUIT_S2S_SECRET to the gateway-provisioned secret (openssl rand -hex 32), " +
  "or set MCP_ALLOW_INSECURE_DEV=1 for local development only.";

const PLACEHOLDER_S2S_SECRET_ERROR =
  "Refusing to start HTTP transport: CONDUIT_S2S_SECRET is a known placeholder. " +
  "Generate a secret with `openssl rand -hex 32` and set CONDUIT_S2S_SECRET to that value.";

const INSECURE_DEV_WARNING =
  "SECURITY WARNING: CONDUIT_S2S_SECRET is empty and MCP_ALLOW_INSECURE_DEV=1. " +
  "HTTP /mcp is starting with service-to-service authentication DISABLED, bound to 127.0.0.1 only. " +
  "Local development only; do not expose this port.";

const CORS_ALLOW_HEADERS = [
  "Content-Type",
  "Accept",
  "Authorization",
  "Mcp-Session-Id",
  "Mcp-Protocol-Version",
  ...GATEWAY_HEADERS,
].join(", ");

function refuseStart(message: string): never {
  logger.error(message);
  process.exit(1);
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/** 127.0.0.1, the rest of 127.0.0.0/8, localhost, and ::1. */
function isLoopbackBindHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[(.+)\]$/, "$1");
  if (normalized === "localhost" || normalized === "::1") return true;
  const bare = normalized.startsWith("::ffff:") ? normalized.slice("::ffff:".length) : normalized;
  const parts = bare.split(".");
  if (parts.length !== 4) return false;
  if (parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return false;
  return parts[0] === "127";
}

/**
 * Fail closed. A known placeholder is never a configured secret, including
 * when MCP_ALLOW_INSECURE_DEV=1 is also set. Empty is the only case the dev
 * flag may bypass, and that bypass does not check X-Gateway-S2S.
 * This is the only read of CONDUIT_S2S_SECRET.
 */
function resolveS2sSecret(env: NodeJS.ProcessEnv = process.env): { secret: string; insecureDev: boolean } {
  const raw = (env.CONDUIT_S2S_SECRET ?? "").trim();
  if (raw && KNOWN_PLACEHOLDER_SECRETS.has(raw.toLowerCase())) {
    refuseStart(PLACEHOLDER_S2S_SECRET_ERROR);
  }
  if (raw) return { secret: raw, insecureDev: false };
  if (env.MCP_ALLOW_INSECURE_DEV === "1") {
    return { secret: "", insecureDev: true };
  }
  refuseStart(MISSING_S2S_SECRET_ERROR);
}

/**
 * No real secret: force 127.0.0.1. A non-loopback MCP_HTTP_HOST refuses to
 * start and is logged. A real secret honors MCP_HTTP_HOST; unset stays
 * 0.0.0.0 so existing container deploys keep their bind.
 */
function resolveBindHost(insecureDev: boolean, env: NodeJS.ProcessEnv = process.env): string {
  const configured = (env.MCP_HTTP_HOST ?? "").trim();
  if (!insecureDev) {
    return configured || "0.0.0.0";
  }
  if (configured === "" || isLoopbackBindHost(configured)) {
    return LOOPBACK_HOST;
  }
  refuseStart(
    `Refusing to start HTTP transport: MCP_ALLOW_INSECURE_DEV=1 without CONDUIT_S2S_SECRET ` +
      `only listens on ${LOOPBACK_HOST}. MCP_HTTP_HOST=${configured} is not loopback. ` +
      `Unset MCP_HTTP_HOST or set it to ${LOOPBACK_HOST}.`
  );
}

export interface HttpStack {
  server: NodeHttpServer;
  /** Closes the MCP handler and the HTTP listener. */
  close(): Promise<void>;
}

export function createHttpStack(options: { gatewayMode: boolean; s2sSecret?: string }): HttpStack {
  const { gatewayMode } = options;
  // Empty only after MCP_ALLOW_INSECURE_DEV=1. Callers that are not the HTTP
  // entry (unit tests of routing) pass no secret and do not enforce S2S.
  const s2sSecret = options.s2sSecret ?? "";

  const mcpHandler = createMcpHandler(makeMcpServerFactory({ gatewayMode }), {
    // 'stateless' (the default) is the dual-era posture: 2025-era traffic is
    // answered per-request statelessly, modern 2026-07-28 envelope traffic
    // natively. NEVER 'reject' on fleet servers.
    legacy: "stateless",
    onerror: (error) => logger.error("MCP serving error", { error: error.message }),
  });
  const handleMcpRequest = toNodeHandler(mcpHandler, {
    onerror: (error) => logger.error("MCP request adapter error", { error: error.message }),
  });

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    // CORS for claude.ai custom connectors — set on every response, before routing.
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS, DELETE");
    res.setHeader("Access-Control-Allow-Headers", CORS_ALLOW_HEADERS);
    res.setHeader("Access-Control-Max-Age", "86400");
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    // Health endpoint — shallow, unauthenticated liveness probe. Must NOT
    // touch credentials, the S2S secret, or any upstream: in gateway mode
    // credentials only arrive per-request via headers, so a credential
    // check here would always fail and crash-loop the container.
    if (url.pathname === "/health" || url.pathname === "/healthz") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: "ok",
          version: SERVER_VERSION,
          mcpTransport: "http",
          authMode: gatewayMode ? "gateway" : "env",
          timestamp: new Date().toISOString(),
        })
      );
      return;
    }

    if (url.pathname === "/mcp") {
      // Empty s2sSecret is only reachable when MCP_ALLOW_INSECURE_DEV=1;
      // startup refuses otherwise. A configured secret is always enforced,
      // before any credential extraction (gateway#377 parity).
      if (s2sSecret && !verifyS2sHeader(headerValue(req.headers[S2S_HEADER]), s2sSecret)) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: {
              code: -32002,
              message:
                "Missing or invalid X-Gateway-S2S header: this endpoint only accepts requests signed by the gateway.",
            },
            id: null,
          })
        );
        return;
      }

      // 401 gate: reject unauthenticated gateway traffic BEFORE serving —
      // falling through to env-configured credentials would serve the
      // operator's tenant data to whoever asked (cross-tenant leak).
      // createMcpHandler has no auth hooks, so the rejection lives here.
      // Whitespace-only headers count as missing.
      if (gatewayMode) {
        const { error } = resolveGatewayCredentials((name) => headerValue(req.headers[name]));
        if (error) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              error: {
                code: -32001,
                message: `Unauthorized: ${error}`,
                data: { required: GATEWAY_HEADERS },
              },
              id: null,
            })
          );
          return;
        }
      }

      // Per-request credential binding happens inside the factory (it reads
      // the gateway headers from ctx.requestInfo on every request).
      // Cast: beta.5's NodeIncomingMessageLike declares `method?: string`,
      // which node:http IncomingMessage rejects under exactOptionalPropertyTypes.
      await handleMcpRequest(req as unknown as Parameters<typeof handleMcpRequest>[0], res);
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found", endpoints: ["/mcp", "/health"] }));
  });

  return {
    server,
    close: async () => {
      await mcpHandler.close();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

/**
 * HTTP entry. Refuses to listen without a real CONDUIT_S2S_SECRET unless
 * MCP_ALLOW_INSECURE_DEV=1, which forces 127.0.0.1. Returns after bind.
 */
export async function startHttpTransport(): Promise<HttpStack> {
  const port = parseInt(process.env.MCP_HTTP_PORT || "8080", 10);
  const { secret, insecureDev } = resolveS2sSecret();
  const host = resolveBindHost(insecureDev);
  if (insecureDev) {
    // error level so LOG_LEVEL=warn|error cannot hide the bypass.
    // Logged only after the loopback bind is accepted, so a refused
    // non-loopback host does not claim the server is starting.
    logger.error(INSECURE_DEV_WARNING);
  }
  const gatewayMode = process.env.AUTH_MODE === "gateway";
  const stack = createHttpStack({ gatewayMode, s2sSecret: secret });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => reject(err);
    stack.server.once("error", onError);
    stack.server.listen(port, host, () => {
      stack.server.off("error", onError);
      logger.info(`Mailprotector MCP server listening on http://${host}:${port}/mcp`);
      logger.info(`Health check available at http://${host}:${port}/health`);
      logger.info(`Authentication mode: ${gatewayMode ? "gateway (header-based)" : "env"}`);
      resolve();
    });
  });

  return stack;
}
