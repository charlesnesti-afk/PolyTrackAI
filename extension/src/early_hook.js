(() => {
  'use strict';
  if (window.__POLYPILOT_EARLY_HOOK__) return;
  window.__POLYPILOT_EARLY_HOOK__ = true;

  function fnv1aHash36(str) {
    let h = 0x811c9dc5;
    const len = str.length;
    const step = len > 4096 ? Math.floor(len / 2048) : 1;
    for (let i = 0; i < len; i += step) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return 'trk' + len.toString(36) + '_' + h.toString(36);
  }

  function rotateVecByQuat(vx, vy, vz, qx, qy, qz, qw) {
    // t = 2 * cross(q.xyz, v)
    const tx = 2 * (qy * vz - qz * vy);
    const ty = 2 * (qz * vx - qx * vz);
    const tz = 2 * (qx * vy - qy * vx);
    return {
      x: vx + qw * tx + (qy * tz - qz * ty),
      y: vy + qw * ty + (qz * tx - qx * tz),
      z: vz + qw * tz + (qx * ty - qy * tx)
    };
  }

  function cloneInitPayload(initMsg) {
    if (!initMsg) return null;
    const clonedParts = [];
    if (Array.isArray(initMsg.trackParts)) {
      for (let k = 0; k < initMsg.trackParts.length; k++) {
        const p = initMsg.trackParts[k];
        if (!p) continue;
        const verts = p.vertices instanceof Float32Array
          ? new Float32Array(p.vertices)
          : (p.vertices ? new Float32Array(Array.from(p.vertices)) : null);
        clonedParts.push({
          id: p.id,
          vertices: verts,
          detector: p.detector ? JSON.parse(JSON.stringify(p.detector)) : null,
          startOffset: p.startOffset ? JSON.parse(JSON.stringify(p.startOffset)) : null
        });
      }
    }
    const carVerts = initMsg.carCollisionShapeVertices instanceof Float32Array
      ? new Float32Array(initMsg.carCollisionShapeVertices)
      : (Array.isArray(initMsg.carCollisionShapeVertices) ? new Float32Array(initMsg.carCollisionShapeVertices) : null);
    return {
      messageType: 0,
      version: initMsg.version || '0.6.3',
      isRealtime: true,
      trackParts: clonedParts,
      carCollisionShapeVertices: carVerts,
      carMassOffset: initMsg.carMassOffset ?? 0.6
    };
  }

  const tap = {
    webglHooked: false,
    workerHooked: false,
    playerCarId: 0,
    latestCarState: null,
    latestCarStateAt: 0,
    latestSentControls: { up: false, right: false, down: false, left: false, reset: false },
    partCatalog: new Map(),
    latestTrackData: null,
    trackLoadSeq: 0,
    trackSignature: null,
    trackPartCount: 0,
    _prevKin: null,
    _prevKinByCar: new Map(),
    _forwardSignZ: 1, // +1 means car local +Z is forward; auto-verified on first forward motion
    workerScriptURL: null,
    workerOptions: null,
    OrigWorker: typeof window.Worker === 'function' ? window.Worker : null,
    rawInitPayload: null,
    mountainVertices: null,
    mountainOffset: null,
    ghostRecordings: [],
    ghostCaptureSeq: 0,
    decodeCarStateBuffer: null
  };
  window.__POLYPILOT_TAP__ = tap;

  // 1. Ensure WebGL context preserves drawing buffer so 64x36 vision sampling never reads cleared frames
  const origGetContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, attrs) {
    if (typeof type === 'string' && (type.indexOf('webgl') !== -1 || type === 'experimental-webgl')) {
      attrs = Object.assign({}, attrs || {}, { preserveDrawingBuffer: true });
      tap.webglHooked = true;
    }
    return origGetContext.call(this, type, attrs);
  };

  // 2. Decode PolyTrack simulation_worker UpdateResult carStateBuffers for active playerCarId passively
  function decodeCarStateBuffer(rawBuffer, expectedCarId) {
    const bytes = rawBuffer instanceof Uint8Array
      ? rawBuffer
      : (ArrayBuffer.isView(rawBuffer)
        ? new Uint8Array(rawBuffer.buffer, rawBuffer.byteOffset, rawBuffer.byteLength)
        : new Uint8Array(rawBuffer));

    if (bytes.byteLength < 44) return null;
    const carId = (bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24)) >>> 0;
    if (carId !== expectedCarId) return null;

    const e = bytes.subarray(4);
    const dv = new DataView(e.buffer, e.byteOffset, e.byteLength);
    let i = 0;

    const frames = e[0] | (e[1] << 8) | (e[2] << 16);
    i += 3;
    const speedKmh = dv.getFloat32(i, true);
    i += 4;

    const flags = e[i];
    i += 1;
    const hasStarted = !!(flags & 1);
    const hasFinished = !!(flags & 2);
    const hasCheckpointToRespawnAt = !!(flags & 4);
    const wheelContacts = [
      (flags & 8) ? 1 : 0,
      (flags & 16) ? 1 : 0,
      (flags & 32) ? 1 : 0,
      (flags & 64) ? 1 : 0
    ];

    let finishFrames = null;
    if (hasFinished) {
      if (e.byteLength < i + 3) return null;
      finishFrames = e[i] | (e[i + 1] << 8) | (e[i + 2] << 16);
      i += 3;
    }

    if (e.byteLength < i + 31) return null;
    const nextCheckpointIndex = dv.getUint16(i, true);
    i += 2;

    const px = dv.getFloat32(i, true);
    const py = dv.getFloat32(i + 4, true);
    const pz = dv.getFloat32(i + 8, true);
    i += 12;

    const qx = dv.getFloat32(i, true);
    const qy = dv.getFloat32(i + 4, true);
    const qz = dv.getFloat32(i + 8, true);
    const qw = dv.getFloat32(i + 12, true);
    i += 16;

    const collisionCount = e[i];
    i += 1;
    if (e.byteLength < i + collisionCount * 4) return null;
    let maxCollisionImpulse = 0;
    for (let k = 0; k < collisionCount; k++) {
      const imp = dv.getFloat32(i, true);
      if (imp > maxCollisionImpulse) maxCollisionImpulse = imp;
      i += 4;
    }

    for (let w = 0; w < 4; w++) {
      if (wheelContacts[w]) {
        if (e.byteLength < i + 24) return null;
        i += 24;
      }
    }

    // Suspension length (16) + velocity (16) + deltaRotation (16) = 48 bytes
    if (e.byteLength < i + 48 + 16 + 4 + 1) return null;
    i += 48;

    let skidSum = 0;
    for (let w = 0; w < 4; w++) {
      skidSum += Math.abs(dv.getFloat32(i, true));
      i += 4;
    }
    const steering = dv.getFloat32(i, true);
    i += 4;

    const ctrlByte = e[i];
    const controls = {
      up: !!(ctrlByte & 1),
      right: !!(ctrlByte & 2),
      down: !!(ctrlByte & 4),
      left: !!(ctrlByte & 8),
      reset: !!(ctrlByte & 16)
    };

    const groundedWheels = wheelContacts[0] + wheelContacts[1] + wheelContacts[2] + wheelContacts[3];

    // Derive exact 3D basis & velocity kinematics from physics timestamps (1 frame = 1ms)
    const rawZ = rotateVecByQuat(0, 0, 1, qx, qy, qz, qw);
    const up = rotateVecByQuat(0, 1, 0, qx, qy, qz, qw);

    let vx = 0;
    let vy = 0;
    let vz = 0;
    let yawRate = 0;
    const pk = tap._prevKinByCar.get(carId) || null;
    if (pk && frames > pk.frames && (frames - pk.frames) < 250) {
      const dt = (frames - pk.frames) * 0.001;
      vx = (px - pk.px) / dt;
      vy = (py - pk.py) / dt;
      vz = (pz - pk.pz) / dt;

      // Auto-lock forward local Z sign when moving cleanly forward (> 20 km/h)
      if (speedKmh > 20 && groundedWheels >= 3) {
        const dotZ = vx * rawZ.x + vy * rawZ.y + vz * rawZ.z;
        if (Math.abs(dotZ) > 3.0) {
          tap._forwardSignZ = dotZ >= 0 ? 1 : -1;
        }
      }

      const prevFwd = pk.forward;
      const curFwdX = rawZ.x * tap._forwardSignZ;
      const curFwdY = rawZ.y * tap._forwardSignZ;
      const curFwdZ = rawZ.z * tap._forwardSignZ;
      const rightX = curFwdY * up.z - curFwdZ * up.y;
      const rightY = curFwdZ * up.x - curFwdX * up.z;
      const rightZ = curFwdX * up.y - curFwdY * up.x;
      const dfx = (curFwdX - prevFwd.x) / dt;
      const dfy = (curFwdY - prevFwd.y) / dt;
      const dfz = (curFwdZ - prevFwd.z) / dt;
      const rawYawRate = dfx * rightX + dfy * rightY + dfz * rightZ;
      yawRate = pk.yawRate * 0.35 + rawYawRate * 0.65;
    }

    const sgn = tap._forwardSignZ;
    const forward = { x: rawZ.x * sgn, y: rawZ.y * sgn, z: rawZ.z * sgn };
    // Universal right-handed identity: right = normalize(cross(forward, up))
    let rx = forward.y * up.z - forward.z * up.y;
    let ry = forward.z * up.x - forward.x * up.z;
    let rz = forward.x * up.y - forward.y * up.x;
    const rLen = Math.hypot(rx, ry, rz) || 1.0;
    const right = { x: rx / rLen, y: ry / rLen, z: rz / rLen };

    // Slip angle: positive when car velocity drifts to the RIGHT of nose forward
    const vFwd = vx * forward.x + vy * forward.y + vz * forward.z;
    const vRight = vx * right.x + vy * right.y + vz * right.z;
    const horizSpeedMps = Math.hypot(vFwd, vRight);
    const slipAngle = horizSpeedMps > 2.5 ? Math.atan2(vRight, Math.max(1.0, Math.abs(vFwd))) : 0;

    if (!pk || frames !== pk.frames) {
      if (tap._prevKinByCar.size >= 24 && !tap._prevKinByCar.has(carId)) {
        const oldestKey = tap._prevKinByCar.keys().next().value;
        tap._prevKinByCar.delete(oldestKey);
      }
      const nextPk = {
        carId,
        frames,
        px,
        py,
        pz,
        forward,
        yawRate
      };
      tap._prevKinByCar.set(carId, nextPk);
      if (carId === tap.playerCarId) tap._prevKin = nextPk;
    } else if (pk) {
      yawRate = pk.yawRate;
    }

    return {
      carId,
      frames,
      timeMs: frames,
      speedKmh,
      hasStarted,
      hasFinished,
      finishFrames,
      finishTimeMs: finishFrames,
      currentCp: nextCheckpointIndex,
      nextCheckpointIndex,
      hasCheckpointToRespawnAt,
      position: { x: px, y: py, z: pz },
      quaternion: { x: qx, y: qy, z: qz, w: qw },
      forward,
      right,
      up,
      velocity: { x: vx, y: vy, z: vz },
      slipAngle,
      yawRate,
      pitch: Math.asin( Math.max(-1, Math.min(1, forward.y)) ),
      maxCollisionImpulse,
      collisionCount,
      groundedWheels,
      avgSkid: skidSum * 0.25,
      steering,
      controls
    };
  }
  tap.decodeCarStateBuffer = decodeCarStateBuffer;

  // 3. Passive Worker wrapper + prototype fallback for realtime simulation_worker (handles blob: URLs & cold-start tabs)
  const OrigWorker = window.Worker;
  const origProtoPostMessage = (typeof OrigWorker === 'function' && OrigWorker.prototype)
    ? OrigWorker.prototype.postMessage
    : null;

  function handleSimWorkerPost(worker, msg) {
    if (!msg || typeof msg !== 'object') return;
    if (worker.__polyPilotInternal) return;

    // Capture leaderboard/opponent ghost carRecordings even when simulated on the non-realtime replay worker
    if (msg.messageType === 3 && typeof msg.carRecording === 'string' && msg.carRecording.length > 0) {
      if (typeof msg.trackData === 'string' && msg.trackData.length > 0 && msg.trackData !== tap.latestTrackData) {
        tap.latestTrackData = msg.trackData;
        tap.trackSignature = fnv1aHash36(msg.trackData);
        tap.trackLoadSeq += 1;
        tap.ghostRecordings = [];
      }
      const exists = tap.ghostRecordings.some((g) => g.carRecording === msg.carRecording);
      if (!exists && tap.ghostRecordings.length < 12) {
        tap.ghostRecordings.push({
          carId: (msg.carId || 0) >>> 0,
          carRecording: msg.carRecording,
          trackSignature: tap.trackSignature
        });
        tap.ghostCaptureSeq += 1;
      }
    }

    // o.Init === 0: Capture 3D physics part catalog once (vertices, detectors, startOffsets)
    if (msg.messageType === 0 && typeof msg.isRealtime === 'boolean') {
      worker.__polyPilotIsRealtime = msg.isRealtime;
      if (!tap.rawInitPayload) {
        tap.rawInitPayload = cloneInitPayload(msg);
      }
      if (msg.carCollisionShapeVertices && !tap.carCollisionShapeVertices) {
        tap.carCollisionShapeVertices = msg.carCollisionShapeVertices;
        tap.carMassOffset = msg.carMassOffset;
      }
      if (tap.partCatalog.size === 0 && Array.isArray(msg.trackParts) && msg.trackParts.length > 0) {
        tap.trackPartCount = msg.trackParts.length;
        for (let k = 0; k < msg.trackParts.length; k++) {
          const p = msg.trackParts[k];
          if (p && typeof p.id === 'number' && p.vertices) {
            const verts = p.vertices instanceof Float32Array
              ? new Float32Array(p.vertices)
              : new Float32Array(Array.from(p.vertices));
            const toVec3 = (v) => {
              if (!v) return { x: 0, y: 0, z: 0 };
              if (Array.isArray(v) || ArrayBuffer.isView(v)) {
                return { x: +(v[0] || 0), y: +(v[1] || 0), z: +(v[2] || 0) };
              }
              return { x: +(v.x || 0), y: +(v.y || 0), z: +(v.z || 0) };
            };
            const det = p.detector ? {
              type: p.detector.type,
              center: toVec3(p.detector.center),
              size: toVec3(p.detector.size)
            } : null;
            const sOff = p.startOffset ? toVec3(p.startOffset) : null;
            tap.partCatalog.set(p.id, { id: p.id, vertices: verts, detector: det, startOffset: sOff });
          }
        }
      }
    } else if (worker.__polyPilotIsRealtime !== false && typeof msg.carId === 'number') {
      // o.CreateCar === 3:
      if (msg.messageType === 3) {
        if (msg.mountainVertices && !tap.mountainVertices) {
          tap.mountainVertices = msg.mountainVertices instanceof Float32Array
            ? new Float32Array(msg.mountainVertices)
            : new Float32Array(Array.from(msg.mountainVertices));
        }
        if (msg.mountainOffset && !tap.mountainOffset) {
          tap.mountainOffset = Object.assign({}, msg.mountainOffset);
        }
        if (typeof msg.trackData === 'string' && msg.trackData.length > 0) {
          if (msg.trackData !== tap.latestTrackData) {
            tap.latestTrackData = msg.trackData;
            tap.trackSignature = fnv1aHash36(msg.trackData);
            tap.trackLoadSeq += 1;
            tap.ghostRecordings = [];
          }
        }
        if (msg.carRecording == null) {
          tap.playerCarId = msg.carId >>> 0;
        } else if (typeof msg.carRecording === 'string' && msg.carRecording.length > 0) {
          const exists = tap.ghostRecordings.some((g) => g.carRecording === msg.carRecording);
          if (!exists && tap.ghostRecordings.length < 12) {
            tap.ghostRecordings.push({
              carId: msg.carId >>> 0,
              carRecording: msg.carRecording,
              trackSignature: tap.trackSignature
            });
            tap.ghostCaptureSeq += 1;
          }
        }
      } else if (msg.messageType === 6 || ('up' in msg && 'down' in msg)) {
        // o.ControlCar === 6
        tap.playerCarId = msg.carId >>> 0;
        tap.latestSentControls = {
          up: !!msg.up,
          right: !!msg.right,
          down: !!msg.down,
          left: !!msg.left,
          reset: !!msg.reset
        };
      }
    }
  }

  function attachWorkerMessageListener(worker) {
    if (!worker || worker.__polyPilotMsgAttached || worker.__polyPilotInternal) return;
    worker.__polyPilotMsgAttached = true;
    worker.addEventListener('message', (ev) => {
      try {
        if (worker.__polyPilotInternal || worker.__polyPilotIsRealtime === false) return;
        const data = ev.data;
        if (data && Array.isArray(data.carStateBuffers) && data.carStateBuffers.length > 0) {
          tap.workerHooked = true;
          const bufs = data.carStateBuffers;
          let matched = null;
          for (let b = bufs.length - 1; b >= 0; b--) {
            const decoded = decodeCarStateBuffer(bufs[b], tap.playerCarId);
            if (decoded) {
              matched = decoded;
              break;
            }
          }
          if (!matched && bufs.length === 1) {
            const bytes = new Uint8Array(bufs[0]);
            if (bytes.byteLength >= 44) {
              const cid = (bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24)) >>> 0;
              matched = decodeCarStateBuffer(bufs[0], cid);
            }
          }
          if (matched) {
            tap.latestCarState = matched;
            tap.latestCarStateAt = performance.now();
          }
        }
      } catch (_) {}
    });
  }

  if (typeof OrigWorker === 'function') {
    if (origProtoPostMessage) {
      OrigWorker.prototype.postMessage = function (msg, transfer) {
        try {
          if (!this.__polyPilotInternal && msg && typeof msg === 'object' && typeof msg.messageType === 'number') {
            attachWorkerMessageListener(this);
            handleSimWorkerPost(this, msg);
          }
        } catch (_) {}
        return arguments.length > 1
          ? origProtoPostMessage.call(this, msg, transfer)
          : origProtoPostMessage.call(this, msg);
      };
    }

    const WrappedWorker = function (scriptURL, options) {
      let resolvedURL = scriptURL;
      try {
        if (typeof scriptURL === 'string' && scriptURL.length > 0) {
          resolvedURL = (typeof window !== 'undefined' && window.location)
            ? new URL(scriptURL, window.location.href).href
            : scriptURL;
        } else if (scriptURL && typeof scriptURL.href === 'string') {
          resolvedURL = scriptURL.href;
        }
      } catch (_) {
        resolvedURL = scriptURL;
      }
      const worker = new OrigWorker(scriptURL, options);
      const urlStr = String(resolvedURL || scriptURL || '');
      if (urlStr.indexOf('simulation_worker') !== -1 || urlStr.indexOf('worker') !== -1 || urlStr.indexOf('blob:') === 0) {
        if (urlStr.indexOf('simulation_worker') !== -1 || !tap.workerScriptURL) {
          tap.workerScriptURL = resolvedURL;
          tap.workerOptions = options;
        }
        attachWorkerMessageListener(worker);
      }
      return worker;
    };
    WrappedWorker.prototype = OrigWorker.prototype;
    Object.setPrototypeOf(WrappedWorker, OrigWorker);
    window.Worker = WrappedWorker;
  }
})();
