(() => {
  'use strict';

  const KEY_SPECS = {
    KeyW: { key: 'w', code: 'KeyW', keyCode: 87 },
    KeyA: { key: 'a', code: 'KeyA', keyCode: 65 },
    KeyS: { key: 's', code: 'KeyS', keyCode: 83 },
    KeyD: { key: 'd', code: 'KeyD', keyCode: 68 },
    KeyT: { key: 't', code: 'KeyT', keyCode: 84 },
    KeyR: { key: 'r', code: 'KeyR', keyCode: 82 }
  };

  function clamp(v, lo, hi) {
    return v < lo ? lo : (v > hi ? hi : v);
  }

  class CarController {
    constructor() {
      this.syntheticHeld = {
        KeyW: false,
        KeyA: false,
        KeyS: false,
        KeyD: false,
        KeyT: false,
        KeyR: false
      };

      this.humanHeld = {
        up: false,
        down: false,
        left: false,
        right: false
      };
      this.humanSmoothSteer = 0;
      this.humanSmoothPedal = 0;
      this.lastHumanInputAt = 0;
      this.resetInFlight = false;

      // 100 Hz Sigma-Delta continuous key modulation state
      this.modulationActive = false;
      this.targetSteer = 0; // -1.0 (Left) .. +1.0 (Right)
      this.targetPedal = 0; // -1.0 (Brake) .. +1.0 (Throttle)
      this._sdSteerAcc = 0;
      this._sdPedalAcc = 0;
      this._prevSteerSign = 0;
      this._prevPedalSign = 0;

      this._bindHumanListeners();
      this._startModulator();
    }

    _bindHumanListeners() {
      const updateHumanKey = (ev, isDown) => {
        if (ev.__polyPilotSynthetic) return;
        const code = ev.code;
        let matched = false;
        if (code === 'KeyW' || code === 'ArrowUp') {
          this.humanHeld.up = isDown;
          matched = true;
        } else if (code === 'KeyS' || code === 'ArrowDown') {
          this.humanHeld.down = isDown;
          matched = true;
        } else if (code === 'KeyA' || code === 'ArrowLeft') {
          this.humanHeld.left = isDown;
          matched = true;
        } else if (code === 'KeyD' || code === 'ArrowRight') {
          this.humanHeld.right = isDown;
          matched = true;
        }
        if (matched && isDown) {
          this.lastHumanInputAt = performance.now();
        }
      };

      window.addEventListener('keydown', (e) => updateHumanKey(e, true), true);
      window.addEventListener('keyup', (e) => updateHumanKey(e, false), true);
      window.addEventListener('blur', () => {
        this.humanHeld.up = false;
        this.humanHeld.down = false;
        this.humanHeld.left = false;
        this.humanHeld.right = false;
      });
    }

    _startModulator() {
      setInterval(() => {
        if (!this.modulationActive || this.resetInFlight) return;
        this._sigmaDeltaStep();
      }, 10);
    }

    _sigmaDeltaStep() {
      const s = this.targetSteer;
      const p = this.targetPedal;

      // 1. Proportional Steering via 1st-order Sigma-Delta modulator
      let wantLeft = false;
      let wantRight = false;
      const absS = Math.abs(s);
      if (absS < 0.035) {
        this._sdSteerAcc = 0;
        this._prevSteerSign = 0;
      } else if (absS >= 0.90) {
        this._sdSteerAcc = 0;
        wantLeft = s < 0;
        wantRight = s > 0;
        this._prevSteerSign = s > 0 ? 1 : -1;
      } else {
        const signS = s > 0 ? 1 : -1;
        if (signS !== this._prevSteerSign) {
          this._sdSteerAcc = 0.55;
          this._prevSteerSign = signS;
        }
        this._sdSteerAcc += absS;
        if (this._sdSteerAcc >= 1.0) {
          this._sdSteerAcc -= 1.0;
          wantLeft = signS < 0;
          wantRight = signS > 0;
        }
      }

      // 2. Proportional Throttle / Trail-Braking via 1st-order Sigma-Delta modulator
      let wantUp = false;
      let wantDown = false;
      const absP = Math.abs(p);
      if (absP < 0.07) {
        this._sdPedalAcc = 0;
        this._prevPedalSign = 0;
      } else if (p >= 0.85) {
        this._sdPedalAcc = 0;
        wantUp = true;
        this._prevPedalSign = 1;
      } else if (p <= -0.86) {
        this._sdPedalAcc = 0;
        wantDown = true;
        this._prevPedalSign = -1;
      } else {
        const signP = p > 0 ? 1 : -1;
        if (signP !== this._prevPedalSign) {
          this._sdPedalAcc = 0.55;
          this._prevPedalSign = signP;
        }
        this._sdPedalAcc += absP;
        if (this._sdPedalAcc >= 1.0) {
          this._sdPedalAcc -= 1.0;
          wantUp = signP > 0;
          wantDown = signP < 0;
        }
      }

      this.dispatchKey('KeyA', wantLeft);
      this.dispatchKey('KeyD', wantRight);
      this.dispatchKey('KeyW', wantUp);
      this.dispatchKey('KeyS', wantDown);
    }

    dispatchKey(codeName, isDown) {
      const spec = KEY_SPECS[codeName];
      if (!spec) return;
      if (this.syntheticHeld[codeName] === isDown) return;
      this.syntheticHeld[codeName] = isDown;

      const eventType = isDown ? 'keydown' : 'keyup';
      const ev = new KeyboardEvent(eventType, {
        key: spec.key,
        code: spec.code,
        keyCode: spec.keyCode,
        which: spec.keyCode,
        bubbles: true,
        cancelable: true,
        composed: true,
        repeat: false
      });
      Object.defineProperty(ev, '__polyPilotSynthetic', { value: true, enumerable: false });
      window.dispatchEvent(ev);
    }

    /**
     * Set continuous steering [-1..+1] and pedal [-1..+1] targets with immediate Sigma-Delta update.
     */
    applyContinuous(steer, pedal) {
      if (this.resetInFlight) return;
      this.targetSteer = clamp(steer, -1.0, 1.0);
      this.targetPedal = clamp(pedal, -1.0, 1.0);
      this.modulationActive = true;
      this._sigmaDeltaStep();
    }

    /**
     * Discrete compatibility wrapper:
     * steerIdx: 0 = Left (-1), 1 = Straight (0), 2 = Right (+1)
     * pedalIdx: 0 = Accelerate (+1), 1 = Coast (0), 2 = Brake (-1)
     */
    applyAction(steerIdx, pedalIdx) {
      const steer = steerIdx === 0 ? -1.0 : (steerIdx === 2 ? 1.0 : 0.0);
      const pedal = pedalIdx === 0 ? 1.0 : (pedalIdx === 2 ? -1.0 : 0.0);
      this.applyContinuous(steer, pedal);
    }

    releaseAll() {
      this.modulationActive = false;
      this.targetSteer = 0;
      this.targetPedal = 0;
      this._sdSteerAcc = 0;
      this._sdPedalAcc = 0;
      this._prevSteerSign = 0;
      this._prevPedalSign = 0;
      for (const k of Object.keys(this.syntheticHeld)) {
        if (this.syntheticHeld[k]) {
          this.dispatchKey(k, false);
        }
      }
    }

    reassertHeldKeys() {
      if (this.resetInFlight) return;
      const active = Object.keys(this.syntheticHeld).filter((k) => this.syntheticHeld[k]);
      for (const k of active) {
        this.dispatchKey(k, false);
        this.dispatchKey(k, true);
      }
    }

    getHumanAction(workerControls = null) {
      let up = this.humanHeld.up;
      let down = this.humanHeld.down;
      let left = this.humanHeld.left;
      let right = this.humanHeld.right;

      if (!up && !down && !left && !right && workerControls) {
        up = !!workerControls.up;
        down = !!workerControls.down;
        left = !!workerControls.left;
        right = !!workerControls.right;
      }

      let rawSteer = 0;
      if (left && !right) rawSteer = -1.0;
      else if (right && !left) rawSteer = 1.0;

      let rawPedal = 0;
      if (up && !down) rawPedal = 1.0;
      else if (down) rawPedal = -1.0;

      // Light exponential smoothing captures human duty-cycle tapping as smooth analog intent!
      this.humanSmoothSteer = 0.45 * this.humanSmoothSteer + 0.55 * rawSteer;
      this.humanSmoothPedal = 0.40 * this.humanSmoothPedal + 0.60 * rawPedal;

      const steerIdx = rawSteer < -0.25 ? 0 : (rawSteer > 0.25 ? 2 : 1);
      const pedalIdx = rawPedal > 0.25 ? 0 : (rawPedal < -0.25 ? 2 : 1);

      return {
        steer: clamp(this.humanSmoothSteer, -1.0, 1.0),
        pedal: clamp(this.humanSmoothPedal, -1.0, 1.0),
        steerIdx,
        pedalIdx,
        anyPressed: up || down || left || right
      };
    }

    _sleepMs(ms) {
      return new Promise((resolve) => setTimeout(resolve, ms));
    }

    _waitFramesOrMs(frames = 2, maxMs = 280) {
      return new Promise((resolve) => {
        let done = false;
        const timer = setTimeout(() => {
          if (!done) {
            done = true;
            resolve();
          }
        }, maxMs);
        let rem = frames;
        const step = () => {
          if (done) return;
          rem -= 1;
          if (rem <= 0) {
            done = true;
            clearTimeout(timer);
            resolve();
          } else {
            window.requestAnimationFrame(step);
          }
        };
        window.requestAnimationFrame(step);
      });
    }

    async triggerReset(mode = 'start') {
      if (this.resetInFlight) return;
      this.resetInFlight = true;
      try {
        this.releaseAll();

        const primaryKey = mode === 'checkpoint' ? 'KeyR' : 'KeyT';
        this.dispatchKey(primaryKey, true);
        await this._sleepMs(70);
        this.dispatchKey(primaryKey, false);
        await this._sleepMs(55);

        const tap = typeof window !== 'undefined' ? window.__POLYPILOT_TAP__ : null;
        if (mode === 'start' && tap?.latestCarState) {
          if (tap.latestCarState.hasFinished) {
            this.dispatchKey('KeyR', true);
            await this._sleepMs(60);
            this.dispatchKey('KeyR', false);
            await this._sleepMs(45);
          }
          // Wait until simulation_worker confirms timer reset to 0 before starting new episode
          const waitStart = performance.now();
          let retried = false;
          while ((performance.now() - waitStart) < 380) {
            const cs = tap.latestCarState;
            if (!cs || (!cs.hasFinished && (cs.timeMs || 0) < 250)) {
              break;
            }
            if (!retried && (performance.now() - waitStart) >= 160) {
              retried = true;
              this.dispatchKey('KeyT', true);
              await this._sleepMs(65);
              this.dispatchKey('KeyT', false);
            }
            await this._sleepMs(20);
          }
        }
      } finally {
        this.resetInFlight = false;
      }
    }
  }

  window.PolyPilotControls = {
    CarController,
    STEER_LABELS: ['LEFT', 'STRAIGHT', 'RIGHT'],
    PEDAL_LABELS: ['THROTTLE', 'COAST', 'BRAKE']
  };
})();
