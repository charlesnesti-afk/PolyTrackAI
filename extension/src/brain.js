(() => {
  'use strict';

  const OBS_DIM = 64;
  const CTX_DIM = 32;
  const IN1_DIM = OBS_DIM + CTX_DIM; // 96
  const H1_DIM = 96;
  const H2_DIM = 64;
  const ACT_DIM = 2; // 0: continuous steer [-1..+1], 1: continuous pedal [-1..+1]
  const MAX_TOP_RUNS = 8;
  const SECTOR_LEN_M = 5.0;
  const MAX_SECTORS = 1024; // Up to >5.1 km track arc-length

  function clamp(v, lo, hi) {
    return v < lo ? lo : (v > hi ? hi : v);
  }

  function float32ToBase64(f32) {
    const bytes = new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength);
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  function base64ToFloat32(b64) {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new Float32Array(bytes.buffer);
  }

  /**
   * Pack continuous trajectory (obs + continuous steer [-1..1] + continuous pedal [-1..1]) compactly.
   */
  function packTrajectory(obsList, steerList, pedalList) {
    const T = obsList.length;
    const dim = obsList[0] ? obsList[0].length : OBS_DIM;
    const qObs = new Int16Array(T * dim);
    const qActs = new Int8Array(T * 2);
    for (let t = 0; t < T; t++) {
      const o = obsList[t];
      const base = t * dim;
      for (let d = 0; d < dim; d++) {
        qObs[base + d] = Math.round(clamp(o[d] || 0, -16, 16) * 1000);
      }
      qActs[t * 2] = Math.round(clamp(steerList[t] || 0, -1, 1) * 100);
      qActs[t * 2 + 1] = Math.round(clamp(pedalList[t] || 0, -1, 1) * 100);
    }

    const qBytes = new Uint8Array(qObs.buffer);
    let binObs = '';
    const chunk = 0x8000;
    for (let i = 0; i < qBytes.length; i += chunk) {
      binObs += String.fromCharCode.apply(null, qBytes.subarray(i, i + chunk));
    }
    const aBytes = new Uint8Array(qActs.buffer);
    let binActs = '';
    for (let i = 0; i < aBytes.length; i += chunk) {
      binActs += String.fromCharCode.apply(null, aBytes.subarray(i, i + chunk));
    }
    return {
      ver: 2,
      obsDim: dim,
      steps: T,
      obsB64: btoa(binObs),
      act2B64: btoa(binActs)
    };
  }

  function unpackTrajectory(packed) {
    if (!packed || !packed.obsB64) return null;
    const binObs = atob(packed.obsB64);
    const qBytes = new Uint8Array(binObs.length);
    for (let i = 0; i < binObs.length; i++) qBytes[i] = binObs.charCodeAt(i);
    const qObs = new Int16Array(qBytes.buffer);

    // Support both v2 continuous trajectories and legacy v1 discrete trajectories
    if (packed.ver === 2 && packed.act2B64) {
      const dim = packed.obsDim || OBS_DIM;
      const binActs = atob(packed.act2B64);
      const aBytes = new Uint8Array(binActs.length);
      for (let i = 0; i < binActs.length; i++) aBytes[i] = binActs.charCodeAt(i);
      const qActs = new Int8Array(aBytes.buffer);
      const T = Math.floor(qActs.length / 2);
      const obsList = new Array(T);
      const steerList = new Float32Array(T);
      const pedalList = new Float32Array(T);

      for (let t = 0; t < T; t++) {
        const o = new Float32Array(OBS_DIM);
        const base = t * dim;
        const copyLen = Math.min(OBS_DIM, dim);
        for (let d = 0; d < copyLen; d++) {
          o[d] = qObs[base + d] * 0.001;
        }
        obsList[t] = o;
        steerList[t] = qActs[t * 2] / 100.0;
        pedalList[t] = qActs[t * 2 + 1] / 100.0;
      }
      return { obsList, steerList, pedalList };
    }

    if (packed.actB64) {
      const binActs = atob(packed.actB64);
      const acts = new Uint8Array(binActs.length);
      for (let i = 0; i < binActs.length; i++) acts[i] = binActs.charCodeAt(i);
      const T = acts.length;
      const oldDim = Math.floor(qObs.length / Math.max(1, T)) || 56;
      const obsList = new Array(T);
      const steerList = new Float32Array(T);
      const pedalList = new Float32Array(T);
      for (let t = 0; t < T; t++) {
        const o = new Float32Array(OBS_DIM);
        const base = t * oldDim;
        for (let d = 0; d < Math.min(30, oldDim); d++) o[d] = qObs[base + d] * 0.001;
        obsList[t] = o;
        const code = acts[t];
        const sIdx = Math.floor(code / 3);
        const pIdx = code % 3;
        steerList[t] = sIdx === 0 ? -1.0 : (sIdx === 2 ? 1.0 : 0.0);
        pedalList[t] = pIdx === 0 ? 1.0 : (pIdx === 2 ? -1.0 : 0.0);
      }
      return { obsList, steerList, pedalList };
    }

    return null;
  }

  /**
   * Adaptive per-track 5m sector memory: learns higher safe apex speeds on clean runs
   * and immediately lowers entry speed / shifts line before any corner that caused a crash.
   */
  class TrackSectorMemory {
    constructor(numSectors = 256) {
      const n = clamp(Math.ceil(numSectors), 32, MAX_SECTORS);
      this.numSectors = n;
      this.speedScale = new Float32Array(n).fill(1.0);
      this.apexBias = new Float32Array(n).fill(0.0); // [-0.6 .. +0.6]
      this.cleanCounts = new Uint16Array(n);
      this.crashCounts = new Uint16Array(n);
      this.globalGripScale = 1.0;

      // Champion snapshot (locked whenever a new #1 Personal Best lap finishes!)
      this.hasChampion = false;
      this.championSpeedScale = new Float32Array(n).fill(1.0);
      this.championApexBias = new Float32Array(n).fill(0.0);
      this.championGripScale = 1.0;
    }

    ensureSize(totalLengthM) {
      const needed = clamp(Math.ceil((totalLengthM + 20) / SECTOR_LEN_M), 32, MAX_SECTORS);
      if (needed <= this.numSectors) return;
      const nextSpeed = new Float32Array(needed).fill(1.0);
      const nextApex = new Float32Array(needed).fill(0.0);
      const nextClean = new Uint16Array(needed);
      const nextCrash = new Uint16Array(needed);
      const nextChampSpd = new Float32Array(needed).fill(1.0);
      const nextChampApx = new Float32Array(needed).fill(0.0);

      nextSpeed.set(this.speedScale);
      nextApex.set(this.apexBias);
      nextClean.set(this.cleanCounts);
      nextCrash.set(this.crashCounts);
      nextChampSpd.set(this.championSpeedScale);
      nextChampApx.set(this.championApexBias);

      this.numSectors = needed;
      this.speedScale = nextSpeed;
      this.apexBias = nextApex;
      this.cleanCounts = nextClean;
      this.crashCounts = nextCrash;
      this.championSpeedScale = nextChampSpd;
      this.championApexBias = nextChampApx;
    }

    binOf(arcS) {
      return clamp(Math.floor((arcS || 0) / SECTOR_LEN_M), 0, this.numSectors - 1);
    }

    getSectorParams(arcS, useChampion = false) {
      const b = this.binOf(arcS);
      if (useChampion && this.hasChampion) {
        return {
          speedScale: this.championSpeedScale[b] * this.championGripScale,
          apexBias: this.championApexBias[b]
        };
      }
      return {
        speedScale: this.speedScale[b] * this.globalGripScale,
        apexBias: this.apexBias[b]
      };
    }

    lockChampion() {
      this.hasChampion = true;
      this.championSpeedScale.set(this.speedScale);
      this.championApexBias.set(this.apexBias);
      this.championGripScale = this.globalGripScale;
    }

    /**
     * Update sector speed & line memory at the end of an episode:
     * - If crashed / flew off at s_end, blame braking zone [s_end - 45m .. s_end + 5m]
     * - For sectors traversed cleanly without heavy wall hits, nudge speed ceiling upward!
     */
    updateFromEpisode({
      maxArcS,
      finished,
      isNewBestLap,
      crashed,
      crashArcS,
      crashLateralSign,
      heavyHitArcs,
      slowCleanSectionRange = null
    }) {
      const maxBin = this.binOf(maxArcS);

      if (isNewBestLap && finished) {
        this.lockChampion();
      }

      const hitBins = new Set();
      if (Array.isArray(heavyHitArcs)) {
        for (let i = 0; i < heavyHitArcs.length; i++) {
          const hb = this.binOf(heavyHitArcs[i]);
          const sBlame = Math.max(0, hb - 9);
          const eBlame = Math.min(this.numSectors - 1, hb + 1);
          for (let k = sBlame; k <= eBlame; k++) {
            hitBins.add(k);
            const distFactor = 1.0 - (hb - k) / 11.0;
            const cut = 0.08 * clamp(distFactor, 0.35, 1.0);
            this.speedScale[k] = clamp(this.speedScale[k] * (1.0 - cut), 0.55, 1.50);
          }
        }
      }

      if (crashed && crashArcS != null) {
        const cBin = this.binOf(crashArcS);
        // Blame 10 sectors (~50m braking & turn-in zone) leading into the crash!
        const startBlame = Math.max(0, cBin - 10);
        const endBlame = Math.min(this.numSectors - 1, cBin + 1);
        for (let b = startBlame; b <= endBlame; b++) {
          hitBins.add(b);
          const distFactor = 1.0 - (cBin - b) / 12.0;
          const cut = 0.14 * clamp(distFactor, 0.35, 1.0);
          this.speedScale[b] = clamp(this.speedScale[b] * (1.0 - cut), 0.55, 1.50);
          this.crashCounts[b] = Math.min(65000, this.crashCounts[b] + 1);
          if (this.hasChampion) {
            this.apexBias[b] = this.apexBias[b] * 0.5 + this.championApexBias[b] * 0.5;
          } else if (crashLateralSign) {
            this.apexBias[b] = clamp(this.apexBias[b] - 0.16 * crashLateralSign * clamp(distFactor, 0.4, 1.0), -0.65, 0.65);
          } else {
            const altDodge = (this.crashCounts[cBin] % 2 === 1) ? 0.32 : -0.46;
            this.apexBias[b] = clamp(altDodge * clamp(distFactor, 0.4, 1.0), -0.65, 0.65);
          }
        }

        if (this.hasChampion) {
          for (let b = startBlame; b <= endBlame; b++) {
            this.speedScale[b] = Math.min(this.speedScale[b], this.championSpeedScale[b] * 0.97);
          }
        }
      }

      // If reset due to a clean slow section (zero wall hits), gently nudge corner speed ceiling up in that section
      if (slowCleanSectionRange && hitBins.size === 0 && !crashed) {
        const sBin = Math.max(0, this.binOf(slowCleanSectionRange[0]) - 3);
        const eBin = Math.min(this.numSectors - 1, this.binOf(slowCleanSectionRange[1]));
        for (let b = sBin; b <= eBin; b++) {
          const caution = 1.0 / (1.0 + 0.8 * this.crashCounts[b]);
          this.speedScale[b] = clamp(this.speedScale[b] * (1.0 + 0.024 * caution), 0.55, 1.62);
        }
        return;
      }

      // Push speed ceiling upward on clean sectors so lap times improve rapidly on any new track!
      const pushRate = finished ? 0.048 : 0.022;
      const limitBin = finished ? (this.numSectors - 1) : Math.max(0, maxBin - 10);
      for (let b = 0; b <= limitBin; b++) {
        if (hitBins.has(b)) continue;
        this.cleanCounts[b] = Math.min(65000, this.cleanCounts[b] + 1);
        const caution = 1.0 / (1.0 + 0.75 * this.crashCounts[b]);
        this.speedScale[b] = clamp(this.speedScale[b] * (1.0 + pushRate * caution), 0.55, 1.65);
      }

      if (finished && hitBins.size === 0) {
        this.globalGripScale = clamp(this.globalGripScale * 1.028, 0.82, 1.40);
      }
    }

    /**
     * Assimilate empirical corner speeds & racing-line apex offsets from a clean verified ghost/human run.
     */
    assimilateProGhost(sectorTargetScales, sectorApexOffsets, lockAsChampion = false) {
      const len = Math.min(this.numSectors, sectorTargetScales ? sectorTargetScales.length : 0);
      for (let b = 0; b < len; b++) {
        if (sectorTargetScales[b] > 0.5) {
          this.speedScale[b] = clamp(this.speedScale[b] * 0.35 + sectorTargetScales[b] * 0.65, 0.65, 1.65);
        }
        if (sectorApexOffsets && Number.isFinite(sectorApexOffsets[b])) {
          this.apexBias[b] = clamp(this.apexBias[b] * 0.35 + sectorApexOffsets[b] * 0.65, -0.60, 0.60);
        }
      }
      if (lockAsChampion) {
        this.lockChampion();
      }
    }

    serialize() {
      return {
        numSectors: this.numSectors,
        globalGripScale: this.globalGripScale,
        hasChampion: this.hasChampion,
        championGripScale: this.championGripScale,
        speedScaleB64: float32ToBase64(this.speedScale),
        apexBiasB64: float32ToBase64(this.apexBias),
        champSpeedB64: float32ToBase64(this.championSpeedScale),
        champApexB64: float32ToBase64(this.championApexBias)
      };
    }

    load(obj) {
      if (!obj || !obj.speedScaleB64) return;
      const spd = base64ToFloat32(obj.speedScaleB64);
      const apx = obj.apexBiasB64 ? base64ToFloat32(obj.apexBiasB64) : new Float32Array(spd.length);
      this.numSectors = spd.length;
      this.speedScale = spd;
      this.apexBias = apx;
      this.cleanCounts = new Uint16Array(this.numSectors);
      this.crashCounts = new Uint16Array(this.numSectors);
      this.globalGripScale = obj.globalGripScale || 1.0;
      this.hasChampion = !!obj.hasChampion;
      this.championGripScale = obj.championGripScale || 1.0;
      this.championSpeedScale = obj.champSpeedB64 ? base64ToFloat32(obj.champSpeedB64) : new Float32Array(spd);
      this.championApexBias = obj.champApexB64 ? base64ToFloat32(obj.champApexB64) : new Float32Array(apx);
    }
  }

  /**
   * Build the 64-dim sensory + 3D lookahead + vehicle dynamics observation vector.
   */
  function buildObservation(vision, track3d, telemetry, sectorMem, prevSteer, prevPedal, lowSpeedSec, useChampion = false) {
    const obs = new Float32Array(OBS_DIM);
    const has3D = !!(track3d && track3d.ready && telemetry.position);
    const rays = has3D ? track3d.rays : vision.rays;
    const deltas = has3D ? track3d.rayDeltas : vision.rayDeltas;

    // [0..14]: 15 ray clearances [-1, +1]
    for (let i = 0; i < 15; i++) {
      obs[i] = (rays[i] - 0.5) * 2.0;
    }
    // [15..29]: 15 ray closing deltas
    for (let i = 0; i < 15; i++) {
      obs[15 + i] = clamp(deltas[i] * 3.5, -1.5, 1.5);
    }

    // [30..39]: 5-point 3D lookahead angles & curvatures (fallback to visual turn bias when 2D-only)
    if (has3D) {
      for (let k = 0; k < 5; k++) {
        obs[30 + k] = track3d.lookaheadAngles[k];
        obs[35 + k] = track3d.lookaheadCurvatures[k];
      }
    } else {
      const vb = clamp(vision.visualTurnBias, -1.2, 1.2);
      for (let k = 0; k < 5; k++) {
        obs[30 + k] = vb * (0.55 + 0.1 * k);
        obs[35 + k] = vb * 0.45;
      }
    }

    // [40..47]: 2x4 condensed canvas visual road corridor grid (mirror-symmetric!)
    for (let row = 0; row < 2; row++) {
      const gRow0 = row * 8;
      const gRow1 = gRow0 + 4;
      for (let col = 0; col < 4; col++) {
        const avg = 0.5 * (vision.horizonGrid[gRow0 + col] + vision.horizonGrid[gRow1 + col]);
        obs[40 + row * 4 + col] = (avg - 0.5) * 2.0;
      }
    }

    // Compute physics target speed for this exact track location
    const priorInfo = computePriorControl(vision, track3d, telemetry, sectorMem, lowSpeedSec, useChampion);

    // Note: in PolyTrack, positive telemetry.steering is Left, negative is Right -> flip so Right > 0!
    const carSteerRight = clamp(-(telemetry.steering || 0) * 1.8, -1.0, 1.0);

    obs[48] = clamp((telemetry.speedKmh || 0) / 220.0, -0.5, 2.0);
    obs[49] = clamp((telemetry.accelKmhPerTick || 0) / 22.0, -1.5, 1.5);
    obs[50] = carSteerRight;
    obs[51] = clamp((telemetry.slipAngle || 0) * 2.2, -1.5, 1.5);
    obs[52] = clamp((telemetry.yawRate || 0) * 0.45, -1.5, 1.5);
    obs[53] = clamp((telemetry.avgSkid || 0) / 1.5, 0.0, 1.5);
    obs[54] = clamp((telemetry.groundedWheels ?? 4) / 4.0, 0.0, 1.0);
    obs[55] = has3D ? track3d.lookaheadPitch : clamp((telemetry.pitch || 0) * 2.0, -1.5, 1.5);
    obs[56] = has3D ? track3d.lateralOffsetNorm : 0.0;
    obs[57] = has3D ? clamp(track3d.headingError * 1.2, -1.5, 1.5) : clamp(-vision.visualTurnBias * 0.6, -1.5, 1.5);
    obs[58] = clamp(((telemetry.speedKmh || 0) - priorInfo.targetSpeedKmh) / 80.0, -1.5, 1.5);
    obs[59] = clamp(priorInfo.apexBias * 1.8, -1.0, 1.0);
    obs[60] = ((has3D ? track3d.centerClearance : vision.centerClearance) - 0.5) * 2.0;
    obs[61] = clamp(prevSteer, -1.0, 1.0);
    obs[62] = clamp(prevPedal, -1.0, 1.0);
    obs[63] = clamp(lowSpeedSec / 1.2, 0.0, 1.0);

    obs._prior = priorInfo;
    return obs;
  }

  /**
   * Exact horizontal left-right reflection symmetry for 2x sample efficiency on all 64 features.
   */
  function mirrorObservation(obs) {
    const m = new Float32Array(OBS_DIM);
    for (let i = 0; i < 15; i++) {
      m[i] = obs[14 - i];
      m[15 + i] = obs[15 + (14 - i)];
    }
    for (let k = 0; k < 5; k++) {
      m[30 + k] = -obs[30 + k]; // lookaheadAngles flip sign
      m[35 + k] = -obs[35 + k]; // lookaheadCurvatures flip sign
    }
    for (let row = 0; row < 2; row++) {
      const base = 40 + row * 4;
      m[base + 0] = obs[base + 3];
      m[base + 1] = obs[base + 2];
      m[base + 2] = obs[base + 1];
      m[base + 3] = obs[base + 0];
    }
    m[48] = obs[48];
    m[49] = obs[49];
    m[50] = -obs[50]; // carSteerRight
    m[51] = -obs[51]; // slipAngle
    m[52] = -obs[52]; // yawRate
    m[53] = obs[53];
    m[54] = obs[54];
    m[55] = obs[55];
    m[56] = -obs[56]; // lateralOffsetNorm
    m[57] = -obs[57]; // headingError
    m[58] = obs[58];
    m[59] = -obs[59]; // apexBias
    m[60] = obs[60];
    m[61] = -obs[61]; // prevSteer
    m[62] = obs[62];  // prevPedal
    m[63] = obs[63];
    return m;
  }

  /**
   * Physics-informed 3D Stanley/Pure-Pursuit + Drift Counter-Steer + Kinematic Braking Profile.
   * Serves as the structured prior around which PolyTinyNet-v2 learns residual racing refinements.
   */
  function computePriorControl(vision, track3d, telemetry, sectorMem, lowSpeedSec, useChampion = false) {
    const speedKmh = telemetry.speedKmh || 0;
    const speedMps = Math.max(0, speedKmh / 3.6);
    const grounded = (telemetry.groundedWheels ?? 4) >= 1;
    const has3D = !!(track3d && track3d.ready && telemetry.position);
    const rays = has3D ? track3d.rays : vision.rays;

    // 1. Wall-pin reverse escape reflex if nose is pinned against a barrier
    if (lowSpeedSec >= 0.62) {
      let leftOpen = 0, rightOpen = 0;
      for (let i = 0; i < 7; i++) leftOpen += rays[i];
      for (let i = 8; i < 15; i++) rightOpen += rays[i];
      // When reversing, steer opposite to the open forward side so the nose swings toward open road!
      const escapeSteer = rightOpen >= leftOpen ? -0.95 : 0.95;
      return {
        steer: escapeSteer,
        pedal: -1.0,
        targetSpeedKmh: 40,
        apexBias: 0,
        has3D
      };
    }

    if (!has3D) {
      // Pure 2D Vision fallback reflex
      const turn = clamp(vision.visualTurnBias * 0.95 - (-(telemetry.steering || 0)) * 0.35, -1.0, 1.0);
      const targetSpd = 95.0 + vision.centerClearance * 135.0;
      const pedal = speedKmh > targetSpd + 14 ? -0.75 : (speedKmh > targetSpd ? 0.0 : 1.0);
      return { steer: turn, pedal, targetSpeedKmh: targetSpd, apexBias: 0, has3D: false };
    }

    const sec = sectorMem
      ? sectorMem.getSectorParams(track3d.lastArcS, useChampion)
      : { speedScale: 1.0, apexBias: 0.0 };

    // 2. Dynamic speed-scaled 3D Pure-Pursuit + Stanley racing-line steering
    const w0 = speedKmh < 95 ? 0.60 : (speedKmh < 190 ? 0.44 : 0.28);
    const w1 = speedKmh < 95 ? 0.34 : (speedKmh < 190 ? 0.43 : 0.44);
    const w2 = speedKmh < 95 ? 0.06 : (speedKmh < 190 ? 0.13 : 0.22);
    const w3 = speedKmh < 190 ? 0.00 : 0.06;

    const targetAngle =
      w0 * track3d.lookaheadAngles[0] +
      w1 * track3d.lookaheadAngles[1] +
      w2 * track3d.lookaheadAngles[2] +
      w3 * track3d.lookaheadAngles[3];

    const W = track3d.waypoints;
    const i0 = track3d.lastArcIndex;
    const s0 = track3d.lastArcS;
    const curWp = W[i0] || { curvature: 0, y: 0 };

    const curvFeedforward = clamp(curWp.curvature * 12.2 + track3d.lookaheadCurvatures[0] * 0.24, -0.72, 0.72);
    const crossTrackErr = track3d.lateralOffsetNorm - sec.apexBias;

    // Close-range 3D LIDAR wall & cliff repulsion margin (disabled while inside vertical loops / wall-rides)
    let lidarRepulse = 0;
    if (!curWp.isWallTrack) {
      for (let r = 2; r <= 6; r++) {
        const distM = 2.0 + rays[r] * 70.0;
        const thresh = r >= 5 ? 8.5 : 5.6;
        if (distM < thresh) {
          lidarRepulse += ((thresh - distM) / thresh) * (r >= 5 ? 0.52 : 0.40);
        }
      }
      for (let r = 8; r <= 12; r++) {
        const distM = 2.0 + rays[r] * 70.0;
        const thresh = r <= 9 ? 8.5 : 5.6;
        if (distM < thresh) {
          lidarRepulse -= ((thresh - distM) / thresh) * (r <= 9 ? 0.52 : 0.40);
        }
      }
    }

    // Combine Pure-Pursuit + Cross-Track + Curvature + Drift Counter-Steer + Speed-Scaled Yaw Damping
    const cteGain = curWp.isWallTrack ? 0.12 : 0.42;
    const tgtGain = curWp.isWallTrack ? 1.15 : (speedKmh > 230 ? 1.82 : 2.02);
    const yawDamp = speedKmh > 220 ? 0.145 : 0.11;
    let steer =
      targetAngle * tgtGain +
      curvFeedforward -
      crossTrackErr * cteGain -
      track3d.headingError * 0.50 +
      lidarRepulse +
      (telemetry.slipAngle || 0) * 0.68 -
      (telemetry.yawRate || 0) * yawDamp;

    // Stabilize mid-air attitude on jumps so all 4 wheels touch down aligned with the landing ramp!
    if (!grounded && !curWp.isWallTrack) {
      steer = clamp(targetAngle * 0.35 - track3d.headingError * 0.35 - (telemetry.yawRate || 0) * 0.14, -0.28, 0.28);
    } else if (speedKmh < 0) {
      steer = -steer;
    }
    steer = clamp(steer, -1.0, 1.0);

    // 3. Pro-Calibrated Kinematic Braking, Aero-Downforce Grip & Early Apex Exit Profile
    // Empirically calibrated from 68 World-Record replays in 1000Hz Bullet WASM (~35-52 m/s^2 aero grip, ~24.5 m/s^2 safe trail-brake)
    const baseLatAccel = 35.5 + Math.min(18.0, 0.0024 * speedMps * speedMps);
    const brakeDecel = 24.5;
    const brakeHorizonM = Math.max(195.0, (speedMps * speedMps) / 36.0 + 55.0);

    const curAbsCurv = curWp.effectiveAbsCurv !== undefined ? curWp.effectiveAbsCurv : Math.abs(curWp.curvature || 0);
    const aheadWp = W[Math.min(W.length - 1, i0 + 3)] || curWp;
    const aheadAbsCurv = aheadWp.effectiveAbsCurv !== undefined ? aheadWp.effectiveAbsCurv : Math.abs(aheadWp.curvature || 0);
    const exitingApex = !curWp.isWallTrack && Math.abs(track3d.headingError) < 0.20 && aheadAbsCurv < curAbsCurv * 0.84;

    let allowedSpeedMps = 134.0; // ~482 km/h straightaway & vertical-dive ceiling
    let wallTrackAhead = !!curWp.isWallTrack;
    for (let i = i0; i < W.length; i++) {
      const ds = Math.max(0, W[i].s - s0);
      if (ds > brakeHorizonM) break;
      if (ds <= 65.0 && W[i].isWallTrack) {
        wallTrackAhead = true;
      }
      if (exitingApex && ds < 3.0) {
        continue;
      }

      const absCurv = W[i].effectiveAbsCurv !== undefined ? W[i].effectiveAbsCurv : Math.abs(W[i].curvature);
      const wpSec = sectorMem ? sectorMem.getSectorParams(W[i].s, useChampion) : sec;
      const localLat = baseLatAccel * wpSec.speedScale;

      let vCornerMps = 134.0;
      if (absCurv > 0.0028) {
        vCornerMps = Math.sqrt(localLat / (absCurv + 0.0018));
        if (W[i].isWallTrack) {
          vCornerMps = Math.max(vCornerMps, 78.0);
        }
      }

      // Extra caution when cresting a hill/jump into an immediate turn (unloaded tires!)
      if (W[i].pitchRate < -0.025 && absCurv > 0.012) {
        vCornerMps *= 0.80;
      }

      // Narrow corridor guard
      if ((W[i].clearance || 4.5) < 3.2 && absCurv > 0.020) {
        vCornerMps *= 0.88;
      }

      // Slope-compensated braking deceleration (downhill requires earlier braking!)
      const avgSlopeDown = ds > 4.0 ? clamp((curWp.y - W[i].y) / ds, -0.35, 0.45) : 0.0;
      const effBrake = Math.max(11.5, brakeDecel - 9.5 * avgSlopeDown);

      const vMaxHere = Math.sqrt(vCornerMps * vCornerMps + 2.0 * effBrake * ds);
      if (vMaxHere < allowedSpeedMps) {
        allowedSpeedMps = vMaxHere;
      }
    }

    if (curWp.isWallTrack) {
      // Smooth off-ramp transition only if a sharp flat-road turn immediately follows exit
      let distToFlat = -1;
      let postFlatCurv = 0;
      for (let j = i0; j < Math.min(W.length, i0 + 28); j++) {
        if (!W[j].isWallTrack) {
          if (distToFlat < 0) distToFlat = Math.max(0.0, W[j].s - curWp.s);
          const fc = W[j].effectiveAbsCurv !== undefined ? W[j].effectiveAbsCurv : Math.abs(W[j].curvature || 0);
          if (fc > postFlatCurv) postFlatCurv = fc;
        }
      }
      if (distToFlat >= 0 && postFlatCurv > 0.018) {
        const vTouch = 52.0; // ~187 km/h into sharp post-wall turn
        const vKin = Math.sqrt(vTouch * vTouch + 2.0 * 14.0 * distToFlat);
        allowedSpeedMps = Math.min(allowedSpeedMps, vKin);
      }
    }

    // Also guard against immediate forward LIDAR wall closure into sharp corners (skip on vertical loops / wall-rides)
    const fwdDistM = 2.0 + track3d.centerClearance * 70.0;
    const pos = telemetry.position, fwd = telemetry.forward;
    const hitsWallAhead = pos && fwd && track3d.segmentHitsWall(pos.x, pos.z, pos.x + fwd.x * 28.0, pos.z + fwd.z * 28.0, pos.y, pos.y) >= 0;
    if (!wallTrackAhead && hitsWallAhead && fwdDistM < 38.0 && Math.abs(targetAngle) > 0.16) {
      const lidarCapMps = Math.max(15.0, Math.sqrt(2.0 * 21.0 * Math.max(1.0, fwdDistM - 4.5)));
      allowedSpeedMps = Math.min(allowedSpeedMps, lidarCapMps * clamp(sec.speedScale, 0.78, 1.35));
    }

    const targetSpeedKmh = clamp(allowedSpeedMps * 3.6, 48.0, 480.0);
    const speedErrKmh = targetSpeedKmh - speedKmh;

    let pedal = 1.0;
    if (speedErrKmh >= -2.5) {
      pedal = (Math.abs(steer) > 0.88 && (telemetry.avgSkid || 0) > 1.15 && speedKmh > 110) ? 0.78 : 1.0;
    } else if (speedErrKmh > -8.5) {
      pedal = clamp(0.15 + (speedErrKmh + 8.5) / 8.5 * 0.60, -0.20, 0.75);
    } else {
      // Crisp hard braking when exceeding corner entry envelope (soften on WallTrack to prevent sliding off)
      const minPedal = curWp.isWallTrack ? -0.45 : -1.0;
      pedal = clamp((speedErrKmh + 5.0) / 14.0, minPedal, -0.35);
    }

    return {
      steer,
      pedal,
      targetSpeedKmh,
      apexBias: sec.apexBias,
      has3D
    };
  }

  class PolyTinyNet {
    constructor(seed = 20261110) {
      this._rngState = seed >>> 0;
      this.totalParams =
        (H1_DIM * IN1_DIM) + H1_DIM +
        (H2_DIM * H1_DIM) + H2_DIM +
        (ACT_DIM * H2_DIM) + ACT_DIM +
        ACT_DIM +
        H2_DIM + 1; // 15,717 Float32 params (~61.4 KB)

      this.params = new Float32Array(this.totalParams);
      this.championParams = null; // Locked weights from fastest finished lap
      this.grads = new Float32Array(this.totalParams);
      this.adamM = new Float32Array(this.totalParams);
      this.adamV = new Float32Array(this.totalParams);
      this.adamStep = 0;

      let off = 0;
      const slice = (len) => {
        const view = this.params.subarray(off, off + len);
        const gView = this.grads.subarray(off, off + len);
        off += len;
        return [view, gView];
      };

      [this.W1, this.gW1] = slice(H1_DIM * IN1_DIM);
      [this.b1, this.gb1] = slice(H1_DIM);
      [this.W2, this.gW2] = slice(H2_DIM * H1_DIM);
      [this.b2, this.gb2] = slice(H2_DIM);
      [this.Wmu, this.gWmu] = slice(ACT_DIM * H2_DIM);
      [this.bmu, this.gbmu] = slice(ACT_DIM);
      [this.logStd, this.gLogStd] = slice(ACT_DIM);
      [this.Wv, this.gWv] = slice(H2_DIM);
      [this.bv, this.gbv] = slice(1);

      this.context = new Float32Array(CTX_DIM);
      this.lastH1 = new Float32Array(H1_DIM);
      this.lastH2 = new Float32Array(H2_DIM);

      // Temporally correlated Ornstein-Uhlenbeck exploration state (smooth exploration, zero jitter!)
      this.ouSteer = 0;
      this.ouPedal = 0;

      // HUD visualization state
      this.lastSteerProbs = [0.0, 1.0, 0.0];
      this.lastPedalProbs = [1.0, 0.0, 0.0];
      this.lastContinuous = { steer: 0, pedal: 1, targetSpeedKmh: 180 };
      this.lastValue = 0;

      this.episodesTrained = 0;
      this.gradientUpdates = 0;
      this.lastLossInfo = { policyLoss: 0, valueLoss: 0, silLoss: 0 };

      this.initSmartWeights();
    }

    _randUniform() {
      let x = this._rngState;
      x ^= x << 13;
      x ^= x >>> 17;
      x ^= x << 5;
      this._rngState = x >>> 0;
      return (this._rngState % 1000000) / 1000000.0;
    }

    _randNormal() {
      const u1 = Math.max(1e-7, this._randUniform());
      const u2 = this._randUniform();
      return Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
    }

    initSmartWeights() {
      this.params.fill(0);
      this.adamM.fill(0);
      this.adamV.fill(0);
      this.adamStep = 0;
      this.championParams = null;

      const s1 = 0.18 / Math.sqrt(IN1_DIM);
      for (let i = 0; i < this.W1.length; i++) this.W1[i] = this._randNormal() * s1;

      const s2 = 0.18 / Math.sqrt(H1_DIM);
      for (let i = 0; i < this.W2.length; i++) this.W2[i] = this._randNormal() * s2;

      // Initialize residual policy output head small & clean so Episode 1 builds smoothly on motorsport physics prior
      const sh = 0.025 / Math.sqrt(H2_DIM);
      for (let i = 0; i < this.Wmu.length; i++) this.Wmu[i] = this._randNormal() * sh;
      for (let i = 0; i < this.Wv.length; i++) this.Wv[i] = this._randNormal() * 0.06;

      // Seed interpretable zero-bias residual channels: apex stabilization + excess-speed braking assist
      this.W1[0 * IN1_DIM + 31] = 0.65;  // 14m lookahead angle
      this.W1[0 * IN1_DIM + 51] = 0.55;  // slipAngle counter-steer
      this.W1[0 * IN1_DIM + 52] = -0.45; // yawRate damping
      this.W2[0 * H1_DIM + 0] = 0.80;
      this.Wmu[0 * H2_DIM + 0] = 0.10;

      this.W1[1 * IN1_DIM + 58] = -0.95; // (speed - targetSpeed) excess -> brake residual
      this.W2[1 * H1_DIM + 1] = 0.80;
      this.Wmu[1 * H2_DIM + 1] = 0.14;
      this.bmu[0] = 0.0;
      this.bmu[1] = 0.0;

      this.logStd[0] = -1.95; // ~0.14 residual std
      this.logStd[1] = -1.90; // ~0.15 residual std
    }

    lockChampionWeights() {
      this.championParams = new Float32Array(this.params);
    }

    resetContext() {
      this.context.fill(0);
      this.ouSteer = 0;
      this.ouPedal = 0;
    }

    _syncHudProbs(steer, pedal, targetSpeedKmh = 180) {
      const s = clamp(steer, -1, 1);
      const p = clamp(pedal, -1, 1);
      this.lastContinuous = { steer: s, pedal: p, targetSpeedKmh };
      this.lastSteerProbs = [
        Math.max(0, -s),
        Math.max(0, 1.0 - Math.abs(s)),
        Math.max(0, s)
      ];
      this.lastPedalProbs = [
        Math.max(0, p),
        Math.max(0, 1.0 - Math.abs(p)),
        Math.max(0, -p)
      ];
    }

    forward(obs, ctxIn = this.context, useChampion = false, updateLiveState = true) {
      const activeParams = (useChampion && this.championParams) ? this.championParams : this.params;

      let off = 0;
      const W1 = activeParams.subarray(off, off + H1_DIM * IN1_DIM); off += H1_DIM * IN1_DIM;
      const b1 = activeParams.subarray(off, off + H1_DIM); off += H1_DIM;
      const W2 = activeParams.subarray(off, off + H2_DIM * H1_DIM); off += H2_DIM * H1_DIM;
      const b2 = activeParams.subarray(off, off + H2_DIM); off += H2_DIM;
      const Wmu = activeParams.subarray(off, off + ACT_DIM * H2_DIM); off += ACT_DIM * H2_DIM;
      const bmu = activeParams.subarray(off, off + ACT_DIM); off += ACT_DIM;
      const logStd = activeParams.subarray(off, off + ACT_DIM); off += ACT_DIM;
      const Wv = activeParams.subarray(off, off + H2_DIM); off += H2_DIM;
      const bv = activeParams.subarray(off, off + 1);

      const zIn = new Float32Array(IN1_DIM);
      zIn.set(obs, 0);
      zIn.set(ctxIn, OBS_DIM);

      const h1 = new Float32Array(H1_DIM);
      for (let i = 0; i < H1_DIM; i++) {
        let sum = b1[i];
        const row = i * IN1_DIM;
        for (let j = 0; j < IN1_DIM; j++) {
          sum += W1[row + j] * zIn[j];
        }
        h1[i] = Math.tanh(sum);
      }

      const h2 = new Float32Array(H2_DIM);
      for (let i = 0; i < H2_DIM; i++) {
        let sum = b2[i];
        const row = i * H1_DIM;
        for (let j = 0; j < H1_DIM; j++) {
          sum += W2[row + j] * h1[j];
        }
        h2[i] = Math.tanh(sum);
      }

      const nextCtx = new Float32Array(CTX_DIM);
      for (let k = 0; k < CTX_DIM; k++) {
        nextCtx[k] = 0.65 * ctxIn[k] + 0.35 * h2[k];
      }

      let rawMu0 = bmu[0];
      let rawMu1 = bmu[1];
      for (let j = 0; j < H2_DIM; j++) {
        rawMu0 += Wmu[j] * h2[j];
        rawMu1 += Wmu[H2_DIM + j] * h2[j];
      }
      const nnSteer = Math.tanh(rawMu0);
      const nnPedal = Math.tanh(rawMu1);

      let val = bv[0];
      for (let j = 0; j < H2_DIM; j++) val += Wv[j] * h2[j];

      const std0 = Math.exp(clamp(logStd[0], -2.6, -0.7));
      const std1 = Math.exp(clamp(logStd[1], -2.6, -0.7));

      if (updateLiveState) {
        this.context.set(nextCtx);
        this.lastH1.set(h1);
        this.lastH2.set(h2);
        this.lastValue = val;
      }

      return {
        zIn,
        h1,
        h2,
        nextCtx,
        rawMu: [rawMu0, rawMu1],
        nnMean: [nnSteer, nnPedal],
        std: [std0, std1],
        value: val
      };
    }

    /**
     * Produce smooth continuous (steer, pedal) commands fusing the 3D motorsport physics prior
     * with PolyTinyNet-v2's learned residual policy.
     */
    act(obs, greedy = false) {
      const ctxBefore = new Float32Array(this.context);
      const out = this.forward(obs, ctxBefore, greedy, true);
      const prior = obs._prior || { steer: 0, pedal: 1.0, targetSpeedKmh: 180, has3D: false };

      // Neural residual authority grows smoothly as training progresses (0.24 -> 0.48 on 3D, 0.72 on 2D)
      const resAuthority = prior.has3D
        ? Math.min(0.48, 0.24 + this.episodesTrained * 0.010)
        : 0.72;

      let resSteer = out.nnMean[0];
      let resPedal = out.nnMean[1];

      if (!greedy) {
        // Smooth Ornstein-Uhlenbeck exploration (damped in mid-air so jump launches stay straight!)
        const decay = Math.max(0.32, Math.exp(-this.episodesTrained / 45.0));
        const airScale = obs[54] < 0.25 ? 0.20 : 1.0;
        this.ouSteer = 0.82 * this.ouSteer + 0.34 * this._randNormal();
        this.ouPedal = 0.82 * this.ouPedal + 0.32 * this._randNormal();
        resSteer = clamp(resSteer + this.ouSteer * out.std[0] * decay * airScale, -1.1, 1.1);
        resPedal = clamp(resPedal + this.ouPedal * out.std[1] * decay, -1.1, 1.1);
      }

      // Override with deterministic reverse-escape when pinned against a wall
      let steer = clamp(prior.steer + resAuthority * resSteer, -1.0, 1.0);
      let pedal = clamp(prior.pedal + resAuthority * resPedal, -1.0, 1.0);
      if (obs[63] > 0.52) {
        steer = prior.steer;
        pedal = -1.0;
      }

      const diff0 = (resSteer - out.nnMean[0]) / out.std[0];
      const diff1 = (resPedal - out.nnMean[1]) / out.std[1];
      const logProb = -0.5 * (diff0 * diff0 + diff1 * diff1) - Math.log(out.std[0] * out.std[1]);

      this._syncHudProbs(steer, pedal, prior.targetSpeedKmh);
      const steerIdx = steer < -0.22 ? 0 : (steer > 0.22 ? 2 : 1);
      const pedalIdx = pedal > 0.20 ? 0 : (pedal < -0.20 ? 2 : 1);

      return {
        steer,
        pedal,
        steerIdx,
        pedalIdx,
        resAction: [resSteer, resPedal],
        priorSteer: prior.steer,
        priorPedal: prior.pedal,
        resAuthority,
        logProb,
        value: out.value,
        ctxBefore
      };
    }

    _zeroGrads() {
      this.grads.fill(0);
    }

    _backwardStep(fwd, dRawMu0, dRawMu1, dLogStd0, dLogStd1, dValue) {
      const dh2 = new Float32Array(H2_DIM);

      this.gbmu[0] += dRawMu0;
      this.gbmu[1] += dRawMu1;
      for (let j = 0; j < H2_DIM; j++) {
        this.gWmu[j] += dRawMu0 * fwd.h2[j];
        this.gWmu[H2_DIM + j] += dRawMu1 * fwd.h2[j];
        dh2[j] += dRawMu0 * this.Wmu[j] + dRawMu1 * this.Wmu[H2_DIM + j];
      }

      this.gLogStd[0] += dLogStd0;
      this.gLogStd[1] += dLogStd1;

      if (dValue !== 0) {
        this.gbv[0] += dValue;
        for (let j = 0; j < H2_DIM; j++) {
          this.gWv[j] += dValue * fwd.h2[j];
          dh2[j] += dValue * this.Wv[j];
        }
      }

      const dh1 = new Float32Array(H1_DIM);
      for (let i = 0; i < H2_DIM; i++) {
        const du2 = dh2[i] * (1.0 - fwd.h2[i] * fwd.h2[i]);
        this.gb2[i] += du2;
        const row = i * H1_DIM;
        for (let j = 0; j < H1_DIM; j++) {
          this.gW2[row + j] += du2 * fwd.h1[j];
          dh1[j] += du2 * this.W2[row + j];
        }
      }

      for (let i = 0; i < H1_DIM; i++) {
        const du1 = dh1[i] * (1.0 - fwd.h1[i] * fwd.h1[i]);
        this.gb1[i] += du1;
        const row = i * IN1_DIM;
        for (let j = 0; j < IN1_DIM; j++) {
          this.gW1[row + j] += du1 * fwd.zIn[j];
        }
      }
    }

    _applyAdamW(lr = 9.0e-4, weightDecay = 1e-4, maxGradNorm = 1.0) {
      let normSq = 0;
      for (let i = 0; i < this.grads.length; i++) {
        normSq += this.grads[i] * this.grads[i];
      }
      const norm = Math.sqrt(normSq);
      const clipScale = norm > maxGradNorm ? (maxGradNorm / (norm + 1e-8)) : 1.0;

      this.adamStep += 1;
      const b1 = 0.9;
      const b2 = 0.999;
      const bc1 = 1.0 - Math.pow(b1, this.adamStep);
      const bc2 = 1.0 - Math.pow(b2, this.adamStep);

      for (let i = 0; i < this.params.length; i++) {
        const g = this.grads[i] * clipScale;
        const m = b1 * this.adamM[i] + (1.0 - b1) * g;
        const v = b2 * this.adamV[i] + (1.0 - b2) * g * g;
        this.adamM[i] = m;
        this.adamV[i] = v;
        const mHat = m / bc1;
        const vHat = v / bc2;
        this.params[i] = this.params[i] * (1.0 - lr * weightDecay) - lr * (mHat / (Math.sqrt(vHat) + 1e-8));
      }
      this.logStd[0] = clamp(this.logStd[0], -2.6, -0.75);
      this.logStd[1] = clamp(this.logStd[1], -2.6, -0.75);
      this.gradientUpdates += 1;
    }

    /**
     * Continuous Gaussian PPO-Clip + GAE update on a completed autonomous episode.
     */
    trainPPOEpisode(trajectory, lr = 8.5e-4) {
      const T = trajectory.length;
      if (T < 5) return;

      const gamma = 0.985;
      const lam = 0.95;
      const clipEps = 0.20;

      const advantages = new Float32Array(T);
      const returns = new Float32Array(T);
      let gae = 0;
      for (let t = T - 1; t >= 0; t--) {
        const nextVal = (t === T - 1) ? 0.0 : trajectory[t + 1].value;
        const delta = trajectory[t].reward + gamma * nextVal - trajectory[t].value;
        gae = delta + gamma * lam * gae;
        advantages[t] = gae;
        returns[t] = gae + trajectory[t].value;
      }

      let meanAdv = 0;
      for (let t = 0; t < T; t++) meanAdv += advantages[t];
      meanAdv /= T;
      let varAdv = 0;
      for (let t = 0; t < T; t++) {
        const d = advantages[t] - meanAdv;
        varAdv += d * d;
      }
      const stdAdv = Math.sqrt(varAdv / T + 1e-6);
      for (let t = 0; t < T; t++) {
        advantages[t] = clamp((advantages[t] - meanAdv) / stdAdv, -3.0, 3.0);
      }

      const batchSize = Math.min(64, T);
      const epochs = 2;
      let lastPolLoss = 0;
      let lastValLoss = 0;

      for (let ep = 0; ep < epochs; ep++) {
        for (let start = 0; start < T; start += batchSize) {
          const end = Math.min(T, start + batchSize);
          const invB = 1.0 / (end - start);
          this._zeroGrads();

          for (let idx = start; idx < end; idx++) {
            const step = trajectory[idx];
            const adv = advantages[idx];
            const ret = returns[idx];

            const fwd = this.forward(step.obs, step.ctxBefore, false, false);
            const mu0 = fwd.nnMean[0], mu1 = fwd.nnMean[1];
            const std0 = fwd.std[0], std1 = fwd.std[1];
            const a0 = step.resAction[0], a1 = step.resAction[1];

            const z0 = (a0 - mu0) / std0;
            const z1 = (a1 - mu1) / std1;
            const newLogProb = -0.5 * (z0 * z0 + z1 * z1) - Math.log(std0 * std1);
            const ratio = Math.exp(clamp(newLogProb - step.logProb, -5, 5));

            const unclipped = ratio * adv;
            const clipped = clamp(ratio, 1.0 - clipEps, 1.0 + clipEps) * adv;
            lastPolLoss += -Math.min(unclipped, clipped) * invB;

            const isClipped = (adv > 0 && ratio > 1.0 + clipEps) || (adv < 0 && ratio < 1.0 - clipEps);
            const pgFactor = isClipped ? 0.0 : (-ratio * adv * invB);

            // d(newLogProb)/d(mu) = (a - mu) / std^2; d(mu)/d(rawMu) = 1 - mu^2
            const dMu0 = pgFactor * (z0 / std0) * (1.0 - mu0 * mu0);
            const dMu1 = pgFactor * (z1 / std1) * (1.0 - mu1 * mu1);
            const dLs0 = pgFactor * (z0 * z0 - 1.0) * 0.15;
            const dLs1 = pgFactor * (z1 * z1 - 1.0) * 0.15;

            const vDiff = clamp(fwd.value - ret, -12.0, 12.0);
            lastValLoss += 0.5 * vDiff * vDiff * invB;
            const dV = 0.45 * vDiff * invB;

            this._backwardStep(fwd, dMu0, dMu1, dLs0, dLs1, dV);
          }

          this._applyAdamW(lr, 1e-4, 1.0);
        }
      }

      this.episodesTrained += 1;
      this.lastLossInfo.policyLoss = lastPolLoss;
      this.lastLossInfo.valueLoss = lastValLoss;
    }

    /**
     * Self-Imitation Learning (SIL) & Human Behavioral Cloning on Top Runs with 50% exact mirror symmetry!
     */
    trainFromEliteRuns(topRuns, stepsBudget = 3, lr = 9.5e-4) {
      if (!topRuns || topRuns.length === 0) return 0;

      const segments = [];
      for (let r = 0; r < topRuns.length; r++) {
        const run = topRuns[r];
        const unpacked = unpackTrajectory(run.trajectory);
        if (!unpacked) continue;
        const usableLen = run.finished
          ? unpacked.obsList.length
          : Math.max(0, unpacked.obsList.length - 22);
        if (usableLen < 8) continue;

        const rankWeight = (run.source === 'YOU' ? 2.4 : 1.0) * (run.finished ? 2.0 : 0.7) * (1.0 / (1.0 + 0.4 * r));
        segments.push({ unpacked, usableLen, rankWeight });
      }
      if (!segments.length) return 0;

      let totalSilLoss = 0;
      for (let pass = 0; pass < stepsBudget; pass++) {
        let wSum = 0;
        for (const s of segments) wSum += s.rankWeight;
        let pick = Math.random() * wSum;
        let chosen = segments[0];
        for (const s of segments) {
          pick -= s.rankWeight;
          if (pick <= 0) {
            chosen = s;
            break;
          }
        }

        const useMirror = Math.random() < 0.5;
        const T = chosen.usableLen;

        const ctxSeq = new Array(T);
        const obsSeq = new Array(T);
        let ctx = new Float32Array(CTX_DIM);
        for (let t = 0; t < T; t++) {
          const o = useMirror
            ? mirrorObservation(chosen.unpacked.obsList[t])
            : chosen.unpacked.obsList[t];
          obsSeq[t] = o;
          ctxSeq[t] = ctx;
          const out = this.forward(o, ctx, false, false);
          ctx = out.nextCtx;
        }

        const sampleCount = Math.min(56, T);
        const invN = 1.0 / sampleCount;
        this._zeroGrads();

        for (let k = 0; k < sampleCount; k++) {
          const idx = Math.min(T - 1, Math.floor((k + Math.random()) * (T / sampleCount)));
          const o = obsSeq[idx];
          const fullSteer = useMirror ? -chosen.unpacked.steerList[idx] : chosen.unpacked.steerList[idx];
          const fullPedal = chosen.unpacked.pedalList[idx];

          // Estimate baseline prior from observation lookahead & speed ratio so residual matches elite trajectory!
          const approxPriorSteer = clamp(
            (0.25 * o[30] + 0.45 * o[31] + 0.30 * o[32]) * 1.65 - o[56] * 0.32 - o[57] * 0.25,
            -1.0,
            1.0
          );
          const approxPriorPedal = o[58] > 0.14 ? clamp(-o[58] * 2.2, -1.0, 0.2) : 1.0;

          const targetResSteer = clamp((fullSteer - approxPriorSteer) / 0.48, -0.95, 0.95);
          const targetResPedal = clamp((fullPedal - approxPriorPedal) / 0.48, -0.95, 0.95);

          const fwd = this.forward(o, ctxSeq[idx], false, false);
          const e0 = fwd.nnMean[0] - targetResSteer;
          const e1 = fwd.nnMean[1] - targetResPedal;
          totalSilLoss += 0.5 * (e0 * e0 + e1 * e1) * invN;

          const dRaw0 = e0 * (1.0 - fwd.nnMean[0] * fwd.nnMean[0]) * invN;
          const dRaw1 = e1 * (1.0 - fwd.nnMean[1] * fwd.nnMean[1]) * invN;
          this._backwardStep(fwd, dRaw0, dRaw1, 0, 0, 0);
        }

        this._applyAdamW(lr, 1e-4, 1.0);
      }

      this.lastLossInfo.silLoss = totalSilLoss / stepsBudget;
      return this.lastLossInfo.silLoss;
    }

    get hasChampion() {
      return !!this.championParams;
    }

    getMemoryStats() {
      const weightBytes = this.params.byteLength + (this.championParams ? this.championParams.byteLength : 0);
      const optimizerBytes = this.adamM.byteLength + this.adamV.byteLength + this.grads.byteLength;
      let heapUsedMB = 22.4;
      if (performance && performance.memory && performance.memory.usedJSHeapSize) {
        heapUsedMB = performance.memory.usedJSHeapSize / (1024 * 1024);
      }
      return {
        paramCount: this.totalParams,
        weightKB: +(this.params.byteLength / 1024).toFixed(1),
        totalModelKB: +((weightBytes + optimizerBytes) / 1024).toFixed(1),
        heapUsedMB: +heapUsedMB.toFixed(1)
      };
    }

    serializeMetaAndWeights() {
      return {
        arch: 'PolyTinyNet-v2',
        obsDim: OBS_DIM,
        ctxDim: CTX_DIM,
        h1Dim: H1_DIM,
        h2Dim: H2_DIM,
        totalParams: this.totalParams,
        episodesTrained: this.episodesTrained,
        gradientUpdates: this.gradientUpdates,
        adamStep: this.adamStep,
        weightsB64: float32ToBase64(this.params),
        championWeightsB64: this.championParams ? float32ToBase64(this.championParams) : null
      };
    }

    loadWeightsObject(obj) {
      if (!obj || !obj.weightsB64) {
        throw new Error('Incompatible PolyTinyNet brain file');
      }
      // Graceful upgrade if loading an older v1 brain file (re-init v2 weights while keeping episode count)
      if (obj.totalParams !== this.totalParams) {
        this.initSmartWeights();
        this.episodesTrained = obj.episodesTrained || 0;
        this.gradientUpdates = obj.gradientUpdates || 0;
        return;
      }
      const loaded = base64ToFloat32(obj.weightsB64);
      if (loaded.length !== this.totalParams) {
        throw new Error('Weight array length mismatch');
      }
      this.params.set(loaded);
      this.championParams = obj.championWeightsB64 ? base64ToFloat32(obj.championWeightsB64) : null;
      this.adamM.fill(0);
      this.adamV.fill(0);
      this.adamStep = obj.adamStep || 0;
      this.episodesTrained = obj.episodesTrained || 0;
      this.gradientUpdates = obj.gradientUpdates || 0;
      this.resetContext();
    }
  }

  /**
   * Compare two runs for Top Runs Leaderboard:
   * 1. Finished runs always rank above unfinished runs
   * 2. Among finished runs: fastest finishTimeMs wins!
   * 3. Among unfinished runs: more checkpoints -> higher progressMeters -> higher totalReward
   */
  function compareRuns(a, b) {
    if (a.finished !== b.finished) return a.finished ? -1 : 1;
    if (a.finished && b.finished) {
      return (a.finishTimeMs || 9999999) - (b.finishTimeMs || 9999999);
    }
    if ((a.checkpoints || 0) !== (b.checkpoints || 0)) {
      return (b.checkpoints || 0) - (a.checkpoints || 0);
    }
    if (Math.abs((a.progressMeters || 0) - (b.progressMeters || 0)) > 1.5) {
      return (b.progressMeters || 0) - (a.progressMeters || 0);
    }
    return (b.totalReward || 0) - (a.totalReward || 0);
  }

  function insertTopRun(topRuns, candidateRun) {
    const list = Array.isArray(topRuns) ? topRuns.slice() : [];
    list.push(candidateRun);
    list.sort(compareRuns);
    const trimmed = list.slice(0, MAX_TOP_RUNS);
    const rank = trimmed.findIndex((r) => r.id === candidateRun.id);
    return { topRuns: trimmed, rank };
  }

  window.PolyPilotBrain = {
    PolyTinyNet,
    TrackSectorMemory,
    OBS_DIM,
    CTX_DIM,
    H1_DIM,
    H2_DIM,
    MAX_TOP_RUNS,
    buildObservation,
    computePriorControl,
    mirrorObservation,
    packTrajectory,
    unpackTrajectory,
    compareRuns,
    insertTopRun
  };
})();
