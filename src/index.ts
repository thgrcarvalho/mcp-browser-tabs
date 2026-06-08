#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z, ZodError, type ZodTypeAny } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

import { closeChromeTabByIndex } from "./applescript.js";
import { Bridge } from "./bridge/server.js";
import { BridgeRpcError } from "./bridge/registry.js";
import {
  AddTabsToGroupInput,
  GroupTabsInput,
  ListGroupsInput,
  RemoveTabsFromGroupInput,
  TabIdInput,
  UngroupGroupInput,
  UpdateGroupInput,
} from "./bridge/protocol.js";
import { credentialsPath, loadOrCreateCredentials, type BridgeCredentials } from "./token.js";
import { activateTabText, closeTabText, getTabsText } from "./tools/tabs.js";
import {
  addTabsToGroupText,
  groupTabsText,
  listGroupsText,
  removeTabsFromGroupText,
  ungroupGroupText,
  updateGroupText,
} from "./tools/groups.js";

const NoInput = z.object({});

interface ToolDef {
  name: string;
  description: string;
  schema: ZodTypeAny;
  handler: (args: unknown) => Promise<string>;
}

function log(message: string): void {
  // stdout carries the JSON-RPC stream; all diagnostics MUST go to stderr.
  console.error(`[mcp-browser-tabs] ${message}`);
}

function buildTools(bridge: Bridge, creds: BridgeCredentials): ToolDef[] {
  return [
    {
      name: "get_tabs",
      description:
        "List all open Google Chrome tabs. When the companion extension is connected, returns chrome.tabs IDs, each tab's group membership, and a summary of tab groups; otherwise falls back to AppleScript with no group info. The output states its `source`. Tab/group IDs are valid for the current browser session only — re-run this after a Chrome restart. Use the [Tab ID] numbers for all tab operations.",
      schema: NoInput,
      handler: () => getTabsText(bridge),
    },
    {
      name: "close_tab_by_id",
      description:
        "Close a specific Chrome tab by its ID (from get_tabs). Immune to tab reordering. Routes through the extension when connected, AppleScript otherwise.",
      schema: TabIdInput,
      handler: (args) => closeTabText(bridge, (args as z.infer<typeof TabIdInput>).tabId),
    },
    {
      name: "activate_tab_by_id",
      description:
        "Activate (focus) a specific Chrome tab by its ID (from get_tabs), bringing it and its window to the front.",
      schema: TabIdInput,
      handler: (args) => activateTabText(bridge, (args as z.infer<typeof TabIdInput>).tabId),
    },
    {
      name: "group_tabs",
      description:
        "Create a new native Chrome tab group from the given tabs, optionally with a title and color. Requires the companion extension. All tabs MUST be in the same window. Returns the new group ID.",
      schema: GroupTabsInput,
      handler: (args) => groupTabsText(bridge, args as z.infer<typeof GroupTabsInput>),
    },
    {
      name: "add_tabs_to_group",
      description:
        "Add tabs to an existing tab group (by group ID from list_groups/get_tabs). Requires the companion extension. Tabs must be in the group's window.",
      schema: AddTabsToGroupInput,
      handler: (args) => addTabsToGroupText(bridge, args as z.infer<typeof AddTabsToGroupInput>),
    },
    {
      name: "remove_tabs_from_group",
      description:
        "Remove (ungroup) specific tabs from whatever group they are in. A group is automatically dissolved when its last tab is removed. Requires the companion extension.",
      schema: RemoveTabsFromGroupInput,
      handler: (args) =>
        removeTabsFromGroupText(bridge, args as z.infer<typeof RemoveTabsFromGroupInput>),
    },
    {
      name: "ungroup_group",
      description:
        "Dissolve an entire tab group by its group ID (ungroups all of its tabs; the tabs stay open). Requires the companion extension.",
      schema: UngroupGroupInput,
      handler: (args) => ungroupGroupText(bridge, args as z.infer<typeof UngroupGroupInput>),
    },
    {
      name: "update_group",
      description:
        "Update an existing tab group's title, color, and/or collapsed state. Provide at least one of those. Colors: grey, blue, red, yellow, green, pink, purple, cyan, orange. Requires the companion extension.",
      schema: UpdateGroupInput,
      handler: (args) => updateGroupText(bridge, args as z.infer<typeof UpdateGroupInput>),
    },
    {
      name: "list_groups",
      description:
        "List all current Chrome tab groups with their titles, colors, collapsed state, window, and member tab IDs. Requires the companion extension.",
      schema: ListGroupsInput,
      handler: (args) => listGroupsText(bridge, args as z.infer<typeof ListGroupsInput>),
    },
    {
      name: "get_pairing_info",
      description:
        "Show the local pairing token and port to paste into the companion extension's options page (one-time setup). The token is a local secret that authorizes the extension to talk to this server over 127.0.0.1.",
      schema: NoInput,
      handler: async () =>
        `Companion extension pairing info (loopback only):\n\n  Token: ${creds.token}\n  Port:  ${creds.port}\n\nOpen the extension's Options page, paste these, and Save. Bridge connected: ${
          bridge.isConnected() ? "yes ✅" : "not yet"
        }.`,
    },
    {
      name: "close_tab",
      description:
        "⚠️ LEGACY: close a tab by window/tab index (AppleScript only). Fragile — indices shift when tabs change. Prefer close_tab_by_id.",
      schema: z.object({
        windowIndex: z.number().int().positive().describe("Window index (1-based)"),
        tabIndex: z.number().int().positive().describe("Tab index within the window (1-based)"),
      }),
      handler: async (args) => {
        const { windowIndex, tabIndex } = args as { windowIndex: number; tabIndex: number };
        await closeChromeTabByIndex(windowIndex, tabIndex);
        return `⚠️ LEGACY: closed tab at window ${windowIndex}, tab ${tabIndex}. Prefer close_tab_by_id.`;
      },
    },
  ];
}

