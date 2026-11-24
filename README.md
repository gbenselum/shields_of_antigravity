# S.H.I.E.L.D. — Shields of Antigravity

> *Sometimes Humans Ignore Events, Logs & Diagnostics*

An Antigravity plugin and MCP App that adds a **S.H.I.E.L.D.** button to the left sidebar, opening a full-page visual operations dashboard in the main panel to monitor all running Antigravity agents and conversations in real time.

## Features

- **Live Telemetry Radar & KPI Cards**: Active, Standby, Idle, and Error counts with instant filtering and search.
- **Agent Operation Cards**: Project badge, live status indicator, current task, progress checklist, **In / Out / Cached** token counts, and auto-refresh every 4 seconds.
- **Live Follow Drawer**: Double-click any agent card to stream its recent steps, tool calls, and messages—and send follow-up instructions directly to the agent from inside S.H.I.E.L.D.
- **Artifacts Inspector**: Infinity Gauntlet button on every card to browse and open artifacts saved by that agent.
- **GitHub & Actions Integration**: Automatic `.git/config` detection with quick links to the GitHub repository and GitHub Actions (with a live green/yellow workflow status dot).
- **Error Diagnostics**: Server-side logging to `shield.log` plus an in-UI diagnostic error banner.

## Install

Clone into your Antigravity plugins directory:

```bash
git clone https://github.com/gbenselum/shields_of_antigravity.git ~/.gemini/config/plugins/shield
```

Antigravity discovers the plugin automatically—click **S.H.I.E.L.D.** in the left sidebar.

## Rebuilding the UI

```bash
cd ~/.gemini/config/plugins/shield/ui
npm install
npm run build
```
