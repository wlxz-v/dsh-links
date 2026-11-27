import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { MIN_COMPAT_APP_VERSION, pluginCapabilities } from "../src/protocol-caps.js";

const rootDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const pkg = JSON.parse(readFileSync(resolve(rootDir, "package.json"), "utf8"));

test("pluginCapabilities exposes compat metadata matching package.json", () => {
  const caps = pluginCapabilities();
  assert.deepEqual(caps.compat, {
    pluginVersion: pkg.version,
    minAppVersion: MIN_COMPAT_APP_VERSION,
    protocolVersion: 1,
  });
});
