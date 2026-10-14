# mailprotector-mcp

MCP server for [Mailprotector](https://api.mailprotector.com/) — email security management
for MSPs (CloudFilter, Bracket, SafeSend, XtraMail): customers, domains, users, quarantine,
allow/block rules, logs, configuration, and the full long-tail API via a router.

Built on the MCP **2026-07-28** spec via the split v2 SDK
(`@modelcontextprotocol/server` / `/node` / `/client` `^2.0.0-beta.5`) with **dual-era
serving**: one shared `McpServerFactory` behind `createMcpHandler({ legacy: 'stateless' })`
answers both 2025-era `initialize`-handshake clients (the WYRE gateway today) and modern
2026-07-28 envelope clients — with an identical, deterministic 22-tool surface for every
caller. Ships as a GHCR container only (no MCPB bundle).

## Tools (22 first-class + routed long tail)

**Router**: `mailprotector_status`, `mailprotector_list_categories`,
`mailprotector_list_category_tools`, `mailprotector_execute_tool`.

**Promoted reads**: `mailprotector_customers_list/get`, `mailprotector_domains_list/get`,
`mailprotector_users_list/get/find_by_address`, `mailprotector_user_groups_list`,
`mailprotector_messages_list`, `mailprotector_allow_block_rules_list`,
`mailprotector_logs_list`, `mailprotector_configuration_get`.

**Promoted writes**: `mailprotector_customers_create`, `mailprotector_domains_create`,
`mailprotector_messages_release` / `release_many` (⚠ HIGH-IMPACT),
`mailprotector_allow_block_rules_create` (⚠ HIGH-IMPACT), and the
⚠ DESTRUCTIVE — IRREVERSIBLE `mailprotector_allow_block_rules_delete`.

**Router categories** (52 routed operations via `mailprotector_execute_tool`):
`resellers` (CRUD), `customers` (update/delete), `domains`
(update/delete/move/aliases), `user_groups` (CRUD + services), `users`
(create/create_many/update/delete/reset_password/aliases), `managers` (CRUD +
notification destinations), `configuration` (update), `statements`,
`email_routing` (destinations/sources for domain|user_group), `user_syncs`
(CRUD + schedule + filters), `notifications` (user notification destinations),
`results` (find_by_code). Every routed delete is ⚠ DESTRUCTIVE and
confirmation-gated; discover schemas with `mailprotector_list_category_tools`.

### Scoped tools

Mailprotector's hierarchy is Provider → Reseller → Customer → Domain → User Group → User,
and many operations exist at several scopes. Scoped tools take `scope`
(`reseller | customer | domain | user_group | user`, per-tool subsets) plus `scope_id`;
`scope_id` defaults to the **bound reseller** when `scope` is `"reseller"`.

### Delete confirmations (MRTR elicitation)

Every delete flows through the SDK v2 MRTR seam: the handler returns
`input_required`, interactive clients see a confirmation prompt, and declining
cancels the delete. Callers that declared no elicitation capability — including
stateless 2025-era callers such as the WYRE Conduit gateway — **fall back to
proceeding** per the integration contract: elicitation here is purely additive,
and the gateway enforces destructive-tool access with its own server-side
per-tool classification gate.

## Credentials

| Env var (env mode) | Gateway header (`AUTH_MODE=gateway`) | Notes |
|---|---|---|
| `MAILPROTECTOR_API_KEY` | `X-Mailprotector-Api-Key` | Per manager-role, from the web console profile page. Sent as `Authorization: Bearer`. |
| `MAILPROTECTOR_RESELLER_ID` | `X-Mailprotector-Reseller-Id` | The MSP's reseller id — the default scope for scoped tools. |
| `MAILPROTECTOR_BASE_URL` (optional) | — | Default `https://emailservice.io`. |

Copy [`.env.example`](.env.example). The gateway Compose service does not load
`MAILPROTECTOR_API_KEY` or `MAILPROTECTOR_RESELLER_ID`.

| Variable | Required | Description |
|---|---|---|
| `MCP_TRANSPORT` | No | `stdio` (default) or `http`. The container image sets `http`. |
| `AUTH_MODE` | No | `gateway` (Docker image and Compose) or `env`. Gateway mode requires `X-Mailprotector-Api-Key` and `X-Mailprotector-Reseller-Id` on each `/mcp` request and never falls back to `MAILPROTECTOR_*`. `env` uses those variables only after S2S auth succeeds. Unset means `env` (stdio and single-tenant HTTP). |
| `CONDUIT_S2S_SECRET` | Yes for HTTP | Service-to-service secret. The HTTP server logs an error and exits non-zero when this is empty or a known placeholder (`changeme`, `secret`, `replace-me`, `replace-with-a-real-secret`, `your-s2s-secret`, and the other example values). Generate one with `openssl rand -hex 32`. Compose will not start without it. The value is never logged. |
| `MCP_ALLOW_INSECURE_DEV` | No | Set to exactly `1` only for local development to start HTTP without `CONDUIT_S2S_SECRET`. The process logs a warning, does not enforce `X-Gateway-S2S`, and binds `127.0.0.1` only. A non-loopback `MCP_HTTP_HOST` refuses to start. A known placeholder secret still refuses to start. |
| `MCP_HTTP_HOST` | No | Bind address when a real `CONDUIT_S2S_SECRET` is set. Unset keeps `0.0.0.0`, the historical container bind. The image and Compose set `0.0.0.0` inside the container. |
| `MCP_HTTP_PORT` | No | HTTP port. Defaults to `8080`. |

`/health` and `/healthz` stay unauthenticated and do not read credentials. The stdio transport does not use `CONDUIT_S2S_SECRET`.

In gateway mode a request missing either credential header (or with a non-numeric reseller id) is
answered `401` (JSON-RPC error `-32001`) before the MCP handler runs — it never falls
through to env credentials.

### HTTP authentication

With `MCP_TRANSPORT=http` and `CONDUIT_S2S_SECRET` set, every `/mcp` request must include `X-Gateway-S2S`. The check is `verifyS2sHeader` in [`src/s2s-verify.ts`](src/s2s-verify.ts): the header value is `t=<unix seconds>,v1=<hex>`, where the hex is HMAC-SHA256 of the literal string `t=<unix seconds>` keyed with `CONDUIT_S2S_SECRET` (64 lowercase hex characters). The timestamp must be within 300 seconds of the server clock. A missing or invalid header is HTTP 401, before vendor credentials are read.

```bash
TS=$(date +%s)
SIG=$(printf 't=%s' "$TS" | openssl dgst -sha256 -hmac "$CONDUIT_S2S_SECRET" -hex | awk '{print $NF}')
curl -sS http://127.0.0.1:8080/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H "X-Gateway-S2S: t=${TS},v1=${SIG}" \
  -H "X-Mailprotector-Api-Key: $MAILPROTECTOR_API_KEY" \
  -H "X-Mailprotector-Reseller-Id: $MAILPROTECTOR_RESELLER_ID" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

In `AUTH_MODE=gateway`, `/mcp` also requires `X-Mailprotector-Api-Key` and `X-Mailprotector-Reseller-Id`. Those headers are the only credential source for that request. `AUTH_MODE=env` still requires the signed `X-Gateway-S2S` header, then uses `MAILPROTECTOR_API_KEY` and `MAILPROTECTOR_RESELLER_ID` from the environment.

## Running

```bash
export NODE_AUTH_TOKEN=$(gh auth token)   # GitHub Packages auth for @wyre-ai/* + @wyre-technology/*
npm install
npm run build
node dist/index.js                        # stdio (default; no S2S secret)
# HTTP refuses to start until CONDUIT_S2S_SECRET is a real secret
CONDUIT_S2S_SECRET="$CONDUIT_S2S_SECRET" MCP_TRANSPORT=http node dist/index.js
# Local HTTP only, without a service-to-service secret (always binds 127.0.0.1)
MCP_ALLOW_INSECURE_DEV=1 MCP_TRANSPORT=http node dist/index.js
node scripts/smoke-dual-era.mjs           # proves both protocol eras serve the same tools
```

Docker (linux/amd64 per fleet law). The image listens on `0.0.0.0` inside the container (`MCP_HTTP_HOST`) and defaults to `AUTH_MODE=gateway`. Publish the port on loopback and pass a real S2S secret. In gateway mode, Mailprotector credentials arrive on each request as headers; they are not read from the environment.

```bash
docker build --platform linux/amd64 --build-arg NODE_AUTH_TOKEN=$(gh auth token) -t mailprotector-mcp .
docker run \
  -e CONDUIT_S2S_SECRET="$CONDUIT_S2S_SECRET" \
  -p 127.0.0.1:8080:8080 \
  mailprotector-mcp
```

Compose refuses to start when `CONDUIT_S2S_SECRET` is unset. The gateway service sets `AUTH_MODE=gateway`, does not inject `MAILPROTECTOR_API_KEY` or `MAILPROTECTOR_RESELLER_ID`, and publishes `127.0.0.1:8080:8080`:

```bash
CONDUIT_S2S_SECRET="$CONDUIT_S2S_SECRET" docker compose up
```

Single-tenant HTTP (`AUTH_MODE=env`) still requires the S2S secret, then uses `MAILPROTECTOR_API_KEY` and `MAILPROTECTOR_RESELLER_ID`. It is separate from the gateway Compose service above.

```bash
docker run \
  -e CONDUIT_S2S_SECRET="$CONDUIT_S2S_SECRET" \
  -e AUTH_MODE=env \
  -e MAILPROTECTOR_API_KEY=... \
  -e MAILPROTECTOR_RESELLER_ID=... \
  -p 127.0.0.1:8080:8080 \
  mailprotector-mcp
```

## Wire notes (expected dual-era behavior)

- Legacy-era POST responses are SSE-framed (`text/event-stream`) — parse the last
  `data:` line.
- Legacy GET/DELETE session operations answer 405: stateless serving has no sessions.

## License

Apache-2.0
