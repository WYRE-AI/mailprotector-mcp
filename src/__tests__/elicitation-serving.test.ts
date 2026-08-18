/**
 * End-to-end elicitation over the REAL serving stack: the same
 * createMcpHandler({ legacy: 'stateless' }) + toNodeHandler wiring as
 * src/index.ts, with only the vendor MailprotectorClient stubbed.
 *
 * Proves the MRTR seam on both protocol eras:
 * - a 2026-07-28 client with the elicitation capability gets the delete
 *   confirmation as an embedded `elicitation/create` request (auto-fulfilled
 *   by the v2 client) — decline cancels the DELETE, accept lets it fire;
 * - a stateless 2025-era caller (no capability view — how the WYRE Conduit
 *   gateway connects) cannot be prompted, so per the integration contract
 *   the delete FALLS BACK TO PROCEEDING (elicitation is purely additive; the
 *   gateway enforces destructive-tool access with its own server-side gate).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import http from "node:http";
import { createMcpHandler } from "@modelcontextprotocol/server";
import type { McpHttpHandler } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";

const { allowBlockApi } = vi.hoisted(() => ({
  allowBlockApi: {
    listFor: vi.fn(),
    createFor: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock("@wyre-technology/node-mailprotector", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@wyre-technology/node-mailprotector")>();
  return {
    ...actual,
    MailprotectorClient: class {
      allowBlockRules = allowBlockApi;
      resellers = { get: vi.fn().mockResolvedValue({ id: 42 }) };
    },
  };
});

const { makeMcpServerFactory } = await import("../mcp-server.js");

const ENV_KEYS = ["MAILPROTECTOR_API_KEY", "MAILPROTECTOR_RESELLER_ID"] as const;

describe("elicitation over the live dual-era serving stack", () => {
  let mcpHandler: McpHttpHandler;
  let server: http.Server;
  let base: string;

  beforeAll(async () => {
    process.env.MAILPROTECTOR_API_KEY = "test-api-key";
    process.env.MAILPROTECTOR_RESELLER_ID = "42";
    mcpHandler = createMcpHandler(makeMcpServerFactory({ gatewayMode: false }), {
      legacy: "stateless",
    });
    const handleMcp = toNodeHandler(mcpHandler);
    server = http.createServer((req, res) => {
      void handleMcp(req as unknown as Parameters<typeof handleMcp>[0], res);
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    for (const key of ENV_KEYS) delete process.env[key];
    await mcpHandler.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function modernDelete(confirm: boolean): Promise<{ prompts: string[]; text: string }> {
    const { Client, StreamableHTTPClientTransport } = await import(
      "@modelcontextprotocol/client"
    );
    const prompts: string[] = [];
    const client = new Client(
      { name: "elicit-e2e", version: "0.0.0" },
      {
        capabilities: { elicitation: {} },
        // Negotiate the modern era — the default is a plain 2025 connect.
        versionNegotiation: { mode: "auto" },
      }
    );
    client.setRequestHandler("elicitation/create", async (request) => {
      prompts.push(request.params.message);
      return { action: "accept" as const, content: { confirm } };
    });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
    try {
      expect(client.getNegotiatedProtocolVersion?.()).toBe("2026-07-28");
      const result = await client.callTool({
        name: "mailprotector_allow_block_rules_delete",
        arguments: { rule_id: 9 },
      });
      const content = result.content as Array<{ type: string; text?: string }>;
      return { prompts, text: content[0]?.text ?? "" };
    } finally {
      await client.close();
    }
  }

  it("2026-07-28 era: declined confirmation cancels the DELETE", async () => {
    allowBlockApi.delete.mockResolvedValue(undefined);

    const { prompts, text } = await modernDelete(false);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("Permanently delete allow/block rule 9");
    expect(text).toContain("NOT deleted");
    expect(allowBlockApi.delete).not.toHaveBeenCalled();
  });

  it("2026-07-28 era: accepted confirmation lets the DELETE fire", async () => {
    allowBlockApi.delete.mockClear();
    allowBlockApi.delete.mockResolvedValue(undefined);

    const { prompts, text } = await modernDelete(true);
    expect(prompts).toHaveLength(1);
    expect(allowBlockApi.delete).toHaveBeenCalledWith(9);
    expect(JSON.parse(text)).toMatchObject({ deleted: true, rule_id: 9 });
  });

  /** One stateless 2025-era tools/call — no initialize, so no capability view. */
  async function statelessDelete(
    args: Record<string, unknown>
  ): Promise<{ isError?: boolean; text: string }> {
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "mailprotector_allow_block_rules_delete", arguments: args },
      }),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    const dataLines = text.split("\n").filter((line) => line.startsWith("data:"));
    const message = JSON.parse(
      (dataLines.length > 0 ? dataLines[dataLines.length - 1].slice(5) : text).trim()
    );
    return {
      isError: message.result?.isError,
      text: message.result?.content?.[0]?.text ?? "",
    };
  }

  it("stateless 2025-era caller: elicitation unavailable → falls back to proceeding (contract)", async () => {
    allowBlockApi.delete.mockClear();
    allowBlockApi.delete.mockResolvedValue(undefined);

    const { isError, text } = await statelessDelete({ rule_id: 9 });
    expect(isError).toBeUndefined();
    expect(JSON.parse(text)).toMatchObject({ deleted: true, rule_id: 9 });
    expect(allowBlockApi.delete).toHaveBeenCalledWith(9);
  });
});
