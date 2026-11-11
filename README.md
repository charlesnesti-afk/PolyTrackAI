# PolyPilot AI v3.4.9 — PolyTrack 3D Neural Driver (Brave Extension Overlay)

Self-contained Manifest V3 Brave Extension overlay that learns and drives cars at high speed in **PolyTrack** (`kodub.com/apps/polytrack`, `app-polytrack.kodub.com`, and mirror sites) directly inside your browser tab—leaving your physical Mac keyboard and mouse completely free.

## Highlights (v3.4.9 Upgrade)

- **Ultra-Compact Residual Neural Architecture (`PolyTinyNet-v2`)**:
  - **15,717 Float32 parameters** (`61.4 KB` raw weights, `< 60 MB` total JS heap—less than **0.7%** of your 8 GB ceiling).
  - Runs at **25 Hz** neural planning paired with **100 Hz Sigma-Delta (`ΣΔ`) proportional key modulation** (`10 ms` duty-cycle on `WASD`) for smooth analog-grade steering, trail-braking, and high-speed drift counter-steering inside PolyTrack's 1,000 Hz Bullet Physics engine.
- **3D Surface/Wall/Cliff LIDAR + Live WebGL Vision Fusion (`track3d.js` + `vision.js`)**:
  - Passively reconstructs the active track's exact 3D triangle mesh, checkpoint trigger boxes, and elevation contours directly from PolyTrack's `simulation_worker` geometry stream (works automatically on official Summer/Winter/Desert tracks, community tracks, and custom Track Editor builds).
  - Casts **15 true 3D surface-following LIDAR rays** (`-68°` to `+68°`, detecting both physical barrier walls and unguarded bridge/cliff drop-offs across hills and ramps), fused with `64×36` live WebGL `#screen` asphalt segmentation and **5-point 3D racing-line lookahead** (`7m` to `58m` ahead).
- **3-Loop Online Learning + Top Runs Hall-of-Fame**:
  - **Auto Train (`Alt+2`)**: Combines **Continuous Gaussian PPO-Clip + GAE** (with smooth Ornstein-Uhlenbeck exploration), **Adaptive 5m Track Sector Speed & Apex Memory** (pushes corner speeds higher on clean sectors and immediately lowers entry speed before any corner that caused a wall hit or fly-off), and **Top-Runs Self-Imitation Learning (SIL)** with **50% Horizontal Mirror Symmetry Augmentation**.
  - **Champion Anchor (`Race Best` / `Alt+4`)**: Every new `#1` Personal Best finished lap automatically locks its neural weights and sector speed profile into a **Champion Anchor** so `RACE BEST` always drives your fastest proven lap with zero exploration noise.
  - **Watch Me (`Alt+3`)**: Drive 1–3 laps yourself (`WASD` or Arrow keys). PolyPilot records your continuous steering/throttle profile into **Top Runs** (`YOU` badge) and clones your racing line.
  - **Top Runs Replay**: Click **Replay** on any entry in the **Top Runs** tab to replay that run.
- **Save & Load Track Brains**:
  - Automatically saves trained weights, Champion Anchor, sector speed memory, and Top Runs per track in `IndexedDB` + `chrome.storage.local` using unique FNV-1a track geometry fingerprints.
  - One-click **Export Brain** (`.polybrain.json`) and **Load File** in the **Save / Load** tab.

---

## Install or Reload in Brave Browser (15 Seconds)

### Option A — Load / Reload in Your Main Brave Profile (Recommended)
1. Open Brave and go to `brave://extensions`
2. Toggle **Developer mode** ON (top-right switch).
3. If loading for the first time, click **Load unpacked** and select:
   ```text
   /Users/charlesnesti/PolyTrackAI/extension
   ```
   *(If already loaded, click the circular **Reload `↻`** icon on the **PolyPilot AI** card!)*
4. Open or refresh (`Cmd + R`) [https://www.kodub.com/apps/polytrack](https://www.kodub.com/apps/polytrack), enter any track, and click **AUTO TRAIN** (or **RACE BEST** / **WATCH ME**) in the top-right **POLYPILOT AI** overlay.

### Option B — 1-Click Dedicated Racing Window
Double-click [`Launch PolyTrack AI.command`](Launch%20PolyTrack%20AI.command) in Finder (or run `./Launch\ PolyTrack\ AI.command`) to launch an isolated Brave window straight into PolyTrack with the extension pre-loaded.

---

## In-Game Shortcuts

- `Alt + P` (`Option + P`): Collapse or expand the PolyPilot HUD overlay
- `Alt + 1`: **Standby** — release all keys and pause AI
- `Alt + 2`: **Auto Train** — autonomous 3D RL + sector speed adaptation + Top-Runs self-imitation
- `Alt + 3`: **Watch Me** — record your human driving into Top Runs & clone
- `Alt + 4`: **Race Best** — drive locked Champion Anchor brain with zero exploration noise

---

## Automated Live Verification

Run the end-to-end Brave + live PolyTrack verification suite:

```bash
python3 /Users/charlesnesti/PolyTrackAI/scripts/verify_live_polytrack.py
```
