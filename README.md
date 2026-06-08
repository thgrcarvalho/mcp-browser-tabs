# MCP Browser Tabs

Model Context Protocol server for **managing Google Chrome tabs and native tab groups** on macOS. It lets Claude Desktop (or any MCP client) list, focus, and close tabs, and **organize them into real Chrome tab groups** (named, colored, collapsible).

By design it **only manages tabs and tab groups — it never touches cookies, sessions, browsing history, or page content.** See [SECURITY.md](SECURITY.md) for the guarantee and how to verify it.

> Works on a locked-down / managed Mac: it uses **AppleScript (Apple Events)** + a **companion extension** (`chrome.tabGroups`). It does **not** use Chrome remote debugging / the DevTools Protocol, so it is unaffected by `RemoteDebuggingAllowed=false`.

<a href="https://glama.ai/mcp/servers/wze1kc6emp"><img width="380" height="200" src="https://glama.ai/mcp/servers/wze1kc6emp/badge" alt="Browser Tabs Server MCP server" /></a>

## How it works

```
Claude / MCP client ──stdio──> MCP server (this package)
                                  │  hosts a loopback WebSocket on 127.0.0.1 (token-gated)
                                  ▼
                          companion Chrome extension (extension/)
                                  │  chrome.tabs / chrome.tabGroups
                                  ▼
                              Google Chrome
```

- **Listing / closing / activating tabs** works through AppleScript out of the box.
- **Tab groups** require the bundled companion extension, because Chrome's AppleScript dictionary has no tab-group support — native groups are only reachable via the `chrome.tabGroups` extension API. The MCP server bridges to the extension over a loopback WebSocket.

When the extension is connected, tab IDs are `chrome.tabs` IDs and `get_tabs` also reports group membership. When it isn't, the server falls back to AppleScript (tab IDs are AppleScript IDs, no group info). The `get_tabs` output always states its `source`.

## Quick Start

Add the server to your Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "tools": {
    "browser-tabs": {
      "command": "npx",
      "args": ["-y", "@kazuph/mcp-browser-tabs"]
    }
  }
}
```

### 1. Grant Automation/Accessibility for Chrome (required for tab listing/close/activate)

- Open **System Settings → Privacy & Security → Accessibility**
- Add **Google Chrome** and turn its toggle ON.

This lets AppleScript interact with Chrome.

### 2. Install the companion extension (required only for tab groups)

1. In Chrome, open `chrome://extensions`, enable **Developer mode** (top-right).
2. Click **Load unpacked** and select the `extension/` folder of this package.
   - If you installed via `npx`, the package lives under your npm cache; cloning the repo and pointing at its `extension/` folder is the simplest path.
3. Note the extension's status — it will be "Not paired" until you complete step 3.

### 3. Pair the extension with the server (one-time)

1. Ask the assistant to run the **`get_pairing_info`** tool (or read `~/.config/mcp-browser-tabs/bridge.json`). You'll get a **token** and **port**.
2. Open the extension's **Options** page (`chrome://extensions` → the extension → *Details* → *Extension options*).
3. Paste the **token** (and **port** if it isn't the default `37454`), click **Save & connect**.
4. The status turns green ("Connected"). Run `get_tabs` — it should report `source: extension`.

The token is a local secret stored in the extension and in `~/.config/mcp-browser-tabs/bridge.json` (mode `0600`). Nothing is sent off your machine.

## Available tools

**Tabs**

- `get_tabs` — list open tabs (with group membership + a group summary when the extension is connected). The output states its `source`.
- `close_tab_by_id` — close a tab by its ID from `get_tabs`.
- `activate_tab_by_id` — focus a tab (and its window) by ID.
- `close_tab` *(legacy)* — close by window/tab index. Fragile; prefer `close_tab_by_id`.

**Tab groups** *(require the companion extension)*

- `group_tabs` — create a new group from tabs, with optional `title` and `color`. All tabs must be in the same window.
- `add_tabs_to_group` — add tabs to an existing group.
- `remove_tabs_from_group` — ungroup specific tabs (a group auto-dissolves when emptied).
- `ungroup_group` — dissolve a whole group (tabs stay open).
- `update_group` — set a group's `title`, `color`, and/or `collapsed` state.
- `list_groups` — list all groups with members, colors, and collapsed state.

**Setup**

- `get_pairing_info` — show the local token + port to paste into the extension.

Group colors: `grey`, `blue`, `red`, `yellow`, `green`, `pink`, `purple`, `cyan`, `orange` (`gray` is accepted and normalized to `grey`).

> Tab and group IDs are valid for the current browser session only — they change after a Chrome restart. Re-run `get_tabs` / `list_groups` to refresh them.

## For developers

### Prerequisites

- Node.js 18+ (developed/tested on Node 24)
- macOS (for AppleScript) + Google Chrome 116+

### Build & test

```bash
git clone https://github.com/kazuph/mcp-browser-tabs.git
cd mcp-browser-tabs
npm install
npm run build   # tsc -> dist/
npm test        # unit tests (bridge protocol/auth + extension handler logic + manifest guard)
```

The unit tests cover the bridge (handshake auth, request/response correlation, timeout, disconnect, single-client) and the extension command handlers (via an injected fake `chrome`), plus a guard that fails if the extension manifest ever requests a sensitive permission. **End-to-end Chrome behavior and the extension service-worker lifecycle can't be unit-tested — verify those manually (below).**

### Configuration

- `MCP_BROWSER_TABS_PORT` — override the loopback bridge port (default `37454`).
- `MCP_BROWSER_TABS_EXT_ORIGIN` — pin the bridge to one extension origin (e.g. `chrome-extension://<id>`). By default any `chrome-extension://` origin is accepted and the token is the gate.

### Manual test checklist (on a Mac with Chrome)

1. Build, configure the MCP client, load the extension, pair it → Options shows **Connected**.
2. `get_tabs` returns `source: extension`, chrome IDs, and `groupId`s.
3. Terminate the extension's service worker (`chrome://extensions` → *service worker* → terminate); within ~60s it reconnects.
4. `group_tabs` with 2+ tabs in one window + `title` + `color` → the group appears correctly.
5. `group_tabs` across two windows → clean `SAME_WINDOW_REQUIRED` error, nothing grouped.
6. `add_tabs_to_group`, `remove_tabs_from_group` (remove the last tab → group disappears), `update_group` (rename, each color, collapse/expand), `ungroup_group`.
7. `list_groups` matches the Chrome UI.
8. Quit Chrome / disable the extension → group tools say "not connected"; `get_tabs` falls back to `source: applescript`.
9. Restart Chrome → group IDs changed; `list_groups` shows the new IDs.
10. Security smoke: from an unrelated `https://` page's devtools, `new WebSocket("ws://127.0.0.1:37454")` is rejected (no token).

## Notes & limitations

- macOS + Google Chrome (Chromium) only. `chrome.tabGroups` is Chromium-specific.
- Tab/group IDs are session-scoped (not stable across restarts).
- Tab-group operations require the companion extension; everything else works via AppleScript alone.
- Does **not** use Chrome remote debugging / CDP.

## Security

This tool manages **only tabs and tab groups**. It cannot read cookies, sessions, history, or page content. See **[SECURITY.md](SECURITY.md)** for the full guarantee and how to verify it (manifest inspection, command allowlist, loopback-only bridge).

## License

MIT License — see [LICENSE](LICENSE).
