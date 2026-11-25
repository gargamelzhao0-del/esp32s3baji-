import http from "node:http"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { fileURLToPath } from "node:url"
import { DatabaseSync } from "node:sqlite"

const root = path.dirname(fileURLToPath(import.meta.url))
const workspace = path.dirname(root)
const dataDir = process.env.MONITOR_DATA_DIR || path.join(os.homedir(), ".agent-monitor", "data")
const eventsFile = path.join(dataDir, "events.jsonl")
const statusFile = path.join(dataDir, "status.json")
try {
  fs.mkdirSync(dataDir, { recursive: true })
} catch {}
const port = parseInt(process.env.MONITOR_PORT || "17890", 10)
const VER = Date.now()
const dbCandidates = [
  process.env.MONITOR_DB === "none" ? null : process.env.XDG_DATA_HOME ? path.join(process.env.XDG_DATA_HOME, "opencode", "opencode.db") : null,
  process.env.MONITOR_PROJECT ? path.join(process.env.MONITOR_PROJECT, "nuwaxcode", "home", ".local", "share", "opencode", "opencode.db") : null,
  path.join(workspace, "nuwaxcode", "home", ".local", "share", "opencode", "opencode.db"),
].filter(Boolean)
const dbPath = dbCandidates.find((p) => fs.existsSync(p)) || null

const ACT_LABELS = {
  thinking: "正在思考",
  responding: "正在回复",
  editing: "编辑文件中",
  terminal: "终端执行中",
  searching: "搜索代码中",
  reading: "读取文件中",
  subagent: "派发子智能体",
  web: "联网搜索中",
  computer: "操作电脑/浏览器",
  render: "渲染界面中",
  asking: "等待用户回答",
  tool: "调用工具中",
  compacting: "压缩上下文中",
  retry: "重试中",
  waiting: "等待模型响应",
  idle: "空闲",
  unknown: "未知",
}
const ACT_COLORS = {
  thinking: "#bc8cff",
  responding: "#3fb950",
  editing: "#d29922",
  terminal: "#58a6ff",
  searching: "#39c5cf",
  reading: "#39c5cf",
  subagent: "#58a6ff",
  web: "#39c5cf",
  computer: "#58a6ff",
  render: "#bc8cff",
  asking: "#d29922",
  tool: "#58a6ff",
  compacting: "#d29922",
  retry: "#f85149",
  waiting: "#8b949e",
  idle: "#8b949e",
  unknown: "#8b949e",
}
const toolCode = (t) => {
  if (!t) return "tool"
  const tl = String(t).toLowerCase()
  if (tl === "edit" || tl === "write" || tl === "apply_patch" || tl === "patch") return "editing"
  if (tl === "bash" || tl === "exec" || tl === "shell" || tl === "exec_command") return "terminal"
  if (tl === "grep" || tl === "glob") return "searching"
  if (tl === "read") return "reading"
  if (tl === "task" || tl === "spawn_agent" || tl === "agent") return "subagent"
  if (tl === "webfetch" || tl === "proxy_web_search" || tl === "websearch") return "web"
  if (tl.indexOf("chrome-devtools") === 0 || tl.indexOf("cua_") === 0) return "computer"
  if (tl.indexOf("nuwax-openui") === 0) return "render"
  if (tl.indexOf("ask-question") === 0 || tl.indexOf("ask_question") >= 0) return "asking"
  return "tool"
}

let db = null
const getDb = () => {
  if (!dbPath) return null
  if (db) return db
  try {
    db = new DatabaseSync(dbPath, { readOnly: true })
    return db
  } catch {
    return null
  }
}
const latestPart = (sids) => {
  const d = getDb()
  if (!d) return null
  try {
    let row
    if (sids.length) {
      const ph = sids.map(() => "?").join(",")
      row = d.prepare("SELECT session_id, time_updated, data FROM part WHERE session_id IN (" + ph + ") ORDER BY time_updated DESC LIMIT 1").get(...sids)
    } else {
      row = d.prepare("SELECT session_id, time_updated, data FROM part ORDER BY time_updated DESC LIMIT 1").get()
    }
    if (!row) return null
    let data = {}
    try {
      data = JSON.parse(row.data)
    } catch {}
    return { sessionID: row.session_id, ts: Number(row.time_updated), type: data.type, state: data.state && data.state.status, tool: data.tool }
  } catch {
    try {
      db.close()
    } catch {}
    db = null
    return null
  }
}

