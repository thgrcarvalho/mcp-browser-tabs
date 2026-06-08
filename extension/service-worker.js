/**
 * Companion extension service worker.
 *
 * Connects OUTBOUND as a WebSocket client to the MCP server's loopback bridge
 * (ws://127.0.0.1:<port>), authenticating with the pairing token carried in the
 * subprotocol. Receives command requests, dispatches them to handlers.js (which
 * touches only chrome.tabs / chrome.tabGroups), and returns results.
 *
 * Lifecycle (MV3): the worker is revived by a 1-minute alarm and on
 * startup/install; while connected, the server's 20s pings keep it alive (WS
 * activity resets the idle timer). Reconnection uses exponential backoff.
 */

import { errorPayload, handleCommand } from "./handlers.js";

const PROTOCOL_VERSION = 1;
const SUBPROTOCOL_PREFIX = "mcp-browser-tabs.";
const DEFAULT_PORT = 37454;
const RECONNECT_ALARM = "mcp-bridge-reconnect";
const BACKOFF_MIN_MS = 1000;
const BACKOFF_MAX_MS = 30000;

let socket = null;
let connecting = false;
let reconnectTimer = null;
let backoffMs = BACKOFF_MIN_MS;
let lastStatus = { state: "idle", detail: "" };

function clearReconnectTimer() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function setStatus(state, detail = "") {
  lastStatus = { state, detail };
  // Best-effort notify an open options page; ignore "no receiver" errors.
  chrome.runtime.sendMessage({ type: "status", status: lastStatus }).catch(() => {});
}

async function getConfig() {
  const stored = await chrome.storage.local.get(["token", "port"]);
  return {
    token: typeof stored.token === "string" ? stored.token : "",
    port: Number.isInteger(stored.port) ? stored.port : DEFAULT_PORT,
  };
}

function send(message) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

async function onMessage(raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }

  if (msg.type === "ping") {
    send({ v: PROTOCOL_VERSION, type: "pong" });
    return;
  }
  if (msg.type === "pong") {
    return;
  }

  // Otherwise it's a command request.
  const { id, type, params } = msg;
  if (typeof id !== "string") return;
  try {
    const result = await handleCommand(chrome, type, params || {});
    send({ v: PROTOCOL_VERSION, id, ok: true, result });
  } catch (e) {
    send({ v: PROTOCOL_VERSION, id, ok: false, error: errorPayload(e) });
  }
}

async function connect() {
  // Reentrancy guard. The `socket` checks alone are not enough: getConfig()
  // below yields to the event loop, so two near-simultaneous triggers (e.g. the
  // top-level call racing onStartup, or an alarm racing storage.onChanged) could
  // both pass the socket check while socket is still null and each open a
  // separate WebSocket. `connecting` is set synchronously before the await so the
  // second caller bails out immediately.
  if (connecting) return;
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return;
  }
  connecting = true;

  let ws;
  try {
    const { token, port } = await getConfig();
    if (!token) {
      setStatus("unpaired", "No pairing token set. Open Options and paste the token from get_pairing_info.");
      return;
    }

    ws = new WebSocket(`ws://127.0.0.1:${port}`, [SUBPROTOCOL_PREFIX + token]);
    socket = ws;
    setStatus("connecting", `ws://127.0.0.1:${port}`);

    ws.onopen = () => {
      clearReconnectTimer();
      backoffMs = BACKOFF_MIN_MS;
      setStatus("connected", `127.0.0.1:${port}`);
    };
    ws.onmessage = (ev) => onMessage(typeof ev.data === "string" ? ev.data : "");
    ws.onerror = () => {
      // onclose fires next with the actual reason.
    };
    ws.onclose = (ev) => {
      // Only the live socket drives reconnects. A superseded socket (one that was
      // replaced by a newer connect()) closing must not trigger a reconnect.
      if (socket !== ws) return;
      socket = null;
      setStatus(
        "disconnected",
        `closed (code ${ev.code}). If this persists, re-check the token/port in Options and that the MCP server is running.`
      );
      scheduleReconnect();
    };
  } catch (e) {
    if (!ws) {
      // Failed before/at WebSocket construction; nothing was assigned to socket.
      setStatus("error", String((e && e.message) || e));
      scheduleReconnect();
    }
  } finally {
    connecting = false;
  }
}

function scheduleReconnect() {
  // At most one in-session backoff timer, so overlapping onclose/alarm/storage
  // events can't multiply timers or corrupt the shared backoff sequence. The
  // 1-minute alarm is the durable backstop (it survives worker termination).
  if (reconnectTimer) return;
  const delay = backoffMs;
  backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

// --- lifecycle wiring (must be registered synchronously at top level) -------

chrome.runtime.onInstalled.addListener(() => {
  ensureAlarm();
  connect();
});

chrome.runtime.onStartup.addListener(() => {
  ensureAlarm();
  connect();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RECONNECT_ALARM) {
    if (!socket || socket.readyState !== WebSocket.OPEN) connect();
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message.type !== "string") return false;
  if (message.type === "getStatus") {
    sendResponse({ status: lastStatus, connected: !!socket && socket.readyState === WebSocket.OPEN });
    return false;
  }
  if (message.type === "reconnect") {
    // Force a fresh connection (e.g. after the user saves new credentials).
    if (socket) {
      try {
        socket.close();
      } catch {
        /* ignore */
      }
      socket = null;
    }
    clearReconnectTimer();
    backoffMs = BACKOFF_MIN_MS;
    connect();
    sendResponse({ ok: true });
    return false;
  }
  return false;
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.token || changes.port)) {
    clearReconnectTimer();
    backoffMs = BACKOFF_MIN_MS;
    connect();
  }
});

function ensureAlarm() {
  chrome.alarms.create(RECONNECT_ALARM, { periodInMinutes: 1 });
}

// Initial attempt when the worker first loads.
ensureAlarm();
connect();
