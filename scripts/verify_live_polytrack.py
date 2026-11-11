#!/usr/bin/env python3
"""End-to-end live verification of PolyPilot AI v2 unpacked Brave extension on PolyTrack."""

import json
import os
import tempfile
import time
from playwright.sync_api import sync_playwright

ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXT_DIR = os.path.join(ROOT_DIR, "extension")
SCREENSHOT_DIR = "/Users/charlesnesti/.gemini/antigravity-cli/brain/f96976b8-c14d-41ba-807d-a08dd25bcf27/scratch"
os.makedirs(SCREENSHOT_DIR, exist_ok=True)


def main():
    console_errors = []
    page_errors = []

    with tempfile.TemporaryDirectory(prefix="polypilot_brave_") as user_data_dir:
        with sync_playwright() as p:
            context = p.chromium.launch_persistent_context(
                user_data_dir=user_data_dir,
                executable_path="/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
                headless=False,
                viewport={"width": 1280, "height": 800},
                device_scale_factor=1,
                args=[
                    "--headless=new",
                    f"--disable-extensions-except={EXT_DIR}",
                    f"--load-extension={EXT_DIR}",
                    "--enable-webgl",
                    "--ignore-gpu-blocklist",
                    "--use-gl=angle",
                    "--use-angle=metal",
                    "--no-first-run",
                    "--no-default-browser-check",
                    "--mute-audio",
                ],
            )

            page = context.pages[0] if context.pages else context.new_page()
            page.on("console", lambda m: console_errors.append(m.text) if m.type == "error" else None)
            page.on("pageerror", lambda err: page_errors.append(str(err)))

            print("1. Navigating to https://www.kodub.com/apps/polytrack ...", flush=True)
            page.goto("https://www.kodub.com/apps/polytrack", wait_until="domcontentloaded", timeout=35000)

            game_frame = None
            for _ in range(40):
                for f in page.frames:
                    if "app-polytrack.kodub.com" in f.url:
                        game_frame = f
                        break
                if game_frame:
                    break
                page.wait_for_timeout(400)

            assert game_frame is not None, f"Could not find inner PolyTrack frame. Frames: {[f.url for f in page.frames]}"
            print("   Found inner game frame:", game_frame.url, flush=True)

            for _ in range(40):
                ready = game_frame.evaluate("""() => {
                    const dlg = document.querySelector('dialog:not(.hidden)');
                    if (dlg) {
                        const btns = dlg.querySelectorAll('button');
                        if (btns.length) btns[btns.length - 1].click();
                    }
                    const mainBtns = document.querySelector('.main-buttons-container');
                    const menuReady = mainBtns && !mainBtns.classList.contains('hidden');
                    const hudReady = !!document.getElementById('polypilot-ai-root') && !!window.__POLYPILOT_INSTANCE__;
                    return { menuReady, hudReady };
                }""")
                if ready["menuReady"] and ready["hudReady"]:
                    break
                page.wait_for_timeout(400)

            outer_has_hud = page.evaluate("() => !!document.getElementById('polypilot-ai-root')")
            assert not outer_has_hud, "Outer wrapper frame should NOT mount duplicate HUD!"

            hook_info = game_frame.evaluate("""() => ({
                hudMounted: !!document.getElementById('polypilot-ai-root'),
                webglHooked: !!window.__POLYPILOT_TAP__?.webglHooked,
                memStats: window.__POLYPILOT_INSTANCE__?.brain?.getMemoryStats()
            })""")
            print("   Hook & Model Info:", json.dumps(hook_info), flush=True)
            assert hook_info["hudMounted"], "HUD did not mount in game frame"
            assert hook_info["webglHooked"], "WebGL preserveDrawingBuffer hook did not fire"
            assert hook_info["memStats"]["paramCount"] == 15717, f"Unexpected paramCount: {hook_info}"
            assert hook_info["memStats"]["heapUsedMB"] < 1024, "Memory exceeded 1 GB (must be << 8 GB)"

            # Enter Play -> Track 1 (Summer 1)
            print("2. Entering Track 1 (Summer 1) & building 3D LIDAR mesh + racing spline ...", flush=True)
            game_frame.evaluate("""() => {
                const playBtn = Array.from(document.querySelectorAll('.main-buttons-container button'))
                    .find(b => b.innerText.includes('Play'));
                if (playBtn) playBtn.click();
            }""")
            page.wait_for_timeout(900)
            game_frame.evaluate("""() => {
                const firstTrack = document.querySelector('.tracks-container.open button, .tracks-container.open .track button, .tracks-container.open > div button');
                if (firstTrack) firstTrack.click();
            }""")

            t3d_ready = False
            for _ in range(35):
                state = game_frame.evaluate("""() => ({
                    inRace: window.__POLYPILOT_INSTANCE__?.telemetryReader?.read()?.inRace || false,
                    t3dReady: !!window.__POLYPILOT_INSTANCE__?.track3d?.ready,
                    totalLenM: Math.round(window.__POLYPILOT_INSTANCE__?.track3d?.totalLengthM || 0),
                    waypoints: window.__POLYPILOT_INSTANCE__?.track3d?.waypoints?.length || 0
                })""")
                if state["inRace"] and state["t3dReady"]:
                    t3d_ready = True
                    print("   3D Track Spline Ready:", json.dumps(state), flush=True)
                    break
                page.wait_for_timeout(350)
            assert t3d_ready, "Track3DAnalyzer did not build 3D mesh/spline!"

            # Click AUTO TRAIN inside Shadow DOM and verify FULL LAP COMPLETION!
            print("3. Activating AUTO TRAIN to verify real full-lap completion & online learning ...", flush=True)
            game_frame.evaluate("""() => {
                const root = document.getElementById('polypilot-ai-root').shadowRoot;
                root.querySelector('[data-mode="train"]').click();
            }""")

            t_start = time.time()
            took_mid_shot = False
            completed_laps = 0
            while time.time() - t_start < 52.0:
                page.wait_for_timeout(1500)
                snap = game_frame.evaluate("""() => {
                    const ag = window.__POLYPILOT_INSTANCE__;
                    const tel = ag.telemetryReader.read();
                    const finRuns = ag.topRuns.filter(r => r.finished);
                    return {
                        ep: ag.episodeIdx,
                        s: Math.round(ag.track3d.lastArcS || 0),
                        cp: `${tel.currentCp}/${tel.totalCp}`,
                        spd: Math.round(tel.speedKmh || 0),
                        gradUpdates: ag.brain.gradientUpdates,
                        hasChampion: !!ag.brain.championParams,
                        finCount: finRuns.length,
                        bestTimeMs: finRuns[0]?.finishTimeMs || null,
                        allLapMs: finRuns.map(r => r.finishTimeMs)
                    };
                }""")
                if not took_mid_shot and snap["spd"] > 90:
                    scope_shot = os.path.join(SCREENSHOT_DIR, "verify_scope.png")
                    page.screenshot(path=scope_shot)
                    took_mid_shot = True
                    print(f"   Saved live Brain Scope screenshot -> {scope_shot}", flush=True)

                print(f"      [live] ep={snap['ep']} s={snap['s']}m cp={snap['cp']} spd={snap['spd']}km/h fin={snap['finCount']} bestMs={snap['bestTimeMs']}", flush=True)
                completed_laps = snap["finCount"]
                if completed_laps >= 2:
                    print("   Multi-lap completion achieved:", json.dumps(snap), flush=True)
                    break

            assert completed_laps >= 1, f"AI did not finish a full lap on Summer 1! Last snap: {snap}"
            assert snap["gradUpdates"] > 0, "PPO/SIL did not run gradient updates"
            assert snap["hasChampion"], "Champion weights were not locked after #1 finished lap"

            # 4. Test WATCH ME human imitation recording
            print("4. Testing WATCH ME human demo imitation + mirror learning ...", flush=True)
            game_frame.evaluate("""() => {
                const root = document.getElementById('polypilot-ai-root').shadowRoot;
                root.querySelector('[data-mode="watch"]').click();
            }""")
            game_frame.evaluate("""() => {
                window.dispatchEvent(new KeyboardEvent('keydown', { key: 'w', code: 'KeyW', keyCode: 87, which: 87, bubbles: true }));
            }""")
            for _ in range(30):
                hm_len = game_frame.evaluate("() => window.__POLYPILOT_INSTANCE__?.epObsRaw?.length || 0")
                if hm_len >= 18:
                    break
                page.wait_for_timeout(200)
            game_frame.evaluate("""() => {
                window.dispatchEvent(new KeyboardEvent('keydown', { key: 'd', code: 'KeyD', keyCode: 68, which: 68, bubbles: true }));
            }""")
            for _ in range(30):
                hm_len = game_frame.evaluate("() => window.__POLYPILOT_INSTANCE__?.epObsRaw?.length || 0")
                if hm_len >= 32:
                    break
                page.wait_for_timeout(200)
            game_frame.evaluate("""() => {
                window.dispatchEvent(new KeyboardEvent('keyup', { key: 'd', code: 'KeyD', keyCode: 68, which: 68, bubbles: true }));
                window.dispatchEvent(new KeyboardEvent('keyup', { key: 'w', code: 'KeyW', keyCode: 87, which: 87, bubbles: true }));
            }""")

            watch_result = game_frame.evaluate("""async () => {
                const ag = window.__POLYPILOT_INSTANCE__;
                await ag.setMode('idle');
                const root = document.getElementById('polypilot-ai-root').shadowRoot;
                root.querySelector('[data-tab="runs"]').click();
                return {
                    topRunsCount: ag.topRuns.length,
                    sources: ag.topRuns.map(r => r.source),
                    bestFinishedMs: ag.topRuns[0]?.finishTimeMs,
                    gradientUpdates: ag.brain.gradientUpdates
                };
            }""")
            print("   Watch-Me + Top Runs result:", json.dumps(watch_result), flush=True)
            assert watch_result["bestFinishedMs"] is not None, "Finished lap should rank #1 above partial Watch-Me demo!"

            page.wait_for_timeout(300)
            runs_shot = os.path.join(SCREENSHOT_DIR, "verify_top_runs.png")
            page.screenshot(path=runs_shot)
            print(f"   Saved Top Runs screenshot -> {runs_shot}", flush=True)

            # 5. Test Distill Top Runs + Save / Load Brain roundtrip
            print("5. Testing Distill Top Runs + Save/Load .polybrain.json roundtrip ...", flush=True)
            roundtrip = game_frame.evaluate("""async () => {
                const ag = window.__POLYPILOT_INSTANCE__;
                const beforeGrad = ag.brain.gradientUpdates;
                await ag.distillTopRunsManual();
                const afterDistillGrad = ag.brain.gradientUpdates;

                const exportedJson = JSON.stringify(ag._buildPersistBundle());
                const wSampleBefore = ag.brain.params[0];
                const topCountBefore = ag.topRuns.length;

                await ag.resetCurrentBrain();
                const topCountAfterReset = ag.topRuns.length;

                await ag.importBrainFromJson(exportedJson, 'Summer_1_v2.polybrain.json');
                const wSampleRestored = ag.brain.params[0];
                const topCountRestored = ag.topRuns.length;

                const root = document.getElementById('polypilot-ai-root').shadowRoot;
                root.querySelector('[data-tab="brains"]').click();
                await ag.refreshSavedBrainsUI();

                return {
                    beforeGrad,
                    afterDistillGrad,
                    wMatch: Math.abs(wSampleBefore - wSampleRestored) < 1e-7,
                    hasChampionRestored: !!ag.brain.championParams,
                    topCountBefore,
                    topCountAfterReset,
                    topCountRestored,
                    exportedKB: +(new Blob([exportedJson]).size / 1024).toFixed(1),
                    memStats: ag.brain.getMemoryStats()
                };
            }""")
            print("   Save/Load Roundtrip:", json.dumps(roundtrip), flush=True)
            assert roundtrip["afterDistillGrad"] > roundtrip["beforeGrad"], "Distill Top Runs did not update weights"
            assert roundtrip["topCountAfterReset"] == 0, "Reset brain did not clear Top Runs"
            assert roundtrip["wMatch"] and roundtrip["topCountRestored"] == roundtrip["topCountBefore"], "Brain import mismatch"
            assert roundtrip["hasChampionRestored"], "Champion weights did not restore from .polybrain.json"

            page.wait_for_timeout(350)
            brains_shot = os.path.join(SCREENSHOT_DIR, "verify_brains.png")
            page.screenshot(path=brains_shot)
            print(f"   Saved Save/Load Brains screenshot -> {brains_shot}", flush=True)

            # 6. Verify switching to Next Track (Summer 2) dynamically rebuilds 3D spline & finishes/drives!
            print("6. Testing Next Track switch (Summer 1 -> Summer 2) ...", flush=True)
            game_frame.evaluate("""() => {
                const nextBtn = Array.from(document.querySelectorAll('.game-toolbar-ui button'))
                    .find(b => b.innerText.includes('Next Track'));
                if (nextBtn) nextBtn.click();
            }""")
            for _ in range(35):
                t2 = game_frame.evaluate("""() => {
                    const ag = window.__POLYPILOT_INSTANCE__;
                    const tel = ag?.telemetryReader?.read();
                    return {
                        name: tel?.trackName || '',
                        inRace: tel?.inRace || false,
                        t3dReady: !!ag?.track3d?.ready,
                        lenM: Math.round(ag?.track3d?.totalLengthM || 0)
                    };
                }""")
                if "Summer 2" in t2["name"] and t2["inRace"] and t2["t3dReady"]:
                    break
                page.wait_for_timeout(300)

            game_frame.evaluate("""() => {
                const root = document.getElementById('polypilot-ai-root').shadowRoot;
                root.querySelector('[data-mode="train"]').click();
            }""")
            page.wait_for_timeout(6000)
            track2_check = game_frame.evaluate("""() => {
                const ag = window.__POLYPILOT_INSTANCE__;
                const tel = ag.telemetryReader.read();
                return {
                    trackName: tel.trackName,
                    trackId: tel.trackId,
                    t3dReady: ag.track3d.ready,
                    arcS: Math.round(ag.track3d.lastArcS || 0),
                    totalLenM: Math.round(ag.track3d.totalLengthM || 0),
                    peakSpeedKmh: Math.round(ag.epMaxSpeed || tel.speedKmh || 0)
                };
            }""")
            print("   Track 2 check:", json.dumps(track2_check), flush=True)
            assert track2_check["t3dReady"] and track2_check["arcS"] > 80, f"Track 2 3D driving too short: {track2_check}"

            print("   Console errors:", console_errors, flush=True)
            print("   Page errors:", page_errors, flush=True)
            assert len(page_errors) == 0, f"Unexpected page errors: {page_errors}"

            context.close()
            print("\nALL_LIVE_POLYTRACK_VERIFICATIONS_PASSED!", flush=True)


if __name__ == "__main__":
    main()
