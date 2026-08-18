/**
 * The promoted Mailprotector tool surface — 22 first-class tools, router
 * pattern (contract §MCP tool surface). Long-tail operations are reached via
 * `mailprotector_execute_tool` (see router.ts).
 *
 * Deterministic ordering rule: all tools live in this single module-scope
 * `TOOLS` array, in the exact order of the integration contract. `tools/list`
 * returns this array by reference for every request, every era, every
 * caller. Never sorted at runtime, never filtered per-session, never varied
 * by credentials.
 *
 * Hand-written JSON Schema (no zod). Destructive tools follow fleet
 * convention §2.7b: description prefix + MCP annotations, and every
 * destructive description ends with "Confirm with the user before invoking."
 */
import type { Tool } from "@modelcontextprotocol/server";
import { CATEGORY_NAMES } from "./router.js";
import {
  ALL_SCOPES,
  READ_ANNOTATIONS,
  dataProp,
  filtersProp,
  pageProp,
  scopeIdProp,
  scopeProp,
} from "./schema.js";

// ── The 22 promoted tools, contract order ──────────────────────────────────

export const TOOLS: Tool[] = [
  // 1 — router: status
  {
    name: "mailprotector_status",
    description:
      "Verify Mailprotector credentials and report connection info for the bound reseller " +
      "(GET /resellers/{resellerId}).",
    inputSchema: { type: "object", properties: {} },
    annotations: READ_ANNOTATIONS,
  },
  // 2 — router: categories
  {
    name: "mailprotector_list_categories",
    description:
      "List the Mailprotector tool categories reachable through mailprotector_execute_tool " +
      "(resellers, customers, domains, user_groups, users, managers, configuration, " +
      "statements, email_routing, user_syncs, notifications, results).",
    inputSchema: { type: "object", properties: {} },
    annotations: READ_ANNOTATIONS,
  },
  // 3 — router: category tools
  {
    name: "mailprotector_list_category_tools",
    description:
      "List the tools in one Mailprotector category: names, descriptions, input schemas, " +
      "and destructive-action annotations. Use before mailprotector_execute_tool.",
    inputSchema: {
      type: "object",
      properties: {
        category: {
          type: "string",
          enum: [...CATEGORY_NAMES],
          description: "Category name from mailprotector_list_categories.",
        },
      },
      required: ["category"],
    },
    annotations: READ_ANNOTATIONS,
  },
  // 4 — router: execute
  {
    name: "mailprotector_execute_tool",
    description:
      "Execute a routed Mailprotector operation by category + tool name with the arguments " +
      "described by mailprotector_list_category_tools. Some routed tools are destructive " +
      "(marked ⚠ in their descriptions) and are individually confirmation-gated.",
    inputSchema: {
      type: "object",
      properties: {
        category: {
          type: "string",
          enum: [...CATEGORY_NAMES],
          description: "Category name from mailprotector_list_categories.",
        },
        tool: {
          type: "string",
          description: "Tool name within the category, from mailprotector_list_category_tools.",
        },
        args: {
          type: "object",
          additionalProperties: true,
          description: "Arguments for the routed tool (per its input schema).",
        },
      },
      required: ["category", "tool"],
    },
    annotations: { readOnlyHint: false, openWorldHint: true },
  },
  // 5
  {
    name: "mailprotector_customers_list",
    description: "List customer accounts under a reseller (defaults to the bound reseller).",
    inputSchema: {
      type: "object",
      properties: {
        reseller_id: {
          type: "number",
          description: "Reseller id. Defaults to the reseller bound by the credentials.",
        },
        page: pageProp,
        filters: filtersProp,
      },
    },
    annotations: READ_ANNOTATIONS,
  },
  // 6
  {
    name: "mailprotector_customers_get",
    description: "Get a customer account by id.",
    inputSchema: {
      type: "object",
      properties: {
        customer_id: { type: "number", description: "Customer id." },
      },
      required: ["customer_id"],
    },
    annotations: READ_ANNOTATIONS,
  },
  // 7
  {
    name: "mailprotector_customers_create",
    description: "Create a customer account under a reseller (defaults to the bound reseller).",
    inputSchema: {
      type: "object",
      properties: {
        reseller_id: {
          type: "number",
          description: "Reseller id. Defaults to the reseller bound by the credentials.",
        },
        name: { type: "string", description: "Customer name." },
        data: dataProp,
      },
      required: ["name"],
    },
    annotations: { readOnlyHint: false, openWorldHint: true },
  },
  // 8
  {
    name: "mailprotector_domains_list",
    description: "List domains under a reseller or customer.",
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
    annotations: READ_ANNOTATIONS,
  },
  // 9
  {
    name: "mailprotector_domains_get",
    description: "Get a domain by id.",
    inputSchema: {
      type: "object",
      properties: {
        domain_id: { type: "number", description: "Domain id." },
      },
      required: ["domain_id"],
    },
    annotations: READ_ANNOTATIONS,
  },
  // 10
  {
    name: "mailprotector_domains_create",
    description: "Create a domain under a customer.",
    inputSchema: {
      type: "object",
      properties: {
        customer_id: { type: "number", description: "Owning customer id." },
        name: { type: "string", description: 'Domain name (e.g. "example.com").' },
        data: dataProp,
      },
      required: ["customer_id", "name"],
    },
    annotations: { readOnlyHint: false, openWorldHint: true },
  },
  // 11
  {
    name: "mailprotector_users_list",
    description: "List mail users under a reseller, customer, domain, or user group.",
    inputSchema: {
      type: "object",
      properties: {
        scope: scopeProp(["reseller", "customer", "domain", "user_group"]),
        scope_id: scopeIdProp,
        page: pageProp,
        filters: filtersProp,
      },
      required: ["scope"],
    },
    annotations: READ_ANNOTATIONS,
  },
  // 12
  {
    name: "mailprotector_users_get",
    description: "Get a mail user by id.",
    inputSchema: {
      type: "object",
      properties: {
        user_id: { type: "number", description: "User id." },
      },
      required: ["user_id"],
    },
    annotations: READ_ANNOTATIONS,
  },
  // 13
  {
    name: "mailprotector_users_find_by_address",
    description: "Look up a mail user by any of their email addresses.",
    inputSchema: {
      type: "object",
      properties: {
        address: { type: "string", description: "Email address to look up." },
      },
      required: ["address"],
    },
    annotations: READ_ANNOTATIONS,
  },
  // 14
  {
    name: "mailprotector_user_groups_list",
    description: "List user groups (service containers) within a domain.",
    inputSchema: {
      type: "object",
      properties: {
        domain_id: { type: "number", description: "Domain id." },
        page: pageProp,
        filters: filtersProp,
      },
      required: ["domain_id"],
    },
    annotations: READ_ANNOTATIONS,
  },
  // 15
  {
    name: "mailprotector_messages_list",
    description:
      "List quarantined messages at any scope (max 50 per page). Defaults to the bound " +
      'reseller when scope is "reseller".',
    inputSchema: {
      type: "object",
      properties: {
        scope: scopeProp(ALL_SCOPES),
        scope_id: scopeIdProp,
        page: pageProp,
        filters: filtersProp,
      },
      required: ["scope"],
    },
    annotations: READ_ANNOTATIONS,
  },
  // 16 — Tier B
  {
    name: "mailprotector_messages_release",
    description:
      "⚠ HIGH-IMPACT. Releases (delivers) a single quarantined message to its recipients. " +
      "Confirm with the user before invoking.",
    inputSchema: {
      type: "object",
      properties: {
        message_id: { type: "number", description: "Quarantined message id." },
        include_original_recipients: {
          type: "boolean",
          description: "Also deliver to the original recipients.",
        },
        recipients: {
          type: "string",
          description: "Comma-separated additional recipient addresses.",
        },
      },
      required: ["message_id"],
    },
    annotations: {
      title: "Release quarantined message (high-impact)",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  // 17 — Tier B
  {
    name: "mailprotector_messages_release_many",
    description:
      "⚠ HIGH-IMPACT. Releases (delivers) several quarantined messages at a scope in one " +
      "call. Confirm with the user before invoking.",
    inputSchema: {
      type: "object",
      properties: {
        scope: scopeProp(ALL_SCOPES),
        scope_id: scopeIdProp,
        ids: {
          type: "array",
          items: { type: "number" },
          description: "Ids of the quarantined messages to release.",
        },
        include_original_recipients: {
          type: "boolean",
          description: "Also deliver to the original recipients.",
        },
        recipients: {
          type: "string",
          description: "Comma-separated additional recipient addresses.",
        },
      },
      required: ["scope", "ids"],
    },
    annotations: {
      title: "Release quarantined messages (high-impact)",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  // 18
  {
    name: "mailprotector_allow_block_rules_list",
    description: "List allow/block rules at any scope.",
    inputSchema: {
      type: "object",
      properties: {
        scope: scopeProp(ALL_SCOPES),
        scope_id: scopeIdProp,
        page: pageProp,
        filters: filtersProp,
      },
      required: ["scope"],
    },
    annotations: READ_ANNOTATIONS,
  },
  // 19 — Tier B
  {
    name: "mailprotector_allow_block_rules_create",
    description:
      "⚠ HIGH-IMPACT. Creates an allow or block rule at a scope — changes mail filtering " +
      "for every mailbox under that scope. Confirm with the user before invoking.",
    inputSchema: {
      type: "object",
      properties: {
        scope: scopeProp(ALL_SCOPES),
        scope_id: scopeIdProp,
        value: {
          type: "string",
          description: "Address, domain, or IP the rule matches (e.g. \"spam.example.com\").",
        },
        rule_type: {
          type: "string",
          enum: ["allow", "block"],
          description: "Rule type.",
        },
      },
      required: ["scope", "value", "rule_type"],
    },
    annotations: {
      title: "Create allow/block rule (high-impact)",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  // 20 — Tier A
  {
    name: "mailprotector_allow_block_rules_delete",
    description:
      "⚠ DESTRUCTIVE — IRREVERSIBLE. Permanently deletes an allow/block rule by id. This " +
      "action cannot be undone. Confirm with the user before invoking.",
    inputSchema: {
      type: "object",
      properties: {
        rule_id: { type: "number", description: "Allow/block rule id." },
      },
      required: ["rule_id"],
    },
    annotations: {
      title: "Delete allow/block rule (irreversible)",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  // 21
  {
    name: "mailprotector_logs_list",
    description:
      "List message-log entries at any scope. Result codes in results_data can be " +
      "explained via the results category (mailprotector_execute_tool).",
    inputSchema: {
      type: "object",
      properties: {
        scope: scopeProp(ALL_SCOPES),
        scope_id: scopeIdProp,
        page: pageProp,
        filters: filtersProp,
      },
      required: ["scope"],
    },
    annotations: READ_ANNOTATIONS,
  },
  // 22
  {
    name: "mailprotector_configuration_get",
    description:
      "Get the configuration document for a reseller, customer, domain, or user group.",
    inputSchema: {
      type: "object",
      properties: {
        scope: scopeProp(["reseller", "customer", "domain", "user_group"]),
        scope_id: scopeIdProp,
      },
      required: ["scope"],
    },
    annotations: READ_ANNOTATIONS,
  },
];
