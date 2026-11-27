import { randomBytes } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HOST_PROBES, PROBE_TIMEOUT_MS } from "../src/host-probe.js";
import { RPC_METHOD_ALLOWLIST, wireEndpoint } from "../src/local-rpc.js";
import { isMissingRemoteError } from "../src/mobile-session-control.js";

const MUTATING_METHODS = new Set([
  "credentials.set", "goals.clear", "goals.edit", "goals.pause", "goals.resume",
  "messageFeedback.delete", "messageFeedback.put", "session.cancel", "session.create",
  "session.fork", "session.prompt", "session.rename", "session.selectModel",
  "session.updateQueue", "schedule.delete", "schedule.update", "settings.mutate",
  "settings.update", "workspace.archiveSession", "workspace.create", "workspace.delete",
]);

export function extractSettingsAllowlistFromSource(sourceText) {
  const match = /const\s+SETTINGS_WRITE_ALLOWLIST\s*=\s*(\{[\s\S]*?\n\})/.exec(String(sourceText ?? ""));
  if (!match) throw new Error("Could not locate SETTINGS_WRITE_ALLOWLIST in src/index.js");
  return Function("'use strict'; return (" + match[1] + ")")();
}

function stableJson(value) {
  return JSON.stringify(value, (_, v) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]]));
    }
    return v;
  });
}

export function validateStaticContracts({ contracts, rpcAllowlist, hostProbes, settingsAllowlist }) {
  const errors = [];
  const rpcEntries = Array.isArray(contracts?.rpcMethods) ? contracts.rpcMethods : [];
  const byMethod = new Map();
  for (const item of rpcEntries) {
    if (!item?.method) { errors.push("rpcMethods entry missing method"); continue; }
    if (byMethod.has(item.method)) errors.push("Duplicate rpcMethod in contracts: " + item.method);
    byMethod.set(item.method, item);
    if (MUTATING_METHODS.has(item.method) && item.probeMode === "readonly") {
      errors.push("Mutating RPC cannot use readonly probeMode: " + item.method);
    }
    const expectedWire = wireEndpoint(item.method);
    if (item.method !== "workspace.list" && expectedWire && item.wire !== expectedWire) {
      errors.push("Wire mismatch for " + item.method + ": expected " + expectedWire + ", got " + item.wire);
    }
  }

  const allowSet = new Set(rpcAllowlist);
  for (const m of allowSet) {
    if (!byMethod.has(m)) errors.push("Missing RPC_METHOD_ALLOWLIST method in compat-contracts.json: " + m);
  }
  for (const m of byMethod.keys()) {
    if (!allowSet.has(m)) errors.push("Extra method in compat-contracts.json not in RPC_METHOD_ALLOWLIST: " + m);
  }

  for (const probe of hostProbes) {
    const entry = byMethod.get(probe.id);
    if (!entry) {
      errors.push("HOST_PROBES entry missing in contracts: " + probe.id);
      continue;
    }
    if (entry.probeMode === "static-only") {
      errors.push("HOST_PROBES entry cannot be static-only: " + probe.id);
    }
    if (stableJson(entry.params ?? {}) !== stableJson(probe.params ?? {})) {
      errors.push("Probe params mismatch for " + probe.id);
    }
  }

  const contractSettings = contracts?.settingsAllowlist ?? {};
  if (stableJson(contractSettings) !== stableJson(settingsAllowlist)) {
    errors.push("settingsAllowlist in compat-contracts.json does not match SETTINGS_WRITE_ALLOWLIST");
  }

  const reqServices = contracts?.services?.required ?? {};
  if (!Array.isArray(reqServices.webServer) || !Array.isArray(reqServices.typertGateway)) {
    errors.push("services.required must declare webServer and typertGateway");
  }

  return { ok: errors.length === 0, rpcCount: byMethod.size, probeCount: hostProbes.length, errors };
}

function classifyProbeError(error) {
  if (isMissingRemoteError(error)) return "missing";
  const code = typeof error?.code === "string" ? error.code : "";
  const msg = String(error?.message ?? "");
  if (code === "TIMEOUT" || code.startsWith("http/5") || /timed out|aborted|ECONNREFUSED|ECONNRESET|peer[- ]disposed/i.test(msg)) {
    return "unknown";
  }
  return "supported";
}

