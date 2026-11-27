# 已知坑位与硬约束（Pitfalls）

> 从 `docs/MAINTENANCE.md` 拆出的稳定锚点手册。代码注释、PR 描述与 `AGENTS.md` 可直接通过 `#<anchor>` 引用。

---

## 测试与构建环境

<a id="windows-test-runner"></a>
### {#windows-test-runner} Windows 单测必须逐文件隔离运行

- 一次执行 `node --test test/*.mjs` 在受限 Windows 沙箱会因内部 spawn 子进程报 `spawn EPERM` 挂死。
- 即使传入 `--test-isolation=none`，把所有文件放进同一进程也会相互污染（例如 `remote-plugin.test.mjs`）。
- **正确做法**：统一使用 `npm test`（即 `node scripts/run-tests.mjs`），逐文件以 `--test-isolation=none --test-force-exit` 隔离执行；单文件调试用 `npm run test:file -- test/<name>.test.mjs`。

<a id="windows-test-env"></a>
### {#windows-test-env} Windows 沙箱环境差异（已适配基线）

以下四类曾造成 Windows 差异，仓库已按规范适配（由 `test/expected-windows-failures.json` 持续监控）：
- 目录符号链接在无特权 Windows 下使用 `"junction"`（`auth`、`workspace-create`、`workspace-path`、`workspace-tree`）。
- 证书生成走 `selfsigned` 而非系统 `openssl`（`diagnostics`、`remote-agent`）。
- `npm` CLI 定位使用 `node_modules/npm/bin/npm-cli.js`（`plugin-package`）。
- 路径断言使用 `path.join()` 兼容反斜杠（`session-log-path`）。

<a id="windows-gradle-non-ascii"></a>
### {#windows-gradle-non-ascii} Windows Android Gradle 必须使用非中文环境变量

- 中文用户名会导致测试 JVM 报 `ClassNotFoundException: worker.org.gradle.process.internal.worker.GradleWorkerMain` 或「管道正在被关闭」。
- 沙箱默认临时目录可能触发 `AccessDeniedException`（`generateDebugGlobalSynthetics`、`compressDebugAssets`）。
- **固定落点**：`JAVA_HOME=D:/DSH/android-tools/jdk-21.0.13`（必须 JDK 21，因 `kyant0/backdrop` 为 Java 21 字节码）、`GRADLE_USER_HOME=D:/DSH/.gradle-home`、`TEMP=TMP=D:/DSH/android-tools/tmp`、`ANDROID_USER_HOME=D:/DSH/android-tools/android-home`。

<a id="windows-sandbox-java"></a>
### {#windows-sandbox-java} Windows 沙箱内 java.exe / gradlew / PowerShell 踩坑

- 沙箱内 `java.exe` 遇 `STATUS_DLL_INIT_FAILED (-1073741502)` 为 `DisallowWin32kSystemCalls` 限制：改用 `Invoke-CimMethod Win32_Process Create` 拉起进程并读 `.exit` 文件。
- `java` 不在 PATH 时写绝对路径 `D:/DSH/android-tools/jdk-21.0.13/bin/java.exe`。
- `cmd //c gradlew.bat` 若只打横幅不执行，直接调 `java -classpath ...gradle-launcher-9.5.0.jar org.gradle.launcher.GradleMain`。
- PowerShell 经工具转发易丢失嵌套引号 / `$_`，复杂脚本写成 `.ps1` 或 `.mjs` 文件再执行。

---

## Android 门禁与 UI 红线

<a id="code-hygiene"></a>
<a id="code-hygiene-dsh-notifier"></a>
### {#code-hygiene-dsh-notifier} `CodeHygieneTest` 与 `DshNotifier.kt` 单表达式函数陷阱

- `apps/android` 的 `code-hygiene-baseline.txt` 与 `function-hygiene-baseline.txt` **只许下调，绝不上调**。大块新逻辑应拆到独立 `.kt` 文件。
- `CodeHygieneTest` 会把**无花括号的单表达式函数**一直量到下一个行尾 `{`。由于 `object DshNotifier {` 在文件末尾附近，在 `DshNotifier.kt` 顶部新增单表达式函数会连带将其后函数判为超预算。
- **修法**：使用 `{ ... }` 块体函数，或拆到独立新文件。

