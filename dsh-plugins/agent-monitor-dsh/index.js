export const name = "agent-monitor-dsh"

import fs from "node:fs"
import path from "node:path"
import http from "node:http"
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
    input: u.input_tokens || u.input || 0,
    output: u.output_tokens || u.output || 0,
    reasoning: u.reasoning_tokens || u.reasoning || (u.output_tokens_details && u.output_tokens_details.thinking_tokens) || 0,
    cache: { read: u.cache_read_input_tokens || (u.cache && u.cache.read) || 0, write: u.cache_creation_input_tokens || (u.cache && u.cache.write) || 0 },
    total: u.total_tokens || u.total || 0,
  }
}

export function apply(ctx, config = {}) {
  const url = config.url || process.env.AGENT_MONITOR_URL || "http://127.0.0.1:17893/api/ingest"
  if (!apply.exitHooked) {
    apply.exitHooked = true
    process.on("exit", (c) => dbg("process exit code=" + c))
    process.on("beforeExit", () => dbg("beforeExit"))
  }
  dbg("apply url=" + url + " configKeys=" + Object.keys(config || {}).join(","))
  const seen = new Set()
  const sid = () => (ctx.session && ctx.session.id) || config.sessionID || "dsh-main"
  const push = (events, identity) => {
    const evs = (events || []).filter((e) => {
      if (!e.dedupe) return true
      if (seen.has(e.dedupe)) return false
      if (seen.size > 5000) seen.clear()
      seen.add(e.dedupe)
      return true
    })
    if (!evs.length && !identity) return
    dbg("push attempt n=" + evs.length + " identity=" + (identity ? "yes" : "no"))
    try {
      const body = JSON.stringify({ events: evs.map((e) => ({ ts: Date.now(), sessionID: sid(), ...e })), identity })
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
  on("session/before-turn", () => push([{ kind: "session.status", status: "busy" }]))
  on("session/after-turn", () => push([{ kind: "session.status", status: "idle" }, { kind: "session.idle" }]))
  on("agent/status", (p) => push([{ kind: "session.status", status: statusOf(p) }]))
  on("agent/error", (e) => push([{ kind: "session.error", name: (e && e.name) || "AgentError", message: clip(e && e.message, 500) }]))

  let envelopeLogged = false
  on("session/event", (...args) => {
    const ev = args.find((a) => a && a.type && (a.data || a.seq != null)) || args[1] || args[0] || {}
    if (!envelopeLogged) {
      envelopeLogged = true
      dbg("envelope args=" + args.length + " keys=" + args.map((a) => (a && typeof a === "object" ? Object.keys(a).slice(0, 8).join("|") : typeof a)).join(" / ") + " pickedType=" + ev.type)
    }
    const t = ev && ev.type
    dbg("session/event " + t)
    const d = (ev && ev.data) || {}
    const callID = d.callId || d.call_id || d.id
    if (t === "tool/call") {
      push([{ kind: "tool.start", dedupe: "ts:" + callID, tool: d.name || d.tool || "tool", callID, status: "running", title: d.name || d.tool, input: clip(d.input ?? d.args, 2000) }])
      const f = d.input && (d.input.file_path || d.input.path)
      if (f && ["edit", "write", "str_replace", "apply_patch"].indexOf(String(d.name || d.tool).toLowerCase()) >= 0) push([{ kind: "file.edited", file: f }])
    } else if (t === "tool/result") {
      push([{ kind: "tool.end", dedupe: "te:" + callID, tool: d.name || d.tool || "tool", callID, status: d.error || d.isError ? "error" : "completed", title: d.name || d.tool, output: clip(d.output ?? d.result, 1000) }])
    } else if (t === "step/end") {
      push([{ kind: "step.finish", dedupe: "sf:" + (ev.seq || 0), reason: d.reason || "stop", tokens: mapTokens(d.usage || d.tokens), cost: 0 }])
    } else if (t === "turn/start") {
      push([{ kind: "session.status", status: "busy" }])
    } else if (t === "turn/end") {
      push([{ kind: "session.status", status: "idle" }, { kind: "session.idle" }])
    } else if (t === "assistant/message") {
      const blocks = d.content || []
      const hasThinking = Array.isArray(blocks) && blocks.some((b) => b && (b.type === "thinking" || b.type === "reasoning"))
      push([{ kind: "part.stream", partType: hasThinking ? "reasoning" : "text" }])
    } else if (t && t.indexOf("compaction/") === 0) {
      push([{ kind: t.indexOf("start") >= 0 ? "compaction.start" : "compaction.done", via: "dsh-session-log" }])
    } else if (t === "request/header") {
      push([], { harness: "deepseek-harness", model: (d.model && (d.model.id || d.model.name)) || d.model || d.modelID || undefined, providerID: (d.provider && (d.provider.id || d.provider.name)) || d.provider || d.providerID || undefined })
    } else if (t === "llm/retry" || t === "llm/retry-started") {
      push([{ kind: "api.retry", attempt: d.attempt || 1, statusCode: d.statusCode || d.status }])
    } else if (t === "todo/write") {
      push([{ kind: "todo.updated", total: (d.todos || []).length, byStatus: {} }])
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
  waterfall("agent/request", (p) => push([], { harness: "deepseek-harness", model: (p && p.model && (p.model.name || p.model.id)) || (p && p.model) || undefined, providerID: (p && p.provider && (p.provider.name || p.provider.id)) || (p && p.provider) || undefined }))

  dbg("apply done, listeners registered")
  push([{ kind: "plugin.loaded" }], { harness: "deepseek-harness", agent: "dsh" })
}
