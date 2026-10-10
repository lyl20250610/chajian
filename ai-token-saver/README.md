# dsh-ai-token-saver

给 **DSH（DeepSeek Harness）** 装上 token 记账、滚动 AI 会话摘要与提前压缩提醒。纯宿主插件：**零依赖、只读不冻结请求、不改写历史**，长会话花的每一分 token 都有账可查，新会话可以带几行摘要上阵、而不是重放几十轮历史。

English below.

## 它解决什么

DSH 自带一套省 token 的机制（`compaction-basic` 压力压缩、spill 溢出外置、tool-result 裁剪、token-meter 重放计量），但它们都是「事后」或「内部」的：你看不到每次调用实际花了多少、缓存省了多少；压缩也只在自己的阈值到了才动。本插件补三件事：

1. **记账（meter）**：在 `llm/stream` 瀑布上做**纯观察**——每次模型调用（对话、压缩、摘要一律）记下 provider / 模型 / 用途 / 提示词估算 / 真实用量。token 数按官方 `TokenUsage` 的口径拆开：`inputTokens` 是**未命中缓存**的输入，计费输入 = input + cacheRead + cacheWrite，缓存命中单独成列，你的缓存到底帮你省了多少一目了然。
2. **滚动摘要（digest）**：每个 turn 结束后，若本会话累计计费 token 超过 `digest.everyTokens`（默认 50k），发起**一次**一次性调用，把「旧摘要 + 最近对话记录」合并成一份紧凑摘要，写在 `~/.dsh/ai-token-saver/digests/<会话>.md`。开新会话时把这份摘要贴进第一条消息，就是几十轮历史的高压缩替代品。
3. **提前压缩提醒（nudge）**：按模型的上下文窗口（`ctx.llm.resolveModelInfo`，与官方压缩引擎同源）计算压力 = 最近一次调用的计费输入 ÷ 窗口。超过 `pressure.ratio`（默认 0.6）时记一条提醒；`pressure.autoCompact` 打开后，会在下一个 `agent/pre-step` 把会话交给**官方**引擎 `ctx.compaction.compactIfNeeded(agent, 'pressure', signal)`——我们不自研压缩器，只是比它自己的阈值更早地问一句，压不压仍由引擎决定。

## 安装

本仓库同时承载多个插件，本插件在子目录 `ai-token-saver/` 里：

```sh
# Web profile（dsh 启动的 GUI）——pnpm 的 git 子目录语法
dsh plugin --profile web add "git+https://github.com/lyl20250610/chajian.git#path:ai-token-saver"

# 国内网络到 github.com 不通时，可用镜像（注意保留 git+ 前缀）：
dsh plugin --profile web add "git+https://ghproxy.net/https://github.com/lyl20250610/chajian.git#path:ai-token-saver"

# 或者本地装（把仓库 clone / 下载解压到任意目录后）：
dsh plugin --profile web add file:/path/to/chajian/ai-token-saver
```

桌面版（Electron）：桌面 profile 同样挂 `@deepseek-ai/dsh-web-app`（有 `webServer`，stats 路由可用），插件代码无需任何改动，差别只在**安装方式**——CLI 对 desktop profile 有防呆（拒绝直接写），且桌面 profile 没有 `patchReload: live`，装完必须重启应用：

- **推荐**：应用内 **设置 → 插件** 安装，规格填 `git+https://github.com/lyl20250610/chajian.git#path:ai-token-saver`，或本地路径（`file:`/`link:` 均可，如打包好的 tgz）。
- **手动**（等效于 GUI，适合脚本化）：**先完全退出应用（含托盘）**，再对 `~/.dsh/profiles/desktop` 依次执行 `pnpm add <tgz|git规格>`、把 `dsh-ai-token-saver` 追加进 `package.json` 的 `dsh.profile.bundles` 数组——应用运行中不要动 profile（它退出时可能回写 package.json，改动会被吞掉）。
- 兼容性预检用的 `dsh.engines.dsh` 范围（`>=0.2.0-rc.1`）与运行时（0.2.0-rc.2 实测）匹配；若宿主更旧触发预检拦截，用 `dsh plugin --profile desktop allow-version ... --accept-risk` 显式豁免。

> `#path:` 是 pnpm 的 git 子目录规格；若你的宿主版本对 git URL 的处理不支持它，用 `file:` 本地路径安装是保底方案（插件管理器明确支持 `file:`/`link:`）。

## 配置

