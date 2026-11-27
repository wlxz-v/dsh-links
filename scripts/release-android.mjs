import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const EXPECTED_CERT_SHA256 = "38f71adf8b67d81042c99a3ec0dfdafb4303dd31e3fc491068ccd534cb482a47";

export function parseGradleVersionInfo(gradleText) {
  const vn = /versionName\s*=\s*"([^"]+)"/.exec(gradleText)?.[1] ?? "";
  const vc = /versionCode\s*=\s*(\d+)/.exec(gradleText)?.[1] ?? "";
  return { versionName: vn, versionCode: vc ? Number(vc) : 0 };
}

export function buildReleaseNotes({ versionName, versionCode, apkSha256, certSha256 }) {
  return [
    "## DeepLinks Android " + versionName + " (versionCode " + versionCode + ")",
    "",
    "- **APK SHA-256**: `" + (apkSha256 || "<pending>") + "`",
    "- **Signing Cert SHA-256**: `" + certSha256 + "`",
    "- **Min Android**: Android 8.0 (API 26)",
    "",
    "Verify after download:",
    "```bash",
    "apksigner verify --print-certs DeepLinks-" + versionName + ".apk",
    "```",
  ].join("\n");
}

function findApksigner() {
  for (const sdkRoot of ["D:/DSH/android-tools/sdk", "D:/DSH/android-sdk"]) {
    const btDir = join(sdkRoot, "build-tools");
    if (!existsSync(btDir)) continue;
    const versions = readdirSync(btDir).sort((a, b) => b.localeCompare(a));
    for (const v of versions) {
      for (const exe of ["apksigner.bat", "apksigner"]) {
        const p = join(btDir, v, exe);
        if (existsSync(p)) return p;
      }
    }
  }
  return "apksigner";
}

function sha256File(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function main() {
  const args = process.argv.slice(2);
  const execute = args.includes("--execute");
  const rootDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const gradleText = readFileSync(join(rootDir, "apps/android/app/build.gradle.kts"), "utf8");
  const { versionName, versionCode } = parseGradleVersionInfo(gradleText);
  if (!versionName || !versionCode) {
    console.error("ERROR: Could not read versionName/versionCode from build.gradle.kts");
    process.exit(1);
  }

  const apkPath = join(rootDir, "apps/android/app/build/outputs/apk/release/app-release.apk");
  const mappingPath = join(rootDir, "apps/android/app/build/outputs/mapping/release/mapping.txt");
  const outDir = resolve(rootDir, "../outputs");
  const mappingDir = join(outDir, "mappings");
  const outApkName = "DeepLinks-" + versionName + ".apk";
  const outApkPath = join(outDir, outApkName);
  const outShaPath = outApkPath + ".sha256";
  const outMappingPath = join(mappingDir, "DeepLinks-" + versionName + "-mapping.txt");
  const tag = "app-v" + versionName;

  const apkExists = existsSync(apkPath);
  const mappingExists = existsSync(mappingPath);
  const apkSha256 = apkExists ? sha256File(apkPath) : "";
  const notes = buildReleaseNotes({ versionName, versionCode, apkSha256, certSha256: EXPECTED_CERT_SHA256 });

  console.log("Mode:", execute ? "EXECUTE" : "DRY-RUN");
  console.log("Tag:", tag, "| versionCode:", versionCode);
  console.log("Signed APK:", apkPath, apkExists ? "[OK]" : "[MISSING]");
  console.log("R8 mapping:", mappingPath, mappingExists ? "[OK]" : "[MISSING]");
  console.log("Output APK:", outApkPath);
  console.log("Backup mapping (external, never committed):", outMappingPath);
  console.log("Release command:", "gh release create " + tag + " --prerelease --title " + tag);
  console.log("\n--- Release Notes Preview ---\n" + notes + "\n");

  if (!execute) return;
  if (!apkExists) {
    console.error("ERROR: Signed APK missing. Run ./gradlew :app:assembleRelease first.");
    process.exit(1);
  }
  const apksigner = findApksigner();
  const certOut = execFileSync(apksigner, ["verify", "--print-certs", apkPath], { encoding: "utf8" });
  if (!certOut.toLowerCase().replace(/:/g, "").includes(EXPECTED_CERT_SHA256)) {
    console.error("ERROR: APK signing certificate SHA-256 mismatch!\n" + certOut);
    process.exit(1);
  }
  mkdirSync(outDir, { recursive: true });
  mkdirSync(mappingDir, { recursive: true });
  copyFileSync(apkPath, outApkPath);
  writeFileSync(outShaPath, apkSha256 + "  " + outApkName + "\n");
  if (mappingExists) copyFileSync(mappingPath, outMappingPath);
  execFileSync("gh", ["release", "create", tag, "--prerelease", "--title", tag, "--notes", notes, outApkPath, outShaPath], {
    cwd: rootDir,
    stdio: "inherit",
  });
}

const entryArg = process.argv[1] ? realpathSync(resolve(process.argv[1])) : "";
const selfPath = realpathSync(fileURLToPath(import.meta.url));
if (entryArg === selfPath) main();