export async function runLiveProbe({ contracts, call, timeoutMs = PROBE_TIMEOUT_MS }) {
  const active = (contracts?.rpcMethods ?? []).filter(
    (entry) => entry.probeMode === "readonly" || entry.probeMode === "not-found",
  );
  const results = [];
  for (const entry of active) {
    let status = "supported";
    let detail = "ok";
    let timer;
    try {
      const callPromise = Promise.resolve().then(() => call(entry.method, entry.params ?? {}));
      const timeoutPromise = new Promise((_, reject) => {
        timer = setTimeout(() => {
          const err = new Error("probe timeout");
          err.code = "TIMEOUT";
          reject(err);
        }, timeoutMs);
        timer.unref?.();
      });
      await Promise.race([callPromise, timeoutPromise]);
    } catch (error) {
      status = classifyProbeError(error);
      detail = error?.code || error?.message || "error";
    } finally {
      clearTimeout(timer);
    }
    results.push({ method: entry.method, tier: entry.tier || "optional", probeMode: entry.probeMode, status, detail: String(detail) });
  }

  const requiredMissing = results.filter((r) => r.tier === "required" && r.status === "missing");
  const optionalMissing = results.filter((r) => r.tier !== "required" && r.status === "missing");
  const unknown = results.filter((r) => r.status === "unknown");
  let verdict = "PASS";
  if (requiredMissing.length > 0) verdict = "BROKEN";
  else if (optionalMissing.length > 0 || unknown.length > 0) verdict = "DEGRADED";

  return {
    verdict,
    checked: results.length,
    supported: results.filter((r) => r.status === "supported").length,
    missing: results.filter((r) => r.status === "missing").map((r) => r.method),
    unknown: unknown.map((r) => r.method),
    results,
  };
}

function makeHttpCaller(baseUrl) {
  const parsed = new URL(baseUrl);
  return (method, params) => new Promise((resolvePromise, reject) => {
    const wire = method === "workspace.list" ? "workspace/list" : wireEndpoint(method);
    if (!wire) return reject(new Error("Unknown wire endpoint for " + method));
    const body = Buffer.from(JSON.stringify({
      type: "client-request",
      rpcId: "probe-" + randomBytes(6).toString("hex"),
      method: wire,
      payload: { args: params ?? {} },
    }));
    const req = httpRequest({
      host: parsed.hostname,
      port: Number(parsed.port) || 80,
      path: "/api/" + wire,
      method: "POST",
      headers: {
        host: parsed.host,
        origin: parsed.origin,
        "content-type": "application/json",
        "content-length": String(body.length),
        connection: "close",
      },
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        if ((res.statusCode ?? 0) >= 500) {
          const err = new Error("http/" + res.statusCode);
          err.code = "http/" + res.statusCode;
          return reject(err);
        }
        let frame;
        try { frame = JSON.parse(raw); } catch {}
        if (frame?.error) {
          const err = new Error(frame.error.message || frame.error.code || "rpc error");
          err.code = frame.error.code;
          return reject(err);
        }
        resolvePromise(frame);
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function main() {
  const args = process.argv.slice(2);
  const isStatic = args.includes("--static");
  const isJson = args.includes("--json");
  const urlIdx = args.indexOf("--url");
  const urlArg = urlIdx >= 0 ? args[urlIdx + 1] : (args.find((a) => a.startsWith("--url="))?.slice(6) ?? "");
  const rootDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const contracts = JSON.parse(readFileSync(join(rootDir, "spec", "compat-contracts.json"), "utf8"));
  const indexSource = readFileSync(join(rootDir, "src", "index.js"), "utf8");
  const settingsAllowlist = extractSettingsAllowlistFromSource(indexSource);

  if (isStatic || !urlArg) {
    const staticRes = validateStaticContracts({
      contracts,
      rpcAllowlist: RPC_METHOD_ALLOWLIST,
      hostProbes: HOST_PROBES,
      settingsAllowlist,
    });
    if (isJson) console.log(JSON.stringify(staticRes, null, 2));
    else if (staticRes.ok) console.log("OK: static compat contracts verified (" + staticRes.rpcCount + " RPCs, " + staticRes.probeCount + " active probes)");
    else for (const e of staticRes.errors) console.error("ERROR: " + e);
    if (!staticRes.ok) process.exit(1);
    if (isStatic || !urlArg) return;
  }

  const report = await runLiveProbe({ contracts, call: makeHttpCaller(urlArg) });
  if (isJson) console.log(JSON.stringify(report, null, 2));
  else {
    console.log("Host probe verdict: " + report.verdict + " (" + report.supported + "/" + report.checked + " supported)");
    for (const r of report.results) console.log("  [" + r.status + "] " + r.method + " (" + r.tier + "): " + r.detail);
  }
  if (report.verdict === "BROKEN") process.exit(1);
}

const entryArg = process.argv[1] ? realpathSync(resolve(process.argv[1])) : "";
const selfPath = realpathSync(fileURLToPath(import.meta.url));
if (entryArg === selfPath) {
  await main();
}
