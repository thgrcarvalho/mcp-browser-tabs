import test from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import { Bridge } from "../src/bridge/server.js";

const TOKEN = "a".repeat(64);
const ORIGIN = "chrome-extension://abcdefghabcdefghabcdefghabcdefgh";

interface StartOpts {
  requestTimeoutMs?: number;
  expectedOrigin?: string;
  heartbeatIntervalMs?: number;
  maxMissedPongs?: number;
}

async function startBridge(opts: StartOpts = {}): Promise<Bridge> {
  const bridge = new Bridge({ token: TOKEN, port: 0, ...opts });
  await bridge.start();
  return bridge;
}

function connectClient(
  port: number,
  { token = TOKEN, origin = ORIGIN, noProtocol = false } = {}
): WebSocket {
  const protocols = noProtocol ? [] : [`mcp-browser-tabs.${token}`];
  return new WebSocket(`ws://127.0.0.1:${port}`, protocols, { origin });
}

function waitOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", (err) => reject(err));
    ws.once("unexpected-response", () => reject(new Error("unexpected-response")));
  });
}

function waitRejected(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.once("open", () => reject(new Error("connection unexpectedly opened")));
    ws.once("error", () => resolve());
    ws.once("unexpected-response", () => resolve());
    ws.once("close", () => resolve());
  });
}

function nextMessage(ws: WebSocket): Promise<string> {
  return new Promise((resolve) => ws.once("message", (d) => resolve(d.toString())));
}

async function waitUntil(fn: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 10));
  }
}

test("rejects connection with no token (no subprotocol)", async () => {
  const bridge = await startBridge();
  try {
    const client = connectClient(bridge.port, { noProtocol: true });
    await waitRejected(client);
    assert.equal(bridge.isConnected(), false);
  } finally {
    await bridge.stop();
  }
});

test("rejects connection with a wrong token", async () => {
  const bridge = await startBridge();
  try {
    const client = connectClient(bridge.port, { token: "b".repeat(64) });
    await waitRejected(client);
    assert.equal(bridge.isConnected(), false);
  } finally {
    await bridge.stop();
  }
});

test("rejects connection with a non-extension origin", async () => {
  const bridge = await startBridge();
  try {
    const client = connectClient(bridge.port, { origin: "https://evil.example.com" });
    await waitRejected(client);
    assert.equal(bridge.isConnected(), false);
  } finally {
    await bridge.stop();
  }
});

test("accepts a valid token + extension origin", async () => {
  const bridge = await startBridge();
  try {
    const client = connectClient(bridge.port);
    await waitOpen(client);
    await waitUntil(() => bridge.isConnected());
    assert.equal(bridge.isConnected(), true);
    client.close();
  } finally {
    await bridge.stop();
  }
});

test("correlates responses to requests, even out of order", async () => {
  const bridge = await startBridge();
  try {
    const client = connectClient(bridge.port);
    await waitOpen(client);
    await waitUntil(() => bridge.isConnected());

    const received: Array<{ id: string; type: string }> = [];
    client.on("message", (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === "ping" || msg.type === "pong") return;
      received.push({ id: msg.id, type: msg.type });
    });

    const p1 = bridge.request("get_tabs", {});
    const p2 = bridge.request("list_groups", {});
    await waitUntil(() => received.length === 2);

    // Reply in reverse order.
    const [first, second] = received;
    client.send(JSON.stringify({ v: 1, id: second.id, ok: true, result: { which: second.type } }));
    client.send(JSON.stringify({ v: 1, id: first.id, ok: true, result: { which: first.type } }));

    assert.deepEqual(await p1, { which: "get_tabs" });
    assert.deepEqual(await p2, { which: "list_groups" });
    client.close();
  } finally {
    await bridge.stop();
  }
});

