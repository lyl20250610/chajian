# dsh-ui-video-background

给 **DSH（DeepSeek Harness）** 的界面铺一段本地视频当动态背景，并把面板做成**液态玻璃**（backdrop-blur + 高光边缘）。纯宿主插件：零依赖、不进客户端模块图，亮/暗主题自动适配，改配置**刷新即生效**。

English below.

## 安装

```sh
# Web profile（dsh 启动的 GUI）
dsh plugin --profile web add git+https://github.com/lyl20250610/chajian.git

# 桌面版：在 设置 → 插件 里安装
# （CLI 对 desktop profile 有防呆，会拒绝直接写桌面端 profile）
```

> 国内网络到 github.com 不通时，可用镜像：`git+https://ghproxy.net/https://github.com/lyl20250610/chajian.git`。
> 注意要带 `git+` 前缀，否则 pnpm 会把镜像 URL 当 tarball 抓。

安装/升级后**重启 DSH**（bundle 在进程启动时装配；部分宿主版本会热装配，重启总没错），客户端页面按 **Ctrl+Shift+R** 硬刷新。

## 配置

文件在 `~/.dsh/ui-video-background/config.json`（首次加载自动生成默认值）。改完按 Ctrl+Shift+R 即可，**不用重启**（开关 `enabled` 除外）：

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关。关掉 = 什么都不注入。⚠️ 改回 `true` 需要重启 DSH（注入行在启动时烘焙） |
| `video` | `null` | 视频绝对路径（正斜杠）；`null` 用包内 `assets/background.mp4`。支持 mp4/webm/mov/ogv/mkv |
| `opacity` | `0.85` | 视频自身不透明度（0–1） |
| `blur` | `0` | 视频整体虚化像素（0–12）。会额外建层叠上下文，一般用 `glass` 就够 |
| `surfaceAlpha` | `0.68` | 主面板保留的不透明度（0.15–1）。调低视频更明显，调高文字更清楚 |
| `sidebarAlpha` | `0.74` | 左侧栏同上 |
| `glass` | `24` | 液态玻璃的 backdrop-blur 半径（0–48 px）；`0` = 纯半透明无玻璃 |

## 原理（30 秒版）

1. **透明化**：DSH 整套调色板声明在 `body` 上（暗色是 `body[data-ds-dark-theme]`），所有面板从 `--dsw-alias-bg-*` 别名令牌取色。插件用 `color-mix(in srgb, var(--dsw-static-neutral-*) A%, transparent) !important` 重定义这几个别名——引用 static 原色所以不循环，`!important` 是因为应用声明在同一元素上且注入位置靠前。tooltip / toast / 菜单 / 代码块刻意保持不透明，保证可读性。
2. **视频层**：`<head>` 解析期挂一个 `position:fixed; z-index:-1` 的 `<video muted loop autoplay playsinline>`。负 z-index 排在面板背景之前绘制，所以必须配合第 1 步才看得见。同源路由 `/dsh-ui-video-background/video` 流式供片，支持 Range（206/416）——`<video>` 会 seek。
3. **液态玻璃**：面板背景色来自 CSS 变量（哈希类名不可靠），所以不能按类名挂 `backdrop-filter`，改成**结构化打标**：脚本扫描「够大（≥160×90）+ 计算背景半透明 + 自己没带 backdrop-filter + 祖先未打霜」的 `div/aside/section/main`，挂上玻璃类——`blur(glass) saturate(150%)`（沿用应用菜单自己的配方 `--dsw-menu-backdrop-filter`）+ 1px 内发光 rim + 发丝描边 + 顶部 sheen 渐变，亮/暗主题各有边缘色。菜单本来就带原生玻璃，天然跳过；DOM 变动由 MutationObserver 防抖补扫。
4. **实时配置**：`buildStyle` 是纯函数，源码经 `.toString()` 序列化进注入脚本，宿主侧和页面侧共用同一份。页面加载时 fetch `/dsh-ui-video-background/config`，用一个更晚插入的 `<style id="dsh-uivb-live">` 覆盖烘焙样式（同为 `!important`，后来者胜）→ 刷新即生效。

## 排查

- 背景没变：确认重启过 DSH、并按了 Ctrl+Shift+R；`curl http://127.0.0.1:<port>/dsh-ui-video-background/config` 看宿主是否活着、`serving` 是否指向真实文件。
- 文字看不清：`surfaceAlpha` / `sidebarAlpha` 调高（0.8–0.9），或 `opacity` 调低。
- 想要更「玻璃」：`glass` 调高（32–40），`surfaceAlpha` 调低。
- 完全还原：`enabled: false` + 重启，或卸载：`dsh plugin --profile web remove dsh-ui-video-background`。

## 关于 `assets/background.mp4`

那只是一个**示例素材**，为了让新装的用户立刻看到效果。它**不在本仓库 MIT 授权的范围内**，请视为「仅供本地试用」；fork 或二次分发前删掉它，换成你自己有权利的素材：

```sh
git rm assets/background.mp4
```

## 兼容性

- `dsh >= 0.2.0-rc.1`；在 desktop（Electron）与 web profile 上都实测过。
- 依赖 Chromium 的 `color-mix(in srgb, …, transparent)` 与 `backdrop-filter`（DSH 自带运行时均支持）。

## 许可

代码与文档 MIT（见 LICENSE）；示例视频除外，见上节。

---

## English

A DSH (DeepSeek Harness) plugin that puts a local video behind the app UI and turns the panels into **liquid glass** (backdrop blur + specular edges). Host-only: zero dependencies, nothing joins the client module graph, light/dark themes adapt automatically, and config changes apply on a plain refresh (no restart, except the `enabled` kill-switch).

Install: `dsh plugin --profile web add git+https://github.com/lyl20250610/chajian.git`, restart DSH, hard-refresh (Ctrl+Shift+R). Desktop app: install via Settings → Plugins (the CLI refuses to write the desktop profile). In mainland China a mirror works with the `git+` prefix kept: `git+https://ghproxy.net/https://github.com/lyl20250610/chajian.git`.

Config at `~/.dsh/ui-video-background/config.json`: `enabled`; `video` (absolute path, `null` = bundled sample); `opacity` (video itself, 0.85); `blur` (video blur, 0); `surfaceAlpha` 0.68 / `sidebarAlpha` 0.74 — how much solid panel colour survives (raise for crisper text, lower to show more video); `glass` 24 — backdrop-blur radius 0–48 px, 0 = plain translucency without the frosting.

How it works: the app declares its palette on `body` via alias tokens; the plugin redefines the big surface aliases as `color-mix(in srgb, <static token> A%, transparent) !important` (non-circular — it references the static palette; `!important` — the app declares on the same element). A `position:fixed; z-index:-1` video sits under the translucent panels, streamed same-origin with Range support. The frosting is applied structurally — the script tags large-enough elements whose computed background is translucent, with no own `backdrop-filter` and no tagged ancestor — so nothing depends on hashed class names, and menus (already native glass at `blur(40px) saturate(150%)`) are skipped. One pure `buildStyle` function is serialized into the page so host and client share a single source of truth; the page fetches the live config and overrides the baked style, hence refresh-only tuning.

`assets/background.mp4` is a trial sample only; it is not covered by the MIT license. Delete it before redistributing.
