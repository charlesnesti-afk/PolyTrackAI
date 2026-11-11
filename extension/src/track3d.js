(() => {
  'use strict';

  const PART_SIZE = 5.0;
  const GRID_CELL = 5.0;
  const NODE_STEP = 2.5;
  const SECTIONS_PER_CP = 8;
  const NUM_RAYS = 15;
  const RAY_ANGLES_DEG = [-68, -56, -45, -35, -26, -17, -8, 0, 8, 17, 26, 35, 45, 56, 68];
  const RAY_MAX_M = 72.0;
  const RAY_MIN_M = 2.0;
  const LOOKAHEAD_DISTS = [7.0, 14.0, 24.0, 38.0, 58.0];

  // Structural pillars & floating arrow/warning signs (never drivable surfaces)
  const PILLAR_SIGN_PARTS = new Set([
    19, 20, 21, 22, 23, 24, 45, 46, 47, 48,
    101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112, 113, 114, 115, 116,
    168, 169
  ]);

  // Scenery mountain/cliff/building blocks (not road asphalt)
  const SCENERY_BLOCK_PARTS = new Set([
    26, 27, 28, 29, 53, 54,
    68, 69, 70, 71, 72, 73,
    85, 86, 87, 88,
    130, 131, 132, 133,
    151, 152, 155,
    174, 175, 176, 177,
    188
  ]);

  // Drivable vertical loops, quarter-pipes & wall-rides (never treat as crash barriers!)
  const WALL_TRACK_PARTS = new Set([
    30, 31, 32,
    49, 50, 51,
    66, 67,
    79, 80, 81,
    90, 98,
    58, 59, 61, 62, 63, 64,
    138, 139, 140, 141, 142, 143, 144,
    153, 154, 156, 157, 158
  ]);

  // Exact PolyTrack Base62 lookup table Ra from simulation_worker.bundle.js
  const RA_TABLE = [
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    52, 53, 54, 55, 56, 57, 58, 59, 60, 61, -1, -1, -1, -1, -1, -1,
    -1, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17,
    18, 19, 20, 21, 22, 23, 24, 25, -1, -1, -1, -1, -1, -1, 26, 27,
    28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43,
    44, 45, 46, 47, 48, 49, 50, 51
  ];

  // Exact 6x4 rotationAxis x rotation quaternion table [qx, qy, qz, qw] from simulation_worker.bundle.js
  const S2 = Math.SQRT1_2;
  const EO_QUATS = [
    [[0, 0, 0, 1], [0, S2, 0, S2], [0, 1, 0, 0], [0, S2, 0, -S2]],
    [[0, 0, 1, 0], [S2, 0, S2, 0], [1, 0, 0, 0], [S2, 0, -S2, 0]],
    [[0, 0, -S2, S2], [0.5, 0.5, -0.5, 0.5], [S2, S2, 0, 0], [0.5, 0.5, 0.5, -0.5]],
    [[0, 0, S2, S2], [0.5, -0.5, 0.5, 0.5], [S2, -S2, 0, 0], [0.5, -0.5, -0.5, -0.5]],
    [[S2, 0, 0, S2], [0.5, 0.5, 0.5, 0.5], [0, S2, S2, 0], [-0.5, 0.5, 0.5, -0.5]],
    [[-S2, 0, 0, S2], [-0.5, -0.5, 0.5, 0.5], [0, -S2, S2, 0], [0.5, -0.5, 0.5, -0.5]]
  ];

  function clamp(v, lo, hi) {
    return v < lo ? lo : (v > hi ? hi : v);
  }

  function rotByQuat(vx, vy, vz, q) {
    const qx = q[0], qy = q[1], qz = q[2], qw = q[3];
    const tx = 2 * (qy * vz - qz * vy);
    const ty = 2 * (qz * vx - qx * vz);
    const tz = 2 * (qx * vy - qy * vx);
    return {
      x: vx + qw * tx + (qy * tz - qz * ty),
      y: vy + qw * ty + (qz * tx - qx * tz),
      z: vz + qw * tz + (qx * ty - qy * tx)
    };
  }

  function quatMul(a, b) {
    return [
      a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
      a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
      a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
      a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]
    ];
  }

  function packBitsOut(out, bitOffset, numBits, val, isLast) {
    const byteIdx = bitOffset >>> 3;
    while (byteIdx >= out.length) out.push(0);
    const shift = bitOffset - (byteIdx << 3);
    out[byteIdx] |= (val << shift) & 255;
    if (shift > 8 - numBits && !isLast) {
      const nextIdx = byteIdx + 1;
      if (nextIdx >= out.length) out.push(0);
      out[nextIdx] |= val >> (8 - shift);
    }
  }

  function decodePolyBase62(str) {
    if (typeof str !== 'string' || !str.length) return null;
    let bitPos = 0;
    const out = [];
    const len = str.length;
    for (let s = 0; s < len; s++) {
      const code = str.charCodeAt(s);
      if (code >= RA_TABLE.length) return null;
      const val = RA_TABLE[code];
      if (val === -1) return null;
      if (30 & ~val) {
        packBitsOut(out, bitPos, 6, val, s === len - 1);
        bitPos += 6;
      } else {
        packBitsOut(out, bitPos, 5, val, s === len - 1);
        bitPos += 5;
      }
    }
    return new Uint8Array(out);
  }

  async function inflateZlibBytes(compressedBytes) {
    const ds = new DecompressionStream('deflate');
    const writer = ds.writable.getWriter();
    writer.write(compressedBytes).catch(() => {});
    writer.close().catch(() => {});
    const reader = ds.readable.getReader();
    const chunks = [];
    let total = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) {
          chunks.push(value);
          total += value.byteLength;
        }
      }
    } catch (err) {
      if (total === 0) throw err;
    }
    const out = new Uint8Array(total);
    let off = 0;
    for (let i = 0; i < chunks.length; i++) {
      out.set(chunks[i], off);
      off += chunks[i].byteLength;
    }
    return out;
  }

  function readInt32LE(bytes, i) {
    return (bytes[i] | (bytes[i + 1] << 8) | (bytes[i + 2] << 16) | (bytes[i + 3] << 24)) | 0;
  }

  function parseTrackBinaryWithMode(bytes, partCatalog, packedRot) {
    let i = 0;
    if (!bytes || bytes.length < 15) return null;
    const environment = bytes[i++];
    const sunDir = bytes[i++];
    if (sunDir >= 180) return null;

    const minX = readInt32LE(bytes, i); i += 4;
    const minY = readInt32LE(bytes, i); i += 4;
    const minZ = readInt32LE(bytes, i); i += 4;

    const packSizes = bytes[i++];
    const hx = packSizes & 3;
    const hy = (packSizes >> 2) & 3;
    const hz = (packSizes >> 4) & 3;
    if (hx < 1 || hx > 4 || hy < 1 || hy > 4 || hz < 1 || hz > 4) return null;

    const minTail = packedRot ? 2 : 3;
    const placed = [];
    while (i < bytes.length) {
      let partId = bytes[i++];
      let extraPartId = null;
      if (!packedRot) {
        if (partId === 40) { partId = 4; extraPartId = 168; }
        else if (partId === 84) { partId = 4; extraPartId = 169; }
        else if (partId === 99) { partId = 35; extraPartId = 168; }
        else if (partId === 100) { partId = 35; extraPartId = 169; }
      }

      if (bytes.length - i < 4) return null;
      const count = readInt32LE(bytes, i); i += 4;
      if (count < 0 || count > 200000) return null;

      const meta = partCatalog.get(partId);
      if (!meta) return null;
      const isCp = !!(meta.detector && meta.detector.type === 0);
      const isStart = !!(meta.startOffset != null);

      for (let k = 0; k < count; k++) {
        if (bytes.length - i < hx + hy + hz + minTail) return null;
        let rx = 0;
        for (let b = 0; b < hx; b++) rx |= bytes[i + b] << (8 * b);
        rx = (rx + minX) | 0;
        i += hx;

        let ry = 0;
        for (let b = 0; b < hy; b++) ry |= bytes[i + b] << (8 * b);
        ry = (ry + minY) | 0;
        i += hy;

        let rz = 0;
        for (let b = 0; b < hz; b++) rz |= bytes[i + b] << (8 * b);
        rz = (rz + minZ) | 0;
        i += hz;

        let rotation, rotationAxis, color;
        if (packedRot) {
          const rotByte = bytes[i++];
          rotation = rotByte & 3;
          rotationAxis = (rotByte >> 2) & 7;
          color = bytes[i++];
        } else {
          rotation = bytes[i++];
          rotationAxis = bytes[i++];
          color = bytes[i++];
        }
        if (rotation > 3 || rotationAxis >= 6) return null;

        let checkpointOrder = null;
        if (isCp) {
          if (bytes.length - i < 2) return null;
          checkpointOrder = bytes[i] | (bytes[i + 1] << 8);
          i += 2;
        }

        let startOrder = null;
        if (isStart) {
          if (bytes.length - i < 4) return null;
          startOrder = readInt32LE(bytes, i);
          i += 4;
        }

        if (extraPartId !== null) {
          placed.push({
            partId: extraPartId,
            x: rx,
            y: ry,
            z: rz,
            rotation,
            rotationAxis,
            color,
            checkpointOrder: null,
            startOrder: null
          });
        }

        placed.push({
          partId,
          x: rx,
          y: ry,
          z: rz,
          rotation,
          rotationAxis,
          color,
          checkpointOrder,
          startOrder
        });
      }
    }

    return i === bytes.length ? { environment, sunDir, placed } : null;
  }

  function parseTrackBinary(bytes, partCatalog) {
    return parseTrackBinaryWithMode(bytes, partCatalog, true) || parseTrackBinaryWithMode(bytes, partCatalog, false);
  }

  function segmentsIntersect2D(ax, az, bx, bz, cx, cz, dx, dz, outU) {
    const rX = bx - ax, rZ = bz - az;
    const sX = dx - cx, sZ = dz - cz;
    const denom = rX * sZ - rZ * sX;
    if (Math.abs(denom) < 1e-8) return -1;
    const qpX = cx - ax, qpZ = cz - az;
    const t = (qpX * sZ - qpZ * sX) / denom;
    if (t < 0 || t > 1) return -1;
    const u = (qpX * rZ - qpZ * rX) / denom;
    if (u < 0 || u > 1) return -1;
    if (outU) outU[0] = u;
    return t;
  }

  function pointInTriXZAndY(px, pz, tri) {
    if (px < tri.minX || px > tri.maxX || pz < tri.minZ || pz > tri.maxZ) return null;
    const x0 = tri.x0, z0 = tri.z0;
    const v0x = tri.x2 - x0, v0z = tri.z2 - z0;
    const v1x = tri.x1 - x0, v1z = tri.z1 - z0;
    const v2x = px - x0, v2z = pz - z0;

    const den = v0x * v1z - v1x * v0z;
    if (Math.abs(den) < 1e-7) return null;
    const invDen = 1.0 / den;
    const u = (v2x * v1z - v1x * v2z) * invDen;
    if (u < -0.015 || u > 1.015) return null;
    const v = (v0x * v2z - v2x * v0z) * invDen;
    if (v < -0.015 || u + v > 1.015) return null;

    return tri.y0 + u * (tri.y2 - tri.y0) + v * (tri.y1 - tri.y0);
  }

  class MinHeap {
    constructor() {
      this.keys = [];
      this.vals = [];
    }
    get size() {
      return this.keys.length;
    }
    push(k, v) {
      const keys = this.keys, vals = this.vals;
      let idx = keys.length;
      keys.push(k);
      vals.push(v);
      while (idx > 0) {
        const p = (idx - 1) >> 1;
        if (keys[p] <= k) break;
        keys[idx] = keys[p];
        vals[idx] = vals[p];
        idx = p;
      }
      keys[idx] = k;
      vals[idx] = v;
    }
    pop() {
      const keys = this.keys, vals = this.vals;
      const topV = vals[0];
      const topK = keys[0];
      const lastK = keys.pop();
      const lastV = vals.pop();
      const n = keys.length;
      if (n > 0) {
        let idx = 0;
        while (true) {
          let l = (idx << 1) + 1;
          if (l >= n) break;
          let r = l + 1;
          let c = (r < n && keys[r] < keys[l]) ? r : l;
          if (lastK <= keys[c]) break;
          keys[idx] = keys[c];
          vals[idx] = vals[c];
          idx = c;
        }
        keys[idx] = lastK;
        vals[idx] = lastV;
      }
      return { cost: topK, node: topV };
    }
  }

  class Track3DAnalyzer {
    constructor() {
      this.ready = false;
      this.building = false;
      this.builtSeq = -1;
      this.roadGrid = new Map();
      this.wallGrid = new Map();
      this.checkpointsByOrder = new Map();
      this.totalCheckpoints = 0;
      this.finishes = [];
      this.startTransform = null;

      this.waypoints = [];
      this.totalLengthM = 0;
      this.finishArcS = 0;
      this.stageBounds = [];
      this.sectionEndS = new Float32Array(0);
      this.sectionsPerCp = SECTIONS_PER_CP;
      this.isCircuit = false;
      this.lastArcIndex = 0;
      this.lastArcS = 0;

      this.rays = new Float32Array(NUM_RAYS).fill(0.85);
      this.prevRays = new Float32Array(NUM_RAYS).fill(0.85);
      this.rayDeltas = new Float32Array(NUM_RAYS);
      this.rayWorldHits = new Array(NUM_RAYS);
      this.lookaheadAngles = new Float32Array(5);
      this.lookaheadCurvatures = new Float32Array(5);
      this.lookaheadPitch = 0;
      this.lateralOffsetNorm = 0;
      this.headingError = 0;
      this.corridorHalfWidth = 5.0;
      this.centerClearance = 0.85;
      this.turnBias3D = 0;

      this.rayAnglesRad = RAY_ANGLES_DEG.map((d) => (d * Math.PI) / 180);
    }

    resetEpisodeTracking() {
      this.lastArcIndex = 0;
      this.lastArcS = 0;
      this.prevRays.set(this.rays);
      this.rayDeltas.fill(0);
    }

    async ensureBuiltFromTap(tap) {
      if (!tap || !tap.latestTrackData || tap.partCatalog.size === 0) return false;
      if (this.attemptedSeq === tap.trackLoadSeq) return this.ready;
      if (this.building) return this.ready;

      this.building = true;
      const targetSeq = tap.trackLoadSeq;
      this.attemptedSeq = targetSeq;
      const trackDataStr = tap.latestTrackData;
      try {
        const b1 = decodePolyBase62(trackDataStr);
        if (!b1) return false;
        const inf1 = await inflateZlibBytes(b1);
        const innerStr = new TextDecoder('utf-8').decode(inf1);
        const b2 = decodePolyBase62(innerStr);
        if (!b2) return false;
        const rawBytes = await inflateZlibBytes(b2);
        const parsed = parseTrackBinary(rawBytes, tap.partCatalog);
        if (!parsed || !parsed.placed.length) return false;

        this._buildSpatialAndSpline(parsed.placed, tap.partCatalog, tap);
        this.builtSeq = targetSeq;
        this.ready = this.waypoints.length >= 4;
        return this.ready;
      } catch (_) {
        this.ready = false;
        return false;
      } finally {
        this.building = false;
      }
    }

    _cellKey(cx, cz) {
      return `${cx},${cz}`;
    }

    _insertRoadTri(tri) {
      const cx0 = Math.floor(tri.minX / GRID_CELL);
      const cx1 = Math.floor(tri.maxX / GRID_CELL);
      const cz0 = Math.floor(tri.minZ / GRID_CELL);
      const cz1 = Math.floor(tri.maxZ / GRID_CELL);
      for (let cx = cx0; cx <= cx1; cx++) {
        for (let cz = cz0; cz <= cz1; cz++) {
          const k = this._cellKey(cx, cz);
          let arr = this.roadGrid.get(k);
          if (!arr) {
            arr = [];
            this.roadGrid.set(k, arr);
          }
          arr.push(tri);
        }
      }
    }

    _insertWallSeg(seg) {
      const minX = Math.min(seg.ax, seg.bx);
      const maxX = Math.max(seg.ax, seg.bx);
      const minZ = Math.min(seg.az, seg.bz);
      const maxZ = Math.max(seg.az, seg.bz);
      const cx0 = Math.floor(minX / GRID_CELL);
      const cx1 = Math.floor(maxX / GRID_CELL);
      const cz0 = Math.floor(minZ / GRID_CELL);
      const cz1 = Math.floor(maxZ / GRID_CELL);
      for (let cx = cx0; cx <= cx1; cx++) {
        for (let cz = cz0; cz <= cz1; cz++) {
          const k = this._cellKey(cx, cz);
          let arr = this.wallGrid.get(k);
          if (!arr) {
            arr = [];
            this.wallGrid.set(k, arr);
          }
          arr.push(seg);
        }
      }
    }

    queryRoadSurfaceY(x, z, refY, maxDeltaY = 3.8) {
      const cx = Math.floor(x / GRID_CELL);
      const cz = Math.floor(z / GRID_CELL);
      const arr = this.roadGrid.get(this._cellKey(cx, cz));
      if (!arr) return null;

      let bestY = null;
      let bestDiff = maxDeltaY;
      for (let i = 0; i < arr.length; i++) {
        const tri = arr[i];
        if (refY != null && (tri.maxY < refY - maxDeltaY || tri.minY > refY + maxDeltaY)) continue;
        const y = pointInTriXZAndY(x, z, tri);
        if (y === null) continue;
        if (refY == null) {
          if (bestY === null || y > bestY) bestY = y;
        } else {
          const diff = Math.abs(y - refY);
          if (diff <= bestDiff) {
            bestDiff = diff;
            bestY = y;
          }
        }
      }
      return bestY;
    }

    segmentHitsWall(ax, az, bx, bz, ay, by = ay) {
      const cx0 = Math.floor(Math.min(ax, bx) / GRID_CELL);
      const cx1 = Math.floor(Math.max(ax, bx) / GRID_CELL);
      const cz0 = Math.floor(Math.min(az, bz) / GRID_CELL);
      const cz1 = Math.floor(Math.max(az, bz) / GRID_CELL);
      let minT = 2.0;
      const uRef = [0];
      for (let cx = cx0; cx <= cx1; cx++) {
        for (let cz = cz0; cz <= cz1; cz++) {
          const arr = this.wallGrid.get(this._cellKey(cx, cz));
          if (!arr) continue;
          for (let i = 0; i < arr.length; i++) {
            const w = arr[i];
            const t = segmentsIntersect2D(ax, az, bx, bz, w.ax, w.az, w.bx, w.bz, uRef);
            if (t < 0 || t >= minT) continue;
            const yAtHit = ay + t * (by - ay);
            if (w.maxY < yAtHit + 0.32 || w.minY > yAtHit + 2.0) continue;

            // Exact vertical slice [sliceMinY, sliceMaxY] of the 3D wall triangle at u along w.a -> w.b
            const u = uRef[0];
            let sliceMinY = Infinity;
            let sliceMaxY = -Infinity;
            const edgesU = [w.u0, w.u1, w.u1, w.u2, w.u2, w.u0];
            const edgesY = [w.y0, w.y1, w.y1, w.y2, w.y2, w.y0];
            for (let e = 0; e < 6; e += 2) {
              const ua = edgesU[e], ub = edgesU[e + 1];
              const ya = edgesY[e], yb = edgesY[e + 1];
              if (Math.abs(ub - ua) < 1e-4) {
                if (Math.abs(u - ua) < 0.02) {
                  if (ya < sliceMinY) sliceMinY = ya;
                  if (yb < sliceMinY) sliceMinY = yb;
                  if (ya > sliceMaxY) sliceMaxY = ya;
                  if (yb > sliceMaxY) sliceMaxY = yb;
                }
              } else if ((u >= ua - 0.01 && u <= ub + 0.01) || (u >= ub - 0.01 && u <= ua + 0.01)) {
                const frac = clamp((u - ua) / (ub - ua), 0.0, 1.0);
                const yCross = ya + frac * (yb - ya);
                if (yCross < sliceMinY) sliceMinY = yCross;
                if (yCross > sliceMaxY) sliceMaxY = yCross;
              }
            }
            if (sliceMaxY < yAtHit + 0.32 || sliceMinY > yAtHit + 2.0) continue;
            minT = t;
          }
        }
      }
      return minT <= 1.0 ? minT : -1;
    }

    _pointInDetectorOBB(px, py, pz, detBox, marginXZ = 1.2) {
      const dx = px - detBox.originX;
      const dy = py - detBox.originY;
      const dz = pz - detBox.originZ;
      // Rotate by conjugate of part quaternion
      const q = detBox.invQuat;
      const loc = rotByQuat(dx, dy, dz, q);
      return (
        Math.abs(loc.x - detBox.center.x) <= detBox.size.x * 0.5 + marginXZ &&
        Math.abs(loc.y - detBox.center.y) <= detBox.size.y * 0.5 + 3.0 &&
        Math.abs(loc.z - detBox.center.z) <= detBox.size.z * 0.5 + marginXZ
      );
    }

    _buildSpatialAndSpline(placed, partCatalog, tap) {
      this.roadGrid.clear();
      this.wallGrid.clear();
      this.checkpointsByOrder.clear();
      this.finishes = [];
      this.startTransform = null;
      this.waypoints = [];
      this.totalLengthM = 0;
      this.finishArcS = 0;
      this.stageBounds = [];
      this.sectionEndS = new Float32Array(0);

      let bestStartOrder = -Infinity;
      let chosenStart = null;
      let globalMinX = Infinity, globalMaxX = -Infinity;
      let globalMinZ = Infinity, globalMaxZ = -Infinity;
      const wallTrackSamples = [];

      for (let pIdx = 0; pIdx < placed.length; pIdx++) {
        const inst = placed[pIdx];
        const part = partCatalog.get(inst.partId);
        if (!part) continue;

        const q = EO_QUATS[inst.rotationAxis]?.[inst.rotation] || EO_QUATS[0][0];
        const invQ = [-q[0], -q[1], -q[2], q[3]];
        const ox = inst.x * PART_SIZE;
        const oy = inst.y * PART_SIZE;
        const oz = inst.z * PART_SIZE;

        if (part.startOffset && inst.startOrder != null && inst.startOrder >= bestStartOrder) {
          bestStartOrder = inst.startOrder;
          chosenStart = { inst, part, q, ox, oy, oz };
        }

        if (part.detector) {
          const wc = rotByQuat(part.detector.center.x, part.detector.center.y, part.detector.center.z, q);
          const box = {
            type: part.detector.type,
            checkpointOrder: inst.checkpointOrder,
            originX: ox,
            originY: oy,
            originZ: oz,
            worldX: ox + wc.x,
            worldY: oy + wc.y,
            worldZ: oz + wc.z,
            quat: q,
            invQuat: invQ,
            center: part.detector.center,
            size: part.detector.size
          };
          if (part.detector.type === 0 && inst.checkpointOrder != null) {
            let list = this.checkpointsByOrder.get(inst.checkpointOrder);
            if (!list) {
              list = [];
              this.checkpointsByOrder.set(inst.checkpointOrder, list);
            }
            list.push(box);
          } else if (part.detector.type === 1) {
            this.finishes.push(box);
          }
        }

        const isPillarOrSign = PILLAR_SIGN_PARTS.has(inst.partId);
        const isSceneryBlock = SCENERY_BLOCK_PARTS.has(inst.partId);
        const isWallTrack = !isPillarOrSign && WALL_TRACK_PARTS.has(inst.partId);
        const isRotatedTile = !isPillarOrSign && inst.rotationAxis >= 1 && !isSceneryBlock;

        const verts = part.vertices;
        if (part._localMinY === undefined) {
          let lMinY = Infinity, lMaxY = -Infinity;
          for (let k = 1; k < verts.length; k += 3) {
            if (verts[k] < lMinY) lMinY = verts[k];
            if (verts[k] > lMaxY) lMaxY = verts[k];
          }
          part._localMinY = Number.isFinite(lMinY) ? lMinY : 0;
          part._localMaxY = Number.isFinite(lMaxY) ? lMaxY : 0;
        }
        const isFlatBorderedOrArch = ((part._localMaxY - part._localMinY) < 1.25) || (part.detector != null);
        const maxAsphaltLocalY = part._localMinY + 0.34;

        let usedAnalyticWT = false;
        // Sample analytic 3D drivable surface + inward up-normals on vertical loops & wall-rides
        if (isWallTrack) {
          const xOffsets = [-7.5, -2.5, 0.0, 2.5, 7.5];
          const addWT = (lx, ly, lz, lnx, lny, lnz, clr) => {
            const wp = rotByQuat(lx, ly, lz, q);
            const wn = rotByQuat(lnx, lny, lnz, q);
            wallTrackSamples.push({
              x: ox + wp.x,
              y: oy + wp.y,
              z: oz + wp.z,
              upX: wn.x,
              upY: wn.y,
              upZ: wn.z,
              clearance: clr
            });
          };
          if (inst.partId === 31 || inst.partId === 50 || inst.partId === 80 || (inst.partId >= 58 && inst.partId <= 64 && inst.partId !== 60)) {
            usedAnalyticWT = true;
            // WallTrackMiddle: vertical 20m x 5m drivable wall at local Z = -9.75, inward normal +Z
            for (const lx of xOffsets) {
              const clr = 8.5 - Math.abs(lx) * 0.45;
              addWT(lx, 1.25, -9.75, 0, 0, 1, clr);
              addWT(lx, 3.75, -9.75, 0, 0, 1, clr);
            }
          } else if (inst.partId === 32 || inst.partId === 49 || inst.partId === 79 || inst.partId === 141 || inst.partId === 153) {
            usedAnalyticWT = true;
            // WallTrackBottom: R=19.8m quarter-pipe centered at (0, 20, 10)
            const degs = [12, 26, 40, 54, 68, 82];
            for (const deg of degs) {
              const th = (deg * Math.PI) / 180;
              const sT = Math.sin(th), cT = Math.cos(th);
              const ly = 20.0 - 19.75 * cT;
              const lz = 10.0 - 19.75 * sT;
              for (const lx of xOffsets) {
                const clr = (8.5 - Math.abs(lx) * 0.45) * (0.30 + 0.70 * (deg / 90.0));
                addWT(lx, ly, lz, 0, cT, sT, clr);
              }
            }
          } else if (inst.partId === 30 || inst.partId === 51 || inst.partId === 81 || inst.partId === 140 || inst.partId === 154) {
            usedAnalyticWT = true;
            // WallTrackTop: R=19.8m upper loop arch centered at (0, 0, 10)
            const degs = [8, 22, 36, 50, 64, 78, 88];
            for (const deg of degs) {
              const th = (deg * Math.PI) / 180;
              const sT = Math.sin(th), cT = Math.cos(th);
              const ly = 19.75 * sT;
              const lz = 10.0 - 19.75 * cT;
              for (const lx of xOffsets) {
                addWT(lx, ly, lz, 0, -sT, cT, 8.5 - Math.abs(lx) * 0.45);
              }
            }
          }
        }

        // Sample rotated road/plane/detector tiles (e.g. vertical wall-ride planes & finishes) or custom quarter-pipe meshes
        if ((isRotatedTile && !isWallTrack) || (isWallTrack && !usedAnalyticWT)) {
          for (let v = 0; v + 8 < verts.length; v += 9) {
            const lx0 = verts[v], ly0 = verts[v + 1], lz0 = verts[v + 2];
            const lx1 = verts[v + 3], ly1 = verts[v + 4], lz1 = verts[v + 5];
            const lx2 = verts[v + 6], ly2 = verts[v + 7], lz2 = verts[v + 8];
            const le1x = lx1 - lx0, le1y = ly1 - ly0, le1z = lz1 - lz0;
            const le2x = lx2 - lx0, le2y = ly2 - ly0, le2z = lz2 - lz0;
            const lnx = le1y * le2z - le1z * le2y;
            const lny = le1z * le2x - le1x * le2z;
            const lnz = le1x * le2y - le1y * le2x;
            const lLen = Math.hypot(lnx, lny, lnz);
            if (lLen < 0.25) continue; // area >= 0.125 m^2
            const uLny = lny / lLen;
            if (!isWallTrack) {
              if (uLny < 0.45) continue;
              if (isFlatBorderedOrArch && Math.max(ly0, ly1, ly2) > maxAsphaltLocalY) continue;
            } else {
              // Skip outer backfaces and thin side-rim skirts on curved wall-ride transition parts
              if (Math.abs(lnx / lLen) > 0.92 && Math.abs(lx0 - lx1) < 0.15 && Math.abs(lx1 - lx2) < 0.15) continue;
              if (uLny < -0.92 && Math.max(ly0, ly1, ly2) < 0.25) continue;
            }
            const wn = rotByQuat(lnx / lLen, uLny, lnz / lLen, q);
            const span = Math.max(
              Math.hypot(lx1 - lx0, ly1 - ly0, lz1 - lz0),
              Math.hypot(lx2 - lx1, ly2 - ly1, lz2 - lz1),
              Math.hypot(lx0 - lx2, ly0 - ly2, lz0 - lz2)
            );
            const steps = Math.max(1, Math.min(8, Math.ceil(span / 2.6)));
            for (let a = 0; a <= steps; a++) {
              for (let b = 0; b <= steps - a; b++) {
                const w0 = (a + 0.33) / (steps + 1.0);
                const w1 = (b + 0.33) / (steps + 1.0);
                const w2 = 1.0 - w0 - w1;
                if (w2 < -0.01) continue;
                const sx = lx0 * w0 + lx1 * w1 + lx2 * w2;
                const sy = ly0 * w0 + ly1 * w1 + ly2 * w2;
                const sz = lz0 * w0 + lz1 * w1 + lz2 * w2;
                const wp = rotByQuat(sx, sy, sz, q);
                wallTrackSamples.push({
                  x: ox + wp.x,
                  y: oy + wp.y,
                  z: oz + wp.z,
                  upX: wn.x,
                  upY: wn.y,
                  upZ: wn.z,
                  clearance: 6.5
                });
              }
            }
          }
        }

        for (let v = 0; v + 8 < verts.length; v += 9) {
          const p0 = rotByQuat(verts[v], verts[v + 1], verts[v + 2], q);
          const p1 = rotByQuat(verts[v + 3], verts[v + 4], verts[v + 5], q);
          const p2 = rotByQuat(verts[v + 6], verts[v + 7], verts[v + 8], q);

          const x0 = p0.x + ox, y0 = p0.y + oy, z0 = p0.z + oz;
          const x1 = p1.x + ox, y1 = p1.y + oy, z1 = p1.z + oz;
          const x2 = p2.x + ox, y2 = p2.y + oy, z2 = p2.z + oz;

          const e1x = x1 - x0, e1y = y1 - y0, e1z = z1 - z0;
          const e2x = x2 - x0, e2y = y2 - y0, e2z = z2 - z0;
          const nx = e1y * e2z - e1z * e2y;
          const ny = e1z * e2x - e1x * e2z;
          const nz = e1x * e2y - e1y * e2x;
          const nLen = Math.hypot(nx, ny, nz);
          if (nLen < 1e-5) continue;
          const unitNy = ny / nLen;

          const minX = Math.min(x0, x1, x2);
          const maxX = Math.max(x0, x1, x2);
          const minY = Math.min(y0, y1, y2);
          const maxY = Math.max(y0, y1, y2);
          const minZ = Math.min(z0, z1, z2);
          const maxZ = Math.max(z0, z1, z2);

          if (!isPillarOrSign && !isSceneryBlock && !isRotatedTile && unitNy > 0.36) {
            // Skip WallTrack parts so roadGrid only holds right-side-up standard road floors
            if (isWallTrack) continue;
            // Exclude raised concrete side-barrier top caps (~0.88m) & overhead detector arches (~4.91m) from roadGrid!
            if (isFlatBorderedOrArch && Math.max(verts[v + 1], verts[v + 4], verts[v + 7]) > maxAsphaltLocalY) continue;
            this._insertRoadTri({
              x0, y0, z0, x1, y1, z1, x2, y2, z2,
              ny: unitNy,
              minX, maxX, minY, maxY, minZ, maxZ
            });
            if (minX < globalMinX) globalMinX = minX;
            if (maxX > globalMaxX) globalMaxX = maxX;
            if (minZ < globalMinZ) globalMinZ = minZ;
            if (maxZ > globalMaxZ) globalMaxZ = maxZ;
          } else if (
            !isWallTrack && !isSceneryBlock && !isRotatedTile &&
            Math.abs(unitNy) <= 0.38 && (maxY - minY) >= 0.34
          ) {
            // Store longest horizontal edge of vertical wall face + exact 3D triangle (u, y) coordinates
            const d01 = (x1 - x0) * (x1 - x0) + (z1 - z0) * (z1 - z0);
            const d12 = (x2 - x1) * (x2 - x1) + (z2 - z1) * (z2 - z1);
            const d20 = (x0 - x2) * (x0 - x2) + (z0 - z2) * (z0 - z2);
            let ax = x0, ayE = y0, az = z0, bx = x1, byE = y1, bz = z1, cxW = x2, cyW = y2, czW = z2;
            let lenSq = d01;
            if (d12 >= d01 && d12 >= d20) {
              ax = x1; ayE = y1; az = z1; bx = x2; byE = y2; bz = z2; cxW = x0; cyW = y0; czW = z0;
              lenSq = d12;
            } else if (d20 >= d01 && d20 >= d12) {
              ax = x2; ayE = y2; az = z2; bx = x0; byE = y0; bz = z0; cxW = x1; cyW = y1; czW = z1;
              lenSq = d20;
            }
            if (lenSq > 0.08) {
              const uC = clamp(((cxW - ax) * (bx - ax) + (czW - az) * (bz - az)) / lenSq, 0.0, 1.0);
              const vertSpan = Math.abs(cyW - (ayE + uC * (byE - ayE)));
              // Skip thin ~0.21m under-road slab skirts on sloped tiles while keeping all >=0.34m barriers
              if (vertSpan >= 0.34) {
                this._insertWallSeg({
                  ax, az, bx, bz, minY, maxY,
                  u0: 0.0, y0: ayE,
                  u1: 1.0, y1: byE,
                  u2: uC, y2: cyW
                });
              }
            }
          }
        }
      }

      if (!chosenStart || !Number.isFinite(globalMinX)) return;

      // Start transform: io(rot, axis) * Euler(0, PI, 0)
      const startQ = quatMul(chosenStart.q, [0, 1, 0, 0]);
      const sOff = rotByQuat(chosenStart.part.startOffset.x, chosenStart.part.startOffset.y, chosenStart.part.startOffset.z, startQ);
      const startPos = {
        x: chosenStart.ox + sOff.x,
        y: chosenStart.oy + sOff.y,
        z: chosenStart.oz + sOff.z
      };

      const candPlusZ = rotByQuat(0, 0, 1, startQ);
      const candMinusZ = { x: -candPlusZ.x, y: -candPlusZ.y, z: -candPlusZ.z };
      const distPlus = this._probeRayDistance3D(startPos.x, startPos.y, startPos.z, candPlusZ.x, candPlusZ.z);
      const distMinus = this._probeRayDistance3D(startPos.x, startPos.y, startPos.z, candMinusZ.x, candMinusZ.z);
      const fwdSign = distPlus >= distMinus ? 1 : -1;
      tap._forwardSignZ = fwdSign;

      const startFwd = fwdSign === 1 ? candPlusZ : candMinusZ;
      this.startTransform = { position: startPos, quat: startQ, forward: startFwd };

      // Build 2.5m 3D Drivable Surface Graph aligned to exact multiples of 2.5m (0.0, +-2.5, +-5.0)
      // so nodes lie dead-center on PolyTrack's 5m road tiles!
      const nodes = [];
      const colBuckets = new Map(); // "gx,gz" -> [nodeIdx, ...]
      const seenCols = new Set();

      for (const cellKeyStr of this.roadGrid.keys()) {
        const comma = cellKeyStr.indexOf(',');
        const cx = parseInt(cellKeyStr.slice(0, comma), 10);
        const cz = parseInt(cellKeyStr.slice(comma + 1), 10);
        for (let subX = 0; subX <= 2; subX++) {
          const gx = cx * 2 + subX;
          const wx = gx * NODE_STEP;
          for (let subZ = 0; subZ <= 2; subZ++) {
            const gz = cz * 2 + subZ;
            const bKey = `${gx},${gz}`;
            if (seenCols.has(bKey)) continue;
            seenCols.add(bKey);

            const wz = gz * NODE_STEP;
            const qKey = this._cellKey(Math.floor(wx / GRID_CELL), Math.floor(wz / GRID_CELL));
            const cellTris = this.roadGrid.get(qKey);
            if (!cellTris) continue;

            const heights = [];
            for (let t = 0; t < cellTris.length; t++) {
              const y = pointInTriXZAndY(wx, wz, cellTris[t]);
              if (y !== null) heights.push(y);
            }
            if (!heights.length) continue;
            heights.sort((a, b) => a - b);

            const bucket = [];
            let lastY = -1e9;
            for (let h = 0; h < heights.length; h++) {
              const y = heights[h];
              if (y - lastY > 2.8) {
                const id = nodes.length;
                nodes.push({
                  id,
                  gx,
                  gz,
                  x: wx,
                  y,
                  z: wz,
                  upX: 0,
                  upY: 1,
                  upZ: 0,
                  isWallTrack: false,
                  clearance: 14.0,
                  adj: []
                });
                bucket.push(id);
                lastY = y;
              }
            }
            if (bucket.length) colBuckets.set(bKey, bucket);
          }
        }
      }

      // Insert analytic 3D WallTrack (vertical loop / half-pipe / wall-ride) nodes into colBuckets
      for (let wi = 0; wi < wallTrackSamples.length; wi++) {
        const ws = wallTrackSamples[wi];
        const gx = Math.round(ws.x / NODE_STEP);
        const gz = Math.round(ws.z / NODE_STEP);
        const bKey = `${gx},${gz}`;
        let bucket = colBuckets.get(bKey);
        if (!bucket) {
          bucket = [];
          colBuckets.set(bKey, bucket);
        }
        let dup = false;
        for (let b = 0; b < bucket.length; b++) {
          const ex = nodes[bucket[b]];
          if (Math.hypot(ex.x - ws.x, ex.y - ws.y, ex.z - ws.z) < 1.3) {
            dup = true;
            break;
          }
        }
        if (dup) continue;
        const id = nodes.length;
        nodes.push({
          id,
          gx,
          gz,
          x: ws.x,
          y: ws.y,
          z: ws.z,
          upX: ws.upX,
          upY: ws.upY,
          upZ: ws.upZ,
          isWallTrack: true,
          clearance: ws.clearance,
          adj: []
        });
        bucket.push(id);
      }

      if (nodes.length < 4) return;

      // Connect adjacent road & wall-track nodes + identify boundary nodes for clearance & ramp jumps
      const NBR_OFFSETS = [
        [0, 0],
        [1, 0], [-1, 0], [0, 1], [0, -1],
        [1, 1], [1, -1], [-1, 1], [-1, -1],
        [2, 0], [-2, 0], [0, 2], [0, -2],
        [2, 1], [2, -1], [-2, 1], [-2, -1], [1, 2], [-1, 2], [1, -2], [-1, -2]
      ];
      const boundaryNodes = [];

      for (let i = 0; i < nodes.length; i++) {
        const u = nodes[i];
        let immediateCardinals = 0;
        // Local tangent basis (t1, t2) on u's surface for 3D boundary detection (works on flat roads AND vertical walls!)
        const refX = Math.abs(u.upY) < 0.9 ? 0 : 1;
        const refY = Math.abs(u.upY) < 0.9 ? 1 : 0;
        let t1x = refY * u.upZ;
        let t1y = -refX * u.upZ;
        let t1z = refX * u.upY - refY * u.upX;
        const t1Len = Math.hypot(t1x, t1y, t1z) || 1.0;
        t1x /= t1Len; t1y /= t1Len; t1z /= t1Len;
        const t2x = u.upY * t1z - u.upZ * t1y;
        const t2y = u.upZ * t1x - u.upX * t1z;
        const t2z = u.upX * t1y - u.upY * t1x;
        let qPos1 = false, qNeg1 = false, qPos2 = false, qNeg2 = false;

        for (let d = 0; d < NBR_OFFSETS.length; d++) {
          const dxG = NBR_OFFSETS[d][0];
          const dzG = NBR_OFFSETS[d][1];
          const isSameCol = dxG === 0 && dzG === 0;
          if (isSameCol && !u.isWallTrack) continue;
          const maxGridSpan = (u.isWallTrack ? 2 : (Math.abs(dxG) <= 2 && Math.abs(dzG) <= 2 && (dxG === 0 || dzG === 0 || Math.abs(dxG) + Math.abs(dzG) <= 2) ? 2 : 0));
          if (!u.isWallTrack && maxGridSpan === 0) continue;

          const candIds = colBuckets.get(`${u.gx + dxG},${u.gz + dzG}`);
          if (!candIds) continue;

          for (let c = 0; c < candIds.length; c++) {
            const v = nodes[candIds[c]];
            if (v.id === u.id) continue;
            const wtEdge = u.isWallTrack || v.isWallTrack;
            if (isSameCol && !v.isWallTrack) continue;
            if (!wtEdge && Math.abs(dxG) + Math.abs(dzG) > 2) continue;

            const dx = v.x - u.x;
            const dy = v.y - u.y;
            const dz = v.z - u.z;
            const dXZ = Math.hypot(dx, dz);
            const d3 = Math.hypot(dXZ, dy);

            if (wtEdge) {
              if (d3 > 6.8) continue;
              // Require smooth surface normal continuity (< ~38deg per step) & tangent-plane step
              const nDot = u.upX * v.upX + u.upY * v.upY + u.upZ * v.upZ;
              if (nDot < 0.78) continue;
              const ax = u.upX + v.upX, ay = u.upY + v.upY, az = u.upZ + v.upZ;
              const aLen = Math.hypot(ax, ay, az) || 1.0;
              const normalStep = Math.abs((dx * ax + dy * ay + dz * az) / aLen);
              if (normalStep > 1.25) continue;
            } else {
              const maxRise = dXZ * 0.85 + 0.70;
              if (Math.abs(dy) > maxRise) continue;
              if (this.segmentHitsWall(u.x, u.z, v.x, v.z, u.y, v.y) >= 0) continue;
            }

            if (!isSameCol && Math.abs(dxG) + Math.abs(dzG) === 1) immediateCardinals += 1;
            if (d3 <= 5.8) {
              const p1 = dx * t1x + dy * t1y + dz * t1z;
              const p2 = dx * t2x + dy * t2y + dz * t2z;
              if (p1 > 1.1) qPos1 = true;
              if (p1 < -1.1) qNeg1 = true;
              if (p2 > 1.1) qPos2 = true;
              if (p2 < -1.1) qNeg2 = true;
            }
            u.adj.push({ to: v.id, dist: d3, isJump: false });
          }
        }
        if (u.isWallTrack) {
          if (!(qPos1 && qNeg1 && qPos2 && qNeg2)) {
            u.clearance = 1.0;
            boundaryNodes.push(u.id);
          } else {
            u.clearance = Math.min(u.clearance || 14.0, 14.0);
          }
        } else if (immediateCardinals < 4) {
          u.clearance = 0.5;
          boundaryNodes.push(u.id);
        }
      }

      // Fast BFS distance transform (up to ~12.5m) from road edges/walls so center of road/wide-plane has high clearance!
      const bfsQ = boundaryNodes.slice();
      let qHead = 0;
      while (qHead < bfsQ.length) {
        const uid = bfsQ[qHead++];
        const u = nodes[uid];
        if (u.clearance >= 12.5) continue;
        for (let k = 0; k < u.adj.length; k++) {
          const edge = u.adj[k];
          const v = nodes[edge.to];
          const candClr = u.clearance + edge.dist;
          if (candClr < v.clearance) {
            v.clearance = candClr;
            bfsQ.push(v.id);
          }
        }
      }

      // Add ballistic jump edges from boundary ramp lips across gaps (6m .. 105m)
      // High jump cost (3.8x + 45m) guarantees Dijkstra always follows connected asphalt when available,
      // and only uses ballistic jumps across genuine track gaps!
      if (boundaryNodes.length < 40000) {
        for (let bi = 0; bi < boundaryNodes.length; bi++) {
          const u = nodes[boundaryNodes[bi]];
          if (u.isWallTrack) continue;
          // Estimate outward lip direction pointing away from interior neighbors
          let inX = 0, inZ = 0, inY = 0, cnt = 0;
          for (let k = 0; k < u.adj.length; k++) {
            const nb = nodes[u.adj[k].to];
            const d = Math.hypot(nb.x - u.x, nb.z - u.z);
            if (d > 0.1 && d < 3.8) {
              inX += (u.x - nb.x) / d;
              inZ += (u.z - nb.z) / d;
              inY += (u.y - nb.y) / d;
              cnt++;
            }
          }
          if (cnt === 0) continue;
          const outLen = Math.hypot(inX, inZ);
          if (outLen < 0.35) continue;
          const dirX = inX / outLen;
          const dirZ = inZ / outLen;
          let slopeSum = 0, slopeCnt = 0;
          for (let k = 0; k < u.adj.length; k++) {
            const nb = nodes[u.adj[k].to];
            const dot = (u.x - nb.x) * dirX + (u.z - nb.z) * dirZ;
            if (dot > 0.5) {
              slopeSum += (u.y - nb.y) / dot;
              slopeCnt++;
            }
          }
          const lipSlopeY = slopeCnt > 0 ? clamp(slopeSum / slopeCnt, -0.35, 1.05) : clamp(inY / cnt, -0.35, 1.05);

          // CRITICAL: Never launch ballistic jump edges through a side barrier wall!
          if (this.segmentHitsWall(u.x, u.z, u.x + dirX * 3.6, u.z + dirZ * 3.6, u.y, u.y + lipSlopeY * 3.6) >= 0) {
            continue;
          }

          // Probe landing points along the open launch lip ray
          for (let dist = 7.5; dist <= 240.0; dist += 3.5) {
            const lx = u.x + dirX * dist;
            const lz = u.z + dirZ * dist;
            const lgx = Math.round(lx / NODE_STEP);
            const lgz = Math.round(lz / NODE_STEP);
            const cands = colBuckets.get(`${lgx},${lgz}`);
            if (!cands) continue;

            const maxBallisticY = u.y + Math.max(0, lipSlopeY) * dist + 3.0 - 0.0008 * dist * dist;
            for (let c = 0; c < cands.length; c++) {
              const v = nodes[cands[c]];
              if (v.isWallTrack) continue;
              if (v.y <= maxBallisticY && v.y >= u.y - 68.0) {
                const d3 = Math.hypot(v.x - u.x, v.y - u.y, v.z - u.z);
                u.adj.push({ to: v.id, dist: d3 * 4.2 + 55.0, isJump: true });
              }
            }
          }
        }
      }

      // Locate Start node (3m ahead of startPos so circuit start/finish never short-circuits backward)
      const launchX = startPos.x + startFwd.x * 3.0;
      const launchZ = startPos.z + startFwd.z * 3.0;
      let startNodeId = this._findNearestNode(nodes, launchX, startPos.y, launchZ);
      if (startNodeId < 0) return;

      const cpOrders = Array.from(this.checkpointsByOrder.keys()).sort((a, b) => a - b);
      this.totalCheckpoints = cpOrders.length;

      // Build target node sets for each stage: CP 0, CP 1, ..., Finish
      const stageTargetSets = [];
      for (let cIdx = 0; cIdx < cpOrders.length; cIdx++) {
        const boxes = this.checkpointsByOrder.get(cpOrders[cIdx]) || [];
        const tSet = new Set();
        for (let i = 0; i < nodes.length; i++) {
          const nd = nodes[i];
          for (let b = 0; b < boxes.length; b++) {
            if (this._pointInDetectorOBB(nd.x, nd.y, nd.z, boxes[b], 1.4)) {
              tSet.add(nd.id);
              break;
            }
          }
        }
        if (tSet.size === 0 && boxes.length > 0) {
          const near = this._findNearestNode(nodes, boxes[0].worldX, boxes[0].worldY, boxes[0].worldZ);
          if (near >= 0) tSet.add(near);
        }
        if (tSet.size > 0) stageTargetSets.push({ stageCp: cIdx, targets: tSet });
      }

      if (this.finishes.length > 0) {
        const fSet = new Set();
        for (let i = 0; i < nodes.length; i++) {
          const nd = nodes[i];
          for (let b = 0; b < this.finishes.length; b++) {
            if (this._pointInDetectorOBB(nd.x, nd.y, nd.z, this.finishes[b], 1.4)) {
              fSet.add(nd.id);
              break;
            }
          }
        }
        if (fSet.size === 0) {
          const near = this._findNearestNode(nodes, this.finishes[0].worldX, this.finishes[0].worldY, this.finishes[0].worldZ);
          if (near >= 0) fSet.add(near);
        }
        if (fSet.size > 0) stageTargetSets.push({ stageCp: cpOrders.length, targets: fSet });
      }

      // Chain Dijkstra across all stages!
      const rawPath = [{
        x: startPos.x,
        y: startPos.y,
        z: startPos.z,
        upX: 0,
        upY: 1,
        upZ: 0,
        isWallTrack: false,
        stageCp: 0,
        clearance: 4.5
      }];
      let curNodeId = startNodeId;
      let curDir = { x: startFwd.x, y: startFwd.y || 0, z: startFwd.z };

      for (let st = 0; st < stageTargetSets.length; st++) {
        const { stageCp, targets } = stageTargetSets[st];
        const segIds = this._dijkstraSegment(nodes, curNodeId, targets, curDir);
        if (!segIds || segIds.length === 0) continue;

        for (let k = (st === 0 ? 0 : 1); k < segIds.length; k++) {
          const nd = nodes[segIds[k]];
          let nearJump = false;
          if (k > 0) {
            const prevNd = nodes[segIds[k - 1]];
            const eJump = prevNd.adj.find((e) => e.to === nd.id && e.isJump);
            if (eJump) nearJump = true;
          }
          if (k + 1 < segIds.length) {
            const nextNd = nodes[segIds[k + 1]];
            const eJumpNext = nd.adj.find((e) => e.to === nextNd.id && e.isJump);
            if (eJumpNext) nearJump = true;
          }
          rawPath.push({
            x: nd.x,
            y: nd.y,
            z: nd.z,
            upX: nd.upX,
            upY: nd.upY,
            upZ: nd.upZ,
            isWallTrack: !!nd.isWallTrack,
            isDetectorAnchor: k === segIds.length - 1 || nearJump,
            stageCp,
            clearance: nd.clearance
          });
        }

        if (segIds.length >= 2) {
          const prevNd = nodes[segIds[segIds.length - 2]];
          const lastNd = nodes[segIds[segIds.length - 1]];
          const dx = lastNd.x - prevNd.x;
          const dy = lastNd.y - prevNd.y;
          const dz = lastNd.z - prevNd.z;
          const dl = Math.hypot(dx, dy, dz) || 1.0;
          curDir = { x: dx / dl, y: dy / dl, z: dz / dl };
        }
        curNodeId = segIds[segIds.length - 1];
      }

      // Extend 14m straight past Finish so the AI drives full-speed across the finish line!
      const numStages = stageTargetSets.length;
      if (rawPath.length >= 2) {
        const last = rawPath[rawPath.length - 1];
        for (let ext = 1; ext <= 4; ext++) {
          rawPath.push({
            x: last.x + curDir.x * (ext * 3.5),
            y: last.y + ( curDir.y || 0 ) * (ext * 3.5),
            z: last.z + curDir.z * (ext * 3.5),
            upX: last.upX ?? 0,
            upY: last.upY ?? 1,
            upZ: last.upZ ?? 0,
            isWallTrack: false,
            stageCp: last.stageCp,
            isFinishExt: true,
            clearance: last.clearance
          });
        }
      }

      this._finalizeSmoothSpline(rawPath, numStages);
    }

    _findNearestNode(nodes, x, y, z) {
      let bestId = -1;
      let bestScore = Infinity;
      for (let i = 0; i < nodes.length; i++) {
        const nd = nodes[i];
        const dy = Math.abs(nd.y - y);
        if (dy > 8.0) continue;
        const dSq = (nd.x - x) * (nd.x - x) + (nd.z - z) * (nd.z - z) + dy * dy * 4.0;
        if (dSq < bestScore) {
          bestScore = dSq;
          bestId = i;
        }
      }
      if (bestId < 0) {
        for (let i = 0; i < nodes.length; i++) {
          const nd = nodes[i];
          const dy = Math.abs(nd.y - y);
          const dSq = (nd.x - x) * (nd.x - x) + (nd.z - z) * (nd.z - z) + dy * dy * 2.5;
          if (dSq < bestScore) {
            bestScore = dSq;
            bestId = i;
          }
        }
      }
      return bestId;
    }

    _dijkstraSegment(nodes, startId, targetSet, initialDirXZ) {
      const N = nodes.length;
      const dist = new Float64Array(N);
      dist.fill(Infinity);
      const parent = new Int32Array(N);
      parent.fill(-1);

      const heap = new MinHeap();
      dist[startId] = 0;
      heap.push(0, startId);

      let reachedId = -1;
      while (heap.size > 0) {
        const { cost, node: uId } = heap.pop();
        if (cost > dist[uId] + 1e-6) continue;
        if (targetSet.has(uId) && uId !== startId) {
          reachedId = uId;
          break;
        }
        const u = nodes[uId];
        for (let k = 0; k < u.adj.length; k++) {
          const edge = u.adj[k];
          const v = nodes[edge.to];
          let stepCost;
          if (v.isWallTrack) {
            stepCost = edge.dist * (1.0 + 2.35 / Math.max(1.0, Math.min(9.5, v.clearance))) * 0.65;
          } else {
            const effClr = Math.max(1.0, Math.min(8.2, v.clearance));
            stepCost = edge.dist * (1.0 + 2.20 / effClr);
            if (v.clearance < 1.95) {
              stepCost += edge.dist * (1.95 - v.clearance) * 3.5;
            }
          }

          // Prevent reversing backward at segment start
          if (uId === startId && initialDirXZ) {
            const dx = v.x - u.x;
            const dz = v.z - u.z;
            const dl = Math.hypot(dx, dz) || 1.0;
            const dot = (dx * initialDirXZ.x + dz * initialDirXZ.z) / dl;
            if (dot < -0.15) stepCost += 80.0;
          }

          const nextCost = cost + stepCost;
          if (nextCost < dist[v.id]) {
            dist[v.id] = nextCost;
            parent[v.id] = uId;
            heap.push(nextCost, v.id);
          }
        }
      }

      if (reachedId < 0) return null;
      const out = [];
      let cur = reachedId;
      while (cur !== -1) {
        out.push(cur);
        cur = parent[cur];
      }
      out.reverse();
      return out;
    }

    _finalizeSmoothSpline(rawPath, numStages = 1) {
      if (rawPath.length < 2) return;

      // 1. Uniform 2.5m resampling
      const resampled = [{ ...rawPath[0] }];
      let acc = 0;
      const stepM = 2.5;
      for (let i = 1; i < rawPath.length; i++) {
        const p0 = rawPath[i - 1];
        const p1 = rawPath[i];
        const segLen = Math.hypot(p1.x - p0.x, p1.y - p0.y, p1.z - p0.z);
        if (segLen < 1e-3) continue;
        let pos = stepM - acc;
        while (pos <= segLen) {
          const t = pos / segLen;
          const upX0 = p0.upX ?? 0, upY0 = p0.upY ?? 1, upZ0 = p0.upZ ?? 0;
          const upX1 = p1.upX ?? 0, upY1 = p1.upY ?? 1, upZ1 = p1.upZ ?? 0;
          let ux = upX0 + (upX1 - upX0) * t;
          let uy = upY0 + (upY1 - upY0) * t;
          let uz = upZ0 + (upZ1 - upZ0) * t;
          const uLen = Math.hypot(ux, uy, uz) || 1.0;
          resampled.push({
            x: p0.x + (p1.x - p0.x) * t,
            y: p0.y + (p1.y - p0.y) * t,
            z: p0.z + (p1.z - p0.z) * t,
            upX: ux / uLen,
            upY: uy / uLen,
            upZ: uz / uLen,
            isWallTrack: !!(p0.isWallTrack || p1.isWallTrack),
            isDetectorAnchor: (t < 0.35 && !!p0.isDetectorAnchor) || (t > 0.65 && !!p1.isDetectorAnchor),
            stageCp: t < 0.5 ? p0.stageCp : p1.stageCp,
            isFinishExt: !!(p0.isFinishExt || (t > 0.25 && p1.isFinishExt)),
            clearance: p0.clearance + (p1.clearance - p0.clearance) * t
          });
          pos += stepM;
        }
        acc = segLen - (pos - stepM);
      }

      const M = resampled.length;
      if (M < 4) return;

      // 2. Minimum-curvature elastic-band racing-line relaxation (outside-inside-outside apex line
      // across wide Plane & corner sections, constrained by 8-way wall/cliff safety halo & detector anchors)
      const origX = resampled.map((p) => p.x);
      const origZ = resampled.map((p) => p.z);
      const HALO_DIRS = [
        [1, 0], [-1, 0], [0, 1], [0, -1],
        [0.7071, 0.7071], [0.7071, -0.7071], [-0.7071, 0.7071], [-0.7071, -0.7071]
      ];
      for (let iter = 0; iter < 32; iter++) {
        for (let i = 2; i < M - 4; i++) {
          const pPrev = resampled[i - 1];
          const pCur = resampled[i];
          const pNext = resampled[i + 1];
          if (pCur.isWallTrack) {
            if (iter < 16) {
              // Smooth WallTrack along 3D arc to eliminate jagged kinks while keeping exact centered loop line
              pCur.x = pCur.x * 0.52 + (pPrev.x + pNext.x) * 0.24;
              pCur.y = pCur.y * 0.52 + (pPrev.y + pNext.y) * 0.24;
              pCur.z = pCur.z * 0.52 + (pPrev.z + pNext.z) * 0.24;
            }
            continue;
          }
          if (pPrev.isWallTrack || pNext.isWallTrack) continue;

          const candX = pCur.x * 0.50 + (pPrev.x + pNext.x) * 0.25;
          const candZ = pCur.z * 0.50 + (pPrev.z + pNext.z) * 0.25;

          const isSteepSlope = Math.abs(pNext.y - pPrev.y) > 0.85;
          const maxShift = pCur.isDetectorAnchor
            ? 0.85
            : isSteepSlope
              ? Math.max(0.35, Math.min(1.6, pCur.clearance - 2.4))
              : Math.max(0.35, Math.min(5.2, pCur.clearance - 3.65));
          const dxOrig = candX - origX[i];
          const dzOrig = candZ - origZ[i];
          const dOrig = Math.hypot(dxOrig, dzOrig);
          let nx = candX, nz = candZ;
          if (dOrig > maxShift) {
            nx = origX[i] + (dxOrig / dOrig) * maxShift;
            nz = origZ[i] + (dzOrig / dOrig) * maxShift;
          }

          const surfY = this.queryRoadSurfaceY(nx, nz, pCur.y, 1.8);
          if (surfY === null || this.segmentHitsWall(pCur.x, pCur.z, nx, nz, pCur.y, surfY) >= 0) {
            continue;
          }

          let haloSafe = true;
          if (dOrig > 0.75) {
            for (let h = 0; h < 8; h++) {
              const hx = nx + HALO_DIRS[h][0] * 3.55;
              const hz = nz + HALO_DIRS[h][1] * 3.55;
              if (this.segmentHitsWall(nx, nz, hx, hz, surfY, surfY) >= 0) {
                haloSafe = false;
                break;
              }
              const sx = nx + HALO_DIRS[h][0] * 3.25;
              const sz = nz + HALO_DIRS[h][1] * 3.25;
              if (this.queryRoadSurfaceY(sx, sz, surfY, 2.0) === null) {
                haloSafe = false;
                break;
              }
            }
          }

          if (haloSafe) {
            pCur.x = nx;
            pCur.z = nz;
            pCur.y = pCur.y * 0.35 + surfY * 0.65;
          }
        }
      }

      for (let i = 0; i < M; i++) {
        if (!resampled[i].isWallTrack) {
          const moved = Math.hypot(resampled[i].x - origX[i], resampled[i].z - origZ[i]);
          resampled[i].clearance = Math.max(2.25, resampled[i].clearance - moved * 0.55);
        }
      }

      // 3. Compute arc-length s, 3D tangents, signed horizontal curvature (+ = RIGHT), and pitch slope
      let s = 0;
      let finishArcS = 0;
      for (let i = 0; i < M; i++) {
        if (i > 0) {
          s += Math.hypot(
            resampled[i].x - resampled[i - 1].x,
            resampled[i].y - resampled[i - 1].y,
            resampled[i].z - resampled[i - 1].z
          );
        }
        resampled[i].s = s;
        if (!resampled[i].isFinishExt) {
          finishArcS = s;
        }
      }
      this.totalLengthM = s;
      this.finishArcS = finishArcS > 5.0 ? finishArcS : s;

      for (let i = 0; i < M; i++) {
        const i0 = Math.max(0, i - 1);
        const i1 = Math.min(M - 1, i + 1);
        const dx = resampled[i1].x - resampled[i0].x;
        const dy = resampled[i1].y - resampled[i0].y;
        const dz = resampled[i1].z - resampled[i0].z;
        const len = Math.hypot(dx, dy, dz) || 1.0;
        resampled[i].tx = dx / len;
        resampled[i].ty = dy / len;
        resampled[i].tz = dz / len;
      }

      for (let i = 0; i < M; i++) {
        const iBack = Math.max(0, i - 2);
        const iFwd = Math.min(M - 1, i + 2);
        const ds = Math.max(1.0, resampled[iFwd].s - resampled[iBack].s);

        let nearWallTrack = false;
        for (let k = Math.max(0, i - 6); k <= Math.min(M - 1, i + 6); k++) {
          if (resampled[k].isWallTrack) {
            nearWallTrack = true;
            break;
          }
        }

        if (nearWallTrack) {
          const b0 = resampled[iBack];
          const b1 = resampled[iFwd];
          const upX = resampled[i].upX ?? 0, upY = resampled[i].upY ?? 1, upZ = resampled[i].upZ ?? 0;
          let rx = b0.ty * upZ - b0.tz * upY;
          let ry = b0.tz * upX - b0.tx * upZ;
          let rz = b0.tx * upY - b0.ty * upX;
          const rLen = Math.hypot(rx, ry, rz) || 1.0;
          rx /= rLen; ry /= rLen; rz /= rLen;
          const sin3D = b1.tx * rx + b1.ty * ry + b1.tz * rz;
          const cos3D = clamp(b0.tx * b1.tx + b0.ty * b1.ty + b0.tz * b1.tz, -1.0, 1.0);
          const curv3D = (Math.atan2(sin3D, cos3D) / ds) * 0.5;
          resampled[i].curvature = curv3D;
          resampled[i].effectiveAbsCurv = Math.abs(curv3D);
          resampled[i].pitchRate = 0.0;
          continue;
        }

        const t0x = resampled[iBack].tx, t0z = resampled[iBack].tz;
        const t1x = resampled[iFwd].tx, t1z = resampled[iFwd].tz;
        // Right vector in XZ plane when Y is up: right = cross(t0, up) = (-t0z, 0, t0x)
        const rightX = -t0z;
        const rightZ = t0x;
        const cosH = clamp(t0x * t1x + t0z * t1z, -1.0, 1.0);
        const sinH = t1x * rightX + t1z * rightZ;
        const dHeadingSigned = Math.atan2(sinH, cosH);
        const curv10 = dHeadingSigned / ds;

        // Multi-scale 22m chord curvature so sustained 90deg/180deg corners are never underestimated
        const iBackW = Math.max(0, i - 4);
        const iFwdW = Math.min(M - 1, i + 4);
        const dsW = Math.max(1.0, resampled[iFwdW].s - resampled[iBackW].s);
        const tw0x = resampled[iBackW].tx, tw0z = resampled[iBackW].tz;
        const tw1x = resampled[iFwdW].tx, tw1z = resampled[iFwdW].tz;
        const cosHW = clamp(tw0x * tw1x + tw0z * tw1z, -1.0, 1.0);
        const sinHW = tw1x * (-tw0z) + tw1z * tw0x;
        const curv22 = Math.atan2(sinHW, cosHW) / dsW;

        resampled[i].curvature = curv10; // [rad / meter], >0 means right turn!
        resampled[i].effectiveAbsCurv = Math.max(Math.abs(curv10), Math.abs(curv22) * 1.12);
        resampled[i].pitchRate = (resampled[iFwd].ty - resampled[iBack].ty) / ds;
      }

      // 4. Build exact 8-sections-per-checkpoint boundaries along the spline!
      const stageCount = Math.max(1, numStages);
      const stageEndS = new Float32Array(stageCount);
      let lastStageSeen = 0;
      for (let i = 0; i < M; i++) {
        if (resampled[i].isFinishExt) break;
        const st = clamp(resampled[i].stageCp || 0, 0, stageCount - 1);
        for (let c = lastStageSeen; c <= st; c++) {
          stageEndS[c] = resampled[i].s;
        }
        lastStageSeen = st;
      }
      stageEndS[stageCount - 1] = this.finishArcS;
      // Ensure strictly increasing stage boundaries even if a stage was short
      for (let st = 0; st < stageCount; st++) {
        const prevEnd = st === 0 ? 0 : stageEndS[st - 1];
        if (stageEndS[st] <= prevEnd + 1.0) {
          stageEndS[st] = prevEnd + Math.max(8.0, (this.finishArcS - prevEnd) / (stageCount - st));
        }
      }

      this.stageBounds = [];
      const totalSecs = stageCount * SECTIONS_PER_CP;
      this.sectionEndS = new Float32Array(totalSecs);
      for (let st = 0; st < stageCount; st++) {
        const sStart = st === 0 ? 0.0 : stageEndS[st - 1];
        const sEnd = stageEndS[st];
        this.stageBounds.push({ stageIdx: st, startS: sStart, endS: sEnd });
        for (let sub = 0; sub < SECTIONS_PER_CP; sub++) {
          this.sectionEndS[st * SECTIONS_PER_CP + sub] = sStart + (sEnd - sStart) * ((sub + 1) / SECTIONS_PER_CP);
        }
      }

      this.waypoints = resampled;
      this.lastArcIndex = 0;
      this.lastArcS = 0;
    }

    /**
     * Return 8-sections-per-checkpoint descriptor for any spline arc-length s.
     */
    getSectionInfo(arcS = this.lastArcS) {
      const n = this.sectionEndS.length;
      if (n === 0) {
        return { sectionIdx: 0, subIdxInCp: 0, cpStage: 0, totalSections: SECTIONS_PER_CP, sectionEndS: 20.0 };
      }
      let idx = 0;
      while (idx + 1 < n && arcS >= this.sectionEndS[idx]) {
        idx++;
      }
      return {
        sectionIdx: idx,
        subIdxInCp: idx % SECTIONS_PER_CP,
        cpStage: Math.floor(idx / SECTIONS_PER_CP),
        totalSections: n,
        sectionEndS: this.sectionEndS[idx]
      };
    }

    _probeRayDistance3D(ox, oy, oz, dirX, dirZ, allowForwardDrop = false) {
      const horizLen = Math.hypot(dirX, dirZ);
      if (horizLen < 1e-4) return RAY_MIN_M;
      const ux = dirX / horizLen;
      const uz = dirZ / horizLen;

      let curY = this.queryRoadSurfaceY(ox, oz, oy, 4.5) ?? oy;
      let prevX = ox;
      let prevZ = oz;
      const step = 2.5;
      let missCount = 0;
      const maxGapSteps = allowForwardDrop ? 30 : 1;

      for (let d = step; d <= RAY_MAX_M; d += step) {
        const nx = ox + ux * d;
        const nz = oz + uz * d;

        const wallT = this.segmentHitsWall(prevX, prevZ, nx, nz, curY);
        if (wallT >= 0) {
          return Math.max(RAY_MIN_M, d - step + wallT * step);
        }

        let surfY = this.queryRoadSurfaceY(nx, nz, curY, step * 1.45 + 1.8);
        if (surfY === null && allowForwardDrop) {
          const dropY = this.queryRoadSurfaceY(nx, nz, null);
          if (dropY !== null && dropY <= curY + 14.0 && dropY >= curY - 68.0) {
            surfY = dropY;
          }
        }

        if (surfY === null) {
          missCount += 1;
          if (missCount >= maxGapSteps) {
            const firstMissD = d - (missCount - 1) * step;
            const midX = ox + ux * (firstMissD - step * 0.5);
            const midZ = oz + uz * (firstMissD - step * 0.5);
            const midSurf = this.queryRoadSurfaceY(midX, midZ, curY, step * 1.1 + 1.4);
            return Math.max(RAY_MIN_M, midSurf !== null ? (firstMissD - step * 0.45) : (firstMissD - step * 0.9));
          }
        } else {
          missCount = 0;
          curY = surfY;
        }
        prevX = nx;
        prevZ = nz;
      }

      return RAY_MAX_M;
    }

    /**
     * Update live 3D LIDAR rays, racing-line lookahead, and arc-length progress s in <0.15ms.
     */
    update(telemetry) {
      if (!this.ready || !telemetry.position || !telemetry.forward || !telemetry.right) {
        return false;
      }

      const pos = telemetry.position;
      const fwd = telemetry.forward;
      const right = telemetry.right;

      // 1. Cast 15 local-frame 3D surface/wall/cliff rays
      this.prevRays.set(this.rays);
      let leftW = 0;
      let rightW = 0;

      for (let r = 0; r < NUM_RAYS; r++) {
        const ang = this.rayAnglesRad[r];
        const c = Math.cos(ang);
        const s = Math.sin(ang);
        const dirX = fwd.x * c + right.x * s;
        const dirZ = fwd.z * c + right.z * s;

        const distM = this._probeRayDistance3D(pos.x, pos.y, pos.z, dirX, dirZ, r >= 6 && r <= 8);
        const norm = clamp((distM - RAY_MIN_M) / (RAY_MAX_M - RAY_MIN_M), 0.0, 1.0);
        this.rays[r] = norm;
        this.rayDeltas[r] = norm - this.prevRays[r];
        this.rayWorldHits[r] = { distM, ang };

        const w = 1.15 - 0.35 * Math.abs((r - 7) / 7.0);
        if (r < 7) leftW += norm * w;
        else if (r > 7) rightW += norm * w;
      }

      this.centerClearance = (this.rays[6] + this.rays[7] + this.rays[8]) / 3.0;
      this.turnBias3D = clamp((rightW - leftW) / 2.1, -1.5, 1.5);

      // 2. Match car position to active checkpoint-filtered waypoint along spline
      const W = this.waypoints;
      const M = W.length;
      const curCp = telemetry.currentCp || 0;

      let bestIdx = this.lastArcIndex;
      let bestScore = Infinity;

      // Local window search first, fallback to checkpoint-filtered global search if reset/teleported
      const winLo = Math.max(0, this.lastArcIndex - 10);
      const winHi = Math.min(M - 1, this.lastArcIndex + 58);
      for (let i = winLo; i <= winHi; i++) {
        const wp = W[i];
        const dx = wp.x - pos.x;
        const dy = wp.y - pos.y;
        const dz = wp.z - pos.z;
        if (!wp.isWallTrack && Math.abs(dy) > 22.0) continue;
        const dotT = fwd.x * wp.tx + fwd.y * wp.ty + fwd.z * wp.tz;
        const alignPen = (1.0 - dotT) * 26.0 + (i < this.lastArcIndex - 3 ? 16.0 : 0.0);
        const dSq = dx * dx + dy * dy * (wp.isWallTrack ? 1.0 : 2.2) + dz * dz + alignPen;
        if (dSq < bestScore) {
          bestScore = dSq;
          bestIdx = i;
        }
      }

      if (bestScore > 320.0) {
        for (let i = 0; i < M; i++) {
          const wp = W[i];
          if (Math.abs(wp.stageCp - curCp) > 1) continue;
          const dx = wp.x - pos.x;
          const dy = wp.y - pos.y;
          const dz = wp.z - pos.z;
          if (!wp.isWallTrack && Math.abs(dy) > 24.0) continue;
          const dotT = fwd.x * wp.tx + fwd.y * wp.ty + fwd.z * wp.tz;
          const dSq = dx * dx + dy * dy * (wp.isWallTrack ? 1.0 : 2.2) + dz * dz + (1.0 - dotT) * 26.0;
          if (dSq < bestScore) {
            bestScore = dSq;
            bestIdx = i;
          }
        }
      }

      this.lastArcIndex = bestIdx;
      const curWp = W[bestIdx];

      // Sub-segment 3D projection for continuous arc-length s & surface-relative cross-track offset
      const dxC = pos.x - curWp.x;
      const dyC = pos.y - curWp.y;
      const dzC = pos.z - curWp.z;
      const along = clamp(dxC * curWp.tx + dyC * curWp.ty + dzC * curWp.tz, -2.5, 2.5);
      this.lastArcS = clamp(curWp.s + along, 0, this.totalLengthM);

      const upX = curWp.upX ?? 0, upY = curWp.upY ?? 1, upZ = curWp.upZ ?? 0;
      let wpRightX = curWp.ty * upZ - curWp.tz * upY;
      let wpRightY = curWp.tz * upX - curWp.tx * upZ;
      let wpRightZ = curWp.tx * upY - curWp.ty * upX;
      const rLen = Math.hypot(wpRightX, wpRightY, wpRightZ) || 1.0;
      wpRightX /= rLen;
      wpRightY /= rLen;
      wpRightZ /= rLen;

      const latMeters = dxC * wpRightX + dyC * wpRightY + dzC * wpRightZ; // >0 means car is to the RIGHT of racing line
      this.corridorHalfWidth = Math.max(2.5, Math.min(8.0, curWp.clearance || 4.5));
      this.lateralOffsetNorm = clamp(latMeters / this.corridorHalfWidth, -1.5, 1.5);

      // Heading error: >0 means car nose points RIGHT of spline tangent
      const sinErr = fwd.x * wpRightX + fwd.y * wpRightY + fwd.z * wpRightZ;
      const cosErr = fwd.x * curWp.tx + fwd.y * curWp.ty + fwd.z * curWp.tz;
      this.headingError = Math.atan2(sinErr, cosErr);

      // 3. Extract 5-point lookahead angles & curvatures in car's 3D frame
      let searchIdx = bestIdx;
      let maxCrestRate = curWp.pitchRate || 0;
      for (let k = 0; k < LOOKAHEAD_DISTS.length; k++) {
        const targetS = Math.min(this.totalLengthM, this.lastArcS + LOOKAHEAD_DISTS[k]);
        while (searchIdx + 1 < M && W[searchIdx + 1].s < targetS) {
          searchIdx++;
          if (Math.abs(W[searchIdx].pitchRate) > Math.abs(maxCrestRate)) {
            maxCrestRate = W[searchIdx].pitchRate;
          }
        }
        const lw = W[searchIdx];
        const rx = lw.x - pos.x;
        const ry = lw.y - pos.y;
        const rz = lw.z - pos.z;

        const localFwd = rx * fwd.x + ry * fwd.y + rz * fwd.z;
        const localRight = rx * right.x + ry * right.y + rz * right.z;
        this.lookaheadAngles[k] = clamp(Math.atan2(localRight, Math.max(2.0, localFwd)), -1.5, 1.5);
        this.lookaheadCurvatures[k] = clamp(lw.curvature * 18.0, -1.5, 1.5);
      }
      this.lookaheadPitch = clamp((telemetry.pitch || 0) * 1.5 + maxCrestRate * 8.0, -1.5, 1.5);

      return true;
    }

    /**
     * Query max absolute curvature & steepest crest over [s, s + horizonM] for physics speed profiling.
     */
    queryUpcomingRoadProfile(horizonM = 70.0) {
      if (!this.ready || !this.waypoints.length) {
        return { maxAbsCurv: 0, nearCurvSigned: 0, distToPeakCurv: horizonM, minClearance: 4.5, crestRisk: 0 };
      }
      const W = this.waypoints;
      const M = W.length;
      const s0 = this.lastArcS;
      let maxAbsCurv = 0;
      let distToPeakCurv = horizonM;
      let nearCurvSigned = W[this.lastArcIndex].curvature;
      let minClearance = W[this.lastArcIndex].clearance || 4.5;
      let crestRisk = 0;

      for (let i = this.lastArcIndex; i < M; i++) {
        const ds = W[i].s - s0;
        if (ds > horizonM) break;
        const ac = Math.abs(W[i].curvature);
        if (ds <= 18.0 && ac > Math.abs(nearCurvSigned)) {
          nearCurvSigned = W[i].curvature;
        }
        if (ac > maxAbsCurv) {
          maxAbsCurv = ac;
          distToPeakCurv = Math.max(0, ds);
        }
        if ((W[i].clearance || 4.5) < minClearance && ds < 35.0) {
          minClearance = W[i].clearance || 4.5;
        }
        // Negative pitchRate means cresting a hill/jump where tires unload!
        if (W[i].pitchRate < -0.025 && ds < 36.0) {
          crestRisk = Math.max(crestRisk, Math.abs(W[i].pitchRate) * 16.0);
        }
      }

      return { maxAbsCurv, nearCurvSigned, distToPeakCurv, minClearance, crestRisk };
    }
  }

  window.PolyPilotTrack3D = {
    Track3DAnalyzer,
    LOOKAHEAD_DISTS,
    SECTIONS_PER_CP,
    RAY_MAX_M,
    RAY_MIN_M
  };
})();
