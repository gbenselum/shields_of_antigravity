import {
  App,
  applyDocumentTheme,
  applyHostStyleVariables,
} from '@modelcontextprotocol/ext-apps';

declare const __GAUNTLET_ICON__: string;
declare const __WRENCH_ICON__: string;

interface StepItem {
  title: string;
  status: string;
}

interface ArtifactItem {
  name: string;
  path: string;
  size: number;
}

interface AgentInfo {
  id: string;
  shortId: string;
  project: string;
  projectPath?: string;
  githubUrl?: string;
  actionsUrl?: string;
  actionsRunning?: boolean;
  state: 'ACTIVE' | 'STANDBY' | 'IDLE' | 'ERROR';
  task: string;
  prompt: string;
  model: string;
  steps: StepItem[];
  stepCount: number;
  lastTool: string;
  subagents: string[];
  artifacts?: ArtifactItem[];
  artifactCount?: number;
  tokens: { input: number; output: number; cached?: number };
  ageSeconds: number;
  updatedAt: string;
}

interface TelemetryPayload {
  timestamp: string;
  brainDir: string;
  logPath?: string;
  errors?: string[];
  summary: {
    total: number;
    active: number;
    standby: number;
    idle: number;
    error: number;
  };
  agents: AgentInfo[];
}

interface FeedEvent {
  step: number;
  type: string;
  status: string;
  time: string;
  tools: string[];
  text: string;
}

let currentData: TelemetryPayload | null = null;
let selectedFilter: 'ALL' | 'ACTIVE' | 'STANDBY' | 'IDLE' | 'ERROR' = 'ALL';
let searchQuery = '';
let autoRefresh = true;
let isRefreshing = false;
let pollTimer: number | null = null;
let followingAgentId: string | null = null;
let drawerTab: 'feed' | 'artifacts' = 'feed';
let followEvents: FeedEvent[] = [];
let followToast = '';
let replyDraft = '';
let isSending = false;
let clientErrors: string[] = [];

function logClientError(context: string, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  const entry = `[${new Date().toLocaleTimeString()}] ${context}: ${msg}`;
  console.error('[S.H.I.E.L.D.]', entry, err);
  clientErrors = [entry, ...clientErrors].slice(0, 20);
}

const app = new App({ name: 'S.H.I.E.L.D.', version: '1.0.0' }, {});

