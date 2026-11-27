# 技术债与暂缓需求清单（Debt Backlog）

> 记录当前刻意暂缓的高成本或低紧迫度方向，以及触发重启评估的具体信号（替代 `MAINTENANCE.md §12` 的散落列表）。

| 编号 | 方向 | 为什么暂缓 | 触发重开的信号 | 参考文档 |
| --- | --- | --- | --- | --- |
| **A2** | 设备凭证与会话 TTL（90 天 / 8 小时自动过期与轮换） | 需插件 + Android 双端改动刷新、401 续签与旧客户端兼容过渡期，当前个人/内测场景无多人托管需求 | 开放公网多用户使用，或开始对外分发给非本人设备时 | `docs/proposals/001-device-token-expiry-rotation.md` |
| **A3** | 第二台手机零信任接入（电脑 PIN + 已配对手机扫码授权） | 依赖新配对流转与 UI，现有一对一单人使用配合局域网确认已足够 | 需要高频授权多台手机/平板，或希望彻底移除电脑端扫码入口时 | `docs/MAINTENANCE.md` |
| **A4** | 短期一次性文件下载票据（替代 URL query token） | 当前文件预览走 `Authorization` Header，仅少数系统 Intent 场景受限；A1+A5 优先级更高 | 发现第三方浏览器/系统播放器泄露完整请求 URL 日志或需要外链分享时 | `SECURITY.md` |
| **B1** | 跨平台一键安装脚本（`install.sh` / `install.ps1`） | 目前主维护者与内测用户均以源码 `link:` 或手动挂载为主，缺少公开发布通道 | 准备向社区公开发布稳定版，需降低零基础用户安装门槛时 | `README.md` |
| **B2** | npm 正式发布与版本自动化 | 当前依赖未稳定冻结，仍处于 `0.1.0-beta.*` 快速迭代期 | 插件接口进入 RC / 1.0 稳定期，需要 `npm install dsh-links` 直接安装时 | `RELEASING.md` |
| **B3** | 终端直接打印 ASCII 二维码与配对码（无 GUI/SSH 场景） | 当前主要使用 DSH 桌面端与内置设置面板 | 出现纯 headless Linux 服务器托管 DSH 且无桌面浏览器可开时 | `README.md` |
| **C2** | Android 首页滑动待办处理台（左拒右批手势） | 涉及首页大面积手势交互与截图基线变更，且与 A5 高危二次确认需错开视觉设计 | 完成 A5 并在 `docs/redesign-v4/design-v4.html` 补齐设计稿后再立项 | `docs/redesign-v4/PLAN.md` |
| **C5** | 手机端消息语音朗读（TTS） | 属于锦上添花功能，对核心编程/审批效率提升有限 | 移动语音交互成为高频诉求时 | — |
| **C6** | 大会话增量快照 / 游标增量同步 | 当前历史分页 + SSE 游标补发在常规会话下性能充足 | 长会话（>1000 轮）手机打开出现明显 JSON 解析卡顿或流量过高时 | `docs/MOBILE_SYNC_CONTRACT.md` |
| **E1** | 自建 Relay Docker 一键镜像与部署脚本 | 官方测试中继已够用，当前仅 Go 源码自编译 | 需要大量用户自部署私有 `dlp-relay` 实例时 | `relay/README.md` |
| **E2** | Tailscale / 局域网增强直连引导 | 当前 `lan-address.js` 已可识别 Tailnet 地址并正常打分选路 | 大规模出现双端跨网段 NAT 无法直连且不想走公网中继时 | `REMOTE_ACCESS.md` |
