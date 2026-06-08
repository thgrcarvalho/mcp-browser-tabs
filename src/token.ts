/**
 * Bridge credentials (shared secret + port) for the loopback WebSocket.
 *
 * The token is the real security gate between the MCP server and the companion
 * extension: a strong random secret the user pastes into the extension once.
 * It is persisted with 0600 permissions so only the user can read it.
 */

import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Default loopback port. Override with MCP_BROWSER_TABS_PORT. */
export const DEFAULT_PORT = 37454;

export interface BridgeCredentials {
  token: string;
  port: number;
}

function configDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), ".config");
  return join(base, "mcp-browser-tabs");
}

export function credentialsPath(): string {
  return join(configDir(), "bridge.json");
}

function envPort(): number | undefined {
  const raw = process.env.MCP_BROWSER_TABS_PORT;
  if (!raw || !/^\d+$/.test(raw)) return undefined;
  const n = Number.parseInt(raw, 10);
  return n >= 1 && n <= 65535 ? n : undefined;
}

/**
 * Read existing credentials or create them. The token is generated once and
 * reused; the port is env override > persisted > default. The resolved values
 * are persisted back so the file always reflects what the server is using.
 */
export function loadOrCreateCredentials(): BridgeCredentials {
  const path = credentialsPath();
  let token: string | undefined;
  let persistedPort: number | undefined;

  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<BridgeCredentials>;
      if (typeof parsed.token === "string" && parsed.token.length >= 32) {
        token = parsed.token;
      } else {
        // File present but unusable token — regenerating silently would break a
        // previously paired extension with no signal, so warn on stderr.
        console.error(
          `[mcp-browser-tabs] ${path} has no valid token; regenerating. Re-pair the extension with the new token (get_pairing_info).`
        );
      }
      if (
        typeof parsed.port === "number" &&
        Number.isInteger(parsed.port) &&
        parsed.port >= 1 &&
        parsed.port <= 65535
      )
        persistedPort = parsed.port;
    } catch {
      // Corrupt file — fall through and regenerate, but tell the user.
      console.error(
        `[mcp-browser-tabs] ${path} is corrupt; regenerating credentials. Re-pair the extension with the new token (get_pairing_info).`
      );
    }
  }

  if (!token) token = randomBytes(32).toString("hex");
  const port = envPort() ?? persistedPort ?? DEFAULT_PORT;

  const dir = configDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify({ token, port }, null, 2)}\n`, { mode: 0o600 });
  // writeFileSync's mode is only applied on creation; enforce it on every run.
  try {
    chmodSync(path, 0o600);
  } catch {
    // Best effort (e.g. non-POSIX filesystems).
  }

  return { token, port };
}