function esc(str: string): string {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatAge(seconds: number): string {
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function formatTokens(n: number | undefined): string {
  const val = Number(n || 0);
  if (val >= 1_000_000) return `${(val / 1_000_000).toFixed(2)}M`;
  if (val >= 1_000) return `${(val / 1_000).toFixed(1)}k`;
  return String(val);
}

function renderRadar(agents: AgentInfo[]): string {
  const blips = agents.slice(0, 18).map((a, idx) => {
    const angle = (idx * 137.5 * Math.PI) / 180;
    const radius = a.state === 'ACTIVE' ? 24 + (idx % 3) * 10 : a.state === 'STANDBY' ? 48 + (idx % 2) * 8 : 64;
    const x = 80 + Math.cos(angle) * radius;
    const y = 80 + Math.sin(angle) * radius;
    const color =
      a.state === 'ACTIVE' ? '#10b981' :
      a.state === 'ERROR' ? '#ef4444' :
      a.state === 'STANDBY' ? '#f59e0b' : '#64748b';
    const r = a.state === 'ACTIVE' || a.state === 'ERROR' ? 4 : 2.8;
    return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r}" fill="${color}">
      <title>${esc(a.project)} — ${esc(a.state)}: ${esc(a.task)}</title>
    </circle>`;
  }).join('');

  return `
    <div class="radar-card">
      <svg class="radar-svg" viewBox="0 0 160 160" aria-label="Agent Activity Radar">
        <defs>
          <linearGradient id="sweepGrad" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stop-color="rgba(56,189,248,0)" />
            <stop offset="100%" stop-color="rgba(56,189,248,0.38)" />
          </linearGradient>
        </defs>
        <circle cx="80" cy="80" r="72" fill="none" stroke="rgba(56,189,248,0.22)" stroke-width="1" />
        <circle cx="80" cy="80" r="50" fill="none" stroke="rgba(56,189,248,0.16)" stroke-width="1" />
        <circle cx="80" cy="80" r="28" fill="none" stroke="rgba(56,189,248,0.16)" stroke-width="1" />
        <line x1="80" y1="8" x2="80" y2="152" stroke="rgba(56,189,248,0.12)" stroke-width="1" />
        <line x1="8" y1="80" x2="152" y2="80" stroke="rgba(56,189,248,0.12)" stroke-width="1" />
        <g class="radar-sweep">
          <path d="M80,80 L80,8 A72,72 0 0,1 142,44 Z" fill="url(#sweepGrad)" />
        </g>
        ${blips}
        <circle cx="80" cy="80" r="3" fill="#38bdf8" />
      </svg>
      <div class="radar-caption">LIVE TELEMETRY SCAN</div>
    </div>
  `;
}

function renderSteps(steps: StepItem[]): string {
  if (!steps || steps.length === 0) return '';
  const doneCount = steps.filter((s) => s.status === 'done').length;
  const pct = Math.round((doneCount / steps.length) * 100);
  const visible = steps.slice(0, 4);
  const items = visible.map((s) => {
    const icon = s.status === 'done' ? '✓' : s.status === 'in_progress' ? '▶' : s.status === 'failed' ? '✕' : '○';
    return `<div class="step-item ${esc(s.status)}"><span>${icon}</span><span>${esc(s.title)}</span></div>`;
  }).join('');

  return `
    <div class="steps-wrap">
      <div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>
      <div class="step-list">${items}</div>
    </div>
  `;
}

function renderCard(agent: AgentInfo): string {
  const pulseClass = agent.state === 'ACTIVE' || agent.state === 'ERROR' ? 'pulse' : '';
  const subagentChips = agent.subagents.map((s) => `<span class="chip">SUB: ${esc(s)}</span>`).join('');
  const toolChip = agent.lastTool ? `<span class="chip">TOOL: ${esc(agent.lastTool)}</span>` : '';

  const ghBtn = agent.githubUrl
    ? `<button class="actions-btn" data-open-url="${esc(agent.githubUrl)}" title="Open GitHub Repository: ${esc(agent.githubUrl)}">
         <svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>
       </button>`
    : '';

  const actionsBtn = agent.actionsUrl
    ? `<button class="actions-btn" data-open-url="${esc(agent.actionsUrl)}" title="GitHub Actions (${agent.actionsRunning ? 'Workflow Running' : 'Idle'})">
         ${__WRENCH_ICON__ ? `<img class="artifact-icon" src="${__WRENCH_ICON__}" alt="Actions" />` : '🔧'}
         <span class="actions-dot ${agent.actionsRunning ? 'running' : 'idle'}"></span>
       </button>`
    : '';

  return `
    <article class="agent-card state-${esc(agent.state)}" data-agent-id="${esc(agent.id)}" title="Double-click to follow agent">
      <div class="card-head">
        <div class="project-wrap">
          <div class="project-badge" title="${esc(agent.project)}">
            <span>◈</span>
            <span>${esc(agent.project)}</span>
          </div>
        </div>
        <div class="state-badge ${esc(agent.state)}">
          <span class="dot ${pulseClass}"></span>
          <span>${esc(agent.state)}</span>
        </div>
      </div>

      <div class="task-box">
        <div class="task-label">Current Task</div>
        <div class="task-text" title="${esc(agent.task)}">${esc(agent.task)}</div>
        ${agent.prompt && agent.prompt !== agent.task ? `<div class="prompt-text" title="${esc(agent.prompt)}">${esc(agent.prompt)}</div>` : ''}
      </div>

      ${renderSteps(agent.steps)}

      <div class="token-row">
        <div class="tok" title="Input tokens: ${(agent.tokens?.input || 0).toLocaleString()}">
          <span class="tok-label">In</span>
          <span class="tok-val in">${formatTokens(agent.tokens?.input)}</span>
        </div>
        <div class="tok" title="Output tokens: ${(agent.tokens?.output || 0).toLocaleString()}">
          <span class="tok-label">Out</span>
          <span class="tok-val out">${formatTokens(agent.tokens?.output)}</span>
        </div>
        <div class="tok" title="Cached tokens: ${(agent.tokens?.cached || 0).toLocaleString()}">
          <span class="tok-label">Cached</span>
          <span class="tok-val cached">${formatTokens(agent.tokens?.cached)}</span>
        </div>
      </div>

      ${subagentChips || toolChip ? `<div class="chips">${toolChip}${subagentChips}</div>` : ''}

      <div class="card-foot">
        <span>#${esc(agent.shortId)} · ${agent.stepCount}s · ${formatAge(agent.ageSeconds)}</span>
        <div class="card-actions">
          <button class="artifact-btn" data-open-artifacts="${esc(agent.id)}" title="View Artifacts (${agent.artifactCount || 0})">
            ${__GAUNTLET_ICON__ ? `<img class="artifact-icon" src="${__GAUNTLET_ICON__}" alt="Artifacts" />` : '✦'}
            <span>${agent.artifactCount || 0}</span>
          </button>
          ${ghBtn}
          ${actionsBtn}
          <button class="btn" style="padding:4px 8px;font-size:11px" data-goto-conv="${esc(agent.id)}" title="Open Live Follow">↗</button>
        </div>
      </div>
    </article>
  `;
}

function render(): void {
  const root = document.getElementById('root');
  if (!root) return;

  if (!currentData) {
    root.innerHTML = `<div class="shell"><div class="empty">Initializing S.H.I.E.L.D. telemetry link…</div></div>`;
    return;
  }

  const { summary, agents, timestamp } = currentData;
  const q = searchQuery.trim().toLowerCase();
  const filtered = agents.filter((a) => {
    if (selectedFilter !== 'ALL' && a.state !== selectedFilter) return false;
    if (!q) return true;
    return (
      a.project.toLowerCase().includes(q) ||
      a.task.toLowerCase().includes(q) ||
      a.prompt.toLowerCase().includes(q) ||
      a.shortId.toLowerCase().includes(q)
    );
  });

  const timeStr = new Date(timestamp).toLocaleTimeString();

  const allErrors = [...(currentData.errors || []).map((e) => `[SERVER] ${e}`), ...clientErrors];
  const errorPanelHtml = allErrors.length > 0 ? `
    <section class="error-panel">
      <div class="error-panel-head">
        <span>⚠ DIAGNOSTIC LOG (${allErrors.length}) ${currentData.logPath ? `· ${esc(currentData.logPath)}` : ''}</span>
        <button class="btn" id="clearErrorsBtn">Clear</button>
      </div>
      <div class="error-list">
        ${allErrors.map((e) => `<div>${esc(e)}</div>`).join('')}
      </div>
    </section>
  ` : '';

  root.innerHTML = `
    <div class="shell">
      <header class="topbar">
        <div class="brand">
          <svg class="emblem" viewBox="0 0 64 64" fill="none">
            <circle cx="32" cy="32" r="29" stroke="#38bdf8" stroke-width="2.5" fill="rgba(56,189,248,0.10)"/>
            <circle cx="32" cy="32" r="22" stroke="#38bdf8" stroke-width="1.2" stroke-dasharray="4 3"/>
            <path d="M32 14 L46 24 L42 44 L32 51 L22 44 L18 24 Z" fill="rgba(56,189,248,0.22)" stroke="#38bdf8" stroke-width="2"/>
            <path d="M32 20 L38 30 L32 42 L26 30 Z" fill="#38bdf8"/>
          </svg>
          <div>
            <div class="brand-title">
              <span>S.H.I.E.L.D.</span>
              <span class="live-pill"><span class="dot pulse"></span>${autoRefresh ? 'LIVE' : 'PAUSED'}</span>
            </div>
            <div class="brand-sub">Sometimes Humans Ignore Events, Logs &amp; Diagnostics</div>
          </div>
        </div>
        <div class="controls">
          <span class="timestamp">SYNC ${esc(timeStr)}</span>
          <button class="btn ${autoRefresh ? 'active' : ''}" id="toggleAuto">${autoRefresh ? 'Auto-Scan: ON' : 'Auto-Scan: OFF'}</button>
          <button class="btn" id="refreshBtn">${isRefreshing ? 'Scanning…' : '↻ Refresh'}</button>
        </div>
      </header>

      ${errorPanelHtml}

      <section class="overview">
        ${renderRadar(agents)}
        <div class="stats-grid">
          <div class="stat-card ${selectedFilter === 'ACTIVE' ? 'selected' : ''}" data-filter="ACTIVE">
            <div class="stat-label"><span>Active Agents</span><span class="dot pulse c-active"></span></div>
            <div class="stat-value c-active">${summary.active}</div>
            <div class="stat-sub">Currently executing</div>
          </div>
          <div class="stat-card ${selectedFilter === 'STANDBY' ? 'selected' : ''}" data-filter="STANDBY">
            <div class="stat-label"><span>Standby</span><span class="dot c-standby"></span></div>
            <div class="stat-value c-standby">${summary.standby}</div>
            <div class="stat-sub">Active within 15m</div>
          </div>
          <div class="stat-card ${selectedFilter === 'IDLE' ? 'selected' : ''}" data-filter="IDLE">
            <div class="stat-label"><span>Idle / Archive</span><span class="dot c-idle"></span></div>
            <div class="stat-value c-idle">${summary.idle}</div>
            <div class="stat-sub">Completed sessions</div>
          </div>
          <div class="stat-card ${selectedFilter === 'ERROR' ? 'selected' : ''}" data-filter="ERROR">
            <div class="stat-label"><span>Alerts</span><span class="dot c-error"></span></div>
            <div class="stat-value c-error">${summary.error}</div>
            <div class="stat-sub">Needs attention</div>
          </div>
        </div>
      </section>

      <section class="toolbar">
        <div class="tabs">
          ${(['ALL', 'ACTIVE', 'STANDBY', 'IDLE', 'ERROR'] as const).map((f) => `
            <button class="btn ${selectedFilter === f ? 'active' : ''}" data-tab="${f}">
              ${f === 'ALL' ? `All (${summary.total})` : f}
            </button>
          `).join('')}
        </div>
        <input class="search" id="searchInput" type="search" placeholder="Filter by project, task, or ID…" value="${esc(searchQuery)}" />
      </section>

      <main class="grid">
        ${filtered.length > 0 ? filtered.map(renderCard).join('') : `<div class="empty">No agents match the current filter.</div>`}
      </main>
    </div>
    ${renderDrawer()}
  `;

  document.getElementById('refreshBtn')?.addEventListener('click', () => void refreshNow());
  document.getElementById('toggleAuto')?.addEventListener('click', () => {
    autoRefresh = !autoRefresh;
    setupPolling();
    render();
  });

  document.querySelectorAll('[data-agent-id]').forEach((el) => {
    el.addEventListener('dblclick', () => {
      const id = el.getAttribute('data-agent-id');
      if (id) {
        drawerTab = 'feed';
        void openFollow(id, false);
      }
    });
  });

  document.querySelectorAll('[data-open-artifacts]').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = el.getAttribute('data-open-artifacts');
      if (id) {
        drawerTab = 'artifacts';
        void openFollow(id, false);
      }
    });
  });

  document.querySelectorAll('[data-goto-conv]').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = el.getAttribute('data-goto-conv');
      if (id) {
        drawerTab = 'feed';
        void openFollow(id, false, 'open_conversation');
      }
    });
  });

  document.getElementById('gotoConvBtn')?.addEventListener('click', () => {
    if (followingAgentId) void openFollow(followingAgentId, false, 'open_conversation');
  });

  document.getElementById('openTermBtn')?.addEventListener('click', () => {
    if (followingAgentId) void openFollow(followingAgentId, false, 'open_terminal');
  });

  document.getElementById('drawerTabFeed')?.addEventListener('click', () => {
    drawerTab = 'feed';
    render();
  });

  document.getElementById('drawerTabArtifacts')?.addEventListener('click', () => {
    drawerTab = 'artifacts';
    render();
  });

  document.querySelectorAll('[data-open-url]').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const url = el.getAttribute('data-open-url');
      if (url) {
        void app.openLink({ url }).catch((err) => logClientError('openLink', err));
      }
    });
  });

  document.querySelectorAll('[data-artifact-path]').forEach((el) => {
    el.addEventListener('click', () => {
      const p = el.getAttribute('data-artifact-path') || '';
      if (followingAgentId) void openFollow(followingAgentId, false, 'open_artifact', p);
    });
  });

  document.getElementById('closeDrawer')?.addEventListener('click', () => {
    followingAgentId = null;
    followEvents = [];
    followToast = '';
    render();
  });

  document.getElementById('drawerBackdrop')?.addEventListener('click', (e) => {
    if ((e.target as HTMLElement)?.id === 'drawerBackdrop') {
      followingAgentId = null;
      followEvents = [];
      followToast = '';
      render();
    }
  });

  document.getElementById('openFolderBtn')?.addEventListener('click', () => {
    if (followingAgentId) void openFollow(followingAgentId, true);
  });

  document.getElementById('replyForm')?.addEventListener('submit', (e) => {
    e.preventDefault();
    if (followingAgentId && replyDraft.trim()) {
      void dispatchToAgent(followingAgentId, replyDraft.trim());
    }
  });

  const replyEl = document.getElementById('replyInput') as HTMLInputElement | null;
  if (replyEl) {
    replyEl.addEventListener('input', (e) => {
      replyDraft = (e.target as HTMLInputElement).value;
    });
  }

  document.getElementById('clearErrorsBtn')?.addEventListener('click', () => {
    clientErrors = [];
    if (currentData) currentData.errors = [];
    render();
  });

  const searchEl = document.getElementById('searchInput') as HTMLInputElement | null;
  if (searchEl) {
    searchEl.addEventListener('input', (e) => {
      searchQuery = (e.target as HTMLInputElement).value;
      render();
      const restored = document.getElementById('searchInput') as HTMLInputElement | null;
      if (restored) {
        restored.focus();
        restored.setSelectionRange(searchQuery.length, searchQuery.length);
      }
    });
  }

  document.querySelectorAll('[data-tab]').forEach((el) => {
    el.addEventListener('click', () => {
      selectedFilter = (el.getAttribute('data-tab') as typeof selectedFilter) || 'ALL';
      render();
    });
  });

  document.querySelectorAll('[data-filter]').forEach((el) => {
    el.addEventListener('click', () => {
      const target = (el.getAttribute('data-filter') as typeof selectedFilter) || 'ALL';
      selectedFilter = selectedFilter === target ? 'ALL' : target;
      render();
    });
  });
}

function renderDrawer(): string {
  if (!followingAgentId || !currentData) return '';
  const agent = currentData.agents.find((a) => a.id === followingAgentId);
  if (!agent) return '';

  const feedHtml = followEvents.length > 0
    ? [...followEvents].reverse().map((ev) => `
        <div class="feed-item">
          <div class="feed-meta">
            <span>STEP #${ev.step ?? '?'} · ${esc(ev.type)}</span>
            <span>${esc(ev.status)}</span>
          </div>
          ${ev.tools.length > 0 ? `<div class="feed-tools">⚡ ${esc(ev.tools.join(' · '))}</div>` : ''}
          ${ev.text ? `<div class="feed-text">${esc(ev.text)}</div>` : ''}
        </div>
      `).join('')
    : `<div class="empty">Loading live conversation feed…</div>`;

  const artifacts = agent.artifacts || [];
  const artifactsHtml = artifacts.length > 0
    ? artifacts.map((art) => `
        <div class="artifact-row" data-artifact-path="${esc(art.path)}" title="Click to open ${esc(art.name)}">
          <div style="display:flex;align-items:center;gap:8px;min-width:0">
            ${__GAUNTLET_ICON__ ? `<img class="artifact-icon" src="${__GAUNTLET_ICON__}" alt="" />` : '✦'}
            <span style="font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(art.name)}</span>
          </div>
          <span class="timestamp">${(art.size / 1024).toFixed(1)} KB ↗</span>
        </div>
      `).join('')
    : `<div class="empty">No artifacts saved for this agent yet.</div>`;

  return `
    <div class="drawer-backdrop" id="drawerBackdrop">
      <aside class="drawer">
        <div class="drawer-head">
          <div>
            <div class="project-badge">◈ ${esc(agent.project)}</div>
            <div class="task-text" style="margin-top:8px">${esc(agent.task)}</div>
            <div class="timestamp" style="margin-top:4px">conversation://${esc(agent.id)}</div>
            ${followToast ? `<div class="toast" style="margin-top:4px">${esc(followToast)}</div>` : ''}
          </div>
          <button class="btn" id="closeDrawer">✕</button>
        </div>
        <div class="drawer-actions">
          <button class="btn active" id="gotoConvBtn">📋 Copy Conversation ID</button>
          ${agent.projectPath ? `<button class="btn" id="openFolderBtn">📁 Project Folder</button>` : ''}
          ${agent.githubUrl ? `<button class="btn" data-open-url="${esc(agent.githubUrl)}">GitHub ↗</button>` : ''}
        </div>
        <div class="drawer-actions">
          <button class="btn ${drawerTab === 'feed' ? 'active' : ''}" id="drawerTabFeed">Live Feed</button>
          <button class="artifact-btn" id="drawerTabArtifacts">
            ${__GAUNTLET_ICON__ ? `<img class="artifact-icon" src="${__GAUNTLET_ICON__}" alt="" />` : '✦'}
            <span>Artifacts (${artifacts.length})</span>
          </button>
          <span class="chip">IN ${formatTokens(agent.tokens?.input)}</span>
          <span class="chip">OUT ${formatTokens(agent.tokens?.output)}</span>
          <span class="chip">CACHED ${formatTokens(agent.tokens?.cached)}</span>
        </div>
        ${drawerTab === 'artifacts' ? `<div class="artifact-list">${artifactsHtml}</div>` : `<div class="feed">${feedHtml}</div>`}
        <form class="reply-form" id="replyForm">
          <input class="reply-input" id="replyInput" type="text" placeholder="Send instruction directly to this agent…" value="${esc(replyDraft)}" ${isSending ? 'disabled' : ''} />
          <button class="btn active" type="submit" ${isSending ? 'disabled' : ''}>${isSending ? 'Sending…' : 'Send ↵'}</button>
        </form>
      </aside>
    </div>
  `;
}

async function dispatchToAgent(agentId: string, message: string): Promise<void> {
  if (isSending) return;
  isSending = true;
  const agent = currentData?.agents.find((a) => a.id === agentId);
  render();
  try {
    const res = await app.callServerTool({
      name: 'send_to_agent',
      arguments: {
        id: agentId,
        message,
        projectPath: agent?.projectPath || '',
      },
    });
    const sc = res?.structuredContent as { ok?: boolean; statusMsg?: string } | undefined;
    followToast = sc?.statusMsg || 'Dispatched to agent';
    if (sc?.ok !== false) {
      replyDraft = '';
      drawerTab = 'feed';
    }
  } catch (err) {
    logClientError('send_to_agent', err);
    followToast = `Send failed: ${err instanceof Error ? err.message : String(err)}`;
  } finally {
    isSending = false;
    render();
    setTimeout(() => void refreshNow(), 1500);
  }
}

async function openFollow(agentId: string, openFolder: boolean, action = '', artifactPath = ''): Promise<void> {
  followingAgentId = agentId;
  const agent = currentData?.agents.find((a) => a.id === agentId);
  render();
  try {
    const res = await app.callServerTool({
      name: 'follow_agent',
      arguments: {
        id: agentId,
        projectPath: agent?.projectPath || '',
        openFolder,
        action,
        artifactPath,
      },
    });
    const sc = res?.structuredContent as { events?: FeedEvent[]; copied?: boolean; openedFolder?: boolean; statusMsg?: string } | undefined;
    if (sc?.events) followEvents = sc.events;
    if (sc?.statusMsg) {
      followToast = sc.statusMsg;
    } else if (sc?.openedFolder) {
      followToast = 'Opened project folder & copied conversation:// link';
    } else if (sc?.copied) {
      followToast = 'Copied conversation:// link to clipboard';
    }
  } catch (err) {
    logClientError('follow_agent', err);
    followToast = `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
  render();
}

async function refreshNow(): Promise<void> {
  if (isRefreshing) return;
  isRefreshing = true;
  render();
  try {
    const res = await app.callServerTool({ name: 'refresh_agents', arguments: { limit: 50 } });
    if (res?.isError) {
      logClientError('refresh_agents', JSON.stringify(res.content));
    } else if (res?.structuredContent) {
      currentData = res.structuredContent as unknown as TelemetryPayload;
    }
    if (followingAgentId) {
      const agent = currentData?.agents.find((a) => a.id === followingAgentId);
      const feedRes = await app.callServerTool({
        name: 'follow_agent',
        arguments: { id: followingAgentId, projectPath: agent?.projectPath || '', openFolder: false },
      });
      const sc = feedRes?.structuredContent as { events?: FeedEvent[] } | undefined;
      if (sc?.events) followEvents = sc.events;
    }
  } catch (err) {
    logClientError('refresh_agents', err);
  } finally {
    isRefreshing = false;
    render();
  }
}

function setupPolling(): void {
  if (pollTimer !== null) {
    window.clearInterval(pollTimer);
    pollTimer = null;
  }
  if (autoRefresh) {
    pollTimer = window.setInterval(() => {
      void refreshNow();
    }, 4000);
  }
}

// Register handlers BEFORE connect()
app.ontoolinput = () => {
  if (!currentData) render();
};

app.ontoolresult = (result) => {
  if (result?.structuredContent) {
    currentData = result.structuredContent as unknown as TelemetryPayload;
    render();
  }
};

app.onhostcontextchanged = (ctx) => {
  if (ctx.theme) applyDocumentTheme(ctx.theme);
  if (ctx.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
};

async function init(): Promise<void> {
  render();
  await app.connect();
  const ctx = app.getHostContext();
  if (ctx?.theme) applyDocumentTheme(ctx.theme);
  if (ctx?.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
  setupPolling();
  if (!currentData) {
    await refreshNow();
  }
}

void init();
