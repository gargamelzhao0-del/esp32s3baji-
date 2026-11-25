#!/usr/bin/env node
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { fileURLToPath } from "node:url"

const repoRoot = path.dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const opt = (n, d) => {
  const i = argv.indexOf(n)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d
}
const wbHome = opt("--wb-home", path.join(os.homedir(), ".workbuddy-ai"))
const pluginSrc = opt("--plugin-src", path.join(repoRoot, "plugins", "agent-monitor"))
const MARKET = "agent-monitor"
const PLUGIN = "agent-monitor"
const VERSION = JSON.parse(fs.readFileSync(path.join(pluginSrc, "plugin.json"), "utf8")).version || "1.2.0"

if (!fs.existsSync(path.join(wbHome, "plugins"))) {
  console.error("WorkBuddy home not found at " + wbHome + " — install/run WorkBuddy once first, or pass --wb-home")
  process.exit(1)
}

const pluginsDir = path.join(wbHome, "plugins")
const mktDir = path.join(pluginsDir, "marketplaces", MARKET)
const cacheDir = path.join(pluginsDir, "cache", MARKET, PLUGIN, VERSION)

fs.mkdirSync(path.join(mktDir, ".codebuddy-plugin"), { recursive: true })
fs.mkdirSync(path.join(mktDir, "plugins"), { recursive: true })
fs.cpSync(pluginSrc, path.join(mktDir, "plugins", PLUGIN), { recursive: true })
fs.cpSync(pluginSrc, cacheDir, { recursive: true })
fs.writeFileSync(path.join(mktDir, ".codebuddy-plugin", "marketplace.json"), JSON.stringify({
  name: MARKET,
  description: "Universal real-time agent observability dashboard (local only).",
  owner: { name: "gargamelzhao0-del" },
  metadata: { version: "1.0.0" },
  plugins: [{ name: PLUGIN, description: "Real-time agent activity dashboard on 127.0.0.1:17896.", source: "./plugins/" + PLUGIN, category: "productivity", version: VERSION }]
}, null, 2))

const now = new Date().toISOString()
const kmFile = path.join(pluginsDir, "known_marketplaces.json")
const ipFile = path.join(pluginsDir, "installed_plugins.json")
let km = {}, ip = { version: 2, plugins: {} }
try { km = JSON.parse(fs.readFileSync(kmFile, "utf8")) } catch {}
try { ip = JSON.parse(fs.readFileSync(ipFile, "utf8")) } catch {}
if (fs.existsSync(kmFile)) fs.copyFileSync(kmFile, kmFile + ".bak-" + Date.now())
if (fs.existsSync(ipFile)) fs.copyFileSync(ipFile, ipFile + ".bak-" + Date.now())

km[MARKET] = { manifestName: MARKET, type: "directory", source: { source: "directory", path: mktDir }, installLocation: mktDir, description: "Agent Monitor local marketplace", lastUpdated: now, autoUpdate: false }
ip.plugins = ip.plugins || {}
ip.plugins[PLUGIN + "@" + MARKET] = [{ scope: "user", installPath: cacheDir, version: VERSION, installedAt: now, lastUpdated: now }]

fs.writeFileSync(kmFile, JSON.stringify(km, null, 2))
fs.writeFileSync(ipFile, JSON.stringify(ip, null, 2))

console.log("WorkBuddy: agent-monitor installed (one-click file registration)")
console.log("  marketplace: " + mktDir)
console.log("  plugin cache: " + cacheDir)
console.log("  registry backups kept (.bak-*)")
console.log("\nNext: restart WorkBuddy. Hooks load from the plugin; dashboard auto-starts on first event.")
console.log("Dashboard: http://127.0.0.1:17896")