文件在 `~/.dsh/ai-token-saver/config.json`（首次加载自动生成默认值，读入时逐项钳制；文件坏了按默认值降级，绝不拖垮宿主）。**改配置需要重启 DSH**（与兄弟插件 `enabled` 开关的语义一致）：

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关。`false` 时什么都不注册（重启后生效） |
| `ledger.enabled` | `true` | 记账开关。关掉后 `llm/stream` 直接放行，摘要也失去数据来源 |
| `ledger.maxFileBytes` | `4194304` | `usage.jsonl` 单文件上限，超过滚动为 `.1`（只保留一代） |
| `ledger.recentCalls` | `50` | stats 里保留的最近调用条数（5–500） |
| `digest.enabled` | `true` | 滚动摘要开关 |
| `digest.everyTokens` | `50000` | 距上次摘要累计计费 token 超过该值才再摘要（摘要调用本身 ≈1k token，默认值保证它划算） |
| `digest.maxSourceChars` | `16000` | 送入摘要的对话记录字符上限（取最近的一段） |
| `digest.maxOutputChars` | `1200` | 摘要正文的长度上限（同时写进提示词） |
| `digest.maxTokens` | `800` | 摘要调用的 `maxTokens` |
| `digest.temperature` | `0.2` | 摘要调用温度 |
| `digest.keepLast` | `12` | 最多保留多少个会话的摘要文件，超出删最旧的 |
| `digest.provider` / `digest.model` | `""` | 摘要用哪个模型；空 = 复用该会话最近一次对话用的路由 |
| `pressure.ratio` | `0.6` | 压力 = 最近一次调用的计费输入 ÷ 上下文窗口，超过才提醒 |
| `pressure.autoCompact` | `false` | **默认关**。打开后压力超阈值会在下一 step 前提前调用官方压缩引擎 |
| `pressure.cooldownMinutes` | `15` | 提醒/触发 的冷却间隔 |

## 数据落在哪

| 文件 | 内容 |
|---|---|
| `~/.dsh/ai-token-saver/config.json` | 配置（首次自动生成） |
| `~/.dsh/ai-token-saver/usage.jsonl` | 每次调用一行 JSON（provider/model/purpose/sessionId/提示词估算/用量/错误），重启不丢 |
| `~/.dsh/ai-token-saver/stats.json` | 汇总快照：总量、按模型、按会话、节省估算、提醒、摘要索引、最近调用 |
| `~/.dsh/ai-token-saver/digests/<会话>.md` | 每个会话一份滚动摘要（Markdown） |

Web profile 下还有同源路由 **`GET /dsh-ai-token-saver/stats`** 返回同一份汇总（`cache-control: no-store`），方便脚本或面板直接取。

## 原理（30 秒版）

1. **为什么不能改请求**：agent 循环的每次请求都是从持久的会话日志重建的，在 `llm/stream` 瀑布上以 `markAgentLoopRequest` 身份**深度冻结**（改写即抛错）——这是官方设计，保证可重建性。所以本插件对该瀑布只做三件事：读 `options`、放行 `next()`、从 chunk 里读 `usage`。省 token 的正确入口是会话日志本身，也就是官方的 compaction 接缝——这正是 nudge 走的路。
2. **记账口径**：`TokenUsage` 的三个输入计数**互斥**（`inputTokens` 未命中 / `cacheRead` 读缓存 / `cacheWrite` 写缓存），计费输入是三者之和；`cacheRead` 大头说明你的钱主要花在缓存外的那一小圈——这就是「透明化」的价值。节省估算：会话内某次 loop 调用的计费输入比此前峰值低 10% 以上，差额记为节省（几乎必然是压缩把一段历史换成了摘要节点），随后重置峰值。**这是估算**，不含缓存与价格差异。
3. **摘要源头**：loop 请求是会话日志的纯函数，所以「最近一次 loop 请求的 messages」就是当前完整上下文。提取时只读已验证的块类型（text / tool-call），未知形状一律跳过不猜；工具参数与工具结果硬截断——它们是体积不是要点。摘要调用带 `isLoop=false` 标记，不污染会话统计、节省估算与摘要节奏。
4. **nudge 时机**：压力在每次调用结束后异步计算（窗口按 `provider|model` 缓存 10 分钟），超阈值只置一个 `nudgePending` 标志；真正的调用发生在 `agent/pre-step` 瀑布里（那里才有官方引擎需要的 `agent` 与 `signal`），压完才放行 `next()`，与 compaction-basic 自己的 pre-step 监听同一姿势。

## 排查

- **stats 路由 404**：web profile 才有 `webServer`；无头 profile 只看 `~/.dsh/ai-token-saver/stats.json`。
- **没有生成摘要**：`digest.enabled`、`digest.everyTokens`（新会话要攒够 50k 默认阈值）、以及 `digest.provider/model` 为空时要求该会话至少有过一次 loop 调用（日志里有每次摘要的结果与原因）。
- **提醒不出现**：`pressure.ratio` 之外还有 `cooldownMinutes` 冷却；`autoCompact` 默认关，提醒只进 stats 不进聊天流——本插件刻意不往对话里塞任何内容。
- **`usage.jsonl` 太大**：调低 `ledger.maxFileBytes`，或把 `ledger.enabled` 关掉（记账与摘要一起停）。
- **想完全还原**：`enabled: false` + 重启，或卸载：`dsh plugin --profile web remove dsh-ai-token-saver`。

## 边界与诚实声明

