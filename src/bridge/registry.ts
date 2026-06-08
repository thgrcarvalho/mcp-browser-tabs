/**
 * Correlates outbound bridge requests with their responses. Pure logic (no
 * WebSocket dependency) so it is fully unit-testable: every request gets a
 * unique id and a promise that resolves on a matching response, rejects on
 * timeout, or rejects when the connection drops.
 */

import { randomUUID } from "node:crypto";
import type { BridgeError, BridgeResponse } from "./protocol.js";

export class BridgeRpcError extends Error {
  readonly code: string;
  constructor(error: BridgeError) {
    super(error.message);
    this.name = "BridgeRpcError";
    this.code = error.code;
  }
}

interface Pending {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class PendingRegistry {
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly timeoutMs: number) {}

  /** Register a new request; returns its id and a promise for the result. */
  create(): { id: string; promise: Promise<unknown> } {
    const id = randomUUID();
    const promise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new BridgeRpcError({
            code: "TIMEOUT",
            message: `Extension did not respond within ${this.timeoutMs}ms`,
          })
        );
      }, this.timeoutMs);
      // Don't let a stray pending timer keep the process alive.
      if (typeof timer.unref === "function") timer.unref();
      this.pending.set(id, { resolve, reject, timer });
    });
    return { id, promise };
  }

  /** Settle the pending request matching a response. Returns true if matched. */
  settle(response: BridgeResponse): boolean {
    const entry = this.pending.get(response.id);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.pending.delete(response.id);
    if (response.ok === true) {
      entry.resolve(response.result);
    } else {
      entry.reject(
        new BridgeRpcError(
          response.error ?? { code: "CHROME_API_ERROR", message: "Unknown extension error" }
        )
      );
    }
    return true;
  }

  /** Reject every outstanding request (e.g. when the socket closes). */
  rejectAll(error: BridgeError): void {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      this.pending.delete(id);
      entry.reject(new BridgeRpcError(error));
    }
  }

  get size(): number {
    return this.pending.size;
  }
}
