# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Releases are cut by semantic-release from Conventional Commits.

## [Unreleased]

### Added

- Initial Mailprotector MCP server, greenfield on the split MCP SDK v2
  (`@modelcontextprotocol/server` / `/node` `^2.0.0-beta.5`) targeting the
  2026-07-28 spec with dual-era serving: one shared `McpServerFactory` behind
  `createMcpHandler({ legacy: 'stateless' })` answers both 2025-era
  `initialize`-handshake clients and modern envelope clients.
- Deterministic 22-tool surface (router pattern): `mailprotector_status`,
  `mailprotector_list_categories`, `mailprotector_list_category_tools`,
  `mailprotector_execute_tool`, plus promoted customers/domains/users/
  user_groups/messages/allow_block_rules/logs/configuration tools.
- Router catalog covering all 52 long-tail SDK operations across 12
  categories (resellers, customers, domains, user_groups, users, managers,
  configuration, statements, email_routing, user_syncs, notifications,
  results).
- Destructive-tool convention (§2.7b): Tier A deletes are
  `⚠ DESTRUCTIVE — IRREVERSIBLE` with `destructiveHint`/`idempotentHint:false`;
  Tier B high-impact writes (message release, allow/block create, password
  reset, configuration update, user-group services update) are
  `⚠ HIGH-IMPACT`. Every destructive description ends with "Confirm with the
  user before invoking."
- MRTR elicitation seam for delete confirmations: handlers return
  `inputRequired()`; interactive clients confirm (decline cancels); callers
  without elicitation capability — including the stateless legacy path used
  by the WYRE Conduit gateway — fall back to proceeding per the integration
  contract (the gateway's server-side destructive-tool gate is the enforcement
  layer there).
- Gateway mode (`AUTH_MODE=gateway`): per-request credential binding from
  `X-Mailprotector-Api-Key` / `X-Mailprotector-Reseller-Id`; missing/partial
  headers are answered 401 in the HTTP layer before the MCP handler runs.
- Dual-era smoke script (`scripts/smoke-dual-era.mjs`) with legacy, modern
  (asserts negotiated 2026-07-28), and gateway 401-gate legs.
- Wire notes: legacy-era POST responses are SSE-framed; legacy GET/DELETE
  session operations answer 405 (stateless serving has no sessions).
