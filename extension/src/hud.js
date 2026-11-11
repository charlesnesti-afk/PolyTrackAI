(() => {
  'use strict';

  function formatMs(ms) {
    if (ms == null || !Number.isFinite(ms) || ms < 0) return '--:--.---';
    const totalMs = Math.round(ms);
    const mins = Math.floor(totalMs / 60000);
    const secs = Math.floor((totalMs % 60000) / 1000);
    const remMs = totalMs % 1000;
    return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(remMs).padStart(3, '0')}`;
  }

  const HUD_CSS = `
    :host {
      --bg: rgba(13, 16, 22, 0.92);
      --surface: #141923;
      --surface-raised: #1b2230;
      --fg: #edf1f7;
      --muted: #8c96a8;
      --border: rgba(255, 255, 255, 0.09);
      --border-strong: rgba(255, 255, 255, 0.16);
      --accent: #22c55e;
      --accent-dim: rgba(34, 197, 94, 0.15);
      --warn: #f59e0b;
      --warn-dim: rgba(245, 158, 11, 0.16);
      --danger: #ef4444;
      --danger-dim: rgba(239, 68, 68, 0.16);
      --info: #38bdf8;
      --info-dim: rgba(56, 189, 248, 0.16);
      --font-sans: 'SF Pro Display', 'Geist', -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
      --font-mono: 'SF Mono', 'JetBrains Mono', 'Geist Mono', ui-monospace, Menlo, monospace;

      position: fixed;
      top: 12px;
      right: 12px;
      z-index: 2147483646;
      pointer-events: none;
      font-family: var(--font-sans);
      color: var(--fg);
      user-select: none;
      -webkit-font-smoothing: antialiased;
    }

    * {
      box-sizing: border-box;
    }

    .panel {
      width: 356px;
      background: var(--bg);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      border: 1px solid var(--border);
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.08), 0 18px 38px -12px rgba(5, 7, 12, 0.72);
      border-radius: 10px;
      pointer-events: auto;
      overflow: hidden;
      transition: width 140ms ease;
    }

    .panel.collapsed {
      width: 252px;
    }

    .panel.collapsed .body-wrap {
      display: none;
    }

    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 8px 10px;
      background: rgba(20, 25, 35, 0.78);
      border-bottom: 1px solid var(--border);
      cursor: grab;
      gap: 8px;
    }

    .header:active {
      cursor: grabbing;
    }

    .brand {
      display: flex;
      align-items: center;
      gap: 7px;
      min-width: 0;
    }

    .brand-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--muted);
      flex-shrink: 0;
    }

    .brand-dot.mode-train { background: var(--accent); }
    .brand-dot.mode-watch { background: var(--warn); }
    .brand-dot.mode-race  { background: var(--info); }
    .brand-dot.mode-replay { background: var(--info); }

    .brand-title {
      font-size: 12px;
      font-weight: 600;
      letter-spacing: -0.01em;
      white-space: nowrap;
      color: var(--fg);
    }

    .track-pill {
      font-family: var(--font-mono);
      font-size: 10px;
      color: var(--muted);
      background: var(--surface-raised);
      border: 1px solid var(--border);
      padding: 2px 6px;
      border-radius: 4px;
      max-width: 112px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .hdr-actions {
      display: flex;
      align-items: center;
      gap: 4px;
      flex-shrink: 0;
    }

    .icon-btn {
      width: 24px;
      height: 24px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      background: transparent;
      border: 1px solid transparent;
      border-radius: 5px;
      color: var(--muted);
      cursor: pointer;
      padding: 0;
      transition: background 110ms ease, color 110ms ease, border-color 110ms ease;
    }

    .icon-btn:hover {
      background: var(--surface-raised);
      border-color: var(--border);
      color: var(--fg);
    }

    .icon-btn:focus-visible, .mode-btn:focus-visible, .tab-btn:focus-visible, .act-btn:focus-visible {
      outline: 1.5px solid var(--accent);
      outline-offset: -1px;
    }

    .mode-grid {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 4px;
      padding: 8px 10px;
      border-bottom: 1px solid var(--border);
    }

    .mode-btn {
      appearance: none;
      border: 1px solid var(--border);
      background: var(--surface);
      color: var(--muted);
      border-radius: 6px;
      padding: 6px 4px;
      font-family: var(--font-sans);
      font-size: 10.5px;
      font-weight: 560;
      letter-spacing: 0.01em;
      cursor: pointer;
      transition: all 110ms ease;
      text-align: center;
    }

    .mode-btn:hover {
      color: var(--fg);
      border-color: var(--border-strong);
    }

    .mode-btn:active {
      transform: scale(0.98);
    }

    .mode-btn.active-idle {
      background: var(--surface-raised);
      color: var(--fg);
      border-color: var(--border-strong);
    }

    .mode-btn.active-train {
      background: var(--accent-dim);
      color: #4ade80;
      border-color: rgba(34, 197, 94, 0.45);
    }

    .mode-btn.active-watch {
      background: var(--warn-dim);
      color: #fbbf24;
      border-color: rgba(245, 158, 11, 0.45);
    }

    .mode-btn.active-race {
      background: var(--info-dim);
      color: #7dd3fc;
      border-color: rgba(56, 189, 248, 0.45);
    }

    .tabs {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      border-bottom: 1px solid var(--border);
      background: rgba(20, 25, 35, 0.45);
    }

    .tab-btn {
      appearance: none;
      background: transparent;
      border: none;
      border-bottom: 2px solid transparent;
      color: var(--muted);
      padding: 7px 6px;
      font-family: var(--font-mono);
      font-size: 10px;
      font-weight: 500;
      letter-spacing: 0.04em;
      cursor: pointer;
      transition: color 110ms ease, border-color 110ms ease;
    }

    .tab-btn:hover {
      color: var(--fg);
    }

    .tab-btn.active {
      color: var(--fg);
      border-bottom-color: var(--accent);
    }

    .view {
      display: none;
      padding: 10px;
    }

    .view.active {
      display: block;
    }

    .scopes-row {
      display: grid;
      grid-template-columns: 168px 1fr;
      gap: 8px;
      margin-bottom: 9px;
    }

    .scope-box {
      background: #0b0e14;
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 4px;
      display: flex;
      flex-direction: column;
      gap: 3px;
    }

    .scope-hdr {
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-family: var(--font-mono);
      font-size: 9px;
      color: var(--muted);
      padding: 0 2px;
      font-variant-numeric: tabular-nums;
    }

    .scope-canvas {
      width: 100%;
      height: 92px;
      display: block;
      border-radius: 3px;
      background: #090c11;
      image-rendering: pixelated;
    }

    .controls-viz {
      display: grid;
      grid-template-columns: 1.25fr 1fr 0.85fr;
      gap: 7px;
      padding: 7px 0;
      border-top: 1px solid var(--border);
      border-bottom: 1px solid var(--border);
      margin-bottom: 8px;
    }

    .bar-group {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .bar-label {
      display: flex;
      justify-content: space-between;
      font-family: var(--font-mono);
      font-size: 9px;
      color: var(--muted);
      font-variant-numeric: tabular-nums;
    }

    .steer-track {
      position: relative;
      height: 8px;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 4px;
      overflow: hidden;
    }

    .steer-center {
      position: absolute;
      left: 50%;
      top: 0;
      bottom: 0;
      width: 1px;
      background: rgba(255, 255, 255, 0.22);
    }

    .steer-fill {
      position: absolute;
      top: 0;
      bottom: 0;
      background: var(--accent);
      transition: left 45ms linear, width 45ms linear;
    }

    .pedal-track {
      height: 8px;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 4px;
      overflow: hidden;
    }

    .pedal-fill {
      height: 100%;
      width: 0%;
      transition: width 45ms linear;
    }

    .pedal-fill.throttle { background: var(--accent); }
    .pedal-fill.brake { background: var(--danger); }

    .metrics-strip {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 6px;
      margin-bottom: 8px;
    }

    .metric-cell {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 5px;
      padding: 5px 6px;
    }

    .metric-k {
      font-family: var(--font-mono);
      font-size: 8.5px;
      color: var(--muted);
      letter-spacing: 0.03em;
      margin-bottom: 2px;
    }

    .metric-v {
      font-family: var(--font-mono);
      font-size: 11.5px;
      font-weight: 600;
      color: var(--fg);
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .chart-box {
      background: #0b0e14;
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 5px 6px;
    }

    .chart-canvas {
      width: 100%;
      height: 50px;
      display: block;
    }

    .toolbar-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
      margin-bottom: 8px;
    }

    .act-btn {
      appearance: none;
      background: var(--surface-raised);
      border: 1px solid var(--border-strong);
      color: var(--fg);
      border-radius: 5px;
      padding: 5px 8px;
      font-family: var(--font-sans);
      font-size: 10.5px;
      font-weight: 550;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 5px;
      transition: background 110ms ease, border-color 110ms ease;
    }

    .act-btn:hover {
      background: #232c3d;
      border-color: rgba(255, 255, 255, 0.26);
    }

    .act-btn.primary {
      background: var(--accent-dim);
      border-color: rgba(34, 197, 94, 0.42);
      color: #4ade80;
    }

    .act-btn.primary:hover {
      background: rgba(34, 197, 94, 0.24);
    }

    .act-btn.danger:hover {
      background: var(--danger-dim);
      border-color: rgba(239, 68, 68, 0.45);
      color: #fca5a5;
    }

    .runs-list {
      display: flex;
      flex-direction: column;
      border: 1px solid var(--border);
      border-radius: 6px;
      background: var(--surface);
      max-height: 210px;
      overflow-y: auto;
    }

    .run-row {
      display: grid;
      grid-template-columns: 24px 36px 1fr auto;
      align-items: center;
      gap: 6px;
      padding: 6px 8px;
      border-bottom: 1px solid var(--border);
      font-family: var(--font-mono);
      font-size: 10.5px;
      font-variant-numeric: tabular-nums;
    }

    .run-row:last-child {
      border-bottom: none;
    }

    .run-rank {
      color: var(--muted);
      font-weight: 600;
    }

    .run-rank.top1 {
      color: var(--accent);
    }

    .src-badge {
      font-size: 9px;
      padding: 1px 4px;
      border-radius: 3px;
      text-align: center;
      border: 1px solid var(--border);
      color: var(--muted);
    }

    .src-badge.you {
      color: #fbbf24;
      border-color: rgba(245, 158, 11, 0.4);
      background: var(--warn-dim);
    }

    .src-badge.ai {
      color: #4ade80;
      border-color: rgba(34, 197, 94, 0.35);
      background: var(--accent-dim);
    }

    .run-stat {
      color: var(--fg);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .run-actions {
      display: flex;
      gap: 4px;
    }

    .mini-btn {
      appearance: none;
      background: var(--surface-raised);
      border: 1px solid var(--border);
      color: var(--fg);
      border-radius: 4px;
      padding: 2px 6px;
      font-family: var(--font-mono);
      font-size: 9.5px;
      cursor: pointer;
    }

    .mini-btn:hover {
      border-color: var(--border-strong);
      background: #252f42;
    }

    .mini-btn.active-replay {
      background: var(--info-dim);
      color: #7dd3fc;
      border-color: rgba(56, 189, 248, 0.5);
    }

    .empty-msg {
      padding: 18px 12px;
      text-align: center;
      font-size: 11px;
      color: var(--muted);
      line-height: 1.5;
    }

    .mem-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 8px;
      margin-bottom: 8px;
    }

    .mem-bar-bg {
      height: 5px;
      background: #0b0e14;
      border-radius: 3px;
      margin-top: 5px;
      overflow: hidden;
    }

    .mem-bar-fill {
      height: 100%;
      background: var(--accent);
      width: 1.5%;
    }

    .footer-bar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 5px 10px;
      background: rgba(11, 14, 20, 0.7);
      border-top: 1px solid var(--border);
      font-family: var(--font-mono);
      font-size: 9.5px;
      color: var(--muted);
      font-variant-numeric: tabular-nums;
    }

    .toast {
      color: var(--accent);
      max-width: 210px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
  `;

  class PolyPilotHUD {
    constructor(callbacks) {
      this.cb = callbacks;
      this.activeTab = 'scope'; // 'scope' | 'runs' | 'brains'
      this.collapsed = false;
      this.toastText = 'Alt+P toggle HUD · Ready';
      this.toastUntil = 0;

      this.host = document.createElement('div');
      this.host.id = 'polypilot-ai-root';
      this.shadow = this.host.attachShadow({ mode: 'open' });

      this._buildDOM();
      document.documentElement.appendChild(this.host);
      this._setupDragging();
    }

    _buildDOM() {
      const style = document.createElement('style');
      style.textContent = HUD_CSS;
      this.shadow.appendChild(style);

      this.panel = document.createElement('div');
      this.panel.className = 'panel';
      this.panel.innerHTML = `
        <div class="header" id="drag-hdr">
          <div class="brand">
            <span class="brand-dot" id="status-dot"></span>
            <span class="brand-title">POLYPILOT AI</span>
            <span class="track-pill" id="track-pill">Summer 1</span>
          </div>
          <div class="hdr-actions">
            <button class="icon-btn" id="btn-collapse" title="Collapse / Expand HUD (Alt+P)" aria-label="Collapse or expand HUD">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
                <path d="M5 12h14"/>
              </svg>
            </button>
          </div>
        </div>

        <div class="body-wrap">
          <div class="mode-grid">
            <button class="mode-btn active-idle" data-mode="idle" title="Release keys and pause AI (Alt+1)">STANDBY</button>
            <button class="mode-btn" data-mode="train" title="Autonomous PPO + Top-Run Self-Imitation (Alt+2)">AUTO TRAIN</button>
            <button class="mode-btn" data-mode="watch" title="Watch you drive & clone your lines (Alt+3)">WATCH ME</button>
            <button class="mode-btn" data-mode="race" title="Drive fastest learned line with zero noise (Alt+4)">RACE BEST</button>
          </div>

          <div class="tabs">
            <button class="tab-btn active" data-tab="scope">BRAIN SCOPE</button>
            <button class="tab-btn" data-tab="runs" id="tab-runs-label">TOP RUNS (0)</button>
            <button class="tab-btn" data-tab="brains">SAVE / LOAD</button>
          </div>

          <!-- VIEW 1: LIVE AI BRAIN VISUALIZER -->
          <div class="view active" id="view-scope">
            <div class="scopes-row">
              <div class="scope-box">
                <div class="scope-hdr">
                  <span>VISION + 15 RAYS</span>
                  <span id="lbl-clearance">CLR 0.80</span>
                </div>
                <canvas class="scope-canvas" id="vision-canvas" width="160" height="92"></canvas>
              </div>
              <div class="scope-box">
                <div class="scope-hdr">
                  <span>TINYNET-64</span>
                  <span id="lbl-value">V +0.0</span>
                </div>
                <canvas class="scope-canvas" id="net-canvas" width="156" height="92"></canvas>
              </div>
            </div>

            <div class="controls-viz">
              <div class="bar-group">
                <div class="bar-label"><span>STEER</span><span id="lbl-steer">0%</span></div>
                <div class="steer-track">
                  <div class="steer-center"></div>
                  <div class="steer-fill" id="bar-steer" style="left:50%;width:0%"></div>
                </div>
              </div>
              <div class="bar-group">
                <div class="bar-label"><span>THROTTLE</span><span id="lbl-throttle">0%</span></div>
                <div class="pedal-track">
                  <div class="pedal-fill throttle" id="bar-throttle"></div>
                </div>
              </div>
              <div class="bar-group">
                <div class="bar-label"><span>BRAKE</span><span id="lbl-brake">0%</span></div>
                <div class="pedal-track">
                  <div class="pedal-fill brake" id="bar-brake"></div>
                </div>
              </div>
            </div>

            <div class="metrics-strip">
              <div class="metric-cell">
                <div class="metric-k">SPEED</div>
                <div class="metric-v" id="m-speed">0 km/h</div>
              </div>
              <div class="metric-cell">
                <div class="metric-k">EPISODE</div>
                <div class="metric-v" id="m-ep">#0</div>
              </div>
              <div class="metric-cell">
                <div class="metric-k">RETURN</div>
                <div class="metric-v" id="m-ret">+0.0</div>
              </div>
              <div class="metric-cell">
                <div class="metric-k">TOP #1</div>
                <div class="metric-v" id="m-best">--:--</div>
              </div>
            </div>

            <div class="chart-box">
              <div class="scope-hdr" style="margin-bottom:3px">
                <span>REWARD &amp; PROGRESS HISTORY</span>
                <span id="lbl-updates">0 grad steps</span>
              </div>
              <canvas class="chart-canvas" id="chart-canvas" width="322" height="50"></canvas>
            </div>
            <div class="chart-box" style="margin-top:5px;padding:5px 8px" id="box-fleet">
              <div class="scope-hdr" style="margin-bottom:0">
                <span id="lbl-fleet-title">PARALLEL FLEET (3 WORKERS)</span>
                <span id="lbl-fleet-stats" style="font-family:var(--font-mono)">6 CARS · 15.0 EP/S</span>
              </div>
            </div>
          </div>

          <!-- VIEW 2: TOP RUNS HALL OF FAME -->
          <div class="view" id="view-runs">
            <div class="toolbar-row">
              <button class="act-btn primary" id="btn-distill">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
                Train on Top Runs
              </button>
              <button class="act-btn" id="btn-reset-mode" title="Switch reset key between T (full run) and R (checkpoint)">
                Reset: Full [T]
              </button>
            </div>
            <div class="runs-list" id="runs-list">
              <div class="empty-msg">No runs recorded on this track yet.<br>Switch to <b>AUTO TRAIN</b> or <b>WATCH ME</b> to populate Top Runs.</div>
            </div>
          </div>

          <!-- VIEW 3: SAVE & LOAD TRACK BRAINS -->
          <div class="view" id="view-brains">
            <div class="mem-card">
              <div class="scope-hdr" style="color:var(--fg);font-size:10px;white-space:nowrap;gap:8px">
                <span>PolyTinyNet-v2 + 3D LIDAR</span>
                <span id="lbl-mem-size">61.4 KB · ~49 MB RAM</span>
              </div>
              <div class="scope-hdr" style="margin-top:3px;white-space:nowrap">
                <span>15,717 Float32 params</span>
                <span>&lt; 0.7% of 8 GB cap</span>
              </div>
              <div class="mem-bar-bg">
                <div class="mem-bar-fill" id="bar-mem"></div>
              </div>
            </div>

            <div class="toolbar-row">
              <button class="act-btn primary" id="btn-export">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                Export Brain
              </button>
              <button class="act-btn" id="btn-import">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
                Load File
              </button>
              <button class="act-btn danger" id="btn-reset-brain" title="Reset neural weights for current track">
                Reset
              </button>
              <input type="file" id="file-import" accept=".json,.polybrain.json" style="display:none" />
            </div>

            <div class="scope-hdr" style="margin-bottom:4px">
              <span>AUTO-SAVED TRACK BRAINS (BRAVE STORAGE)</span>
              <span id="lbl-saved-count">0 saved</span>
            </div>
            <div class="runs-list" id="saved-brains-list" style="max-height:132px">
              <div class="empty-msg">Auto-saves after every improved run.</div>
            </div>
          </div>

          <div class="footer-bar">
            <span id="lbl-state-summary">STANDBY · CP 0/0</span>
            <span class="toast" id="lbl-toast">Alt+P toggle HUD</span>
          </div>
        </div>
      `;
      this.shadow.appendChild(this.panel);

      // Cache elements
      const $ = (id) => this.shadow.getElementById(id);
      this.els = {
        statusDot: $('status-dot'),
        trackPill: $('track-pill'),
        btnCollapse: $('btn-collapse'),
        tabRunsLabel: $('tab-runs-label'),
        visionCanvas: $('vision-canvas'),
        netCanvas: $('net-canvas'),
        chartCanvas: $('chart-canvas'),
        lblClearance: $('lbl-clearance'),
        lblValue: $('lbl-value'),
        lblSteer: $('lbl-steer'),
        lblThrottle: $('lbl-throttle'),
        lblBrake: $('lbl-brake'),
        barSteer: $('bar-steer'),
        barThrottle: $('bar-throttle'),
        barBrake: $('bar-brake'),
        mSpeed: $('m-speed'),
        mEp: $('m-ep'),
        mRet: $('m-ret'),
        mBest: $('m-best'),
        lblUpdates: $('lbl-updates'),
        runsList: $('runs-list'),
        btnDistill: $('btn-distill'),
        btnResetMode: $('btn-reset-mode'),
        lblMemSize: $('lbl-mem-size'),
        barMem: $('bar-mem'),
        btnExport: $('btn-export'),
        btnImport: $('btn-import'),
        btnResetBrain: $('btn-reset-brain'),
        fileImport: $('file-import'),
        savedBrainsList: $('saved-brains-list'),
        lblSavedCount: $('lbl-saved-count'),
        lblStateSummary: $('lbl-state-summary'),
        lblToast: $('lbl-toast'),
        boxFleet: $('box-fleet'),
        lblFleetTitle: $('lbl-fleet-title'),
        lblFleetStats: $('lbl-fleet-stats')
      };

      this.visionCtx = this.els.visionCanvas.getContext('2d');
      this.netCtx = this.els.netCanvas.getContext('2d');
      this.chartCtx = this.els.chartCanvas.getContext('2d');
      this._miniFrameCanvas = document.createElement('canvas');
      this._miniFrameCanvas.width = 64;
      this._miniFrameCanvas.height = 36;
      this._miniFrameCtx = this._miniFrameCanvas.getContext('2d');

      this._bindUIEvents();
    }

    _refocusGame(el) {
      if (el && typeof el.blur === 'function') el.blur();
      window.focus();
    }

    _bindUIEvents() {
      this.els.btnCollapse.addEventListener('click', (e) => {
        e.stopPropagation();
        this.toggleCollapse();
        this._refocusGame(e.currentTarget);
      });

      this.shadow.querySelectorAll('.mode-btn').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const mode = btn.getAttribute('data-mode');
          this.cb.onSetMode(mode);
          this._refocusGame(btn);
        });
      });

      this.shadow.querySelectorAll('.tab-btn').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const tab = btn.getAttribute('data-tab');
          this.setTab(tab);
          if (tab === 'brains') this.cb.onRefreshSavedBrains();
          this._refocusGame(btn);
        });
      });

      this.els.btnDistill.addEventListener('click', (e) => {
        e.stopPropagation();
        this.cb.onDistillTopRuns();
        this._refocusGame(e.currentTarget);
      });

      this.els.btnResetMode.addEventListener('click', (e) => {
        e.stopPropagation();
        const next = this.cb.onToggleResetKeyMode();
        this.els.btnResetMode.textContent = next === 'checkpoint' ? 'Reset: CP [R]' : 'Reset: Full [T]';
        this._refocusGame(e.currentTarget);
      });

      this.els.btnExport.addEventListener('click', (e) => {
        e.stopPropagation();
        this.cb.onExportBrain();
        this._refocusGame(e.currentTarget);
      });

      this.els.btnImport.addEventListener('click', (e) => {
        e.stopPropagation();
        this.els.fileImport.click();
        this._refocusGame(e.currentTarget);
      });

      this.els.fileImport.addEventListener('change', (e) => {
        const file = e.target.files && e.target.files[0];
        if (file) {
          const reader = new FileReader();
          reader.onload = () => {
            this.cb.onImportBrainText(String(reader.result || ''), file.name);
          };
          reader.readAsText(file);
        }
        e.target.value = '';
        this._refocusGame(null);
      });

      this.els.btnResetBrain.addEventListener('click', (e) => {
        e.stopPropagation();
        this.cb.onResetBrain();
        this._refocusGame(e.currentTarget);
      });
    }

    _setupDragging() {
      const hdr = this.shadow.getElementById('drag-hdr');
      let dragging = false;
      let startX = 0;
      let startY = 0;
      let origRight = 12;
      let origTop = 12;

      hdr.addEventListener('mousedown', (e) => {
        if (e.target.closest('button')) return;
        dragging = true;
        startX = e.clientX;
        startY = e.clientY;
        const rect = this.host.getBoundingClientRect();
        origRight = window.innerWidth - rect.right;
        origTop = rect.top;
        e.preventDefault();
      });

      window.addEventListener('mousemove', (e) => {
        if (!dragging) return;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        const nextRight = Math.max(6, Math.min(window.innerWidth - 260, origRight - dx));
        const nextTop = Math.max(6, Math.min(window.innerHeight - 60, origTop + dy));
        this.host.style.right = `${nextRight}px`;
        this.host.style.top = `${nextTop}px`;
      });

      window.addEventListener('mouseup', () => {
        dragging = false;
      });
    }

    toggleCollapse() {
      this.collapsed = !this.collapsed;
      this.panel.classList.toggle('collapsed', this.collapsed);
    }

    setTab(tab) {
      this.activeTab = tab;
      this.shadow.querySelectorAll('.tab-btn').forEach((b) => {
        b.classList.toggle('active', b.getAttribute('data-tab') === tab);
      });
      this.shadow.getElementById('view-scope').classList.toggle('active', tab === 'scope');
      this.shadow.getElementById('view-runs').classList.toggle('active', tab === 'runs');
      this.shadow.getElementById('view-brains').classList.toggle('active', tab === 'brains');
    }

    showToast(msg, durationMs = 3500) {
      this.toastText = msg;
      this.toastUntil = performance.now() + durationMs;
      this.els.lblToast.textContent = msg;
    }

    updateModeUI(mode, replayRunId = null) {
      const dot = this.els.statusDot;
      dot.className = 'brand-dot';
      if (mode === 'train') dot.classList.add('mode-train');
      else if (mode === 'watch') dot.classList.add('mode-watch');
      else if (mode === 'race') dot.classList.add('mode-race');
      else if (mode === 'replay') dot.classList.add('mode-replay');

      this.shadow.querySelectorAll('.mode-btn').forEach((btn) => {
        const m = btn.getAttribute('data-mode');
        btn.className = 'mode-btn';
        if (m === mode) {
          btn.classList.add(`active-${m}`);
        }
      });

      this._activeReplayId = replayRunId;
    }

    renderTopRuns(topRuns, activeReplayId = null) {
      this.els.tabRunsLabel.textContent = `TOP RUNS (${topRuns.length})`;
      if (!topRuns || topRuns.length === 0) {
        this.els.runsList.innerHTML = `<div class="empty-msg">No runs recorded on this track yet.<br>Switch to <b>AUTO TRAIN</b> or <b>WATCH ME</b> to record Top Runs.</div>`;
        return;
      }

      this.els.runsList.innerHTML = '';
      topRuns.forEach((run, idx) => {
        const row = document.createElement('div');
        row.className = 'run-row';
        const statText = run.finished
          ? `${formatMs(run.finishTimeMs)} · ${Math.round(run.maxSpeedKmh || 0)}km/h`
          : `CP ${run.checkpoints || 0}/${run.totalCp || '?'} · ${Math.round(run.progressMeters || 0)}m`;

        const isReplaying = activeReplayId && activeReplayId === run.id;
        row.innerHTML = `
          <span class="run-rank ${idx === 0 ? 'top1' : ''}">#${idx + 1}</span>
          <span class="src-badge ${run.source === 'YOU' ? 'you' : 'ai'}">${run.source}</span>
          <span class="run-stat" title="Reward ${(run.totalReward || 0).toFixed(1)}">${statText}</span>
          <div class="run-actions">
            <button class="mini-btn ${isReplaying ? 'active-replay' : ''}" data-act="replay">${isReplaying ? 'Stop' : 'Replay'}</button>
            <button class="mini-btn" data-act="del" title="Remove run">×</button>
          </div>
        `;

        row.querySelector('[data-act="replay"]').addEventListener('click', (e) => {
          e.stopPropagation();
          this.cb.onReplayTopRun(run.id);
          this._refocusGame(e.currentTarget);
        });
        row.querySelector('[data-act="del"]').addEventListener('click', (e) => {
          e.stopPropagation();
          this.cb.onDeleteTopRun(run.id);
          this._refocusGame(e.currentTarget);
        });
        this.els.runsList.appendChild(row);
      });
    }

    renderSavedBrains(list, currentTrackId) {
      this.els.lblSavedCount.textContent = `${list.length} saved`;
      if (!list || list.length === 0) {
        this.els.savedBrainsList.innerHTML = `<div class="empty-msg">Auto-saves after every improved run.</div>`;
        return;
      }
      this.els.savedBrainsList.innerHTML = '';
      list.forEach((item) => {
        const row = document.createElement('div');
        row.className = 'run-row';
        row.style.gridTemplateColumns = '1fr auto';
        const bestStr = item.bestTimeMs != null ? formatMs(item.bestTimeMs) : `${item.topRunsCount} top`;
        const isCur = item.trackId === currentTrackId;
        row.innerHTML = `
          <span class="run-stat">${item.trackName} · Ep ${item.episodesTrained} · ${bestStr}</span>
          <div class="run-actions">
            <button class="mini-btn" data-act="load">${isCur ? 'Reload' : 'Use Weights'}</button>
          </div>
        `;
        row.querySelector('[data-act="load"]').addEventListener('click', (e) => {
          e.stopPropagation();
          this.cb.onLoadSavedTrackWeights(item.trackId);
          this._refocusGame(e.currentTarget);
        });
        this.els.savedBrainsList.appendChild(row);
      });
    }

    renderLiveFrame(state) {
      const {
        mode,
        telemetry,
        vision,
        track3d,
        brain,
        steerIdx,
        pedalIdx,
        continuousSteer,
        continuousPedal,
        episodeIdx,
        episodeReturn,
        rewardHistory,
        topRuns,
        memStats,
        secInfo,
        fleetStats
      } = state;

      this.els.trackPill.textContent = telemetry.trackName || 'PolyTrack';
      this.els.mSpeed.textContent = `${Math.round(Math.abs(telemetry.speedKmh || 0))} km/h`;
      this.els.mEp.textContent = `#${episodeIdx}`;
      this.els.mRet.textContent = (episodeReturn >= 0 ? '+' : '') + episodeReturn.toFixed(1);

      if (topRuns && topRuns.length > 0) {
        const r0 = topRuns[0];
        this.els.mBest.textContent = r0.finished
          ? formatMs(r0.finishTimeMs)
          : `${Math.round(r0.progressMeters || 0)}m`;
      } else {
        this.els.mBest.textContent = '--:--';
      }

      const modeLabel = mode.toUpperCase();
      let raceFlag = telemetry.inRace ? `CP ${telemetry.currentCp}/${telemetry.totalCp || '?'}` : 'IN MENU';
      if (telemetry.inRace && secInfo) {
        if (secInfo.deltaMs != null) {
          const deltaStr = secInfo.deltaMs > 0 ? `+${secInfo.deltaMs}ms` : `${secInfo.deltaMs}ms`;
          raceFlag = `CP ${secInfo.cp} (${deltaStr} / +1000ms max)`;
        } else if (secInfo.nextTargetMs != null) {
          raceFlag = `CP ${secInfo.cp} (BEST ${formatMs(secInfo.nextTargetMs)})`;
        } else {
          raceFlag = `CP ${secInfo.cp}`;
        }
      }
      let fleetSummary = '';
      if (fleetStats && (fleetStats.activeWorkers > 0 || fleetStats.totalCars > 0)) {
        fleetSummary = ` · FLEET: ${fleetStats.activeWorkers}W · ${fleetStats.totalCars} CARS · ${fleetStats.rolloutsPerSec} EP/S`;
      }
      this.els.lblStateSummary.textContent = `${modeLabel} · ${raceFlag}${fleetSummary}`;

      if (this.els.lblFleetStats && fleetStats) {
        this.els.lblFleetTitle.textContent = `PARALLEL FLEET (${fleetStats.activeWorkers || 0} WORKERS)`;
        this.els.lblFleetStats.textContent = `${fleetStats.totalCars || 0} CARS · ${(fleetStats.rolloutsPerSec || 0).toFixed(1)} EP/S`;
      }

      if (performance.now() > this.toastUntil && this.els.lblToast.textContent !== 'Alt+P toggle HUD') {
        this.els.lblToast.textContent = 'Alt+P toggle HUD';
      }

      if (this.collapsed) return;

      if (this.activeTab === 'brains' && memStats) {
        this.els.lblMemSize.textContent = `${memStats.weightKB} KB · ~${memStats.heapUsedMB} MB RAM`;
        const pct = Math.max(0.8, Math.min(100, (memStats.heapUsedMB / 8192) * 100));
        this.els.barMem.style.width = `${pct}%`;
      }

      if (this.activeTab !== 'scope') return;

      // Update Continuous Analog Steering & Pedal Bars
      const sp = brain.lastSteerProbs;
      const pp = brain.lastPedalProbs;
      const netSteer = typeof continuousSteer === 'number' ? continuousSteer : (sp[2] - sp[0]);
      const netPedal = typeof continuousPedal === 'number' ? continuousPedal : (pp[0] - pp[2]);
      const displaySteer = netSteer;

      this.els.lblSteer.textContent = displaySteer < -0.04
        ? `L ${Math.round(Math.abs(displaySteer) * 100)}%`
        : (displaySteer > 0.04 ? `R ${Math.round(displaySteer * 100)}%` : '0%');

      if (displaySteer < 0) {
        const w = Math.min(50, Math.abs(displaySteer) * 50);
        this.els.barSteer.style.left = `${50 - w}%`;
        this.els.barSteer.style.width = `${w}%`;
      } else {
        const w = Math.min(50, displaySteer * 50);
        this.els.barSteer.style.left = '50%';
        this.els.barSteer.style.width = `${w}%`;
      }

      const throtPct = Math.round(Math.max(0, netPedal) * 100);
      const brakePct = Math.round(Math.max(0, -netPedal) * 100);
      this.els.lblThrottle.textContent = `${throtPct}%`;
      this.els.barThrottle.style.width = `${throtPct}%`;
      this.els.lblBrake.textContent = `${brakePct}%`;
      this.els.barBrake.style.width = `${brakePct}%`;

      const has3D = !!(track3d && track3d.ready && telemetry.position);
      const activeClr = has3D ? track3d.centerClearance : vision.centerClearance;
      this.els.lblClearance.textContent = `${has3D ? '3D' : 'CLR'} ${activeClr.toFixed(2)}`;
      const v = brain.lastValue;
      this.els.lblValue.textContent = `V ${v >= 0 ? '+' : ''}${v.toFixed(1)}`;
      this.els.lblUpdates.textContent = `${brain.gradientUpdates} grad steps`;

      this._drawVisionScope(vision, track3d, has3D, displaySteer);
      this._drawNeuralScope(has3D ? track3d : vision, brain, steerIdx, pedalIdx);
      this._drawRewardChart(rewardHistory);
    }

    _drawVisionScope(vision, track3d, has3D, displaySteer) {
      const ctx = this.visionCtx;
      const W = 160;
      const H = 92;
      ctx.fillStyle = '#090c11';
      ctx.fillRect(0, 0, W, H);

      if (!vision.frameValid || !vision.lastImageData) {
        ctx.fillStyle = '#8c96a8';
        ctx.font = '10px monospace';
        ctx.fillText('Awaiting track canvas...', 14, 48);
        return;
      }

      this._miniFrameCtx.putImageData(vision.lastImageData, 0, 0);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(this._miniFrameCanvas, 0, 0, W, H);

      // Subtle dark vignette for crisp ray readability
      ctx.fillStyle = 'rgba(9, 12, 17, 0.28)';
      ctx.fillRect(0, 0, W, H);

      const sx = W / vision.width;
      const sy = H / vision.height;
      const ox = (vision.originX || vision.width * 0.5) * sx;
      const oy = (vision.originY || 20.0) * sy;

      // Draw 15 multi-angle 3D LIDAR / Vision rays
      ctx.lineWidth = 1.25;
      const rays = has3D ? track3d.rays : vision.rays;
      const numRays = vision.numRays;

      for (let r = 0; r < numRays; r++) {
        const d = rays[r];
        let ex, ey;
        if (has3D && track3d.rayWorldHits[r]) {
          const ang = track3d.rayWorldHits[r].ang;
          const radLen = 10 + d * 42;
          ex = ox + Math.sin(ang) * radLen * 1.35;
          ey = oy - Math.cos(ang) * radLen * 0.78;
        } else {
          const ep = vision.rayEndpoints[r];
          ex = ep.x * sx;
          ey = ep.y * sy;
        }

        let color = '#22c55e';
        if (d < 0.28) color = '#ef4444';
        else if (d < 0.56) color = '#f59e0b';

        ctx.strokeStyle = color;
        ctx.globalAlpha = 0.72;
        ctx.beginPath();
        ctx.moveTo(ox, oy);
        ctx.lineTo(ex, ey);
        ctx.stroke();

        ctx.fillStyle = color;
        ctx.globalAlpha = 0.95;
        ctx.fillRect(ex - 1.5, ey - 1.5, 3, 3);
      }
      ctx.globalAlpha = 1.0;

      // Draw 5-point 3D lookahead racing line curve if 3D spline active
      if (has3D && track3d.lookaheadAngles) {
        ctx.strokeStyle = 'rgba(56, 189, 248, 0.85)';
        ctx.lineWidth = 1.8;
        ctx.beginPath();
        ctx.moveTo(ox, oy);
        const radii = [12, 20, 29, 38, 46];
        for (let k = 0; k < 5; k++) {
          const la = track3d.lookaheadAngles[k];
          const px = ox + Math.sin(la) * radii[k] * 1.4;
          const py = oy - Math.cos(la) * radii[k] * 0.78;
          ctx.lineTo(px, py);
        }
        ctx.stroke();
      }

      // Draw chosen steering heading vector in bright cyan
      const headingAng = displaySteer * 0.85 - Math.PI * 0.5;
      ctx.strokeStyle = '#38bdf8';
      ctx.lineWidth = 2.3;
      ctx.beginPath();
      ctx.moveTo(ox, oy);
      ctx.lineTo(ox + Math.cos(headingAng) * 26, oy + Math.sin(headingAng) * 26);
      ctx.stroke();
    }

    _drawNeuralScope(sensorSource, brain, steerIdx, pedalIdx) {
      const ctx = this.netCtx;
      const W = 156;
      const H = 92;
      ctx.fillStyle = '#090c11';
      ctx.fillRect(0, 0, W, H);

      // Column 1 (x = 12): 15 Ray Inputs
      const inX = 11;
      for (let i = 0; i < 15; i++) {
        const y = 7 + i * 5.6;
        const v = sensorSource.rays[i];
        ctx.fillStyle = `rgba(34, 197, 94, ${0.18 + 0.80 * v})`;
        ctx.fillRect(inX - 2, y - 2, 4, 4);
      }

      // Column 2 (x = 36..94): 8x8 Hidden Recurrent Layer (H2 = 64 neurons)
      const gridX0 = 34;
      const gridY0 = 11;
      const cell = 8.4;
      for (let idx = 0; idx < 64; idx++) {
        const gx = idx % 8;
        const gy = Math.floor(idx / 8);
        const act = brain.lastH2[idx]; // [-1, +1]
        const mag = Math.min(1, Math.abs(act));
        ctx.fillStyle = act >= 0
          ? `rgba(34, 197, 94, ${0.12 + 0.85 * mag})`
          : `rgba(56, 189, 248, ${0.12 + 0.85 * mag})`;
        ctx.fillRect(gridX0 + gx * cell, gridY0 + gy * cell, 6.4, 6.4);
      }

      // Column 3 (x = 138): 6 Output Nodes (L, C, R, W, -, S)
      const outX = 128;
      const labels = ['L', 'C', 'R', 'W', '·', 'S'];
      const probs = [
        brain.lastSteerProbs[0],
        brain.lastSteerProbs[1],
        brain.lastSteerProbs[2],
        brain.lastPedalProbs[0],
        brain.lastPedalProbs[1],
        brain.lastPedalProbs[2]
      ];
      const activeFlags = [
        steerIdx === 0,
        steerIdx === 1,
        steerIdx === 2,
        pedalIdx === 0,
        pedalIdx === 1,
        pedalIdx === 2
      ];

      ctx.font = '9px monospace';
      for (let k = 0; k < 6; k++) {
        const y = 12 + k * 13.5 + (k >= 3 ? 3 : 0);
        const p = probs[k];

        // Subtle synaptic connector from hidden block right edge
        ctx.strokeStyle = activeFlags[k]
          ? `rgba(34, 197, 94, ${0.25 + 0.55 * p})`
          : 'rgba(140, 150, 168, 0.14)';
        ctx.lineWidth = activeFlags[k] ? 1.3 : 0.7;
        ctx.beginPath();
        ctx.moveTo(gridX0 + 8 * cell - 1, 24 + (k * 9));
        ctx.lineTo(outX - 4, y);
        ctx.stroke();

        ctx.fillStyle = activeFlags[k] ? '#22c55e' : `rgba(237, 241, 247, ${0.18 + 0.65 * p})`;
        ctx.beginPath();
        ctx.arc(outX, y, 3.8, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = activeFlags[k] ? '#edf1f7' : '#8c96a8';
        ctx.fillText(labels[k], outX + 7, y + 3);
      }
    }

    _drawRewardChart(history) {
      const ctx = this.chartCtx;
      const W = 322;
      const H = 50;
      ctx.fillStyle = '#090c11';
      ctx.fillRect(0, 0, W, H);

      if (!history || history.length === 0) {
        ctx.fillStyle = '#8c96a8';
        ctx.font = '9.5px monospace';
        ctx.fillText('Episode rewards will plot here after Run #1', 36, 28);
        return;
      }

      const recent = history.slice(-50);
      let minR = Infinity;
      let maxR = -Infinity;
      for (const item of recent) {
        if (item.reward < minR) minR = item.reward;
        if (item.reward > maxR) maxR = item.reward;
      }
      if (maxR - minR < 5) {
        maxR += 2.5;
        minR -= 2.5;
      }

      const padX = 6;
      const padY = 6;
      const plotW = W - padX * 2;
      const plotH = H - padY * 2;
      const mapX = (i) => padX + (recent.length === 1 ? plotW * 0.5 : (i / (recent.length - 1)) * plotW);
      const mapY = (r) => padY + plotH - ((r - minR) / (maxR - minR)) * plotH;

      // Zero baseline if within range
      if (minR < 0 && maxR > 0) {
        const zy = mapY(0);
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(padX, zy);
        ctx.lineTo(W - padX, zy);
        ctx.stroke();
      }

      // Raw episode reward polyline
      ctx.strokeStyle = 'rgba(140, 150, 168, 0.45)';
      ctx.lineWidth = 1.1;
      ctx.beginPath();
      recent.forEach((pt, i) => {
        const x = mapX(i);
        const y = mapY(pt.reward);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();

      // Smoothed EMA trendline in Signal Green
      ctx.strokeStyle = '#22c55e';
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      let ema = recent[0].reward;
      recent.forEach((pt, i) => {
        ema = i === 0 ? pt.reward : (0.28 * pt.reward + 0.72 * ema);
        const x = mapX(i);
        const y = mapY(ema);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();

      // Highlight Top Run #1 breakthroughs with amber dots
      recent.forEach((pt, i) => {
        if (pt.isTopRun) {
          const x = mapX(i);
          const y = mapY(pt.reward);
          ctx.fillStyle = '#f59e0b';
          ctx.beginPath();
          ctx.arc(x, y, 2.4, 0, Math.PI * 2);
          ctx.fill();
        }
      });
    }
  }

  window.PolyPilotHUD = {
    PolyPilotHUD,
    formatMs
  };
})();
