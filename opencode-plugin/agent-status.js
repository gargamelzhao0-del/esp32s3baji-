import fs from "node:fs"
import path from "node:path"
import http from "node:http"

const pushUrl = process.env.AGENT_MONITOR_URL || "http://127.0.0.1:17890/api/ingest"
const push = (body) => {
  try {
    const u = new URL(pushUrl)
    const data = JSON.stringify(body)
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname, method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } }, (res) => res.resume())
    req.on("error", () => {})
    req.setTimeout(1500, () => req.destroy())
    req.end(data)
  } catch {}
}

export default async ({ directory, client }) => {
  const outDir = path.join(directory, ".tmp", "agent-status")
  const statusFile = path.join(outDir, "status.json")
  const eventsFile = path.join(outDir, "events.jsonl")
  const contextLimit = parseInt(process.env.OPENCODE_MAX_CONTEXT_TOKENS || "", 10) || undefined
  const state = { pluginLoadedAt: Date.now(), pid: process.pid, contextLimit, sessions: {}, ptys: {}, bootstrap: {} }
  const seen = new Set()
  let lastPersistAt = 0

  try {
    fs.mkdirSync(outDir, { recursive: true })
  } catch {}

  const persist = () => {
    try {
      fs.writeFileSync(statusFile, JSON.stringify(state, null, 2))
      lastPersistAt = Date.now()
    } catch {}
    push({ status: state.sessions, identity: { harness: "opencode", agent: "opencode", directory } })
  }

  const maybePersist = () => {
    if (Date.now() - lastPersistAt > 1000) persist()
  }

  const log = (kind, sessionID, payload) => {
    try {
      fs.appendFileSync(eventsFile, JSON.stringify({ ...payload, ts: Date.now(), kind, sessionID }) + "\n")
    } catch {}
    push({ events: [{ ...payload, ts: Date.now(), kind, sessionID }] })
  }

  const sess = (id) => {
    if (!id) return null
    if (!state.sessions[id]) {
      state.sessions[id] = {
        status: "unknown",
        compacting: false,
        compactionCount: 0,
        stepCount: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
        cost: 0,
        diff: { files: 0, additions: 0, deletions: 0 },
        updatedAt: Date.now(),
      }
    }
    return state.sessions[id]
  }

  const clip = (v, n) => {
    if (v === undefined || v === null) return undefined
    const s = typeof v === "string" ? v : JSON.stringify(v)
    if (typeof s !== "string") return undefined
    return s.length > n ? s.slice(0, n) + "...[truncated]" : s
  }

  const dedupe = (key) => {
    if (seen.has(key)) return false
    if (seen.size > 20000) seen.clear()
    seen.add(key)
    return true
  }

  const touch = (s) => {
    if (s) s.updatedAt = Date.now()
    persist()
  }

  const errInfo = (e) => {
    if (!e) return undefined
    return { name: e.name, message: clip(e.data?.message, 500), statusCode: e.data?.statusCode, isRetryable: e.data?.isRetryable }
  }

  const safeConfig = (cfg) => ({
    model: cfg?.model,
    small_model: cfg?.small_model,
    default_agent: cfg?.default_agent,
    username: cfg?.username,
    share: cfg?.share,
    autoupdate: cfg?.autoupdate,
    snapshot: cfg?.snapshot,
    logLevel: cfg?.logLevel,
    shell: cfg?.shell,
    compaction: cfg?.compaction,
    instructions: cfg?.instructions,
    plugin: cfg?.plugin,
    providers: Object.keys(cfg?.provider || {}),
    disabled_providers: cfg?.disabled_providers,
    enabled_providers: cfg?.enabled_providers,
    agents: Object.keys(cfg?.agent || {}),
    mcp: Object.keys(cfg?.mcp || {}),
    permission: cfg?.permission,
    skills: cfg?.skills,
    experimental: cfg?.experimental,
  })

  const boot = async (key, fn, map) => {
    try {
      const r = await fn()
      state.bootstrap[key] = map ? map(r?.data) : r?.data
    } catch {}
  }

  await boot("sessionStatus", () => client.session.status())
  await boot("mcp", () => client.mcp.status())
  await boot("toolIds", () => client.tool.ids())
  await boot("sessions", () => client.session.list(), (d) => (Array.isArray(d) ? d.slice(0, 30).map((s) => ({ id: s.id, title: clip(s.title, 100), parentID: s.parentID, time: s.time })) : d))
  await boot("agents", () => client.app.agents(), (d) => (Array.isArray(d) ? d.map((a) => ({ name: a.name, mode: a.mode, description: clip(a.description, 150) })) : d))
  await boot("lsp", () => client.lsp.status())
  await boot("formatter", () => client.formatter.status())
  await boot("commands", () => client.command.list(), (d) => (Array.isArray(d) ? d.map((c) => c.name) : d))
  await boot("project", () => client.project.current())
  await boot("vcs", () => client.vcs.get())
  await boot("ptyList", () => client.pty.list())
  await boot("paths", () => client.path.get())
  await boot("fileStatus", () => client.file.status(), (d) => (Array.isArray(d) ? { count: d.length, files: d.slice(0, 50) } : d))

  log("plugin.loaded", undefined, { directory, outDir, contextLimit, bootstrap: Object.keys(state.bootstrap) })
  persist()

  const heartbeat = setInterval(() => {
    state.heartbeatAt = Date.now()
    persist()
  }, 30000)
  heartbeat.unref?.()

  return {
    async config(cfg) {
      try {
        state.configSummary = safeConfig(cfg)
        log("config.loaded", undefined, state.configSummary)
        persist()
      } catch {}
    },

    async event({ event }) {
      try {
        const p = event.properties || {}
        if (event.type === "session.status") {
          const s = sess(p.sessionID)
          s.status = p.status?.type || "unknown"
          if (p.status?.type === "retry") {
            s.retry = { attempt: p.status.attempt, message: clip(p.status.message, 500), next: p.status.next }
          } else {
            delete s.retry
          }
          log("session.status", p.sessionID, { status: s.status, retry: s.retry })
          touch(s)
        } else if (event.type === "session.idle") {
          const s = sess(p.sessionID)
          s.status = "idle"
          log("session.idle", p.sessionID, {})
          touch(s)
        } else if (event.type === "session.compacted") {
          const s = sess(p.sessionID)
          s.compacting = false
          const recentHook = s.lastCompaction?.via === "hook" && Date.now() - s.lastCompaction.at < 10000
          if (!recentHook) {
            s.compactionCount += 1
            s.lastCompaction = { at: Date.now(), via: "session.compacted" }
          }
          log("compaction.done", p.sessionID, { via: "session.compacted", counted: !recentHook, count: s.compactionCount })
          touch(s)
        } else if (event.type === "session.created") {
          const info = p.info || {}
          sess(info.id)
          log("session.created", info.id, { title: clip(info.title, 100), parentID: info.parentID, directory: info.directory })
          persist()
        } else if (event.type === "session.updated") {
          const info = p.info || {}
          const s = sess(info.id)
          if (info.title) s.title = clip(info.title, 100)
          if (info.parentID) s.parentID = info.parentID
          const t = info.time?.compacting
          if (t && t !== s.compactingStartedAt && !s.compacting) {
            s.compacting = true
            s.compactingStartedAt = t
            s.status = "compacting"
            log("compaction.start", info.id, { via: "session.updated", at: t })
          }
          touch(s)
        } else if (event.type === "session.deleted") {
          const info = p.info || {}
          log("session.deleted", info.id, { title: clip(info.title, 100) })
          delete state.sessions[info.id]
          persist()
        } else if (event.type === "session.error") {
          const s = sess(p.sessionID)
          const e = errInfo(p.error)
          if (s) s.lastError = { at: Date.now(), ...e }
          log("session.error", p.sessionID, e || {})
          touch(s)
        } else if (event.type === "session.diff") {
          const s = sess(p.sessionID)
          const diffs = p.diff || []
          const add = diffs.reduce((a, d) => a + (d.additions || 0), 0)
          const del = diffs.reduce((a, d) => a + (d.deletions || 0), 0)
          if (s) s.diff = { files: diffs.length, additions: add, deletions: del }
          log("session.diff", p.sessionID, { files: diffs.length, additions: add, deletions: del, detail: diffs.slice(0, 20).map((d) => ({ file: d.file, additions: d.additions, deletions: d.deletions })) })
          touch(s)
        } else if (event.type === "message.updated") {
          const info = p.info || {}
          if (info.role === "user") {
            if (!dedupe("usermsg:" + info.id)) return
            const s = sess(info.sessionID)
            log("message.user", info.sessionID, { messageID: info.id, agent: info.agent, model: info.model, variant: info.variant, toolCount: Object.keys(info.tools || {}).length })
            touch(s)
            return
          }
          const done = info.time?.completed
          if (!done && !info.error) return
          if (!dedupe("msg:" + info.id + ":" + (done || "err"))) return
          const s = sess(info.sessionID)
          const latency = done && info.time?.created ? done - info.time.created : undefined
          if (s) {
            s.lastModel = { providerID: info.providerID, modelID: info.modelID, mode: info.mode }
            s.lastMessageAt = done || Date.now()
            if (info.error) s.lastError = { at: Date.now(), ...errInfo(info.error) }
          }
          log("message.complete", info.sessionID, { messageID: info.id, modelID: info.modelID, providerID: info.providerID, mode: info.mode, finish: info.finish, latencyMs: latency, cost: info.cost, tokens: info.tokens, error: errInfo(info.error) })
          touch(s)
        } else if (event.type === "message.removed") {
          log("message.removed", p.sessionID, { messageID: p.messageID })
        } else if (event.type === "message.part.removed") {
          log("part.removed", p.sessionID, { messageID: p.messageID, partID: p.partID })
        } else if (event.type === "message.part.updated") {
          const part = p.part || {}
          if (part.type === "compaction") {
            const s = sess(part.sessionID)
            log("compaction.part", part.sessionID, { auto: part.auto, messageID: part.messageID })
            touch(s)
          } else if (part.type === "step-start") {
            if (!dedupe("stepstart:" + part.id)) return
            const s = sess(part.sessionID)
            if (s) s.stepCount += 1
            log("step.start", part.sessionID, { messageID: part.messageID, snapshot: part.snapshot })
            touch(s)
          } else if (part.type === "step-finish") {
            if (!dedupe("step:" + part.id)) return
            const s = sess(part.sessionID)
            const t = part.tokens || {}
            s.tokens.input += t.input || 0
            s.tokens.output += t.output || 0
            s.tokens.reasoning += t.reasoning || 0
            s.tokens.cacheRead += t.cache?.read || 0
            s.tokens.cacheWrite += t.cache?.write || 0
            s.cost += part.cost || 0
            s.lastStepFinishAt = Date.now()
            const ctx = t.total ? t.total - (t.output || 0) - (t.reasoning || 0) : (t.input || 0) + (t.cache?.read || 0) + (t.cache?.write || 0)
            s.contextUsage = { contextTokens: ctx, limitTokens: contextLimit, ratio: contextLimit ? Math.round((ctx / contextLimit) * 10000) / 10000 : undefined }
            log("step.finish", part.sessionID, { reason: part.reason, tokens: part.tokens, cost: part.cost, contextTokens: ctx })
            touch(s)
          } else if (part.type === "tool") {
            const st = part.state || {}
            if (!dedupe("tool:" + part.id + ":" + st.status)) return
            const s = sess(part.sessionID)
            if (st.status === "running" || st.status === "pending") {
              s.currentTool = { tool: part.tool, callID: part.callID, status: st.status, title: st.title, startedAt: st.time?.start }
              log("tool.start", part.sessionID, { tool: part.tool, callID: part.callID, status: st.status, title: st.title, input: clip(st.input, 2000) })
            } else if (st.status === "completed") {
              if (s.currentTool?.callID === part.callID) s.currentTool = null
              const dur = st.time?.end && st.time?.start ? st.time.end - st.time.start : undefined
              log("tool.end", part.sessionID, { tool: part.tool, callID: part.callID, status: "completed", title: st.title, durationMs: dur, output: clip(st.output, 1000) })
            } else if (st.status === "error") {
              if (s.currentTool?.callID === part.callID) s.currentTool = null
              log("tool.end", part.sessionID, { tool: part.tool, callID: part.callID, status: "error", error: clip(st.error, 1000) })
            }
            touch(s)
          } else if (part.type === "retry") {
            if (!dedupe("retry:" + part.id + ":" + part.attempt)) return
            const s = sess(part.sessionID)
            log("api.retry", part.sessionID, { attempt: part.attempt, error: errInfo(part.error) })
            touch(s)
          } else if (part.type === "subtask") {
            if (!dedupe("subtask:" + part.id)) return
            const s = sess(part.sessionID)
            log("subtask", part.sessionID, { agent: part.agent, description: part.description, prompt: clip(part.prompt, 500) })
            touch(s)
          } else if (part.type === "agent") {
            if (!dedupe("agent:" + part.id)) return
            const s = sess(part.sessionID)
            if (s) s.currentAgent = part.name
            log("agent.switch", part.sessionID, { name: part.name })
            touch(s)
          } else if (part.type === "patch") {
            if (!dedupe("patch:" + part.id)) return
            const s = sess(part.sessionID)
            log("patch", part.sessionID, { files: part.files })
            touch(s)
          } else if (part.type === "snapshot") {
            if (!dedupe("snapshot:" + part.id)) return
            log("snapshot", part.sessionID, { snapshot: part.snapshot })
          } else if (part.type === "file") {
            if (!dedupe("filepart:" + part.id)) return
            log("file.attach", part.sessionID, { filename: part.filename, mime: part.mime, url: clip(part.url, 200) })
          } else if (part.type === "text" || part.type === "reasoning") {
            const s = sess(part.sessionID)
            if (s) {
              if (part.type === "text") {
                s.outputPreview = clip(part.text, 300)
                s.lastTextAt = Date.now()
              } else {
                s.reasoningPreview = clip(part.text, 300)
                s.lastReasoningAt = Date.now()
              }
            }
            if (dedupe("stream:" + part.id)) log(part.type === "text" ? "text.part" : "reasoning.part", part.sessionID, { messageID: part.messageID, partID: part.id })
            maybePersist()
          }
        } else if (event.type === "permission.updated") {
          const s = sess(p.sessionID)
          const perm = { id: p.id, type: p.type, title: p.title, pattern: p.pattern, sessionID: p.sessionID, callID: p.callID }
          if (s) s.pendingPermission = perm
          log("permission.ask", p.sessionID, perm)
          touch(s)
        } else if (event.type === "permission.replied") {
          const s = sess(p.sessionID)
          if (s?.pendingPermission?.id === p.permissionID) delete s.pendingPermission
          log("permission.reply", p.sessionID, { permissionID: p.permissionID, response: p.response })
          touch(s)
        } else if (event.type === "todo.updated") {
          const s = sess(p.sessionID)
          const todos = p.todos || []
          const byStatus = {}
          for (const t of todos) byStatus[t.status] = (byStatus[t.status] || 0) + 1
          if (s) s.todos = { total: todos.length, byStatus, items: todos.map((t) => ({ content: clip(t.content, 200), status: t.status, priority: t.priority })) }
          log("todo.updated", p.sessionID, { total: todos.length, byStatus })
          touch(s)
        } else if (event.type === "command.executed") {
          log("command.executed", p.sessionID, { name: p.name, arguments: clip(p.arguments, 500) })
        } else if (event.type === "file.edited") {
          log("file.edited", undefined, { file: p.file })
        } else if (event.type === "file.watcher.updated") {
          log("file.watcher", undefined, { file: p.file, event: p.event })
        } else if (event.type === "vcs.branch.updated") {
          state.branch = p.branch
          log("vcs.branch", undefined, { branch: p.branch })
          persist()
        } else if (event.type === "pty.created" || event.type === "pty.updated") {
          const info = p.info || {}
          state.ptys[info.id] = { id: info.id, title: info.title, command: info.command, args: info.args, cwd: info.cwd, pid: info.pid, status: info.status }
          log("pty." + (event.type === "pty.created" ? "created" : "updated"), undefined, state.ptys[info.id])
          persist()
        } else if (event.type === "pty.exited") {
          if (state.ptys[p.id]) state.ptys[p.id].status = "exited"
          log("pty.exited", undefined, { id: p.id, exitCode: p.exitCode })
          persist()
        } else if (event.type === "pty.deleted") {
          delete state.ptys[p.id]
          log("pty.deleted", undefined, { id: p.id })
          persist()
        } else if (event.type === "lsp.client.diagnostics") {
          log("lsp.diagnostics", undefined, { serverID: p.serverID, path: p.path })
        } else if (event.type === "lsp.updated") {
          log("lsp.updated", undefined, { keys: Object.keys(p) })
        } else if (event.type === "installation.updated" || event.type === "installation.update-available") {
          state.installation = { version: p.version, event: event.type }
          log("installation", undefined, { version: p.version, event: event.type })
          persist()
        } else if (event.type === "server.connected") {
          log("server.connected", undefined, {})
        } else if (event.type === "server.instance.disposed") {
          log("server.disposed", undefined, { directory: p.directory })
        } else if (event.type === "tui.prompt.append") {
          log("tui.prompt", undefined, { text: clip(p.text, 300) })
        } else if (event.type === "tui.command.execute") {
          log("tui.command", undefined, { command: p.command })
        } else if (event.type === "tui.toast.show") {
          log("tui.toast", undefined, { title: p.title, message: clip(p.message, 300), variant: p.variant })
        }
      } catch {}
    },

    async "chat.message"(input) {
      try {
        const s = sess(input.sessionID)
        log("chat.message", input.sessionID, { agent: input.agent, model: input.model, messageID: input.messageID, variant: input.variant })
        touch(s)
      } catch {}
    },

    async "chat.params"(input, output) {
      try {
        const s = sess(input.sessionID)
        const params = { temperature: output.temperature, topP: output.topP, topK: output.topK, maxOutputTokens: output.maxOutputTokens, options: clip(output.options, 300) }
        if (s) s.lastChatParams = params
        log("chat.params", input.sessionID, { agent: input.agent, model: input.model?.id, ...params })
        touch(s)
      } catch {}
    },

    async "chat.headers"(input, output) {
      try {
        log("chat.headers", input.sessionID, { headerNames: Object.keys(output.headers || {}) })
      } catch {}
    },

    async "shell.env"(input, output) {
      try {
        log("shell.env", input.sessionID, { cwd: input.cwd, envKeys: Object.keys(output.env || {}) })
      } catch {}
    },

    async "permission.ask"(input, output) {
      try {
        log("permission.hook", input.sessionID, { type: input.type, title: clip(input.title, 200), decision: output.status })
      } catch {}
    },

    async "experimental.chat.messages.transform"(input, output) {
      try {
        const msgs = output.messages || []
        let chars = 0
        let toolParts = 0
        for (const m of msgs) {
          for (const part of m.parts || []) {
            if (typeof part.text === "string") chars += part.text.length
            if (part.type === "tool") toolParts += 1
          }
        }
        const sessionID = msgs[0]?.info?.sessionID
        state.lastContext = { at: Date.now(), sessionID, messageCount: msgs.length, totalChars: chars, toolParts }
        log("context.transform", sessionID, state.lastContext)
        persist()
      } catch {}
    },

    async "experimental.chat.system.transform"(input, output) {
      try {
        const sys = output.system || []
        log("system.transform", input.sessionID, { blocks: sys.length, totalChars: sys.reduce((a, s) => a + (s?.length || 0), 0), model: input.model?.id })
      } catch {}
    },

    async "experimental.provider.small_model"(input, output) {
      try {
        log("small_model", undefined, { provider: input.provider?.id, model: output.model?.id })
      } catch {}
    },

    async "experimental.text.complete"(input) {
      try {
        if (!dedupe("textcomplete:" + input.partID)) return
        log("text.complete", input.sessionID, { messageID: input.messageID, partID: input.partID })
      } catch {}
    },

    async "experimental.session.compacting"(input) {
      try {
        const s = sess(input.sessionID)
        const already = s.compacting
        s.compacting = true
        s.compactingStartedAt = Date.now()
        s.status = "compacting"
        if (!already) log("compaction.start", input.sessionID, { via: "hook" })
        touch(s)
      } catch {}
    },

    async "experimental.compaction.autocontinue"(input) {
      try {
        const s = sess(input.sessionID)
        s.compacting = false
        const recentHook = s.lastCompaction?.via === "hook" && Date.now() - s.lastCompaction.at < 10000
        if (!recentHook) s.compactionCount += 1
        s.lastCompaction = { at: Date.now(), via: "hook", overflow: input.overflow }
        log("compaction.done", input.sessionID, { via: "hook", overflow: input.overflow, agent: input.agent, model: input.model?.id, count: s.compactionCount })
        touch(s)
      } catch {}
    },

    async dispose() {
      clearInterval(heartbeat)
      state.pluginUnloadAt = Date.now()
      log("plugin.unloaded", undefined, { pid: process.pid })
      persist()
    },
  }
}