<a id="size-usage-dp"></a>
### {#size-usage-dp} `DshSizeUsageTest` 裸 `dp` 只降不升

- `size-baseline.txt` 守护生产代码中的裸 `dp` 使用（含零容忍项 `__touch_below_48__`）。
- 新增或修改 Compose UI 不得引入新的裸 `dp`，优先复用 `DshSpace` / `DshRowHeight` / `fillMaxWidth` / `fillMaxHeight` 等相对或语义值。

<a id="screenshot-baseline-ci-only"></a>
### {#screenshot-baseline-ci-only} Compose 截图基线只能在 Linux CI 生成

- 禁止在 Windows 开发机生成并提交 Compose 截图基线；必须通过 `.github/workflows/regen-screenshots.yml` 在 `ubuntu-latest` 生成后提交。

<a id="release-no-connected-test"></a>
### {#release-no-connected-test} 严禁对 release 变体跑 `connectedAndroidTest`

- AGP 设备测试收尾会卸载被测包，连同用户真机配对数据一起清掉。设备测试一律走 debug 变体（`applicationIdSuffix = ".debug"`）。

---

## 插件运行时与协议红线

<a id="state-dir-isolation"></a>
### {#state-dir-isolation} `state.json` 全局共享，测试/冒烟必须隔离 `stateDir`

- 默认 `~/.dsh/dsh-links/state.json` 跨 profile 全局共享。冒烟脚本与测试必须传入临时隔离 `stateDir`，**严禁调用设备吊销触碰真实用户设备**。

<a id="bound-port-not-config"></a>
### {#bound-port-not-config} 严禁直读 `config.port`，必须读 `boundPort()`

- `18640` 被占用时插件会顺延探测最多 8 个端口；构造配对 QR、LAN URL、预览护栏与 `pluginPort` 一律读实际 `boundPort()`。

<a id="preview-blacklist-frozen"></a>
### {#preview-blacklist-frozen} 严禁改动 `PREVIEW_BLACKLIST`

- `src/preview-proxy.js` 的 `PREVIEW_BLACKLIST` 内容被单测精确断言，不得擅自增删或重构。

<a id="detail-enum-string"></a>
### {#detail-enum-string} 诊断 `detail` 字段必须符合 `ENUM_STRING`

- `detail` 会被清洗，必须匹配 `/^[A-Za-z0-9_.-]{1,32}$/`；切勿在 `detail` 中放入带冒号或超长的字符串。

<a id="delete-content-type-415"></a>
### {#delete-content-type-415} HTTP 条件请求与无 body DELETE 415 教训

- 只有 `GET` / `HEAD`（且非 `no-store`）可走 `JsonConditionalGet` 条件请求（ETag / 304）。
- 写请求必须保留原方法与 body；无 body 的 `DELETE` 请求也必须补 `Content-Type: application/json`，否则服务端会返回 `415`。

<a id="client-bundle-sync"></a>
### {#client-bundle-sync} 修改 `src/panel.js` 后必须重建 `src/client.js`

- CI 会执行 `pnpm build:client && git diff --exit-code -- src/client.js`。改动面板前端后必须运行 `node build-client.mjs` 并一并提交。

---

## 宿主与网络常见现象

<a id="gateway-peer-so-timeout"></a>
### {#gateway-peer-so-timeout} 远程会话 90 秒断线与 `gateway/peer-disposed`

- 远程隧道需在 Android `WebSocketTunnelSocketFactory` 将隧道 peer 的 `soTimeout` 设为 `0`。
- DSH `0.2.x` 要求请求携带有效 `request.peer`；插件侧通过 `ensureGatewayPeer()` 创建并在遇 `gateway/peer-disposed` 时重建重试一次。

<a id="session-log-path-windows"></a>
### {#session-log-path-windows} Windows 会话日志路径编码差异

- Windows 下中文用户路径会编码成 `--C-Users-~65E0~754C15X--` 形式；由 `src/session-log-path.js` 与宿主对齐。
