# 维护手册（MAINTENANCE）

> 面向后续维护者：一页看清仓库状态、构建/测试配方、关键契约与已知坑位。
> 本文件只记录**可复现的事实与决策原因**，不写进度流水账；改动请随代码一起提交。

---

## 1. 一页速览

| 项 | 值 |
| --- | --- |
| 仓库 | `D:/DSH/dsh-links`（本地） / `https://github.com/wlxz-v/dsh-links`（远端） |
| 来源 | 分叉自原作者 **lunaship** 的 `dsh-links`（MIT）；原仓库已下架，本项目为社区分支 |
| 分支 / 当前基线 | `main` = `6503f17`（2026-11-27 全绿） |
| 插件版本 | `package.json` → `0.1.0-beta.20`（注意：Android `versionName` 是 `0.5.0-beta.27`，两者独立演进） |
| 三端 | 插件（Node ESM，`src/`）+ Android（Kotlin/Compose，`apps/android`）+ Go 中继（`relay/`） |
| 主要门禁 | `ci.yml`（Node 单测 + Go race + DLP/1 e2e）、`ci-android.yml`（ktlint + 864 单测 + 截图基线 + R8 + 模拟器冒烟） |
| 运行方式 | 作为 DSH 插件以 `link:` 挂到 profile，重启 DSH 客户端生效 |

判定「改动没问题」的最低标准（缺一不可）：

1. 插件：`npm run prepack` 通过（当前 414 项）。
2. Android：`gradlew :app:assembleDebug :app:testDebugUnitTest :app:lintDebug` 通过（当前 864 项单测）。
3. 涉及 `relay/`：`go build ./... && go vet ./... && go test ./...`。
4. 涉及协议字段（帧/快照/通知）：同步更新 `spec/protocol-vectors.json`，插件与 Android 两侧测试都要绿。

---

## 2. 环境准备

### 2.1 插件（Node）

- Node **≥ 20**（`package.json` 的 `engines`）。
- 依赖：`npm install --omit=dev --legacy-peer-deps --no-audit --no-fund`。
  - 本机 `pnpm install --offline` 会失败：`ERR_PNPM_NO_OFFLINE_META`（`@deepseek-ai/cordis` 不在 store），离线镜像也缺 `@linxin666/dsh-web-all@0.4.13`。**不要在这台机器上强推 pnpm**。
- 运行时依赖仅 `@deepseek-ai/schemastery`、`qrcode`、`selfsigned`、`ws`；`@deepseek-ai/cordis` 是 peer。

### 2.2 Android

固定工具链（这台机器的实际落点）：

| 组件 | 路径 / 版本 |
| --- | --- |
| JDK | `D:/DSH/android-tools/jdk-21.0.13`（Temurin 21，**必须是 21**：`kyant0/backdrop` 是 Java 21 字节码，17 会 `UnsupportedClassVersionError`） |
| Gradle | `D:/DSH/android-tools/gradle-9.5.0`（wrapper 要求 9.5.0-bin；`services.gradle.org` 会 307 到无法直连的 GitHub，腾讯镜像可用） |
| Android SDK | `D:/DSH/android-sdk`（平台包名是 **`platforms;android-37.0`**，不是 `android-37`；build-tools 37.0.0） |
| Gradle 用户目录 | `GRADLE_USER_HOME=D:\DSH\.gradle-home`（junction 到 `C:\Users\无界15X\.gradle`） |
| 临时目录 | `TEMP=TMP=D:\DSH\android-tools\tmp` |

关键环境变量的**存在原因**：

- `GRADLE_USER_HOME` 指到非中文路径：中文用户名会让测试 JVM 报
  `ClassNotFoundException: worker.org.gradle.process.internal.worker.GradleWorkerMain` / `管道正在被关闭`。
- `TEMP/TMP` 指到工作区外的可写目录：Gradle 默认临时目录落在受限沙箱里会 `AccessDeniedException`（`generateDebugGlobalSynthetics`、`compressDebugAssets`）。
- `ANDROID_USER_HOME` 指到 `D:\DSH\android-tools\android-home`：否则 `sdkmanager` 因非 ASCII 路径报 `AccessDeniedException ...\.android\cache\sdkbin-1_*`。

### 2.3 Go 中继

Go 1.25（`relay/go.mod`）；`relay/internal/dlp` 含 `FuzzParseControl`，CI 只跑 `go test -race ./...`。

---

## 3. 目录地图

