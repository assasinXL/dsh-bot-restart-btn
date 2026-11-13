# dsh-bot-restart-btn

DS Bot 界面右下角的一枚圆形扁平化按钮，点一下就能重启 DSH——应用会自行关闭并重新打开，界面口随之变化。

![预览](docs/preview.svg)

- **座位**：注册在 `shell.overlay`，固定在视口右下角（`right/bottom: 20px`，含安全区适配），不随列滚动，也不占别人的位置。
- **外观**：直径 36px 的正圆，直接沿用 DS Bot 左下角设置 / 插件按钮（`.bt-you`）的配方——底色 `color-mix(in srgb, var(--bt-ink) 5%, var(--bt-sidebar))`、内描边 `inset 0 0 0 1px var(--bt-line)`、图标色 `--bt-ink-2`、15px 线性「重载」箭头（描边视觉粗细对齐 DS Bot 的 20 格 1.6px 图标）；悬停填充提到 9% 并把图标提亮到 `--bt-ink`，按下缩到 0.94，键盘聚焦显示 `--bt-accent` 光圈。
- **确认卡**：`--bt-glass-*` 玻璃层（12px 圆角、背板模糊、`--bt-glass-shadow`），按钮是 999px 胶囊。不额外加投影，保持扁平。配色全部走 DS Bot / DSH 主题变量，深浅色自动跟随。
- **交互**：点按钮 → 确认卡（取消 / 重启）→ 重启。有任务在跑时不会硬重启，而是给出「取消 / 等空闲后重启 / 强制重启」；等待模式可以取消等待。派发后按钮转圈并显示「正在重启…」，30 秒后补一句「若 30 秒内没有重新打开，请手动启动应用」。Esc、点卡片外、再点一次按钮都会收起。

## 安装

插件是标准的 DSH bundle（`package.json` 带 `dsh.bundle.patch` 与 `dsh.client`）。

```bash
git clone https://github.com/assasinXL/dsh-bot-restart-btn.git
```

然后在 DSH 里安装这个目录，重启应用生效：

- Agent 会话里：`plugin_manager` → `install_bundle`，`target` 填本目录的绝对路径；
- 或者手动把它链进 profile 的 `node_modules` 并在 profile `package.json` 写依赖（等价于上面的安装动作）。

装好后 profile 里会多出条目 `include:dsh-bot-restart-btn`，关掉它按钮就消失。

## 实现

重启链路自带，不依赖别的插件。宿主半边 `index.js` + `lib/`（移植自 [dsh-restart-now](https://www.npmjs.com/package/dsh-restart-now) 1.3.0，MIT，原作者 Mr54233，见 [NOTICE](NOTICE)）注册：

| 路由 | 作用 |
| --- | --- |
| `GET /plugins/dsh-bot-restart-btn/environment` | 探测：环境、平台、生效配置、版本、上次回执 |
| `POST /plugins/dsh-bot-restart-btn/restart` | `?force=1` 强制、`?wait=1` 等空闲、`?cancel=1` 取消等待、`?dry=1` 自检 |
| `GET /plugins/dsh-bot-restart-btn/status` | 等待模式快照 |
| `GET` / `POST /plugins/dsh-bot-restart-btn/config` | 配置读写 |

派发流程：写助手脚本 → 用应用自身 exe 以 `ELECTRON_RUN_AS_NODE` detached 拉起 → 等 ack（800ms 内没 ack 就什么都不杀）→ 只结束 Electron 主进程（不带 `/T`），让宿主优雅退出 → 重新拉起 → 验证监听。Windows 与 macOS 同构。

守卫顺序：总开关 → 桌面环境 → 平台 → 同源围栏 → 平台会话鉴权 → 安装锁 → 活跃任务（可 force / wait）→ 冷却。

## 配置与回执

- 配置：`<profile>/restart-button.config.json`，字段 `allowRestart`、`confirm`、`exePath`、`platformAuth`。
- 回执：`<profile>/restart-button.last.json`，依次写入 `at / hostPid / mainPid / helperPid / respawnedAt / newPid / downtimeMs`。回执在派发前就要落盘（那一刻还没有助手 pid），`helperPid` 在 ack 到达后回填；失败时记 `failed.reason`。
- 探活：拉起后用 HTTP 探测新实例的界面口，日志形如 `web_listen=ok http wait=… port=<界面口>`；4 秒内没有 HTTP 应答时退回「进程树里有人在 LISTEN」的 TCP 判据（`ok tcp`）。只观测、不因此判失败。
- 自检：`POST /plugins/dsh-bot-restart-btn/restart?dry=1` 跑完全部门禁与助手脚本生成，但不派发、不写回执、不占冷却。它同样要过平台会话鉴权，只能在应用窗口内（同源页面）调用。

## 范围与限制

- 只支持桌面应用（win32 / darwin）。浏览器里打开 Web 界面时环境探测失败，按钮不出现。
- 不提供「退出应用」。
- 重启会中断正在运行的任务，所以默认要过一道确认；这是设计取舍，不是缺陷。

## 许可

MIT，见 [LICENSE](LICENSE)。`lib/` 中移植自 dsh-restart-now 的部分同样为 MIT，署名见 [NOTICE](NOTICE)。
