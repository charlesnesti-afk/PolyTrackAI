(() => {
  'use strict';

  function parseTimeMs(text) {
    if (!text) return null;
    const cleaned = text.replace(/\s+/g, '').trim();
    if (!cleaned || cleaned.indexOf('-') !== -1) return null;
    const m = cleaned.match(/^(?:(\d+):)?(\d{1,2}):(\d{2})\.(\d{1,3})$/);
    if (m) {
      const hrs = m[1] ? parseInt(m[1], 10) : 0;
      const mins = parseInt(m[2], 10);
      const secs = parseInt(m[3], 10);
      const ms = parseInt(m[4].padEnd(3, '0'), 10);
      return ((hrs * 3600 + mins * 60 + secs) * 1000) + ms;
    }
    const sOnly = cleaned.match(/^(\d+)\.(\d{1,3})$/);
    if (sOnly) {
      return parseInt(sOnly[1], 10) * 1000 + parseInt(sOnly[2].padEnd(3, '0'), 10);
    }
    return null;
  }

  function sanitizeTrackKey(name, totalCp, sig) {
    const base = (name || 'Unknown Track')
      .trim()
      .replace(/[^a-zA-Z0-9 _-]+/g, '')
      .replace(/\s+/g, '_')
      .slice(0, 48) || 'Track';
    if (sig) return `${base}__${sig}`;
    if (totalCp > 0) return `${base}__cp${totalCp}`;
    return base;
  }

  class TelemetryReader {
    constructor() {
      this.prevSpeedKmh = 0;
      this.lastTrackName = 'PolyTrack';
      this.lastTotalCp = 0;
    }

    read() {
      const screenCanvas = document.getElementById('screen');
      const uiRoot = document.getElementById('ui');
      const gameUi = uiRoot ? uiRoot.querySelector('.game-ui') : null;
      const menuUi = uiRoot ? uiRoot.querySelector('.menu-ui') : null;
      const pauseUi = uiRoot ? uiRoot.querySelector('.pause-screen-ui') : null;
      const loadingScreen = uiRoot ? uiRoot.querySelector('.loading-screen-ui, .loading-ui') : null;

      const gameVisible = !!(gameUi && !gameUi.classList.contains('hidden'));
      const menuVisible = !!(menuUi && !menuUi.classList.contains('hidden') && menuUi.offsetParent !== null);
      const isPaused = !!(pauseUi && !pauseUi.classList.contains('hidden') && pauseUi.offsetParent !== null);
      const isLoading = !!(loadingScreen && !loadingScreen.classList.contains('hidden') && loadingScreen.offsetParent !== null);
      const inRace = gameVisible && !menuVisible && !isLoading;

      // 1. Track Name
      const trackNameEl = gameUi ? gameUi.querySelector('.game-toolbar-ui .track-name') : null;
      const domTrackName = trackNameEl ? trackNameEl.textContent.trim() : '';
      if (domTrackName) this.lastTrackName = domTrackName;

      // 2. HUD Speedometer
      let domSpeedKmh = 0;
      const speedDigitsEl = gameUi ? gameUi.querySelector('.speedometer-ui .box .container > span:first-child') : null;
      if (speedDigitsEl) {
        const parsed = parseFloat(speedDigitsEl.textContent.replace(/[^0-9.-]/g, ''));
        if (!Number.isNaN(parsed)) domSpeedKmh = parsed;
      }

      // 3. HUD Checkpoints ("1/3")
      let domCurrentCp = 0;
      let domTotalCp = this.lastTotalCp;
      const cpEl = gameUi ? gameUi.querySelector('.checkpoint-ui span') : null;
      if (cpEl) {
        const cpMatch = cpEl.textContent.trim().match(/(\d+)\s*\/\s*(\d+)/);
        if (cpMatch) {
          domCurrentCp = parseInt(cpMatch[1], 10);
          domTotalCp = parseInt(cpMatch[2], 10);
          this.lastTotalCp = domTotalCp;
        }
      }

      // 4. HUD Timers
      const curTimeEl = gameUi ? gameUi.querySelector('.timer-ui .center .time') : null;
      const recTimeEl = gameUi ? gameUi.querySelector('.timer-ui .left .time') : null;
      const domTimeMs = curTimeEl ? (parseTimeMs(curTimeEl.textContent) ?? 0) : 0;
      const recordTimeMs = recTimeEl ? parseTimeMs(recTimeEl.textContent) : null;

      // 5. Finish Hint Backup Check
      const hintEl = gameUi ? gameUi.querySelector('.hint-ui') : null;
      const hintVisible = !!(hintEl && !hintEl.classList.contains('hide') && !hintEl.classList.contains('hidden'));
      const hintText = hintVisible ? hintEl.textContent : '';
      const domFinished = /improve your time|try again/i.test(hintText);

      // 6. Fuse with Passive Simulation Worker Tap
      const tap = window.__POLYPILOT_TAP__;
      const now = performance.now();
      const workerFresh = !!(tap && tap.latestCarState && (now - tap.latestCarStateAt) < 2500);
      const cs = workerFresh ? tap.latestCarState : null;

      const speedKmh = cs ? cs.speedKmh : domSpeedKmh;
      const accelKmhPerTick = speedKmh - this.prevSpeedKmh;
      this.prevSpeedKmh = speedKmh;

      const timeMs = cs ? cs.timeMs : domTimeMs;
      const hasStarted = cs ? cs.hasStarted : (timeMs > 0 || Math.abs(speedKmh) > 0.5);
      const hasFinished = cs ? cs.hasFinished : domFinished;
      const finishTimeMs = cs && cs.finishTimeMs != null
        ? cs.finishTimeMs
        : (hasFinished && domTimeMs > 0 ? domTimeMs : null);

      const currentCp = cs ? Math.max(domCurrentCp, cs.nextCheckpointIndex) : domCurrentCp;
      const trackSig = tap ? tap.trackSignature : null;
      const trackId = sanitizeTrackKey(this.lastTrackName, domTotalCp, trackSig);

      return {
        screenCanvas,
        inRace,
        isPaused,
        menuVisible,
        trackName: this.lastTrackName || 'Summer 1',
        trackId,
        trackLoadSeq: tap ? tap.trackLoadSeq : 0,
        speedKmh,
        accelKmhPerTick,
        timeMs,
        recordTimeMs,
        currentCp,
        totalCp: domTotalCp,
        hasStarted,
        hasFinished,
        finishTimeMs,
        workerActive: workerFresh,
        position: cs ? cs.position : null,
        quaternion: cs ? cs.quaternion : null,
        forward: cs ? cs.forward : null,
        right: cs ? cs.right : null,
        up: cs ? cs.up : null,
        velocity: cs ? cs.velocity : null,
        slipAngle: cs ? (cs.slipAngle || 0) : 0,
        yawRate: cs ? (cs.yawRate || 0) : 0,
        pitch: cs ? (cs.pitch || 0) : 0,
        groundedWheels: cs ? cs.groundedWheels : 4,
        avgSkid: cs ? cs.avgSkid : 0,
        steering: cs ? cs.steering : 0,
        maxCollisionImpulse: cs ? cs.maxCollisionImpulse : 0,
        workerControls: cs ? cs.controls : (tap ? tap.latestSentControls : null)
      };
    }
  }

  window.PolyPilotTelemetry = {
    TelemetryReader,
    parseTimeMs,
    sanitizeTrackKey
  };
})();