```
dsh-links/
├─ src/                     插件运行时（42 个 ESM 模块，直接运行，无构建）
│  ├─ index.js              插件入口：apply、路由、SSE、审批/澄清钩子、状态持久化
│  ├─ mobile-api.js         手机 HTTP API（bootstrap、会话、待办、文件、工作区）
│  ├─ host-events.js        后台事件流（session/state 帧、游标补发、通知去重）
│  ├─ request-lifecycle.js  审批/澄清的待办登记、快照与结算
│  ├─ approval-detail.js    从 tool/call 回填审批命令原文
│  ├─ question-answers.js   澄清题校验与作答
│  ├─ protocol-caps.js      能力声明（capabilities）
│  ├─ host-probe.js         宿主能力探针（缺方法才降级）
│  ├─ local-rpc.js          笔记本机 RPC / 网关 Peer 调用
│  ├─ http-utils.js         json()、压缩协商、ETag/304、CORS/同源校验
│  ├─ lan-address.js        局域网地址打分、端口顺延探测
│  ├─ preview-proxy.js      本地预览反代（WebSocket/HTTP）
│  ├─ remote/               DLP/1 远程中继客户端（agent/runtime）
│  ├─ panel.js, client.js   设置面板与前端产物（client.js 由 build-client.mjs 生成）
│  └─ tls.js, atomic-fs.js  自签证书与原子落盘
├─ apps/android/            原生 Android 客户端（Compose Material 3）
│  └─ app/src/main/java/dev/deeplinks/{core,native,ui}
├─ relay/                   Go DLP/1 中继（hub/limits/wire/stats）
├─ spec/protocol-vectors.json  双端共读的协议形状（插件与 App 测试都读它）
├─ test/                    56 个 node:test 文件
├─ scripts/                 dlp1-e2e.mjs、build-android-debug.cmd、dev-isolated-host.mjs 等
├─ docs/                    架构、兼容性、同步契约、本手册
└─ .github/workflows/       ci.yml、ci-android.yml、regen-screenshots.yml
```

`src/` 分组（排查时的入口）：

| 领域 | 模块 |
| --- | --- |
| 入口与路由 | `index.js`、`panel.js`、`client.js`、`diagnostics.js` |
| 手机 API | `mobile-api.js`、`mobile-models.js`、`mobile-session-activity.js`、`mobile-session-control.js`、`mobile-session-summary.js`、`produced-files.js` |
| 待办与交互 | `request-lifecycle.js`、`awaiting-input.js`、`approval-detail.js`、`question-answers.js`、`question-bridge.js`、`workspace-approval.js` |
| 事件与历史 | `host-events.js`、`history.js`、`stream-cursor.js`、`session-log-path.js`、`session-log-reasoning.js` |
| 传输与安全 | `http-utils.js`、`tls.js`、`auth.js`、`atomic-fs.js`、`zstd-frames.js`、`device-mutation-gate.js` |
| 网络与预览 | `lan-address.js`、`preview-proxy.js`、`preview-detect.js`、`remote/` |
| 工作区与文件 | `workspace-path.js`、`workspace-file.js`、`workspace-changes.js`、`workspace-create.js` |
| 能力与限流 | `protocol-caps.js`、`host-probe.js`、`bounded-map.js`、`pricing.js` |

---

## 4. 安装 / 挂载到 DSH

插件以**本地源码仓**方式挂载（不发布也能改代码即生效，重启后加载）：

1. 在 profile 的 `package.json` 的 `dependencies` 里写 `"dsh-links": "link:D:/DSH/dsh-links"`；
   并把 `dsh-links` 放到 `dsh.profile.bundles` 里。
2. `node_modules/dsh-links` 用目录联接指向源码仓（Windows）：
   ```bat
   mklink /J "C:\Users\<user>\.dsh\profiles\<profile>\node_modules\dsh-links" "D:\DSH\dsh-links"
   ```
3. **重启 DSH 客户端**（bundle 类插件只在进程启动时加载）。
4. 验证：
   ```bash
   node -e "import('dsh-links').then(m => console.log(Object.keys(m).length))"   # 预期 26
   ```

当前两个 profile 都已挂载：

| profile | 依赖 | 备注 |
| --- | --- | --- |
| `desktop` | `link:D:/DSH/dsh-links` | 原为 tarball 安装，已切换 |
| `web` | `link:D:/DSH/dsh-links` | 旧 `v0.1.0-beta.19` 归档在 `node_modules/.dsh-links-old-0.1.0-beta.19`，`package.json.bak-20261127` |