test("propagates structured errors from the extension", async () => {
  const bridge = await startBridge();
  try {
    const client = connectClient(bridge.port);
    await waitOpen(client);
    await waitUntil(() => bridge.isConnected());
    client.on("message", (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === "ping" || msg.type === "pong") return;
      client.send(
        JSON.stringify({
          v: 1,
          id: msg.id,
          ok: false,
          error: { code: "SAME_WINDOW_REQUIRED", message: "nope" },
        })
      );
    });
    await assert.rejects(bridge.request("group_tabs", { tabIds: [1, 2] }), (e: any) => {
      assert.equal(e.code, "SAME_WINDOW_REQUIRED");
      return true;
    });
    client.close();
  } finally {
    await bridge.stop();
  }
});

test("times out when the extension never responds", async () => {
  const bridge = await startBridge({ requestTimeoutMs: 150 });
  try {
    const client = connectClient(bridge.port);
    await waitOpen(client);
    await waitUntil(() => bridge.isConnected());
    // Client intentionally ignores requests.
    await assert.rejects(bridge.request("get_tabs", {}), (e: any) => {
      assert.equal(e.code, "TIMEOUT");
      return true;
    });
    client.close();
  } finally {
    await bridge.stop();
  }
});

test("rejects pending requests when the client disconnects", async () => {
  const bridge = await startBridge();
  try {
    const client = connectClient(bridge.port);
    await waitOpen(client);
    await waitUntil(() => bridge.isConnected());
    const p = bridge.request("get_tabs", {});
    client.close();
    await assert.rejects(p, (e: any) => {
      assert.equal(e.code, "DISCONNECTED");
      return true;
    });
  } finally {
    await bridge.stop();
  }
});

test("a new authenticated client replaces the previous one", async () => {
  const bridge = await startBridge();
  try {
    const a = connectClient(bridge.port);
    await waitOpen(a);
    await waitUntil(() => bridge.isConnected());

    // An in-flight request on A must reject cleanly (not hang) when B replaces A.
    const inflight = bridge.request("get_tabs", {});
    const inflightRejects = assert.rejects(inflight, (e: any) => {
      assert.equal(e.code, "DISCONNECTED");
      return true;
    });

    const b = connectClient(bridge.port);
    await waitOpen(b);
    // Server should drop A.
    await waitUntil(() => a.readyState === WebSocket.CLOSING || a.readyState === WebSocket.CLOSED);
    await waitUntil(() => bridge.isConnected());
    assert.equal(bridge.isConnected(), true);
    await inflightRejects;
    b.close();
  } finally {
    await bridge.stop();
  }
});

test("responds to a client ping with a pong", async () => {
  const bridge = await startBridge();
  try {
    const client = connectClient(bridge.port);
    await waitOpen(client);
    await waitUntil(() => bridge.isConnected());
    client.send(JSON.stringify({ v: 1, type: "ping" }));
    const reply = JSON.parse(await nextMessage(client));
    assert.equal(reply.type, "pong");
    client.close();
  } finally {
    await bridge.stop();
  }
});

test("request rejects when no client is connected", async () => {
  const bridge = await startBridge();
  try {
    await assert.rejects(bridge.request("get_tabs", {}), (e: any) => {
      assert.equal(e.code, "NOT_CONNECTED");
      return true;
    });
  } finally {
    await bridge.stop();
  }
});

test("terminates a client that never replies to server pings", async () => {
  const bridge = await startBridge({ heartbeatIntervalMs: 30, maxMissedPongs: 2 });
  try {
    const client = connectClient(bridge.port);
    await waitOpen(client);
    await waitUntil(() => bridge.isConnected());
    // Client deliberately ignores the server's pings (sends no pong).
    await waitUntil(() => !bridge.isConnected(), 3000);
    assert.equal(bridge.isConnected(), false);
  } finally {
    await bridge.stop();
  }
});

test("keeps a client that replies to server pings", async () => {
  const bridge = await startBridge({ heartbeatIntervalMs: 30, maxMissedPongs: 2 });
  try {
    const client = connectClient(bridge.port);
    await waitOpen(client);
    await waitUntil(() => bridge.isConnected());
    client.on("message", (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === "ping") client.send(JSON.stringify({ v: 1, type: "pong" }));
    });
    // Over several heartbeat intervals the connection must stay up.
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(bridge.isConnected(), true);
    client.close();
  } finally {
    await bridge.stop();
  }
});
