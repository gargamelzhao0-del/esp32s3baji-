window.__ModuleLoader__.load({
  id: "agent-monitor-dsh/float",
  factory(require) {
    const React = require("react")
    const h = React.createElement
    const port = (typeof window !== "undefined" && window.__AGENT_MONITOR_PORT__) || 17893
    const base = "http://127.0.0.1:" + port

    function FloatWidget() {
      const [state, setState] = React.useState(null)
      const [open, setOpen] = React.useState(false)
      React.useEffect(() => {
        let alive = true
        const tick = () => {
          fetch(base + "/api/state", { cache: "no-store" })
            .then((r) => r.json())
            .then((d) => {
              if (alive) setState(d)
            })
            .catch(() => {})
        }
        tick()
        const t = setInterval(tick, 2000)
        return () => {
          alive = false
          clearInterval(t)
        }
      }, [])
      const act = (state && state.activity) || {}
      const ident = (state && state.identity) || {}
      const stats = (state && state.stats) || {}
      const color = act.color || "#8b949e"
      const pill = h(
        "button",
        {
          onClick: () => setOpen(!open),
          title: "Agent Monitor",
          style: {
            position: "fixed",
            right: 16,
            bottom: 16,
            zIndex: 99999,
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "8px 14px",
            borderRadius: 999,
            border: "1px solid #30363d",
            background: "#161b22",
            color: "#e6edf3",
            cursor: "pointer",
            fontSize: 12,
            boxShadow: "0 4px 16px rgba(0,0,0,.4)",
          },
        },
        h("span", { style: { width: 8, height: 8, borderRadius: 999, background: color, display: "inline-block" } }),
        h("span", null, act.label || "Agent"),
        h("span", { style: { color: "#8b949e" } }, (ident.modelID || ident.model || "") + " · " + (stats.total || 0) + " ev")
      )
      const panel = open
        ? h(
            "div",
            {
              style: {
                position: "fixed",
                right: 16,
                bottom: 60,
                zIndex: 99998,
                width: 440,
                height: 600,
                border: "1px solid #30363d",
                borderRadius: 12,
                overflow: "hidden",
                background: "#0d1117",
                boxShadow: "0 8px 32px rgba(0,0,0,.5)",
              },
            },
            h(
              "div",
              { style: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 10px", background: "#161b22", color: "#8b949e", fontSize: 11 } },
              h("span", null, "Agent Monitor"),
              h("a", { href: base + "/", target: "_blank", rel: "noreferrer", style: { color: "#58a6ff", textDecoration: "none" } }, "新窗口打开 ↗")
            ),
            h("iframe", { src: base + "/", style: { width: "100%", height: "calc(100% - 28px)", border: "none" } })
          )
        : null
      return h("div", null, pill, panel)
    }

    return {
      inject: ["slots"],
      apply(ctx) {
        ctx.slots.inject("conversation.composer.dock", () =>
          ctx.slots.register({ name: "conversation.composer.dock", id: "agent-monitor-float", order: 9 }, FloatWidget)
        )
      },
    }
  },
})
