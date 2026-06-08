const DEFAULT_PORT = 37454;

const tokenInput = document.getElementById("token");
const portInput = document.getElementById("port");
const saveButton = document.getElementById("save");
const statusText = document.getElementById("status-text");
const statusDot = document.querySelector("#status .dot");

function renderStatus(status, connected) {
  const state = connected ? "connected" : (status && status.state) || "idle";
  const detail = (status && status.detail) || "";
  let cls = "";
  let label = state;
  if (connected || state === "connected") {
    cls = "connected";
    label = "Connected";
  } else if (state === "connecting") {
    cls = "pending";
    label = "Connecting…";
  } else if (state === "error" || state === "unpaired") {
    cls = "error";
    label = state === "unpaired" ? "Not paired" : "Error";
  } else {
    cls = "";
    label = "Disconnected";
  }
  statusDot.className = `dot ${cls}`;
  statusText.textContent = detail ? `${label} — ${detail}` : label;
}

async function load() {
  const stored = await chrome.storage.local.get(["token", "port"]);
  if (typeof stored.token === "string") tokenInput.value = stored.token;
  portInput.value = Number.isInteger(stored.port) ? stored.port : DEFAULT_PORT;
  refreshStatus();
}

function refreshStatus() {
  chrome.runtime.sendMessage({ type: "getStatus" }, (resp) => {
    if (chrome.runtime.lastError) {
      renderStatus({ state: "idle" }, false);
      return;
    }
    renderStatus(resp && resp.status, resp && resp.connected);
  });
}

saveButton.addEventListener("click", async () => {
  const token = tokenInput.value.trim();
  const port = Number.parseInt(portInput.value, 10) || DEFAULT_PORT;
  await chrome.storage.local.set({ token, port });
  chrome.runtime.sendMessage({ type: "reconnect" }, () => {
    void chrome.runtime.lastError; // ignore if worker is asleep; storage change also triggers reconnect
    renderStatus({ state: "connecting" }, false);
  });
});

// Live updates pushed by the service worker.
chrome.runtime.onMessage.addListener((message) => {
  if (message && message.type === "status") {
    renderStatus(message.status, message.status && message.status.state === "connected");
  }
});

load();
