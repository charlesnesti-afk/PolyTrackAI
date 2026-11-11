(() => {
  'use strict';

  const VISION_W = 64;
  const VISION_H = 36;
  const NUM_RAYS = 15;
  const RAY_ANGLES_DEG = [-68, -56, -45, -35, -26, -17, -8, 0, 8, 17, 26, 35, 45, 56, 68];

  // Calibrated to PolyTrack's chase camera (horizon at ~44% height = y:15.8 on 64x36 grid)
  const X_CENTER = 32.0;
  const Y_HORIZON = 15.6;
  const FOCAL_Y = 92.0;  // Z=5m -> y=34, Z=12m -> y=23.3, Z=25m -> y=19.3, Z=65m -> y=17.0
  const FOCAL_X = 42.0;
  const MIN_DIST_M = 7.5;
  const MAX_DIST_M = 65.0;

  class VisionProcessor {
    constructor() {
      this.width = VISION_W;
      this.height = VISION_H;
      this.numRays = NUM_RAYS;
      this.originX = X_CENTER;
      this.originY = 20.0; // Front bumper anchor for HUD drawing

      this.offscreen = document.createElement('canvas');
      this.offscreen.width = VISION_W;
      this.offscreen.height = VISION_H;
      this.ctx = this.offscreen.getContext('2d', { willReadFrequently: true });

      this.roadMap = new Float32Array(VISION_W * VISION_H);
      this.rays = new Float32Array(NUM_RAYS);
      this.prevRays1 = new Float32Array(NUM_RAYS);
      this.prevRays2 = new Float32Array(NUM_RAYS);
      this.rayDeltas = new Float32Array(NUM_RAYS);
      this.horizonGrid = new Float32Array(16);
      this.rayEndpoints = new Array(NUM_RAYS);
      for (let i = 0; i < NUM_RAYS; i++) {
        this.rays[i] = 0.90;
        this.prevRays1[i] = 0.90;
        this.prevRays2[i] = 0.90;
        this.rayEndpoints[i] = { x: X_CENTER, y: 17 };
      }

      this.refRoadR = 95;
      this.refRoadG = 112;
      this.refRoadB = 132;
      this.refInitialized = false;

      this.visualTurnBias = 0;
      this.centerClearance = 0.90;
      this.frameValid = false;
      this.lastImageData = null;

      this.rayAnglesRad = RAY_ANGLES_DEG.map((deg) => (deg * Math.PI) / 180);
    }

    resetTemporal() {
      for (let i = 0; i < NUM_RAYS; i++) {
        this.prevRays1[i] = this.rays[i];
        this.prevRays2[i] = this.rays[i];
        this.rayDeltas[i] = 0;
      }
    }

    process(screenCanvas, isGrounded = true) {
      if (!screenCanvas || screenCanvas.width === 0 || screenCanvas.height === 0) {
        this.frameValid = false;
        return this;
      }

      try {
        this.ctx.drawImage(screenCanvas, 0, 0, VISION_W, VISION_H);
        const imgData = this.ctx.getImageData(0, 0, VISION_W, VISION_H);
        this.lastImageData = imgData;
        const data = imgData.data;

        let nonZeroSum = 0;
        for (let idx = 0; idx < data.length; idx += 16) {
          nonZeroSum += data[idx] + data[idx + 1] + data[idx + 2];
        }
        this.frameValid = nonZeroSum > 200;
        if (!this.frameValid) return this;

        // Self-calibrate road color from unobstructed asphalt directly behind rear bumper (x: 26..37, y: 31..35)
        if (isGrounded || !this.refInitialized) {
          let sumR = 0;
          let sumG = 0;
          let sumB = 0;
          let count = 0;
          for (let y = 31; y <= 35; y++) {
            for (let x = 26; x <= 37; x++) {
              const base = (y * VISION_W + x) * 4;
              const r = data[base];
              const g = data[base + 1];
              const b = data[base + 2];
              if (b > 215 && g > 185 && (b - r) > 42) continue;
              if (g > r + 18 && g > b + 12) continue;
              sumR += r;
              sumG += g;
              sumB += b;
              count++;
            }
          }
          if (count >= 10) {
            const alpha = this.refInitialized ? 0.10 : 1.0;
            this.refRoadR += alpha * ((sumR / count) - this.refRoadR);
            this.refRoadG += alpha * ((sumG / count) - this.refRoadG);
            this.refRoadB += alpha * ((sumB / count) - this.refRoadB);
            this.refInitialized = true;
          }
        }

        // Segment drivable road surface by calibrated asphalt color affinity;
        // thin painted lines (<3m) are stepped over naturally by badRun >= 3 in ground-plane meters
        for (let p = 0, base = 0; p < VISION_W * VISION_H; p++, base += 4) {
          const r = data[base];
          const g = data[base + 1];
          const b = data[base + 2];

          const lum = (r + g + b) * 0.3333;
          const isSky = (b > 205 && (b - r) > 42 && lum > 150);
          const isGrass = (g > r + 16 && g > b + 10);
          const isRedWall = (r > 170 && (r - g) > 80 && (r - b) > 70);

          let score;
          if (isSky || isGrass || isRedWall) {
            score = 0.02;
          } else {
            const dr = (r - this.refRoadR) / 255.0;
            const dg = (g - this.refRoadG) / 255.0;
            const db = (b - this.refRoadB) / 255.0;
            const colorDist = Math.sqrt(dr * dr + dg * dg + db * db);
            // Asphalt + road shadow matches refRoad tightly (colorDist < 0.22 -> score > 0.55);
            // bright white barrier walls / clouds have colorDist > 0.45 -> score < 0.15
            score = Math.max(0.0, Math.min(1.0, 1.0 - colorDist * 2.05));
          }
          this.roadMap[p] = score;
        }

        this.prevRays2.set(this.prevRays1);
        this.prevRays1.set(this.rays);

        // Ground-Plane Inverse Perspective Raycasting (steps in true 3D ground meters 7.5m .. 65m!)
        let leftWeighted = 0;
        let rightWeighted = 0;

        for (let r = 0; r < NUM_RAYS; r++) {
          const theta = this.rayAnglesRad[r];
          const sinT = Math.sin(theta);
          const cosT = Math.cos(theta);

          let hitDistM = MAX_DIST_M;
          let endX = X_CENTER + sinT * 18;
          let endY = Y_HORIZON + 1.5;
          let badRun = 0;

          for (let dM = MIN_DIST_M; dM <= MAX_DIST_M; dM += 1.5) {
            const zGround = Math.max(3.5, dM * cosT);
            const xGround = dM * sinT;

            const px = Math.round(X_CENTER + (FOCAL_X * xGround) / zGround);
            const py = Math.round(Y_HORIZON + FOCAL_Y / zGround);

            if (px < 1 || px >= VISION_W - 1 || py < 2 || py >= VISION_H - 1) {
              hitDistM = dM;
              endX = Math.max(1, Math.min(VISION_W - 2, px));
              endY = Math.max(2, Math.min(VISION_H - 2, py));
              break;
            }

            // Skip car body silhouette box (x: 25..38, y: 19..30)
            if (py >= 19 && py <= 30 && px >= 25 && px <= 38) {
              continue;
            }

            endX = px;
            endY = py;
            const road = this.roadMap[py * VISION_W + px];
            if (road < 0.42) {
              badRun += 1;
              if (badRun >= 3) {
                hitDistM = Math.max(MIN_DIST_M, dM - 3.0);
                break;
              }
            } else {
              badRun = 0;
            }
          }

          const normDist = Math.max(0.0, Math.min(1.0, (hitDistM - MIN_DIST_M) / (MAX_DIST_M - MIN_DIST_M)));
          this.rays[r] = normDist;
          this.rayDeltas[r] = normDist - this.prevRays2[r];
          this.rayEndpoints[r] = { x: endX, y: endY };

          const centerOffset = (r - 7) / 7.0;
          const weight = 1.15 - 0.35 * Math.abs(centerOffset);
          if (r < 7) leftWeighted += normDist * weight;
          else if (r > 7) rightWeighted += normDist * weight;
        }

        this.visualTurnBias = Math.max(-1.5, Math.min(1.5, (rightWeighted - leftWeighted) / 2.2));
        this.centerClearance = (this.rays[6] + this.rays[7] + this.rays[8]) / 3.0;

        // 4x4 Forward Perspective Corridor Grid (rows y = 14..26 covering horizon-to-midfield, cols x = 4..60)
        for (let gy = 0; gy < 4; gy++) {
          const y0 = 14 + gy * 3;
          const y1 = y0 + 3;
          for (let gx = 0; gx < 4; gx++) {
            const x0 = 4 + gx * 14;
            const x1 = x0 + 14;
            let sum = 0;
            let cnt = 0;
            for (let yy = y0; yy < y1; yy++) {
              const rowOff = yy * VISION_W;
              for (let xx = x0; xx < x1; xx++) {
                if (yy >= 19 && xx >= 25 && xx <= 38) continue;
                sum += this.roadMap[rowOff + xx];
                cnt++;
              }
            }
            this.horizonGrid[gy * 4 + gx] = cnt > 0 ? sum / cnt : 0.5;
          }
        }
      } catch (_) {
        this.frameValid = false;
      }

      return this;
    }
  }

  window.PolyPilotVision = {
    VisionProcessor,
    VISION_W,
    VISION_H,
    NUM_RAYS,
    RAY_ANGLES_DEG
  };
})();
