/**
 * Dual-era serving determinism over the REAL stack: two separate connections
 * — one legacy 2025-era (classic initialize handshake) and one modern
 * 2026-07-28 (@modelcontextprotocol/client with versionNegotiation auto) —
 * must see the identical tool surface: same names, same order.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHttpStack } from "../http.js";
import { TOOLS } from "../tools.js";
import { mcpJson } from "./helpers.js";

const ENV = {
  MAILPROTECTOR_API_KEY: "test-api-key",
  MAILPROTECTOR_RESELLER_ID: "42",
} as const;

describe("dual-era tool-list determinism", () => {
  let stack: ReturnType<typeof createHttpStack>;
  let base: string;

  beforeAll(async () => {
    Object.assign(process.env, ENV);
    stack = createHttpStack({ gatewayMode: false });
    await new Promise<void>((resolve) => {
      stack.server.listen(0, "127.0.0.1", () => {
        const addr = stack.server.address();
        base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    for (const key of Object.keys(ENV)) delete process.env[key];
    await stack.close();
  });

  async function legacyConnectionTools(): Promise<string[]> {
    const post = (body: unknown) =>
      fetch(`${base}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify(body),
      });

    const initRes = await post({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "det-legacy", version: "0.0.0" },
      },
    });
    expect(initRes.status).toBe(200);
    const init = (await mcpJson(initRes)) as {
      result: { serverInfo: { name: string } };
    };
    expect(init.result.serverInfo.name).toBe("mailprotector-mcp");

    const toolsRes = await post({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const body = (await mcpJson(toolsRes)) as { result: { tools: Array<{ name: string }> } };
    return body.result.tools.map((t) => t.name);
  }

  async function modernConnectionTools(): Promise<string[]> {
    const { Client, StreamableHTTPClientTransport } = await import("@modelcontextprotocol/client");
    const client = new Client(
      { name: "det-modern", version: "0.0.0" },
      { versionNegotiation: { mode: "auto" } }
    );
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
    try {
      expect(client.getNegotiatedProtocolVersion?.()).toBe("2026-07-28");
      const { tools } = await client.listTools();
      return tools.map((t) => t.name);
    } finally {
      await client.close();
    }
  }

  it("two connections across both eras see identical names in identical order", async () => {
    const legacyNames = await legacyConnectionTools();
    const modernNames = await modernConnectionTools();
    const sourceNames = TOOLS.map((t) => t.name);

    expect(legacyNames).toEqual(sourceNames);
    expect(modernNames).toEqual(sourceNames);
    expect(legacyNames).toEqual(modernNames);
  });
});
