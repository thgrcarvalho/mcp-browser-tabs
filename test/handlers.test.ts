import test from "node:test";
import assert from "node:assert/strict";
// Import the SAME module the extension service worker loads.
import { handleCommand, TAB_GROUP_ID_NONE } from "../extension/handlers.js";

interface FakeTab {
  id: number;
  windowId: number;
  index: number;
  title: string;
  url: string;
  pendingUrl?: string;
  active: boolean;
  pinned: boolean;
  groupId: number;
}

interface FakeGroup {
  id: number;
  windowId: number;
  title: string;
  color: string;
  collapsed: boolean;
}

/** Minimal in-memory stand-in for the chrome.tabs / chrome.tabGroups APIs. */
function makeFakeChrome(tabs: FakeTab[], groups: FakeGroup[] = []) {
  let nextGroupId = Math.max(0, ...groups.map((g) => g.id)) + 1;
  const focusedWindows: Array<{ id: number; props: unknown }> = [];

  function pruneEmptyGroups() {
    for (let i = groups.length - 1; i >= 0; i--) {
      const g = groups[i];
      if (!tabs.some((t) => t.groupId === g.id)) groups.splice(i, 1);
    }
  }

  const chrome = {
    tabs: {
      async query(q: { groupId?: number; windowId?: number } = {}) {
        return tabs.filter(
          (t) =>
            (q.groupId === undefined || t.groupId === q.groupId) &&
            (q.windowId === undefined || t.windowId === q.windowId)
        );
      },
      async get(id: number) {
        const t = tabs.find((x) => x.id === id);
        if (!t) throw new Error(`No tab with id: ${id}.`);
        return t;
      },
      async remove(id: number) {
        const idx = tabs.findIndex((x) => x.id === id);
        if (idx === -1) throw new Error(`No tab with id: ${id}.`);
        tabs.splice(idx, 1);
        pruneEmptyGroups();
      },
      async update(id: number, props: Partial<FakeTab>) {
        const t = tabs.find((x) => x.id === id);
        if (!t) throw new Error(`No tab with id: ${id}.`);
        Object.assign(t, props);
        return t;
      },
      async group({
        tabIds,
        groupId,
      }: {
        tabIds: number[];
        groupId?: number;
        createProperties?: { windowId?: number };
      }) {
        const targets = tabIds.map((id) => {
          const t = tabs.find((x) => x.id === id);
          if (!t) throw new Error(`No tab with id: ${id}.`);
          return t;
        });
        let gid = groupId;
        if (gid === undefined) {
          gid = nextGroupId++;
          groups.push({
            id: gid,
            windowId: targets[0].windowId,
            title: "",
            color: "grey",
            collapsed: false,
          });
        } else if (!groups.some((g) => g.id === gid)) {
          throw new Error(`No group with id: ${gid}.`);
        }
        for (const t of targets) t.groupId = gid;
        return gid;
      },
      async ungroup(tabIds: number[]) {
        for (const id of tabIds) {
          const t = tabs.find((x) => x.id === id);
          if (t) t.groupId = TAB_GROUP_ID_NONE;
        }
        pruneEmptyGroups();
      },
    },
    tabGroups: {
      async query(q: { windowId?: number } = {}) {
        return groups.filter((g) => q.windowId === undefined || g.windowId === q.windowId);
      },
      async get(id: number) {
        const g = groups.find((x) => x.id === id);
        if (!g) throw new Error(`No group with id: ${id}.`);
        return g;
      },
      async update(id: number, props: Partial<FakeGroup>) {
        const g = groups.find((x) => x.id === id);
        if (!g) throw new Error(`No group with id: ${id}.`);
        Object.assign(g, props);
        return g;
      },
    },
    windows: {
      async update(id: number, props: unknown) {
        focusedWindows.push({ id, props });
        return {};
      },
    },
    focusedWindows,
  };
  return chrome;
}

function tab(id: number, windowId: number, index: number, extra: Partial<FakeTab> = {}): FakeTab {
  return {
    id,
    windowId,
    index,
    title: `Tab ${id}`,
    url: `https://example.com/${id}`,
    active: false,
    pinned: false,
    groupId: TAB_GROUP_ID_NONE,
    ...extra,
  };
}

