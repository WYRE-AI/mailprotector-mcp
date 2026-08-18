/**
 * Router catalog — every Mailprotector SDK operation NOT promoted to a
 * first-class tool, reachable via mailprotector_execute_tool(category, tool,
 * args). Deterministic order: categories and tools are module-scope arrays,
 * never sorted or filtered at runtime, so mailprotector_list_categories and
 * mailprotector_list_category_tools return identical output for every caller.
 *
 * Destructive routed tools follow the same §2.7b convention as promoted
 * tools (⚠ prefix + annotations, surfaced through
 * mailprotector_list_category_tools) and every delete flows through the MRTR
 * confirmDelete() elicitation gate before the mutating SDK call fires.
 */
import type {
  AccountData,
  EntityConfigurationUpdate,
  ManagerCreateData,
  NotificationDestinationCreateData,
  UserCreateData,
  UserGroupServicesUpdateData,
  UserSyncData,
  UserSyncFilterCreateData,
  UserSyncScheduleUpdateData,
  UserUpdateData,
} from "@wyre-technology/node-mailprotector";
import { confirmDelete } from "./elicitation.js";
import {
  jsonResult,
  requireArray,
  requireNumber,
  requireObject,
  requireString,
  optionalNumber,
  optionalObject,
  textResult,
} from "./handlers/results.js";
import { listParams, resolveScope } from "./handlers/scopes.js";
import type { HandlerContext, ToolHandler } from "./handlers/types.js";
import {
  dataProp,
  filtersProp,
  pageProp,
  scopeIdProp,
  scopeProp,
} from "./schema.js";

export interface RouterTool {
  name: string;
  description: string;
  annotations: Record<string, unknown>;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
  handler: ToolHandler;
}

export interface RouterCategory {
  name: string;
  description: string;
  tools: RouterTool[];
}

const readAnnotations = { readOnlyHint: true };
const writeAnnotations = { readOnlyHint: false, openWorldHint: true };

/** Merge `name` (or another required field) with the optional `data` object. */
function bodyWith(
  args: Record<string, unknown>,
  base: Record<string, unknown>
): Record<string, unknown> {
  return { ...(optionalObject(args, "data") ?? {}), ...base };
}

/** Best-effort entity label for delete confirmations (read-only). */
async function labelFor(
  fetch: () => Promise<{ name?: string } | undefined>,
  fallback: string
): Promise<string> {
  try {
    const entity = await fetch();
    if (entity?.name) return `${fallback} ("${entity.name}")`;
  } catch {
    /* confirmation still shows the id */
  }
  return fallback;
}

/** Shared delete flow: confirm (MRTR) → mutate → report. */
async function gatedDelete(
  ctx: HandlerContext,
  message: string,
  run: () => Promise<void>,
  deleted: Record<string, unknown>
) {
  const gate = confirmDelete(ctx.elicitation, message);
  if (gate.kind === "ask") return gate.result;
  if (gate.kind === "refused") return textResult(`Cancelled — nothing was deleted. (${message})`);
  await run();
  return jsonResult({ deleted: true, ...deleted });
}

// ── The catalog ────────────────────────────────────────────────────────────

