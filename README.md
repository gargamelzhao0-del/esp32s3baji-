# agent-monitor — universal agent observability

One plugin, every major agent client. Real-time local-only dashboard: activity banner, fine-grained status matrix, agent/model identity, event stream, token & tool stats, state-transition history (thinking / responding / tools / edits / compaction / permissions / retries).

All servers bind **127.0.0.1 only**. No data leaves the machine. Zero runtime dependencies (Node >= 22).

## 零基础用户（最简单，推荐）

1. 下载本仓库 ZIP（GitHub 页面 **Code → Download ZIP**），解压。
2. 双击 **`一键安装.bat`**。它会自动检测你装了哪些客户端并全部装好，然后打开「大屏导航」页。
3. 重启你的客户端；ChatGPT/Codex 用户在 **设置 > Hooks** 点「信任」。
4. 随便发一条消息，在导航页点对应按钮即可看到实时监控。

> 需要本机有 Node.js 22+（安装器会自动找；没有会提示去 nodejs.org 下载 LTS，一路下一步）。全程不用敲命令。

## Supported platforms

| Platform | Mechanism | Dashboard |
|---|---|---|
| ChatGPT / Codex desktop | Agent Plugins + lifecycle hooks | http://127.0.0.1:17894 |
| Codex CLI | same package + hooks | http://127.0.0.1:17894 |
| Claude Code | same package + hooks (`.claude-plugin`) | http://127.0.0.1:17892 |
| WorkBuddy (Tencent) | same package + hooks (`.codebuddy-plugin`) | http://127.0.0.1:17896 |
| DeepSeek Harness | native Cordis plugin (`dsh-plugins/`) | http://127.0.0.1:17893 |
| opencode / Nuwax | native plugin (`opencode-plugin/`) | http://127.0.0.1:17890 |

The hooks-based package `plugins/agent-monitor` is a single portable [Agent Plugins](https://agent-plugins.org) bundle that auto-detects the host (ChatGPT/Codex vs Claude Code vs WorkBuddy) and picks the right port. It carries `plugin.json`, `.codex-plugin/plugin.json`, `.claude-plugin/plugin.json` and `.codebuddy-plugin/plugin.json` so every host recognises it. Host detection uses the plugin-root env var each client sets (`PLUGIN_ROOT` → ChatGPT/Codex, `CLAUDE_PLUGIN_ROOT` → Claude, `CODEBUDDY_PLUGIN_ROOT` → WorkBuddy).

## Install

### ChatGPT / Codex desktop (UI)
1. Plugins → **添加** → **添加插件市场**.
2. Source: `gargamelzhao0-del/esp32s3baji-` (Git ref `main`, sparse path optional).
3. Install **Agent Monitor** from the marketplace.
4. **Settings > Hooks** → review & trust the hooks (required security step).
5. Send any message → open http://127.0.0.1:17894.

### CLI (any platform)
```bash
node install.mjs --platform chatgpt     # ChatGPT / Codex desktop + CLI
node install.mjs --platform claude      # Claude Code
node install.mjs --platform workbuddy   # WorkBuddy (one-click file registration)
node install.mjs --platform dsh         # DeepSeek Harness (prints pnpm spec)
node install.mjs --platform opencode --project DIR
node install.mjs --platform all
```
Offline / local checkout: add `--local /path/to/this/repo`.

Equivalent native commands:
```bash
codex plugin marketplace add gargamelzhao0-del/esp32s3baji-
codex plugin add agent-monitor@agent-monitor

claude plugin marketplace add gargamelzhao0-del/esp32s3baji-
claude plugin install agent-monitor@agent-monitor
```

### WorkBuddy (one-click)
```bash
node install.mjs --platform workbuddy            # registers marketplace + plugin into ~/.workbuddy-ai
# or: node install-workbuddy.mjs [--wb-home DIR]
```
Then **restart WorkBuddy**. Hooks load automatically (`defaultEnabled`); the dashboard auto-starts on the first event → http://127.0.0.1:17896. Registry backups (`.bak-*`) are kept.

### DeepSeek Harness (pnpm)
```bash
pnpm add "github:gargamelzhao0-del/esp32s3baji-#main&path:/dsh-plugins/agent-monitor-dsh"
```

## After install
Hooks must be **reviewed and trusted** once (ChatGPT/Codex: Settings > Hooks or `/hooks`; Claude Code loads plugin hooks on session start). The bundled server auto-starts on the first hook event.

## Layout
```
plugins/agent-monitor/        universal hooks plugin (ChatGPT/Codex/Claude)
dsh-plugins/agent-monitor-dsh/ DeepSeek Harness Cordis plugin
opencode-plugin/agent-status.js opencode/Nuwax plugin
.agents/plugins/marketplace.json   ChatGPT/Codex marketplace
.claude-plugin/marketplace.json    Claude Code marketplace
.codebuddy-plugin/marketplace.json WorkBuddy marketplace
install.mjs                   universal installer
install-workbuddy.mjs         WorkBuddy one-click file registration
```