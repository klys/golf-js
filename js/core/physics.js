(function (NG) {
  'use strict';

  const { CONFIG, TerrainUtil } = NG;
  const { clamp, lerp, smoothstep, normalize, dot } = NG.MathUtil;

  class PhysicsEngine {
    constructor() {
      this.time = 0;
    }

    /**
     * @param {object} options
     *   `preview`: trazado de ayuda al apuntar; no consume nada ni duerme la bola.
     *   `speculative`: predicción/extrapolación del cliente. Simula la misma
     *   física pero NO altera el estado del mundo (portales consumidos,
     *   multiplicadores, cuevas descubiertas), que pertenece al host y llega
     *   por snapshot. Sin esto, la predicción apagaría un portal en pantalla
     *   antes de que la autoridad lo confirme.
     */
    update(ball, hole, dt, options = {}) {
      if (!ball || !hole || !Number.isFinite(dt) || dt <= 0 || ball.holed) return;

      if (!ball.moving) {
        this.time += dt;
        if (ball.boosterCooldown > 0) ball.boosterCooldown = Math.max(0, ball.boosterCooldown - dt);
        if (ball.portalCooldown > 0) ball.portalCooldown = Math.max(0, ball.portalCooldown - dt);
        if (ball.specialCooldown > 0) ball.specialCooldown = Math.max(0, ball.specialCooldown - dt);
        ball.prevX = ball.x;
        ball.prevY = ball.y;
        // Los obstáculos dinámicos siguen vivos mientras el jugador apunta. Si alcanzan
        // una bola en reposo, pueden ponerla de nuevo en movimiento de forma física.
        this.resolvePlatforms(ball, hole, dt, options);
        this.resolveMovingWalls(ball, hole, dt, options);
        this.resolveSpinners(ball, hole, options);
        this.settleIntoCup(ball, hole);
        return;
      }

      if (ball.caveRide) {
        this.resetMotionGuard(ball);
        this.updateSecretCaveRide(ball, hole, dt, options);
        return;
      }

      const speed = Math.max(1, Math.hypot(ball.vx, ball.vy), this.dynamicHazardMaxSpeed(hole));
      const travel = speed * dt;
      const maxStepTravel = Math.max(5.5, CONFIG.ball.radius * 0.56);
      const steps = clamp(Math.ceil(travel / maxStepTravel), 1, 12);
      const stepDt = dt / steps;

      for (let i = 0; i < steps; i += 1) {
        if (!ball.moving || ball.holed || ball.inWater) break;
        this.step(ball, hole, stepDt, options);
      }
      this.applyMotionGuard(ball, dt, options);
    }

    step(ball, hole, dt, options) {
      this.time += dt;
      if (ball.boosterCooldown > 0) ball.boosterCooldown = Math.max(0, ball.boosterCooldown - dt);
      if (ball.portalCooldown > 0) ball.portalCooldown = Math.max(0, ball.portalCooldown - dt);
      if (ball.specialCooldown > 0) ball.specialCooldown = Math.max(0, ball.specialCooldown - dt);
      ball.prevX = ball.x;
      ball.prevY = ball.y;
      ball.onSurface = false;
      ball.topImpactVx = null;
      ball.topImpactVy = null;

      this.applyGravityWells(ball, hole, dt, options);
      this.applyHoleSuction(ball, hole, dt, options);
      this.applyFanFields(ball, hole, dt, options);

      const wind = this.currentWind(hole.windBase);
      ball.vx += wind.x * CONFIG.wind.accelerationPerMps * dt;
      ball.vy += (CONFIG.ball.gravity + wind.y * CONFIG.wind.accelerationPerMps) * dt;
      ball.vx *= Math.pow(CONFIG.ball.airDrag, dt * 60);
      ball.vy *= Math.pow(CONFIG.ball.airDrag, dt * 60);

      const speed = Math.hypot(ball.vx, ball.vy);
      if (speed > CONFIG.ball.maxSpeed) {
        const scale = CONFIG.ball.maxSpeed / speed;
        ball.vx *= scale;
        ball.vy *= scale;
      }

      ball.x += ball.vx * dt;
      ball.y += ball.vy * dt;

      this.resolveSolidWalls(ball, hole, options);
      this.resolveBumpers(ball, hole, options);
      this.resolvePortals(ball, hole, options);
      this.resolvePlatforms(ball, hole, dt, options);
      this.resolveMovingWalls(ball, hole, dt, options);
      this.resolveSpinners(ball, hole, options);
      this.resolveBottomSurfaces(ball, hole, options);
      this.resolveTopSurfaces(ball, hole, dt, options);
      this.resolveSecretCaves(ball, hole, options);
      if (ball.caveRide) return;
      this.resolveCannons(ball, hole, options);
      this.resolveMultipliers(ball, hole, options);
      // Segunda pasada estática: las correcciones de superficies/obstáculos dinámicos
      // no pueden volver a introducir la bola dentro de un lateral de isla/techo.
      this.resolveSolidWalls(ball, hole, options);
      this.resolveWater(ball, hole, options);
      this.resolveHole(ball, hole, options);

      if (![ball.x, ball.y, ball.vx, ball.vy].every(Number.isFinite)) {
        const safe = ball.lastSafe || { x: hole.tee.x, y: hole.tee.y };
        ball.x = safe.x;
        ball.y = safe.y;
        ball.vx = 0;
        ball.vy = 0;
        ball.moving = false;
        ball.inWater = false;
      }
    }

    currentWind(base) {
      const safeBase = base && Number.isFinite(base.speed) && Number.isFinite(base.angle)
        ? base
        : { speed: 0, angle: 0 };
      const gust = 1 + Math.sin(this.time * 1.17) * CONFIG.wind.gustStrength;
      const angle = safeBase.angle + Math.sin(this.time * 0.41 + safeBase.speed) * CONFIG.wind.directionWobbleRadians;
      const speed = Math.max(0, safeBase.speed * gust);
      return {
        x: Math.cos(angle) * speed,
        y: Math.sin(angle) * speed,
        speed,
        angle,
      };
    }

    resetMotionGuard(ball, detach = true) {
      if (!ball) return;
      ball.motionGuardX = Number.isFinite(ball.x) ? ball.x : 0;
      ball.motionGuardY = Number.isFinite(ball.y) ? ball.y : 0;
      ball.motionGuardElapsed = 0;
      ball.motionGuardLowElapsed = 0;
      if (detach) ball.restingPlatformId = null;
    }

    sleepBall(ball, rememberSurface = true) {
      if (!ball) return;
      ball.vx = 0;
      ball.vy = 0;
      ball.moving = false;
      ball.motionGuardX = ball.x;
      ball.motionGuardY = ball.y;
      ball.motionGuardElapsed = 0;
      ball.motionGuardLowElapsed = 0;
      if (rememberSurface && ball.onSurface && ball.lastSurfaceId) {
        ball.lastSafe = { x: ball.x, y: ball.y, surfaceId: ball.lastSurfaceId };
      }
    }

    applyMotionGuard(ball, dt, options = {}) {
      if (options.preview || !ball || !ball.moving || ball.holed || ball.inWater || ball.caveRide) return;
      const speed = Math.hypot(Number(ball.vx) || 0, Number(ball.vy) || 0);
      const trapRadius = CONFIG.ball.radius * 4;
      const lowSpeed = Math.max(CONFIG.shot.minLaunchSpeed * 1.35, CONFIG.ball.settleSpeed * 2.5);
      const maxTrapSpeed = Math.max(240, CONFIG.shot.minLaunchSpeed * 5.5);
      const lowSleepSeconds = Math.max(0.38, CONFIG.gameplay.safeRestSeconds * 2.5);
      const trappedSleepSeconds = Math.max(1.1, CONFIG.gameplay.safeRestSeconds * 7);

      if (!Number.isFinite(ball.motionGuardX) || !Number.isFinite(ball.motionGuardY)) {
        this.resetMotionGuard(ball, false);
        return;
      }

      const distance = Math.hypot(ball.x - ball.motionGuardX, ball.y - ball.motionGuardY);
      if (distance > trapRadius || speed > maxTrapSpeed) {
        this.resetMotionGuard(ball, false);
        return;
      }

      ball.motionGuardElapsed = (Number(ball.motionGuardElapsed) || 0) + dt;
      if (speed <= lowSpeed) ball.motionGuardLowElapsed = (Number(ball.motionGuardLowElapsed) || 0) + dt;
      else ball.motionGuardLowElapsed = Math.max(0, (Number(ball.motionGuardLowElapsed) || 0) - dt * 0.5);

      if (ball.motionGuardLowElapsed >= lowSleepSeconds || ball.motionGuardElapsed >= trappedSleepSeconds) {
        this.sleepBall(ball);
      }
    }

    resolveTopSurfaces(ball, hole, dt, options) {
      const r = CONFIG.ball.radius;
      let candidate = null;
      let bestDistance = Infinity;

      for (const surface of hole.surfaces) {
        if (surface.side !== 'top') continue;
        if (ball.x < surface.xMin - r || ball.x > surface.xMax + r) continue;
        const x = clamp(ball.x, surface.xMin, surface.xMax);
        const y = TerrainUtil.sampleSurface(surface, x);
        if (!Number.isFinite(y)) continue;

        const water = TerrainUtil.waterAt(hole, surface.id, x);
        if (water) continue;

        const previousBottom = (ball.prevY ?? ball.y) + r;
        const bottom = ball.y + r;
        const crossed = previousBottom <= y + 2.5 && bottom >= y;
        const shallowPenetration = bottom >= y - 0.5 && ball.y <= y + r * 0.95 && ball.y >= y - r * 1.65;
        if (!crossed && !shallowPenetration) continue;

        const distance = Math.abs(bottom - y);
        if (distance < bestDistance) {
          bestDistance = distance;
          candidate = { surface, x, y };
        }
      }

      if (!candidate) return;
      const { surface, x, y } = candidate;
      const slope = TerrainUtil.surfaceSlope(surface, x);
      const tangent = normalize({ x: 1, y: slope });
      const normal = normalize({ x: slope, y: -1 });
      const incomingNormal = dot({ x: ball.vx, y: ball.vy }, normal);
      let tangentSpeed = dot({ x: ball.vx, y: ball.vy }, tangent);

      ball.y = y - r;
      ball.onSurface = true;
      ball.lastSurfaceId = surface.id;

      if (incomingNormal < 0) {
        // Conservamos la velocidad de entrada antes del rebote. resolveHole se
        // ejecuta después de las superficies y necesita este vector original
        // para reconocer una caída pronunciada desde arriba.
        ball.topImpactVx = ball.vx;
        ball.topImpactVy = ball.vy;
        const bounce = surface.kind === 'island' || surface.kind === 'ground'
          ? CONFIG.ball.groundBounce
          : CONFIG.ball.roofBounce;
        const outgoingNormal = -incomingNormal * bounce;
        tangentSpeed *= 0.995;
        ball.vx = tangent.x * tangentSpeed + normal.x * outgoingNormal;
        ball.vy = tangent.y * tangentSpeed + normal.y * outgoingNormal;
        if (!options.preview && -incomingNormal > 58) {
          ball.lastImpactSpeed = -incomingNormal;
          ball.impactSerial = (ball.impactSerial || 0) + 1;
        }
      }

      const material = TerrainUtil.surfaceMaterialAt(hole, surface.id, x);
      const friction = material === 'sand'
        ? CONFIG.ball.sandFriction
        : material === 'rough'
          ? CONFIG.ball.roughFriction
          : material === 'ice'
            ? CONFIG.ball.iceFriction
            : CONFIG.ball.fairwayFriction;
      const frictionPower = Math.pow(friction, dt * 60);

      const normalAfter = dot({ x: ball.vx, y: ball.vy }, normal);
      if (Math.abs(normalAfter) < 96 || Math.abs(ball.vy) < 100) {
        tangentSpeed = dot({ x: ball.vx, y: ball.vy }, tangent) * frictionPower;
        const gravityAlongTangent = CONFIG.ball.gravity * tangent.y * CONFIG.ball.rollingGravityScale;
        tangentSpeed += gravityAlongTangent * dt;
        ball.vx = tangent.x * tangentSpeed;
        ball.vy = tangent.y * tangentSpeed;
      }

      if (material === 'booster' && ball.boosterCooldown <= 0) {
        const booster = TerrainUtil.boosterAt(hole, surface.id, x);
        const direction = booster?.direction || Math.sign(hole.cup.x - ball.x) || Math.sign(tangentSpeed) || 1;
        const power = booster?.power || 480;
        ball.vx += tangent.x * direction * power + normal.x * 120;
        ball.vy += tangent.y * direction * power + normal.y * 120;
        ball.boosterCooldown = 0.36;
        if (!options.preview) {
          ball.boosterSerial = (ball.boosterSerial || 0) + 1;
          ball.boosterPulse = 1;
        }
      }

      const motion = Math.hypot(ball.vx, ball.vy);
      const settleSpeed = material === 'ice' ? Math.min(7, CONFIG.ball.settleSpeed * 0.32) : CONFIG.ball.settleSpeed;
      const settleSlope = material === 'ice' ? 0.055 : 0.24;
      if (motion < settleSpeed && Math.abs(slope) < settleSlope) {
        this.sleepBall(ball);
      }
    }

    resolvePlatforms(ball, hole, dt, options) {
      const r = CONFIG.ball.radius;
      const bounceSide = 0.62;

      for (const hazard of hole.hazards) {
        if (hazard.type !== 'platform') continue;
        const platform = this.platformState(hazard);
        const previousPlatform = this.platformStateAt(hazard, Math.max(0, this.time - dt));
        const platformId = `platform-${hazard.x}-${hazard.y}`;
        const halfW = hazard.width * 0.5;
        const halfH = Math.max(5, (hazard.thickness || 18) * 0.5);
        const left = platform.x - halfW;
        const right = platform.x + halfW;
        const top = platform.y - halfH;
        const bottom = platform.y + halfH;
        const prevLeft = previousPlatform.x - halfW;
        const prevRight = previousPlatform.x + halfW;
        const prevTop = previousPlatform.y - halfH;
        const prevBottom = previousPlatform.y + halfH;

        // Una bola dormida sobre una plataforma se desplaza con ella, pero sigue
        // disponible para el siguiente tiro. La velocidad del soporte no cuenta
        // como movimiento propio de la bola.
        if (!ball.moving && ball.restingPlatformId === platformId) {
          ball.x += platform.x - previousPlatform.x;
          ball.y = top - r;
          ball.vx = 0;
          ball.vy = 0;
          ball.onSurface = true;
          ball.lastSurfaceId = platformId;
          ball.lastSafe = { x: ball.x, y: ball.y, surfaceId: platformId };
          return;
        }

        const px = ball.prevX ?? ball.x;
        const py = ball.prevY ?? ball.y;
        const prevBallLeft = px - r;
        const prevBallRight = px + r;
        const prevBallTop = py - r;
        const prevBallBottom = py + r;
        const ballLeft = ball.x - r;
        const ballRight = ball.x + r;
        const ballTop = ball.y - r;
        const ballBottom = ball.y + r;
        const verticalOverlap = ballBottom >= top - 2 && ballTop <= bottom + 2;
        const horizontalOverlap = ballRight >= left - 2 && ballLeft <= right + 2;
        const relVx = ball.vx - platform.vx;
        const relVy = ball.vy - platform.vy;

        // Cara superior. La coordenada Y crece hacia abajo, por lo que relVy > 0
        // significa que la bola se acerca a la plataforma desde arriba.
        const crossedTop = prevBallBottom <= prevTop + 2.5 && ballBottom >= top && horizontalOverlap && relVy >= -18;
        if (crossedTop) {
          ball.y = top - r;
          ball.onSurface = true;
          ball.lastSurfaceId = platformId;
          let tangentSpeed = (ball.vx - platform.vx) * Math.pow(CONFIG.ball.fairwayFriction, dt * 60);
          let normalSpeed = relVy;
          if (normalSpeed > 34) normalSpeed = -normalSpeed * CONFIG.ball.groundBounce;
          else normalSpeed = 0;
          ball.vx = platform.vx + tangentSpeed;
          ball.vy = platform.vy + normalSpeed;
          if (Math.hypot(tangentSpeed, normalSpeed) < CONFIG.ball.settleSpeed) {
            ball.restingPlatformId = platformId;
            this.sleepBall(ball);
          }
          if (!options.preview) ball.platformSerial = (ball.platformSerial || 0) + 1;
          return;
        }

        // Cara inferior: evita atravesar visualmente una plataforma al disparar desde abajo.
        const crossedBottom = prevBallTop >= prevBottom - 2.5 && ballTop <= bottom && horizontalOverlap && relVy <= 18;
        if (crossedBottom) {
          ball.y = bottom + r;
          const reflected = Math.abs(relVy) * CONFIG.ball.roofBounce;
          ball.vy = platform.vy + reflected;
          ball.vx = platform.vx + relVx * 0.995;
          if (!options.preview) ball.platformSerial = (ball.platformSerial || 0) + 1;
          return;
        }

        // Laterales sólidos. Esto mantiene la regla del generador: si una masa se ve
        // sólida, también debe ser sólida para la física.
        const crossedLeft = prevBallRight <= prevLeft + 2.5 && ballRight >= left && verticalOverlap && relVx > -18;
        if (crossedLeft) {
          ball.x = left - r;
          ball.vx = platform.vx - Math.abs(relVx) * bounceSide;
          ball.vy = platform.vy + relVy * 0.995;
          if (!options.preview) ball.platformSerial = (ball.platformSerial || 0) + 1;
          return;
        }
        const crossedRight = prevBallLeft >= prevRight - 2.5 && ballLeft <= right && verticalOverlap && relVx < 18;
        if (crossedRight) {
          ball.x = right + r;
          ball.vx = platform.vx + Math.abs(relVx) * bounceSide;
          ball.vy = platform.vy + relVy * 0.995;
          if (!options.preview) ball.platformSerial = (ball.platformSerial || 0) + 1;
          return;
        }

        // Guardia de penetración para movimientos de la propia plataforma. Se usa solo
        // cuando el centro de la bola acaba dentro del AABB expandido sin haber cruzado
        // limpiamente una cara durante el sub-step.
        if (!horizontalOverlap || !verticalOverlap) continue;
        const penLeft = Math.abs(ballRight - left);
        const penRight = Math.abs(right - ballLeft);
        const penTop = Math.abs(ballBottom - top);
        const penBottom = Math.abs(bottom - ballTop);
        const minPen = Math.min(penLeft, penRight, penTop, penBottom);
        if (minPen === penTop) {
          ball.y = top - r;
          ball.onSurface = true;
          ball.lastSurfaceId = platformId;
          ball.vx = platform.vx + relVx * Math.pow(CONFIG.ball.fairwayFriction, dt * 60);
          ball.vy = platform.vy + Math.min(0, relVy) * CONFIG.ball.groundBounce;
        } else if (minPen === penBottom) {
          ball.y = bottom + r;
          ball.vy = platform.vy + Math.abs(relVy) * CONFIG.ball.roofBounce;
        } else if (minPen === penLeft) {
          ball.x = left - r;
          ball.vx = platform.vx - Math.abs(relVx) * bounceSide;
        } else {
          ball.x = right + r;
          ball.vx = platform.vx + Math.abs(relVx) * bounceSide;
        }
        if (!options.preview) ball.platformSerial = (ball.platformSerial || 0) + 1;
        return;
      }
    }

    platformStateAt(platform, time) {
      const omega = (Math.PI * 2) / Math.max(0.5, platform.period || 3);
      const axis = platform.axis === 'x' ? 'x' : 'y';
      const offset = Math.sin(time * omega + (platform.phase || 0)) * (platform.amplitude || 0);
      const velocity = Math.cos(time * omega + (platform.phase || 0)) * (platform.amplitude || 0) * omega;
      return {
        x: (platform.baseX ?? platform.x) + (axis === 'x' ? offset : 0),
        y: (platform.baseY ?? platform.y) + (axis === 'y' ? offset : 0),
        vx: axis === 'x' ? velocity : 0,
        vy: axis === 'y' ? velocity : 0,
      };
    }

    platformState(platform) {
      return this.platformStateAt(platform, this.time);
    }

    dynamicHazardMaxSpeed(hole) {
      let maxSpeed = 0;
      for (const hazard of hole?.hazards || []) {
        if (hazard.type === 'platform' || hazard.type === 'moving-wall') {
          const omega = (Math.PI * 2) / Math.max(0.5, hazard.period || 3);
          maxSpeed = Math.max(maxSpeed, Math.abs(hazard.amplitude || 0) * omega);
        } else if (hazard.type === 'spinner') {
          const omega = (Math.PI * 2) / Math.max(0.5, hazard.period || 3);
          maxSpeed = Math.max(maxSpeed, Math.abs(hazard.armLength || 0) * omega);
        }
      }
      return maxSpeed;
    }

    movingWallStateAt(wall, time) {
      const omega = (Math.PI * 2) / Math.max(0.5, wall.period || 3);
      const offset = Math.sin(time * omega + (wall.phase || 0)) * (wall.amplitude || 0);
      const velocity = Math.cos(time * omega + (wall.phase || 0)) * (wall.amplitude || 0) * omega;
      return {
        x: wall.baseX ?? wall.x,
        y: (wall.baseY ?? wall.y) + offset,
        vx: 0,
        vy: velocity,
      };
    }

    movingWallState(wall) {
      return this.movingWallStateAt(wall, this.time);
    }

    resolveMovingWalls(ball, hole, dt, options) {
      const r = CONFIG.ball.radius;
      const wasMoving = !!ball.moving;
      const wakeSpeed = Math.max(90, CONFIG.shot.minLaunchSpeed * 2.25);
      for (const wall of hole.hazards) {
        if (wall.type !== 'moving-wall') continue;
        const state = this.movingWallState(wall);
        const prev = this.movingWallStateAt(wall, Math.max(0, this.time - dt));
        const hw = wall.width * 0.5;
        const hh = wall.height * 0.5;
        const left = state.x - hw, right = state.x + hw, top = state.y - hh, bottom = state.y + hh;
        const prevLeft = prev.x - hw, prevRight = prev.x + hw, prevTop = prev.y - hh, prevBottom = prev.y + hh;
        const px = ball.prevX ?? ball.x, py = ball.prevY ?? ball.y;
        const prevL = px - r, prevR = px + r, prevT = py - r, prevB = py + r;
        const currL = ball.x - r, currR = ball.x + r, currT = ball.y - r, currB = ball.y + r;
        const hOverlap = currR >= left - 2 && currL <= right + 2;
        const vOverlap = currB >= top - 2 && currT <= bottom + 2;
        const rvx = ball.vx - state.vx;
        const rvy = ball.vy - state.vy;
        const bounce = Number.isFinite(wall.bounce) ? wall.bounce : 0.68;
        let hit = false;

        if (prevB <= prevTop + 2.5 && currB >= top && hOverlap && rvy >= -20) {
          ball.y = top - r;
          ball.vy = state.vy - Math.abs(rvy) * bounce;
          ball.vx = state.vx + rvx * 0.995;
          hit = true;
        } else if (prevT >= prevBottom - 2.5 && currT <= bottom && hOverlap && rvy <= 20) {
          ball.y = bottom + r;
          if (!this.markMovingWallCrush(ball, hole, state, options)) {
            ball.vy = state.vy + Math.abs(rvy) * bounce;
            ball.vx = state.vx + rvx * 0.995;
          }
          hit = true;
        } else if (prevR <= prevLeft + 2.5 && currR >= left && vOverlap && rvx >= -20) {
          ball.x = left - r;
          ball.vx = state.vx - Math.abs(rvx) * bounce;
          ball.vy = state.vy + rvy * 0.995;
          hit = true;
        } else if (prevL >= prevRight - 2.5 && currL <= right && vOverlap && rvx <= 20) {
          ball.x = right + r;
          ball.vx = state.vx + Math.abs(rvx) * bounce;
          ball.vy = state.vy + rvy * 0.995;
          hit = true;
        } else if (hOverlap && vOverlap) {
          const penL = Math.abs(currR - left);
          const penR = Math.abs(right - currL);
          const penT = Math.abs(currB - top);
          const penB = Math.abs(bottom - currT);
          const minPen = Math.min(penL, penR, penT, penB);
          if (minPen === penT) { ball.y = top - r; ball.vy = state.vy - Math.abs(rvy) * bounce; }
          else if (minPen === penB) {
            ball.y = bottom + r;
            if (!this.markMovingWallCrush(ball, hole, state, options)) ball.vy = state.vy + Math.abs(rvy) * bounce;
          }
          else if (minPen === penL) { ball.x = left - r; ball.vx = state.vx - Math.abs(rvx) * bounce; }
          else { ball.x = right + r; ball.vx = state.vx + Math.abs(rvx) * bounce; }
          hit = true;
        }

        if (hit) {
          const contactSpeed = Math.hypot(rvx, rvy);
          if (!wasMoving && contactSpeed < wakeSpeed) this.sleepBall(ball, false);
          else {
            if (!wasMoving) this.resetMotionGuard(ball);
            ball.moving = true;
          }
          if (!options.preview && ball.moving) {
            ball.movingWallSerial = (ball.movingWallSerial || 0) + 1;
            ball.lastImpactSpeed = Math.max(ball.lastImpactSpeed || 0, contactSpeed);
          }
          return;
        }
      }
    }

    nearestSupportYBelow(ball, hole) {
      const r = CONFIG.ball.radius;
      let bestY = Infinity;
      const x = ball.x;
      for (const surface of hole.surfaces || []) {
        if (surface.side !== 'top' || x < surface.xMin - r || x > surface.xMax + r) continue;
        const y = TerrainUtil.sampleSurface(surface, x);
        if (!Number.isFinite(y) || y < ball.y) continue;
        if (y < bestY) bestY = y;
      }
      for (const hazard of hole.hazards || []) {
        if (hazard.type !== 'platform') continue;
        const state = this.platformState(hazard);
        const left = state.x - hazard.width * 0.5 - r;
        const right = state.x + hazard.width * 0.5 + r;
        const top = state.y - (hazard.thickness || 18) * 0.5;
        if (x < left || x > right || top < ball.y) continue;
        if (top < bestY) bestY = top;
      }
      return bestY;
    }

    markMovingWallCrush(ball, hole, state, options) {
      if (options.preview || state.vy < CONFIG.gameplay.crushMinWallSpeed) return false;
      const supportY = this.nearestSupportYBelow(ball, hole);
      if (!Number.isFinite(supportY)) return false;
      const gap = supportY - (ball.y + CONFIG.ball.radius);
      if (gap > CONFIG.gameplay.crushSupportGap) return false;
      ball.crushed = true;
      ball.moving = false;
      ball.vx = 0;
      ball.vy = 0;
      return true;
    }

    spinnerStateAt(spinner, time) {
      const omegaBase = (Math.PI * 2) / Math.max(0.5, spinner.period || 3);
      const omega = omegaBase * (spinner.spin || 1);
      return { angle: (spinner.phase || 0) + time * omega, omega };
    }

    spinnerState(spinner) {
      return this.spinnerStateAt(spinner, this.time);
    }

    resolveSpinners(ball, hole, options) {
      const ballRadius = CONFIG.ball.radius;
      const wasMoving = !!ball.moving;
      const wakeSpeed = Math.max(90, CONFIG.shot.minLaunchSpeed * 2.25);
      for (const spinner of hole.hazards) {
        if (spinner.type !== 'spinner') continue;
        const state = this.spinnerState(spinner);
        const contactRadius = ballRadius + (spinner.thickness || 18) * 0.5;
        const contactRadius2 = contactRadius * contactRadius;
        for (let arm = 0; arm < 2; arm += 1) {
          const angle = state.angle + arm * Math.PI * 0.5;
          const ux = Math.cos(angle), uy = Math.sin(angle);
          const ax = spinner.x - ux * spinner.armLength;
          const ay = spinner.y - uy * spinner.armLength;
          const bx = spinner.x + ux * spinner.armLength;
          const by = spinner.y + uy * spinner.armLength;
          const sx = bx - ax, sy = by - ay;
          const len2 = sx * sx + sy * sy;
          if (len2 <= 0.0001) continue;
          const t = clamp(((ball.x - ax) * sx + (ball.y - ay) * sy) / len2, 0, 1);
          const qx = ax + sx * t, qy = ay + sy * t;
          let dx = ball.x - qx, dy = ball.y - qy;
          let dist2 = dx * dx + dy * dy;
          if (dist2 >= contactRadius2) continue;
          let dist = Math.sqrt(Math.max(0, dist2));
          let nx, ny;
          if (dist > 0.0001) { nx = dx / dist; ny = dy / dist; }
          else { nx = -uy; ny = ux; dist = 0; }

          const penetration = contactRadius - dist;
          ball.x += nx * (penetration + 0.05);
          ball.y += ny * (penetration + 0.05);

          const rx = qx - spinner.x, ry = qy - spinner.y;
          const surfaceVx = -state.omega * ry;
          const surfaceVy = state.omega * rx;
          let relVx = ball.vx - surfaceVx;
          let relVy = ball.vy - surfaceVy;
          const contactSpeed = Math.hypot(relVx, relVy);
          const vn = relVx * nx + relVy * ny;
          if (vn < 0) {
            const bounce = Number.isFinite(spinner.bounce) ? spinner.bounce : 0.82;
            relVx -= (1 + bounce) * vn * nx;
            relVy -= (1 + bounce) * vn * ny;
          } else if (Math.hypot(relVx, relVy) < 34) {
            relVx += nx * 34;
            relVy += ny * 34;
          }
          ball.vx = relVx + surfaceVx;
          ball.vy = relVy + surfaceVy;
          if (!wasMoving && contactSpeed < wakeSpeed) this.sleepBall(ball, false);
          else {
            if (!wasMoving) this.resetMotionGuard(ball);
            ball.moving = true;
          }
          if (!options.preview && ball.moving) {
            ball.spinnerSerial = (ball.spinnerSerial || 0) + 1;
            ball.lastImpactSpeed = Math.max(ball.lastImpactSpeed || 0, Math.abs(vn));
          }
        }
      }
    }

    resolveBottomSurfaces(ball, hole, options) {
      const r = CONFIG.ball.radius;
      let candidate = null;
      let bestDistance = Infinity;

      for (const surface of hole.surfaces) {
        if (surface.side !== 'bottom') continue;
        if (ball.x < surface.xMin - r || ball.x > surface.xMax + r) continue;
        const x = clamp(ball.x, surface.xMin, surface.xMax);
        const y = TerrainUtil.sampleSurface(surface, x);
        if (!Number.isFinite(y)) continue;
        const previousTop = (ball.prevY ?? ball.y) - r;
        const top = ball.y - r;
        const crossed = previousTop >= y - 2.5 && top <= y;
        const shallowPenetration = top <= y + 0.5 && ball.y >= y - r * 0.95 && ball.y <= y + r * 1.65;
        if (!crossed && !shallowPenetration) continue;
        const distance = Math.abs(top - y);
        if (distance < bestDistance) {
          bestDistance = distance;
          candidate = { surface, x, y };
        }
      }

      if (!candidate) return;
      const { x, y } = candidate;
      const surface = candidate.surface;
      const slope = TerrainUtil.surfaceSlope(surface, x);
      const normal = normalize({ x: -slope, y: 1 });
      const tangent = normalize({ x: 1, y: slope });
      const incomingNormal = dot({ x: ball.vx, y: ball.vy }, normal);
      const tangentSpeed = dot({ x: ball.vx, y: ball.vy }, tangent) * 0.992;
      ball.y = y + r;
      if (incomingNormal < 0) {
        const out = -incomingNormal * CONFIG.ball.roofBounce;
        ball.vx = tangent.x * tangentSpeed + normal.x * out;
        ball.vy = tangent.y * tangentSpeed + normal.y * out;
        if (!options.preview && -incomingNormal > 68) {
          ball.lastImpactSpeed = -incomingNormal;
          ball.impactSerial = (ball.impactSerial || 0) + 1;
        }
      }
    }

    resolveSolidWalls(ball, hole, options) {
      const walls = hole.solidWalls || [];
      const r = CONFIG.ball.radius;
      const r2 = r * r;

      for (const wall of walls) {
        const minX = Math.min(wall.x1, wall.x2) - r;
        const maxX = Math.max(wall.x1, wall.x2) + r;
        const minY = Math.min(wall.y1, wall.y2) - r;
        const maxY = Math.max(wall.y1, wall.y2) + r;
        if (ball.x < minX || ball.x > maxX || ball.y < minY || ball.y > maxY) continue;

        const sx = wall.x2 - wall.x1;
        const sy = wall.y2 - wall.y1;
        const len2 = sx * sx + sy * sy;
        if (len2 <= 0.000001) continue;
        const t = clamp(((ball.x - wall.x1) * sx + (ball.y - wall.y1) * sy) / len2, 0, 1);
        const qx = wall.x1 + sx * t;
        const qy = wall.y1 + sy * t;
        const dx = ball.x - qx;
        const dy = ball.y - qy;
        const dist2 = dx * dx + dy * dy;
        if (dist2 >= r2) continue;

        let nx;
        let ny;
        const dist = Math.sqrt(Math.max(0, dist2));
        if (dist > 0.0001) {
          nx = dx / dist;
          ny = dy / dist;
        } else {
          const invLen = 1 / Math.sqrt(len2);
          const px = -sy * invLen;
          const py = sx * invLen;
          const prevSide = ((ball.prevX ?? ball.x) - qx) * px + ((ball.prevY ?? ball.y) - qy) * py;
          const velocitySide = ball.vx * px + ball.vy * py;
          const sign = Math.sign(prevSide) || -Math.sign(velocitySide) || 1;
          nx = px * sign;
          ny = py * sign;
        }

        const penetration = r - dist;
        ball.x += nx * (penetration + 0.035);
        ball.y += ny * (penetration + 0.035);

        const vn = ball.vx * nx + ball.vy * ny;
        if (vn < 0) {
          const bounce = Number.isFinite(wall.bounce) ? wall.bounce : CONFIG.ball.groundBounce;
          ball.vx -= (1 + bounce) * vn * nx;
          ball.vy -= (1 + bounce) * vn * ny;
          const tangentX = -ny;
          const tangentY = nx;
          const tangentSpeed = (ball.vx * tangentX + ball.vy * tangentY) * 0.997;
          const normalSpeed = ball.vx * nx + ball.vy * ny;
          ball.vx = tangentX * tangentSpeed + nx * normalSpeed;
          ball.vy = tangentY * tangentSpeed + ny * normalSpeed;

          if (!options.preview && -vn > 58) {
            ball.lastImpactSpeed = Math.max(ball.lastImpactSpeed || 0, -vn);
            ball.impactSerial = (ball.impactSerial || 0) + 1;
            ball.wallSerial = (ball.wallSerial || 0) + 1;
          }
        }
      }
    }

    resolveBumpers(ball, hole, options) {
      for (const bumper of hole.hazards) {
        if (bumper.type !== 'bumper') continue;
        const dx = ball.x - bumper.x;
        const dy = ball.y - bumper.y;
        const minDist = CONFIG.ball.radius + bumper.radius;
        const dist = Math.hypot(dx, dy);
        if (dist <= 0 || dist >= minDist) continue;
        const nx = dx / dist;
        const ny = dy / dist;
        ball.x = bumper.x + nx * minDist;
        ball.y = bumper.y + ny * minDist;
        const vn = ball.vx * nx + ball.vy * ny;
        if (vn < 0) {
          ball.vx -= (1 + bumper.bounce) * vn * nx;
          ball.vy -= (1 + bumper.bounce) * vn * ny;
          if (!options.preview) {
            ball.lastImpactSpeed = Math.max(ball.lastImpactSpeed || 0, -vn);
            ball.impactSerial = (ball.impactSerial || 0) + 1;
          }
        }
      }
    }

    /**
     * Pozos de gravedad.
     *
     * Repulsión y atracción no son el mismo campo con el signo cambiado, y
     * tratarlas igual es justo lo que los volvía o inofensivos o injugables.
     * Empujar hacia fuera es seguro por construcción —por muy fuerte que sea,
     * un repulsor no puede quedarse con la bola—, así que va a plena potencia.
     * Atraer no lo es: un tirón radial fuerte termina con la bola orbitando el
     * centro hasta que alguien resetea, y eso no es un obstáculo, es una
     * partida colgada.
     *
     * Por eso la atracción se aplica casi toda PERPENDICULAR a la velocidad,
     * que es la componente que dobla el vuelo sin cambiar la rapidez, y su
     * parte radial solo actúa mientras la bola se ACERCA: acelera al entrar y
     * no le cobra esa energía al salir, así que la bola se va siempre con algo
     * más de la que traía. Escapar no depende del azar, sale de la forma del
     * campo. Encima van dos seguros más —un núcleo sin fuerza y un tiempo
     * máximo de agarre— para que el caso raro tampoco atrape a nadie.
     */
    applyGravityWells(ball, hole, dt, options) {
      const cfg = CONFIG.gravityWell;
      // El agarre acumulado se lee del frame anterior y se actualiza al final:
      // así todos los pozos de la misma pasada ven el mismo valor.
      const hold = Number(ball.gravityHold) || 0;
      const release = 1 - smoothstep((hold - cfg.holdReleaseSeconds) / Math.max(0.01, cfg.holdFadeSeconds));
      let pulling = false;
      for (const well of hole.hazards) {
        if (well.type !== 'gravity-well') continue;
        const dx = well.x - ball.x;
        const dy = well.y - ball.y;
        const dist = Math.hypot(dx, dy);
        const influence = well.radius * cfg.influenceScale;
        if (dist < 1 || dist > influence) continue;
        const nx = dx / dist;
        const ny = dy / dist;
        const reach = 1 - dist / influence;
        const power = Math.abs(well.strength);
        const spin = well.spin || 1;
        let weight = 0;

        if (well.strength < 0) {
          weight = Math.pow(reach, cfg.repelFalloff);
          const accel = power * cfg.repelScale * weight;
          ball.vx -= nx * accel * dt;
          ball.vy -= ny * accel * dt;
          const swirl = power * cfg.repelSwirl * weight * spin;
          ball.vx += -ny * swirl * dt;
          ball.vy += nx * swirl * dt;
        } else {
          const speed = Math.hypot(ball.vx, ball.vy);
          if (speed <= cfg.attractMinSpeed) continue;
          // Seguro 1: el núcleo no tira. Sin fondo al que caer, la bola cruza
          // el centro recta en vez de quedarse dando vueltas dentro.
          const core = smoothstep(dist / Math.max(1, well.radius * cfg.attractCoreRatio));
          // Seguro 3: cuanto más lenta llega la bola, menos la agarra el pozo.
          const fast = smoothstep((speed - cfg.attractMinSpeed) / Math.max(1, cfg.attractFullSpeed - cfg.attractMinSpeed));
          weight = Math.pow(reach, cfg.attractFalloff) * core * fast * release;
          if (weight <= 0.001) continue;
          const accel = power * cfg.attractScale * weight;
          const ux = ball.vx / speed;
          const uy = ball.vy / speed;
          // Descomposición del tirón respecto a la marcha de la bola.
          const along = nx * ux + ny * uy;
          ball.vx += (nx - ux * along) * accel * dt;
          ball.vy += (ny - uy * along) * accel * dt;
          // Seguro 2: la parte radial solo mientras se acerca.
          if (along > 0) {
            const pull = accel * along * cfg.attractPullScale;
            ball.vx += ux * pull * dt;
            ball.vy += uy * pull * dt;
          }
          const swirl = power * cfg.attractSwirl * weight * spin;
          ball.vx += -ny * swirl * dt;
          ball.vy += nx * swirl * dt;
          if (weight > 0.02) pulling = true;
        }

        if (!options.preview && weight > 0.16) ball.gravityPulse = Math.max(ball.gravityPulse || 0, weight);
      }
      // El contador solo corre con atractores encima: la repulsión no necesita
      // válvula de escape, y sumarla ahí apagaría el imán del pozo siguiente.
      ball.gravityHold = pulling
        ? hold + dt
        : Math.max(0, hold - dt * 2.5);
    }

    /**
     * Succión de la copa.
     *
     * El radio es corto a propósito: esto no está para corregir un tiro malo
     * desde lejos, sino para resolver el caso que más frustra —la bola que
     * roza el borde y sigue de largo por dos píxeles—. Fuera del borde
     * inmediato apenas se nota, porque la caída es muy pronunciada.
     *
     * El factor de velocidad es lo que separa los dos casos: una bola lanzada
     * lleva demasiada energía para que el imán la doble y pasa de largo; una
     * que llega rodando se va dentro.
     */
    applyHoleSuction(ball, hole, dt, options) {
      const cfg = CONFIG.gameplay;
      const radius = cfg.holeSuctionRadius;
      if (!(radius > 0) || !(cfg.holeSuctionStrength > 0) || ball.holed || !hole.cup) return;
      // Se apunta al centro que tendría la bola apoyada en el borde, no al
      // punto de la copa: si no, el tirón la empuja contra el suelo.
      const dx = hole.cup.x - ball.x;
      const dy = (hole.cup.y - CONFIG.ball.radius) - ball.y;
      const dist = Math.hypot(dx, dy);
      if (dist < 0.5 || dist > radius) return;
      const weight = Math.pow(1 - dist / radius, cfg.holeSuctionFalloff);
      const speed = Math.hypot(ball.vx, ball.vy);
      const speedFactor = clamp(1 - speed / Math.max(1, cfg.holeSuctionMaxSpeed), cfg.holeSuctionMinFactor, 1);
      const accel = cfg.holeSuctionStrength * weight * speedFactor;
      ball.vx += (dx / dist) * accel * dt;
      ball.vy += (dy / dist) * accel * dt;
    }

    /**
     * Bola parada en el labio de la copa.
     *
     * La succión solo actúa sobre bolas en movimiento, así que sin esto una
     * bola que se detiene rozando el borde se queda ahí para siempre. Aquí se
     * la despierta: a partir de ese momento manda `applyHoleSuction`, que la
     * mete o la deja fuera según lo cerca que estuviera de verdad.
     */
    settleIntoCup(ball, hole) {
      const radius = CONFIG.gameplay.holeSettleRadius;
      if (!(radius > 0) || ball.holed || ball.inWater || ball.caveRide || !hole.cup) return;
      const dx = hole.cup.x - ball.x;
      const dy = (hole.cup.y - CONFIG.ball.radius) - ball.y;
      if (Math.hypot(dx, dy) > radius) return;
      ball.moving = true;
    }

    resolveSecretCaves(ball, hole, options) {
      if (ball.specialCooldown > 0 || ball.caveRide) return;
      const r = CONFIG.ball.radius;
      for (const cave of hole.hazards) {
        if (cave.type !== 'secret-cave') continue;
        const endpoints = [
          { x: cave.entranceX, surfaceId: cave.entranceSurfaceId, reverse: false },
          { x: cave.exitX, surfaceId: cave.exitSurfaceId, reverse: true },
        ];
        for (const endpoint of endpoints) {
          const surface = TerrainUtil.findSurface(hole, endpoint.surfaceId);
          if (!surface) continue;
          const surfaceY = TerrainUtil.sampleSurface(surface, endpoint.x);
          if (!Number.isFinite(surfaceY)) continue;
          if (Math.abs(ball.x - endpoint.x) > cave.entranceRadius + r * 0.35) continue;
          const nearSurface = ball.y + r >= surfaceY - 8 && ball.y - r <= surfaceY + 34;
          if (!nearSurface || ball.vy < -180) continue;

          ball.caveRide = {
            cave,
            reverse: endpoint.reverse,
            t: 0,
            duration: Math.max(0.45, cave.duration || 0.9),
            entrySpeed: Math.max(180, Math.hypot(ball.vx, ball.vy)),
          };
          ball.lastCaveId = cave.caveId || null;
          ball.vx = 0;
          ball.vy = 0;
          ball.moving = true;
          ball.onSurface = false;
          if (!options.preview) {
            if (!options.speculative) {
              cave.discovered = true;
              cave.discoverySerial = (cave.discoverySerial || 0) + 1;
            }
            ball.caveSerial = (ball.caveSerial || 0) + 1;
          }
          return;
        }
      }
    }

    updateSecretCaveRide(ball, hole, dt, options) {
      const ride = ball.caveRide;
      if (!ride || !ride.cave) {
        ball.caveRide = null;
        return;
      }
      this.time += dt;
      const cave = ride.cave;
      const reverse = !!ride.reverse;
      ride.t = clamp(ride.t + dt / ride.duration, 0, 1);
      const t = ride.t;
      const u = 1 - t;
      const ex = reverse ? cave.exitX : cave.entranceX;
      const ey = (reverse ? cave.exitY : cave.entranceY) + CONFIG.ball.radius * 0.25;
      const cx = cave.controlX;
      const cy = cave.controlY;
      const xx = reverse ? cave.entranceX : cave.exitX;
      const xy = (reverse ? cave.entranceY : cave.exitY) + CONFIG.ball.radius * 0.25;
      ball.prevX = ball.x;
      ball.prevY = ball.y;
      ball.x = u * u * ex + 2 * u * t * cx + t * t * xx;
      ball.y = u * u * ey + 2 * u * t * cy + t * t * xy;
      ball.onSurface = false;

      if (t < 1) return;
      const targetSurfaceId = reverse ? cave.entranceSurfaceId : cave.exitSurfaceId;
      const surface = TerrainUtil.findSurface(hole, targetSurfaceId);
      const surfaceY = surface ? TerrainUtil.sampleSurface(surface, xx) : xy;
      const tx = xx - cave.controlX;
      const ty = (reverse ? cave.entranceY : cave.exitY) - cave.controlY;
      const mag = Math.max(0.001, Math.hypot(tx, ty));
      const nx = tx / mag;
      const ny = ty / mag;
      const power = Math.max(cave.exitPower || 380, ride.entrySpeed * 0.58);
      ball.x = xx + nx * (CONFIG.ball.radius + 5);
      ball.y = (Number.isFinite(surfaceY) ? surfaceY - CONFIG.ball.radius : xy - CONFIG.ball.radius) + ny * 4;
      ball.vx = nx * power;
      ball.vy = ny * power;
      ball.caveRide = null;
      ball.specialCooldown = CONFIG.gameplay.secretCaveCooldownSeconds;
      ball.lastSurfaceId = targetSurfaceId;
      ball.lastSafe = { x: ball.x, y: ball.y, surfaceId: targetSurfaceId };
      if (!options.preview) ball.caveExitSerial = (ball.caveExitSerial || 0) + 1;
    }

    applyFanFields(ball, hole, dt, options) {
      for (const fan of hole.hazards) {
        if (fan.type !== 'fan') continue;
        const dx = ball.x - fan.x;
        const dy = ball.y - fan.y;
        const ca = Math.cos(-(fan.angle || 0));
        const sa = Math.sin(-(fan.angle || 0));
        const lx = dx * ca - dy * sa;
        const ly = dx * sa + dy * ca;
        if (lx < -fan.width * 0.6 || lx > fan.range) continue;
        if (Math.abs(ly) > fan.fieldHeight * 0.5) continue;
        const xT = 1 - clamp(lx / Math.max(1, fan.range), 0, 1);
        const yT = 1 - clamp(Math.abs(ly) / Math.max(1, fan.fieldHeight * 0.5), 0, 1);
        const weight = xT * xT * yT;
        const fx = Math.cos(fan.angle) * fan.force * weight;
        const fy = Math.sin(fan.angle) * fan.force * weight;
        ball.vx += fx * dt;
        ball.vy += fy * dt;
        if (!options.preview && weight > 0.2) ball.fanPulse = 1;
      }
    }

    resolvePortals(ball, hole, options) {
      if (ball.portalCooldown > 0) return;
      const r = CONFIG.ball.radius;
      for (const portal of hole.hazards) {
        if (portal.type !== 'portal') continue;
        if (portal.consumed) continue;
        // Los pares son direccionales: el aro de salida nunca vuelve a aceptar la bola.
        // Esto elimina el ping-pong A↔B y hace que el sentido sea legible y estable.
        if (portal.portalRole === 'exit' || portal.entryEnabled === false) continue;
        const dx = ball.x - portal.x;
        const dy = ball.y - portal.y;
        const dist = Math.hypot(dx, dy);
        if (dist > portal.radius + r * 0.35) continue;
        const mate = hole.hazards.find((h) => h.type === 'portal' && h.pairId === portal.pairId && h.portalRole === 'exit');
        if (!mate || mate.consumed) continue;
        const exitAngle = Number.isFinite(mate.heading) ? mate.heading : 0;
        const exitOffset = mate.radius + r + CONFIG.gameplay.portalExitClearance;
        ball.x = mate.x + Math.cos(exitAngle) * exitOffset;
        ball.y = mate.y + Math.sin(exitAngle) * exitOffset;
        const forwardBoost = 105;
        ball.vx += Math.cos(exitAngle) * forwardBoost;
        ball.vy += Math.sin(exitAngle) * forwardBoost;
        ball.portalCooldown = CONFIG.gameplay.portalCooldownSeconds;
        ball.lastPortalPairId = portal.pairId;
        ball.lastPortalExitIndex = mate.portalIndex;
        if (!options.preview) {
          if (!options.speculative) {
            for (const member of hole.hazards) {
              if (member.type === 'portal' && member.pairId === portal.pairId) member.consumed = true;
            }
          }
          ball.portalSerial = (ball.portalSerial || 0) + 1;
        }
        break;
      }
    }

    /**
     * Cañones, en sus dos sabores.
     *
     * El normal te dispara hacia el hoyo. El de retroceso hace exactamente lo
     * contrario y con más fuerza: es la única pieza del mapa que quita
     * progreso, y por eso solo hay una por mundo.
     *
     * Comparten disparador —pisar la placa estando apoyado— y eso es
     * deliberado: si uno saltara al rozarlo y el otro no, el jugador no podría
     * predecir ninguno de los dos. La diferencia tiene que estar en lo que
     * hacen y en cómo se ven, nunca en cuándo se activan.
     */
    resolveCannons(ball, hole, options) {
      if (ball.specialCooldown > 0 || !ball.onSurface) return;
      const r = CONFIG.ball.radius;
      for (const cannon of hole.hazards) {
        const reverse = cannon.type === 'reverse-cannon';
        if (!reverse && cannon.type !== 'cannon') continue;
        // El de retroceso solo dispara UNA vez por golpe. Sin esto, la bola
        // que sale despedida y luego vuelve rodando cuesta abajo se vuelve a
        // meter dentro: medido en simulación, hasta seis disparos seguidos en
        // el mismo tiro. Deja de leerse como un obstáculo y pasa a parecer un
        // fallo. Se recarga con el siguiente golpe.
        if (reverse && ball.reverseCannonSpent) continue;
        const surface = TerrainUtil.findSurface(hole, cannon.surfaceId);
        if (!surface) continue;
        const surfaceY = TerrainUtil.sampleSurface(surface, cannon.x);
        if (Math.abs(ball.x - cannon.x) > cannon.width * 0.55) continue;
        if (Math.abs((ball.y + r) - surfaceY) > 16) continue;
        ball.vx = Math.cos(cannon.angle) * cannon.power;
        ball.vy = Math.sin(cannon.angle) * cannon.power;
        ball.moving = true;
        ball.specialCooldown = CONFIG.gameplay.specialCooldownSeconds;
        if (reverse) ball.reverseCannonSpent = true;
        if (!options.preview) {
          if (reverse) ball.reverseSerial = (ball.reverseSerial || 0) + 1;
          else ball.cannonSerial = (ball.cannonSerial || 0) + 1;
        }
        break;
      }
    }

    resolveMultipliers(ball, hole, options) {
      // Recoger el multiplicador no altera la trayectoria, así que la
      // predicción puede ignorarlo por completo y dejárselo a la autoridad.
      if (options.speculative) return;
      for (const multiplier of hole.hazards) {
        if (multiplier.type !== 'multiplier' || multiplier.collected) continue;
        const dx = ball.x - multiplier.x;
        const dy = ball.y - multiplier.y;
        if (Math.hypot(dx, dy) > multiplier.radius + CONFIG.ball.radius * 0.62) continue;
        multiplier.collected = true;
        hole.scoreMultiplierCollected = true;
        if (!options.preview) ball.multiplierSerial = (ball.multiplierSerial || 0) + 1;
        break;
      }
    }

    resolveWater(ball, hole, options = {}) {
      const r = CONFIG.ball.radius;
      for (let index = 0; index < hole.hazards.length; index += 1) {
        const water = hole.hazards[index];
        if (water.type !== 'water') continue;
        if (ball.x < water.x - water.width / 2 || ball.x > water.x + water.width / 2) continue;
        const surfaceY = water.surfaceY;
        if (ball.y + r < surfaceY) continue;
        if (ball.y - r > surfaceY + water.depth + 80) continue;
        if (this.trySkipOnWater(ball, water, index, options)) return;
        ball.inWater = true;
        ball.moving = false;
        ball.vx = 0;
        ball.vy = 0;
        return;
      }
    }

    /**
     * Piedra picada sobre el agua.
     *
     * Una bola que llega RASA y RÁPIDA no se hunde: toca la lámina y sale
     * despedida, como una piedra lanzada de canto. Es lo que convierte la
     * charca en una apuesta —cruzarla por arriba— en vez de un muro que solo
     * castiga, y exige las dos cosas a la vez, porque cualquiera de ellas
     * sola es un tiro normal: ángulo rasante y velocidad de verdad.
     *
     * La ventana de ángulo se ensancha con la velocidad, igual que en el agua
     * real: un misil raso perdona un picado que un globo no.
     *
     * El límite de picados es POR CHARCA, no por tiro: cruzar dos estanques
     * en el mismo golpe da dos oportunidades, pero rebotar tres veces en el
     * mismo nunca. Al tercer contacto gana el agua.
     */
    trySkipOnWater(ball, water, zoneIndex, options) {
      const cfg = CONFIG.water;
      if (!(cfg.skipMaxBounces > 0)) return false;
      // Solo pica quien llega desde arriba y bajando. Una bola que ya está
      // dentro, o que sube, no tiene nada contra lo que rebotar.
      if (!(ball.vy > 0)) return false;
      const r = CONFIG.ball.radius;
      const surfaceY = water.surfaceY;
      const previousBottom = (Number.isFinite(ball.prevY) ? ball.prevY : ball.y) + r;
      if (previousBottom > surfaceY + cfg.skipEntryTolerance) return false;
      const speed = Math.hypot(ball.vx, ball.vy);
      if (speed < cfg.skipMinSpeed) return false;
      const reach = clamp((speed - cfg.skipMinSpeed) / Math.max(1, cfg.skipFullSpeed - cfg.skipMinSpeed), 0, 1);
      const maxAngle = lerp(cfg.skipMinAngleDegrees, cfg.skipMaxAngleDegrees, reach) * Math.PI / 180;
      if (Math.atan2(ball.vy, Math.abs(ball.vx)) > maxAngle) return false;
      const used = ball.waterSkipZone === zoneIndex ? (Number(ball.waterSkips) || 0) : 0;
      if (used >= cfg.skipMaxBounces) return false;

      ball.y = surfaceY - r - cfg.skipClearance;
      ball.vx *= cfg.skipHorizontalKeep;
      // El suelo de impulso es lo que separa un picado de un roce: sin él, una
      // entrada casi horizontal sale tan pegada a la lámina que vuelve a tocar
      // al instante y gasta los dos picados en el mismo palmo de agua.
      ball.vy = -Math.max(ball.vy * cfg.skipVerticalBounce, cfg.skipMinLift);
      ball.waterSkipZone = zoneIndex;
      ball.waterSkips = used + 1;
      ball.inWater = false;
      if (!options.preview) {
        ball.waterSkipSerial = (ball.waterSkipSerial || 0) + 1;
        ball.lastWaterSkipX = ball.x;
        ball.lastWaterSkipY = surfaceY;
      }
      return true;
    }

    resolveHole(ball, hole, options) {
      const dx = ball.x - hole.cup.x;
      const dy = ball.y + CONFIG.ball.radius - hole.cup.y;
      const close = Math.abs(dx) < CONFIG.gameplay.holeRadius;
      const slowEnough = Math.abs(ball.vx) < 205 && Math.abs(ball.vy) < 135;
      const nearSurface = Math.abs(dy) < 14;
      const impactVx = Number(ball.topImpactVx);
      const impactVy = Number(ball.topImpactVy);
      const previousBottom = (ball.prevY ?? ball.y) + CONFIG.ball.radius;
      const enteredFromAbove = Number.isFinite(impactVx)
        && Number.isFinite(impactVy)
        && impactVy > 0
        && previousBottom <= hole.cup.y + 2.5;
      const entryAngle = enteredFromAbove ? Math.atan2(impactVy, Math.abs(impactVx)) : 0;
      const steepEntryAngle = (CONFIG.gameplay.steepHoleEntryDegrees || 50) * Math.PI / 180;
      const steepEntry = enteredFromAbove && entryAngle >= steepEntryAngle;
      // Captura por succión: quien llega rodando al borde con poca energía
      // entra, sin depender del ángulo exacto que exige la entrada clásica.
      const radial = Math.hypot(dx, dy);
      const sucked = radial < CONFIG.gameplay.holeCaptureRadius
        && Math.hypot(ball.vx, ball.vy) < CONFIG.gameplay.holeCaptureSpeed;
      if (sucked || (close && nearSurface && (slowEnough || steepEntry))) {
        ball.x = hole.cup.x;
        ball.y = hole.cup.y + CONFIG.gameplay.cupDepth;
        ball.vx = 0;
        ball.vy = 0;
        ball.moving = false;
        ball.holed = true;
        if (!options.preview) ball.holeSerial = (ball.holeSerial || 0) + 1;
      }
    }

    simulatePreview(start, launchVelocity, hole, steps = CONFIG.shot.previewSteps, dt = CONFIG.shot.previewDt) {
      const ball = {
        x: start.x,
        y: start.y,
        vx: launchVelocity.x,
        vy: launchVelocity.y,
        moving: true,
        holed: false,
        boosterCooldown: start.boosterCooldown || 0,
        portalCooldown: start.portalCooldown || 0,
        specialCooldown: start.specialCooldown || 0,
        lastSafe: { x: start.x, y: start.y, surfaceId: start.lastSurfaceId || start.surfaceId },
        lastSurfaceId: start.lastSurfaceId || start.surfaceId,
        inWater: false,
        waterSkips: 0,
        waterSkipZone: null,
        gravityHold: 0,
        reverseCannonSpent: false,
      };
      const path = [];
      const savedTime = this.time;
      const savedMultiplier = !!hole.scoreMultiplierCollected;
      const multiplierHazards = hole.hazards.filter((h) => h.type === 'multiplier');
      const savedMultipliers = multiplierHazards.map((h) => h.collected);
      const caveHazards = hole.hazards.filter((h) => h.type === 'secret-cave');
      const savedCaves = caveHazards.map((h) => h.discovered);
      for (let i = 0; i < steps; i += 1) {
        path.push({ x: ball.x, y: ball.y });
        this.update(ball, hole, dt, { preview: true });
        if (!ball.moving || ball.holed || ball.inWater) break;
      }
      multiplierHazards.forEach((h, index) => { h.collected = savedMultipliers[index]; });
      caveHazards.forEach((h, index) => { h.discovered = savedCaves[index]; });
      hole.scoreMultiplierCollected = savedMultiplier;
      this.time = savedTime;
      return path;
    }
  }

  NG.PhysicsEngine = PhysicsEngine;
}(window.NoiseGolf = window.NoiseGolf || {}));