export const ROUTER_CATEGORIES: RouterCategory[] = [
  {
    name: "resellers",
    description: "Reseller (MSP) account CRUD under a provider.",
    tools: [
      {
        name: "list",
        description: "List all resellers belonging to a provider.",
        annotations: readAnnotations,
        inputSchema: {
          type: "object",
          properties: {
            provider_id: { type: "number", description: "Provider id." },
            page: pageProp,
            filters: filtersProp,
          },
          required: ["provider_id"],
        },
        handler: async (ctx, args) =>
          jsonResult(
            await ctx.client.resellers.list(requireNumber(args, "provider_id"), listParams(args))
          ),
      },
      {
        name: "get",
        description: "Get a reseller by id (defaults to the bound reseller).",
        annotations: readAnnotations,
        inputSchema: {
          type: "object",
          properties: {
            reseller_id: {
              type: "number",
              description: "Reseller id. Defaults to the reseller bound by the credentials.",
            },
          },
        },
        handler: async (ctx, args) =>
          jsonResult(
            await ctx.client.resellers.get(optionalNumber(args, "reseller_id") ?? ctx.resellerId)
          ),
      },
      {
        name: "create",
        description: "Create a reseller under a provider.",
        annotations: writeAnnotations,
        inputSchema: {
          type: "object",
          properties: {
            provider_id: { type: "number", description: "Provider id." },
            name: { type: "string", description: "Reseller name." },
            data: dataProp,
          },
          required: ["provider_id", "name"],
        },
        handler: async (ctx, args) =>
          jsonResult(
            await ctx.client.resellers.create(
              requireNumber(args, "provider_id"),
              bodyWith(args, { name: requireString(args, "name") }) as AccountData
            )
          ),
      },
      {
        name: "update",
        description: "Update a reseller (defaults to the bound reseller).",
        annotations: writeAnnotations,
        inputSchema: {
          type: "object",
          properties: {
            reseller_id: {
              type: "number",
              description: "Reseller id. Defaults to the reseller bound by the credentials.",
            },
            data: { ...dataProp, description: "Fields to update (e.g. name, email)." },
          },
          required: ["data"],
        },
        handler: async (ctx, args) =>
          jsonResult(
            await ctx.client.resellers.update(
              optionalNumber(args, "reseller_id") ?? ctx.resellerId,
              requireObject(args, "data") as AccountData
            )
          ),
      },
      {
        name: "delete",
        description:
          "⚠ DESTRUCTIVE — IRREVERSIBLE. Permanently deletes a reseller and everything " +
          "under it. This action cannot be undone. Requires an explicit reseller_id (never " +
          "defaults to the bound reseller). Confirm with the user before invoking.",
        annotations: {
          title: "Delete reseller (irreversible)",
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: true,
        },
        inputSchema: {
          type: "object",
          properties: {
            reseller_id: { type: "number", description: "Reseller id (explicit, required)." },
          },
          required: ["reseller_id"],
        },
        handler: async (ctx, args) => {
          const resellerId = requireNumber(args, "reseller_id");
          const label = await labelFor(
            () => ctx.client.resellers.get(resellerId),
            `reseller ${resellerId}`
          );
          return gatedDelete(
            ctx,
            `Permanently delete ${label} and every customer, domain, and user under it? This cannot be undone.`,
            () => ctx.client.resellers.delete(resellerId),
            { reseller_id: resellerId }
          );
        },
      },
    ],
  },
  {
    name: "customers",
    description:
      "Customer account update/delete (list/get/create are promoted first-class tools).",
    tools: [
      {
        name: "update",
        description: "Update a customer account.",
        annotations: writeAnnotations,
        inputSchema: {
          type: "object",
          properties: {
            customer_id: { type: "number", description: "Customer id." },
            data: { ...dataProp, description: "Fields to update (e.g. name, email)." },
          },
          required: ["customer_id", "data"],
        },
        handler: async (ctx, args) =>
          jsonResult(
            await ctx.client.customers.update(
              requireNumber(args, "customer_id"),
              requireObject(args, "data") as AccountData
            )
          ),
      },
      {
        name: "delete",
        description:
          "⚠ DESTRUCTIVE — IRREVERSIBLE. Permanently deletes a customer account and " +
          "everything under it (domains, user groups, users). This action cannot be " +
          "undone. Confirm with the user before invoking.",
        annotations: {
          title: "Delete customer (irreversible)",
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: true,
        },
        inputSchema: {
          type: "object",
          properties: {
            customer_id: { type: "number", description: "Customer id." },
          },
          required: ["customer_id"],
        },
        handler: async (ctx, args) => {
          const customerId = requireNumber(args, "customer_id");
          const label = await labelFor(
            () => ctx.client.customers.get(customerId),
            `customer ${customerId}`
          );
          return gatedDelete(
            ctx,
            `Permanently delete ${label} and every domain, user group, and user under it? This cannot be undone.`,
            () => ctx.client.customers.delete(customerId),
            { customer_id: customerId }
          );
        },
      },
    ],
  },
  {
    name: "domains",
    description:
      "Domain update/delete/move and domain aliases (list/get/create are promoted).",
    tools: [
      {
        name: "update",
        description: "Update a domain (e.g. name, address_discovery_enabled).",
        annotations: writeAnnotations,
        inputSchema: {
          type: "object",
          properties: {
            domain_id: { type: "number", description: "Domain id." },
            data: { ...dataProp, description: "Fields to update." },
          },
          required: ["domain_id", "data"],
        },
        handler: async (ctx, args) =>
          jsonResult(
            await ctx.client.domains.update(
              requireNumber(args, "domain_id"),
              requireObject(args, "data")
            )
          ),
      },
      {
        name: "delete",
        description:
          "⚠ DESTRUCTIVE — IRREVERSIBLE. Permanently deletes a domain and everything " +
          "under it (user groups, users, mail flow). This action cannot be undone. " +
          "Confirm with the user before invoking.",
        annotations: {
          title: "Delete domain (irreversible)",
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: true,
        },
        inputSchema: {
          type: "object",
          properties: {
            domain_id: { type: "number", description: "Domain id." },
          },
          required: ["domain_id"],
        },
        handler: async (ctx, args) => {
          const domainId = requireNumber(args, "domain_id");
          const label = await labelFor(
            () => ctx.client.domains.get(domainId),
            `domain ${domainId}`
          );
          return gatedDelete(
            ctx,
            `Permanently delete ${label} and every user group and user under it? Mail processing for the domain stops. This cannot be undone.`,
            () => ctx.client.domains.delete(domainId),
            { domain_id: domainId }
          );
        },
      },
      {
        name: "move",
        description: "Move a domain to another customer.",
        annotations: writeAnnotations,
        inputSchema: {
          type: "object",
          properties: {
            domain_id: { type: "number", description: "Domain id." },
            customer_id: { type: "number", description: "Destination customer id." },
          },
          required: ["domain_id", "customer_id"],
        },
        handler: async (ctx, args) =>
          jsonResult(
            await ctx.client.domains.move(
              requireNumber(args, "domain_id"),
              requireNumber(args, "customer_id")
            )
          ),
      },
      {
        name: "aliases_list",
        description: "List a domain's aliases.",
        annotations: readAnnotations,
        inputSchema: {
          type: "object",
          properties: {
            domain_id: { type: "number", description: "Domain id." },
            page: pageProp,
          },
          required: ["domain_id"],
        },
        handler: async (ctx, args) =>
          jsonResult(
            await ctx.client.domains.listAliases(requireNumber(args, "domain_id"), listParams(args))
          ),
      },
      {
        name: "aliases_create",
        description: "Create an alias for a domain.",
        annotations: writeAnnotations,
        inputSchema: {
          type: "object",
          properties: {
            domain_id: { type: "number", description: "Domain id." },
            name: { type: "string", description: 'Alias domain name (e.g. "alias.example.com").' },
          },
          required: ["domain_id", "name"],
        },
        handler: async (ctx, args) =>
          jsonResult(
            await ctx.client.domains.createAlias(
              requireNumber(args, "domain_id"),
              requireString(args, "name")
            )
          ),
      },
    ],
  },
  {
    name: "user_groups",
    description: "User group CRUD and service assignment (list is promoted).",
    tools: [
      {
        name: "get",
        description: "Get a user group by id.",
        annotations: readAnnotations,
        inputSchema: {
          type: "object",
          properties: {
            user_group_id: { type: "number", description: "User group id." },
          },
          required: ["user_group_id"],
        },
        handler: async (ctx, args) =>
          jsonResult(await ctx.client.userGroups.get(requireNumber(args, "user_group_id"))),
      },
      {
        name: "create",
        description: "Create a user group within a domain.",
        annotations: writeAnnotations,
        inputSchema: {
          type: "object",
          properties: {
            domain_id: { type: "number", description: "Domain id." },
            name: { type: "string", description: "User group name." },
            data: dataProp,
          },
          required: ["domain_id", "name"],
        },
        handler: async (ctx, args) =>
          jsonResult(
            await ctx.client.userGroups.create(
              requireNumber(args, "domain_id"),
              bodyWith(args, { name: requireString(args, "name") }) as { name: string }
            )
          ),
      },
      {
        name: "update",
        description: "Update a user group.",
        annotations: writeAnnotations,
        inputSchema: {
          type: "object",
          properties: {
            user_group_id: { type: "number", description: "User group id." },
            data: { ...dataProp, description: "Fields to update (e.g. name)." },
          },
          required: ["user_group_id", "data"],
        },
        handler: async (ctx, args) =>
          jsonResult(
            await ctx.client.userGroups.update(
              requireNumber(args, "user_group_id"),
              requireObject(args, "data")
            )
          ),
      },
      {
        name: "delete",
        description:
          "⚠ DESTRUCTIVE — IRREVERSIBLE. Permanently deletes a user group and its users. " +
          "This action cannot be undone. Confirm with the user before invoking.",
        annotations: {
          title: "Delete user group (irreversible)",
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: true,
        },
        inputSchema: {
          type: "object",
          properties: {
            user_group_id: { type: "number", description: "User group id." },
          },
          required: ["user_group_id"],
        },
        handler: async (ctx, args) => {
          const userGroupId = requireNumber(args, "user_group_id");
          const label = await labelFor(
            () => ctx.client.userGroups.get(userGroupId),
            `user group ${userGroupId}`
          );
          return gatedDelete(
            ctx,
            `Permanently delete ${label} and every user in it? This cannot be undone.`,
            () => ctx.client.userGroups.delete(userGroupId),
            { user_group_id: userGroupId }
          );
        },
      },
      {
        name: "services_get",
        description: "Get the service assignment (hosting type + addons) on a user group.",
        annotations: readAnnotations,
        inputSchema: {
          type: "object",
          properties: {
            user_group_id: { type: "number", description: "User group id." },
          },
          required: ["user_group_id"],
        },
        handler: async (ctx, args) =>
          jsonResult(await ctx.client.userGroups.getServices(requireNumber(args, "user_group_id"))),
      },
      {
        name: "services_update",
        description:
          "⚠ HIGH-IMPACT. Updates the service assignment (hosting type + addons) on a user " +
          "group — changes billing and mail handling for every user in the group. Confirm " +
          "with the user before invoking.",
        annotations: {
          title: "Update user group services (high-impact)",
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
        inputSchema: {
          type: "object",
          properties: {
            user_group_id: { type: "number", description: "User group id." },
            data: {
              ...dataProp,
              description:
                'Service update body, e.g. {"service_types": {"hosting": "CloudFilter", "addons": ["Bracket"]}}.',
            },
          },
          required: ["user_group_id", "data"],
        },
        handler: async (ctx, args) =>
          jsonResult(
            await ctx.client.userGroups.updateServices(
              requireNumber(args, "user_group_id"),
              requireObject(args, "data") as UserGroupServicesUpdateData
            )
          ),
      },
    ],
  },
  {
    name: "users",
    description:
      "Mail user create/update/delete, password resets, and user aliases " +
      "(list/get/find_by_address are promoted).",
    tools: [
      {
        name: "create",
        description: "Create a mail user in a user group.",
        annotations: writeAnnotations,
        inputSchema: {
          type: "object",
          properties: {
            user_group_id: { type: "number", description: "User group id." },
            name: {
              type: "string",
              description: 'Primary email address local part or full address (e.g. "bob@example.com").',
            },
            data: {
              ...dataProp,
              description:
                "Additional fields (first_name, last_name, user_type_id, aliases, ...).",
            },
          },
          required: ["user_group_id", "name"],
        },
        handler: async (ctx, args) =>
          jsonResult(
            await ctx.client.users.create(
              requireNumber(args, "user_group_id"),
              bodyWith(args, { name: requireString(args, "name") }) as UserCreateData
            )
          ),
      },
      {
        name: "create_many",
        description: "Create several mail users in a user group in one call.",
        annotations: writeAnnotations,
        inputSchema: {
          type: "object",
          properties: {
            user_group_id: { type: "number", description: "User group id." },
            users: {
              type: "array",
              items: { type: "object", additionalProperties: true },
              description: 'User bodies, each at least {"name": "address@example.com"}.',
            },
          },
          required: ["user_group_id", "users"],
        },
        handler: async (ctx, args) =>
          jsonResult(
            await ctx.client.users.createMany(
              requireNumber(args, "user_group_id"),
              requireArray(args, "users") as UserCreateData[]
            )
          ),
      },
      {
        name: "update",
        description: "Update a mail user (first_name, last_name, phone, user_type_id, ...).",
        annotations: writeAnnotations,
        inputSchema: {
          type: "object",
          properties: {
            user_id: { type: "number", description: "User id." },
            data: { ...dataProp, description: "Fields to update." },
          },
          required: ["user_id", "data"],
        },
        handler: async (ctx, args) =>
          jsonResult(
            await ctx.client.users.update(
              requireNumber(args, "user_id"),
              requireObject(args, "data") as UserUpdateData
            )
          ),
      },
      {
        name: "delete",
        description:
          "⚠ DESTRUCTIVE — IRREVERSIBLE. Permanently deletes a mail user and their " +
          "aliases. This action cannot be undone. Confirm with the user before invoking.",
        annotations: {
          title: "Delete user (irreversible)",
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: true,
        },
        inputSchema: {
          type: "object",
          properties: {
            user_id: { type: "number", description: "User id." },
          },
          required: ["user_id"],
        },
        handler: async (ctx, args) => {
          const userId = requireNumber(args, "user_id");
          const label = await labelFor(() => ctx.client.users.get(userId), `user ${userId}`);
          return gatedDelete(
            ctx,
            `Permanently delete ${label} and their aliases? Mail for their addresses stops being processed. This cannot be undone.`,
            () => ctx.client.users.delete(userId),
            { user_id: userId }
          );
        },
      },
      {
        name: "reset_password",
        description:
          "⚠ HIGH-IMPACT. Resets a mail user's password — the old password stops working " +
          "immediately. Confirm with the user before invoking.",
        annotations: {
          title: "Reset user password (high-impact)",
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: true,
          openWorldHint: true,
        },
        inputSchema: {
          type: "object",
          properties: {
            user_id: { type: "number", description: "User id." },
            password: { type: "string", description: "The new password." },
          },
          required: ["user_id", "password"],
        },
        handler: async (ctx, args) =>
          jsonResult(
            await ctx.client.users.resetPassword(
              requireNumber(args, "user_id"),
              requireString(args, "password")
            )
          ),
      },
      {
        name: "aliases_list",
        description: "List a user's aliases.",
        annotations: readAnnotations,
        inputSchema: {
          type: "object",
          properties: {
            user_id: { type: "number", description: "User id." },
            page: pageProp,
          },
          required: ["user_id"],
        },
        handler: async (ctx, args) =>
          jsonResult(
            await ctx.client.users.listAliases(requireNumber(args, "user_id"), listParams(args))
          ),
      },
      {
        name: "aliases_create",
        description: "Create an alias address for a user.",
        annotations: writeAnnotations,
        inputSchema: {
          type: "object",
          properties: {
            user_id: { type: "number", description: "User id." },
            name: { type: "string", description: 'Alias address (e.g. "sales@example.com").' },
          },
          required: ["user_id", "name"],
        },
        handler: async (ctx, args) =>
          jsonResult(
            await ctx.client.users.createAlias(
              requireNumber(args, "user_id"),
              requireString(args, "name")
            )
          ),
      },
    ],
  },
  {
    name: "managers",
    description: "Managers (console logins) and their notification destinations.",
    tools: [
      {
        name: "list",
        description:
          "List managers on a reseller or customer (scope defaults to the bound reseller).",
        annotations: readAnnotations,
        inputSchema: {
          type: "object",
          properties: {
            scope: scopeProp(["reseller", "customer"]),
            scope_id: scopeIdProp,
            page: pageProp,
            filters: filtersProp,
          },
          required: ["scope"],
        },
        handler: async (ctx, args) => {
          const { scope, scopeId } = resolveScope(ctx, args, ["reseller", "customer"] as const);
          return jsonResult(await ctx.client.managers.listFor(scope, scopeId, listParams(args)));
        },
      },
      {
        name: "get",
        description: "Get a manager by id.",
        annotations: readAnnotations,
        inputSchema: {
          type: "object",
          properties: {
            manager_id: { type: "number", description: "Manager id." },
          },
          required: ["manager_id"],
        },
        handler: async (ctx, args) =>
          jsonResult(await ctx.client.managers.get(requireNumber(args, "manager_id"))),
      },
      {
        name: "create",
        description: "Create a manager (console login) on a reseller or customer.",
        annotations: writeAnnotations,
        inputSchema: {
          type: "object",
          properties: {
            scope: scopeProp(["reseller", "customer"]),
            scope_id: scopeIdProp,
            data: {
              ...dataProp,
              description:
                "Manager body: first_name, last_name, email, username, password (all required by the API).",
            },
          },
          required: ["scope", "data"],
        },
        handler: async (ctx, args) => {
          const { scope, scopeId } = resolveScope(ctx, args, ["reseller", "customer"] as const);
          return jsonResult(
            await ctx.client.managers.createFor(
              scope,
              scopeId,
              requireObject(args, "data") as ManagerCreateData
            )
          );
        },
      },
      {
        name: "delete",
        description:
          "⚠ DESTRUCTIVE — IRREVERSIBLE. Permanently deletes a manager (console login). " +
          "This action cannot be undone. Confirm with the user before invoking.",
        annotations: {
          title: "Delete manager (irreversible)",
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: true,
        },
        inputSchema: {
          type: "object",
          properties: {
            manager_id: { type: "number", description: "Manager id." },
          },
          required: ["manager_id"],
        },
        handler: async (ctx, args) => {
          const managerId = requireNumber(args, "manager_id");
          const label = await labelFor(
            () => ctx.client.managers.get(managerId),
            `manager ${managerId}`
          );
          return gatedDelete(
            ctx,
            `Permanently delete ${label}? Their console access is revoked. This cannot be undone.`,
            () => ctx.client.managers.delete(managerId),
            { manager_id: managerId }
          );
        },
      },
      {
        name: "notification_destinations_list",
        description: "List a manager's notification destinations.",
        annotations: readAnnotations,
        inputSchema: {
          type: "object",
          properties: {
            manager_id: { type: "number", description: "Manager id." },
            page: pageProp,
          },
          required: ["manager_id"],
        },
        handler: async (ctx, args) =>
          jsonResult(
            await ctx.client.managers.listNotificationDestinations(
              requireNumber(args, "manager_id"),
              listParams(args)
            )
          ),
      },
      {
        name: "notification_destinations_create",
        description: "Add a notification destination to a manager.",
        annotations: writeAnnotations,
        inputSchema: {
          type: "object",
          properties: {
            manager_id: { type: "number", description: "Manager id." },
            data: {
              ...dataProp,
              description:
                'Destination body: {"value": "alerts@msp.com", "destination_type_id": 1, "level_id": 1} (1 = Email / Normal).',
            },
          },
          required: ["manager_id", "data"],
        },
        handler: async (ctx, args) =>
          jsonResult(
            await ctx.client.managers.createNotificationDestination(
              requireNumber(args, "manager_id"),
              requireObject(args, "data") as NotificationDestinationCreateData
            )
          ),
      },
    ],
  },
  {
    name: "configuration",
    description: "Entity configuration updates (configuration_get is promoted).",
    tools: [
      {
        name: "update",
        description:
          "⚠ HIGH-IMPACT. Partially updates the configuration document for a reseller, " +
          "customer, domain, or user group — send only the sections to change. Affects " +
          "mail handling for everything under that scope. Confirm with the user before " +
          "invoking.",
        annotations: {
          title: "Update configuration (high-impact)",
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
        inputSchema: {
          type: "object",
          properties: {
            scope: scopeProp(["reseller", "customer", "domain", "user_group"]),
            scope_id: scopeIdProp,
            data: {
              ...dataProp,
              description:
                'Partial configuration document, e.g. {"region": {"time_zone": "Eastern Time (US & Canada)"}}.',
            },
          },
          required: ["scope", "data"],
        },
        handler: async (ctx, args) => {
          const { scope, scopeId } = resolveScope(ctx, args, [
            "reseller",
            "customer",
            "domain",
            "user_group",
          ] as const);
          return jsonResult(
            await ctx.client.configuration.updateFor(
              scope,
              scopeId,
              requireObject(args, "data") as EntityConfigurationUpdate
            )
          );
        },
      },
    ],
  },
  {
    name: "statements",
    description: "Billing statements on resellers and customers.",
    tools: [
      {
        name: "list",
        description:
          "List billing statements on a reseller or customer (scope defaults to the bound reseller).",
        annotations: readAnnotations,
        inputSchema: {
          type: "object",
          properties: {
            scope: scopeProp(["reseller", "customer"]),
            scope_id: scopeIdProp,
            page: pageProp,
            filters: filtersProp,
          },
          required: ["scope"],
        },
        handler: async (ctx, args) => {
          const { scope, scopeId } = resolveScope(ctx, args, ["reseller", "customer"] as const);
          return jsonResult(await ctx.client.statements.listFor(scope, scopeId, listParams(args)));
        },
      },
    ],
  },
  {
    name: "email_routing",
    description:
      "Email delivery destinations and allowed sending sources on domains and user groups.",
    tools: [
      {
        name: "destinations_list",
        description: "List email delivery destinations on a domain or user group.",
        annotations: readAnnotations,
        inputSchema: {
          type: "object",
          properties: {
            scope: scopeProp(["domain", "user_group"]),
            scope_id: { type: "number", description: "Domain or user group id." },
            page: pageProp,
          },
          required: ["scope", "scope_id"],
        },
        handler: async (ctx, args) => {
          const { scope, scopeId } = resolveScope(ctx, args, ["domain", "user_group"] as const);
          return jsonResult(
            await ctx.client.emailRouting.listDestinations(scope, scopeId, listParams(args))
          );
        },
      },
      {
        name: "destinations_create",
        description: "Add an email delivery destination (MX-style host) to a domain or user group.",
        annotations: writeAnnotations,
        inputSchema: {
          type: "object",
          properties: {
            scope: scopeProp(["domain", "user_group"]),
            scope_id: { type: "number", description: "Domain or user group id." },
            address: { type: "string", description: 'Destination host (e.g. "mail.example.com").' },
            data: dataProp,
          },
          required: ["scope", "scope_id", "address"],
        },
        handler: async (ctx, args) => {
          const { scope, scopeId } = resolveScope(ctx, args, ["domain", "user_group"] as const);
          return jsonResult(
            await ctx.client.emailRouting.createDestination(
              scope,
              scopeId,
              bodyWith(args, { address: requireString(args, "address") }) as { address: string }
            )
          );
        },
      },
      {
        name: "sources_list",
        description: "List allowed sending sources on a domain or user group.",
        annotations: readAnnotations,
        inputSchema: {
          type: "object",
          properties: {
            scope: scopeProp(["domain", "user_group"]),
            scope_id: { type: "number", description: "Domain or user group id." },
            page: pageProp,
          },
          required: ["scope", "scope_id"],
        },
        handler: async (ctx, args) => {
          const { scope, scopeId } = resolveScope(ctx, args, ["domain", "user_group"] as const);
          return jsonResult(
            await ctx.client.emailRouting.listSources(scope, scopeId, listParams(args))
          );
        },
      },
      {
        name: "sources_create",
        description: "Add an allowed sending source (IP/host) to a domain or user group.",
        annotations: writeAnnotations,
        inputSchema: {
          type: "object",
          properties: {
            scope: scopeProp(["domain", "user_group"]),
            scope_id: { type: "number", description: "Domain or user group id." },
            address: { type: "string", description: 'Source IP or host (e.g. "203.0.113.10").' },
            data: dataProp,
          },
          required: ["scope", "scope_id", "address"],
        },
        handler: async (ctx, args) => {
          const { scope, scopeId } = resolveScope(ctx, args, ["domain", "user_group"] as const);
          return jsonResult(
            await ctx.client.emailRouting.createSource(
              scope,
              scopeId,
              bodyWith(args, { address: requireString(args, "address") }) as { address: string }
            )
          );
        },
      },
    ],
  },
  {
    name: "user_syncs",
    description: "Directory user syncs, the per-domain sync schedule, and sync filters.",
    tools: [
      {
        name: "list",
        description: "List user syncs on a domain.",
        annotations: readAnnotations,
        inputSchema: {
          type: "object",
          properties: {
            domain_id: { type: "number", description: "Domain id." },
            page: pageProp,
          },
          required: ["domain_id"],
        },
        handler: async (ctx, args) =>
          jsonResult(
            await ctx.client.userSyncs.list(requireNumber(args, "domain_id"), listParams(args))
          ),
      },
      {
        name: "get",
        description: "Get a user sync by id.",
        annotations: readAnnotations,
        inputSchema: {
          type: "object",
          properties: {
            user_sync_id: { type: "number", description: "User sync id." },
          },
          required: ["user_sync_id"],
        },
        handler: async (ctx, args) =>
          jsonResult(await ctx.client.userSyncs.get(requireNumber(args, "user_sync_id"))),
      },
      {
        name: "create",
        description: "Create a user sync on a domain.",
        annotations: writeAnnotations,
        inputSchema: {
          type: "object",
          properties: {
            domain_id: { type: "number", description: "Domain id." },
            data: {
              ...dataProp,
              description:
                "Sync body: destination_user_group_id, source_type, enabled, source " +
                "({host, port, username, password, search_base, use_ssl}).",
            },
          },
          required: ["domain_id", "data"],
        },
        handler: async (ctx, args) =>
          jsonResult(
            await ctx.client.userSyncs.create(
              requireNumber(args, "domain_id"),
              requireObject(args, "data") as UserSyncData
            )
          ),
      },
      {
        name: "update",
        description: "Update a user sync.",
        annotations: writeAnnotations,
        inputSchema: {
          type: "object",
          properties: {
            user_sync_id: { type: "number", description: "User sync id." },
            data: { ...dataProp, description: "Fields to update." },
          },
          required: ["user_sync_id", "data"],
        },
        handler: async (ctx, args) =>
          jsonResult(
            await ctx.client.userSyncs.update(
              requireNumber(args, "user_sync_id"),
              requireObject(args, "data") as UserSyncData
            )
          ),
      },
      {
        name: "delete",
        description:
          "⚠ DESTRUCTIVE — IRREVERSIBLE. Permanently deletes a user sync. This action " +
          "cannot be undone. Confirm with the user before invoking.",
        annotations: {
          title: "Delete user sync (irreversible)",
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: true,
        },
        inputSchema: {
          type: "object",
          properties: {
            user_sync_id: { type: "number", description: "User sync id." },
          },
          required: ["user_sync_id"],
        },
        handler: async (ctx, args) => {
          const userSyncId = requireNumber(args, "user_sync_id");
          return gatedDelete(
            ctx,
            `Permanently delete user sync ${userSyncId}? Directory synchronization through it stops. This cannot be undone.`,
            () => ctx.client.userSyncs.delete(userSyncId),
            { user_sync_id: userSyncId }
          );
        },
      },
      {
        name: "schedule_get",
        description: "Get the user sync schedule on a domain.",
        annotations: readAnnotations,
        inputSchema: {
          type: "object",
          properties: {
            domain_id: { type: "number", description: "Domain id." },
          },
          required: ["domain_id"],
        },
        handler: async (ctx, args) =>
          jsonResult(await ctx.client.userSyncs.getSchedule(requireNumber(args, "domain_id"))),
      },
      {
        name: "schedule_update",
        description: "Update the user sync schedule on a domain (interval in minutes, enabled).",
        annotations: writeAnnotations,
        inputSchema: {
          type: "object",
          properties: {
            domain_id: { type: "number", description: "Domain id." },
            data: {
              ...dataProp,
              description: 'Schedule body, e.g. {"interval": 60, "enabled": true}.',
            },
          },
          required: ["domain_id", "data"],
        },
        handler: async (ctx, args) =>
          jsonResult(
            await ctx.client.userSyncs.updateSchedule(
              requireNumber(args, "domain_id"),
              requireObject(args, "data") as UserSyncScheduleUpdateData
            )
          ),
      },
      {
        name: "filters_list",
        description: "List a user sync's filters.",
        annotations: readAnnotations,
        inputSchema: {
          type: "object",
          properties: {
            user_sync_id: { type: "number", description: "User sync id." },
            page: pageProp,
          },
          required: ["user_sync_id"],
        },
        handler: async (ctx, args) =>
          jsonResult(
            await ctx.client.userSyncs.listFilters(
              requireNumber(args, "user_sync_id"),
              listParams(args)
            )
          ),
      },
      {
        name: "filter_get",
        description: "Get a user sync filter by its own id.",
        annotations: readAnnotations,
        inputSchema: {
          type: "object",
          properties: {
            filter_id: { type: "number", description: "Filter id." },
          },
          required: ["filter_id"],
        },
        handler: async (ctx, args) =>
          jsonResult(await ctx.client.userSyncs.getFilter(requireNumber(args, "filter_id"))),
      },
      {
        name: "filter_create",
        description: "Create a filter on a user sync.",
        annotations: writeAnnotations,
        inputSchema: {
          type: "object",
          properties: {
            user_sync_id: { type: "number", description: "User sync id." },
            data: {
              ...dataProp,
              description:
                'Filter body: {"field": "...", "value": "...", "filter_group": "all|any", "comparison_type_id": 1}.',
            },
          },
          required: ["user_sync_id", "data"],
        },
        handler: async (ctx, args) =>
          jsonResult(
            await ctx.client.userSyncs.createFilter(
              requireNumber(args, "user_sync_id"),
              requireObject(args, "data") as UserSyncFilterCreateData
            )
          ),
      },
      {
        name: "filter_delete",
        description:
          "⚠ DESTRUCTIVE — IRREVERSIBLE. Permanently deletes a user sync filter. This " +
          "action cannot be undone. Confirm with the user before invoking.",
        annotations: {
          title: "Delete user sync filter (irreversible)",
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: true,
        },
        inputSchema: {
          type: "object",
          properties: {
            filter_id: { type: "number", description: "Filter id." },
          },
          required: ["filter_id"],
        },
        handler: async (ctx, args) => {
          const filterId = requireNumber(args, "filter_id");
          return gatedDelete(
            ctx,
            `Permanently delete user sync filter ${filterId}? This cannot be undone.`,
            () => ctx.client.userSyncs.deleteFilter(filterId),
            { filter_id: filterId }
          );
        },
      },
    ],
  },
  {
    name: "notifications",
    description:
      "Notification destinations on users (manager destinations live in the managers " +
      "category; deletes share one id space).",
    tools: [
      {
        name: "user_destinations_list",
        description: "List a user's notification destinations.",
        annotations: readAnnotations,
        inputSchema: {
          type: "object",
          properties: {
            user_id: { type: "number", description: "User id." },
            page: pageProp,
          },
          required: ["user_id"],
        },
        handler: async (ctx, args) =>
          jsonResult(
            await ctx.client.notificationDestinations.listForUser(
              requireNumber(args, "user_id"),
              listParams(args)
            )
          ),
      },
      {
        name: "user_destinations_create",
        description: "Add a notification destination to a user.",
        annotations: writeAnnotations,
        inputSchema: {
          type: "object",
          properties: {
            user_id: { type: "number", description: "User id." },
            data: {
              ...dataProp,
              description:
                'Destination body: {"value": "bob@example.com", "destination_type_id": 1, "level_id": 1} (1 = Email / Normal).',
            },
          },
          required: ["user_id", "data"],
        },
        handler: async (ctx, args) =>
          jsonResult(
            await ctx.client.notificationDestinations.createForUser(
              requireNumber(args, "user_id"),
              requireObject(args, "data") as NotificationDestinationCreateData
            )
          ),
      },
      {
        name: "destinations_delete",
        description:
          "⚠ DESTRUCTIVE — IRREVERSIBLE. Permanently deletes a notification destination " +
          "by id (user- or manager-owned). This action cannot be undone. Confirm with the " +
          "user before invoking.",
        annotations: {
          title: "Delete notification destination (irreversible)",
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: true,
        },
        inputSchema: {
          type: "object",
          properties: {
            destination_id: { type: "number", description: "Notification destination id." },
          },
          required: ["destination_id"],
        },
        handler: async (ctx, args) => {
          const destinationId = requireNumber(args, "destination_id");
          return gatedDelete(
            ctx,
            `Permanently delete notification destination ${destinationId}? This cannot be undone.`,
            () => ctx.client.notificationDestinations.delete(destinationId),
            { destination_id: destinationId }
          );
        },
      },
    ],
  },
  {
    name: "results",
    description: "Filtering result-code documentation lookup.",
    tools: [
      {
        name: "find_by_code",
        description:
          "Explain a filtering result code (codes appear in log entries' results_data).",
        annotations: readAnnotations,
        inputSchema: {
          type: "object",
          properties: {
            code: { type: "string", description: 'Result code (e.g. "no_rdns").' },
            mode: { type: "string", description: 'Direction: "inbound" or "outbound".' },
          },
          required: ["code", "mode"],
        },
        handler: async (ctx, args) =>
          jsonResult(
            await ctx.client.results.findByCode({
              code: requireString(args, "code"),
              mode: requireString(args, "mode"),
            })
          ),
      },
    ],
  },
];

export const CATEGORY_NAMES: readonly string[] = ROUTER_CATEGORIES.map((c) => c.name);

export function findCategory(name: string): RouterCategory | undefined {
  return ROUTER_CATEGORIES.find((c) => c.name === name);
}

export function findRouterTool(category: string, tool: string): RouterTool | undefined {
  return findCategory(category)?.tools.find((t) => t.name === tool);
}
