# dsh-links — AI 协作总入口与路由表（AGENTS）

> 面向所有模型与自动化代理的统一入口。动手前按「任务场景」先读对应文档，改完必跑对应门禁。

## 1. 不可违背的红线

1. **状态隔离**：`~/.dsh/dsh-links/state.json` 全局共享。所有测试与冒烟必须使用隔离 `stateDir`，严禁吊销用户真机（见 [`docs/pitfalls.md#state-dir-isolation`](docs/pitfalls.md#state-dir-isolation)）。
2. **官方宿主代码完整性**：绝不修改 DSH 宿主安装目录或第三方依赖原字节；所有宿主兼容绕过只写在 `dsh-links` 内。
3. **双端协议同步**：修改 `capabilities`、审批/澄清字段或文件传输头时，必须同步更新 `spec/protocol-vectors.json` 并通过插件 + Android 双侧测试。
4. **前端打包同步**：修改 `src/panel.js` 后必须执行 `node build-client.mjs` 并一并提交 `src/client.js`。
5. **Android 三禁**：`CodeHygieneTest` 与 `DshSizeUsageTest` 基线只降不升；禁止在 `DshNotifier.kt` 顶部加单表达式函数；禁止在开发机提交 Compose 截图基线；禁止对 release 变体跑 `connectedAndroidTest`。

## 2. 任务场景路由表

| 任务场景 | 先读文档 | 必跑门禁 |
| --- | --- | --- |
| **了解环境、路径与命令** | [`docs/MAINTENANCE.md`](docs/MAINTENANCE.md) | 按对应子系统 |
| **查踩坑与硬约束** | [`docs/pitfalls.md`](docs/pitfalls.md) | — |
| **改插件运行时 / HTTP / 面板** | [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)、[`docs/pitfalls.md#bound-port-not-config`](docs/pitfalls.md#bound-port-not-config) | `npm run prepack`（=`build-client` + `node scripts/run-tests.mjs`） |
| **改手机同步接口 / 协议字段** | [`docs/MOBILE_SYNC_CONTRACT.md`](docs/MOBILE_SYNC_CONTRACT.md)、[`spec/protocol-vectors.json`](spec/protocol-vectors.json) | 插件全量 + Android `testDebugUnitTest` |
| **改远程连接 / DLP/1 / 中继** | [`docs/rfc/0001-dlp1-remote-pipe.md`](docs/rfc/0001-dlp1-remote-pipe.md)、[`relay/README.md`](relay/README.md) | `cd relay && go vet ./... && go test -race ./...` + `npm run test:dlp1-e2e` |
| **改 Android 逻辑或 Compose UI** | [`apps/android/CLAUDE.md`](apps/android/CLAUDE.md)、[`apps/android/docs/visual-rules.md`](apps/android/docs/visual-rules.md)、[`docs/redesign-v4/design-v4.html`](docs/redesign-v4/design-v4.html)、[`docs/pitfalls.md#code-hygiene-dsh-notifier`](docs/pitfalls.md#code-hygiene-dsh-notifier) | `cd apps/android && ./gradlew :app:assembleDebug :app:testDebugUnitTest :app:lintDebug` |
| **改版本 / 兼容矩阵 / 发版** | [`docs/COMPATIBILITY.md`](docs/COMPATIBILITY.md)、[`RELEASING.md`](RELEASING.md) | 插件 + Android 三连 |
| **查看暂缓需求与技术债** | [`docs/debt-backlog.md`](docs/debt-backlog.md) | — |
