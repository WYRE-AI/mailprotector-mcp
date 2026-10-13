/**
 * HTTP transport fail-closed auth (CWE-306).
 *
 * Startup requires a real CONDUIT_S2S_SECRET. Empty and known placeholders
 * refuse to listen. MCP_ALLOW_INSECURE_DEV=1 is the empty-secret bypass: it
 * binds 127.0.0.1 and refuses a non-loopback MCP_HTTP_HOST.
 * /mcp rejects a missing or invalid X-Gateway-S2S header.
 * AUTH_MODE=gateway rejects requests that omit vendor credential headers
 * and must not fall back to MAILPROTECTOR_* in process.env.
 */

import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { ctorConfigs, resellersApi } = vi.hoisted(() => ({
  ctorConfigs: [] as Array<Record<string, unknown>>,
  resellersApi: { get: vi.fn() },
}));

vi.mock("@wyre-technology/node-mailprotector", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@wyre-technology/node-mailprotector")>();
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

const { startHttpTransport } = await import("../http.js");
type HttpStack = Awaited<ReturnType<typeof startHttpTransport>>;

const S2S_SECRET = "s2s-do-not-log-7f3a";
const ENV_API_KEY = "env-api-key-must-not-be-used";
const ENV_RESELLER_ID = "99999";

const ENV_KEYS = [
  "CONDUIT_S2S_SECRET",
  "MCP_ALLOW_INSECURE_DEV",
  "MCP_HTTP_PORT",
  "MCP_HTTP_HOST",
  "AUTH_MODE",
  "MAILPROTECTOR_API_KEY",
  "MAILPROTECTOR_RESELLER_ID",
  "MAILPROTECTOR_BASE_URL",
  "LOG_LEVEL",
  "MCP_TRANSPORT",
] as const;

const savedEnv = new Map<string, string | undefined>();
const stacks: HttpStack[] = [];

function mintS2sHeader(secret: string, unixSeconds = Math.floor(Date.now() / 1000)): string {
  const message = `t=${unixSeconds}`;
  const hex = createHmac("sha256", secret).update(message).digest("hex");
  return `${message},v1=${hex}`;
}

function captureStderr(): { text: () => string; restore: () => void } {
  const lines: string[] = [];
  const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    lines.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  });
  return {
    text: () => lines.join(""),
    restore: () => spy.mockRestore(),
  };
}

async function listen(): Promise<{ port: number; address: string; stack: HttpStack }> {
  const stack = await startHttpTransport();
  stacks.push(stack);
  const bound = stack.server.address() as AddressInfo | null;
  if (!bound || typeof bound === "string") {
    throw new Error("HTTP server did not bind a TCP port");
  }
  return { port: bound.port, address: bound.address, stack };
}

function mcpHeaders(extra?: Record<string, string>): Record<string, string> {
  return {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    ...extra,
  };
}

async function postMcp(
  port: number,
  headers: Record<string, string>,
  body: unknown
): Promise<{ status: number; text: string; json: unknown }> {
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: mcpHeaders(headers),
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const contentType = res.headers.get("content-type") ?? "";
  let json: unknown = null;
  if (text) {
    if (contentType.includes("text/event-stream")) {
      const dataLines = text.split("\n").filter((line) => line.startsWith("data:"));
      const last = dataLines[dataLines.length - 1];
      json = last ? JSON.parse(last.slice("data:".length).trim()) : null;
    } else {
      json = JSON.parse(text);
    }
  }
  return { status: res.status, text, json };
}

const statusCall = {
  jsonrpc: "2.0",
  id: 1,
  method: "tools/call",
  params: { name: "mailprotector_status", arguments: {} },
};

beforeAll(() => {
  for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);
});

afterAll(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

beforeEach(() => {
  process.env.MCP_HTTP_PORT = "0";
  process.env.MCP_HTTP_HOST = "127.0.0.1";
  process.env.LOG_LEVEL = "info";
  delete process.env.CONDUIT_S2S_SECRET;
  delete process.env.MCP_ALLOW_INSECURE_DEV;
  delete process.env.AUTH_MODE;
  delete process.env.MAILPROTECTOR_API_KEY;
  delete process.env.MAILPROTECTOR_RESELLER_ID;
  delete process.env.MAILPROTECTOR_BASE_URL;
  ctorConfigs.length = 0;
  resellersApi.get.mockReset();
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`process.exit:${String(code)}`);
  }) as typeof process.exit);
});