let curActivity = null
const activityHistory = []
const partFromEvents = (events) => {
  for (let i = (events || []).length - 1; i >= 0; i--) {
    const e = events[i]
    if (e.kind === "part.stream") return { ts: e.ts, type: e.partType, state: null, tool: null }
  }
  return null
}
const computeActivity = (status, events) => {
  const sids = Object.keys((status && status.sessions) || {})
  const s = (status && status.sessions && status.sessions[sids[0]]) || {}
  const now = Date.now()
  const part = latestPart(sids) || partFromEvents(events)
  let a
  if (s.compacting) a = { code: "compacting" }
  else if (s.status === "retry") a = { code: "retry" }
  else if (s.currentTool) a = { code: toolCode(s.currentTool.tool), tool: s.currentTool.tool }
  else if (s.status === "busy") {
    if (part && now - part.ts < 6000) {
      if (part.type === "reasoning") a = { code: "thinking" }
      else if (part.type === "text") a = { code: "responding" }
      else if (part.type === "tool" && part.state === "running") a = { code: toolCode(part.tool), tool: part.tool }
      else a = { code: "waiting" }
    } else a = { code: "waiting" }
  } else if (s.status === "idle") a = { code: "idle" }
  else a = { code: "unknown" }
  a.label = ACT_LABELS[a.code] || a.code
  a.color = ACT_COLORS[a.code] || "#8b949e"
  a.partType = part ? part.type : null
  a.partAgeMs = part ? now - part.ts : null
  if (!curActivity || curActivity.code !== a.code || curActivity.tool !== a.tool) {
    if (curActivity) curActivity.until = now
    curActivity = { ...a, ts: now, until: null }
    activityHistory.push(curActivity)
    if (activityHistory.length > 200) activityHistory.shift()
  }
  a.since = curActivity.ts
  a.ageMs = now - curActivity.ts
  return a
}

