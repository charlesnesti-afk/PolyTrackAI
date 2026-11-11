# PolyPilot AI — Visual & Interaction Design System (`DESIGN.md`)

## Direction: `tech-utility` (Dark Motorsport Telemetry Cockpit)
Surface mode: **Operate** — High-density, zero-clutter motorsport & neural-network telemetry instrument floating cleanly in the top-right corner of PolyTrack inside Brave Browser.

## Palette Tokens (OKLch / Off-Black — Zero `#000000`, Zero Purple Gradients, Zero Neon Glows)
```css
:host {
  --bg:             rgba(13, 16, 22, 0.92);   /* oklch(17% 0.015 255 / 0.92) — off-black slate */
  --surface:        #141923;                  /* oklch(21% 0.018 255) */
  --surface-raised: #1b2230;                  /* oklch(25% 0.020 255) */
  --fg:             #edf1f7;                  /* oklch(95% 0.008 250) */
  --muted:          #8c96a8;                  /* oklch(67% 0.022 255) */
  --border:         rgba(255, 255, 255, 0.09);
  --edge-refract:   inset 0 1px 0 rgba(255, 255, 255, 0.08);
  --accent:         #22c55e;                  /* oklch(72% 0.19 149) — Signal Telemetry Green */
  --accent-dim:     rgba(34, 197, 94, 0.14);
  --warn:           #f59e0b;                  /* Telemetry Amber — Watch-Me Demo Recording */
  --warn-dim:       rgba(245, 158, 11, 0.15);
  --danger:         #ef4444;                  /* Telemetry Red — Brake / Wall Proximity */
  --danger-dim:     rgba(239, 68, 68, 0.15);
  --info:           #38bdf8;                  /* Replay / Ghost Telemetry Cyan */

  --font-display:   'SF Pro Display', 'Geist', -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
  --font-body:      'SF Pro Text', 'Geist', -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
  --font-mono:      'SF Mono', 'JetBrains Mono', 'Geist Mono', ui-monospace, Menlo, monospace;
}
```

## Layout & Ergonomics
- **Non-Overlapping Dock Position**: Anchored `top: 12px; right: 12px; width: 356px` inside an isolated `ShadowRoot`. Leaves PolyTrack's top-left toolbar (`.game-toolbar-ui`), top-center timer (`.timer-ui`), bottom-center checkpoints (`.checkpoint-ui`), bottom-right speedometer (`.speedometer-ui`), and center driving viewport 100% unobstructed.
- **Draggable & Collapsible**: Header drag handle moves the HUD anywhere in the viewport; minimize button or `Alt+P` collapses the HUD into a compact `252px` status strip.
- **3D LIDAR + Vision Scope**: Overlays 15 surface-contour & barrier LIDAR rays (`#22c55e` safe, `#f59e0b` caution, `#ef4444` close) plus the 5-point 3D racing-line trajectory curve (`#38bdf8`) directly over the live `64×36` WebGL viewport feed.
- **Typography & Density**:
  - Tabular monospace numerics (`font-variant-numeric: tabular-nums`) on all speed, lap times, parameter counts, RAM meters, and activation bars so digits never shift layout width at 20–60 Hz.
  - Hairline `1px` dividers (`divide-y`) and recessed instrument scopes instead of nested card-in-card clutter.
  - Consistent `1.5px` stroke inline SVG iconography; zero emojis anywhere.
