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

In gateway mode a request missing either header (or with a non-numeric reseller id) is
answered `401` (JSON-RPC error `-32001`) before the MCP handler runs — it never falls
through to env credentials.

## Running

```bash
export NODE_AUTH_TOKEN=$(gh auth token)   # GitHub Packages auth for @wyre-technology/*
npm install
npm run build
node dist/index.js                        # stdio (default)
MCP_TRANSPORT=http node dist/index.js     # HTTP on :8080 (/mcp, /health)
node scripts/smoke-dual-era.mjs           # proves both protocol eras serve the same tools
```

Docker (linux/amd64 per fleet law):

```bash
docker build --platform linux/amd64 --build-arg NODE_AUTH_TOKEN=$(gh auth token) -t mailprotector-mcp .
docker run -p 8080:8080 -e AUTH_MODE=env \
  -e MAILPROTECTOR_API_KEY=... -e MAILPROTECTOR_RESELLER_ID=... mailprotector-mcp
```

## Wire notes (expected dual-era behavior)

- Legacy-era POST responses are SSE-framed (`text/event-stream`) — parse the last
  `data:` line.
- Legacy GET/DELETE session operations answer 405: stateless serving has no sessions.

## License

Apache-2.0
