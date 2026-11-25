import fs from "node:fs"
import path from "node:path"
import http from "node:http"
import os from "node:os"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const argv = process.argv.slice(2)
const opt = (n, d) => {
  const i = argv.indexOf(n)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d
}

const harness = opt("--harness", process.env.PLUGIN_ROOT ? "chatgpt" : process.env.CLAUDE_PLUGIN_ROOT ? "claude-code" : "chatgpt")
const DEFAULT_PORT = { "chatgpt": 17894, "codex": 17891, "claude-code": 17892 }
const port = parseInt(process.env.AGENT_MONITOR_PORT || opt("--port", String(DEFAULT_PORT[harness] || 17894)), 10)
const url = process.env.AGENT_MONITOR_URL || opt("--url", "http://127.0.0.1:" + port + "/api/ingest")
const dataDir = process.env.AGENT_MONITOR_DATA_DIR || path.join(os.homedir(), ".agent-monitor", harness === "claude-code" ? "claude" : harness)

const dbg = (msg) => {
  try {
    fs.mkdirSync(dataDir, { recursive: true })
    const f = path.join(dataDir, "hook-debug.log")
    fs.appendFileSync(f, new Date().toISOString() + " " + msg + "\n")
    if (fs.statSync(f).size > 1048576) fs.writeFileSync(f, fs.readFileSync(f, "utf8").split("\n").slice(-200).join("\n"))
  } catch {}
}

const clip = (v, n) => {
  if (v === undefined || v === null) return undefined
  const s = typeof v === "string" ? v : JSON.stringify(v)
  if (typeof s !== "string") return undefined
  return s.length > n ? s.slice(0, n) + "...[truncated]" : s
}

const mapTokens = (u) => {
  if (!u) return { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 }, total: 0 }
  return {
    input: u.inputTokens || u.input_tokens || u.input || 0,
    output: u.outputTokens || u.output_tokens || u.output || 0,
    reasoning: u.reasoningTokens || u.reasoning_tokens || u.reasoning || (u.output_tokens_details && u.output_tokens_details.thinking_tokens) || 0,
    cache: { read: u.cacheReadTokens || u.cache_read_input_tokens || (u.cache && u.cache.read) || 0, write: u.cacheWriteTokens || u.cache_creation_input_tokens || (u.cache && u.cache.write) || 0 },
    total: u.totalTokens || u.total_tokens || u.total || 0,
  }
}

const waitUp = (tries) => new Promise((resolve) => {
  const req = http.get({ host: "127.0.0.1", port, path: "/api/state", timeout: 300 }, (res) => {
    res.resume()
    resolve()
  })
  const retry = () => {
    if (tries <= 0) return resolve()
    setTimeout(() => waitUp(tries - 1).then(resolve), 150)
  }
  req.on("error", retry)
  req.on("timeout", () => {
    req.destroy()
    retry()
  })
})

const ensureServer = () => new Promise((resolve) => {
  const req = http.get({ host: "127.0.0.1", port, path: "/api/state", timeout: 400 }, (res) => {
    res.resume()
    resolve()
  })
  const spawnIt = () => {
    try {
      const child = spawn(process.execPath, [path.join(root, "server", "server.mjs")], { env: { ...process.env, MONITOR_PORT: String(port), MONITOR_DATA_DIR: dataDir, MONITOR_DB: "none" }, stdio: "ignore", detached: true })
      child.unref()
      dbg("server spawned pid=" + child.pid)
    } catch (e) {
      dbg("spawn err " + (e && e.message))
    }
    waitUp(16).then(resolve)
  }
  req.on("error", spawnIt)
  req.on("timeout", () => {
    req.destroy()
    spawnIt()
  })
})

const readStdin = async () => {
  const chunks = []
  for await (const c of process.stdin) chunks.push(c)
  return Buffer.concat(chunks).toString("utf8")
}

const lastAssistant = (p) => {
  try {
    const lines = fs.readFileSync(p, "utf8").trim().split("\n").slice(-40)
    for (let i = lines.length - 1; i >= 0; i--) {
      let j
      try {
        j = JSON.parse(lines[i])
      } catch {
        continue
      }
      if (j.type === "assistant" && j.message) return j
    }
  } catch {}
  return null
}

