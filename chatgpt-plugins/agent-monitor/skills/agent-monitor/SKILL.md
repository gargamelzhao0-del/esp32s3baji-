---
name: agent-monitor
description: Open and read the local Agent Monitor dashboard showing real-time agent activity, tool calls, token usage, errors and compaction. Use when the user asks about the monitor, agent activity status, or the observability dashboard.
---

# Agent Monitor

The Agent Monitor plugin streams this client's lifecycle events to a local-only server.

- Dashboard: http://127.0.0.1:17894
- State API: http://127.0.0.1:17894/api/state (JSON: activity, identity, stats, events, histories)

When asked about current activity, fetch the state API and summarize: current activity label, active tool, session status, cumulative tokens, recent errors. All data stays on 127.0.0.1; never send it to external services.

If the dashboard is unreachable, tell the user the monitor server starts automatically on the next hook event (send any message in a new conversation), or run `node <plugin-root>/server/server.mjs` with `MONITOR_PORT=17894`.