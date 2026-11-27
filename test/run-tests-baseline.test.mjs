import assert from "node:assert/strict";
import test from "node:test";
import { classifyResults, parseArgs, parseTapOutput } from "../scripts/run-tests.mjs";

test("parseTapOutput extracts leaf failures and ignores subtestsFailed wrapper", () => {
  const tap = [
    "TAP version 13",
    "# Subtest: outer suite",
    "    # Subtest: inner leaf fail",
    "    not ok 1 - inner leaf fail",
    "      ---",
    "      failureType: 'testCodeFailure'",
    "      ...",
    "    1..1",
    "not ok 1 - outer suite",
    "  ---",
    "  failureType: 'subtestsFailed'",
    "  ...",
    "ok 2 - passing test",
    "1..2",
    "# tests 3",
    "# pass 1",
    "# fail 2",
  ].join("\n");

  const parsed = parseTapOutput(tap);
  assert.equal(parsed.tests, 3);
  assert.equal(parsed.pass, 1);
  assert.equal(parsed.fail, 2);
  assert.deepEqual(parsed.failedNames, ["inner leaf fail"]);
});

test("classifyResults exits 0 when failures match baseline exactly", () => {
  const summary = classifyResults({
    fileResults: [{ file: "test/auth.test.mjs", exitCode: 1, pass: 50, failedNames: ["chmod check"] }],
    baselineEntries: [{ file: "test/auth.test.mjs", testName: "chmod check", reason: "win32 posix mode" }],
    strict: false,
  });
  assert.equal(summary.exitCode, 0);
  assert.equal(summary.expectedFailed.length, 1);
  assert.equal(summary.unexpectedFailed.length, 0);
  assert.equal(summary.newlyPassing.length, 0);
});

test("classifyResults exits 1 on unexpected failure or process crash", () => {
  const failCase = classifyResults({
    fileResults: [{ file: "test/auth.test.mjs", exitCode: 1, pass: 49, failedNames: ["new regression"] }],
    baselineEntries: [{ file: "test/auth.test.mjs", testName: "chmod check", reason: "win32" }],
    strict: false,
  });
  assert.equal(failCase.exitCode, 1);
  assert.equal(failCase.unexpectedFailed.length, 1);
  assert.equal(failCase.newlyPassing.length, 1);

  const crashCase = classifyResults({
    fileResults: [{ file: "test/broken.test.mjs", exitCode: 1, pass: 0, failedNames: [] }],
    baselineEntries: [],
    strict: false,
  });
  assert.equal(crashCase.exitCode, 1);
  assert.deepEqual(crashCase.unexpectedFailed, [{ file: "test/broken.test.mjs", testName: "process-exit-1" }]);
});

test("classifyResults flags stale baseline entries as newlyPassing and ignores unexecuted files", () => {
  const summary = classifyResults({
    fileResults: [{ file: "test/auth.test.mjs", exitCode: 0, pass: 51, failedNames: [] }],
    baselineEntries: [
      { file: "test/auth.test.mjs", testName: "chmod check", reason: "win32" },
      { file: "test/other.test.mjs", testName: "other fail", reason: "not run under filter" },
    ],
    strict: false,
  });
  assert.equal(summary.exitCode, 0);
  assert.equal(summary.newlyPassing.length, 1);
  assert.equal(summary.newlyPassing[0].testName, "chmod check");
});

test("strict mode treats baseline entries as unexpected failures", () => {
  const summary = classifyResults({
    fileResults: [{ file: "test/auth.test.mjs", exitCode: 1, pass: 50, failedNames: ["chmod check"] }],
    baselineEntries: [{ file: "test/auth.test.mjs", testName: "chmod check", reason: "win32" }],
    strict: true,
  });
  assert.equal(summary.exitCode, 1);
  assert.equal(summary.unexpectedFailed.length, 1);
  assert.equal(summary.newlyPassing.length, 0);
});

test("parseArgs defaults strict on non-win32 and parses flags", () => {
  assert.equal(parseArgs([], "linux").strict, true);
  assert.equal(parseArgs([], "win32").strict, false);
  assert.deepEqual(parseArgs(["--strict", "--json", "--filter", "auth"], "win32"), {
    filter: "auth",
    strict: true,
    json: true,
    baseline: "",
  });
});