const html = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Agent 实时监控</title>
<style>
:root{--bg:#0d1117;--card:#161b22;--border:#30363d;--text:#e6edf3;--dim:#8b949e;--accent:#58a6ff;--green:#3fb950;--red:#f85149;--orange:#d29922;--purple:#bc8cff;--teal:#39c5cf}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--text);font-family:"Segoe UI","Microsoft YaHei",system-ui,sans-serif;font-size:14px;padding:16px}
.top{display:flex;align-items:center;gap:12px;margin-bottom:14px;flex-wrap:wrap}
.dot{width:10px;height:10px;border-radius:50%;background:var(--green);box-shadow:0 0 8px var(--green)}
.dot.err{background:var(--red);box-shadow:0 0 8px var(--red)}
h1{font-size:18px;font-weight:600}
.meta{color:var(--dim);font-size:12px}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:14px}
.kpi{background:var(--card);border:1px solid var(--border);border-radius:8px;padding:12px}
.kpi .label{color:var(--dim);font-size:12px;margin-bottom:6px}
.kpi .value{font-size:22px;font-weight:700;font-variant-numeric:tabular-nums}
.kpi .sub{color:var(--dim);font-size:11px;margin-top:4px}
.flash{animation:flash 0.8s ease-out}
@keyframes flash{from{background:rgba(31,111,235,0.35)}to{background:transparent}}
.grid{display:grid;grid-template-columns:1.2fr 1fr;gap:14px}
@media(max-width:900px){.grid{grid-template-columns:1fr}}
.card{background:var(--card);border:1px solid var(--border);border-radius:8px;padding:14px;margin-bottom:14px}
.card h2{font-size:14px;font-weight:600;margin-bottom:10px;color:var(--text)}
.card h2 span{color:var(--dim);font-weight:400;font-size:12px;margin-left:8px}
.feed{max-height:520px;overflow-y:auto;font-size:12px}
.ev{display:flex;gap:8px;padding:4px 6px;border-bottom:1px solid #21262d;align-items:baseline}
.ev.new{animation:flash 1s ease-out}
.ev .t{color:var(--dim);font-variant-numeric:tabular-nums;flex-shrink:0;width:62px}
.badge{flex-shrink:0;padding:1px 7px;border-radius:10px;font-size:11px;background:#21262d;color:var(--dim);min-width:96px;text-align:center}
.b-tool-start{background:#1f6feb33;color:var(--accent)}
.b-tool-end{background:#23863633;color:var(--green)}
.b-tool-error{background:#f8514933;color:var(--red)}
.b-step-finish{background:#bc8cff33;color:var(--purple)}
.b-compaction{background:#d2992233;color:var(--orange)}
.b-error{background:#f8514933;color:var(--red)}
.b-idle{background:#39c5cf33;color:var(--teal)}
.b-file{background:#39c5cf22;color:var(--teal)}
.ev .s{color:var(--text);word-break:break-all}
.bar-row{display:flex;align-items:center;gap:8px;margin-bottom:6px;font-size:12px}
.bar-row .name{width:130px;color:var(--dim);flex-shrink:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bar-track{flex:1;background:#21262d;border-radius:4px;height:14px;overflow:hidden}
.bar-fill{height:100%;background:var(--accent);border-radius:4px;transition:width 0.5s}
.bar-row .num{width:64px;text-align:right;font-variant-numeric:tabular-nums;flex-shrink:0}
.stack{display:flex;height:22px;border-radius:6px;overflow:hidden;margin:8px 0}
.stack div{transition:width 0.5s}
.legend{display:flex;flex-wrap:wrap;gap:10px;font-size:11px;color:var(--dim)}
.legend i{display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:4px}
table{width:100%;border-collapse:collapse;font-size:12px}
td{padding:5px 6px;border-bottom:1px solid #21262d;vertical-align:top}
td:first-child{color:var(--dim);width:130px}
.st{display:inline-block;padding:1px 8px;border-radius:10px;font-size:11px;font-weight:600}
.st-busy{background:#1f6feb33;color:var(--accent)}
.st-idle{background:#21262d;color:var(--dim)}
.st-compacting{background:#d2992233;color:var(--orange)}
.st-retry{background:#f8514933;color:var(--red)}
.st-unknown{background:#21262d;color:var(--dim)}
.sess-head{display:flex;align-items:center;gap:10px;margin-bottom:8px;flex-wrap:wrap}
.sess-id{color:var(--dim);font-size:11px;font-family:Consolas,monospace}
.tabs{display:flex;gap:6px;margin-bottom:10px;flex-wrap:wrap}
.tab{background:#21262d;border:1px solid var(--border);color:var(--dim);border-radius:6px;padding:4px 12px;font-size:12px;cursor:pointer}
.tab.active{background:#1f6feb33;border-color:var(--accent);color:var(--accent)}
.hist-table td:first-child{width:70px}
.hist-table .dur{color:var(--teal);font-variant-numeric:tabular-nums}
.hist-table .ok{color:var(--green)}
.hist-table .bad{color:var(--red)}
.hist-table .run{color:var(--accent)}
.activity{display:flex;align-items:center;gap:12px;background:var(--card);border:1px solid var(--border);border-radius:8px;padding:12px 16px;margin-bottom:14px}
.activity .pulse{width:12px;height:12px;border-radius:50%;flex-shrink:0;animation:pulse 1.2s infinite}
@keyframes pulse{0%{box-shadow:0 0 0 0 rgba(255,255,255,0.25)}70%{box-shadow:0 0 0 9px rgba(255,255,255,0)}100%{box-shadow:0 0 0 0 rgba(255,255,255,0)}}
.activity .alabel{font-size:17px;font-weight:700}
.activity .adetail{color:var(--dim);font-size:12px}
.dims{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:8px}
.dim{background:#21262d;border:1px solid var(--border);border-radius:6px;padding:8px 10px}
.dim.on{border-color:var(--accent);background:#1f6feb22}
.dim .dn{color:var(--dim);font-size:11px}
.dim .dv{font-size:13px;font-weight:600;margin-top:3px;word-break:break-all}
.dim.on .dv{color:var(--accent)}
.dim .dt{color:var(--dim);font-size:10px;margin-top:2px}
</style>
</head>
<body>
<div class="top">
  <div class="dot" id="dot"></div>
  <h1>Agent 实时监控</h1>
  <span class="meta" id="upd">连接中…</span>
  <span class="meta">数据源 .tmp/agent-status/ · 每秒刷新 · 仅本机访问</span>
</div>
<div class="activity" id="actBanner">
  <div class="pulse" id="actPulse"></div>
  <span class="alabel" id="actLabel">连接中…</span>
  <span class="adetail" id="actDetail"></span>
</div>
<div class="card">
  <h2>精细化状态矩阵 <span>各维度当前值 · 高亮 = 正在进行</span></h2>
  <div class="dims" id="dims"></div>
</div>
<div class="card">
  <h2>Agent / 模型身份 <span>谁在跑 · 用什么模型</span></h2>
  <table id="ident"></table>
</div>
<div class="kpis" id="kpis"></div>
<div class="grid">
  <div>
    <div class="card">
      <h2>实时事件流 <span id="evcount"></span></h2>
      <div class="feed" id="feed"></div>
    </div>
  </div>
  <div>
    <div class="card" id="sessions"></div>
    <div class="card">
      <h2>Token 构成 <span id="toktotal"></span></h2>
      <div class="stack" id="tokstack"></div>
      <div class="legend" id="toklegend"></div>
    </div>
    <div class="card">
      <h2>工具调用排行 <span>启动次数</span></h2>
      <div id="tools"></div>
    </div>
    <div class="card">
      <h2>事件分布 <span id="kindtotal"></span></h2>
      <div id="kinds"></div>
    </div>
  </div>
</div>
<div class="card">
  <h2>状态变迁历史 <span>按类型查看历史变化与持续时长，不止当前值</span></h2>
  <div class="tabs" id="histTabs"></div>
  <div id="histBody" style="max-height:380px;overflow-y:auto"></div>
</div>
<script>
var prevKpi = {};
var prevTopEv = "";
function fmtTime(ts){ var d = new Date(ts); return d.toLocaleTimeString("zh-CN",{hour12:false}); }
function fmtNum(n){ return (n||0).toLocaleString("en-US"); }
function esc(s){ return String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }
function badgeClass(kind, status){
  if(kind==="tool.end") return status==="error" ? "b-tool-error" : "b-tool-end";
  if(kind==="tool.start") return "b-tool-start";
  if(kind==="step.finish") return "b-step-finish";
  if(kind.indexOf("compaction")===0) return "b-compaction";
  if(kind==="session.error"||kind==="api.retry") return "b-error";
  if(kind==="session.idle") return "b-idle";
  if(kind.indexOf("file")===0) return "b-file";
  return "";
}
function evSummary(e){
  if(e.kind==="tool.start"||e.kind==="tool.end") return (e.tool||"")+" "+(e.title||e.status||"")+(e.durationMs!=null?" ("+e.durationMs+"ms)":"");
  if(e.kind==="step.finish") return "tokens "+fmtNum(e.tokens&&e.tokens.total)+" / "+(e.reason||"");
  if(e.kind==="session.status") return e.status+(e.retry?" attempt "+e.retry.attempt:"");
  if(e.kind==="compaction.start"||e.kind==="compaction.done") return (e.via||"")+(e.overflow?" overflow":"");
  if(e.kind==="plugin.loaded") return "pid "+e.pid;
  if(e.kind==="session.error") return (e.name||"")+": "+(e.message||"");
  if(e.kind==="file.edited"||e.kind==="file.watcher") return e.file||"";
  return "";
}
function kpi(label, value, sub, key){
  var changed = prevKpi[key] !== undefined && prevKpi[key] !== String(value);
  prevKpi[key] = String(value);
  return '<div class="kpi'+(changed?" flash":"")+'"><div class="label">'+label+'</div><div class="value">'+value+'</div><div class="sub">'+esc(sub||"")+'</div></div>';
}
function bars(el, entries, total){
  var max = Math.max.apply(null, entries.map(function(e){return e[1];}).concat([1]));
  el.innerHTML = entries.map(function(e){
    return '<div class="bar-row"><div class="name" title="'+esc(e[0])+'">'+esc(e[0])+'</div><div class="bar-track"><div class="bar-fill" style="width:'+(e[1]/max*100)+'%"></div></div><div class="num">'+fmtNum(e[1])+'</div></div>';
  }).join("") || '<span class="meta">暂无数据</span>';
}
function render(d){
  if(window.__ver && d.ver && d.ver!==window.__ver){ location.reload(); return; }
  window.__ver = d.ver;
  var st = d.stats||{}, status = d.status||{}, sessions = status.sessions||{};
  var act = d.activity||{};
  document.getElementById("actLabel").textContent = act.label||"未知";
  document.getElementById("actLabel").style.color = act.color||"#8b949e";
  document.getElementById("actPulse").style.background = act.color||"#8b949e";
  document.getElementById("actDetail").textContent = (act.tool?esc(act.tool)+" · ":"")+"已持续 "+fmtDur(act.ageMs)+(act.partType?" · 最新部件 "+esc(act.partType)+"（"+fmtDur(act.partAgeMs)+"前）":"");
  var dims = d.dimensions||{};
  document.getElementById("dims").innerHTML = Object.keys(dims).map(function(k){
    var x = dims[k];
    var t = x.since ? (x.active ? "已持续 "+fmtDur(d.now-x.since) : "最近 "+fmtTime(x.since)) : "";
    return '<div class="dim'+(x.active?" on":"")+'"><div class="dn">'+esc(x.label)+'</div><div class="dv">'+esc(x.value)+'</div><div class="dt">'+t+'</div></div>';
  }).join("");
  var id = d.identity||{};
  var irows = [
    ["运行时 harness", id.harness==="codex" ? ("Codex · "+(id.originator||"")+" "+(id.cliVersion||"")) : id.harness==="chatgpt" ? "ChatGPT / Codex 桌面版" : id.harness==="workbuddy" ? "WorkBuddy（腾讯）" : id.harness==="deepseek-harness" ? "DeepSeek Harness" : id.harness==="opencode" ? ("opencode（Nuwax 运行时）"+(id.runtimeVersion||"")) : (id.harness||"—")],
    ["平台智能体", id.platformAgent ? (id.platformAgent.agentName+"（agentId "+id.platformAgent.agentId+"）") : "—"],
    ["会话 agent", (id.agent||"—")+(id.mode?" · mode "+id.mode:"")],
    ["当前模型", (id.providerID?id.providerID+"/":"")+(id.modelID||id.model||"—")],
    ["推理强度", id.reasoningEffort||"—"],
    ["上下文窗口", typeof id.contextWindow==="number"?fmtNum(id.contextWindow):"—"],
    ["配置模型", id.envModel||"—"],
    ["会话标题", id.title||"—"],
    ["工作目录", id.directory||"—"]
  ];
  document.getElementById("ident").innerHTML = irows.map(function(r){return "<tr><td>"+r[0]+"</td><td>"+esc(r[1])+"</td></tr>";}).join("");
  var sids = Object.keys(sessions);
  var s = sids.length ? sessions[sids[0]] : {};
  var tok = st.tokens||{};
  var tokSum = (tok.input||0)+(tok.output||0)+(tok.reasoning||0)+(tok.cacheRead||0)+(tok.cacheWrite||0);
  document.getElementById("kpis").innerHTML =
    kpi("当前活动", '<span style="color:'+esc(act.color||"#8b949e")+'">'+esc(act.label||"未知")+'</span>', act.tool||"细粒度实时状态", "act") +
    kpi("当前模型", esc(id.modelID||id.model||"—"), id.providerID||id.harness||"", "model") +
    kpi("会话状态", '<span class="st st-'+esc(s.status||"unknown")+'">'+esc(s.status||"unknown")+'</span>', sids.length+" 个会话", "state") +
    kpi("当前工具", esc(s.currentTool ? s.currentTool.tool : "—"), s.currentTool ? s.currentTool.status : "无执行中工具", "tool") +
    kpi("模型步数", fmtNum(st.steps), "最近结束: "+(st.lastReason||"—"), "steps") +
    kpi("累计 Token", fmtNum(tokSum), "缓存读 "+fmtNum(tok.cacheRead), "tokens") +
    kpi("上下文压缩", fmtNum(s.compactionCount||0), s.compacting ? "压缩中…" : "未压缩", "comp") +
    kpi("事件总数", fmtNum(st.total), (st.firstTs?fmtTime(st.firstTs):"")+" 起", "events");
  var evs = (d.events||[]).slice().reverse();
  var topKey = evs.length ? evs[0].ts+evs[0].kind : "";
  var feedHtml = evs.slice(0,100).map(function(e,i){
    var isNew = prevTopEv && e.ts+e.kind===topKey && i===0 && prevTopEv!==topKey;
    return '<div class="ev'+(isNew?" new":"")+'"><span class="t">'+fmtTime(e.ts)+'</span><span class="badge '+badgeClass(e.kind,e.status)+'">'+esc(e.kind)+'</span><span class="s">'+esc(evSummary(e))+'</span></div>';
  }).join("");
  document.getElementById("feed").innerHTML = feedHtml || '<span class="meta">暂无事件</span>';
  prevTopEv = topKey;
  document.getElementById("evcount").textContent = "最近 "+evs.length+" 条 / 共 "+fmtNum(st.total)+" 条";
  var sessHtml = '<h2>会话快照 <span>'+sids.length+' 个会话</span></h2>';
  sids.forEach(function(id){
    var x = sessions[id];
    var rows = [
      ["会话 ID", '<span class="sess-id">'+esc(id)+'</span>'],
      ["状态", '<span class="st st-'+esc(x.status||"unknown")+'">'+esc(x.status||"unknown")+'</span>'+(x.retry?" · 重试 "+x.retry.attempt:"")],
      ["当前活动", '<span style="color:'+esc(act.color||"#8b949e")+'">'+esc(act.label||"未知")+'</span>'+(act.tool?" · "+esc(act.tool):"")],
      ["当前工具", x.currentTool ? esc(x.currentTool.tool)+" · "+esc(x.currentTool.status) : "—"],
      ["压缩", (x.compactionCount||0)+" 次"+(x.compacting?" · 压缩中":"")],
      ["Token", "入 "+fmtNum(x.tokens&&x.tokens.input)+" / 出 "+fmtNum(x.tokens&&x.tokens.output)+" / 推理 "+fmtNum(x.tokens&&x.tokens.reasoning)],
      ["上下文占用", x.contextUsage ? fmtNum(x.contextUsage.contextTokens)+" / "+fmtNum(x.contextUsage.limitTokens)+" ("+Math.round((x.contextUsage.ratio||0)*100)+"%)" : "待全量版插件"],
      ["最后模型", x.lastModel ? esc(x.lastModel.modelID) : "—"],
      ["最后错误", x.lastError ? esc(x.lastError.name) : "无"],
      ["代码变更", x.diff ? x.diff.files+" 文件 / +"+x.diff.additions+" -"+x.diff.deletions : "—"],
      ["更新时间", fmtTime(x.updatedAt)]
    ];
    sessHtml += '<div class="sess-head"><span class="st st-'+esc(x.status||"unknown")+'">'+esc(x.status||"unknown")+'</span><span class="sess-id">'+esc(id)+'</span></div><table>'+rows.map(function(r){return "<tr><td>"+r[0]+"</td><td>"+r[1]+"</td></tr>";}).join("")+'</table>';
  });
  document.getElementById("sessions").innerHTML = sessHtml || '<h2>会话快照</h2><span class="meta">暂无会话数据</span>';
  var segs = [["缓存读",tok.cacheRead||0,"#8b949e"],["输入",tok.input||0,"#58a6ff"],["输出",tok.output||0,"#3fb950"],["推理",tok.reasoning||0,"#bc8cff"],["缓存写",tok.cacheWrite||0,"#d29922"]];
  document.getElementById("tokstack").innerHTML = segs.map(function(g){ return tokSum>0&&g[1]>0 ? '<div style="width:'+(g[1]/tokSum*100)+'%;background:'+g[2]+'" title="'+g[0]+' '+fmtNum(g[1])+'"></div>' : ""; }).join("");
  document.getElementById("toklegend").innerHTML = segs.map(function(g){ return '<span><i style="background:'+g[2]+'"></i>'+g[0]+' '+fmtNum(g[1])+'</span>'; }).join("");
  document.getElementById("toktotal").textContent = "累计 "+fmtNum(tokSum);
  bars(document.getElementById("tools"), st.tools||[]);
  bars(document.getElementById("kinds"), st.kinds||[]);
  document.getElementById("kindtotal").textContent = fmtNum(st.total)+" 条";
  document.getElementById("upd").textContent = "更新于 "+fmtTime(d.now)+(status.heartbeatAt?" · 心跳 "+fmtTime(status.heartbeatAt):"")+" · pid "+(status.pid||"?");
  document.getElementById("dot").className = "dot";
  lastData = d;
  renderHist(d);
}
var lastData = null;
var histTab = "activity";
var histTabs = [["activity","活动"],["status","工作状态"],["tools","工具生命周期"],["compaction","压缩"],["errors","错误与重试"],["permissions","权限"]];
function fmtDur(ms){
  if(ms==null) return "进行中";
  if(ms<1000) return ms+"ms";
  if(ms<60000) return (ms/1000).toFixed(1)+"s";
  return Math.floor(ms/60000)+"m"+Math.round(ms%60000/1000)+"s";
}
function setHistTab(t){ histTab = t; if(lastData) renderHist(lastData); }
function renderHist(d){
  var h = d.histories||{};
  document.getElementById("histTabs").innerHTML = histTabs.map(function(t){
    var n = (h[t[0]]||[]).length;
    return '<button class="tab'+(histTab===t[0]?" active":"")+'" data-tab="'+t[0]+'">'+t[1]+' ('+n+')</button>';
  }).join("");
  var rows = [], head = [];
  if(histTab==="activity"){
    head = ["时间","活动","持续"];
    rows = (h.activity||[]).slice().reverse().map(function(x){
      return [fmtTime(x.ts), '<span style="color:'+esc(x.color||"#8b949e")+'">'+esc(x.label)+(x.tool?" · "+esc(x.tool):"")+'</span>', '<span class="dur">'+fmtDur(x.until?x.until-x.ts:null)+'</span>'];
    });
  } else if(histTab==="status"){
    head = ["时间","状态","持续"];
    rows = (h.status||[]).slice().reverse().map(function(x){
      return [fmtTime(x.ts), '<span class="st st-'+esc(x.status)+'">'+esc(x.status)+'</span>', '<span class="dur">'+fmtDur(x.until?x.until-x.ts:null)+'</span>'];
    });
  } else if(histTab==="tools"){
    head = ["工具","标题","开始","耗时","结果"];
    rows = (h.tools||[]).map(function(x){
      var cls = x.result==="completed"?"ok":x.result==="error"?"bad":"run";
      return [esc(x.tool), esc(x.title||""), fmtTime(x.startTs), '<span class="dur">'+fmtDur(x.durationMs)+'</span>', '<span class="'+cls+'">'+esc(x.result)+'</span>'];
    });
  } else if(histTab==="compaction"){
    head = ["时间","事件","来源","详情"];
    rows = (h.compaction||[]).map(function(x){
      return [fmtTime(x.ts), esc(x.kind==="compaction.start"?"开始":"完成"), esc(x.via||""), (x.overflow?"overflow触发 ":"")+(x.count!=null?"第"+x.count+"次":"")];
    });
  } else if(histTab==="errors"){
    head = ["时间","类型","详情"];
    rows = (h.errors||[]).map(function(x){
      var detail = (x.name||"")+(x.message?" · "+x.message:"")+(x.attempt!=null?" · 第"+x.attempt+"次":"")+(x.statusCode?" · HTTP "+x.statusCode:"");
      return [fmtTime(x.ts), esc(x.kind), '<span class="bad">'+esc(detail)+'</span>'];
    });
  } else {
    head = ["时间","事件","详情"];
    rows = (h.permissions||[]).map(function(x){
      var detail = (x.type||"")+(x.title?" · "+x.title:"")+(x.response?" → "+x.response:"")+(x.decision?" → "+x.decision:"");
      return [fmtTime(x.ts), esc(x.kind), esc(detail)];
    });
  }
  document.getElementById("histBody").innerHTML = rows.length
    ? '<table class="hist-table"><tr>'+head.map(function(c){return "<td>"+c+"</td>";}).join("")+'</tr>'+rows.map(function(r){return "<tr>"+r.map(function(c){return "<td>"+c+"</td>";}).join("")+"</tr>";}).join("")+'</table>'
    : '<span class="meta">该类型暂无历史记录</span>';
}
document.getElementById("histTabs").addEventListener("click", function(ev){
  var b = ev.target.closest("button[data-tab]");
  if(b) setHistTab(b.getAttribute("data-tab"));
});
function tick(){
  fetch("/api/state",{cache:"no-store"}).then(function(r){return r.json();}).then(render).catch(function(){
    document.getElementById("dot").className = "dot err";
    document.getElementById("upd").textContent = "连接失败，重试中…";
  });
}
setInterval(function(){ if(!document.hidden) tick(); }, 1000);
tick();
</script>
</body>
</html>`

let platformAgentCache = { at: 0, data: null }
const fetchPlatformAgent = async () => {
  const now = Date.now()
  if (platformAgentCache.data && now - platformAgentCache.at < 60000) return platformAgentCache.data
  const base = process.env.PLATFORM_BASE_URL
  const ak = process.env.SANDBOX_ACCESS_KEY
  if (!base || !ak) return null
  try {
    const convId = path.basename(workspace)
    const r = await fetch(base + "/api/v1/4sandbox/agent-task/list-running", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + ak }, body: JSON.stringify({ limit: 50 }) })
    const j = await r.json()
    const list = (j && j.data) || []
    const hit = list.find((x) => String(x.conversationId) === convId) || list[0]
    platformAgentCache = { at: now, data: hit ? { agentId: hit.agentId, agentName: hit.agentName, topic: hit.topic } : null }
    return platformAgentCache.data
  } catch {
    return platformAgentCache.data
  }
}

const identityFromDb = (sids) => {
  const d = getDb()
  if (!d) return null
  try {
    const ph = sids.map(() => "?").join(",")
    const row = sids.length
      ? d.prepare("SELECT id,agent,model,title,version,parent_id,directory FROM session WHERE id IN (" + ph + ") ORDER BY time_updated DESC LIMIT 1").get(...sids)
      : d.prepare("SELECT id,agent,model,title,version,parent_id,directory FROM session ORDER BY time_updated DESC LIMIT 1").get()
    let sm = null
    try {
      sm = row && row.model ? JSON.parse(row.model) : null
    } catch {}
    const msgs = sids.length
      ? d.prepare("SELECT data FROM message WHERE session_id IN (" + ph + ") ORDER BY time_updated DESC LIMIT 30").all(...sids)
      : d.prepare("SELECT data FROM message ORDER BY time_updated DESC LIMIT 30").all()
    let am = null
    for (const m of msgs) {
      let dd = {}
      try {
        dd = JSON.parse(m.data)
      } catch {}
      if (dd.role === "assistant") {
        am = dd
        break
      }
    }
    return {
      harness: "opencode",
      sessionID: row && row.id,
      agent: (row && row.agent) || (am && am.agent) || null,
      mode: am && am.mode,
      modelID: (am && am.modelID) || (sm && sm.id) || null,
      providerID: (am && am.providerID) || (sm && sm.providerID) || null,
      title: row && row.title,
      directory: row && row.directory,
      runtimeVersion: row && row.version,
      parentID: row && row.parent_id,
      envModel: process.env.OPENCODE_MODEL || null,
    }
  } catch {
    return null
  }
}

const readState = async () => {
  let status = null
  let events = []
  let histories = {}
  const stats = { total: 0, kinds: {}, tools: {}, steps: 0, lastReason: null, firstTs: null, lastTs: null, tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 } }
  try {
    status = JSON.parse(fs.readFileSync(path.join(dataDir, "status.json"), "utf8"))
  } catch {}
  try {
    const raw = fs.readFileSync(path.join(dataDir, "events.jsonl"), "utf8")
    const lines = raw.trim().split("\n")
    const parsed = []
    for (const line of lines) {
      let e
      try {
        e = JSON.parse(line)
      } catch {
        continue
      }
      parsed.push(e)
      stats.total += 1
      stats.kinds[e.kind] = (stats.kinds[e.kind] || 0) + 1
      if (!stats.firstTs) stats.firstTs = e.ts
      stats.lastTs = e.ts
      if ((e.kind === "tool.start" || e.kind === "tool.end") && e.tool) stats.tools[e.tool] = (stats.tools[e.tool] || 0) + (e.kind === "tool.start" ? 1 : 0)
      if (e.kind === "step.finish") {
        stats.steps += 1
        stats.lastReason = e.reason
        const t = e.tokens || {}
        stats.tokens.input += t.input || 0
        stats.tokens.output += t.output || 0
        stats.tokens.reasoning += t.reasoning || 0
        stats.tokens.cacheRead += (t.cache && t.cache.read) || 0
        stats.tokens.cacheWrite += (t.cache && t.cache.write) || 0
      }
    }
    events = parsed.slice(-150)
    const hist = { status: [], tools: [], compaction: [], errors: [], permissions: [] }
    const toolOpen = {}
    let lastStatus = null
    const pushStatus = (ts, st) => {
      if (lastStatus && lastStatus.status === st) return
      if (lastStatus) lastStatus.until = ts
      lastStatus = { ts, status: st, until: null }
      hist.status.push(lastStatus)
    }
    for (const e of parsed) {
      if (e.kind === "session.status") pushStatus(e.ts, e.status)
      else if (e.kind === "session.idle") pushStatus(e.ts, "idle")
      else if (e.kind === "tool.start" && e.status === "running") toolOpen[e.callID] = { tool: e.tool, title: e.title, startTs: e.ts, callID: e.callID }
      else if (e.kind === "tool.end") {
        const o = toolOpen[e.callID] || { tool: e.tool, title: e.title, startTs: e.ts, callID: e.callID }
        hist.tools.push({ tool: o.tool, title: o.title, startTs: o.startTs, endTs: e.ts, durationMs: e.durationMs != null ? e.durationMs : (o.startTs ? e.ts - o.startTs : null), result: e.status })
        delete toolOpen[e.callID]
      } else if (e.kind === "compaction.start" || e.kind === "compaction.done") hist.compaction.push({ ts: e.ts, kind: e.kind, via: e.via, overflow: e.overflow, count: e.count })
      else if (e.kind === "session.error" || e.kind === "api.retry" || (e.kind === "tool.end" && e.status === "error")) hist.errors.push({ ts: e.ts, kind: e.kind, name: e.name || e.tool, message: e.message || e.error, attempt: e.attempt, statusCode: e.statusCode })
      else if (e.kind === "permission.ask" || e.kind === "permission.reply" || e.kind === "permission.hook") hist.permissions.push({ ts: e.ts, kind: e.kind, type: e.type, title: e.title, response: e.response, decision: e.decision })
    }
    for (const o of Object.values(toolOpen)) hist.tools.push({ tool: o.tool, title: o.title, startTs: o.startTs, endTs: null, durationMs: null, result: "running" })
    hist.status = hist.status.slice(-60)
    hist.tools = hist.tools.slice(-60).reverse()
    hist.compaction = hist.compaction.slice(-40).reverse()
    hist.errors = hist.errors.slice(-40).reverse()
    hist.permissions = hist.permissions.slice(-40).reverse()
    histories = hist
  } catch {}
  stats.kinds = Object.entries(stats.kinds).sort((a, b) => b[1] - a[1])
  stats.tools = Object.entries(stats.tools).sort((a, b) => b[1] - a[1])
  const activity = computeActivity(status, events)
  histories.activity = activityHistory.slice(-60)
  const sids2 = Object.keys((status && status.sessions) || {})
  const s2 = (status && status.sessions && status.sessions[sids2[0]]) || {}
  const ct = s2.currentTool
  const tool = (ct && ct.tool) || ""
  const lastEdit = events.slice().reverse().find((e) => e.kind === "file.edited")
  const dim = (label, active, value, since) => ({ label, active, value, since: since || null })
  const toolL = tool.toLowerCase()
  const isEdit = ["edit", "write", "apply_patch", "patch"].indexOf(toolL) >= 0
  const isSearch = ["grep", "glob", "proxy_web_search", "webfetch", "websearch"].indexOf(toolL) >= 0
  const isComputer = toolL.indexOf("chrome-devtools") === 0 || toolL.indexOf("cua_") === 0
  const dimensions = {
    model: dim("模型活动", ["thinking", "responding", "waiting"].indexOf(activity.code) >= 0, activity.label, activity.since),
    tool: dim("工具调用", !!ct, ct ? tool + " · " + ct.status : "无", ct && ct.startedAt),
    edit: dim("文件编辑", isEdit, isEdit ? (ct.title || tool) : (lastEdit ? "最近 " + lastEdit.file : "无"), isEdit ? ct.startedAt : (lastEdit && lastEdit.ts)),
    search: dim("搜索", isSearch, isSearch ? tool : "无", isSearch && ct && ct.startedAt),
    computer: dim("电脑控制", isComputer, isComputer ? tool : "无", isComputer && ct && ct.startedAt),
    subagent: dim("子智能体", toolL === "task" || toolL === "spawn_agent", toolL === "task" || toolL === "spawn_agent" ? tool : "无", (toolL === "task" || toolL === "spawn_agent") && ct && ct.startedAt),
    compaction: dim("上下文压缩", !!s2.compacting, s2.compacting ? "压缩中" : (s2.compactionCount || 0) + " 次", s2.compactingStartedAt),
    permission: dim("权限等待", !!s2.pendingPermission, s2.pendingPermission ? (s2.pendingPermission.title || s2.pendingPermission.type) : "无", null),
    retry: dim("重试", s2.status === "retry", s2.retry ? "第 " + s2.retry.attempt + " 次" : "无", null),
  }
  let identity = (status && status.identity) || identityFromDb(sids2) || { harness: process.env.MONITOR_DB === "none" ? "external" : "opencode", envModel: process.env.OPENCODE_MODEL || null }
  if (identity.harness === "opencode") {
    const pa = await fetchPlatformAgent()
    if (pa) identity = { ...identity, platformAgent: pa }
  }
  return { now: Date.now(), ver: VER, status, events, stats, histories, activity, dimensions, identity }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1")
  if (req.method === "OPTIONS") {
    res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,POST,OPTIONS", "Access-Control-Allow-Headers": "Content-Type" })
    res.end()
    return
  }
  if (url.pathname === "/api/state") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" })
    res.end(JSON.stringify(await readState()))
    return
  }
  if (url.pathname === "/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" })
    res.end(html)
    return
  }
  if (url.pathname === "/api/ingest" && req.method === "POST") {
    let body = ""
    req.on("data", (c) => (body += c))
    req.on("end", () => {
      try {
        const j = JSON.parse(body)
        const evs = Array.isArray(j.events) ? j.events : j.kind ? [j] : []
        for (const e of evs) {
          const ev = { ...e, ts: e.ts || Date.now(), kind: e.kind, sessionID: e.sessionID || null }
          fs.appendFileSync(eventsFile, JSON.stringify(ev) + "\n")
        }
        if (j.identity || j.status) {
          let st = {}
          try {
            st = JSON.parse(fs.readFileSync(statusFile, "utf8"))
          } catch {}
          if (j.identity) st.identity = { ...st.identity, ...j.identity }
          if (j.status) {
            st.sessions = st.sessions || {}
            for (const [sid, patch] of Object.entries(j.status)) st.sessions[sid] = { ...st.sessions[sid], ...patch, updatedAt: Date.now() }
          }
          st.pid = st.pid || process.pid
          fs.writeFileSync(statusFile, JSON.stringify(st, null, 2))
        }
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ ok: true, appended: evs.length }))
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ ok: false, error: String(e) }))
      }
    })
    return
  }
  if (url.pathname === "/favicon.ico") {
    res.writeHead(204)
    res.end()
    return
  }
  res.writeHead(404, { "Content-Type": "text/plain" })
  res.end("not found")
})

server.listen(port, "127.0.0.1", () => {
  console.log("agent monitor listening on http://127.0.0.1:" + port)
})
