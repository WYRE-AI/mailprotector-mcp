/**
 * Static invariants of the tool surface: deterministic order, naming
 * convention, destructive-warning tiers (§2.7b), and full router coverage.
 */
import { describe, expect, it } from "vitest";
import { listToolsResult } from "../mcp-server.js";
import { CATEGORY_NAMES, ROUTER_CATEGORIES, findRouterTool } from "../router.js";
import { TOOLS } from "../tools.js";

/** The contract-ordered promoted surface. */
const EXPECTED_TOOL_NAMES = [
  "mailprotector_status",
  "mailprotector_list_categories",
  "mailprotector_list_category_tools",
  "mailprotector_execute_tool",
  "mailprotector_customers_list",
  "mailprotector_customers_get",
  "mailprotector_customers_create",
  "mailprotector_domains_list",
  "mailprotector_domains_get",
  "mailprotector_domains_create",
  "mailprotector_users_list",
  "mailprotector_users_get",
  "mailprotector_users_find_by_address",
  "mailprotector_user_groups_list",
  "mailprotector_messages_list",
  "mailprotector_messages_release",
  "mailprotector_messages_release_many",
  "mailprotector_allow_block_rules_list",
  "mailprotector_allow_block_rules_create",
  "mailprotector_allow_block_rules_delete",
  "mailprotector_logs_list",
  "mailprotector_configuration_get",
];

const EXPECTED_CATEGORIES = [
  "resellers",
  "customers",
  "domains",
  "user_groups",
  "users",
  "managers",
  "configuration",
  "statements",
  "email_routing",
  "user_syncs",
  "notifications",
  "results",
];

describe("promoted tool surface", () => {
  it("serves exactly the 22 contract tools in contract order", () => {
    expect(TOOLS.map((t) => t.name)).toEqual(EXPECTED_TOOL_NAMES);
  });

  it("tools/list returns the same array by reference every time (deterministic)", () => {
    expect(listToolsResult().tools).toBe(TOOLS);
    expect(listToolsResult().tools).toBe(listToolsResult().tools);
  });

  it("every tool follows the mailprotector_{entity}_{operation} naming convention", () => {
    for (const tool of TOOLS) {
      expect(tool.name).toMatch(/^mailprotector_[a-z_]+$/);
    }
  });

  it("every tool has an object inputSchema and a description", () => {
    for (const tool of TOOLS) {
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.description?.length ?? 0).toBeGreaterThan(10);
    }
  });

  it("Tier A deletes carry the irreversible warning, annotations, and confirm suffix", () => {
    const tool = TOOLS.find((t) => t.name === "mailprotector_allow_block_rules_delete")!;
    expect(tool.description).toMatch(/^⚠ DESTRUCTIVE — IRREVERSIBLE\./);
    expect(tool.description).toMatch(/Confirm with the user before invoking\.$/);
    expect(tool.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
    });
  });

  it("Tier B tools carry the high-impact warning and confirm suffix", () => {
    for (const name of [
      "mailprotector_messages_release",
      "mailprotector_messages_release_many",
      "mailprotector_allow_block_rules_create",
    ]) {
      const tool = TOOLS.find((t) => t.name === name)!;
      expect(tool.description).toMatch(/^⚠ HIGH-IMPACT\./);
      expect(tool.description).toMatch(/Confirm with the user before invoking\.$/);
      expect(tool.annotations).toMatchObject({ readOnlyHint: false, idempotentHint: true });
    }
  });

  it("read-only tools carry no warning prefix and no destructiveHint", () => {
    const readTools = TOOLS.filter((t) => t.annotations?.readOnlyHint === true);
    expect(readTools.length).toBeGreaterThanOrEqual(14);
    for (const tool of readTools) {
      expect(tool.description).not.toContain("⚠");
      expect(tool.annotations?.destructiveHint).toBeUndefined();
    }
  });
});

describe("router catalog", () => {
  it("exposes exactly the contract categories in deterministic order", () => {
    expect([...CATEGORY_NAMES]).toEqual(EXPECTED_CATEGORIES);
  });

  it("covers all 52 long-tail SDK operations", () => {
    const total = ROUTER_CATEGORIES.reduce((sum, c) => sum + c.tools.length, 0);
    expect(total).toBe(52);
  });

  it("router tool names are unique within each category", () => {
    for (const category of ROUTER_CATEGORIES) {
      const names = category.tools.map((t) => t.name);
      expect(new Set(names).size).toBe(names.length);
    }
  });

  it("every routed delete is Tier A: ⚠ prefix, destructiveHint, confirm suffix", () => {
    const deletes = ROUTER_CATEGORIES.flatMap((c) =>
      c.tools.filter((t) => t.name === "delete" || t.name.endsWith("_delete"))
    );
    // resellers, customers, domains, user_groups, users, managers,
    // user_syncs (x2: delete + filter_delete), notifications.
    expect(deletes.length).toBe(9);
    for (const tool of deletes) {
      expect(tool.description).toMatch(/^⚠ DESTRUCTIVE — IRREVERSIBLE\./);
      expect(tool.description).toMatch(/Confirm with the user before invoking\.$/);
      expect(tool.annotations).toMatchObject({ destructiveHint: true, idempotentHint: false });
    }
  });

  it("Tier B routed tools carry the high-impact warning", () => {
    for (const [category, name] of [
      ["users", "reset_password"],
      ["configuration", "update"],
      ["user_groups", "services_update"],
    ] as const) {
      const tool = findRouterTool(category, name)!;
      expect(tool.description).toMatch(/^⚠ HIGH-IMPACT\./);
      expect(tool.description).toMatch(/Confirm with the user before invoking\.$/);
      expect(tool.annotations).toMatchObject({ readOnlyHint: false, idempotentHint: true });
    }
  });

  it("the execute_tool and list_category_tools schemas enumerate the real categories", () => {
    for (const name of ["mailprotector_execute_tool", "mailprotector_list_category_tools"]) {
      const tool = TOOLS.find((t) => t.name === name)!;
      const properties = tool.inputSchema.properties as Record<string, { enum?: string[] }>;
      expect(properties.category.enum).toEqual(EXPECTED_CATEGORIES);
    }
  });
});