> 改 `src/` 后必须重启 DSH 才生效；改 Android 需重新装 APK；改 `relay/` 需重启中继进程。

---

## 5. 常用命令

### 5.1 插件

```bash
cd D:/DSH/dsh-links

# 全量单测（注意：不要用 npm test 一把梭，见 6.1）
node --test --test-isolation=none --test-force-exit test/xxx.test.mjs

# 发布前门禁（构建 client.js + 414 项测试）
npm run prepack

# DLP/1 端到端（需要 relay 可起）
node scripts/dlp1-e2e.mjs
```

### 5.2 Android

```bash
cd D:/DSH/dsh-links/apps/android

JAVA_HOME=D:/DSH/android-tools/jdk-21.0.13
ANDROID_HOME=D:/DSH/android-sdk
ANDROID_SDK_ROOT=D:/DSH/android-sdk
GRADLE_USER_HOME=D:/DSH/.gradle-home
TEMP=TMP=D:/DSH/android-tools/tmp

./gradlew :app:assembleDebug :app:testDebugUnitTest :app:lintDebug
```

发布包（Release 不签名可用 `-PallowUnsignedRelease=true`）：

```bash
./gradlew :app:assembleDebug :app:assembleRelease -PallowUnsignedRelease=true --no-daemon
```

产物：

- `apps/android/app/build/outputs/apk/debug/app-debug.apk`
- `apps/android/app/build/outputs/apk/release/app-release-unsigned.apk`

### 5.3 Go 中继

```bash
cd D:/DSH/dsh-links/relay
go build ./... && go vet ./... && go test -race ./...
```

---

## 6. 测试与门禁

### 6.1 为什么必须「逐文件 + `--test-isolation=none`」

- 一次 `node --test test/*.mjs` 会挂：测试运行器要 spawn 子进程，本机沙箱报 `spawn EPERM`。
- 即使 `--test-isolation=none`，把**所有**文件塞进同一个进程也会互相污染（如 remote-plugin 的 5 个远程用例）。
- 正确姿势：**一个文件一次调用**，脚本化循环。

### 6.2 已知 Windows 环境失败（13 例，不是回归）

| 文件 | 原因 |
| --- | --- |
| `auth`、`workspace-create`、`workspace-path`、`workspace-tree` | symlink 需要特权 → 用 `"junction"` 类型 / 环境无权限，属预期 |
| `auth` | `chmod` 语义断言（Windows 无 POSIX 权限位） |
| `diagnostics` | `openssl` 不存在 → 改走 `selfsigned` |
| `plugin-package` | `npm` 不在 PATH → 用 `node_modules/npm/bin/npm-cli.js` |
| `session-log-path` | POSIX 分隔符断言 vs Windows 反斜杠 → 用 `path.join()` |

判断标准：失败集合**恰好等于**这 13 例 → 视为与改造前基线一致。

### 6.3 硬约束（违反会被 CI 抓）

- `CodeHygieneTest` 的函数体行数/文件行数基线**只能下调**，不许上调。
  - 注意它把**单表达式函数**（无花括号）量到「下一个行尾 `{`」，而 `object DshNotifier {` 正好在文件末尾 → 新增函数会连带把前面的函数判超预算。修法是合并进已有函数或写成块体。
- `DshSizeUsageTest` 守护裸 `dp` 使用：production 代码里裸尺寸只降不升（用 `fillMaxHeight(0.85f)` 这类相对值替代 `heightIn(max=640.dp)`）。
- Compose 截图基线只能由 `.github/workflows/regen-screenshots.yml` 在 ubuntu-latest 生成；开发机不许生成后提交。
- **绝不**对 release 变体跑 `connectedAndroidTest`（会卸载用户配对数据）。
- `src/preview-proxy.js` 的 `PREVIEW_BLACKLIST` 内容被测试精确断言，不要「顺手优化」。

---

## 7. 发布流程

1. 改版本号（插件 `package.json`；Android `app/build.gradle.kts` 的 `versionCode/versionName`）。
2. 更新 `CHANGELOG.md` 顶部「未发布（main）」。
3. 跑门禁：`npm run prepack` + Android 三连 + （涉及 relay）Go 测试。
4. 提交（本机身份固定）：
   ```bash
   git -c user.name=wlxz-v -c user.email=wlxz-v@users.noreply.github.com commit -am "feat: ..."
   ```
