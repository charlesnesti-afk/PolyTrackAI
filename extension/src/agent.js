(() => {
  'use strict';
  if (typeof window !== 'undefined') {
    if (window.__POLYPILOT_AGENT_BOOTED__) return;
    window.__POLYPILOT_AGENT_BOOTED__ = true;
  }

  const { VisionProcessor } = (typeof window !== 'undefined' && window.PolyPilotVision) || {};
  const { Track3DAnalyzer } = (typeof window !== 'undefined' && window.PolyPilotTrack3D) || {};
  const { TelemetryReader } = (typeof window !== 'undefined' && window.PolyPilotTelemetry) || {};
  const { CarController } = (typeof window !== 'undefined' && window.PolyPilotControls) || {};
  const {
    PolyTinyNet,
    TrackSectorMemory,
    buildObservation,
    packTrajectory,
    unpackTrajectory,
    insertTopRun
  } = (typeof window !== 'undefined' && window.PolyPilotBrain) || {};
  const { BrainStorage } = (typeof window !== 'undefined' && window.PolyPilotStorage) || {};
  const { PolyPilotHUD, formatMs } = (typeof window !== 'undefined' && window.PolyPilotHUD) || { formatMs: () => '' };

  const TICK_MS = 40; // 25 Hz neural planning + 100 Hz Sigma-Delta proportional actuation
  const CP_TOLERANCE_MS = 1000.0; // Reset unless fastest checkpoint or within 1.0s (+1000ms)

  /**
   * SectionBenchmarkTracker: Checkpoint +1.0s (+1000ms) Reset Tracker.
   * Tracks fastest cumulative race time at each checkpoint (1..totalCp) and Finish.
   * Immediately prunes a run if it crosses a checkpoint slower than fastest + 1000ms,
   * or if live elapsed time before reaching the next checkpoint already exceeds fastest + 1000ms.
   * Uses a 500ms clean post-checkpoint survival buffer so kamikaze gate-slams never poison records.
   */
  class SectionBenchmarkTracker {
    constructor(maxCheckpoints = 64, toleranceMs = CP_TOLERANCE_MS) {
      this.maxSections = maxCheckpoints;
      this.toleranceMs = toleranceMs;
      this.bestCpMs = new Float32Array(maxCheckpoints).fill(Infinity);
      this.bestCumulativeMs = this.bestCpMs;
      this.bestFinishMs = Infinity;
      this.maxObservedCp = 0;
      this.resetEpisode();
    }

    ensureSize(numCheckpoints) {
      if (numCheckpoints <= this.maxSections) return;
      const nextMax = Math.max(numCheckpoints + 8, this.maxSections * 2);
      const nextCp = new Float32Array(nextMax).fill(Infinity);
      nextCp.set(this.bestCpMs);
      this.bestCpMs = nextCp;
      this.bestCumulativeMs = nextCp;
      this.maxSections = nextMax;
    }

    resetEpisode() {
      this.lastCp = 0;
      this.prevRaceTimeMs = 0;
      this.lastDeltaMs = null;
      this.episodeCheckedStart = false;
      this.episodeValidFromStart = true;
      // Post-checkpoint survival queue: { cpIdx, crossingTimeMs, commitAtMs }
      this.stagedEntries = [];
    }

    onWallContact(discardStaged = true) {
      if (discardStaged) {
        this.stagedEntries = [];
      }
    }

    update(curS, raceTimeMs, telemetry, track3d) {
      const curCp = Math.max(0, (telemetry && telemetry.currentCp) || 0);
      if (raceTimeMs + 250 < this.prevRaceTimeMs && raceTimeMs < 800 && curCp === 0) {
        this.resetEpisode();
      }
      this.prevRaceTimeMs = raceTimeMs;

      const totalCp = Math.max(
        (telemetry && telemetry.totalCp) || 0,
        (track3d && track3d.ready) ? (track3d.totalCheckpoints || 0) : 0,
        this.maxObservedCp,
        curCp
      );
      if (curCp > this.maxObservedCp) {
        this.maxObservedCp = curCp;
      }
      this.ensureSize(totalCp + 4);

      if (curCp === 0 && raceTimeMs >= 0 && raceTimeMs < 1200) {
        this.episodeCheckedStart = true;
        this.episodeValidFromStart = true;
      } else if (!this.episodeCheckedStart && ((telemetry && telemetry.hasStarted) || raceTimeMs >= 1200 || curCp > 0)) {
        this.episodeCheckedStart = true;
        this.episodeValidFromStart = false;
      }

      if (telemetry && telemetry.maxCollisionImpulse > 45) {
        this.onWallContact(true);
      }

      while (this.stagedEntries.length > 0 && raceTimeMs >= this.stagedEntries[0].commitAtMs) {
        const committed = this.stagedEntries.shift();
        if (committed.crossingTimeMs < this.bestCpMs[committed.cpIdx]) {
          this.bestCpMs[committed.cpIdx] = committed.crossingTimeMs;
        }
      }

      // 1. Check newly crossed checkpoints: must be fastest or within +1000ms
      while (this.lastCp < curCp) {
        const cp = this.lastCp + 1;
        this.ensureSize(cp + 2);
        const bestAtCp = this.bestCpMs[cp];
        if (bestAtCp < Infinity) {
          this.lastDeltaMs = Math.round(raceTimeMs - bestAtCp);
          if (this.episodeValidFromStart && raceTimeMs > bestAtCp + this.toleranceMs) {
            return {
              pruned: true,
              reason: 'checkpoint_prune',
              secInfo: {
                cp: `${cp}/${totalCp || cp}`,
                nextTargetMs: Math.round(bestAtCp),
                deltaMs: this.lastDeltaMs,
                prunedCp: `CP ${cp}`
              }
            };
          }
        } else {
          this.lastDeltaMs = 0;
        }

        if (this.episodeValidFromStart && raceTimeMs > 0) {
          this.stagedEntries.push({
            cpIdx: cp,
            crossingTimeMs: raceTimeMs,
            commitAtMs: raceTimeMs + 500.0
          });
        }
        this.lastCp = cp;
      }

      // 2. Live deadline check before reaching the next checkpoint (or Finish)
      let targetBestMs = Infinity;
      let targetLabel = 'Finish';
      if (totalCp > 0 && curCp < totalCp) {
        const nextCp = curCp + 1;
        targetBestMs = this.bestCpMs[nextCp];
        targetLabel = `CP ${nextCp}`;
      } else {
        targetBestMs = this.bestFinishMs;
        targetLabel = 'Finish';
      }

      if (this.episodeValidFromStart &&
          raceTimeMs > this.toleranceMs &&
          targetBestMs < Infinity &&
          raceTimeMs > targetBestMs + this.toleranceMs) {
        const liveDelta = Math.round(raceTimeMs - targetBestMs);
        return {
          pruned: true,
          reason: 'checkpoint_prune',
          secInfo: {
            cp: `${curCp}/${totalCp || '?'}`,
            nextTargetMs: Math.round(targetBestMs),
            deltaMs: liveDelta,
            prunedCp: targetLabel
          }
        };
      }

      return {
        pruned: false,
        reason: null,
        secInfo: {
          cp: `${curCp}/${totalCp || '?'}`,
          nextTargetMs: targetBestMs < Infinity ? Math.round(targetBestMs) : null,
          deltaMs: this.lastDeltaMs
        }
      };
    }

    onLapFinishedCleanly(finishTimeMs) {
      if (this.episodeValidFromStart) {
        while (this.stagedEntries.length > 0) {
          const committed = this.stagedEntries.shift();
          if (committed.crossingTimeMs < this.bestCpMs[committed.cpIdx]) {
            this.bestCpMs[committed.cpIdx] = committed.crossingTimeMs;
          }
        }
        if (finishTimeMs > 0 && finishTimeMs < this.bestFinishMs) {
          this.bestFinishMs = finishTimeMs;
        }
      } else {
        this.stagedEntries = [];
      }
    }
  }

  /**
   * BackgroundRolloutPool: Lightweight background Bullet WASM rollout fleet
   * (2-3 Web Workers x 2 cars each) running in Train mode.
   */
  class BackgroundRolloutPool {
    constructor(agent) {
      this.agent = agent;
      this.workers = [];
      this.running = false;
      this.rolloutCount = 0;
      this._lastRateCalcAt = performance.now();
      this._lastRolloutSnapshot = 0;
      this.rolloutsPerSec = 0;
      this._virtualVision = {
        rays: new Float32Array(15).fill(0.75),
        rayDeltas: new Float32Array(15),
        horizonGrid: new Float32Array(16).fill(0.5),
        visualTurnBias: 0,
        centerClearance: 0.75
      };
      this._savedCursor = {
        rays: new Float32Array(15),
        prevRays: new Float32Array(15),
        rayDeltas: new Float32Array(15),
        lookAngles: new Float32Array(5),
        lookCurvs: new Float32Array(5),
        centerClearance: 0.75,
        turnBias3D: 0,
        lastArcIndex: 0,
        lastArcS: 0,
        corridorHalfWidth: 4.5,
        lateralOffsetNorm: 0,
        headingError: 0,
        lookaheadPitch: 0
      };
      this._savedBrainCtx = new Float32Array(32);
    }

    get activeWorkers() {
      return this.workers.length;
    }

    get totalCars() {
      return this.workers.reduce((acc, w) => acc + (w.cars ? w.cars.length : 0), 0);
    }

    getStats() {
      const now = performance.now();
      const dt = (now - this._lastRateCalcAt) / 1000.0;
      if (dt >= 1.5) {
        const dRollouts = this.rolloutCount - this._lastRolloutSnapshot;
        this.rolloutsPerSec = +(Math.max(0, dRollouts / dt)).toFixed(1);
        this._lastRateCalcAt = now;
        this._lastRolloutSnapshot = this.rolloutCount;
      }
      return {
        activeWorkers: this.activeWorkers,
        totalCars: this.totalCars,
        rolloutsPerSec: this.rolloutsPerSec
      };
    }

    start() {
      if (this.running) return;
      const tap = (typeof window !== 'undefined' ? window.__POLYPILOT_TAP__ : null);
      if (!tap || !tap.workerScriptURL || !tap.rawInitPayload || !tap.latestTrackData) {
        return;
      }
      this.running = true;
      const numWorkers = 1;
      const carsPerWorker = 4;
      const speedScales = [0.92, 0.98, 1.03, 1.07];
      const WorkerCtor = tap.OrigWorker || Worker;

      for (let w = 0; w < numWorkers; w++) {
        try {
          const worker = new WorkerCtor(tap.workerScriptURL, tap.workerOptions);
          worker.__polyPilotInternal = true;
          worker.addEventListener('error', (errEv) => {
            errEv.preventDefault();
            errEv.stopImmediatePropagation();
          }, true);

          const wMeta = {
            worker,
            workerIdx: w,
            ready: false,
            cars: []
          };

          for (let c = 0; c < carsPerWorker; c++) {
            const carIdx = w * carsPerWorker + c;
            const carId = 8100 + w * 20 + (c + 1);
            const carScale = speedScales[carIdx % speedScales.length];
            const carMeta = {
              carId,
              carIdx,
              speedScale: carScale,
              sectionTracker: new SectionBenchmarkTracker(64),
              context: new Float32Array((this.agent.brain && this.agent.brain.context) ? this.agent.brain.context.length : 32),
              prevRays: new Float32Array(15).fill(0.75),
              lastArcIndex: 0,
              lastArcS: 0,
              lateralOffsetNorm: 0,
              lastSubFrame: -1,
              lastDecisionFrames: -1,
              sdSteerAcc: 0,
              sdPedalAcc: 0,
              prevSteerSign: 0,
              prevPedalSign: 0,
              targetSteer: 0,
              targetPedal: 1,
              tickMaxImp: 0,
              tickColCount: 0,
              epSteps: [],
              epTicks: 0,
              epReturn: 0,
              epLowSpeedSec: 0,
              epMaxArcS: 0,
              epBestCp: 0,
              epHeavyHitArcs: [],
              epLastHitCooldown: 0,
              prevSpeedKmh: 0,
              prevSteer: 0,
              prevPedal: 1
            };
            wMeta.cars.push(carMeta);
          }

          worker.addEventListener('message', (ev) => {
            if (!this.running) return;
            const data = ev.data;
            if (!data) return;

            // Wait for TestDeterminism handshake (messageType 9) so WASM & worker top-level `o` are initialized
            if (!wMeta.ready && (data.messageType === 9 || 'isDeterminstic' in data)) {
              wMeta.ready = true;
              setTimeout(() => {
                if (!this.running) return;
                try {
                  worker.postMessage(tap.rawInitPayload);
                  for (let c = 0; c < wMeta.cars.length; c++) {
                    const cid = wMeta.cars[c].carId;
                    worker.postMessage({
                      messageType: 3,
                      carId: cid,
                      trackData: tap.latestTrackData,
                      carRecording: null,
                      mountainVertices: tap.mountainVertices,
                      mountainOffset: tap.mountainOffset
                    });
                    worker.postMessage({
                      messageType: 5,
                      carId: cid,
                      targetSimulationTimeFrames: null
                    });
                  }
                } catch (_) {}
              }, 25);
              return;
            }

            if (!Array.isArray(data.carStateBuffers)) return;
            const bufs = data.carStateBuffers;
            for (let b = 0; b < bufs.length; b++) {
              const buf = bufs[b];
              if (!buf || buf.byteLength < 44) continue;
              const bytes = new Uint8Array(buf);
              const cid = (bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24)) >>> 0;
              const carMeta = wMeta.cars.find(c => c.carId === cid);
              if (!carMeta) continue;

              const decodeFn = (tap && tap.decodeCarStateBuffer) || null;
              if (!decodeFn) continue;
              const vState = decodeFn(buf, cid);
              if (!vState) continue;

              this._stepVirtualCar(wMeta, carMeta, vState);
            }
          });

          // Kick off WASM readiness handshake first (avoids TDZ on `let o` inside simulation_worker.bundle.js)
          worker.postMessage({ messageType: 2 });

          this.workers.push(wMeta);
        } catch (_) {
          break;
        }
      }
    }

    _saveTrackCursor(track3d) {
      const sc = this._savedCursor;
      sc.rays.set(track3d.rays);
      sc.prevRays.set(track3d.prevRays);
      sc.rayDeltas.set(track3d.rayDeltas);
      sc.lookAngles.set(track3d.lookaheadAngles);
      sc.lookCurvs.set(track3d.lookaheadCurvatures);
      sc.centerClearance = track3d.centerClearance;
      sc.turnBias3D = track3d.turnBias3D;
      sc.lastArcIndex = track3d.lastArcIndex;
      sc.lastArcS = track3d.lastArcS;
      sc.corridorHalfWidth = track3d.corridorHalfWidth;
      sc.lateralOffsetNorm = track3d.lateralOffsetNorm;
      sc.headingError = track3d.headingError;
      sc.lookaheadPitch = track3d.lookaheadPitch;
    }

    _restoreTrackCursor(track3d) {
      const sc = this._savedCursor;
      track3d.rays.set(sc.rays);
      track3d.prevRays.set(sc.prevRays);
      track3d.rayDeltas.set(sc.rayDeltas);
      track3d.lookaheadAngles.set(sc.lookAngles);
      track3d.lookaheadCurvatures.set(sc.lookCurvs);
      track3d.centerClearance = sc.centerClearance;
      track3d.turnBias3D = sc.turnBias3D;
      track3d.lastArcIndex = sc.lastArcIndex;
      track3d.lastArcS = sc.lastArcS;
      track3d.corridorHalfWidth = sc.corridorHalfWidth;
      track3d.lateralOffsetNorm = sc.lateralOffsetNorm;
      track3d.headingError = sc.headingError;
      track3d.lookaheadPitch = sc.lookaheadPitch;
    }

    _sendModulatedSubstep(wMeta, carMeta) {
      const s = carMeta.targetSteer;
      const p = carMeta.targetPedal;
      let wantLeft = false;
      let wantRight = false;
      const absS = Math.abs(s);
      if (absS < 0.035) {
        carMeta.sdSteerAcc = 0;
        carMeta.prevSteerSign = 0;
      } else if (absS >= 0.90) {
        carMeta.sdSteerAcc = 0;
        wantLeft = s < 0;
        wantRight = s > 0;
        carMeta.prevSteerSign = s > 0 ? 1 : -1;
      } else {
        const signS = s > 0 ? 1 : -1;
        if (signS !== carMeta.prevSteerSign) {
          carMeta.sdSteerAcc = 0.55;
          carMeta.prevSteerSign = signS;
        }
        carMeta.sdSteerAcc += absS;
        if (carMeta.sdSteerAcc >= 1.0) {
          carMeta.sdSteerAcc -= 1.0;
          wantLeft = signS < 0;
          wantRight = signS > 0;
        }
      }

      let wantUp = false;
      let wantDown = false;
      const absP = Math.abs(p);
      if (absP < 0.07) {
        carMeta.sdPedalAcc = 0;
        carMeta.prevPedalSign = 0;
      } else if (p >= 0.85) {
        carMeta.sdPedalAcc = 0;
        wantUp = true;
        carMeta.prevPedalSign = 1;
      } else if (p <= -0.86) {
        carMeta.sdPedalAcc = 0;
        wantDown = true;
        carMeta.prevPedalSign = -1;
      } else {
        const signP = p > 0 ? 1 : -1;
        if (signP !== carMeta.prevPedalSign) {
          carMeta.sdPedalAcc = 0.55;
          carMeta.prevPedalSign = signP;
        }
        carMeta.sdPedalAcc += absP;
        if (carMeta.sdPedalAcc >= 1.0) {
          carMeta.sdPedalAcc -= 1.0;
          wantUp = signP > 0;
          wantDown = signP < 0;
        }
      }

      wMeta.worker.postMessage({
        messageType: 6,
        carId: carMeta.carId,
        up: wantUp,
        down: wantDown,
        right: wantRight,
        left: wantLeft,
        reset: false
      });
    }

    _stepVirtualCar(wMeta, carMeta, vState) {
      const agent = this.agent;
      const track3d = agent.track3d;
      const brain = agent.brain;
      const secMem = agent.sectorMemory;

      if (vState.frames === carMeta.lastSubFrame && !vState.hasFinished) return;
      carMeta.lastSubFrame = vState.frames;
      if (vState.maxCollisionImpulse > carMeta.tickMaxImp) {
        carMeta.tickMaxImp = vState.maxCollisionImpulse;
      }
      if (vState.collisionCount > 0) {
        carMeta.tickColCount += vState.collisionCount;
      }

      const needDecision = vState.hasFinished || carMeta.lastDecisionFrames < 0 ||
        (vState.frames - carMeta.lastDecisionFrames) >= 38 ||
        vState.frames < carMeta.lastDecisionFrames;

      if (!needDecision) {
        this._sendModulatedSubstep(wMeta, carMeta);
        return;
      }

      carMeta.lastDecisionFrames = vState.frames;
      carMeta.epTicks += 1;
      const dtSec = 0.04;

      vState.totalCp = (track3d && track3d.totalCheckpoints) || 0;
      vState.currentCp = vState.nextCheckpointIndex || 0;
      vState.accelKmhPerTick = vState.speedKmh - carMeta.prevSpeedKmh;
      carMeta.prevSpeedKmh = vState.speedKmh;

      if (Math.abs(vState.speedKmh) < 6.5 && carMeta.epTicks > 26) {
        carMeta.epLowSpeedSec += dtSec;
      } else {
        carMeta.epLowSpeedSec = Math.max(0, carMeta.epLowSpeedSec - dtSec * 1.6);
      }

      let obs;
      let decision;
      const has3D = !!(track3d && track3d.ready && vState.position);
      if (has3D) {
        this._saveTrackCursor(track3d);
        track3d.lastArcIndex = carMeta.lastArcIndex;
        track3d.rays.set(carMeta.prevRays);
        track3d.update(vState);
        carMeta.lastArcIndex = track3d.lastArcIndex;
        carMeta.lastArcS = track3d.lastArcS;
        carMeta.lateralOffsetNorm = track3d.lateralOffsetNorm;
        carMeta.prevRays.set(track3d.rays);
      }

      try {
        obs = buildObservation(
          this._virtualVision,
          track3d,
          vState,
          secMem,
          carMeta.prevSteer,
          carMeta.prevPedal,
          carMeta.epLowSpeedSec,
          false
        );

        if (this._savedBrainCtx.length !== brain.context.length) {
          this._savedBrainCtx = new Float32Array(brain.context.length);
        }
        if (carMeta.context.length !== brain.context.length) {
          carMeta.context = new Float32Array(brain.context.length);
        }
        this._savedBrainCtx.set(brain.context);
        brain.context.set(carMeta.context);
        decision = brain.act(obs, carMeta.carIdx <= 1);
        carMeta.context.set(brain.context);
        brain.context.set(this._savedBrainCtx);
      } finally {
        if (has3D) {
          this._restoreTrackCursor(track3d);
        }
      }

      let pedal = decision.pedal;
      if (carMeta.speedScale < 0.98) {
        const scaledCap = (brain.lastContinuous.targetSpeedKmh || 160) * carMeta.speedScale;
        if (vState.speedKmh > scaledCap + 3.0) {
          pedal = Math.min(pedal, -0.35);
        } else if (vState.speedKmh > scaledCap - 2.0) {
          pedal = Math.min(pedal, 0.35);
        }
      } else if (carMeta.speedScale > 1.02 && pedal > -0.20) {
        const scaledCap = (brain.lastContinuous.targetSpeedKmh || 160) * carMeta.speedScale;
        if (vState.speedKmh < scaledCap - 2.0) {
          pedal = Math.max(pedal, 0.90);
        }
      }

      carMeta.prevSteer = decision.steer;
      carMeta.prevPedal = pedal;
      carMeta.targetSteer = decision.steer;
      carMeta.targetPedal = pedal;
      this._sendModulatedSubstep(wMeta, carMeta);

      // Compute authentic 5x wall impact/scrape + arc-length step reward
      const tickImp = carMeta.tickMaxImp;
      const tickCols = carMeta.tickColCount;
      carMeta.tickMaxImp = 0;
      carMeta.tickColCount = 0;

      let stepReward = -0.12;
      if (vState.currentCp > carMeta.epBestCp) {
        stepReward += 30.0 * (vState.currentCp - carMeta.epBestCp);
        carMeta.epBestCp = vState.currentCp;
      }

      const isImpact = (tickImp > 30) || (vState.accelKmhPerTick < -32 && carMeta.epTicks > 8);
      const isScraping = tickCols > 0 || (tickImp > 12 && !isImpact);
      if (carMeta.epLastHitCooldown > 0) carMeta.epLastHitCooldown -= dtSec;

      if (!isImpact && has3D && carMeta.lastArcS > carMeta.epMaxArcS + 0.15) {
        const ds = Math.min(8.5, carMeta.lastArcS - carMeta.epMaxArcS);
        carMeta.epMaxArcS = carMeta.lastArcS;
        stepReward += ds * 0.55;
      }
      if (!isImpact && !isScraping) {
        stepReward += (Math.max(0, vState.speedKmh) / 150.0) * 0.24;
      }
      if (isImpact) {
        if (carMeta.epLastHitCooldown <= 0) {
          const pen = 16.0 + Math.min(8.0, Math.max(0, tickImp - 30.0) / 15.0);
          stepReward -= pen;
          carMeta.epLastHitCooldown = 0.40;
          if (has3D) {
            carMeta.epHeavyHitArcs.push(carMeta.lastArcS);
            if (agent.isNewTrackAdapting) {
              agent._applyEmergencyBrakingCut(carMeta.lastArcS);
            }
          }
        }
        if ( tickImp > 45 ) {
          carMeta.sectionTracker.onWallContact(true);
        }
      }
      if (isScraping) {
        stepReward -= 1.20;
      }

      let shouldReset = false;
      let resetReason = 'timeout';
      if (vState.hasFinished) {
        const finMs = vState.finishTimeMs || vState.timeMs;
        carMeta.sectionTracker.onLapFinishedCleanly(finMs);
        stepReward += 160.0;
        shouldReset = true;
        resetReason = 'finished';
      } else {
        const effTel = {
          currentCp: vState.currentCp,
          totalCp: vState.totalCp,
          hasStarted: vState.hasStarted,
          maxCollisionImpulse: tickImp,
          collisionCount: tickCols
        };
        const sRes = carMeta.sectionTracker.update(carMeta.lastArcS, vState.timeMs, effTel, track3d);
        if (sRes.pruned) {
          shouldReset = true;
          resetReason = 'checkpoint_prune';
        } else if (has3D && track3d.waypoints.length && vState.position.y < track3d.waypoints[carMeta.lastArcIndex].y - 14.5) {
          stepReward -= 22.0;
          carMeta.sectionTracker.onWallContact(true);
          shouldReset = true;
          resetReason = 'off_track';
        }
      }

      if (!shouldReset && carMeta.epLowSpeedSec >= 1.55 && carMeta.epTicks > 35) {
        stepReward -= 25.0;
        carMeta.sectionTracker.onWallContact(true);
        shouldReset = true;
        resetReason = 'stuck';
      }
      if (!shouldReset && carMeta.epTicks >= 2400) {
        shouldReset = true;
        resetReason = 'timeout';
      }

      carMeta.epReturn += stepReward;
      carMeta.epSteps.push({
        obs,
        ctxBefore: decision.ctxBefore,
        resAction: decision.resAction,
        logProb: decision.logProb,
        value: decision.value,
        reward: stepReward
      });

      if (shouldReset) {
        this.rolloutCount += 1;
        wMeta.worker.postMessage({
          messageType: 6,
          carId: carMeta.carId,
          up: false,
          down: false,
          right: false,
          left: false,
          reset: true
        });

        // Immediately teach sectorMemory from scout car's corners, braking zones & clean finishes!
        if (has3D && secMem && resetReason !== 'checkpoint_prune') {
          const crashed = !vState.hasFinished && (resetReason === 'off_track' || resetReason === 'stuck');
          const latSign = Math.abs(carMeta.lateralOffsetNorm) > 0.2 ? Math.sign(carMeta.lateralOffsetNorm) : 0;
          const bestVisMs = (agent.topRuns && agent.topRuns[0] && agent.topRuns[0].finished)
            ? agent.topRuns[0].finishTimeMs
            : Infinity;
          const finMs = vState.finishTimeMs || vState.timeMs || Infinity;
          secMem.updateFromEpisode({
            maxArcS: carMeta.epMaxArcS,
            finished: !!vState.hasFinished,
            isNewBestLap: !!vState.hasFinished && finMs < bestVisMs,
            crashed,
            crashArcS: crashed ? carMeta.lastArcS : null,
            crashLateralSign: latSign,
            heavyHitArcs: carMeta.epHeavyHitArcs
          });
          if (vState.hasFinished && finMs < bestVisMs) {
            brain.lockChampionWeights();
          }
        }

        if (carMeta.epSteps.length >= 20 && (vState.hasFinished || carMeta.epMaxArcS >= 45.0)) {
          brain.trainPPOEpisode(carMeta.epSteps, 4.5e-4);
        }

        carMeta.epSteps = [];
        carMeta.epTicks = 0;
        carMeta.epReturn = 0;
        carMeta.epLowSpeedSec = 0;
        carMeta.epMaxArcS = 0;
        carMeta.epBestCp = 0;
        carMeta.epHeavyHitArcs = [];
        carMeta.epLastHitCooldown = 0;
        carMeta.prevSpeedKmh = 0;
        carMeta.lastArcIndex = 0;
        carMeta.lastArcS = 0;
        carMeta.lastSubFrame = -1;
        carMeta.lastDecisionFrames = -1;
        carMeta.sdSteerAcc = 0;
        carMeta.sdPedalAcc = 0;
        carMeta.prevSteerSign = 0;
        carMeta.prevPedalSign = 0;
        carMeta.context.fill(0);
        carMeta.prevRays.fill(0.75);
        carMeta.sectionTracker.resetEpisode();
      }
    }

    restartForNewTrack() {
      this.stop();
      if (this.agent.mode === 'train') {
        this.start();
      }
    }

    stop() {
      this.running = false;
      for (let i = 0; i < this.workers.length; i++) {
        try {
          this.workers[i].worker.terminate();
        } catch (_) {}
      }
      this.workers = [];
    }
  }

  class PolyPilotAgent {
    constructor() {
      this.vision = new VisionProcessor();
      this.track3d = new Track3DAnalyzer();
      this.telemetryReader = new TelemetryReader();
      this.controller = new CarController();
      this.storage = new BrainStorage();
      this.brain = new PolyTinyNet(20261110);
      this.sectorMemory = new TrackSectorMemory(256);

      this.mode = 'idle'; // 'idle' | 'train' | 'watch' | 'race' | 'replay'
      this.resetKeyMode = 'start'; // 'start' [KeyT] | 'checkpoint' [KeyR]

      this.activeTrackId = null;
      this.activeTrackName = 'Summer 1';
      this.topRuns = [];
      this.rewardHistory = [];
      this.episodeIdx = 0;

      // Checkpoint +1.0s Pruning Tracker, Fleet Pool & Fast New-Track Adaptation
      this.sectionTracker = new SectionBenchmarkTracker(64);
      this.secInfo = { cp: '0/?', nextTargetMs: null, deltaMs: null };
      this.fleetStats = { activeWorkers: 0, totalCars: 0, rolloutsPerSec: 0 };
      this.backgroundPool = new BackgroundRolloutPool(this);
      this.isNewTrackAdapting = true;
      this._awaitingFreshStart = false;
      this._freshStartWaitTicks = 0;

      // Replay state
      this.replayRunId = null;
      this.replayUnpacked = null;
      this.replayStepIdx = 0;

      // Active Episode Tracking
      this._resetEpisodeBuffers();
      this._episodeFinalizing = false;
      this._tickBusy = false;
      this._lastStatusPublishAt = 0;

      this.hud = new PolyPilotHUD({
        onSetMode: (m) => this.setMode(m),
        onDistillTopRuns: () => this.distillTopRunsManual(),
        onToggleResetKeyMode: () => {
          this.resetKeyMode = this.resetKeyMode === 'start' ? 'checkpoint' : 'start';
          this.hud.showToast(`Reset key set to ${this.resetKeyMode === 'start' ? 'Full Run [T]' : 'Checkpoint [R]'}`);
          return this.resetKeyMode;
        },
        onReplayTopRun: (runId) => this.toggleReplayTopRun(runId),
        onDeleteTopRun: (runId) => this.deleteTopRun(runId),
        onExportBrain: () => this.exportCurrentBrain(),
        onImportBrainText: (txt, name) => this.importBrainFromJson(txt, name),
        onResetBrain: () => this.resetCurrentBrain(),
        onRefreshSavedBrains: () => this.refreshSavedBrainsUI(),
        onLoadSavedTrackWeights: (tid) => this.loadSavedTrackWeights(tid)
      });

      this.storage.onPopupCommand = (cmd) => this._handlePopupCommand(cmd);
      this._bindHotkeys();
      this._startLoop();
    }

    _resetEpisodeBuffers() {
      this.epSteps = [];
      this.epObsRaw = [];
      this.epSteerList = [];
      this.epPedalList = [];
      this.epReturn = 0;
      this.epTicks = 0;
      this.epMaxSpeed = 0;
      this.epSpeedSum = 0;
      this.epBestCp = 0;
      this.epVisitedCells = new Set();
      this.epProgressMeters = 0;
      this.epMaxArcS = 0;
      this.epHeavyHitArcs = [];
      this.epLastHitCooldown = 0;
      this.epStartY = null;
      this.epLowSpeedSec = 0;
      this.epAirborneSec = 0;
      this.epStagnantSec = 0;
      this.prevRaceTimeMs = 0;
      this.prevSteer = 0;
      this.prevPedal = 1;
      this.brain.resetContext();
      this.vision.resetTemporal();
      this.track3d.resetEpisodeTracking();
      if (this.sectionTracker) {
        this.sectionTracker.resetEpisode();
      }
    }

    _bindHotkeys() {
      window.addEventListener('keydown', (e) => {
        if (!e.altKey || e.repeat) return;
        if (e.code === 'KeyP') {
          e.preventDefault();
          this.hud.toggleCollapse();
        } else if (e.code === 'Digit1') {
          e.preventDefault();
          this.setMode('idle');
        } else if (e.code === 'Digit2') {
          e.preventDefault();
          this.setMode('train');
        } else if (e.code === 'Digit3') {
          e.preventDefault();
          this.setMode('watch');
        } else if (e.code === 'Digit4') {
          e.preventDefault();
          this.setMode('race');
        }
      }, true);

      document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
          this.controller.releaseAll();
        }
      });
    }

    _handlePopupCommand(cmd) {
      if (!cmd || !cmd.type) return;
      if (cmd.type === 'SET_MODE') {
        this.setMode(cmd.mode || 'idle');
      } else if (cmd.type === 'TOGGLE_HUD') {
        this.hud.toggleCollapse();
      } else if (cmd.type === 'DISTILL_TOP_RUNS') {
        this.distillTopRunsManual();
      }
    }

    async setMode(nextMode) {
      if (this.mode === nextMode && nextMode !== 'replay') return;

      if (this.mode === 'watch' && this.epObsRaw.length >= 28) {
        await this._finalizeEpisode({ finished: false, terminalPenalty: 0, reason: 'mode_switch', isHuman: true });
      }

      this.controller.releaseAll();
      this.mode = nextMode;
      if (nextMode !== 'replay') {
        this.replayRunId = null;
        this.replayUnpacked = null;
      }

      if (nextMode === 'train' || nextMode === 'race') {
        const curTel = this.telemetryReader.read();
        if (curTel && curTel.inRace && ((curTel.timeMs || 0) > 250 || curTel.hasFinished || (curTel.currentCp || 0) > 0)) {
          await this.controller.triggerReset('start');
          this._awaitingFreshStart = true;
          this._freshStartWaitTicks = 0;
        }
      }

      if (nextMode === 'train') {
        this.backgroundPool.start();
      } else {
        this.backgroundPool.stop();
      }

      this._resetEpisodeBuffers();
      this.hud.updateModeUI(this.mode, this.replayRunId);
      this.hud.renderTopRuns(this.topRuns, this.replayRunId);

      const modeMessages = {
        idle: 'Standby · Keyboard free',
        train: 'Auto Train · Checkpoint +1.0s reset + Neural RL active',
        watch: 'Drive now! Recording your racing line',
        race: 'Race Best · Champion brain engaged',
        replay: 'Replaying Top Run trajectory'
      };
      this.hud.showToast(modeMessages[this.mode] || 'Mode updated');
    }

    async _ensureTrackLoaded(telemetry) {
      await this.track3d.ensureBuiltFromTap(window.__POLYPILOT_TAP__);

      if (!telemetry.trackId || telemetry.trackId === this.activeTrackId) {
        if (this.track3d.ready && this.track3d.totalLengthM > 0) {
          this.sectorMemory.ensureSize(this.track3d.totalLengthM);
        }
        return;
      }

      this.controller.releaseAll();
      this.activeTrackId = telemetry.trackId;
      this.activeTrackName = telemetry.trackName || 'PolyTrack';

      const curPretrainedStamp = (typeof window !== 'undefined' && window.PolyPilotPretrained && window.PolyPilotPretrained.updatedAt) || '3.4.9';
      const estLen = (this.track3d.ready && this.track3d.totalLengthM > 0) ? this.track3d.totalLengthM : 1400;
      const saved = await this.storage.loadTrackBundle(this.activeTrackId);
      const isUpToDateBundle = !!(saved && saved.brain && saved.pretrainedStamp === curPretrainedStamp);

      if (isUpToDateBundle) {
        try {
          this.brain.loadWeightsObject(saved.brain);
          this.sectorMemory = new TrackSectorMemory(Math.ceil((estLen + 30) / 5));
          if (saved.sectorMemory) {
            this.sectorMemory.load(saved.sectorMemory);
          }
          this.sectorMemory.ensureSize(estLen);
          this.topRuns = Array.isArray(saved.topRuns) ? saved.topRuns : [];
          this.rewardHistory = Array.isArray(saved.rewardHistory) ? saved.rewardHistory : [];
          this.episodeIdx = saved.episodeIdx || this.brain.episodesTrained || 0;
          this.isNewTrackAdapting = !this.brain.hasChampion || this.episodeIdx < 20;
          this.hud.showToast(`Loaded ${this.activeTrackName} brain (${this.topRuns.length} top runs)`);
        } catch (_) {
          this.brain = new PolyTinyNet(20261110);
          this.sectorMemory = new TrackSectorMemory(Math.ceil((estLen + 30) / 5));
          this.topRuns = [];
          this.rewardHistory = [];
          this.episodeIdx = 0;
          this.isNewTrackAdapting = true;
        }
      } else {
        this.brain = new PolyTinyNet(20261110);
        let loadedPretrained = false;
        try {
          const genSaved = await this.storage.loadTrackBundle('__polypilot_generalist_v2__');
          if (genSaved && genSaved.pretrainedStamp === curPretrainedStamp && genSaved.brain && genSaved.brain.weightsB64) {
            this.brain.loadWeightsObject(genSaved.brain);
            loadedPretrained = true;
          }
        } catch (_) {}

        if (!loadedPretrained && typeof window !== 'undefined' && window.PolyPilotPretrained && window.PolyPilotPretrained.weightsBase64) {
          try {
            this.brain.loadWeightsObject({
              arch: window.PolyPilotPretrained.arch || 'PolyTinyNet-v2',
              totalParams: window.PolyPilotPretrained.paramCount || 15717,
              weightsB64: window.PolyPilotPretrained.weightsBase64,
              championWeightsB64: window.PolyPilotPretrained.weightsBase64
            });
            loadedPretrained = true;
          } catch (_) {}
        }

        this.sectorMemory = new TrackSectorMemory(Math.ceil((estLen + 30) / 5));
        const humanRuns = (saved && Array.isArray(saved.topRuns))
          ? saved.topRuns.filter((r) => r && r.source === 'YOU')
          : [];
        this.topRuns = humanRuns;
        this.rewardHistory = [];
        this.episodeIdx = 0;
        this.isNewTrackAdapting = true;
        if (saved && saved.brain) {
          void this._autoSaveTrack();
        }
        this.hud.showToast(loadedPretrained
          ? `Fast Adaptation: Pretrained weights for ${this.activeTrackName}`
          : `Initialized New Track Brain for ${this.activeTrackName}`);
      }

      this.sectionTracker = new SectionBenchmarkTracker(64);
      if (this.topRuns.length > 0 && this.topRuns[0].finished && this.topRuns[0].finishTimeMs > 0) {
        this.sectionTracker.bestFinishMs = this.topRuns[0].finishTimeMs;
      }
      if (this.mode === 'train') {
        this.backgroundPool.restartForNewTrack();
      }

      this._resetEpisodeBuffers();
      this.hud.renderTopRuns(this.topRuns, this.replayRunId);
      this.refreshSavedBrainsUI();
    }

    _buildPersistBundle() {
      const curPretrainedStamp = (typeof window !== 'undefined' && window.PolyPilotPretrained && window.PolyPilotPretrained.updatedAt) || '3.4.9';
      return {
        trackId: this.activeTrackId || 'PolyTrack',
        trackName: this.activeTrackName || 'PolyTrack',
        pretrainedStamp: curPretrainedStamp,
        episodeIdx: this.episodeIdx,
        brain: this.brain.serializeMetaAndWeights(),
        sectorMemory: this.sectorMemory.serialize(),
        topRuns: this.topRuns,
        rewardHistory: this.rewardHistory.slice(-80)
      };
    }

    async _autoSaveTrack() {
      if (!this.activeTrackId) return;
      const curPretrainedStamp = (typeof window !== 'undefined' && window.PolyPilotPretrained && window.PolyPilotPretrained.updatedAt) || '3.4.9';
      await this.storage.saveTrackBundle(this.activeTrackId, this._buildPersistBundle());
      try {
        if (this.brain.hasChampion && this.topRuns.length > 0 && this.topRuns[0].finished) {
          await this.storage.saveTrackBundle('__polypilot_generalist_v2__', {
            trackId: '__polypilot_generalist_v2__',
            trackName: 'PolyPilot Generalist Champion',
            pretrainedStamp: curPretrainedStamp,
            brain: this.brain.serializeMetaAndWeights()
          });
        }
      } catch (_) {}
    }

    async distillTopRunsManual() {
      if (!this.topRuns.length) {
        this.hud.showToast('Record or complete at least 1 run first');
        return;
      }
      const loss = this.brain.trainFromEliteRuns(this.topRuns, 10, 1.0e-3);
      void this._autoSaveTrack();
      this.hud.showToast(`Distilled ${this.topRuns.length} Top Runs · Loss ${loss.toFixed(3)}`);
    }

    async toggleReplayTopRun(runId) {
      if (this.mode === 'replay' && this.replayRunId === runId) {
        await this.setMode('idle');
        return;
      }
      const target = this.topRuns.find((r) => r.id === runId);
      if (!target) return;
      const unpacked = unpackTrajectory(target.trajectory);
      if (!unpacked || unpacked.obsList.length === 0) {
        this.hud.showToast('Run has no replay steps');
        return;
      }

      this.controller.releaseAll();
      this.replayRunId = runId;
      this.replayUnpacked = unpacked;
      this.replayStepIdx = 0;
      this.mode = 'replay';
      this.hud.updateModeUI('replay', this.replayRunId);
      this.hud.renderTopRuns(this.topRuns, this.replayRunId);
      this.hud.showToast('Resetting to start for Top Run replay...');
      await this.controller.triggerReset('start');
      this._resetEpisodeBuffers();
    }

    async deleteTopRun(runId) {
      this.topRuns = this.topRuns.filter((r) => r.id !== runId);
      if (this.replayRunId === runId) {
        await this.setMode('idle');
      }
      this.hud.renderTopRuns(this.topRuns, this.replayRunId);
      void this._autoSaveTrack();
      this.hud.showToast('Removed run from Top Runs');
    }

    exportCurrentBrain() {
      const bundle = this._buildPersistBundle();
      const bytes = this.storage.exportToDiskFile(bundle);
      this.hud.showToast(`Exported ${(bytes / 1024).toFixed(1)} KB .polybrain.json`);
    }

    async importBrainFromJson(jsonText, fileName) {
      try {
        const parsed = this.storage.parseImportedJson(jsonText);
        this.brain.loadWeightsObject(parsed.brain);
        if (parsed.sectorMemory) {
          this.sectorMemory.load(parsed.sectorMemory);
        }
        if (Array.isArray(parsed.topRuns) && parsed.topRuns.length > 0) {
          this.topRuns = parsed.topRuns;
        }
        if (Array.isArray(parsed.rewardHistory)) {
          this.rewardHistory = parsed.rewardHistory;
        }
        this.episodeIdx = parsed.episodeIdx || this.brain.episodesTrained || 0;
        this._resetEpisodeBuffers();
        this.hud.renderTopRuns(this.topRuns, this.replayRunId);
        await this._autoSaveTrack();
        await this.refreshSavedBrainsUI();
        this.hud.showToast(`Loaded ${fileName}`);
      } catch (err) {
        this.hud.showToast(`Load failed: ${err.message || err}`);
      }
    }

    async resetCurrentBrain() {
      this.controller.releaseAll();
      this.brain = new PolyTinyNet((Date.now() & 0xffffffff) >>> 0);
      const estLen = (this.track3d.ready && this.track3d.totalLengthM > 0) ? this.track3d.totalLengthM : 1400;
      this.sectorMemory = new TrackSectorMemory(Math.ceil((estLen + 30) / 5));
      this.topRuns = [];
      this.rewardHistory = [];
      this.episodeIdx = 0;
      this._resetEpisodeBuffers();
      await this.storage.deleteTrackBundle(this.activeTrackId);
      this.hud.renderTopRuns(this.topRuns, null);
      await this.refreshSavedBrainsUI();
      this.hud.showToast('Reset weights & Top Runs for track');
    }

    async refreshSavedBrainsUI() {
      const list = await this.storage.listSavedTracks();
      this.hud.renderSavedBrains(list, this.activeTrackId);
    }

    async loadSavedTrackWeights(sourceTrackId) {
      const saved = await this.storage.loadTrackBundle(sourceTrackId);
      if (!saved || !saved.brain) {
        this.hud.showToast('Saved brain not found');
        return;
      }
      this.brain.loadWeightsObject(saved.brain);
      if (sourceTrackId === this.activeTrackId) {
        if (saved.sectorMemory) this.sectorMemory.load(saved.sectorMemory);
        if (Array.isArray(saved.topRuns)) {
          this.topRuns = saved.topRuns;
          this.hud.renderTopRuns(this.topRuns, this.replayRunId);
        }
      }
      void this._autoSaveTrack();
      this.hud.showToast(`Transferred weights from ${saved.trackName || sourceTrackId}`);
    }

    _applyEmergencyBrakingCut(impactArcS) {
      if (!this.sectorMemory) return;
      const startS = Math.max(0, impactArcS - 50.0);
      const endS = impactArcS + 5.0;
      const startSec = Math.floor(startS / 5.0);
      const endSec = Math.min(this.sectorMemory.numSectors - 1, Math.ceil(endS / 5.0));
      for (let s = startSec; s <= endSec; s++) {
        this.sectorMemory.speedScale[s] = Math.max(0.65, this.sectorMemory.speedScale[s] * 0.82);
      }
    }

    _computeStepRewardAndProgress(telemetry, dtSec) {
      let r = 0;
      let progressedThisTick = false;

      // 1. Checkpoint bonus
      if (telemetry.currentCp > this.epBestCp) {
        const gained = telemetry.currentCp - this.epBestCp;
        r += 30.0 * gained;
        this.epBestCp = telemetry.currentCp;
        progressedThisTick = true;
      }

      // Check impact condition (ignore clean belly-pan jump touchdowns after >=0.20s flight where forward speed is preserved)
      const isJumpTouchdown = (this.epAirborneSec >= 0.20) && ((telemetry.groundedWheels ?? 4) >= 1) &&
        ((telemetry.accelKmhPerTick || 0) > -20) && (telemetry.speedKmh > 45);
      const isImpact = !isJumpTouchdown && ((telemetry.maxCollisionImpulse > 30) || (telemetry.accelKmhPerTick < -32 && this.epTicks > 8));

      // 2. True 3D Track Arc-Length Progress (fallback to 3D breadcrumbs if 3D spline unavailable)
      // MANDATORY PROGRESS SUPPRESSION: On any tick where maxCollisionImpulse > 30 (or isImpact), suppress arc-length progress reward!
      if (!isImpact) {
        if (this.track3d.ready && telemetry.position) {
          const curS = this.track3d.lastArcS;
          if (curS > this.epMaxArcS + 0.15) {
            const ds = Math.min(8.5, curS - this.epMaxArcS);
            this.epMaxArcS = curS;
            this.epProgressMeters = curS;
            r += ds * 0.55;
            progressedThisTick = true;
          }
        } else if (telemetry.position) {
          if (this.epStartY == null) this.epStartY = telemetry.position.y;
          const cellSize = 2.5;
          const cx = Math.floor(telemetry.position.x / cellSize);
          const cy = Math.floor(telemetry.position.y / (cellSize * 2));
          const cz = Math.floor(telemetry.position.z / cellSize);
          const key = `${cx},${cy},${cz}`;
          if (!this.epVisitedCells.has(key)) {
            this.epVisitedCells.add(key);
            if (this.epVisitedCells.size > 1) {
              r += 1.05;
              this.epProgressMeters = (this.epVisitedCells.size - 1) * cellSize;
              progressedThisTick = true;
            }
          }
        } else if (telemetry.speedKmh > 8) {
          const dMeters = (telemetry.speedKmh / 3.6) * dtSec;
          this.epProgressMeters += dMeters;
          r += dMeters * 0.28;
          if (telemetry.speedKmh > 18) progressedThisTick = true;
        }
      }

      // 3. Forward Velocity Along Track + Racing-Line Cleanliness (suppressed on wall impact or scrape)
      const isScraping = telemetry.collisionCount > 0 || (telemetry.maxCollisionImpulse > 12 && !isImpact);
      if (!isImpact && !isScraping) {
        const fwdSpeed = Math.max(0, telemetry.speedKmh);
        r += (fwdSpeed / 150.0) * 0.24;
      }
      if (telemetry.speedKmh < -2) {
        r -= 0.14;
      }

      // 4. 5x Wall Collision Penalty & Sector Incident Logging
      if (this.epLastHitCooldown > 0) this.epLastHitCooldown -= dtSec;

      if (isImpact) {
        if (this.epLastHitCooldown <= 0) {
          // Impact penalty: -16.0 to -24.0 Return when maxCollisionImpulse > 30 or accelKmhPerTick < -32. Cooldown 0.40s.
          const impulseExcess = Math.max(0, (telemetry.maxCollisionImpulse || 30.0) - 30.0);
          const pen = 16.0 + Math.min(8.0, impulseExcess / 15.0);
          r -= pen;
          this.epLastHitCooldown = 0.40;
          if (this.track3d.ready) {
            this.epHeavyHitArcs.push(this.track3d.lastArcS);
            if (this.isNewTrackAdapting) {
              this._applyEmergencyBrakingCut(this.track3d.lastArcS);
            }
          }
        }
        if (this.sectionTracker && (telemetry.maxCollisionImpulse || 0) > 45) {
          this.sectionTracker.onWallContact(true);
        }
      }

      // Wall-scrape continuous penalty: -1.20 Return per tick (-30.00 Return/sec, 10x clean driving cost)
      if (isScraping) {
        r -= 1.20;
      }

      // 5. Clean driving time cost: r -= 0.12 per tick (-3.00 Return/sec)
      r -= 0.12;

      // Update termination timers
      if (Math.abs(telemetry.speedKmh) < 6.5 && this.epTicks > 26) {
        this.epLowSpeedSec += dtSec;
      } else {
        this.epLowSpeedSec = Math.max(0, this.epLowSpeedSec - dtSec * 1.6);
      }

      if ((telemetry.groundedWheels ?? 4) === 0) {
        this.epAirborneSec += dtSec;
      } else {
        this.epAirborneSec = 0;
      }

      if (progressedThisTick) {
        this.epStagnantSec = 0;
      } else if (this.epTicks > 24) {
        this.epStagnantSec += dtSec;
      }

      return r;
    }

    async _finalizeEpisode({ finished, finishTimeMs = null, terminalPenalty = 0, reason = 'reset', isHuman = false }) {
      if (this._episodeFinalizing) return;
      this._episodeFinalizing = true;

      try {
        this.controller.releaseAll();

        const T = this.epObsRaw.length;
        if (T >= 12) {
          if (this.epSteps.length > 0 && terminalPenalty !== 0) {
            this.epSteps[this.epSteps.length - 1].reward += terminalPenalty;
            this.epReturn += terminalPenalty;
          }

          this.episodeIdx += 1;
          const avgSpeed = this.epSpeedSum / Math.max(1, T);

          let isNewTop1 = false;
          const meaningfulProgress = finished || this.epProgressMeters >= 8 || this.epBestCp >= 1 || (isHuman && T >= 28);
          if (meaningfulProgress) {
            const candidate = {
              id: `run_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
              source: isHuman ? 'YOU' : 'AI',
              finished: !!finished,
              finishTimeMs: finished ? (finishTimeMs || this.prevRaceTimeMs || T * TICK_MS) : null,
              checkpoints: this.epBestCp,
              totalCp: this._lastTotalCp || 0,
              progressMeters: +this.epProgressMeters.toFixed(1),
              totalReward: +this.epReturn.toFixed(2),
              maxSpeedKmh: +this.epMaxSpeed.toFixed(1),
              avgSpeedKmh: +avgSpeed.toFixed(1),
              stepsCount: T,
              createdAt: Date.now(),
              trajectory: packTrajectory(this.epObsRaw, this.epSteerList, this.epPedalList)
            };

            const res = insertTopRun(this.topRuns, candidate);
            this.topRuns = res.topRuns;
            if (res.rank === 0) {
              isNewTop1 = true;
              if (finished && !isHuman) {
                this.brain.lockChampionWeights();
              }
              const label = finished
                ? `NEW #1 RECORD: ${formatMs(candidate.finishTimeMs)}!`
                : `New #1 Best Distance: ${Math.round(candidate.progressMeters)}m!`;
              this.hud.showToast(label, 4800);
            } else if (res.rank > 0 && finished) {
              this.hud.showToast(`Lap Finished: ${formatMs(candidate.finishTimeMs)} (#${res.rank + 1})`, 3600);
            } else if (res.rank > 0 && isHuman) {
              this.hud.showToast(`Recorded Human Top Run #${res.rank + 1}!`, 3500);
            }
            this.hud.renderTopRuns(this.topRuns, this.replayRunId);
          }

          this.rewardHistory.push({
            ep: this.episodeIdx,
            reward: +this.epReturn.toFixed(2),
            isTopRun: isNewTop1
          });
          if (this.rewardHistory.length > 100) {
            this.rewardHistory.shift();
          }

          // Update Per-Sector Speed & Apex Memory + Neural Policy!
          const crashed = !finished && (reason === 'off_track' || reason === 'stuck' || reason === 'stagnant');
          if (!isHuman && this.track3d.ready && (this.mode === 'train' || this.mode === 'race')) {
            const latSign = Math.abs(this.track3d.lateralOffsetNorm) > 0.2
              ? Math.sign(this.track3d.lateralOffsetNorm)
              : 0;
            this.sectorMemory.updateFromEpisode({
              maxArcS: this.epMaxArcS,
              finished: !!finished,
              isNewBestLap: isNewTop1 && !!finished,
              crashed,
              crashArcS: crashed ? this.track3d.lastArcS : null,
              crashLateralSign: latSign,
              heavyHitArcs: this.epHeavyHitArcs
            });
          }

          if (isHuman) {
            this.brain.trainFromEliteRuns(this.topRuns, 7, 1.15e-3);
            this.brain.episodesTrained += 1;
          } else if (this.mode === 'train') {
            this.brain.trainPPOEpisode(this.epSteps, 8.5e-4);
            if (this.topRuns.length > 0) {
              this.brain.trainFromEliteRuns(this.topRuns, 3, 8.5e-4);
            }
          }

          void this._autoSaveTrack();
        }

        if (!isHuman && reason === 'checkpoint_prune') {
          const cpLabel = (this.secInfo && this.secInfo.prunedCp) || 'Checkpoint';
          const dLabel = (this.secInfo && this.secInfo.deltaMs != null) ? ` (+${(this.secInfo.deltaMs / 1000).toFixed(2)}s)` : '';
          this.hud.showToast(`Reset: ${cpLabel} > 1.0s behind best${dLabel}`, 2000);
        }

        if (!isHuman && (this.mode === 'train' || this.mode === 'race' || this.mode === 'replay') && reason !== 'manual_restart') {
          const effResetMode = (reason === 'checkpoint_prune' || reason === 'section_prune' || finished)
            ? 'start'
            : this.resetKeyMode;
          await this.controller.triggerReset(effResetMode);
          if (effResetMode === 'start') {
            this._awaitingFreshStart = true;
            this._freshStartWaitTicks = 0;
          }
        }

        this._resetEpisodeBuffers();
        this.replayStepIdx = 0;
      } finally {
        this._episodeFinalizing = false;
      }
    }

    _startLoop() {
      let lastStepAt = 0;
      const maybeStep = () => {
        const now = performance.now();
        if (now - lastStepAt >= TICK_MS - 3) {
          lastStepAt = now;
          this._tick();
        }
      };
      const onFrame = () => {
        maybeStep();
        window.requestAnimationFrame(onFrame);
      };
      window.requestAnimationFrame(onFrame);
      setInterval(maybeStep, TICK_MS);
    }

    async _tick() {
      if (this._tickBusy || this._episodeFinalizing) return;
      this._tickBusy = true;
      try {
        await this._tickInner();
      } finally {
        this._tickBusy = false;
      }
    }

    async _tickInner() {
      const telemetry = this.telemetryReader.read();
      this._lastTotalCp = telemetry.totalCp;

      if (telemetry.inRace) {
        await this._ensureTrackLoaded(telemetry);
      }

      const isGrounded = (telemetry.groundedWheels ?? 4) >= 1;
      if (telemetry.inRace && telemetry.position) {
        this.track3d.update(telemetry);
      }

      this._visCounter = ((this._visCounter || 0) + 1) | 0;
      const visMod = !telemetry.inRace
        ? 10
        : ((this.track3d.ready && telemetry.position) ? 4 : 1);
      if (this._visCounter % visMod === 1 || !this.vision.frameValid) {
        this.vision.process(telemetry.screenCanvas, isGrounded);
      }

      if (!telemetry.inRace || telemetry.isPaused) {
        this.controller.releaseAll();
        this._renderAndPublish(telemetry, 1, 1, 0, 0);
        return;
      }

      // Guard post-reset frames until game timer confirms 0:00.000 at start line
      if (this._awaitingFreshStart && (this.mode === 'train' || this.mode === 'race')) {
        if (!telemetry.hasFinished && (telemetry.timeMs || 0) < 450 && (telemetry.currentCp || 0) === 0) {
          this._awaitingFreshStart = false;
          this._freshStartWaitTicks = 0;
        } else {
          this._freshStartWaitTicks += 1;
          this.controller.releaseAll();
          if (this._freshStartWaitTicks >= 12) {
            this._freshStartWaitTicks = 0;
            await this.controller.triggerReset('start');
          }
          this._renderAndPublish(telemetry, 1, 1, 0, 0);
          return;
        }
      }

      // Detect manual user restart (timer jumped back to 0)
      if (this.epTicks >= 1 && telemetry.timeMs + 300 < this.prevRaceTimeMs && telemetry.timeMs < 600) {
        if (this.mode === 'watch' && this.epObsRaw.length >= 26) {
          await this._finalizeEpisode({ finished: false, terminalPenalty: 0, reason: 'manual_restart', isHuman: true });
          return;
        }
        this._resetEpisodeBuffers();
      }
      this.prevRaceTimeMs = telemetry.timeMs;

      const useChampion = this.mode === 'race';
      const obs = buildObservation(
        this.vision,
        this.track3d,
        telemetry,
        this.sectorMemory,
        this.prevSteer,
        this.prevPedal,
        this.epLowSpeedSec,
        useChampion
      );

      const dtSec = TICK_MS / 1000.0;

      // === MODE 1: STANDBY ===
      if (this.mode === 'idle') {
        const out = this.brain.forward(obs, this.brain.context, false, true);
        const p = obs._prior || { steer: 0, pedal: 0, targetSpeedKmh: 180 };
        this.brain._syncHudProbs(
          Math.max(-1, Math.min(1, p.steer + 0.4 * out.nnMean[0])),
          0,
          p.targetSpeedKmh
        );
        this._renderAndPublish(telemetry, 1, 1, 0, 0);
        return;
      }

      // === MODE 2: WATCH ME DRIVE (HUMAN IMITATION RECORDING) ===
      if (this.mode === 'watch') {
        this.brain.forward(obs, this.brain.context, false, true);
        const human = this.controller.getHumanAction(telemetry.workerControls);
        this.brain._syncHudProbs(human.steer, human.pedal, 180);

        if (telemetry.hasStarted || human.anyPressed) {
          const stepReward = this._computeStepRewardAndProgress(telemetry, dtSec);
          this.epReturn += stepReward;
          this.epTicks += 1;
          this.epMaxSpeed = Math.max(this.epMaxSpeed, telemetry.speedKmh);
          this.epSpeedSum += Math.max(0, telemetry.speedKmh);
          this.epObsRaw.push(obs);
          this.epSteerList.push(human.steer);
          this.epPedalList.push(human.pedal);
          this.prevSteer = human.steer;
          this.prevPedal = human.pedal;

          if (telemetry.hasFinished) {
            const finMs = telemetry.finishTimeMs || telemetry.timeMs;
            this.epReturn += 160.0 + Math.max(0, 75.0 - finMs / 1000.0) * 3.0;
            await this._finalizeEpisode({ finished: true, finishTimeMs: finMs, reason: 'finished', isHuman: true });
            return;
          }
        }

        this._renderAndPublish(telemetry, human.steerIdx, human.pedalIdx, human.steer, human.pedal);
        return;
      }

      // === MODE 3: REPLAY TOP RUN ===
      if (this.mode === 'replay' && this.replayUnpacked) {
        this.brain.forward(obs, this.brain.context, true, true);
        const len = this.replayUnpacked.steerList.length;
        if (this.replayStepIdx < len && !telemetry.hasFinished) {
          const sVal = this.replayUnpacked.steerList[this.replayStepIdx];
          const pVal = this.replayUnpacked.pedalList[this.replayStepIdx];
          this.replayStepIdx += 1;
          this.controller.applyContinuous(sVal, pVal);
          this.brain._syncHudProbs(sVal, pVal, 180);
          this.prevSteer = sVal;
          this.prevPedal = pVal;
          const sIdx = sVal < -0.2 ? 0 : (sVal > 0.2 ? 2 : 1);
          const pIdx = pVal > 0.2 ? 0 : (pVal < -0.2 ? 2 : 1);
          this._renderAndPublish(telemetry, sIdx, pIdx, sVal, pVal);
        } else {
          await this.controller.triggerReset('start');
          this._resetEpisodeBuffers();
          this.replayStepIdx = 0;
        }
        return;
      }

      // === MODE 4 & 5: AUTO TRAIN (HYBRID RL + SECTOR ADAPTATION) & RACE BEST (CHAMPION) ===
      const decision = this.brain.act(obs, useChampion);

      this.controller.applyContinuous(decision.steer, decision.pedal);
      if (!telemetry.hasStarted && Math.abs(telemetry.speedKmh) < 0.3 && Math.abs(decision.pedal) > 0.2 && (this.epTicks % 6 === 3)) {
        this.controller.reassertHeldKeys();
      }
      this.prevSteer = decision.steer;
      this.prevPedal = decision.pedal;

      const stepReward = this._computeStepRewardAndProgress(telemetry, dtSec);
      this.epReturn += stepReward;
      this.epTicks += 1;
      this.epMaxSpeed = Math.max(this.epMaxSpeed, telemetry.speedKmh);
      this.epSpeedSum += Math.max(0, telemetry.speedKmh);

      this.epObsRaw.push(obs);
      this.epSteerList.push(decision.steer);
      this.epPedalList.push(decision.pedal);
      this.epSteps.push({
        obs,
        ctxBefore: decision.ctxBefore,
        resAction: decision.resAction,
        logProb: decision.logProb,
        value: decision.value,
        reward: stepReward
      });

      // Check Checkpoint +1.0s (+1000ms) Pruning
      if (telemetry.inRace) {
        const secRes = this.sectionTracker.update(
          this.track3d.lastArcS || 0,
          telemetry.timeMs,
          telemetry,
          this.track3d
        );
        this.secInfo = secRes.secInfo;
        if (secRes.pruned && (this.mode === 'train' || this.mode === 'race')) {
          await this._finalizeEpisode({
            finished: false,
            terminalPenalty: 0,
            reason: 'checkpoint_prune',
            isHuman: false
          });
          return;
        }
      }

      // Check Episode Termination Conditions
      if (telemetry.hasFinished) {
        const finMs = telemetry.finishTimeMs || telemetry.timeMs;
        this.sectionTracker.onLapFinishedCleanly(finMs);
        const finishBonus = 160.0 + Math.max(0, 75.0 - finMs / 1000.0) * 3.2;
        await this._finalizeEpisode({
          finished: true,
          finishTimeMs: finMs,
          terminalPenalty: finishBonus,
          reason: 'finished',
          isHuman: false
        });
        return;
      }

      let fellIntoVoid = this.epAirborneSec > 3.1;
      if (!fellIntoVoid && telemetry.position) {
        if (this.track3d.ready && this.track3d.waypoints.length > 0) {
          const refWpY = this.track3d.waypoints[this.track3d.lastArcIndex].y;
          if (telemetry.position.y < refWpY - 10.5) fellIntoVoid = true;
        } else if (this.epStartY != null && telemetry.position.y < this.epStartY - 22.0) {
          fellIntoVoid = true;
        }
      }
      if (fellIntoVoid) {
        this.sectionTracker.onWallContact();
        await this._finalizeEpisode({ finished: false, terminalPenalty: -9.5, reason: 'off_track', isHuman: false });
        return;
      }

      if (this.epLowSpeedSec >= 1.55 && this.epTicks > 35) {
        this.sectionTracker.onWallContact();
        await this._finalizeEpisode({ finished: false, terminalPenalty: -25.0, reason: 'stuck', isHuman: false });
        return;
      }

      if (this.epStagnantSec >= 5.5 && this.epTicks > 85) {
        this.sectionTracker.onWallContact();
        await this._finalizeEpisode({ finished: false, terminalPenalty: -5.0, reason: 'stagnant', isHuman: false });
        return;
      }

      if (this.epTicks >= 2400) {
        await this._finalizeEpisode({ finished: false, terminalPenalty: 0, reason: 'timeout', isHuman: false });
        return;
      }

      this._renderAndPublish(telemetry, decision.steerIdx, decision.pedalIdx, decision.steer, decision.pedal);
    }

    _renderAndPublish(telemetry, steerIdx, pedalIdx, continuousSteer = 0, continuousPedal = 0) {
      const memStats = this.brain.getMemoryStats();
      if (this.backgroundPool) {
        this.fleetStats = this.backgroundPool.getStats();
      }
      this.hud.renderLiveFrame({
        mode: this.mode,
        telemetry,
        vision: this.vision,
        track3d: this.track3d,
        brain: this.brain,
        steerIdx,
        pedalIdx,
        continuousSteer,
        continuousPedal,
        episodeIdx: this.episodeIdx,
        episodeReturn: this.epReturn,
        rewardHistory: this.rewardHistory,
        topRuns: this.topRuns,
        memStats,
        secInfo: this.secInfo,
        fleetStats: this.fleetStats
      });

      const now = performance.now();
      if (now - this._lastStatusPublishAt > 600) {
        this._lastStatusPublishAt = now;
        this.storage.publishStatus({
          mode: this.mode,
          trackName: telemetry.trackName,
          inRace: telemetry.inRace,
          speedKmh: Math.round(telemetry.speedKmh || 0),
          episodes: this.episodeIdx,
          topRunsCount: this.topRuns.length,
          bestTimeMs: this.topRuns[0]?.finishTimeMs ?? null,
          bestDistM: Math.round(this.topRuns[0]?.progressMeters || 0),
          memStats
        });
      }
    }
  }

  function tryMountPolyPilot() {
    if (typeof document === 'undefined') return false;
    const screen = document.getElementById('screen');
    const ui = document.getElementById('ui');
    if (screen && screen.tagName === 'CANVAS' && ui) {
      if (!window.__POLYPILOT_INSTANCE__) {
        const inst = new PolyPilotAgent();
        window.__POLYPILOT_INSTANCE__ = inst;
        window.__polyPilot = {
          get agent() { return window.__POLYPILOT_INSTANCE__; },
          get brain() { return window.__POLYPILOT_INSTANCE__?.brain; },
          get track3d() { return window.__POLYPILOT_INSTANCE__?.track3d; },
          get hud() { return window.__POLYPILOT_INSTANCE__?.hud; },
          get telemetry() { return window.__POLYPILOT_INSTANCE__?.telemetryReader?.read() || {}; },
          get topRuns() { return window.__POLYPILOT_INSTANCE__?.topRuns || []; },
          get secInfo() { return window.__POLYPILOT_INSTANCE__?.secInfo || { cp: '1/1', sec: '1/8', deltaMs: 0 }; },
          get fleetStats() { return window.__POLYPILOT_INSTANCE__?.fleetStats || { activeWorkers: 0, totalCars: 0, rolloutsPerSec: 0 }; }
        };
      }
      return true;
    }
    return false;
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      PolyPilotAgent,
      SectionBenchmarkTracker,
      BackgroundRolloutPool
    };
  }
  if (typeof window !== 'undefined') {
    window.PolyPilotAgent = PolyPilotAgent;
    window.PolyPilotSectionBenchmarkTracker = SectionBenchmarkTracker;
    window.PolyPilotBackgroundRolloutPool = BackgroundRolloutPool;
  }

  if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    if (!tryMountPolyPilot()) {
      let checks = 0;
      const timer = setInterval(() => {
        checks += 1;
        if (tryMountPolyPilot() || checks > 150) {
          clearInterval(timer);
        }
      }, 400);
    }
  }
})();