afterEach(async () => {
  vi.restoreAllMocks();
  while (stacks.length > 0) {
    const stack = stacks.pop();
    if (!stack?.server.listening) continue;
    await stack.close();
  }
});

describe("HTTP startup", () => {
  it("refuses to start when CONDUIT_S2S_SECRET is empty", async () => {
    const logs = captureStderr();
    try {
      await expect(startHttpTransport()).rejects.toThrow("process.exit:1");
      expect(process.exit).toHaveBeenCalledWith(1);
      const text = logs.text();
      expect(text).toContain("Refusing to start HTTP transport");
      expect(text).toContain("CONDUIT_S2S_SECRET is empty");
      expect(text).not.toContain(S2S_SECRET);
    } finally {
      logs.restore();
    }
  });

  it("refuses to start when CONDUIT_S2S_SECRET is whitespace", async () => {
    process.env.CONDUIT_S2S_SECRET = "   ";
    const logs = captureStderr();
    try {
      await expect(startHttpTransport()).rejects.toThrow("process.exit:1");
      expect(process.exit).toHaveBeenCalledWith(1);
      expect(logs.text()).toContain("CONDUIT_S2S_SECRET is empty");
    } finally {
      logs.restore();
    }
  });

  it("still refuses when MCP_ALLOW_INSECURE_DEV is not exactly 1", async () => {
    process.env.MCP_ALLOW_INSECURE_DEV = "true";
    const logs = captureStderr();
    try {
      await expect(startHttpTransport()).rejects.toThrow("process.exit:1");
      expect(logs.text()).toContain("Refusing to start HTTP transport");
    } finally {
      logs.restore();
    }
  });

  it.each(["changeme", "Change-Me", "  replace-with-a-real-secret  ", "your-s2s-secret"])(
    "refuses known placeholder %j and does not log it",
    async (placeholder) => {
      process.env.CONDUIT_S2S_SECRET = placeholder;
      const logs = captureStderr();
      try {
        await expect(startHttpTransport()).rejects.toThrow("process.exit:1");
        expect(process.exit).toHaveBeenCalledWith(1);
        const text = logs.text();
        expect(text).toContain("known placeholder");
        expect(text).toContain("openssl rand -hex 32");
        expect(text).not.toContain(placeholder.trim());
        expect(text).not.toContain(`CONDUIT_S2S_SECRET=${placeholder.trim()}`);
      } finally {
        logs.restore();
      }
    }
  );

  it("refuses the placeholder word secret without echoing the configured value", async () => {
    process.env.CONDUIT_S2S_SECRET = "secret";
    const logs = captureStderr();
    try {
      await expect(startHttpTransport()).rejects.toThrow("process.exit:1");
      const text = logs.text();
      expect(text).toContain("known placeholder");
      expect(text).not.toContain("CONDUIT_S2S_SECRET=secret");
    } finally {
      logs.restore();
    }
  });

  it("refuses a placeholder even when MCP_ALLOW_INSECURE_DEV=1", async () => {
    process.env.CONDUIT_S2S_SECRET = "your-s2s-secret";
    process.env.MCP_ALLOW_INSECURE_DEV = "1";
    const logs = captureStderr();
    try {
      await expect(startHttpTransport()).rejects.toThrow("process.exit:1");
      const text = logs.text();
      expect(text).toContain("known placeholder");
      expect(text).not.toContain("your-s2s-secret");
      expect(text).not.toContain("SECURITY WARNING");
    } finally {
      logs.restore();
    }
  });

  it("allows startup with a warning when MCP_ALLOW_INSECURE_DEV=1 and binds 127.0.0.1", async () => {
    process.env.MCP_ALLOW_INSECURE_DEV = "1";
    delete process.env.MCP_HTTP_HOST;
    const logs = captureStderr();
    try {
      const server = await listen();
      expect(process.exit).not.toHaveBeenCalled();
      expect(server.address).toBe("127.0.0.1");
      const text = logs.text();
      expect(text).toContain("SECURITY WARNING");
      expect(text).toContain("CONDUIT_S2S_SECRET");
      expect(text).toContain("MCP_ALLOW_INSECURE_DEV=1");
      expect(text).toContain("127.0.0.1");
      expect(text).not.toContain(S2S_SECRET);
    } finally {
      logs.restore();
    }
  });

  it("forces 127.0.0.1 when the dev bypass host is localhost", async () => {
    process.env.MCP_ALLOW_INSECURE_DEV = "1";
    process.env.MCP_HTTP_HOST = "localhost";
    const logs = captureStderr();
    try {
      const server = await listen();
      expect(server.address).toBe("127.0.0.1");
      expect(logs.text()).toContain("SECURITY WARNING");
      expect(logs.text()).toContain("listening on http://127.0.0.1:");
    } finally {
      logs.restore();
    }
  });

  it.each(["0.0.0.0", "10.1.2.3"])("refuses the dev bypass when MCP_HTTP_HOST is %s", async (host) => {
    process.env.MCP_ALLOW_INSECURE_DEV = "1";
    process.env.MCP_HTTP_HOST = host;
    const logs = captureStderr();
    try {
      await expect(startHttpTransport()).rejects.toThrow("process.exit:1");
      expect(process.exit).toHaveBeenCalledWith(1);
      const text = logs.text();
      expect(text).toContain("Refusing to start HTTP transport");
      expect(text).toContain("MCP_ALLOW_INSECURE_DEV");
      expect(text).toContain("127.0.0.1");
      expect(text).toContain(`MCP_HTTP_HOST=${host}`);
      expect(text).toContain("not loopback");
      expect(text).not.toContain(S2S_SECRET);
    } finally {
      logs.restore();
    }
  });

  it("honors a non-loopback MCP_HTTP_HOST when CONDUIT_S2S_SECRET is set", async () => {
    process.env.CONDUIT_S2S_SECRET = S2S_SECRET;
    process.env.MCP_HTTP_HOST = "0.0.0.0";
    const logs = captureStderr();
    try {
      const server = await listen();
      expect(server.address).toBe("0.0.0.0");
      expect(logs.text()).not.toContain("not loopback");
      expect(logs.text()).not.toContain(S2S_SECRET);
    } finally {
      logs.restore();
    }
  });

  it("keeps the 0.0.0.0 bind when a secret is set and MCP_HTTP_HOST is unset", async () => {
    process.env.CONDUIT_S2S_SECRET = S2S_SECRET;
    delete process.env.MCP_HTTP_HOST;
    const server = await listen();
    expect(server.address).toBe("0.0.0.0");
  });
});

