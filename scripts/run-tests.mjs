import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function normalizeTestPath(filePath) {
  return String(filePath).replace(/\\/g, "/").replace(/^\.\//, "");
}

export function parseTapOutput(tapText) {
  const lines = String(tapText ?? "").split(/\r?\n/);
  let tests = 0;
  let pass = 0;
  let fail = 0;
  let skipped = 0;
  const failures = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const summaryMatch = /^# (tests|pass|fail|skipped) (\d+)\s*$/.exec(line);
    if (summaryMatch) {
      const count = Number(summaryMatch[2]);
      if (summaryMatch[1] === "tests") tests = count;
      else if (summaryMatch[1] === "pass") pass = count;
      else if (summaryMatch[1] === "fail") fail = count;
      else if (summaryMatch[1] === "skipped") skipped = count;
      continue;
    }
    const notOkMatch = /^(\s*)not ok \d+ - (.+?)\s*$/.exec(line);
    if (!notOkMatch) continue;
    const indent = notOkMatch[1].length;
    const rawName = notOkMatch[2].replace(/\s+#\s+(?:SKIP|TODO).*$/i, "").trim();
    let isSubtestsFailed = false;
    const nextLine = lines[i + 1] ?? "";
    if (/^\s*---\s*$/.test(nextLine)) {
      for (let j = i + 2; j < lines.length; j += 1) {
        if (/^\s*\.\.\.\s*$/.test(lines[j])) break;
        if (/^\s*failureType:\s*['"]?subtestsFailed['"]?\s*$/.test(lines[j])) {
          isSubtestsFailed = true;
        }
      }
    }
    failures.push({ indent, name: rawName, isSubtestsFailed });
  }

  const leafNames = failures.filter((f) => !f.isSubtestsFailed).map((f) => f.name);
  const failedNames = leafNames.length > 0 ? leafNames : failures.map((f) => f.name);
  return { tests, pass, fail, skipped, failedNames };
}

export function classifyResults({ fileResults, baselineEntries = [], strict = false }) {
  const executedFiles = new Set(fileResults.map((r) => normalizeTestPath(r.file)));
  const filteredBaseline = strict
    ? []
    : baselineEntries
        .map((b) => ({
          file: normalizeTestPath(b.file),
          testName: String(b.testName ?? ""),
          reason: String(b.reason ?? ""),
        }))
        .filter((b) => executedFiles.has(b.file));

  const baselineMap = new Map();
  for (const entry of filteredBaseline) {
    baselineMap.set(entry.file + "\0" + entry.testName, entry);
  }

  let passed = 0;
  const expectedFailed = [];
  const unexpectedFailed = [];
  const matchedKeys = new Set();

  for (const r of fileResults) {
    const file = normalizeTestPath(r.file);
    passed += Number(r.pass ?? 0);
    const failedNames = Array.isArray(r.failedNames) ? r.failedNames : [];
    for (const testName of failedNames) {
      const key = file + "\0" + testName;
      if (!strict && baselineMap.has(key)) {
        matchedKeys.add(key);
        expectedFailed.push({ file, testName, reason: baselineMap.get(key).reason });
      } else {
        unexpectedFailed.push({ file, testName });
      }
    }
    if ((r.exitCode !== 0 && failedNames.length === 0) || r.error) {
      unexpectedFailed.push({
        file,
        testName: r.error ? String(r.error) : "process-exit-" + String(r.exitCode),
      });
    }
  }

  const newlyPassing = filteredBaseline.filter((b) => !matchedKeys.has(b.file + "\0" + b.testName));
  return {
    totalFiles: fileResults.length,
    passed,
    expectedFailed,
    unexpectedFailed,
    newlyPassing,
    exitCode: unexpectedFailed.length > 0 ? 1 : 0,
  };
}

export function parseArgs(argv, platform = process.platform) {
  const opts = {
    filter: "",
    strict: platform !== "win32",
    json: false,
    baseline: "",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--strict") opts.strict = true;
    else if (arg === "--no-strict") opts.strict = false;
    else if (arg === "--json") opts.json = true;
    else if (arg === "--filter" && i + 1 < argv.length) opts.filter = argv[++i];
    else if (arg.startsWith("--filter=")) opts.filter = arg.slice("--filter=".length);
    else if (arg === "--baseline" && i + 1 < argv.length) opts.baseline = argv[++i];
    else if (arg.startsWith("--baseline=")) opts.baseline = arg.slice("--baseline=".length);
  }
  return opts;
}

function loadBaseline(baselinePath) {
  if (!existsSync(baselinePath)) return [];
  const parsed = JSON.parse(readFileSync(baselinePath, "utf8"));
  return Array.isArray(parsed?.entries) ? parsed.entries : [];
}

function main() {
  const rootDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const opts = parseArgs(process.argv.slice(2));
  const testDir = join(rootDir, "test");
  const allFiles = readdirSync(testDir)
    .filter((name) => name.endsWith(".mjs"))
    .sort((a, b) => a.localeCompare(b))
    .map((name) => "test/" + name);
  const selectedFiles = opts.filter
    ? allFiles.filter((f) => f.includes(opts.filter))
    : allFiles;

  const baselinePath = opts.baseline
    ? resolve(rootDir, opts.baseline)
    : join(testDir, "expected-windows-failures.json");
  const baselineEntries = loadBaseline(baselinePath);

  const fileResults = [];
  for (const relFile of selectedFiles) {
    const absFile = join(rootDir, relFile);
    const proc = spawnSync(
      process.execPath,
      ["--test", "--test-isolation=none", "--test-force-exit", "--test-reporter=tap", absFile],
      { cwd: rootDir, encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
    );
    const tapText = (proc.stdout ?? "") + (proc.stderr ? "\n" + proc.stderr : "");
    const parsed = parseTapOutput(tapText);
    const exitCode = proc.status ?? 1;
    const error = proc.error ? proc.error.message : undefined;
    fileResults.push({
      file: relFile,
      exitCode,
      tests: parsed.tests,
      pass: parsed.pass,
      fail: parsed.fail,
      failedNames: parsed.failedNames,
      error,
    });
    if (!opts.json) {
      const mark = exitCode === 0 && parsed.failedNames.length === 0 ? "PASS" : "FAIL";
      console.log("[" + mark + "] " + relFile + " (" + parsed.pass + "/" + parsed.tests + ")");
    }
  }

  const summary = classifyResults({ fileResults, baselineEntries, strict: opts.strict });
  if (opts.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log("");
    console.log("Summary: files=" + summary.totalFiles + " passed=" + summary.passed + " expectedFailed=" + summary.expectedFailed.length + " unexpectedFailed=" + summary.unexpectedFailed.length + " newlyPassing=" + summary.newlyPassing.length);
    if (summary.expectedFailed.length > 0) {
      console.log("Expected baseline failures:");
      for (const item of summary.expectedFailed) console.log("  - " + item.file + " :: " + item.testName + " (" + item.reason + ")");
    }
    if (summary.newlyPassing.length > 0) {
      console.log("Newly passing (can shrink baseline):");
      for (const item of summary.newlyPassing) console.log("  - " + item.file + " :: " + item.testName);
    }
    if (summary.unexpectedFailed.length > 0) {
      console.error("Unexpected failures:");
      for (const item of summary.unexpectedFailed) console.error("  - " + item.file + " :: " + item.testName);
    }
  }
  process.exit(summary.exitCode);
}

const entryArg = process.argv[1] ? realpathSync(resolve(process.argv[1])) : "";
const selfPath = realpathSync(fileURLToPath(import.meta.url));
if (entryArg === selfPath) {
  main();
}
