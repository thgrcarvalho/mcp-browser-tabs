/**
 * Tab listing / close / activate. These route through the companion extension
 * when it is connected (so ids are chrome.tabs ids, consistent with the group
 * tools) and fall back to AppleScript otherwise.
 *
 * IMPORTANT id-space rule: when the extension is connected, ALL id-based tools
 * use chrome.tabs ids; when it is not, ALL use AppleScript tab ids. The two are
 * different namespaces, so never mix ids fetched in one mode with calls in the
 * other. The get_tabs output always states its `source` so the contract is clear.
 */

import {
  activateChromeTabById,
  closeChromeTabById,
  getChromeTabsWithIds,
} from "../applescript.js";
import type { Bridge } from "../bridge/server.js";
import type { ExtGroup, ExtTab } from "../bridge/protocol.js";

interface GetTabsResult {
  tabs: ExtTab[];
  groups: ExtGroup[];
}

export async function getTabsText(bridge: Bridge): Promise<string> {
  if (bridge.isConnected()) {
    const { tabs, groups } = await bridge.request<GetTabsResult>("get_tabs", {});
    return formatExtensionTabs(tabs, groups);
  }
  const windows = await getChromeTabsWithIds();
  return formatAppleScriptTabs(windows);
}

export async function closeTabText(bridge: Bridge, tabId: number): Promise<string> {
  if (bridge.isConnected()) {
    await bridge.request("close_tab", { tabId });
  } else {
    await closeChromeTabById(tabId);
  }
  return `✅ Closed tab with ID ${tabId}`;
}

export async function activateTabText(bridge: Bridge, tabId: number): Promise<string> {
  if (bridge.isConnected()) {
    await bridge.request("activate_tab", { tabId });
  } else {
    await activateChromeTabById(tabId);
  }
  return `✅ Activated tab with ID ${tabId}`;
}

// --- formatting ------------------------------------------------------------

function formatExtensionTabs(tabs: ExtTab[], groups: ExtGroup[]): string {
  if (tabs.length === 0) {
    return "No open Chrome tabs found (source: extension — chrome.tabs IDs).";
  }
  const groupById = new Map(groups.map((g) => [g.id, g]));

  // Preserve window order by first appearance, tabs by their index.
  const byWindow = new Map<number, ExtTab[]>();
  for (const tab of tabs) {
    const list = byWindow.get(tab.windowId) ?? [];
    list.push(tab);
    byWindow.set(tab.windowId, list);
  }

  const windowBlocks = Array.from(byWindow.entries()).map(([windowId, winTabs]) => {
    winTabs.sort((a, b) => a.index - b.index);
    const active = winTabs.find((t) => t.active);
    const header = `Window ${windowId}${active ? ` (Active: Tab ID ${active.id})` : ""}:`;
    const lines = winTabs.map((t) => {
      const markers = `${t.active ? " ★" : ""}${t.pinned ? " 📌" : ""}`;
      const group = t.groupId !== -1 ? groupById.get(t.groupId) : undefined;
      const groupNote = group
        ? `  (group ${group.id}: "${group.title || "untitled"}", ${group.color})`
        : "";
      return `  ${t.index + 1}. ${t.title}${markers}\n     ${t.url}\n     [Tab ID: ${t.id}]${groupNote}`;
    });
    return `${header}\n${lines.join("\n")}`;
  });

  const groupSummary =
    groups.length > 0
      ? `\n\nTab groups (${groups.length}):\n${groups
          .map(
            (g) =>
              `  [Group ${g.id}] "${g.title || "untitled"}" — ${g.color}${
                g.collapsed ? ", collapsed" : ""
              } — tabs: ${g.tabIds.join(", ") || "(none)"}`
          )
          .join("\n")}`
      : "\n\nNo tab groups yet.";

  return `Found ${tabs.length} open tabs in Chrome (source: extension — chrome.tabs IDs).

${windowBlocks.join("\n\n")}${groupSummary}

Notes:
- Use the [Tab ID] / [Group ID] numbers for all operations.
- IDs are valid for THIS browser session only — they change after a Chrome restart, so re-run get_tabs / list_groups to refresh them.
- All tabs in a group must be in the same window (windowId shown in the group's tabs).`;
}

function formatAppleScriptTabs(
  windows: Awaited<ReturnType<typeof getChromeTabsWithIds>>
): string {
  const totalTabs = windows.reduce((sum, w) => sum + w.tabs.length, 0);
  if (totalTabs === 0) {
    return "No open Chrome tabs found (source: applescript — AppleScript tab IDs).";
  }
  const blocks = windows.map((window) => {
    const activeTab = window.tabs.find((t) => t.isActive);
    const activeIndicator = activeTab ? ` (Active: Tab ID ${activeTab.id})` : "";
    const lines = window.tabs
      .map((tab) => {
        const activeMarker = tab.isActive ? " ★" : "";
        return `  ${window.windowIndex}-${tab.tabIndex}. ${tab.title}${activeMarker}\n     ${tab.url}\n     [Tab ID: ${tab.id}]`;
      })
      .join("\n");
    return `Window ${window.windowIndex}${activeIndicator}:\n${lines}`;
  });

  return `Found ${totalTabs} open tabs in Chrome (source: applescript — AppleScript tab IDs).

${blocks.join("\n\n")}

Notes:
- Tab groups are unavailable in this mode. Connect the companion extension to create/manage groups.
- Use the [Tab ID] numbers for close/activate. These AppleScript IDs are NOT stable across browser restarts — re-run get_tabs to refresh them.`;
}
