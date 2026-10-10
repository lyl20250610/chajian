# Changelog

## 0.1.0

- 初始版本。三个模块，全部走官方接缝、零 npm 依赖：
  - **记账**：`llm/stream` 瀑布纯观察（loop 请求深度冻结，只读不碰），每次调用记 JSONL（`usage.jsonl`，按大小滚动）；按官方 `TokenUsage` 口径折叠出总量/按模型/按会话，计费输入 = input + cacheRead + cacheWrite；会话内 loop 调用计费输入跌破峰值 90% 时把差额记为节省估算并重置峰值。汇总快照写 `stats.json`，web profile 暴露 `GET /dsh-ai-token-saver/stats`。
  - **滚动摘要**：`turn/end` 后，会话距上次摘要累计计费 token 超 `digest.everyTokens`（默认 50k）时，发起一次一次性 `ctx.llm.stream()`（`RequestUserInput` 精确构造，purpose 留空），把「旧摘要 + 最近 loop 记录尾部」合并写入 `digests/<会话>.md`；只读已验证的内容块类型，未知形状跳过；摘要调用标记 `isLoop=false`，不污染会话统计/节省估算/摘要节奏。
  - **提前压缩提醒**：用 `ctx.llm.resolveModelInfo`（按路由缓存 10 分钟）取上下文窗口，压力 = 最近一次 loop 调用计费输入 ÷ 窗口；超 `pressure.ratio` 记入 stats 提醒；`pressure.autoCompact` 打开时在 `agent/pre-step` 调用**官方** `ctx.compaction.compactIfNeeded(agent, 'pressure', signal)`（与 compaction-basic 同一姿势，压不压由引擎决定），冷却 `cooldownMinutes`。
- 配置在 `~/.dsh/ai-token-saver/config.json`（首载生成、读入钳制、坏文件降级默认值）；`enabled=false` 时什么都不注册，与兄弟插件 dsh-ui-video-background 的开关语义一致。
- 明确不做的事：不改写冻结请求、不自研压缩引擎替换官方接缝、不向对话流注入任何内容。
