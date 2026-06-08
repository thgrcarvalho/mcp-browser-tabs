/**
 * Native Chrome tab-group tools. All require the companion extension (they call
 * chrome.tabs.group / chrome.tabGroups via the bridge); when it is not
 * connected, bridge.request throws NOT_CONNECTED and the dispatcher surfaces a
 * clear pairing message.
 *
 * Tab/group ids here are chrome.tabs / chrome.tabGroups ids, matching the ids
 * get_tabs returns while the extension is connected.
 */

import type { z } from "zod";
import type { Bridge } from "../bridge/server.js";
import type {
  AddTabsToGroupInput,
  ExtGroup,
  GroupTabsInput,
  ListGroupsInput,
  RemoveTabsFromGroupInput,
  UngroupGroupInput,
  UpdateGroupInput,
} from "../bridge/protocol.js";

type Params = Record<string, unknown>;

export async function groupTabsText(
  bridge: Bridge,
  args: z.infer<typeof GroupTabsInput>
): Promise<string> {
  const { groupId } = await bridge.request<{ groupId: number }>("group_tabs", args as Params);
  const name = args.title ? ` "${args.title}"` : "";
  const color = args.color ? `, color ${args.color}` : "";
  return `✅ Created group ${groupId}${name} with ${args.tabIds.length} tab(s)${color}.`;
}

export async function addTabsToGroupText(
  bridge: Bridge,
  args: z.infer<typeof AddTabsToGroupInput>
): Promise<string> {
  await bridge.request("add_tabs_to_group", args as Params);
  return `✅ Added ${args.tabIds.length} tab(s) to group ${args.groupId}.`;
}

export async function removeTabsFromGroupText(
  bridge: Bridge,
  args: z.infer<typeof RemoveTabsFromGroupInput>
): Promise<string> {
  const res = await bridge.request<{ dissolvedGroupIds?: number[]; removedCount?: number }>(
    "remove_tabs_from_group",
    args as Params
  );
  const dissolved =
    res?.dissolvedGroupIds && res.dissolvedGroupIds.length > 0
      ? ` Group(s) ${res.dissolvedGroupIds.join(", ")} became empty and were dissolved.`
      : "";
  const removed = res?.removedCount ?? args.tabIds.length;
  if (removed === 0) {
    return `No tabs needed removing — the requested tab(s) were already ungrouped.${dissolved}`;
  }
  return `✅ Removed ${removed} tab(s) from their group.${dissolved}`;
}

export async function ungroupGroupText(
  bridge: Bridge,
  args: z.infer<typeof UngroupGroupInput>
): Promise<string> {
  await bridge.request("ungroup_group", args as Params);
  return `✅ Dissolved group ${args.groupId} (its tabs are now ungrouped).`;
}

export async function updateGroupText(
  bridge: Bridge,
  args: z.infer<typeof UpdateGroupInput>
): Promise<string> {
  const { group } = await bridge.request<{ group: ExtGroup }>("update_group", args as Params);
  const changes: string[] = [];
  if (args.title !== undefined) changes.push(group.title ? `title "${group.title}"` : "title cleared");
  if (args.color !== undefined) changes.push(`color ${group.color}`);
  if (args.collapsed !== undefined) changes.push(group.collapsed ? "collapsed" : "expanded");
  return `✅ Updated group ${group.id}: ${changes.join(", ")}.`;
}

export async function listGroupsText(
  bridge: Bridge,
  args: z.infer<typeof ListGroupsInput>
): Promise<string> {
  const { groups } = await bridge.request<{ groups: ExtGroup[] }>("list_groups", args as Params);
  if (groups.length === 0) {
    return "No tab groups currently exist.";
  }
  const lines = groups.map(
    (g) =>
      `[Group ${g.id}] "${g.title || "untitled"}" — ${g.color}${
        g.collapsed ? ", collapsed" : ""
      } — window ${g.windowId} — tabs: ${g.tabIds.join(", ") || "(none)"}`
  );
  return `${groups.length} tab group(s):\n${lines.join("\n")}`;
}
