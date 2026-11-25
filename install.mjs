#!/usr/bin/env node
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const repoRoot = path.dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const opt = (n, d) => {
  const i = argv.indexOf(n)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d
}
const flag = (n) => argv.includes(n)
const REPO = opt("--repo", "gargamelzhao0-del/esp32s3baji-")
const MARKET = "agent-monitor"
const PLUGIN = "agent-monitor"
const local = opt("--local", null)
const source = local ? path.resolve(local) : REPO

const run = (cmd, args) => {
  console.log("> " + cmd + " " + args.join(" "))
  const r = spawnSync(cmd, args, { stdio: "inherit", shell: process.platform === "win32" })
  return r.status === 0
}

const has = (cmd) => {
  const r = spawnSync(process.platform === "win32" ? "where" : "which", [cmd], { stdio: "ignore", shell: process.platform === "win32" })
  return r.status === 0
}

const installCodex = () => {
  if (!has("codex")) return console.log("codex CLI not found; install ChatGPT/Codex desktop or codex CLI first")
  run("codex", ["plugin", "marketplace", "add", source])
  run("codex", ["plugin", "add", PLUGIN + "@" + MARKET])
  console.log("\nChatGPT/Codex: restart the desktop app, then review & trust hooks (Settings > Hooks, or /hooks in CLI).")
  console.log("Dashboard: http://127.0.0.1:17894")
}

const installClaude = () => {
  if (!has("claude")) return console.log("claude CLI not found; install Claude Code first")
  run("claude", ["plugin", "marketplace", "add", source])
  run("claude", ["plugin", "install", PLUGIN + "@" + MARKET])
  console.log("\nClaude Code: restart sessions; hooks load from the plugin. Dashboard: http://127.0.0.1:17892")
}

const installWorkbuddy = () => {
  const args = [path.join(repoRoot, "install-workbuddy.mjs")]
  const wb = opt("--wb-home", null)
  if (wb) args.push("--wb-home", wb)
  run(process.execPath, args)
}

const installDsh = () => {
  const spec = "github:" + REPO + "#main&path:/dsh-plugins/agent-monitor-dsh"
  console.log("DeepSeek Harness — install the native Cordis plugin via pnpm:")
  console.log("  pnpm add \"" + spec + "\"")
  console.log("or copy dsh-plugins/agent-monitor-dsh into your profile and mount its cordis.patch.yml.")
  console.log("Dashboard: http://127.0.0.1:17893")
}

const installOpencode = () => {
  const project = opt("--project", process.cwd())
  const dest = path.join(project, ".opencode", "plugin")
  fs.mkdirSync(dest, { recursive: true })
  fs.copyFileSync(path.join(repoRoot, "opencode-plugin", "agent-status.js"), path.join(dest, "agent-status.js"))
  console.log("opencode/Nuwax: installed -> " + path.join(dest, "agent-status.js"))
  console.log("restart the runtime; dashboard: http://127.0.0.1:17890")
}

const target = opt("--platform", argv[0] && !argv[0].startsWith("--") ? argv[0] : "auto")
if (target === "chatgpt" || target === "codex") installCodex()
else if (target === "claude" || target === "claude-code") installClaude()
else if (target === "dsh") installDsh()
else if (target === "workbuddy") installWorkbuddy()
else if (target === "opencode") installOpencode()
else if (target === "all") {
  installCodex()
  installClaude()
  installWorkbuddy()
  installDsh()
} else {
  console.log("agent-monitor — universal installer")
  console.log("usage: node install.mjs --platform <chatgpt|codex|claude|workbuddy|dsh|opencode|all> [--local REPO_ROOT] [--repo owner/repo] [--project DIR] [--wb-home DIR]")
  console.log("\nAuto-detected CLIs:")
  console.log("  codex:  " + (has("codex") ? "yes" : "no"))
  console.log("  claude: " + (has("claude") ? "yes" : "no"))
  console.log("\nOne repo, every platform. GitHub dialog source: " + REPO)
}