function formatError(error: unknown): string {
  if (error instanceof ZodError) {
    const details = error.issues
      .map((i) => `${i.path.join(".") || "(input)"}: ${i.message}`)
      .join("; ");
    return `Invalid arguments: ${details}`;
  }
  if (error instanceof BridgeRpcError) {
    return `${error.message} [${error.code}]`;
  }
  return error instanceof Error ? error.message : String(error);
}

const ListToolsSchema = z.object({ method: z.literal("tools/list") });
const CallToolSchema = z.object({
  method: z.literal("tools/call"),
  params: z.object({
    name: z.string(),
    arguments: z.record(z.unknown()).optional(),
  }),
});

const server = new Server(
  { name: "mcp-browser-tabs", version: "1.3.0" },
  { capabilities: { tools: {} } }
);

type RawHandler = (request: any, extra: any) => Promise<unknown>;

/**
 * Register a request handler, bypassing the SDK's generic signature. Recent
 * @modelcontextprotocol/sdk + zod versions make the generic over-instantiate
 * the inferred result type (TS2589). The schema is still used at runtime to
 * route and validate the request; only the compile-time generic is sidestepped.
 */
function register(schema: ZodTypeAny, handler: RawHandler): void {
  (server.setRequestHandler as unknown as (s: ZodTypeAny, h: RawHandler) => void)(schema, handler);
}

function setupHandlers(tools: ToolDef[]): void {
  const byName = new Map(tools.map((t) => [t.name, t]));
  const toJsonSchema = zodToJsonSchema as unknown as (s: ZodTypeAny) => Record<string, unknown>;
  const toolList = tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: toJsonSchema(t.schema),
  }));

  register(ListToolsSchema, async () => ({ tools: toolList }));

  register(CallToolSchema, async (request: { params: { name: string; arguments?: Record<string, unknown> } }) => {
    const { name, arguments: rawArgs } = request.params;
    const tool = byName.get(name);
    if (!tool) {
      return {
        content: [{ type: "text", text: `❌ Unknown tool: ${name}` }],
        isError: true,
      };
    }
    try {
      const args = tool.schema.parse(rawArgs ?? {});
      const text = await tool.handler(args);
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return {
        content: [{ type: "text", text: `❌ Error: ${formatError(error)}` }],
        isError: true,
      };
    }
  });
}

async function runServer(): Promise<void> {
  const creds = loadOrCreateCredentials();
  const bridge = new Bridge({
    token: creds.token,
    port: creds.port,
    expectedOrigin: process.env.MCP_BROWSER_TABS_EXT_ORIGIN,
    log: (m) => log(`bridge: ${m}`),
  });

  try {
    await bridge.start();
    // Never log the token: stderr is captured into the MCP client's on-disk log
    // files. Retrieve it on demand via get_pairing_info or the 0600 creds file.
    log(
      `bridge listening on 127.0.0.1:${creds.port}. Pair the extension with the get_pairing_info tool (token stored in ${credentialsPath()}).`
    );
  } catch (error) {
    log(
      `WARNING: bridge failed to start (${
        error instanceof Error ? error.message : String(error)
      }). Tab grouping will be unavailable; get_tabs/close/activate still work via AppleScript. If the port is in use, set MCP_BROWSER_TABS_PORT.`
    );
  }

  setupHandlers(buildTools(bridge, creds));

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log("server running on stdio");
}

runServer().catch((error) => {
  process.stderr.write(`Fatal error running server: ${error}\n`);
  process.exit(1);
});
