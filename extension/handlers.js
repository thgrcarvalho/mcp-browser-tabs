/**
 * Command handlers for the companion extension.
 *
 * These are PURE in the sense that they take the `chrome` API object as an
 * argument, so they can be unit-tested in Node with a fake chrome. They touch
 * ONLY chrome.tabs / chrome.tabGroups / chrome.windows — never cookies,
 * history, or page content (the extension has no permission for those).
 *
 * This module is shared verbatim between the browser (service-worker.js imports
 * it) and the Node test suite.
 */

export const TAB_GROUP_ID_NONE = -1;

export class CommandError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CommandError";
    this.code = code;
  }
}

function requireTabIds(params) {
  const ids = params && params.tabIds;
  if (!Array.isArray(ids) || ids.length === 0) {
    throw new CommandError("EMPTY_TAB_IDS", "Provide a non-empty tabIds array.");
  }
  return ids;
}

function toExtTab(t) {
  return {
    id: t.id,
    windowId: t.windowId,
    index: t.index,
    title: t.title || "",
    url: t.url || t.pendingUrl || "",
    active: !!t.active,
    pinned: !!t.pinned,
    groupId: typeof t.groupId === "number" ? t.groupId : TAB_GROUP_ID_NONE,
  };
}

async function toExtGroup(chrome, g) {
  const members = await chrome.tabs.query({ groupId: g.id });
  return {
    id: g.id,
    windowId: g.windowId,
    title: g.title || "",
    color: g.color,
    collapsed: !!g.collapsed,
    tabIds: members.map((t) => t.id),
  };
}

/** Reject if the given tabs (plus an optional required window) aren't all in one window. */
async function assertSameWindow(chrome, tabIds, requiredWindowId) {
  const tabs = await Promise.all(tabIds.map((id) => chrome.tabs.get(id)));
  const windows = new Set(tabs.map((t) => t.windowId));
  if (requiredWindowId !== undefined && requiredWindowId !== null) windows.add(requiredWindowId);
  if (windows.size > 1) {
    throw new CommandError(
      "SAME_WINDOW_REQUIRED",
      `All tabs must be in the same window. Saw windows: ${[...windows].join(", ")}.`
    );
  }
  return tabs.length ? tabs[0].windowId : requiredWindowId;
}

async function getTabs(chrome) {
  const tabs = await chrome.tabs.query({});
  const groupsRaw = await chrome.tabGroups.query({});
  const groups = await Promise.all(groupsRaw.map((g) => toExtGroup(chrome, g)));
  return { tabs: tabs.map(toExtTab), groups };
}

async function closeTab(chrome, params) {
  await chrome.tabs.remove(params.tabId);
  return {};
}

async function activateTab(chrome, params) {
  const tab = await chrome.tabs.get(params.tabId);
  await chrome.tabs.update(params.tabId, { active: true });
  if (tab && typeof tab.windowId === "number") {
    await chrome.windows.update(tab.windowId, { focused: true });
  }
  return {};
}

async function groupTabs(chrome, params) {
  const tabIds = requireTabIds(params);
  await assertSameWindow(chrome, tabIds, params.windowId);
  const groupId = await chrome.tabs.group({ tabIds });
  const update = {};
  if (params.title !== undefined) update.title = params.title;
  if (params.color !== undefined) update.color = params.color;
  if (Object.keys(update).length > 0) {
    await chrome.tabGroups.update(groupId, update);
  }
  return { groupId };
}

async function addTabsToGroup(chrome, params) {
  const tabIds = requireTabIds(params);
  const group = await chrome.tabGroups.get(params.groupId); // throws -> GROUP_NOT_FOUND
  await assertSameWindow(chrome, tabIds, group.windowId);
  await chrome.tabs.group({ tabIds, groupId: params.groupId });
  return { groupId: params.groupId };
}

async function removeTabsFromGroup(chrome, params) {
  const tabIds = requireTabIds(params);
  // Record which groups these tabs belonged to, to report any that dissolve.
  const before = await Promise.all(tabIds.map((id) => chrome.tabs.get(id)));
  const groupIdOf = (t) => (typeof t.groupId === "number" ? t.groupId : TAB_GROUP_ID_NONE);
  // Tabs that were actually in a group (already-ungrouped tabs are a no-op).
  const removedCount = before.filter((t) => groupIdOf(t) !== TAB_GROUP_ID_NONE).length;
  const affected = [...new Set(before.map(groupIdOf).filter((gid) => gid !== TAB_GROUP_ID_NONE))];
  await chrome.tabs.ungroup(tabIds);
  const dissolvedGroupIds = [];
  for (const gid of affected) {
    try {
      await chrome.tabGroups.get(gid);
    } catch {
      dissolvedGroupIds.push(gid);
    }
  }
  return { dissolvedGroupIds, removedCount };
}

async function ungroupGroup(chrome, params) {
  await chrome.tabGroups.get(params.groupId); // throws -> GROUP_NOT_FOUND
  const members = await chrome.tabs.query({ groupId: params.groupId });
  if (members.length > 0) {
    await chrome.tabs.ungroup(members.map((t) => t.id));
  }
  return {};
}

async function updateGroup(chrome, params) {
  const update = {};
  if (params.title !== undefined) update.title = params.title;
  if (params.color !== undefined) update.color = params.color;
  if (params.collapsed !== undefined) update.collapsed = params.collapsed;
  if (Object.keys(update).length === 0) {
    throw new CommandError("INVALID_PARAMS", "Provide at least one of: title, color, collapsed.");
  }
  const g = await chrome.tabGroups.update(params.groupId, update); // throws -> GROUP_NOT_FOUND
  return { group: await toExtGroup(chrome, g) };
}

async function listGroups(chrome, params) {
  const query = params && typeof params.windowId === "number" ? { windowId: params.windowId } : {};
  const groupsRaw = await chrome.tabGroups.query(query);
  const groups = await Promise.all(groupsRaw.map((g) => toExtGroup(chrome, g)));
  return { groups };
}

const ROUTES = {
  get_tabs: getTabs,
  close_tab: closeTab,
  activate_tab: activateTab,
  group_tabs: groupTabs,
  add_tabs_to_group: addTabsToGroup,
  remove_tabs_from_group: removeTabsFromGroup,
  ungroup_group: ungroupGroup,
  update_group: updateGroup,
  list_groups: listGroups,
};

/**
 * Dispatch a single command. Throws CommandError; the caller serializes
 * `{ code, message }` back to the server.
 */
export async function handleCommand(chrome, type, params = {}) {
  const route = ROUTES[type];
  if (!route) {
    throw new CommandError("INVALID_PARAMS", `Unknown command: ${type}`);
  }
  try {
    return await route(chrome, params);
  } catch (e) {
    if (e instanceof CommandError) throw e;
    const msg = e && e.message ? e.message : String(e);
    if (/No tab with id/i.test(msg)) throw new CommandError("TAB_NOT_FOUND", msg);
    if (/No group with id/i.test(msg)) throw new CommandError("GROUP_NOT_FOUND", msg);
    throw new CommandError("CHROME_API_ERROR", msg);
  }
}

export function errorPayload(e) {
  if (e instanceof CommandError) return { code: e.code, message: e.message };
  return { code: "CHROME_API_ERROR", message: e && e.message ? e.message : String(e) };
}