5. 推送（本机 SSH 必须显式指定 key，否则 `Host key verification failed`）：
   ```bash
   git -c core.sshCommand="ssh -o StrictHostKeyChecking=no -i C:/Users/无界15X/.ssh/id_ed25519" push origin main
   ```
6. 确认 CI：`gh run watch <id>`（`gh` 已登录；`gh repo create` 也可用）。
7. APK 产出后复制到 `D:/DSH/outputs/`，默认 `send_wechat` 推送给用户。

---

## 8. 关键运行时契约（改之前先读）

| 契约 | 实现要点 |
| --- | --- |
| **端口顺延** | `src/lan-address.js` 的 `findFreeListenPort(start, attempts)` 先用临时 net server 探测；`src/index.js` 再自愈重试绑定，成功后写 `portState`/`boundPort()`。所有对外 URL（pair-info、qr、lanUrls、preview、remote runtime）都必须读 `boundPort()`，**不要直接读 `config.port`**。 |
| **JSON 压缩 + ETag** | `src/http-utils.js`：按 `Accept-Encoding` 协商 `zstd/br/gzip`（>1KB），`jsonEtag(coding, body)` 用**压缩后字节**算弱 ETag；`304` 命中时跳过压缩、剥掉 `content-length`/`content-encoding`，保留 `etag`/`vary`。ETag 只给 GET/HEAD 且非 `no-store`。 |
| **后台事件流** | `src/host-events.js`：`session/state` 帧带 `notify`（重复终态 60s 内 `false`）、审批字段、澄清字段；游标补发支持 `Last-Event-ID` 与 `?since=<seq>`，缓冲不够回 `resync-required`。 |
| **双端审批** | `src/index.js` 的 `approval/request` 钩子：永远先建手机端 rec 再 `next()`；电脑端只有 `allowed-once`/`rejected` 算定案（`desktopApprovalDecided`）；手机离线时 30s 兜底（`APPROVAL_OFFLINE_GRACE_MS`）。 |
| **双端澄清** | `user-questions/request`：一律建 `rpcId = q-<hex>`；多题只发给声明 `multiQuestion` 的连接；`answerOnDesktop()` 只调一次 `next()`；答完补发 `event: question-resolved`。 |
| **审批详情** | 宿主 `approval/request` 不含参数；`src/approval-detail.js` 按同 `callId` 的 `tool/call` 回填 `detail`，history/快照/事件帧/通知四处都要带。 |
| **产出文件** | 上限 `BoundedIo.MAX_WORKSPACE_FILE_BYTES = 8 MiB`；PDF 用系统 `PdfRenderer` 前 5 页内置预览，其它交系统 Intent；插件 `MIME_TYPES` 负责补全 Office/zip/音视频。 |
| **宿主能力探针** | `src/host-probe.js`：只读调用探测，写接口用 `schedule.edit {id:"probe-missing"}` 的 not-found 探测；只有「方法缺失」判 `missing`，超时判 `unknown`，5 分钟 TTL。 |
| **能力声明** | `src/protocol-caps.js` 是唯一来源；`spec/protocol-vectors.json` 是双端共读的协议样本，改帧字段必须同时改两边测试。 |

---

## 9. 诊断与排障

### 9.1 诊断页

- 面板路径：`/dsh-link/diagnostics`（仅回环；在非回环端口上 404 是正常的）。
- 检查项：`host.rpc`、`host.services`、`host.probe`、`mobile.streams`、`plugin.version`、`tls`、`listen`。
- `detail` 里的字符串必须匹配 `ENUM_STRING = /^[A-Za-z0-9_.-]{1,32}$/`（冒号会被清洗掉）→ Remote 名（带点）不要放进 detail，viewers 用 `.` 连接。

### 9.2 常见现象

| 现象 | 判断方法 | 处置 |
| --- | --- | --- |
| `peerConnection:false / peerError:"no-connection"` | 启动早期快照，打一次 RPC 再看 | 正常；插件已加 `ensureGatewayPeer()` 重试 |
| 手机收不到审批/澄清 | 看诊断 `mobile.streams` 是否 LIVE | 手机端后台监控未连；确认 App 装在后台、权限允许 |
| 审批只剩两个按钮、没有命令 | 看 `detail`/`approvalDetail` 是否为空 | 宿主 history 里找不到同 `callId` 的 `tool/call`；检查 `session.history` 调用 |
| 远程会话 90 秒必断 | 看是否走中继 | Android `WebSocketTunnelSocketFactory` 应把 `gatewayPeer.soTimeout=0` |
| 手机一直走公网中继而非局域网 | `state.json` 里设备 `via:"remote"` | 防火墙入站规则（18640）需放行；排查手机 VPN/AP 隔离 |
| Windows 思考内容读不到 | 目录是否形如 `--C-Users-~65E0~754C15X--` | `src/session-log-path.js` 编码对齐宿主实现 |