describe("HTTP /mcp authentication", () => {
  beforeEach(() => {
    process.env.CONDUIT_S2S_SECRET = S2S_SECRET;
    process.env.AUTH_MODE = "gateway";
    process.env.MCP_HTTP_HOST = "127.0.0.1";
    process.env.MAILPROTECTOR_API_KEY = ENV_API_KEY;
    process.env.MAILPROTECTOR_RESELLER_ID = ENV_RESELLER_ID;
  });

  it("returns 401 when the S2S header is missing or invalid and does not log the secret", async () => {
    const logs = captureStderr();
    const server = await listen();
    try {
      const missing = await postMcp(server.port, {}, statusCall);
      const invalid = await postMcp(server.port, { "x-gateway-s2s": mintS2sHeader("wrong-secret") }, statusCall);

      expect(missing.status).toBe(401);
      expect(invalid.status).toBe(401);
      expect(missing.text).toContain("X-Gateway-S2S");
      expect(invalid.text).toContain("X-Gateway-S2S");
      expect(missing.text).not.toContain(S2S_SECRET);
      expect(invalid.text).not.toContain(S2S_SECRET);
      expect(missing.text).not.toContain(ENV_API_KEY);
      expect(missing.text).not.toContain(ENV_RESELLER_ID);
      expect(logs.text()).not.toContain(S2S_SECRET);
      expect(ctorConfigs).toHaveLength(0);
    } finally {
      logs.restore();
    }
  });

  it("returns 401 in gateway mode without credential headers and does not use env credentials", async () => {
    const server = await listen();
    const response = await postMcp(server.port, { "x-gateway-s2s": mintS2sHeader(S2S_SECRET) }, statusCall);

    expect(response.status).toBe(401);
    expect(response.text).toContain("Missing credentials");
    expect(response.text).toContain("X-Mailprotector-Api-Key");
    expect(response.text).toContain("X-Mailprotector-Reseller-Id");
    expect(response.text).not.toContain(ENV_API_KEY);
    expect(response.text).not.toContain(ENV_RESELLER_ID);
    expect(response.text).not.toContain(S2S_SECRET);
    expect(ctorConfigs).toHaveLength(0);

    const partial = await postMcp(
      server.port,
      {
        "x-gateway-s2s": mintS2sHeader(S2S_SECRET),
        "x-mailprotector-api-key": "header-only-key",
      },
      statusCall
    );
    expect(partial.status).toBe(401);
    expect(ctorConfigs).toHaveLength(0);
  });

  it("rejects whitespace-only gateway credential headers", async () => {
    const server = await listen();
    const response = await postMcp(
      server.port,
      {
        "x-gateway-s2s": mintS2sHeader(S2S_SECRET),
        "x-mailprotector-api-key": "   ",
        "x-mailprotector-reseller-id": "   ",
      },
      statusCall
    );

    expect(response.status).toBe(401);
    expect(response.text).toContain("Missing credentials");
    expect(ctorConfigs).toHaveLength(0);
  });

  it("accepts a valid S2S header plus credential headers and uses those credentials", async () => {
    resellersApi.get.mockResolvedValue({ id: 777, name: "GW Reseller" });
    const logs = captureStderr();
    const server = await listen();
    try {
      const response = await postMcp(
        server.port,
        {
          "x-gateway-s2s": mintS2sHeader(S2S_SECRET),
          "x-mailprotector-api-key": "header-api-key",
          "x-mailprotector-reseller-id": "777",
        },
        statusCall
      );

      expect(response.status).toBe(200);
      expect(response.text).not.toContain(S2S_SECRET);
      expect(response.text).not.toContain(ENV_API_KEY);
      expect(response.text).not.toContain(ENV_RESELLER_ID);
      const payload = response.json as {
        result?: { content?: Array<{ text?: string }> };
      };
      const text = payload.result?.content?.[0]?.text ?? "";
      const status = JSON.parse(text) as { connected?: boolean; reseller_id?: number };
      expect(status.connected).toBe(true);
      expect(status.reseller_id).toBe(777);
      expect(ctorConfigs).toEqual([expect.objectContaining({ apiKey: "header-api-key" })]);
      expect(resellersApi.get).toHaveBeenCalledWith(777);
      expect(logs.text()).not.toContain(S2S_SECRET);
      expect(logs.text()).not.toContain(ENV_API_KEY);
    } finally {
      logs.restore();
    }
  });

  it("serves /health and /healthz without authentication and without reading credentials", async () => {
    const server = await listen();
    for (const path of ["/health", "/healthz"]) {
      const response = await fetch(`http://127.0.0.1:${server.port}${path}`);
      const text = await response.text();
      expect(response.status).toBe(200);
      const body = JSON.parse(text) as { status?: string; authMode?: string };
      expect(body.status).toBe("ok");
      expect(body.authMode).toBe("gateway");
      expect(text).not.toContain(S2S_SECRET);
      expect(text).not.toContain(ENV_API_KEY);
      expect(text).not.toContain(ENV_RESELLER_ID);
    }
    expect(ctorConfigs).toHaveLength(0);
  });
});

describe("env-mode HTTP still requires S2S", () => {
  it("returns 401 when the S2S header is missing", async () => {
    process.env.CONDUIT_S2S_SECRET = S2S_SECRET;
    process.env.AUTH_MODE = "env";
    process.env.MAILPROTECTOR_API_KEY = ENV_API_KEY;
    process.env.MAILPROTECTOR_RESELLER_ID = "42";
    const server = await listen();
    const response = await postMcp(server.port, {}, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {},
    });
    expect(response.status).toBe(401);
    expect(response.text).toContain("X-Gateway-S2S");
    expect(response.text).not.toContain(ENV_API_KEY);
    expect(ctorConfigs).toHaveLength(0);
  });
});
