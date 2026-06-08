# Security & Privacy Guarantee

**This tool manages only tabs and tab groups. It does not read or transmit cookies, sessions, browsing history, passwords, form data, or page content — and it is structured so you can verify that yourself.**

There are exactly two ways this tool touches Chrome, and neither can reach security-sensitive data.

## 1. AppleScript (Apple Events)

Tab listing, close, and activate work via `osascript` talking to Chrome (`src/applescript.ts`).

- Chrome's AppleScript dictionary exposes only `application`, `window`, `tab`, and `bookmark`. The only tab data it can read is **title and URL**; the only actions are navigate/close/activate.
- It **cannot** read cookies, sessions, history, or page DOM — those simply aren't in the scripting dictionary. This isn't a policy we enforce; the capability doesn't exist.
- This tool does **not** use `execute javascript` (which would run in page context anyway and still cannot reach extension/cookie APIs), and does **not** use Chrome remote debugging / the DevTools Protocol.

## 2. The companion extension

Native tab groups are managed by the bundled extension (`extension/`) via `chrome.tabs` / `chrome.tabGroups`. Its power is bounded by its manifest.

### Permissions: exactly four, all non-sensitive

`extension/manifest.json` requests **only**:

| Permission  | What it grants | What it does NOT grant |
|-------------|----------------|------------------------|
| `tabs`      | Read tab `title`/`url`, and group/close/activate tabs | No page content, no cookies, no history |
| `tabGroups` | Create/read/update/dissolve tab groups | Exposes no page data at all |
| `storage`   | The extension's own storage (holds the pairing token) | Not page/site storage, not cookies |
| `alarms`    | A periodic timer to keep the bridge connection alive | Nothing data-related |

It deliberately declares **no** `host_permissions`, **no** `<all_urls>`, **no** `content_scripts`, and none of `cookies`, `history`, `webRequest`, `scripting`, `downloads`, `bookmarks`, `browsingData`, `debugger`. Cookies, page content, and network interception live behind those separate permissions — which this extension never requests.

> Note: the `tabs` permission does expose each tab's URL and title (the same metadata `get_tabs` has always returned). That is tab metadata, not page content, cookies, or history.

### Closed command set — no arbitrary code

The extension executes only the fixed command allowlist in `src/bridge/protocol.ts`, dispatched in `extension/handlers.js`. There is **no** `eval`, **no** arbitrary `chrome.*` passthrough, and **no** script injection. Every handler calls only `chrome.tabs`, `chrome.tabGroups`, or `chrome.windows`.

## The bridge

The MCP server and extension talk over a WebSocket that is:

- **Loopback only** — bound to `127.0.0.1`, never reachable off your machine.
- **Token-authenticated at the handshake** — a 256-bit random token (in `~/.config/mcp-browser-tabs/bridge.json`, mode `0600`) carried in the WebSocket subprotocol and checked with a constant-time compare before any command channel exists. A web page that probes the port without the token is rejected during the handshake.
- **Origin-checked** — only `chrome-extension://` origins are accepted (optionally pinned to one extension ID via `MCP_BROWSER_TABS_EXT_ORIGIN`).
- **Single-client** — only one authenticated client at a time.

Nothing is sent off the machine: the extension connects only to `127.0.0.1`, and the token never leaves local storage.

## How to verify it yourself

1. **Read `extension/manifest.json`** — confirm `permissions` is exactly `["tabs", "tabGroups", "storage", "alarms"]` and there are no `host_permissions` / `content_scripts`.
2. **Read `extension/handlers.js`** — confirm every operation uses only `chrome.tabs` / `chrome.tabGroups` / `chrome.windows`, with no `eval` or script injection.
3. **Run the tests** — `npm test` includes `test/manifest.test.ts`, which **fails the build** if anyone ever adds a sensitive permission to the manifest.
4. **Check the bridge bind** — `src/bridge/server.ts` binds to `127.0.0.1` and authenticates in `verifyClient` before accepting any message.

## Reporting

If you find a way this tool can reach cookies, sessions, history, or page content, please open an issue — that would be a bug against this guarantee.
