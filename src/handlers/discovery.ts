/**
 * Router discovery tools (§2.6 stateless progressive discovery): categories →
 * category tools → execute. Catalog output is deterministic — it renders the
 * module-scope router arrays verbatim, identical for every caller.
 */
import { findCategory, findRouterTool, ROUTER_CATEGORIES } from "../router.js";
import { errorResult, jsonResult, optionalObject, requireString } from "./results.js";
import type { ToolHandler } from "./types.js";

export const DISCOVERY_HANDLERS: Record<string, ToolHandler> = {
  mailprotector_list_categories: async () =>
    jsonResult({
      categories: ROUTER_CATEGORIES.map((category) => ({
        name: category.name,
        description: category.description,
        tool_count: category.tools.length,
      })),
      usage:
        "Call mailprotector_list_category_tools(category) for tool schemas, then " +
        "mailprotector_execute_tool(category, tool, args).",
    }),

  mailprotector_list_category_tools: async (_ctx, args) => {
    const name = requireString(args, "category");
    const category = findCategory(name);
    if (!category) {
      return errorResult(
        `Unknown category "${name}". Categories: ${ROUTER_CATEGORIES.map((c) => c.name).join(", ")}.`
      );
    }
    return jsonResult({
      category: category.name,
      description: category.description,
      tools: category.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: tool.annotations,
      })),
    });
  },

  mailprotector_execute_tool: async (ctx, args) => {
    const category = requireString(args, "category");
    const toolName = requireString(args, "tool");
    if (!findCategory(category)) {
      return errorResult(
        `Unknown category "${category}". Categories: ${ROUTER_CATEGORIES.map((c) => c.name).join(", ")}.`
      );
    }
    const tool = findRouterTool(category, toolName);
    if (!tool) {
      const available = findCategory(category)?.tools.map((t) => t.name) ?? [];
      return errorResult(
        `Unknown tool "${toolName}" in category "${category}". Tools: ${available.join(", ")}.`
      );
    }
    return tool.handler(ctx, optionalObject(args, "args") ?? {});
  },
};