test("get_tabs returns tabs and groups with members", async () => {
  const chrome = makeFakeChrome(
    [tab(1, 100, 0, { groupId: 5, active: true }), tab(2, 100, 1, { groupId: 5 }), tab(3, 100, 2)],
    [{ id: 5, windowId: 100, title: "Work", color: "blue", collapsed: false }]
  );
  const res: any = await handleCommand(chrome, "get_tabs", {});
  assert.equal(res.tabs.length, 3);
  assert.equal(res.groups.length, 1);
  assert.deepEqual(res.groups[0].tabIds.sort(), [1, 2]);
  assert.equal(res.tabs.find((t: any) => t.id === 3).groupId, TAB_GROUP_ID_NONE);
});

test("group_tabs creates a group and applies title/color (two-step)", async () => {
  const chrome = makeFakeChrome([tab(1, 100, 0), tab(2, 100, 1)]);
  const res: any = await handleCommand(chrome, "group_tabs", {
    tabIds: [1, 2],
    title: "Research",
    color: "green",
  });
  assert.ok(Number.isInteger(res.groupId));
  const groups: any = await handleCommand(chrome, "list_groups", {});
  assert.equal(groups.groups[0].title, "Research");
  assert.equal(groups.groups[0].color, "green");
  assert.deepEqual(groups.groups[0].tabIds.sort(), [1, 2]);
});

test("group_tabs rejects tabs spanning multiple windows", async () => {
  const chrome = makeFakeChrome([tab(1, 100, 0), tab(2, 200, 0)]);
  await assert.rejects(handleCommand(chrome, "group_tabs", { tabIds: [1, 2] }), (e: any) => {
    assert.equal(e.code, "SAME_WINDOW_REQUIRED");
    return true;
  });
});

test("group_tabs rejects an empty tabIds array", async () => {
  const chrome = makeFakeChrome([tab(1, 100, 0)]);
  await assert.rejects(handleCommand(chrome, "group_tabs", { tabIds: [] }), (e: any) => {
    assert.equal(e.code, "EMPTY_TAB_IDS");
    return true;
  });
});

test("add_tabs_to_group fails for a missing group", async () => {
  const chrome = makeFakeChrome([tab(1, 100, 0)]);
  await assert.rejects(
    handleCommand(chrome, "add_tabs_to_group", { groupId: 999, tabIds: [1] }),
    (e: any) => {
      assert.equal(e.code, "GROUP_NOT_FOUND");
      return true;
    }
  );
});

test("remove_tabs_from_group reports a group that dissolves when emptied", async () => {
  const chrome = makeFakeChrome(
    [tab(1, 100, 0, { groupId: 7 }), tab(2, 100, 1, { groupId: 7 })],
    [{ id: 7, windowId: 100, title: "Temp", color: "red", collapsed: false }]
  );
  const res: any = await handleCommand(chrome, "remove_tabs_from_group", { tabIds: [1, 2] });
  assert.deepEqual(res.dissolvedGroupIds, [7]);
  const groups: any = await handleCommand(chrome, "list_groups", {});
  assert.equal(groups.groups.length, 0);
});

test("ungroup_group dissolves a group but keeps the tabs", async () => {
  const chrome = makeFakeChrome(
    [tab(1, 100, 0, { groupId: 9 }), tab(2, 100, 1, { groupId: 9 })],
    [{ id: 9, windowId: 100, title: "X", color: "pink", collapsed: false }]
  );
  await handleCommand(chrome, "ungroup_group", { groupId: 9 });
  const res: any = await handleCommand(chrome, "get_tabs", {});
  assert.equal(res.tabs.length, 2);
  assert.equal(res.groups.length, 0);
});

test("update_group applies collapsed + color", async () => {
  const chrome = makeFakeChrome(
    [tab(1, 100, 0, { groupId: 3 })],
    [{ id: 3, windowId: 100, title: "A", color: "grey", collapsed: false }]
  );
  const res: any = await handleCommand(chrome, "update_group", {
    groupId: 3,
    color: "purple",
    collapsed: true,
  });
  assert.equal(res.group.color, "purple");
  assert.equal(res.group.collapsed, true);
});

test("update_group with no fields is rejected", async () => {
  const chrome = makeFakeChrome(
    [tab(1, 100, 0, { groupId: 3 })],
    [{ id: 3, windowId: 100, title: "A", color: "grey", collapsed: false }]
  );
  await assert.rejects(handleCommand(chrome, "update_group", { groupId: 3 }), (e: any) => {
    assert.equal(e.code, "INVALID_PARAMS");
    return true;
  });
});

