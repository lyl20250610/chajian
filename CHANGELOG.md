# Changelog

## 0.2.1

- 修复「看不见背景」的根因：半透明层会**相乘**（body 68% × 外层壳 68% × 列容器 68% ≈ 只剩 32% 视频），多层叠加后视频几乎被洗白。现在凡覆盖 ≥95% 视口且完全不透明的结构性容器（div/aside/section/main）运行时一律打 `.dsh-uivb-clear` 强制全透明，半透明令牌只留给真正的面板；按几何判定、不依赖哈希类名，应用升级后依然有效。
- `body` 自身也直接清零（原来靠令牌半透明，与外层壳相乘）。
- 新增覆盖 `--dsw-alias-bg-layer-3`（亮 bluish-00 / 暗 bluish-800），此前被漏掉的不透明层。
- 新增配置 `clearStructural`（默认 true；false = 退回 0.2.0 的纯令牌行为）。
- 新增一次性 DOM 诊断：页面加载后向 `POST /dsh-ui-video-background/diag` 上报一次各探针点的绘制链，写入 `$DSH_HOME/ui-video-background/diag.json`（只进本机，用于排查“到底谁盖住了视频”）。

## 0.2.0

- 液态玻璃：半透明面板获得 `backdrop-blur + saturate(150%)`（沿用应用自己菜单的配方）、1px 内发光边缘（rim）+ 发丝描边（hairline）、顶部高光渐变（sheen）；亮/暗主题各自的边缘色。
- 面板不透明度默认上调（`surfaceAlpha` 0.5 → 0.68，`sidebarAlpha` 0.62 → 0.74，`opacity` 0.9 → 0.85），文字更清楚；不喜欢可以用配置降回去。
- 改配置 **刷新即生效，不用重启**：页面加载时从 `/dsh-ui-video-background/config` 拉实时配置，用同一段 `buildStyle`（源码序列化进注入脚本，两端共用一份）覆盖烘焙样式。
- 配置新增 `glass`（玻璃模糊半径 0–48，默认 24；0 = 纯半透明无玻璃）。
- 打霜判定是结构化的：只给「够大 + 背景半透明 + 自己没有 backdrop-filter + 祖先未打霜」的 div/aside/section/main 挂类，天然绕开已经带 `blur(40px) saturate(150%)` 的菜单，也不碰小控件。
- 开源发布：MIT（代码），示例视频见 README 版权说明；补 LICENSE / CHANGELOG / 双语 README。

## 0.1.0

- 初始版本：宿主注入 `style` + `script` 两行，铺一段本地视频当界面背景。
- `color-mix` 重定义大面板别名令牌（`--dsw-alias-bg-base/layer-1/layer-2`、`--dsw-specific-sidebar-fill`）为半透明，引用 static 原色不循环，亮/暗双主题。
- 宿主路由流式提供视频，支持 Range（206/416）；配置缺失或视频不存在时什么都不注入。
