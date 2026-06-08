import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Guards the core security guarantee: the companion extension must request ONLY
 * tab/group-management permissions and never anything that could read cookies,
 * sessions, history, or page content. If anyone widens the manifest, this fails.
 */

const here = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(
  readFileSync(join(here, "..", "extension", "manifest.json"), "utf8")
) as Record<string, any>;

const ALLOWED_PERMISSIONS = ["alarms", "storage", "tabGroups", "tabs"];
const FORBIDDEN_TOP_LEVEL_KEYS = [
  "host_permissions",
  "content_scripts",
  "web_accessible_resources",
];
const FORBIDDEN_PERMISSIONS = [
  "cookies",
  "history",
  "webRequest",
  "webRequestBlocking",
  "scripting",
  "<all_urls>",
  "debugger",
  "downloads",
  "bookmarks",
  "browsingData",
  "privacy",
  "proxy",
];

test("manifest requests EXACTLY the allowlisted permissions", () => {
  assert.deepEqual([...manifest.permissions].sort(), ALLOWED_PERMISSIONS);
});

test("manifest declares no host permissions or content scripts", () => {
  for (const key of FORBIDDEN_TOP_LEVEL_KEYS) {
    assert.equal(manifest[key], undefined, `manifest must not declare ${key}`);
  }
});

test("manifest requests no security-sensitive permission", () => {
  const perms = new Set<string>(manifest.permissions);
  for (const p of FORBIDDEN_PERMISSIONS) {
    assert.equal(perms.has(p), false, `manifest must not request "${p}"`);
  }
});

test("manifest is MV3 with a module service worker", () => {
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.background.type, "module");
  assert.equal(manifest.background.service_worker, "service-worker.js");
});