const main = async () => {
  let h = {}
  try {
    h = JSON.parse(await readStdin())
  } catch {}
  const t = h.hook_event_name
  if (!t) return
  const ts = Date.now()
  const sid = h.session_id || h.sessionId || harness + "-main"
  const events = []
  const identity = { harness, agent: harness === "claude-code" ? "main" : "codex" }
  if (h.model) identity.modelID = h.model
  if (h.cwd) identity.directory = h.cwd
  let status = null
  const patch = (p) => {
    status = { ...(status || {}), ...p }
  }
  const ev = (kind, payload) => events.push({ kind, ...payload })

  if (t === "SessionStart") {
    ev("session.created", { title: clip(h.cwd || h.source || "session", 120) })
    patch({ status: "idle" })
  } else if (t === "UserPromptSubmit") {
    ev("session.status", { status: "busy" })
    patch({ status: "busy" })
  } else if (t === "PreToolUse") {
    const tool = h.tool_name || "tool"
    const callID = h.tool_use_id || "hook-" + ts
    ev("tool.start", { dedupe: "ts:" + callID, tool, callID, status: "running", title: tool, input: clip(h.tool_input, 2000) })
    patch({ status: "busy", currentTool: { tool, status: "running", title: tool, startedAt: ts } })
    const inp = h.tool_input || {}
    let file = inp.file_path || inp.path
    if (!file && typeof inp.command === "string") {
      const m = inp.command.match(/\*\*\* (?:Update|Add|Delete) File: (.+)/)
      if (m) file = m[1].trim()
    }
    if (file && /^(apply_patch|Edit|Write|MultiEdit|NotebookEdit)$/i.test(tool)) ev("file.edited", { file })
    if (tool === "Task" || tool === "Agent" || tool === "spawn_agent") ev("subtask", { agent: inp.subagent_type || inp.agent_type || "task", description: clip(inp.description, 200) })
  } else if (t === "PostToolUse") {
    const tool = h.tool_name || "tool"
    const r = h.tool_response
    const isErr = !!(r && typeof r === "object" && (r.error || r.isError || r.is_error || r.interrupted))
    ev("tool.end", { dedupe: "te:" + (h.tool_use_id || ts), tool, callID: h.tool_use_id || "hook-" + ts, status: isErr ? "error" : "completed", title: tool, output: clip(typeof r === "string" ? r : (r && (r.stdout || r.content)) || r, 1000) })
    patch({ currentTool: null })
  } else if (t === "PermissionRequest" || t === "Notification") {
    const title = (h.tool_input && h.tool_input.description) || h.message || h.title || h.tool_name || "approval"
    ev("permission.ask", { type: h.tool_name || "notification", title: clip(title, 200) })
    patch({ pendingPermission: { type: h.tool_name || "notification", title: clip(title, 200) } })
  } else if (t === "PreModelRequest") {
    patch({ status: "busy" })
  } else if (t === "PostModelRequest") {
    if (h.status === "failed") {
      ev("session.error", { name: "ModelError", message: clip(h.error, 500) })
      patch({ lastError: { name: "ModelError", message: clip(h.error, 200) } })
    } else if (h.status === "completed") {
      const tk = mapTokens(h.token_usage)
      ev("step.finish", { reason: "stop", tokens: tk, cost: 0 })
      ev("part.stream", { partType: "text" })
      accTokens(sid, tk, h.model, patch)
    }
  } else if (t === "PreCompact") {
    ev("compaction.start", { via: h.trigger || "auto" })
    patch({ compacting: true, compactingStartedAt: ts })
  } else if (t === "PostCompact") {
    ev("compaction.done", { via: h.trigger || "auto" })
    patch({ compacting: false })
  } else if (t === "SubagentStart") {
    ev("subtask", { agent: h.agent_type, description: "start" })
  } else if (t === "Stop" || t === "SubagentStop") {
    ev("session.status", { status: "idle" })
    ev("session.idle", {})
    patch({ status: "idle", currentTool: null, pendingPermission: null })
    if (harness === "claude-code") {
      const a = lastAssistant(h.transcript_path)
      if (a && a.message) {
        const tk = mapTokens(a.message.usage)
        ev("step.finish", { reason: a.message.stop_reason || "stop", tokens: tk, cost: 0 })
        identity.modelID = a.message.model
        identity.providerID = "anthropic"
        identity.agent = a.isSidechain ? "sidechain" : "main"
        accTokens(sid, tk, a.message.model, patch)
      }
    }
  } else if (t === "Interrupt") {
    ev("session.status", { status: "idle" })
    patch({ status: "idle", currentTool: null })
  } else if (t === "SessionEnd") {
    ev("session.idle", {})
    patch({ status: "idle", currentTool: null })
  }

  if (t !== "SessionEnd" && t !== "Interrupt") await ensureServer()
  const body = JSON.stringify({ events: events.map((e) => ({ ts, sessionID: sid, ...e })), identity, status: status ? { [sid]: status } : undefined })
  const u = new URL(url)
  const req = http.request({ host: u.hostname, port: u.port, path: u.pathname, method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } }, (res) => {
    dbg(harness + " " + t + " push " + res.statusCode + " n=" + events.length)
    res.resume()
  })
  req.on("error", (e) => dbg(t + " push err " + (e && e.message)))
  req.setTimeout(t === "SessionEnd" || t === "Interrupt" ? 700 : 2000, () => {
    dbg(t + " push timeout")
    req.destroy()
  })
  req.end(body)
}

const accTokens = (sid, tk, model, patch) => {
  try {
    const accFile = path.join(dataDir, "acc.json")
    let acc = {}
    try {
      acc = JSON.parse(fs.readFileSync(accFile, "utf8"))
    } catch {}
    const a = (acc[sid] = acc[sid] || { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 })
    a.input += tk.input
    a.output += tk.output
    a.reasoning += tk.reasoning
    a.cacheRead += tk.cache.read
    a.cacheWrite += tk.cache.write
    fs.mkdirSync(dataDir, { recursive: true })
    fs.writeFileSync(accFile, JSON.stringify(acc))
    patch({ tokens: { ...a }, lastModel: { modelID: model } })
  } catch {}
}

main()