### 9.3 本机排障专用

- **agy 沙箱内 `java.exe` 报 `STATUS_DLL_INIT_FAILED (-1073741502)`**：继承的 `DisallowWin32kSystemCalls` 限制；用 `Invoke-CimMethod Win32_Process Create` 起进程并读 `.exit` 文件。
- `java` 不在 PATH：必须写绝对路径 `D:/DSH/android-tools/jdk-21.0.13/bin/java.exe`。
- `cmd //c gradlew.bat` 在部分沙箱只打印横幅不执行：直接调 `java -classpath ...gradle-launcher-9.5.0.jar org.gradle.launcher.GradleMain`。
- PowerShell 经工具转发会丢嵌套引号/`$_`：复杂脚本写成 `.ps1` 或 `.mjs` 文件再执行。

---

## 10. 已知坑与禁忌

1. 不要上调 `CodeHygieneTest` 基线（只许下调）。
2. 不要动 `PREVIEW_BLACKLIST` 的内容（测试精确断言）。
3. 不要用 `npm test` / `node --test test/*.mjs` 跑全量（会挂，见 6.1）。
4. 不要在开发机生成并提交 Compose 截图基线。
5. 不要对 release 变体跑 connectedAndroidTest。
6. 不要直接读 `config.port` 构造对外地址（必须 `boundPort()`）。
7. 不要在 `detail` 里放带冒号/点的长字符串（会被 ENUM_STRING 清洗）。
8. 不要把单表达式函数追加到 `DshNotifier.kt` 顶部（会连带量到文件末尾超预算）。
9. `2c86839` 的教训：**只有 GET 能走条件请求**；写请求必须保留方法与 body，无 body 的 DELETE 要补 `Content-Type: application/json`（否则服务端 415）。
10. `state.json` 是全局共享（`~/.dsh/dsh-links/state.json`）：冒烟测试必须用 `stateDir` 隔离，**不要吊销用户设备**。

---

## 11. 提交历史（关键节点）

| 提交 | 内容 |
| --- | --- |
| `18c5ddb` | 上游 `0.1.0-beta.19` 快照 |
| `c906cd0` | DSH 0.2.x 网关 Peer 补丁 |
| `8111262` / `a7a840e` | 局域网地址打分 / 端口顺延 + 压缩协商 + notify 提示 |
| `f10ec98` / `90c5a39` | 双端审批（先答先算）/ Android 后台审批通知 |
| `f19ba19` / `e0f2e9c` | 审批详情（命令原文）插件 + Android |
| `9588406` | 产出文件手机可打开（PDF 预览 + 系统 Intent） |
| `c87856a` | 审批不再「手机没连着就只推电脑」 |
| `10a03a0` | 双端澄清：多题依次选择推到手机 |
| `2c86839` | B1 宿主探针 + B2 协议向量 + E2 断线补发 + D1 ETag |
| `6a96723` / `ce13dc0` | 全量梳理第一轮（含 2c86839 回归修复） |
| `392d507` | Android 首页列表与全局滚动性能 |
| `16e9ce8` / `6f5cedd` / `0c7eacc` | 插件 / Android / Go 中继三端深度硬化 |
| `fa07f07` … `6503f17` | CI 全绿修复链（ktlint、gradlew、e2e、首帧白屏、截图基线） |

---

## 12. 尚未做的方向（按价值排序）

1. **设备/会话有效期**：当前配对后永久有效；建议 90 天设备 TTL + 8 小时会话 TTL。
2. **管理路由 DNS-rebinding 防护**：面板/配对路由加「仅回环 + Host 白名单 + `Sec-Fetch-Site`」三重校验。
3. **第二台手机配对**：电脑面板设 PIN，已配对手机输入后出示一次性 QR。
4. **分发**：一键安装脚本 + npm 发布 + 插件市场索引。
5. **中继就近化**：外网场景自建更近 relay，或引导用户走 Tailscale。
