import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { HOST_PROBES } from "../src/host-probe.js";
import { RPC_METHOD_ALLOWLIST } from "../src/local-rpc.js";
import {
  extractSettingsAllowlistFromSource,
  runLiveProbe,
  validateStaticContracts,
} from "../scripts/probe-host.mjs";

const rootDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const contracts = JSON.parse(readFileSync(resolve(rootDir, "spec/compat-contracts.json"), "utf8"));
const settingsAllowlist = extractSettingsAllowlistFromSource(
  readFileSync(resolve(rootDir, "src/index.js"), "utf8"),
);

test("repo spec/compat-contracts.json matches live allowlists and HOST_PROBES", () => {
  const res = validateStaticContracts({
    contracts,
    rpcAllowlist: RPC_METHOD_ALLOWLIST,
    hostProbes: HOST_PROBES,
    settingsAllowlist,
  });
  assert.equal(res.ok, true, res.errors.join("; "));
  assert.equal(res.rpcCount, 40);
});

test("validateStaticContracts detects missing RPC and settings allowlist drift", () => {
  const trimmed = {
    ...contracts,
    rpcMethods: contracts.rpcMethods.filter((r) => r.method !== "workspace.list"),
    settingsAllowlist: { ...contracts.settingsAllowlist, extra: ["k"] },
  };
  const res = validateStaticContracts({
    contracts: trimmed,
    rpcAllowlist: RPC_METHOD_ALLOWLIST,
    hostProbes: HOST_PROBES,
    settingsAllowlist,
  });
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => e.includes("workspace.list")));
  assert.ok(res.errors.some((e) => e.includes("settingsAllowlist")));
});

test("runLiveProbe classifies PASS, DEGRADED, BROKEN, timeout unknown, and skips static-only", async () => {
  const seen = [];
  const passReport = await runLiveProbe({
    contracts,
    call: async (method) => { seen.push(method); return {}; },
  });
  assert.equal(passReport.verdict, "PASS");
  assert.ok(!seen.includes("session.create"), "static-only mutating RPC must never be called");

  const degradedReport = await runLiveProbe({
    contracts,
    call: async (method) => {
      if (method === "schedule.edit") {
        const err = new Error("unknown remote");
        err.code = "gateway/unknown-remote";
        throw err;
      }
      return {};
    },
  });
  assert.equal(degradedReport.verdict, "DEGRADED");
  assert.deepEqual(degradedReport.missing, ["schedule.edit"]);

  const brokenReport = await runLiveProbe({
    contracts,
    call: async (method) => {
      if (method === "workspace.list") {
        const err = new Error("no such method");
        err.code = "gateway/method-not-found";
        throw err;
      }
      return {};
    },
  });
  assert.equal(brokenReport.verdict, "BROKEN");

  const timeoutReport = await runLiveProbe({
    contracts,
    timeoutMs: 20,
    call: async (method) => {
      if (method === "settings.describe") return await new Promise(() => {});
      return {};
    },
  });
  assert.equal(timeoutReport.verdict, "DEGRADED");
  assert.deepEqual(timeoutReport.unknown, ["settings.describe"]);
});
