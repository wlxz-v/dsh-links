import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { checkPatches } from "../scripts/check-patches.mjs";

function makeFixture() {
  const dir = mkdtempSync(join(tmpdir(), "dsh-links-patches-"));
  mkdirSync(join(dir, "src"), { recursive: true });
  mkdirSync(join(dir, "spec"), { recursive: true });
  mkdirSync(join(dir, "test"), { recursive: true });
  return dir;
}

test("repo spec/patches-registry.json passes bidirectional check", () => {
  const rootDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const res = checkPatches({ rootDir });
  assert.equal(res.ok, true, res.errors.join("; "));
  assert.ok(res.count >= 6);
});

test("checkPatches rejects unregistered @patch tag in source", () => {
  const dir = makeFixture();
  try {
    writeFileSync(join(dir, "src", "a.js"), "// @patch(orphan-patch)\nexport const a = 1;\n");
    writeFileSync(join(dir, "spec", "patches-registry.json"), JSON.stringify({ schemaVersion: 1, patches: [] }));
    const res = checkPatches({ rootDir: dir });
    assert.equal(res.ok, false);
    assert.ok(res.errors.some((e) => e.includes("orphan-patch")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("checkPatches rejects missing @patch tag, empty fields, and missing test file", () => {
  const dir = makeFixture();
  try {
    writeFileSync(join(dir, "src", "a.js"), "export const a = 1;\n");
    writeFileSync(join(dir, "spec", "patches-registry.json"), JSON.stringify({
      schemaVersion: 1,
      patches: [{ id: "p1", file: "src/a.js", for: "host", why: "reason", until: "", test: "test/missing.test.mjs" }],
    }));
    const res = checkPatches({ rootDir: dir });
    assert.equal(res.ok, false);
    assert.ok(res.errors.some((e) => e.includes("until")));
    assert.ok(res.errors.some((e) => e.includes("missing test file")));
    assert.ok(res.errors.some((e) => e.includes("tag was not found")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