- 节省 token 的是**官方压缩引擎 + 你复用摘要**这两件事；本插件做的是计量透明化、跨会话摘要的自动化、以及更早地推动官方压缩。它不替换、不模拟、不绕过任何官方机制。
- 摘要会调用一次模型（成本可见于账本），阈值默认 50k 就是为了让这笔开销稳赚。
- `promptTokensEst` 是 chars/4 的粗估，仅供相对比较；精确数字永远以 `usage` 为准。

## 兼容性

- `dsh >= 0.2.0-rc.1`；Node ≥ 20；零 npm 依赖（宿主提供 `llm`，`compaction`/`webServer` 缺席时自动降级）。
- 与仓库内 `dsh-ui-video-background` 完全独立，可单独安装/卸载。

## 许可

MIT（见仓库根 LICENSE）。

---

## English

A DSH (DeepSeek Harness) plugin for token **metering**, a rolling **AI session digest**, and an early **compaction nudge**. Host-only: zero dependencies, strictly read-only around the frozen agent-loop requests, never rewrites history.

DSH already ships compaction (pressure/overflow), spill, tool-result pruning, and a replay token meter — all reactive or internal. This plugin adds: (1) a `llm/stream` pass-through meter that records every model call's real usage under the official `TokenUsage` semantics (billed input = input + cacheRead + cacheWrite), per session/model, with a peak-drop savings estimate; (2) after each turn, one hand-built one-shot `ctx.llm.stream()` call that merges the previous digest with the tail of the latest loop transcript into `~/.dsh/ai-token-saver/digests/<session>.md` — a new session carries a dozen lines instead of replaying dozens of turns; (3) per-call pressure (latest billed input ÷ context window via `ctx.llm.resolveModelInfo`) with a recorded advisory and an opt-in `agent/pre-step` nudge that asks the OFFICIAL engine — `ctx.compaction.compactIfNeeded(agent, 'pressure', signal)` — to compact earlier than its own threshold would. It never reimplements compaction; the engine still decides.

Install (the plugin lives in the `ai-token-saver/` subdirectory of the repo): `dsh plugin --profile web add "git+https://github.com/lyl20250610/chajian.git#path:ai-token-saver"` (pnpm git-subdir spec), or from a local checkout `dsh plugin --profile web add file:/path/to/chajian/ai-token-saver`; desktop via Settings → Plugins. Restart DSH after install. A mainland mirror works with the `git+` prefix kept.

Config at `~/.dsh/ai-token-saver/config.json` (seeded, clamped, degrade-to-defaults): `enabled`; `ledger.enabled/maxFileBytes/recentCalls` (JSONL per call, rotated); `digest.enabled/everyTokens(50k)/maxSourceChars/maxOutputChars/maxTokens/temperature/keepLast/provider/model` (empty = reuse the session's own route); `pressure.ratio(0.6)/autoCompact(false)/cooldownMinutes(15)`. Aggregate snapshot at `stats.json` and a same-origin `GET /dsh-ai-token-saver/stats` route on web profiles.

How it works: loop requests are derived from the durable session log and arrive deep-frozen at `llm/stream` (mutation throws by design), so the meter only reads `options` and the `usage` chunk. The digest source is the latest loop request's messages — a pure function of the session log — read defensively (verified block types only, unknown shapes skipped). The digest's own call is marked non-loop and cannot pollute session stats, savings, or cadence. Savings estimate: a loop call billing ≥10% below the session peak credits the drop (that is what compaction bought), then re-bases. The nudge fires inside `agent/pre-step` — where the official `agent`/`signal` live — and only when `autoCompact` is on.

Honest boundaries: the actual savings come from the official compaction engine plus you reusing the digest; this plugin adds transparency, an automated cross-session digest, and an earlier trigger. The digest costs one model call (visible in the ledger); the 50k default threshold keeps it profitable. `promptTokensEst` is a chars/4 rough estimate for relative comparison only — exact numbers always come from `usage`.

Requires `dsh >= 0.2.0-rc.1`, Node ≥ 20. Independent of the sibling `dsh-ui-video-background`; install or remove either alone. MIT (repo root LICENSE).

Desktop (Electron): the desktop profile also mounts `@deepseek-ai/dsh-web-app` (so `webServer` and the stats route exist) and the plugin code needs no changes there — only the install path differs. The CLI refuses to write the desktop profile by design, and desktop has no `patchReload: live`, so a full app restart (tray included) is required. Recommended: install via in-app Settings → Plugins with the `git+...#path:ai-token-saver` spec or a local `file:`/`link:` path. Manual/scripted equivalent: fully quit the app first, then `pnpm add <tgz|spec>` inside `~/.dsh/profiles/desktop` and append `dsh-ai-token-saver` to `dsh.profile.bundles` — never edit the profile while the app runs, it may rewrite package.json on exit and swallow the change. Verified against runtime 0.2.0-rc.2; the `dsh.engines.dsh >= 0.2.0-rc.1` range passes preflight.
