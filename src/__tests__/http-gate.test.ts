/**
 * Gateway 401 gate over the REAL HTTP stack (createHttpStack — the exact
 * routing src/index.ts serves, not a hand-mirrored replica): missing/partial
 * credential headers are rejected 401 BEFORE the MCP handler runs; complete
 * headers reach the factory, which binds a per-request client from those
 * exact header values.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mcpJson } from "./helpers.js";

const { ctorConfigs, resellersApi } = vi.hoisted(() => ({
  ctorConfigs: [] as Array<Record<string, unknown>>,
  resellersApi: { get: vi.fn() },
}));

vi.mock("@wyre-technology/node-mailprotector", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@wyre-technology/node-mailprotector")>();
  return {
    ...actual,
    MailprotectorClient: class {
      resellers = resellersApi;
      constructor(config: Record<string, unknown>) {
        ctorConfigs.push(config);
      }
    },
  };
});

const { createHttpStack } = await import("../http.js");

const HEADERS = {
  "X-Mailprotector-Api-Key": "gw-api-key-1",
  "X-Mailprotector-Reseller-Id": "777",
};

describe("gateway 401 gate + per-request binding", () => {
  let stack: ReturnType<typeof createHttpStack>;
  let base: string;

  beforeAll(async () => {
    // No env fallback exists in gateway mode by construction, but strip the
    // vars anyway so a regression would be caught as a leak here.
    delete process.env.MAILPROTECTOR_API_KEY;
    delete process.env.MAILPROTECTOR_RESELLER_ID;
    stack = createHttpStack({ gatewayMode: true });
    await new Promise<void>((resolve) => {
      stack.server.listen(0, "127.0.0.1", () => {
        const addr = stack.server.address();
        base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await stack.close();
  });

  beforeEach(() => {
    ctorConfigs.length = 0;
    resellersApi.get.mockReset();
  });

  function post(headers: Record<string, string>, body: unknown) {
    return fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...headers,
      },
      body: JSON.stringify(body),
    });
  }

  const toolsList = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };

  it("answers 401 with a JSON-RPC error when both credential headers are missing", async () => {
    const res = await post({}, toolsList);
    expect(res.status).toBe(401);
    const body = (await res.json()) as {
      error: { code: number; message: string; data: { required: string[] } };
    };
    expect(body.error.code).toBe(-32001);
    expect(body.error.data.required).toEqual([
      "X-Mailprotector-Api-Key",
      "X-Mailprotector-Reseller-Id",
    ]);
  });

  it("answers 401 on partial credentials (no partial bind)", async () => {
    const res = await post({ "X-Mailprotector-Api-Key": "gw-api-key-1" }, toolsList);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("X-Mailprotector-Reseller-Id");
  });

  it("answers 401 on a non-numeric reseller id", async () => {
    const res = await post(
      { "X-Mailprotector-Api-Key": "k", "X-Mailprotector-Reseller-Id": "not-a-number" },
      toolsList
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("positive integer");
  });

  it("answers 200 with the full tool surface when both headers are present", async () => {
    const res = await post(HEADERS, toolsList);
    expect(res.status).toBe(200);
    const body = (await mcpJson(res)) as { result: { tools: Array<{ name: string }> } };
    expect(body.result.tools).toHaveLength(22);
    expect(body.result.tools[0].name).toBe("mailprotector_status");
  });

  it("binds the client per request from the header values", async () => {
    resellersApi.get.mockResolvedValue({ id: 777, name: "GW Reseller" });
    const res = await post(HEADERS, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "mailprotector_status", arguments: {} },
    });
    expect(res.status).toBe(200);
    const body = (await mcpJson(res)) as {
      result: { content: Array<{ text: string }>; isError?: boolean };
    };
    expect(body.result.isError).toBeUndefined();
    expect(JSON.parse(body.result.content[0].text)).toMatchObject({ reseller_id: 777 });
    expect(ctorConfigs).toHaveLength(1);
    expect(ctorConfigs[0]).toMatchObject({ apiKey: "gw-api-key-1" });
    expect(resellersApi.get).toHaveBeenCalledWith(777);
  });

  it("re-binds on every request — a different tenant's headers reach a different client", async () => {
    resellersApi.get.mockResolvedValue({ id: 888 });
    const res = await post(
      { "X-Mailprotector-Api-Key": "gw-api-key-2", "X-Mailprotector-Reseller-Id": "888" },
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "mailprotector_status", arguments: {} },
      }
    );
    expect(res.status).toBe(200);
    expect(ctorConfigs).toHaveLength(1);
    expect(ctorConfigs[0]).toMatchObject({ apiKey: "gw-api-key-2" });
    expect(resellersApi.get).toHaveBeenCalledWith(888);
  });

  it("serves /health without credentials", async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; authMode: string };
    expect(body.status).toBe("ok");
    expect(body.authMode).toBe("gateway");
  });
});
