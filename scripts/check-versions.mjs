import { readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function checkVersions({ rootDir }) {
  const errors = [];
  const pkg = JSON.parse(readFileSync(join(rootDir, "package.json"), "utf8"));
  const pluginVersion = String(pkg.version ?? "").trim();
  const gradle = readFileSync(join(rootDir, "apps/android/app/build.gradle.kts"), "utf8");
  const vnMatch = /versionName\s*=\s*"([^"]+)"/.exec(gradle);
  const vcMatch = /versionCode\s*=\s*(\d+)/.exec(gradle);
  const appVersionName = vnMatch?.[1] ?? "";
  const appVersionCode = vcMatch?.[1] ?? "";
  if (!pluginVersion) errors.push("Missing package.json version");
  if (!appVersionName) errors.push("Missing Android versionName in build.gradle.kts");
  if (!appVersionCode) errors.push("Missing Android versionCode in build.gradle.kts");

  const compat = readFileSync(join(rootDir, "docs/COMPATIBILITY.md"), "utf8");
  const topSection = compat.split("## ")[1] ?? compat;
  if (pluginVersion && !topSection.includes(pluginVersion)) {
    errors.push("docs/COMPATIBILITY.md baseline table missing plugin version " + pluginVersion);
  }
  if (appVersionName && !topSection.includes(appVersionName)) {
    errors.push("docs/COMPATIBILITY.md baseline table missing Android versionName " + appVersionName);
  }
  if (appVersionCode && !topSection.includes("versionCode " + appVersionCode)) {
    errors.push("docs/COMPATIBILITY.md baseline table missing Android versionCode " + appVersionCode);
  }

  const capsSrc = readFileSync(join(rootDir, "src/protocol-caps.js"), "utf8");
  const compatKt = readFileSync(join(rootDir, "apps/android/app/src/main/java/dev/deeplinks/core/CompatCheck.kt"), "utf8");
  const minAppMatch = /MIN_COMPAT_APP_VERSION\s*=\s*"([^"]+)"/.exec(capsSrc);
  const minPluginMatch = /MIN_RECOMMENDED_PLUGIN_VERSION\s*=\s*"([^"]+)"/.exec(compatKt);
  return {
    ok: errors.length === 0,
    pluginVersion,
    appVersionName,
    appVersionCode,
    minCompatAppVersion: minAppMatch?.[1] ?? "",
    minRecommendedPluginVersion: minPluginMatch?.[1] ?? "",
    errors,
  };
}

function main() {
  const rootDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const res = checkVersions({ rootDir });
  console.log("Versions:", JSON.stringify({
    plugin: res.pluginVersion,
    android: res.appVersionName + " (" + res.appVersionCode + ")",
    minApp: res.minCompatAppVersion,
    minPlugin: res.minRecommendedPluginVersion,
  }));
  if (!res.ok) {
    for (const err of res.errors) console.error("ERROR: " + err);
    process.exit(1);
  }
  console.log("OK: version baselines verified");
}

const entryArg = process.argv[1] ? realpathSync(resolve(process.argv[1])) : "";
const selfPath = realpathSync(fileURLToPath(import.meta.url));
if (entryArg === selfPath) main();
