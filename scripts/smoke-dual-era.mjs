#!/usr/bin/env node
// Dual-era smoke test: proves the HTTP entrypoint serves BOTH protocol eras.
//   (a) LEGACY leg — hand-crafted 2025-era JSON-RPC POSTs: initialize →
//       notifications/initialized → tools/list.
//   (b) MODERN leg — @modelcontextprotocol/client@2 (StreamableHTTP transport,
//       2026-07-28 negotiation): connect → tools/list.
// Both legs must see the same non-empty tool surface.
//   (c) GATEWAY leg — a second process in AUTH_MODE=gateway with NO env
//       credentials, proving the 401 gate rejects missing/partial credential
//       headers rather than falling through to env-configured ones. That
//       fallthrough would be a cross-tenant leak, so it is asserted here and
//       not only unit-tested.
// Run after `npm run build`:
//   node scripts/smoke-dual-era.mjs

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const serverEntry = resolve(root, 'dist/index.js');
const PORT = 38700 + Math.floor(Math.random() * 200);
const BASE = `http://127.0.0.1:${PORT}`;
const GATEWAY_PORT = PORT + 300;
const GATEWAY_BASE = `http://127.0.0.1:${GATEWAY_PORT}`;
const SERVER_NAME = 'mailprotector-mcp';

/** The gateway-injected credential headers, per the integration contract. */
const CRED_HEADERS = {
  'X-Mailprotector-Api-Key': 'gateway-api-key',
  'X-Mailprotector-Reseller-Id': '42',
};

const failures = [];
function check(label, ok, detail = '') {
  const status = ok ? 'PASS' : 'FAIL';
  console.log(`  [${status}] ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(label);
}

/** Parse a Streamable HTTP response body: plain JSON or a single-message SSE stream. */
async function mcpBody(res) {
  const text = await res.text();
  const contentType = res.headers.get('content-type') ?? '';
  if (contentType.includes('text/event-stream')) {
    const dataLines = text.split('\n').filter((line) => line.startsWith('data:'));
    const last = dataLines[dataLines.length - 1];
    if (!last) throw new Error(`No data frame in SSE body: ${JSON.stringify(text)}`);
    return JSON.parse(last.slice('data:'.length).trim());
  }
  return JSON.parse(text);
}

async function legacyPost(body) {
  return fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify(body),
  });
}

async function waitForHealth(base = BASE, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/health`);
      if (res.ok) return res.json();
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Server did not become healthy on ${base} within ${timeoutMs}ms`);
}

/**
 * Gateway leg: a separate process in AUTH_MODE=gateway started with the
 * MAILPROTECTOR_* env vars explicitly stripped, so a 200 on an
 * unauthenticated request could only mean the gate fell through to env
 * credentials — the cross-tenant leak this asserts against.
 */
async function gatewayLeg(expectedToolCount) {
  console.log('\nGATEWAY leg (AUTH_MODE=gateway, no env credentials):');
  const {
    MAILPROTECTOR_API_KEY: _key,
    MAILPROTECTOR_RESELLER_ID: _rid,
    ...cleanEnv
  } = process.env;
  const child = spawn(process.execPath, [serverEntry], {
    cwd: root,
    env: {
      ...cleanEnv,
      AUTH_MODE: 'gateway',
      MCP_TRANSPORT: 'http',
      MCP_HTTP_PORT: String(GATEWAY_PORT),
      MCP_HTTP_HOST: '127.0.0.1',
      LOG_LEVEL: 'error',
    },
    stdio: ['ignore', 'inherit', 'inherit'],
  });

  const post = (headers, body) =>
    fetch(`${GATEWAY_BASE}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
      body: JSON.stringify(body),
    });
  const toolsList = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };

  try {
    await waitForHealth(GATEWAY_BASE);

    const none = await post({}, toolsList);
    check('no credential headers → 401', none.status === 401, `status=${none.status}`);
    const body = await none.json().catch(() => null);
    check('401 body is a JSON-RPC error naming the required headers',
      body?.error?.code === -32001 && Array.isArray(body?.error?.data?.required),
      `code=${body?.error?.code} required=${(body?.error?.data?.required ?? []).join(',')}`);

    const { 'X-Mailprotector-Reseller-Id': _omitted, ...partial } = CRED_HEADERS;
    const partialRes = await post(partial, toolsList);
    check('partial credential headers → 401 (no partial bind)', partialRes.status === 401, `status=${partialRes.status}`);

    const full = await post(CRED_HEADERS, toolsList);
    check('complete credential headers → 200', full.status === 200, `status=${full.status}`);
    const tools = (await mcpBody(full))?.result?.tools ?? [];
    check('gateway mode serves the same tool surface', tools.length === expectedToolCount,
      `gateway=${tools.length} expected=${expectedToolCount}`);
  } finally {
    child.kill('SIGTERM');
  }
}

