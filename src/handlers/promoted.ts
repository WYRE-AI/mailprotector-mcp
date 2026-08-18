/**
 * Handlers for the promoted (non-router) first-class tools. Reads and
 * elicitation always precede the single mutating SDK call (MRTR retries
 * re-execute the handler from the top).
 */
import type {
  AccountData,
  DomainCreateData,
  MessageReleaseOptions,
} from "@wyre-technology/node-mailprotector";
import { confirmDelete } from "../elicitation.js";
import {
  jsonResult,
  optionalBoolean,
  optionalNumber,
  optionalObject,
  optionalString,
  requireArray,
  requireNumber,
  requireString,
  textResult,
} from "./results.js";
import { listParams, resolveScope } from "./scopes.js";
import type { HandlerResult, HandlerContext, ToolHandler } from "./types.js";

const ALL_SCOPES = ["reseller", "customer", "domain", "user_group", "user"] as const;
const CONFIG_SCOPES = ["reseller", "customer", "domain", "user_group"] as const;

function releaseOptions(args: Record<string, unknown>): MessageReleaseOptions | undefined {
  const includeOriginal = optionalBoolean(args, "include_original_recipients");
  const recipients = optionalString(args, "recipients");
  if (includeOriginal === undefined && recipients === undefined) return undefined;
  return {
    ...(includeOriginal !== undefined ? { include_original_recipients: includeOriginal } : {}),
    ...(recipients !== undefined ? { recipients } : {}),
  };
}

async function deleteAllowBlockRule(
  ctx: HandlerContext,
  args: Record<string, unknown>
): Promise<HandlerResult> {
  const ruleId = requireNumber(args, "rule_id");
  const gate = confirmDelete(
    ctx.elicitation,
    `Permanently delete allow/block rule ${ruleId}? Mail filtering changes for everything under its scope. This cannot be undone.`
  );
  if (gate.kind === "ask") return gate.result;
  if (gate.kind === "refused") {
    return textResult(`Cancelled — allow/block rule ${ruleId} was NOT deleted.`);
  }
  await ctx.client.allowBlockRules.delete(ruleId);
  return jsonResult({ deleted: true, rule_id: ruleId });
}

export const PROMOTED_HANDLERS: Record<string, ToolHandler> = {
  mailprotector_status: async (ctx) => {
    const reseller = await ctx.client.resellers.get(ctx.resellerId);
    return jsonResult({
      connected: true,
      reseller_id: ctx.resellerId,
      reseller,
    });
  },

  mailprotector_customers_list: async (ctx, args) =>
    jsonResult(
      await ctx.client.customers.list(
        optionalNumber(args, "reseller_id") ?? ctx.resellerId,
        listParams(args)
      )
    ),

  mailprotector_customers_get: async (ctx, args) =>
    jsonResult(await ctx.client.customers.get(requireNumber(args, "customer_id"))),

  mailprotector_customers_create: async (ctx, args) =>
    jsonResult(
      await ctx.client.customers.create(optionalNumber(args, "reseller_id") ?? ctx.resellerId, {
        ...(optionalObject(args, "data") ?? {}),
        name: requireString(args, "name"),
      } as AccountData)
    ),

  mailprotector_domains_list: async (ctx, args) => {
    const { scope, scopeId } = resolveScope(ctx, args, ["reseller", "customer"] as const);
    return jsonResult(await ctx.client.domains.listFor(scope, scopeId, listParams(args)));
  },

  mailprotector_domains_get: async (ctx, args) =>
    jsonResult(await ctx.client.domains.get(requireNumber(args, "domain_id"))),

  mailprotector_domains_create: async (ctx, args) =>
    jsonResult(
      await ctx.client.domains.create(requireNumber(args, "customer_id"), {
        ...(optionalObject(args, "data") ?? {}),
        name: requireString(args, "name"),
      } as DomainCreateData)
    ),

  mailprotector_users_list: async (ctx, args) => {
    const { scope, scopeId } = resolveScope(ctx, args, [
      "reseller",
      "customer",
      "domain",
      "user_group",
    ] as const);
    return jsonResult(await ctx.client.users.listFor(scope, scopeId, listParams(args)));
  },

  mailprotector_users_get: async (ctx, args) =>
    jsonResult(await ctx.client.users.get(requireNumber(args, "user_id"))),

  mailprotector_users_find_by_address: async (ctx, args) =>
    jsonResult(await ctx.client.users.findByAddress(requireString(args, "address"))),

  mailprotector_user_groups_list: async (ctx, args) =>
    jsonResult(
      await ctx.client.userGroups.list(requireNumber(args, "domain_id"), listParams(args))
    ),

  mailprotector_messages_list: async (ctx, args) => {
    const { scope, scopeId } = resolveScope(ctx, args, ALL_SCOPES);
    return jsonResult(await ctx.client.messages.listFor(scope, scopeId, listParams(args)));
  },

  mailprotector_messages_release: async (ctx, args) => {
    const messageId = requireNumber(args, "message_id");
    await ctx.client.messages.release(messageId, releaseOptions(args));
    return jsonResult({ released: true, message_id: messageId });
  },

  mailprotector_messages_release_many: async (ctx, args) => {
    const { scope, scopeId } = resolveScope(ctx, args, ALL_SCOPES);
    const ids = requireArray(args, "ids") as Array<number | string>;
    return jsonResult(
      await ctx.client.messages.releaseMany(scope, scopeId, ids, releaseOptions(args))
    );
  },

  mailprotector_allow_block_rules_list: async (ctx, args) => {
    const { scope, scopeId } = resolveScope(ctx, args, ALL_SCOPES);
    return jsonResult(await ctx.client.allowBlockRules.listFor(scope, scopeId, listParams(args)));
  },

  mailprotector_allow_block_rules_create: async (ctx, args) => {
    const { scope, scopeId } = resolveScope(ctx, args, ALL_SCOPES);
    const ruleType = requireString(args, "rule_type").toLowerCase();
    if (ruleType !== "allow" && ruleType !== "block") {
      return textResult('Argument "rule_type" must be "allow" or "block".');
    }
    return jsonResult(
      await ctx.client.allowBlockRules.createFor(scope, scopeId, {
        value: requireString(args, "value"),
        rule_type: ruleType,
      })
    );
  },

  mailprotector_allow_block_rules_delete: deleteAllowBlockRule,

  mailprotector_logs_list: async (ctx, args) => {
    const { scope, scopeId } = resolveScope(ctx, args, ALL_SCOPES);
    return jsonResult(await ctx.client.logs.listFor(scope, scopeId, listParams(args)));
  },

  mailprotector_configuration_get: async (ctx, args) => {
    const { scope, scopeId } = resolveScope(ctx, args, CONFIG_SCOPES);
    return jsonResult(await ctx.client.configuration.getFor(scope, scopeId));
  },
};