test("unknown command is rejected", async () => {
  const chrome = makeFakeChrome([]);
  await assert.rejects(handleCommand(chrome, "do_evil", {}), (e: any) => {
    assert.equal(e.code, "INVALID_PARAMS");
    return true;
  });
});

test("a missing tab maps to TAB_NOT_FOUND", async () => {
  const chrome = makeFakeChrome([]);
  await assert.rejects(handleCommand(chrome, "close_tab", { tabId: 42 }), (e: any) => {
    assert.equal(e.code, "TAB_NOT_FOUND");
    return true;
  });
});

test("activate_tab activates the tab and focuses its own window", async () => {
  const chrome = makeFakeChrome([tab(1, 100, 0), tab(2, 200, 1)]);
  await handleCommand(chrome, "activate_tab", { tabId: 1 });
  const res: any = await handleCommand(chrome, "get_tabs", {});
  assert.equal(res.tabs.find((t: any) => t.id === 1).active, true);
  assert.equal(chrome.focusedWindows.length, 1);
  assert.deepEqual(chrome.focusedWindows[0], { id: 100, props: { focused: true } });
});

test("activate_tab on a missing tab maps to TAB_NOT_FOUND", async () => {
  const chrome = makeFakeChrome([]);
  await assert.rejects(handleCommand(chrome, "activate_tab", { tabId: 42 }), (e: any) => {
    assert.equal(e.code, "TAB_NOT_FOUND");
    return true;
  });
});

test("add_tabs_to_group adds a same-window tab to an existing group", async () => {
  const chrome = makeFakeChrome(
    [tab(1, 100, 0, { groupId: 5 }), tab(2, 100, 1)],
    [{ id: 5, windowId: 100, title: "Work", color: "blue", collapsed: false }]
  );
  const res: any = await handleCommand(chrome, "add_tabs_to_group", { groupId: 5, tabIds: [2] });
  assert.equal(res.groupId, 5);
  const view: any = await handleCommand(chrome, "get_tabs", {});
  assert.deepEqual(view.groups.find((x: any) => x.id === 5).tabIds.sort(), [1, 2]);
});

test("add_tabs_to_group rejects a tab in a different window than the group", async () => {
  const chrome = makeFakeChrome(
    [tab(1, 100, 0, { groupId: 5 }), tab(2, 200, 0)],
    [{ id: 5, windowId: 100, title: "Work", color: "blue", collapsed: false }]
  );
  await assert.rejects(
    handleCommand(chrome, "add_tabs_to_group", { groupId: 5, tabIds: [2] }),
    (e: any) => {
      assert.equal(e.code, "SAME_WINDOW_REQUIRED");
      return true;
    }
  );
});

test("add_tabs_to_group rejects an empty tabIds array before the group lookup", async () => {
  // groupId 999 doesn't exist; if requireTabIds did NOT run first, this would
  // surface GROUP_NOT_FOUND instead — so this asserts the ordering.
  const chrome = makeFakeChrome([tab(1, 100, 0)]);
  await assert.rejects(
    handleCommand(chrome, "add_tabs_to_group", { groupId: 999, tabIds: [] }),
    (e: any) => {
      assert.equal(e.code, "EMPTY_TAB_IDS");
      return true;
    }
  );
});

test("remove_tabs_from_group reports 0 removed when tabs were already ungrouped", async () => {
  const chrome = makeFakeChrome([tab(1, 100, 0), tab(2, 100, 1)]);
  const res: any = await handleCommand(chrome, "remove_tabs_from_group", { tabIds: [1, 2] });
  assert.equal(res.removedCount, 0);
  assert.deepEqual(res.dissolvedGroupIds, []);
});

test("get_tabs surfaces pendingUrl and a defaulted empty title for a loading tab", async () => {
  const chrome = makeFakeChrome([
    tab(1, 100, 0, { url: "", pendingUrl: "https://loading.example", title: "" }),
  ]);
  const res: any = await handleCommand(chrome, "get_tabs", {});
  const t = res.tabs.find((x: any) => x.id === 1);
  assert.equal(t.url, "https://loading.example");
  assert.equal(t.title, "");
});
