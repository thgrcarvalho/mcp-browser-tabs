/**
 * Loopback WebSocket server that bridges the MCP server to the companion
 * Chrome extension.
 *
 * Security model (see SECURITY.md):
 *  - Binds to 127.0.0.1 only — never reachable off-box.
 *  - Authenticates at the WebSocket *handshake* via a token carried in the
 *    Sec-WebSocket-Protocol subprotocol (service workers cannot set custom
 *    headers, but can set a subprotocol). Unauthenticated peers are rejected
 *    during the upgrade and never reach the message dispatcher.
 *  - Pins the Origin to a chrome-extension:// origin (defense in depth; the
 *    token, not the origin, is the real gate since native processes can spoof
 *    Origin).
 *  - Single authenticated client at a time (a new one drops the old).
 *  - Dispatches only the closed command allowlist in protocol.ts — no
 *    arbitrary chrome.* passthrough.
 */

import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocket, WebSocketServer } from "ws";
import { BridgeRpcError, PendingRegistry } from "./registry.js";
import {
  type BridgeRequest,
  type BridgeResponse,
  BridgeResponseSchema,
  type CommandType,
  type Heartbeat,
  PROTOCOL_VERSION,
  isHeartbeat,
} from "./protocol.js";

export const SUBPROTOCOL_PREFIX = "mcp-browser-tabs.";
const HEARTBEAT_INTERVAL_MS = 20_000;
const HEARTBEAT_MAX_MISSED = 2;
const REQUEST_TIMEOUT_MS = 8_000;

export interface BridgeOptions {
  token: string;
  port: number;
  /** Bind host. Defaults to 127.0.0.1; do not expose off-loopback. */
  host?: string;
  /**
   * If set, only this exact Origin is accepted (e.g.
   * "chrome-extension://<id>"). If unset, any chrome-extension:// origin is
   * accepted and the token does the gating.
   */
  expectedOrigin?: string;
  /** Diagnostic logger. MUST write to stderr (stdout is the JSON-RPC stream). */
  log?: (msg: string) => void;
  /** Per-request response timeout in ms (default 8000). */
  requestTimeoutMs?: number;
  /** Heartbeat ping interval in ms (default 20000). */
  heartbeatIntervalMs?: number;
  /** Missed pongs before the client is terminated (default 2). */
  maxMissedPongs?: number;
}

function timingSafeStringEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** Extract a candidate token from the comma-separated subprotocol header. */
export function extractSubprotocolToken(header: string | undefined): string | null {
  if (!header) return null;
  for (const raw of header.split(",")) {
    const proto = raw.trim();
    if (proto.startsWith(SUBPROTOCOL_PREFIX)) {
      return proto.slice(SUBPROTOCOL_PREFIX.length);
    }
  }
  return null;
}

export class Bridge {
  private wss: WebSocketServer | null = null;
  private client: WebSocket | null = null;
  private readonly registry: PendingRegistry;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private missedPongs = 0;
  private boundPort: number | null = null;
  private readonly host: string;
  private readonly log: (msg: string) => void;
  private readonly heartbeatIntervalMs: number;
  private readonly maxMissedPongs: number;

  constructor(private readonly opts: BridgeOptions) {
    this.host = opts.host ?? "127.0.0.1";
    this.log = opts.log ?? (() => {});
    this.registry = new PendingRegistry(opts.requestTimeoutMs ?? REQUEST_TIMEOUT_MS);
    this.heartbeatIntervalMs = opts.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS;
    this.maxMissedPongs = opts.maxMissedPongs ?? HEARTBEAT_MAX_MISSED;
  }

  isConnected(): boolean {
    return this.client !== null && this.client.readyState === WebSocket.OPEN;
  }

