import fs from "node:fs"
import path from "node:path"
import http from "node:http"
import os from "node:os"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const dataDir = process.env.AGENT_MONITOR_DATA_DIR || path.join(os.homedir(), ".agent-monitor", "chatgpt")
const url = process.env.AGENT_MONITOR_URL || "http://127.0.0.1:17894/api/ingest"
const port = parseInt(process.env.AGENT_MONITOR_PORT || new URL(url).port || "17894", 10)

const dbg = (msg) => {
  try {
    fs.mkdirSync(dataDir, { recursive: true })
    const f = path.join(dataDir, "hook-debug.log")
    fs.appendFileSync(f, new Date().toISOString() + " " + msg + "\n")
    const st = fs.statSync(f)
    if (st.size > 1048576) {
      const lines = fs.readFileSync(f, "utf8").split("\n")
      fs.writeFileSync(f, lines.slice(-200).join("\n"))
    }
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
    reasoning: u.reasoningTokens || u.reasoning_tokens || u.reasoning || 0,
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

const main = async () => {
  let h = {}
  try {
    h = JSON.parse(await readStdin())
  } catch {}
  const t = h.hook_event_name
  if (!t) return
  const ts = Date.now()
  const sid = h.session_id || "chatgpt-main"
  const events = []
  const identity = { harness: "chatgpt", agent: "codex" }
  if (h.model) identity.modelID = h.model
  if (h.cwd) identity.directory = h.cwd
  let status = null
  const patch = (p) => {
    status = { ...(status || {}), ...p }
  }

  if (t === "SessionStart") {
    events.push({ kind: "session.created", title: "codex " + (h.source || "startup") })
    patch({ status: "idle" })
  } else if (t === "UserPromptSubmit") {
    events.push({ kind: "session.status", status: "busy" })
    patch({ status: "busy" })
  } else if (t === "PreToolUse") {
    const tool = h.tool_name || "tool"
    events.push({ kind: "tool.start", dedupe: "ts:" + h.tool_use_id, tool, callID: h.tool_use_id, status: "running", title: tool, input: clip(h.tool_input, 2000) })
    patch({ status: "busy", currentTool: { tool, status: "running", title: tool, startedAt: ts } })
    const inp = h.tool_input || {}
    let file = inp.file_path || inp.path
    if (!file && typeof inp.command === "string") {
      const m = inp.command.match(/\*\*\* (?:Update|Add|Delete) File: (.+)/)
      if (m) file = m[1].trim()
    }
    if (file && /^(apply_patch|Edit|Write)$/i.test(tool)) events.push({ kind: "file.edited", file })
  } else if (t === "PostToolUse") {
    const tool = h.tool_name || "tool"
    const resp = h.tool_response
    const isErr = !!(resp && typeof resp === "object" && (resp.error || resp.isError))
    events.push({ kind: "tool.end", dedupe: "te:" + h.tool_use_id, tool, callID: h.tool_use_id, status: isErr ? "error" : "completed", title: tool, output: clip(resp, 1000) })
    patch({ currentTool: null })
  } else if (t === "PermissionRequest") {
    const title = (h.tool_input && h.tool_input.description) || h.tool_name || "approval"
    events.push({ kind: "permission.ask", type: h.tool_name, title })
    patch({ pendingPermission: { type: h.tool_name, title } })
  } else if (t === "PreModelRequest") {
    patch({ status: "busy" })
  } else if (t === "PostModelRequest") {
    if (h.status === "failed") {
      events.push({ kind: "session.error", name: "ModelError", message: clip(h.error, 500) })
      patch({ lastError: { name: "ModelError", message: clip(h.error, 200) } })
    } else if (h.status === "completed") {
      const tk = mapTokens(h.token_usage)
      events.push({ kind: "step.finish", reason: "stop", tokens: tk, cost: 0 })
      events.push({ kind: "part.stream", partType: "text" })
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
        patch({ tokens: { ...a }, lastModel: { modelID: h.model } })
      } catch {}
    }
  } else if (t === "PreCompact") {
    events.push({ kind: "compaction.start", via: h.trigger || "auto" })
    patch({ compacting: true, compactingStartedAt: ts })
  } else if (t === "PostCompact") {
    events.push({ kind: "compaction.done", via: h.trigger || "auto" })
    patch({ compacting: false })
  } else if (t === "SubagentStart") {
    events.push({ kind: "subtask", agent: h.agent_type, description: "start" })
  } else if (t === "SubagentStop") {
    events.push({ kind: "subtask", agent: h.agent_type, description: "stop" })
  } else if (t === "Stop") {
    events.push({ kind: "session.status", status: "idle" })
    events.push({ kind: "session.idle" })
    patch({ status: "idle", currentTool: null, pendingPermission: null })
  } else if (t === "Interrupt") {
    events.push({ kind: "session.status", status: "idle" })
    patch({ status: "idle", currentTool: null })
  } else if (t === "SessionEnd") {
    events.push({ kind: "session.idle" })
    patch({ status: "idle", currentTool: null })
  }

  if (t !== "SessionEnd" && t !== "Interrupt") await ensureServer()
  const body = JSON.stringify({ events: events.map((e) => ({ ts, sessionID: sid, ...e })), identity, status: status ? { [sid]: status } : undefined })
  const u = new URL(url)
  const req = http.request({ host: u.hostname, port: u.port, path: u.pathname, method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } }, (res) => {
    dbg(t + " push " + res.statusCode + " n=" + events.length)
    res.resume()
  })
  req.on("error", (e) => dbg(t + " push err " + (e && e.message)))
  req.setTimeout(t === "SessionEnd" || t === "Interrupt" ? 700 : 2000, () => {
    dbg(t + " push timeout")
    req.destroy()
  })
  req.end(body)
}

main()