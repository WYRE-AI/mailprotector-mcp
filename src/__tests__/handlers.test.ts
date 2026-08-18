/**
 * Dispatch tests: promoted tools, router discovery, execute_tool reaching the
 * long tail, scope-default resolution, and vendor-error normalization. The
 * SDK client is a plain stub — handleToolCall takes it as an argument, so no
 * module mocking is needed here.
 */
import { describe, expect, it, vi } from "vitest";
import {
  NotFoundError,
  type MailprotectorClient,
} from "@wyre-technology/node-mailprotector";
import { handleToolCall } from "../handlers/index.js";
import type { ToolResult } from "../handlers/results.js";

const RESELLER_ID = 42;

type Stub = ReturnType<typeof stubClient>;

function stubClient() {
  return {
    resellers: {
      list: vi.fn(),
      get: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    customers: {
      list: vi.fn(),
      get: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    domains: {
      listFor: vi.fn(),
      get: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      move: vi.fn(),
      listAliases: vi.fn(),
      createAlias: vi.fn(),
    },
    userGroups: {
      list: vi.fn(),
      get: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      getServices: vi.fn(),
      updateServices: vi.fn(),
    },
    users: {
      listFor: vi.fn(),
      get: vi.fn(),
      create: vi.fn(),
      createMany: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      findByAddress: vi.fn(),
      resetPassword: vi.fn(),
      listAliases: vi.fn(),
      createAlias: vi.fn(),
    },
    managers: {
      listFor: vi.fn(),
      get: vi.fn(),
      createFor: vi.fn(),
      delete: vi.fn(),
      listNotificationDestinations: vi.fn(),
      createNotificationDestination: vi.fn(),
      deleteNotificationDestination: vi.fn(),
    },
    messages: { listFor: vi.fn(), release: vi.fn(), releaseMany: vi.fn() },
    allowBlockRules: { listFor: vi.fn(), createFor: vi.fn(), delete: vi.fn() },
    configuration: { getFor: vi.fn(), updateFor: vi.fn() },
    logs: { listFor: vi.fn() },
    statements: { listFor: vi.fn() },
    emailRouting: {
      listDestinations: vi.fn(),
      createDestination: vi.fn(),
      listSources: vi.fn(),
      createSource: vi.fn(),
    },
    userSyncs: {
      list: vi.fn(),
      get: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      getSchedule: vi.fn(),
      updateSchedule: vi.fn(),
      listFilters: vi.fn(),
      getFilter: vi.fn(),
      createFilter: vi.fn(),
      deleteFilter: vi.fn(),
    },
    notificationDestinations: { listForUser: vi.fn(), createForUser: vi.fn(), delete: vi.fn() },
    results: { findByCode: vi.fn() },
  };
}

async function call(client: Stub, name: string, args: Record<string, unknown> = {}) {
  const result = (await handleToolCall(
    client as unknown as MailprotectorClient,
    RESELLER_ID,
    name,
    args
  )) as ToolResult;
  return { result, text: result.content?.[0]?.text ?? "" };
}

describe("promoted tool dispatch", () => {
  it("status calls GET /resellers/{boundResellerId}", async () => {
    const client = stubClient();
    client.resellers.get.mockResolvedValue({ id: RESELLER_ID, name: "WYRE" });
    const { result, text } = await call(client, "mailprotector_status");
    expect(client.resellers.get).toHaveBeenCalledWith(RESELLER_ID);
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(text)).toMatchObject({ connected: true, reseller_id: RESELLER_ID });
  });

  it("customers_list defaults to the bound reseller", async () => {
    const client = stubClient();
    client.customers.list.mockResolvedValue([{ id: 1 }]);
    await call(client, "mailprotector_customers_list", { page: 2 });
    expect(client.customers.list).toHaveBeenCalledWith(RESELLER_ID, { page: 2 });
  });

  it("customers_list honors an explicit reseller_id and filters", async () => {
    const client = stubClient();
    client.customers.list.mockResolvedValue([]);
    await call(client, "mailprotector_customers_list", {
      reseller_id: 99,
      filters: { name: "Acme" },
    });
    expect(client.customers.list).toHaveBeenCalledWith(99, { name: "Acme" });
  });

  it("customers_create merges name into the data body", async () => {
    const client = stubClient();
    client.customers.create.mockResolvedValue({ id: 7 });
    await call(client, "mailprotector_customers_create", {
      name: "Acme",
      data: { email: "it@acme.com" },
    });
    expect(client.customers.create).toHaveBeenCalledWith(RESELLER_ID, {
      name: "Acme",
      email: "it@acme.com",
    });
  });

  it("messages_list resolves scope=reseller to the bound id", async () => {
    const client = stubClient();
    client.messages.listFor.mockResolvedValue([]);
    await call(client, "mailprotector_messages_list", { scope: "reseller" });
    expect(client.messages.listFor).toHaveBeenCalledWith("reseller", RESELLER_ID, undefined);
  });

  it("scoped tools require scope_id for non-reseller scopes", async () => {
    const client = stubClient();
    const { result, text } = await call(client, "mailprotector_users_list", {
      scope: "user_group",
    });
    expect(result.isError).toBe(true);
    expect(text).toContain('"scope_id" is required');
    expect(client.users.listFor).not.toHaveBeenCalled();
  });

  it("scoped tools reject scopes outside the tool's allowed set", async () => {
    const client = stubClient();
    const { result, text } = await call(client, "mailprotector_domains_list", {
      scope: "user",
      scope_id: 5,
    });
    expect(result.isError).toBe(true);
    expect(text).toContain('"scope" must be one of');
  });

  it("messages_release_many forwards ids and options", async () => {
    const client = stubClient();
    client.messages.releaseMany.mockResolvedValue({ delivered_messages: [1, 2] });
    await call(client, "mailprotector_messages_release_many", {
      scope: "domain",
      scope_id: 10,
      ids: [1, 2],
      include_original_recipients: true,
    });
    expect(client.messages.releaseMany).toHaveBeenCalledWith("domain", 10, [1, 2], {
      include_original_recipients: true,
    });
  });

  it("allow_block_rules_create validates rule_type", async () => {
    const client = stubClient();
    const { result, text } = await call(client, "mailprotector_allow_block_rules_create", {
      scope: "reseller",
      value: "spam.example.com",
      rule_type: "banish",
    });
    expect(text).toContain('"rule_type" must be "allow" or "block"');
    expect(client.allowBlockRules.createFor).not.toHaveBeenCalled();
    void result;
  });

  it("configuration_get resolves scope and unwraps via the SDK", async () => {
    const client = stubClient();
    client.configuration.getFor.mockResolvedValue({ region: { locale: "en" } });
    const { text } = await call(client, "mailprotector_configuration_get", {
      scope: "domain",
      scope_id: 3,
    });
    expect(client.configuration.getFor).toHaveBeenCalledWith("domain", 3);
    expect(JSON.parse(text)).toEqual({ region: { locale: "en" } });
  });

  it("unknown tools answer isError, not a throw", async () => {
    const client = stubClient();
    const { result, text } = await call(client, "mailprotector_nope");
    expect(result.isError).toBe(true);
    expect(text).toContain("Unknown tool");
  });

  it("vendor errors are normalized into isError text", async () => {
    const client = stubClient();
    client.customers.get.mockRejectedValue(
      new NotFoundError("Resource not found", { error: "not found" })
    );
    const { result, text } = await call(client, "mailprotector_customers_get", {
      customer_id: 12345,
    });
    expect(result.isError).toBe(true);
    expect(text).toContain("Mailprotector error (HTTP 404)");
  });
});

describe("router discovery and execute_tool", () => {
  it("list_categories returns the 12 categories with counts", async () => {
    const client = stubClient();
    const { text } = await call(client, "mailprotector_list_categories");
    const parsed = JSON.parse(text) as { categories: Array<{ name: string; tool_count: number }> };
    expect(parsed.categories).toHaveLength(12);
    expect(parsed.categories[0]).toMatchObject({ name: "resellers", tool_count: 5 });
  });

  it("list_category_tools returns schemas and annotations for a category", async () => {
    const client = stubClient();
    const { text } = await call(client, "mailprotector_list_category_tools", {
      category: "users",
    });
    const parsed = JSON.parse(text) as { tools: Array<{ name: string }> };
    expect(parsed.tools.map((t) => t.name)).toEqual([
      "create",
      "create_many",
      "update",
      "delete",
      "reset_password",
      "aliases_list",
      "aliases_create",
    ]);
  });

  it("list_category_tools rejects unknown categories", async () => {
    const client = stubClient();
    const { result, text } = await call(client, "mailprotector_list_category_tools", {
      category: "spaceships",
    });
    expect(result.isError).toBe(true);
    expect(text).toContain("Unknown category");
  });

  it("execute_tool reaches users.reset_password", async () => {
    const client = stubClient();
    client.users.resetPassword.mockResolvedValue({ id: 5 });
    const { result } = await call(client, "mailprotector_execute_tool", {
      category: "users",
      tool: "reset_password",
      args: { user_id: 5, password: "n3w-p4ss" },
    });
    expect(client.users.resetPassword).toHaveBeenCalledWith(5, "n3w-p4ss");
    expect(result.isError).toBeUndefined();
  });

  it("execute_tool reaches statements.list with the reseller default", async () => {
    const client = stubClient();
    client.statements.listFor.mockResolvedValue([]);
    await call(client, "mailprotector_execute_tool", {
      category: "statements",
      tool: "list",
      args: { scope: "reseller" },
    });
    expect(client.statements.listFor).toHaveBeenCalledWith("reseller", RESELLER_ID, undefined);
  });

  it("execute_tool reaches email_routing.destinations_create", async () => {
    const client = stubClient();
    client.emailRouting.createDestination.mockResolvedValue({ id: 1 });
    await call(client, "mailprotector_execute_tool", {
      category: "email_routing",
      tool: "destinations_create",
      args: { scope: "domain", scope_id: 8, address: "mail.example.com" },
    });
    expect(client.emailRouting.createDestination).toHaveBeenCalledWith("domain", 8, {
      address: "mail.example.com",
    });
  });

  it("execute_tool reaches user_syncs.filter_delete (proceeds when elicitation is unavailable)", async () => {
    const client = stubClient();
    client.userSyncs.deleteFilter.mockResolvedValue(undefined);
    const { text } = await call(client, "mailprotector_execute_tool", {
      category: "user_syncs",
      tool: "filter_delete",
      args: { filter_id: 66 },
    });
    expect(client.userSyncs.deleteFilter).toHaveBeenCalledWith(66);
    expect(JSON.parse(text)).toMatchObject({ deleted: true, filter_id: 66 });
  });

  it("execute_tool reaches resellers.get with the bound default", async () => {
    const client = stubClient();
    client.resellers.get.mockResolvedValue({ id: RESELLER_ID });
    await call(client, "mailprotector_execute_tool", {
      category: "resellers",
      tool: "get",
      args: {},
    });
    expect(client.resellers.get).toHaveBeenCalledWith(RESELLER_ID);
  });

  it("execute_tool rejects unknown categories and tools", async () => {
    const client = stubClient();
    const unknownCategory = await call(client, "mailprotector_execute_tool", {
      category: "spaceships",
      tool: "launch",
    });
    expect(unknownCategory.result.isError).toBe(true);
    expect(unknownCategory.text).toContain("Unknown category");

    const unknownTool = await call(client, "mailprotector_execute_tool", {
      category: "users",
      tool: "launch",
    });
    expect(unknownTool.result.isError).toBe(true);
    expect(unknownTool.text).toContain('Unknown tool "launch"');
  });
});
