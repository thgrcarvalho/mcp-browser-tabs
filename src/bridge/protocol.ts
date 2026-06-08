/**
 * Shared wire protocol between the MCP server (WebSocket server) and the
 * companion Chrome extension (WebSocket client).
 *
 * SECURITY NOTE: this protocol is a *closed command allowlist*. The extension
 * dispatches ONLY the command types enumerated here onto chrome.tabs /
 * chrome.tabGroups. There is no arbitrary `chrome.*` passthrough and no code
 * eval, so the bridge cannot be coerced into reading cookies, history, or page
 * content — none of which it has permission to touch anyway. See SECURITY.md.
 */

import { z } from "zod";

export const PROTOCOL_VERSION = 1;

/** Every command the server may ask the extension to perform. */
export const COMMAND_TYPES = [
  "get_tabs",
  "close_tab",
  "activate_tab",
  "group_tabs",
  "add_tabs_to_group",
  "remove_tabs_from_group",
  "ungroup_group",
  "update_group",
  "list_groups",
] as const;

export type CommandType = (typeof COMMAND_TYPES)[number];

/** Structured error codes the extension (or server) can return. */
export type BridgeErrorCode =
  | "SAME_WINDOW_REQUIRED"
  | "GROUP_NOT_FOUND"
  | "TAB_NOT_FOUND"
  | "EMPTY_TAB_IDS"
  | "INVALID_PARAMS"
  | "CHROME_API_ERROR"
  | "NOT_CONNECTED"
  | "TIMEOUT"
  | "DISCONNECTED";

export interface BridgeError {
  code: BridgeErrorCode;
  message: string;
}

/** Server -> extension. */
export interface BridgeRequest {
  v: number;
  id: string;
  type: CommandType;
  params: Record<string, unknown>;
}

/** Extension -> server. */
export interface BridgeResponse {
  v: number;
  id: string;
  ok: boolean;
  result?: unknown;
  error?: BridgeError;
}

/** Bidirectional keepalive (no id, not correlated). */
export interface Heartbeat {
  v: number;
  type: "ping" | "pong";
}

export function isHeartbeat(msg: unknown): msg is Heartbeat {
  if (typeof msg !== "object" || msg === null) return false;
  const m = msg as { id?: unknown; v?: unknown; type?: unknown };
  // Correlated responses always carry an id; heartbeats never do. Rejecting
  // any id-bearing message here keeps the two message classes mutually
  // exclusive, so an id-bearing frame is always routed to the response branch
  // regardless of its `type`.
  if ("id" in m) return false;
  if (typeof m.v !== "number") return false;
  return m.type === "ping" || m.type === "pong";
}

// ---------------------------------------------------------------------------
// Chrome-side shapes (what the extension reports back)
// ---------------------------------------------------------------------------

/** A tab as seen by the extension via chrome.tabs (ids are chrome.tabs ids). */
export interface ExtTab {
  id: number;
  windowId: number;
  index: number;
  title: string;
  url: string;
  active: boolean;
  pinned: boolean;
  /** chrome.tabGroups id, or -1 (TAB_GROUP_ID_NONE) when ungrouped. */
  groupId: number;
}

/** A tab group as seen by the extension via chrome.tabGroups. */
export interface ExtGroup {
  id: number;
  windowId: number;
  title: string;
  color: GroupColor;
  collapsed: boolean;
  /** chrome.tabs ids that belong to this group. */
  tabIds: number[];
}

// ---------------------------------------------------------------------------
// Tab group colors
// ---------------------------------------------------------------------------

/**
 * The exact color set chrome.tabGroups accepts. Note the British spelling
 * "grey" (not "gray"); see normalizeColor for the alias.
 */
export const GROUP_COLORS = [
  "grey",
  "blue",
  "red",
  "yellow",
  "green",
  "pink",
  "purple",
  "cyan",
  "orange",
] as const;

export type GroupColor = (typeof GROUP_COLORS)[number];

export const GroupColorSchema = z
  .enum(["grey", "gray", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"])
  .transform((c): GroupColor => (c === "gray" ? "grey" : c));

// ---------------------------------------------------------------------------
// MCP tool input schemas (validated server-side before crossing the bridge)
// ---------------------------------------------------------------------------

const TabId = z.number().int().positive();
const TabIds = z.array(TabId).min(1, "Provide at least one tab ID");
const GroupId = z.number().int();

export const GroupTabsInput = z.object({
  tabIds: TabIds.describe("chrome.tabs IDs (from get_tabs) to put in a new group — all must be in the same window"),
  title: z.string().optional().describe("Optional group name shown on the tab strip"),
  color: GroupColorSchema.optional().describe("Optional group color (grey, blue, red, yellow, green, pink, purple, cyan, orange)"),
  windowId: z.number().int().optional().describe("Optional window ID; defaults to the window the tabs are in"),
});

export const AddTabsToGroupInput = z.object({
  groupId: GroupId.describe("Existing group ID from list_groups/get_tabs"),
  tabIds: TabIds.describe("chrome.tabs IDs to add to the group — must be in the group's window"),
});

export const RemoveTabsFromGroupInput = z.object({
  tabIds: TabIds.describe("chrome.tabs IDs to ungroup (a group auto-dissolves when its last tab is removed)"),
});

export const UngroupGroupInput = z.object({
  groupId: GroupId.describe("Group ID to dissolve (ungroups all of its tabs)"),
});

export const UpdateGroupInput = z
  .object({
    groupId: GroupId.describe("Group ID to update"),
    title: z.string().optional().describe("New group name"),
    color: GroupColorSchema.optional().describe("New group color"),
    collapsed: z.boolean().optional().describe("Collapse (true) or expand (false) the group"),
  })
  .refine(
    (v) => v.title !== undefined || v.color !== undefined || v.collapsed !== undefined,
    { message: "Provide at least one of: title, color, collapsed" }
  );

export const ListGroupsInput = z.object({
  windowId: z.number().int().optional().describe("Optional window ID to filter groups by"),
});

export const TabIdInput = z.object({
  tabId: TabId.describe("The chrome.tabs ID (when the extension is connected) or AppleScript tab ID (fallback) from get_tabs"),
});

/**
 * Runtime shape check for inbound responses from the extension. Even though the
 * peer is token-authenticated, a buggy extension could send a malformed frame;
 * validating here keeps garbage out of the tool layer and avoids mis-routing a
 * non-boolean `ok` as success. `code` is left as a loose string so a
 * well-formed error with an unknown code still settles as a rejection.
 */
export const BridgeResponseSchema = z.object({
  v: z.number(),
  id: z.string(),
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
});
