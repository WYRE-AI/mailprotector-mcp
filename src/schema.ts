/** JSON-Schema fragments shared by the promoted tools and the router catalog. */

export const ALL_SCOPES = ["reseller", "customer", "domain", "user_group", "user"] as const;

export function scopeProp(allowed: readonly string[]) {
  return {
    type: "string" as const,
    enum: [...allowed],
    description: `Entity scope for this operation (${allowed.join(" | ")}).`,
  };
}

export const scopeIdProp = {
  type: "number" as const,
  description:
    'Id of the entity at the chosen scope. Optional when scope is "reseller" — ' +
    "defaults to the reseller bound by the credentials.",
};

export const pageProp = {
  type: "number" as const,
  description: "1-based page number. Message lists cap at 50 results per page.",
};

export const filtersProp = {
  type: "object" as const,
  additionalProperties: true,
  description:
    "Arbitrary field filters passed straight to the query string " +
    '(e.g. {"first_name": "Bob"} or {"name": "example.com"}).',
};

export const dataProp = {
  type: "object" as const,
  additionalProperties: true,
  description: "Additional fields to include in the request body.",
};

export const READ_ANNOTATIONS = { readOnlyHint: true } as const;

// NOTE (§2.7b): Tier A/B destructive annotations are written INLINE on each
// destructive tool (tools.ts + router.ts) — not built by a helper — so
// scripts/lint-destructive-warnings.mjs finds the literal
// `destructiveHint: true` within its per-tool window.