  /** The actually-bound port (resolves port 0 to the OS-assigned port). */
  get port(): number {
    return this.boundPort ?? this.opts.port;
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const wss = new WebSocketServer({
        host: this.host,
        port: this.opts.port,
        handleProtocols: (protocols: Set<string>) => this.selectProtocol(protocols),
        verifyClient: (
          info: { origin: string; secure: boolean; req: IncomingMessage },
          cb: (verified: boolean, code?: number, message?: string) => void
        ) => this.verifyClient(info, cb),
      });

      const onError = (err: Error) => {
        this.log(`bridge server error: ${err.message}`);
        reject(err);
      };
      wss.once("error", onError);
      wss.on("listening", () => {
        wss.off("error", onError);
        wss.on("error", (err) => this.log(`bridge server error: ${err.message}`));
        const addr = wss.address();
        if (addr && typeof addr === "object") this.boundPort = (addr as AddressInfo).port;
        this.log(`bridge listening on ws://${this.host}:${this.port}`);
        resolve();
      });
      wss.on("connection", (ws, req) => this.onConnection(ws, req));
      this.wss = wss;
    });
  }

  /** Send a command to the extension and await its correlated response. */
  async request<T = unknown>(type: CommandType, params: Record<string, unknown>): Promise<T> {
    if (!this.isConnected()) {
      throw new BridgeRpcError({
        code: "NOT_CONNECTED",
        message:
          "Companion Chrome extension is not connected. Load the extension and pair it (see README).",
      });
    }
    const { id, promise } = this.registry.create();
    const msg: BridgeRequest = { v: PROTOCOL_VERSION, id, type, params };
    this.client!.send(JSON.stringify(msg));
    return promise as Promise<T>;
  }

  async stop(): Promise<void> {
    this.stopHeartbeat();
    this.client?.terminate();
    this.client = null;
    this.registry.rejectAll({ code: "DISCONNECTED", message: "Bridge stopped" });
    const wss = this.wss;
    this.wss = null;
    if (!wss) return;
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  }

  // --- handshake auth ------------------------------------------------------

  private verifyClient(
    info: { origin: string; secure: boolean; req: IncomingMessage },
    cb: (verified: boolean, code?: number, message?: string) => void
  ): void {
    const origin = info.origin ?? (info.req.headers.origin as string | undefined) ?? "";
    const originOk = this.opts.expectedOrigin
      ? origin === this.opts.expectedOrigin
      : origin.startsWith("chrome-extension://");
    if (!originOk) {
      this.log(`rejected connection: bad origin "${origin}"`);
      cb(false, 403, "Forbidden origin");
      return;
    }

    const header = info.req.headers["sec-websocket-protocol"] as string | undefined;
    const token = extractSubprotocolToken(header);
    if (!token || !timingSafeStringEqual(token, this.opts.token)) {
      this.log("rejected connection: bad or missing token");
      cb(false, 401, "Unauthorized");
      return;
    }
    cb(true);
  }

  /** Echo back the authenticated subprotocol so the handshake completes. */
  private selectProtocol(protocols: Set<string>): string | false {
    for (const proto of protocols) {
      if (proto.startsWith(SUBPROTOCOL_PREFIX)) return proto;
    }
    return false;
  }

  // --- connection lifecycle ------------------------------------------------

  private onConnection(ws: WebSocket, req: IncomingMessage): void {
    // Single-client policy: a fresh authenticated client replaces the old one.
    if (this.client && this.client !== ws) {
      this.log("new client connected; dropping previous client");
      this.client.terminate();
      this.registry.rejectAll({ code: "DISCONNECTED", message: "Replaced by a new client" });
    }
    this.client = ws;
    this.missedPongs = 0;
    this.log(`extension connected from ${req.socket.remoteAddress ?? "?"}`);

    ws.on("message", (data) => this.onMessage(ws, data.toString()));
    ws.on("close", () => this.onClose(ws));
    ws.on("error", (err) => this.log(`client socket error: ${err.message}`));

    this.startHeartbeat();
  }

  private onMessage(ws: WebSocket, raw: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(raw);
    } catch {
      this.log("dropped non-JSON message from client");
      return;
    }

    if (isHeartbeat(msg)) {
      if (msg.type === "ping") {
        const pong: Heartbeat = { v: PROTOCOL_VERSION, type: "pong" };
        ws.send(JSON.stringify(pong));
      } else {
        this.missedPongs = 0;
      }
      return;
    }

    const parsed = BridgeResponseSchema.safeParse(msg);
    if (!parsed.success) {
      this.log("dropped malformed response from client");
      return;
    }
    if (!this.registry.settle(parsed.data as unknown as BridgeResponse)) {
      this.log(`dropped response for unknown/expired id ${parsed.data.id}`);
    }
  }

  private onClose(ws: WebSocket): void {
    if (this.client !== ws) return; // a stale (already-replaced) socket closing
    this.log("extension disconnected");
    this.client = null;
    this.stopHeartbeat();
    this.registry.rejectAll({ code: "DISCONNECTED", message: "Extension disconnected" });
  }

  // --- heartbeat -----------------------------------------------------------

  private startHeartbeat(): void {
    this.stopHeartbeat();
    const timer = setInterval(() => {
      if (!this.client || this.client.readyState !== WebSocket.OPEN) return;
      if (this.missedPongs >= this.maxMissedPongs) {
        this.log("heartbeat timeout; terminating client");
        this.client.terminate();
        return;
      }
      this.missedPongs++;
      const ping: Heartbeat = { v: PROTOCOL_VERSION, type: "ping" };
      this.client.send(JSON.stringify(ping));
    }, this.heartbeatIntervalMs);
    if (typeof timer.unref === "function") timer.unref();
    this.heartbeatTimer = timer;
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
}