async function legacyLeg() {
  console.log('\nLEGACY leg (2025-era classic JSON-RPC handshake):');
  const initRes = await legacyPost({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'smoke-legacy', version: '0.0.0' },
    },
  });
  check('initialize HTTP 200', initRes.status === 200, `status=${initRes.status}`);
  const init = await mcpBody(initRes);
  const result = init?.result;
  check(
    'InitializeResult has protocolVersion + serverInfo + capabilities',
    typeof result?.protocolVersion === 'string' &&
      result?.serverInfo?.name === SERVER_NAME &&
      typeof result?.capabilities === 'object',
    `protocolVersion=${result?.protocolVersion} serverInfo=${result?.serverInfo?.name}`
  );

  const notifRes = await legacyPost({ jsonrpc: '2.0', method: 'notifications/initialized' });
  check('notifications/initialized accepted', notifRes.status >= 200 && notifRes.status < 300, `status=${notifRes.status}`);

  const toolsRes = await legacyPost({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  check('tools/list HTTP 200', toolsRes.status === 200, `status=${toolsRes.status}`);
  const tools = (await mcpBody(toolsRes))?.result?.tools ?? [];
  check('tools/list returns >0 tools', tools.length > 0, `count=${tools.length}`);
  return tools;
}

async function modernLeg() {
  console.log('\nMODERN leg (@modelcontextprotocol/client v2, 2026-07-28 era):');
  const { Client, StreamableHTTPClientTransport } = await import('@modelcontextprotocol/client');

  const client = new Client(
    { name: 'smoke-modern', version: '0.0.0' },
    // 'auto' negotiates the 2026-07-28 era via server/discover; the default
    // ('legacy') would silently run a plain 2025 connect sequence.
    { versionNegotiation: { mode: 'auto' } }
  );
  const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`));
  await client.connect(transport);
  const negotiated = client.getNegotiatedProtocolVersion?.();
  check('client negotiated the 2026-07-28 era', negotiated === '2026-07-28', `negotiated=${negotiated}`);

  const { tools } = await client.listTools();
  check('tools/list returns >0 tools', tools.length > 0, `count=${tools.length}`);
  await client.close();
  return tools;
}

async function main() {
  if (!existsSync(serverEntry)) {
    console.error(`Missing ${serverEntry} — run 'npm run build' first.`);
    process.exit(1);
  }

  const child = spawn(process.execPath, [serverEntry], {
    cwd: root,
    env: {
      ...process.env,
      MCP_TRANSPORT: 'http',
      MCP_HTTP_PORT: String(PORT),
      MCP_HTTP_HOST: '127.0.0.1',
      // env-mode dummy credentials — tools/list never touches the vendor API
      MAILPROTECTOR_API_KEY: 'smoke-dummy-key',
      MAILPROTECTOR_RESELLER_ID: '42',
      LOG_LEVEL: 'error',
    },
    stdio: ['ignore', 'inherit', 'inherit'],
  });

  try {
    const health = await waitForHealth();
    check('health probe ok', health?.status === 'ok', `version=${health?.version}`);

    const legacyTools = await legacyLeg();
    const modernTools = await modernLeg();

    console.log('\nCross-era comparison:');
    check('both eras serve the same tool count', legacyTools.length === modernTools.length,
      `legacy=${legacyTools.length} modern=${modernTools.length}`);
    const legacyNames = new Set(legacyTools.map((t) => t.name));
    const modernNames = new Set(modernTools.map((t) => t.name));
    const drift = [...legacyNames].filter((n) => !modernNames.has(n))
      .concat([...modernNames].filter((n) => !legacyNames.has(n)));
    check('both eras serve the same tool names', drift.length === 0, drift.join(', ') || 'no drift');

    await gatewayLeg(modernTools.length);
  } catch (error) {
    check('smoke run completed without exception', false, String(error));
  } finally {
    child.kill('SIGTERM');
  }

  if (failures.length > 0) {
    console.error(`\nSMOKE FAILED: ${failures.length} check(s): ${failures.join('; ')}`);
    process.exit(1);
  }
  console.log('\nSMOKE PASSED: both protocol eras served by the same factory; gateway gate rejects incomplete credentials.');
  process.exit(0);
}

main().catch((error) => { console.error('Smoke script crashed:', error); process.exit(1); });
