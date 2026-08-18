# Contributing to mailprotector-mcp

Thanks for helping improve the Mailprotector MCP server.

## Development setup

```bash
export NODE_AUTH_TOKEN=$(gh auth token)   # GitHub Packages registry auth
npm install
```

## Workflow

- `npm run build` — tsc build to `dist/`.
- `npm test` — vitest suite.
- `npm run lint` — eslint; `npm run typecheck` — `tsc --noEmit`.
- `node scripts/lint-destructive-warnings.mjs src` — destructive-warning convention gate.
- `node scripts/smoke-dual-era.mjs` — dual-era serving proof (run after build).

All of the above must pass before a PR is merged.

## Invariants (do not break)

- **Stateless tool surface**: `tools/list` must return the same tools in the same order for
  every caller. No sessions, no per-user variance, no runtime sorting/filtering.
- **Never `legacy: 'reject'`** on `createMcpHandler` — it turns away every 2025-era client.
- **The gateway 401 gate lives in the HTTP layer**, before the MCP handler — a throwing
  factory would surface as a 500, and falling through to env credentials is a
  cross-tenant leak.
- **Reads and elicitation precede the single mutating vendor call** in every handler —
  MRTR retries re-execute handlers from the top.
- **Destructive tools** carry the §2.7b description prefix + annotations, written inline
  (the lint script needs the literal `destructiveHint: true` near each tool name).

## Commits

Conventional Commits (`feat:`, `fix:`, `docs:`, ...) — semantic-release cuts versions
from them on `main`.
