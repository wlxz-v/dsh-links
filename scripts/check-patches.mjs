import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PATCH_TAG_RE = /@patch\(([a-z0-9-]+)\)/g;
const SCAN_EXTENSIONS = new Set([".js", ".mjs", ".kt"]);
const REQUIRED_FIELDS = ["id", "file", "for", "why", "until", "test"];

function normalizeRel(p) {
  return String(p).replace(/\\/g, "/").replace(/^\.\//, "");
}

function walkSourceFiles(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkSourceFiles(full, out);
    } else if (entry.isFile()) {
      const dot = entry.name.lastIndexOf(".");
      const ext = dot >= 0 ? entry.name.slice(dot) : "";
      if (SCAN_EXTENSIONS.has(ext)) out.push(full);
    }
  }
  return out;
}

export function checkPatches({
  rootDir,
  registryPath = "spec/patches-registry.json",
  scanDirs = ["src", "apps/android/app/src/main"],
}) {
  const errors = [];
  const absRegistry = resolve(rootDir, registryPath);
  if (!existsSync(absRegistry)) {
    return { ok: false, count: 0, errors: ["Missing registry file: " + registryPath] };
  }
  const raw = JSON.parse(readFileSync(absRegistry, "utf8"));
  const patches = Array.isArray(raw?.patches) ? raw.patches : null;
  if (!patches) {
    return { ok: false, count: 0, errors: ["Registry patches field must be an array"] };
  }

  const byId = new Map();
  for (let i = 0; i < patches.length; i += 1) {
    const p = patches[i];
    for (const field of REQUIRED_FIELDS) {
      if (typeof p?.[field] !== "string" || !p[field].trim()) {
        errors.push("Entry #" + i + " (" + String(p?.id ?? "unknown") + ") missing non-empty field: " + field);
      }
    }
    if (typeof p?.id === "string" && p.id.trim()) {
      if (byId.has(p.id)) errors.push("Duplicate patch id: " + p.id);
      else byId.set(p.id, { ...p, file: normalizeRel(p.file), test: normalizeRel(p.test) });
    }
    if (typeof p?.test === "string" && p.test.trim()) {
      if (!existsSync(resolve(rootDir, p.test))) {
        errors.push("Patch " + p.id + " references missing test file: " + p.test);
      }
    }
    if (typeof p?.file === "string" && p.file.trim()) {
      const absFile = resolve(rootDir, p.file);
      if (!existsSync(absFile)) {
        errors.push("Patch " + p.id + " references missing source file: " + p.file);
      } else {
        const text = readFileSync(absFile, "utf8");
        if (!text.includes("@patch(" + p.id + ")")) {
          errors.push("Patch " + p.id + " is registered for " + p.file + " but @patch(" + p.id + ") tag was not found there");
        }
      }
    }
  }

  for (const relDir of scanDirs) {
    const absDir = resolve(rootDir, relDir);
    for (const absFile of walkSourceFiles(absDir)) {
      const relFile = normalizeRel(relative(rootDir, absFile));
      const text = readFileSync(absFile, "utf8");
      for (const match of text.matchAll(PATCH_TAG_RE)) {
        const id = match[1];
        const entry = byId.get(id);
        if (!entry) {
          errors.push("Unregistered @patch(" + id + ") found in " + relFile);
        } else if (entry.file !== relFile) {
          errors.push("@patch(" + id + ") found in " + relFile + " but registry expects " + entry.file);
        }
      }
    }
  }

  return { ok: errors.length === 0, count: patches.length, errors };
}

function main() {
  const rootDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const res = checkPatches({ rootDir });
  if (!res.ok) {
    for (const err of res.errors) console.error("ERROR: " + err);
    process.exit(1);
  }
  console.log("OK: " + res.count + " patches verified");
}

const entryArg = process.argv[1] ? realpathSync(resolve(process.argv[1])) : "";
const selfPath = realpathSync(fileURLToPath(import.meta.url));
if (entryArg === selfPath) {
  main();
}
