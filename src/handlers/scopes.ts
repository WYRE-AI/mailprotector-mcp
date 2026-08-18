/** Scope resolution shared by every scoped tool (contract §Scope consolidation). */
import type { EntityScope, ListParams } from "@wyre-technology/node-mailprotector";
import { ToolInputError, optionalNumber, optionalObject, requireString } from "./results.js";
import type { HandlerContext } from "./types.js";

/**
 * Resolve the `scope` + `scope_id` argument pair. `scope_id` defaults to the
 * bound reseller when `scope` is "reseller"; every other scope requires an
 * explicit id.
 */
export function resolveScope<S extends EntityScope>(
  ctx: HandlerContext,
  args: Record<string, unknown>,
  allowed: readonly S[]
): { scope: S; scopeId: number } {
  const scope = requireString(args, "scope") as S;
  if (!allowed.includes(scope)) {
    throw new ToolInputError(`Argument "scope" must be one of: ${allowed.join(", ")}.`);
  }
  let scopeId = optionalNumber(args, "scope_id");
  if (scopeId === undefined) {
    if (scope === "reseller") {
      scopeId = ctx.resellerId;
    } else {
      throw new ToolInputError(`Argument "scope_id" is required when scope is "${scope}".`);
    }
  }
  return { scope, scopeId };
}

/** Assemble Mailprotector list params from `page` + passthrough `filters`. */
export function listParams(args: Record<string, unknown>): ListParams | undefined {
  const page = optionalNumber(args, "page");
  const filters = optionalObject(args, "filters");
  if (page === undefined && filters === undefined) return undefined;
  return {
    ...((filters ?? {}) as ListParams),
    ...(page !== undefined ? { page } : {}),
  };
}
