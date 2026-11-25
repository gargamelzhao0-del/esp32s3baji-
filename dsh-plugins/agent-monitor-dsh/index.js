export const name = "agent-monitor-dsh"

import fs from "node:fs"
import path from "node:path"
import http from "node:http"
import os from "node:os"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"

const dbg = (msg) => {
  try {
    fs.appendFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "debug.log"), new Date().toISOString() + " " + msg + "\n")
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
    cache: {
      read: u.cacheReadTokens || u.cache_read_input_tokens || (u.cache && u.cache.read) || 0,
      write: u.cacheWriteTokens || u.cache_creation_input_tokens || (u.cache && u.cache.write) || 0,
    },
    total: u.totalTokens || u.total_tokens || u.total || 0,
  }
}

export function apply(ctx, config = {}) {
  const port = parseInt(config.port || process.env.AGENT_MONITOR_PORT || "17893", 10)
  const dataDir = config.dataDir || process.env.AGENT_MONITOR_DATA_DIR || path.join(os.homedir(), ".agent-monitor", "dsh")
  const serverEntry = path.join(path.dirname(fileURLToPath(import.meta.url)), "server.mjs")
  if (!apply.serverProbed && fs.existsSync(serverEntry)) {
    apply.serverProbed = true
    const spawnServer = () => {
      try {
        const child = spawn(process.execPath, [serverEntry], { env: { ...process.env, MONITOR_PORT: String(port), MONITOR_DATA_DIR: dataDir, MONITOR_DB: "none" }, stdio: "ignore", detached: true })
        child.unref()
        dbg("server spawned pid=" + child.pid + " port=" + port + " data=" + dataDir)
      } catch (e) {
        dbg("server spawn err " + (e && e.message))
      }
    }
    const probe = http.get({ host: "127.0.0.1", port, path: "/api/state", timeout: 800 }, (res) => {
      res.resume()
      dbg("server already up port=" + port)
    })
    probe.on("error", spawnServer)
    probe.on("timeout", () => {
      probe.destroy()
      spawnServer()
    })
  }
  const url = config.url || process.env.AGENT_MONITOR_URL || "http://127.0.0.1:" + port + "/api/ingest"
  if (!apply.exitHooked) {
    apply.exitHooked = true
    process.on("exit", (c) => dbg("process exit code=" + c))
    process.on("beforeExit", () => dbg("beforeExit"))
  }
  dbg("apply url=" + url + " configKeys=" + Object.keys(config || {}).join(","))
  const seen = new Set()
  let lastSid = null
  const sid = () => {
    if (lastSid) return lastSid
    try {
      const s = ctx.session
      if (s && s.id) return s.id
    } catch {}
    return config.sessionID || "dsh-main"
  }
  const push = (events, identity, status) => {
    const evs = (events || []).filter((e) => {
      if (!e.dedupe) return true
      if (seen.has(e.dedupe)) return false
      if (seen.size > 5000) seen.clear()
      seen.add(e.dedupe)
      return true
    })
    if (!evs.length && !identity && !status) return
    try {
      const body = JSON.stringify({ events: evs.map((e) => ({ ts: Date.now(), sessionID: sid(), ...e })), identity, status })
      const req = http.request(url, { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } }, (res) => {
        dbg("push ok " + res.statusCode + " n=" + evs.length)
        res.resume()
      })
      req.on("error", (e) => dbg("push err " + (e && e.message)))
      req.setTimeout(2500, () => {
        dbg("push timeout n=" + evs.length)
        req.destroy()
      })
      req.end(body)
    } catch (e) {
      dbg("push throw " + (e && e.message))
    }
  }
  const pushStatus = (patch) => push([], null, { [sid()]: patch })
  const statusOf = (p) => {
    const s = (p && (p.status || p.type)) || (p && p.running ? "busy" : "idle")
    if (s === "running" || s === "busy" || s === "working") return "busy"
    if (s === "compacting") return "compacting"
    if (s === "retry" || s === "retrying") return "retry"
    return "idle"
  }

  const on = (name, fn) => {
    ctx.on(name, (...args) => {
      const next = args[args.length - 1]
      const hasNext = typeof next === "function"
      let r
      try {
        r = fn(...(hasNext ? args.slice(0, -1) : args))
      } catch (e) {
        dbg("handler err " + name + " " + (e && e.message))
      }
      return hasNext ? next() : r
    })
  }

  on("ready", () => {
    dbg("ready fired")
    push([{ kind: "plugin.loaded" }], { harness: "deepseek-harness", agent: "dsh" })
  })
  on("session/created", (s) => push([{ kind: "session.created", title: clip((s && (s.title || s.id)) || "", 120) }]))
  on("session/before-turn", () => {
    push([{ kind: "session.status", status: "busy" }])
    pushStatus({ status: "busy" })
  })
  on("session/after-turn", () => {
    push([{ kind: "session.status", status: "idle" }, { kind: "session.idle" }])
    pushStatus({ status: "idle", currentTool: null })
  })
  on("agent/status", (p) => {
    push([{ kind: "session.status", status: statusOf(p) }])
    pushStatus({ status: statusOf(p) })
  })
  on("agent/error", (e) => {
    push([{ kind: "session.error", name: (e && e.name) || "AgentError", message: clip(e && e.message, 500) }])
    pushStatus({ lastError: { name: (e && e.name) || "AgentError", message: clip(e && e.message, 200) } })
  })

  const callNames = {}
  const tokAcc = {}
  const compCount = {}
  const msgSteps = new Set()
  const dumped = {}
  const dumpOnce = (t, d) => {
    if (dumped[t]) return
    dumped[t] = true
    dbg("payload " + t + " " + clip(d, 900))
  }
  let metaPushed = false

  on("session/event", (...args) => {
    const sess = args[0]
    if (sess && sess.id) lastSid = sess.id
    const ev = args.find((a) => a && a.type && (a.data || a.seq != null)) || args[1] || args[0] || {}
    const t = ev && ev.type
    const d = (ev && ev.data) || {}
    if (!metaPushed && sess && (sess.cwd || sess.agentPreset)) {
      metaPushed = true
      push([], { harness: "deepseek-harness", directory: sess.cwd || undefined, agent: sess.agentPreset || "dsh" })
    }
    if (t === "tool/call") {
      const callID = d.callId || d.call_id || d.id
      const tool = d.name || d.tool || "tool"
      callNames[callID] = tool
      let input
      try {
        input = typeof d.arguments === "string" ? JSON.parse(d.arguments) : d.input ?? d.args
      } catch {
        input = d.arguments
      }
      push([{ kind: "tool.start", dedupe: "ts:" + callID, tool, callID, status: "running", title: tool, input: clip(input, 2000) }])
      pushStatus({ status: "busy", currentTool: { tool, status: "running", title: tool, startedAt: Date.now() } })
      const f = input && (input.file_path || input.path)
      const ln = String(tool).toLowerCase()
      if (f && (["edit", "write", "str_replace", "apply_patch"].indexOf(ln) >= 0 || ln.indexOf("edit") >= 0 || ln.indexOf("write") >= 0 || ln.indexOf("patch") >= 0)) push([{ kind: "file.edited", file: f }])
    } else if (t === "tool/result") {
      const msg = d.message || {}
      const callID = msg.toolCallId || d.callId || d.call_id || d.id
      const tool = callNames[callID] || d.name || d.tool || "tool"
      const isErr = !!(d.error || msg.isError || d.isError)
      push([{ kind: "tool.end", dedupe: "te:" + callID, tool, callID, status: isErr ? "error" : "completed", title: tool, output: clip(msg.content ?? d.output ?? d.result, 1000) }])
      pushStatus({ currentTool: null })
      if (isErr) pushStatus({ lastError: { name: (d.error && d.error.name) || tool, message: clip((d.error && (d.error.reason || d.error.code)) || msg.content, 200) } })
      delete callNames[callID]
    } else if (t === "assistant/message") {
      dumpOnce(t, { usage: d.usage, source: d.message && d.message.source })
      msgSteps.add(d.turn + ":" + d.step)
      const blocks = (d.message && d.message.content) || d.content || []
      const hasThinking = Array.isArray(blocks) && blocks.some((b) => b && (b.type === "thinking" || b.type === "reasoning"))
      push([{ kind: "part.stream", partType: hasThinking ? "reasoning" : "text" }])
      const src = d.message && d.message.source
      if (src && (src.model || src.provider)) push([], { harness: "deepseek-harness", modelID: src.model || undefined, providerID: src.provider || undefined })
      if (d.usage) {
        const tk = mapTokens(d.usage)
        push([{ kind: "step.finish", dedupe: "sf:" + (ev.seq || 0), reason: d.interrupted ? "interrupted" : "stop", tokens: tk, cost: 0 }])
        const s = sid()
        const acc = (tokAcc[s] = tokAcc[s] || { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 })
        acc.input += tk.input
        acc.output += tk.output
        acc.reasoning += tk.reasoning
        acc.cacheRead += tk.cache.read
        acc.cacheWrite += tk.cache.write
        pushStatus({ tokens: { ...acc }, lastModel: { modelID: src && src.model, providerID: src && src.provider } })
      }
    } else if (t === "step/end") {
      if (!msgSteps.has(d.turn + ":" + d.step)) push([{ kind: "step.finish", dedupe: "se:" + (ev.seq || 0), reason: "stop", tokens: mapTokens(null), cost: 0 }])
    } else if (t === "turn/start") {
      push([{ kind: "session.status", status: "busy" }])
      pushStatus({ status: "busy" })
    } else if (t === "turn/end") {
      push([{ kind: "session.status", status: "idle" }, { kind: "session.idle" }])
      pushStatus({ status: "idle", currentTool: null })
    } else if (t === "request/context") {
      dumpOnce(t, d)
      push([], { harness: "deepseek-harness", modelID: d.model || undefined, providerID: d.provider || undefined, contextWindow: d.contextWindow })
    } else if (t === "model/selection") {
      dumpOnce(t, d)
      push([], { harness: "deepseek-harness", modelID: d.model || undefined, providerID: d.provider || undefined, reasoningEffort: d.reasoningEffort })
    } else if (t === "request/header") {
      dumpOnce(t, d.header && d.header.config)
      const cfg = (d.header && d.header.config) || {}
      push([], { harness: "deepseek-harness", modelID: cfg.model || undefined, providerID: cfg.provider || undefined, reasoningEffort: cfg.reasoningEffort })
    } else if (t === "session/title") {
      dumpOnce(t, d)
      const title = d.title || d.text || (typeof d === "string" ? d : undefined)
      if (title) push([], { title: clip(title, 120) })
    } else if (t && t.indexOf("working-dir") === 0) {
      if (d.cwd) push([], { directory: d.cwd })
    } else if (t && t.indexOf("compaction/") === 0) {
      const s = sid()
      if (t.indexOf("start") >= 0) {
        push([{ kind: "compaction.start", via: "dsh-session-log" }])
        pushStatus({ compacting: true, compactingStartedAt: Date.now() })
      } else {
        compCount[s] = (compCount[s] || 0) + 1
        push([{ kind: "compaction.done", via: "dsh-session-log", count: compCount[s] }])
        pushStatus({ compacting: false, compactionCount: compCount[s] })
      }
    } else if (t === "llm/retry" || t === "llm/retry-started") {
      push([{ kind: "api.retry", attempt: d.attempt || 1, statusCode: d.statusCode || d.status }])
      pushStatus({ status: "retry", retry: { attempt: d.attempt || 1 } })
    } else if (t === "approval/asked") {
      push([{ kind: "permission.ask", type: "tool", title: d.toolName || d.id }])
      pushStatus({ pendingPermission: { type: "tool", title: d.toolName || d.id } })
    } else if (t === "approval/decided") {
      push([{ kind: "permission.reply", response: d.outcome }])
      pushStatus({ pendingPermission: null })
    } else if (t === "todo/write") {
      const todos = d.todos || []
      const byStatus = {}
      for (const x of todos) byStatus[x.status] = (byStatus[x.status] || 0) + 1
      push([{ kind: "todo.updated", total: todos.length, byStatus }])
    }
  })

  const waterfall = (eventName, fn) => {
    ctx.on(eventName, (...args) => {
      const next = args[args.length - 1]
      try {
        fn(...args.slice(0, -1))
      } catch {}
      return typeof next === "function" ? next() : undefined
    })
  }
  waterfall("agent/request", (p) => {
    const cfg = (p && p.config) || p || {}
    push([], { harness: "deepseek-harness", modelID: cfg.model || (p && p.model && (p.model.name || p.model.id)) || undefined, providerID: cfg.provider || (p && p.provider && (p.provider.name || p.provider.id)) || undefined, reasoningEffort: cfg.reasoningEffort })
  })

  dbg("apply done, listeners registered")
  push([{ kind: "plugin.loaded" }], { harness: "deepseek-harness", agent: "dsh" })
}