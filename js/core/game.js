(function (NG) {
  'use strict';

  const {
    CONFIG, TerrainGenerator, PhysicsEngine, HUD, Camera2D, ParticleSystem, WorldRenderer,
  } = NG;
  const { clamp, distance, hashString } = NG.MathUtil;

  class GolfGame {
    constructor(canvas) {
      if (!canvas) throw new Error('Canvas #game no encontrado.');
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      if (!this.ctx) throw new Error('Canvas 2D no disponible en este navegador.');

      this.physics = new PhysicsEngine();
      this.hud = new HUD();
      this.camera = new Camera2D();
      this.particles = new ParticleSystem();
      this.renderer = new WorldRenderer();
      this.seed = this.makeSeed();
      this.holeIndex = 0;
      this.holes = [];
      this.hole = null;
      this.strokes = 0;
      this.totalScore = 0;
      this.arcadePoints = 0;
      this.ball = null;
      this.dragging = false;
      this.pointer = { x: 0, y: 0 };
      this.lastTimestamp = 0;
      this.pausedForResult = false;
      this.dpr = 1;
      this.trail = [];
      this.handledImpactSerial = 0;
      this.handledBoosterSerial = 0;
      this.handledHoleSerial = 0;
      this.handledPortalSerial = 0;
      this.handledCannonSerial = 0;
      this.handledMultiplierSerial = 0;
      this.handledCaveSerial = 0;
      this.handledCaveExitSerial = 0;
      this.networkSession = null;
      this.inputLocked = true;
      // La simulación local avanza en pasos fijos: los FPS ya no cambian el
      // resultado de la física, solo cuántos pasos se consumen por frame.
      this.fixedStep = new NG.FixedStep(NG.NET_CONFIG?.simulationHz || 60);
      // Estado anterior al último paso fijo; permite interpolar el render
      // cuando la pantalla va más rápido que la simulación.
      this.simPrev = { x: 0, y: 0, valid: false };
      this.renderBall = null;

      this.bindEvents();
      this.resize();
      this.startNewCourse(this.seed);
    }

    makeSeed() {
      return `${Date.now().toString(36).slice(-6)}-${Math.floor(Math.random() * 46656).toString(36).padStart(3, '0')}`;
    }

    viewport() {
      return {
        width: this.canvas.clientWidth || window.innerWidth || 1280,
        height: this.canvas.clientHeight || window.innerHeight || 720,
      };
    }

    bindEvents() {
      window.addEventListener('resize', () => this.resize());
      this.canvas.addEventListener('pointerdown', (e) => this.onPointerDown(e));
      this.canvas.addEventListener('pointermove', (e) => this.onPointerMove(e));
      window.addEventListener('pointerup', (e) => this.onPointerUp(e));
      window.addEventListener('pointercancel', () => this.cancelDrag());
      this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
      window.addEventListener('keydown', (e) => {
        if (e.key.toLowerCase() === 'r' && !this.pausedForResult && !this.inputLocked) {
          this.returnToShotOrigin();
        }
      });

      const newCourse = document.querySelector('#newCourseBtn');
      const continueBtn = document.querySelector('#continueBtn');
      if (newCourse) newCourse.addEventListener('click', () => {
        if (this.networkSession?.getStatus().online) {
          this.hud.flashStatus('Sal de la partida online para crear un campo nuevo', 'neutral', 1.2);
          return;
        }
        this.startNewCourse(this.makeSeed());
      });
      if (continueBtn) continueBtn.addEventListener('click', () => this.continueAfterResult());
    }

    cancelDrag() {
      this.dragging = false;
    }

    resize() {
      this.dpr = Math.min(CONFIG.rendering.maxDpr, window.devicePixelRatio || 1);
      const rect = this.canvas.getBoundingClientRect();
      const width = Math.max(1, Math.floor((rect.width || window.innerWidth || 1280) * this.dpr));
      const height = Math.max(1, Math.floor((rect.height || window.innerHeight || 720) * this.dpr));
      if (this.canvas.width !== width) this.canvas.width = width;
      if (this.canvas.height !== height) this.canvas.height = height;
      this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      if (this.ball && this.hole) this.camera.clampToBounds(this.hole, this.viewport());
    }

    startNewCourse(seedText, options = {}) {
      this.seed = String(seedText || this.makeSeed());
      const generator = new TerrainGenerator(hashString(this.seed), { allowedArchetypes: options.allowedArchetypes });
      this.physics.time = 0;
      this.holes = Array.from({ length: CONFIG.course.holeCount }, (_, i) => generator.generateHole(i));
      const multiplierHoleIndex = hashString(`${this.seed}:score-multiplier`) % this.holes.length;
      generator.placeScoreMultiplier(this.holes[multiplierHoleIndex]);
      this.holeIndex = 0;
      this.totalScore = 0;
      this.arcadePoints = 0;
      this.hud.hideResult();
      this.pausedForResult = false;
      this.loadHole(0);
      if (!options.quiet) this.hud.flashStatus('Nuevo campo procedural', 'good', 1.25);
    }

    loadHole(index) {
      this.holeIndex = index;
      this.hole = this.holes[index];
      this.hole.scoreMultiplierCollected = false;
      for (const hazard of this.hole.hazards) {
        if (hazard.type === 'multiplier') hazard.collected = false;
        if (hazard.type === 'secret-cave') hazard.discovered = false;
        if (hazard.type === 'portal') hazard.consumed = false;
      }
      this.strokes = 0;
      this.ball = {
        x: this.hole.tee.x,
        y: this.hole.tee.y,
        vx: 0,
        vy: 0,
        moving: false,
        holed: false,
        inWater: false,
        boosterCooldown: 0,
        portalCooldown: 0,
        specialCooldown: 0,
        boosterPulse: 0,
        fanPulse: 0,
        lastSafe: { x: this.hole.tee.x, y: this.hole.tee.y, surfaceId: this.hole.tee.surfaceId },
        shotOrigin: { x: this.hole.tee.x, y: this.hole.tee.y, surfaceId: this.hole.tee.surfaceId },
        lastSurfaceId: this.hole.tee.surfaceId,
        impactSerial: 0,
        boosterSerial: 0,
        holeSerial: 0,
        portalSerial: 0,
        cannonSerial: 0,
        multiplierSerial: 0,
        caveSerial: 0,
        caveExitSerial: 0,
        gravityPulse: 0,
        movingWallSerial: 0,
        spinnerSerial: 0,
        lastPortalPairId: null,
        lastPortalExitIndex: null,
        caveRide: null,
        crushed: false,
      };
      this.dragging = false;
      this.trail.length = 0;
      this.particles.clear();
      this.handledImpactSerial = 0;
      this.handledBoosterSerial = 0;
      this.handledHoleSerial = 0;
      this.handledPortalSerial = 0;
      this.handledCannonSerial = 0;
      this.handledMultiplierSerial = 0;
      this.handledCaveSerial = 0;
      this.handledCaveExitSerial = 0;
      this.camera = new Camera2D();
      this.camera.snapTo(this.ball, this.hole, this.viewport());
      this.lastTimestamp = 0;
      this.fixedStep.reset();
      this.simPrev = { x: this.ball.x, y: this.ball.y, valid: false };
      this.renderBall = this.ball;
      this.hud.flashStatus(`${this.hole.archetypeLabel} · ${this.hole.mapSize}`, 'neutral', 1.4);
    }

    screenToWorld(clientX, clientY) {
      const rect = this.canvas.getBoundingClientRect();
      return this.camera.screenToWorld(clientX - rect.left, clientY - rect.top);
    }

    onPointerDown(e) {
      if (this.inputLocked || this.pausedForResult || !this.ball || this.ball.moving || this.ball.holed || this.ball.inWater) return;
      if (this.networkSession?.getStatus().online && !this.networkSession.canLocalShoot()) {
        const status = this.networkSession.getStatus();
        this.hud.flashStatus(status.state === 'spectating' ? 'Espectador hasta el próximo hoyo' : 'Espera tu turno o a que la bola se detenga', 'neutral', 0.85);
        return;
      }
      const p = this.screenToWorld(e.clientX, e.clientY);
      if (distance(p, this.ball) > 58 / Math.max(0.75, this.camera.zoom)) return;
      this.dragging = true;
      this.pointer = p;
      this.canvas.setPointerCapture?.(e.pointerId);
    }

    onPointerMove(e) {
      if (!this.ball) return;
      this.pointer = this.screenToWorld(e.clientX, e.clientY);
    }

    onPointerUp(e) {
      if (!this.dragging || !this.ball) return;
      this.pointer = this.screenToWorld(e.clientX, e.clientY);
      const velocity = this.computeLaunchVelocity();
      this.dragging = false;
      const speed = Math.hypot(velocity.x, velocity.y);
      if (speed < CONFIG.shot.minLaunchSpeed) return;
      if (this.networkSession?.getStatus().online) {
        if (!this.networkSession.submitShot(velocity)) {
          this.hud.flashStatus('El host rechazó ese tiro', 'neutral', 0.9);
          return;
        }
      } else {
        this.physics.resetMotionGuard(this.ball);
        this.ball.shotOrigin = {
          x: this.ball.x,
          y: this.ball.y,
          surfaceId: this.ball.lastSurfaceId || this.ball.lastSafe?.surfaceId || this.hole.tee.surfaceId,
        };
        this.ball.vx = velocity.x;
        this.ball.vy = velocity.y;
        this.ball.moving = true;
        this.ball.inWater = false;
        this.ball.lastImpactSpeed = 0;
        this.strokes += 1;
      }
      this.trail.length = 0;
      const direction = Math.atan2(-velocity.y, -velocity.x);
      this.particles.emitBurst(this.ball.x, this.ball.y, {
        count: 8,
        angle: direction,
        spread: 0.9,
        speedMin: 28,
        speedMax: 105,
        gravity: 150,
        lifeMin: 0.18,
        lifeMax: 0.42,
        colors: ['#ffffff', this.hole.theme.accent],
        sizeMin: 1.5,
        sizeMax: 3.2,
        glow: 5,
        shape: 'spark',
      });
    }

    computeLaunchVelocity() {
      if (!this.ball) return { x: 0, y: 0 };
      const dx = this.ball.x - this.pointer.x;
      const dy = this.ball.y - this.pointer.y;
      const length = Math.hypot(dx, dy);
      const scale = length > CONFIG.shot.maxDrag ? CONFIG.shot.maxDrag / length : 1;
      return { x: dx * scale * CONFIG.shot.powerScale, y: dy * scale * CONFIG.shot.powerScale };
    }

    aimPower() {
      if (!this.dragging || !this.ball) return 0;
      const velocity = this.computeLaunchVelocity();
      return clamp(Math.hypot(velocity.x, velocity.y) / CONFIG.ball.maxSpeed, 0, 1);
    }

    canReturnToShotOrigin() {
      if (!this.ball || this.ball.holed || this.pausedForResult) return false;
      if (this.networkSession?.getStatus().online) return this.networkSession.canRequestReset();
      return true;
    }

    returnToShotOrigin() {
      if (!this.canReturnToShotOrigin()) {
        this.hud.flashStatus('Vuelta al punto del tiro no disponible ahora', 'neutral', 0.9);
        return false;
      }
      if (this.networkSession?.getStatus().online) {
        if (!this.networkSession.requestReset()) {
          this.hud.flashStatus('Vuelta al punto del tiro no disponible ahora', 'neutral', 0.9);
          return false;
        }
      } else {
        this.resetBall(true, 'shot');
        this.hud.flashStatus('Vuelta al punto del tiro · +1 golpe', 'penalty');
      }
      return true;
    }

    resetBall(withPenalty = false, target = 'safe') {
      if (!this.ball || this.ball.holed) return false;
      if (withPenalty) this.strokes += 1;
      const tee = { x: this.hole.tee.x, y: this.hole.tee.y, surfaceId: this.hole.tee.surfaceId };
      const safe = target === 'shot'
        ? (this.ball.shotOrigin || this.ball.lastSafe || tee)
        : (this.ball.lastSafe || tee);
      this.ball.x = Number.isFinite(safe.x) ? safe.x : this.hole.tee.x;
      this.ball.y = Number.isFinite(safe.y) ? safe.y : this.hole.tee.y;
      this.ball.vx = 0;
      this.ball.vy = 0;
      this.ball.moving = false;
      this.ball.inWater = false;
      this.ball.holed = false;
      this.ball.boosterCooldown = 0;
      this.ball.portalCooldown = 0;
      this.ball.specialCooldown = 0;
      this.ball.caveRide = null;
      this.ball.crushed = false;
      this.ball.boosterPulse = 0;
      this.ball.gravityPulse = 0;
      this.ball.lastPortalPairId = null;
      this.ball.lastPortalExitIndex = null;
      this.ball.lastSurfaceId = safe.surfaceId || this.hole.tee.surfaceId;
      this.ball.lastSafe = { x: this.ball.x, y: this.ball.y, surfaceId: this.ball.lastSurfaceId };
      this.ball.shotOrigin = { ...this.ball.lastSafe };
      this.physics.resetMotionGuard(this.ball);
      this.dragging = false;
      this.trail.length = 0;
      this.simPrev = { x: this.ball.x, y: this.ball.y, valid: false };
      this.renderBall = this.ball;
      this.camera.snapTo(this.ball, this.hole, this.viewport());
      return true;
    }

    /**
     * Bola de presentación offline: mezcla el estado anterior y el actual con
     * la fracción de paso sobrante. Sin esto, una pantalla de 144 Hz vería los
     * 60 pasos por segundo de la simulación como micro-tirones.
     */
    updateRenderBall() {
      const ball = this.ball;
      if (!ball) return;
      const alpha = this.fixedStep.alpha;
      if (!this.simPrev.valid || !ball.moving || ball.holed || alpha <= 0) {
        this.renderBall = ball;
        return;
      }
      const dx = ball.x - this.simPrev.x;
      const dy = ball.y - this.simPrev.y;
      // Un salto grande es un portal o una cueva: eso no se interpola.
      if (Math.hypot(dx, dy) > 260) {
        this.renderBall = ball;
        return;
      }
      this.renderBall = { ...ball, x: this.simPrev.x + dx * alpha, y: this.simPrev.y + dy * alpha };
    }

    setInputLocked(value) {
      this.inputLocked = !!value;
      if (this.inputLocked) this.cancelDrag();
    }

    setNetworkSession(session) {
      this.networkSession = session || null;
    }

    continueAfterResult() {
      this.hud.hideResult();
      this.pausedForResult = false;
      if (this.holeIndex < this.holes.length - 1) this.loadHole(this.holeIndex + 1);
      else this.startNewCourse(this.makeSeed());
    }

    isOutOfWorld(ball) {
      const m = CONFIG.course.worldMargin;
      return ball.x < this.hole.bounds.minX - m
        || ball.x > this.hole.bounds.maxX + m
        || ball.y < this.hole.bounds.minY - CONFIG.course.topFlightMargin - m
        || ball.y > this.hole.bounds.maxY + CONFIG.course.bottomFallMargin;
    }

    handleEffects() {
      const ball = this.ball;
      if (!ball) return;
      if ((ball.impactSerial || 0) > this.handledImpactSerial) {
        this.handledImpactSerial = ball.impactSerial;
        const impactSpeed = ball.lastImpactSpeed || 0;
        const impact = clamp(impactSpeed / 420, 0.15, 1);
        // Solo sacude un golpe que de verdad suena. Los botes flojos del final
        // del tiro tenían suelo de sacudida y mantenían la cámara vibrando
        // justo cuando el jugador intenta leer dónde va a parar la bola.
        this.camera.addShake(clamp((impactSpeed - 270) / 520, 0, 1) * 9);
        this.particles.emitBurst(ball.x, ball.y + CONFIG.ball.radius * 0.65, {
          count: Math.round(5 + impact * 9),
          angle: -Math.PI / 2,
          spread: Math.PI * 0.85,
          speedMin: 35,
          speedMax: 120 + impact * 70,
          gravity: 360,
          lifeMin: 0.22,
          lifeMax: 0.60,
          colors: [this.hole.theme.grass, this.hole.theme.soil, '#d8efcf'],
          sizeMin: 1.6,
          sizeMax: 4.2,
        });
      }

      if ((ball.boosterSerial || 0) > this.handledBoosterSerial) {
        this.handledBoosterSerial = ball.boosterSerial;
        this.camera.addShake(5.5);
        this.hud.flashStatus('¡ACELERADOR!', 'boost', 0.7);
        this.particles.emitBurst(ball.x, ball.y, {
          count: 18,
          angle: Math.atan2(-ball.vy, -ball.vx),
          spread: 1.25,
          speedMin: 65,
          speedMax: 220,
          gravity: 90,
          lifeMin: 0.22,
          lifeMax: 0.55,
          colors: ['#64fff0', '#75ff8c', '#ffffff'],
          sizeMin: 1.5,
          sizeMax: 3.8,
          glow: 8,
          shape: 'spark',
        });
      }

      if ((ball.portalSerial || 0) > this.handledPortalSerial) {
        this.handledPortalSerial = ball.portalSerial;
        this.hud.flashStatus('Portal activado', 'neutral', 0.9);
        this.camera.addShake(3.2);
        this.particles.emitBurst(ball.x, ball.y, {
          count: 22,
          speedMin: 40,
          speedMax: 180,
          gravity: 60,
          lifeMin: 0.24,
          lifeMax: 0.62,
          colors: ['#ffffff', '#7a5dff', '#ff87d8'],
          sizeMin: 1.6,
          sizeMax: 3.8,
          glow: 10,
        });
      }

      if ((ball.cannonSerial || 0) > this.handledCannonSerial) {
        this.handledCannonSerial = ball.cannonSerial;
        this.hud.flashStatus('Cañón!', 'boost', 0.8);
        this.camera.addShake(6.5);
        this.particles.emitBurst(ball.x, ball.y, {
          count: 18,
          angle: Math.atan2(-ball.vy, -ball.vx),
          spread: 0.9,
          speedMin: 80,
          speedMax: 260,
          gravity: 85,
          lifeMin: 0.2,
          lifeMax: 0.5,
          colors: ['#ffe48a', '#ffffff', '#6cf7ff'],
          sizeMin: 2,
          sizeMax: 4.8,
          glow: 8,
        });
      }

      if ((ball.multiplierSerial || 0) > this.handledMultiplierSerial) {
        this.handledMultiplierSerial = ball.multiplierSerial;
        this.hud.flashStatus(`¡MULTIPLICADOR x${CONFIG.gameplay.scoreMultiplier}!`, 'good', 1.35);
        this.camera.addShake(3.8);
        this.particles.emitBurst(ball.x, ball.y - 10, {
          count: 28,
          speedMin: 45,
          speedMax: 180,
          gravity: 115,
          lifeMin: 0.42,
          lifeMax: 1.05,
          colors: ['#fff3a4', '#ffffff', '#7bffdc'],
          sizeMin: 2,
          sizeMax: 5.2,
          glow: 10,
          shape: 'spark',
        });
      }

      if ((ball.caveSerial || 0) > this.handledCaveSerial) {
        this.handledCaveSerial = ball.caveSerial;
        this.hud.flashStatus('¡Ruta secreta descubierta!', 'neutral', 1.15);
        this.camera.addShake(2.4);
      }

      if ((ball.caveExitSerial || 0) > this.handledCaveExitSerial) {
        this.handledCaveExitSerial = ball.caveExitSerial;
        this.particles.emitBurst(ball.x, ball.y, {
          count: 18, angle: Math.atan2(-ball.vy, -ball.vx), spread: 1.0,
          speedMin: 55, speedMax: 185, gravity: 80,
          lifeMin: 0.25, lifeMax: 0.65,
          colors: ['#7bffdc', '#7d6cff', '#ffffff'],
          sizeMin: 1.6, sizeMax: 4.0, glow: 8,
        });
      }

      if ((ball.holeSerial || 0) > this.handledHoleSerial) {
        this.handledHoleSerial = ball.holeSerial;
        this.particles.emitBurst(this.hole.cup.x, this.hole.cup.y - 18, {
          count: 34,
          speedMin: 80,
          speedMax: 270,
          gravity: 240,
          lifeMin: 0.55,
          lifeMax: 1.2,
          colors: [this.hole.theme.accent, '#ffffff', '#ffe48a'],
          sizeMin: 2,
          sizeMax: 5,
          glow: 6,
        });
        this.camera.addShake(4);
      }
    }

    update(dt) {
      if (!this.ball || !this.hole) return;
      // Presentación: un frame perdido no debe teletransportar la cámara ni
      // matar de golpe todas las partículas.
      const viewDt = Math.min(dt, 1 / 15);
      this.renderer.update(viewDt);
      this.particles.update(viewDt);
      this.hud.tick(viewDt);
      if (this.ball.boosterPulse > 0) this.ball.boosterPulse = Math.max(0, this.ball.boosterPulse - viewDt * 3.4);
      if (this.ball.gravityPulse > 0) this.ball.gravityPulse = Math.max(0, this.ball.gravityPulse - viewDt * 2.2);

      const online = !!this.networkSession?.getStatus().online;
      if (online) {
        // La sesión lleva su propio acumulador: el host simula en paso fijo y
        // el cliente interpola/predice cada frame.
        this.networkSession.update(dt);
      } else if (!this.pausedForResult) {
        this.fixedStep.run(dt, (step) => {
          this.simPrev.x = this.ball.x;
          this.simPrev.y = this.ball.y;
          this.simPrev.valid = true;
          this.physics.update(this.ball, this.hole, step);
        });
        this.updateRenderBall();
      } else this.renderBall = this.ball;
      this.handleEffects();

      if (!online) {
        if (this.ball.crushed) {
          this.strokes += CONFIG.gameplay.crushPenaltyStroke;
          this.hud.flashStatus(`Aplastado · +${CONFIG.gameplay.crushPenaltyStroke}`, 'penalty', 1.05);
          this.resetBall(false);
        } else if (this.ball.inWater) {
          this.particles.emitBurst(this.ball.x, this.ball.y, {
            count: 22,
            angle: -Math.PI / 2,
            spread: Math.PI * 0.8,
            speedMin: 45,
            speedMax: 190,
            gravity: 310,
            lifeMin: 0.35,
            lifeMax: 0.85,
            colors: ['#c8fbff', this.hole.theme.water, '#ffffff'],
            sizeMin: 2,
            sizeMax: 5,
          });
          this.strokes += CONFIG.gameplay.waterPenaltyStroke;
          this.hud.flashStatus(`Agua · +${CONFIG.gameplay.waterPenaltyStroke}`, 'penalty', 1.0);
          this.resetBall(false);
        } else if (this.isOutOfWorld(this.ball)) {
          this.strokes += CONFIG.gameplay.outOfBoundsPenaltyStroke;
          this.hud.flashStatus(`Fuera del mapa · +${CONFIG.gameplay.outOfBoundsPenaltyStroke}`, 'penalty', 1.05);
          this.resetBall(false);
        }

        if (this.ball.holed && !this.pausedForResult) {
          this.pausedForResult = true;
          this.totalScore += this.strokes - this.hole.par;
          const performance = clamp(this.hole.par - this.strokes + 2, 0, 6);
          const basePoints = Math.round(650 + this.hole.difficulty * 700 + performance * 280);
          const scoreMultiplier = this.hole.scoreMultiplierCollected ? CONFIG.gameplay.scoreMultiplier : 1;
          const holePoints = basePoints * scoreMultiplier;
          this.arcadePoints += holePoints;
          const final = this.holeIndex === this.holes.length - 1;
          this.hud.showResult(this.strokes, this.hole.par, final, this.totalScore, this.arcadePoints, holePoints, scoreMultiplier);
        }
      }

      // La estela sigue a la bola visible, no a la simulada: si no, se separa
      // de la bola a alta velocidad.
      const view = this.renderBall || this.ball;
      if (this.ball.moving && !this.ball.holed) {
        this.trail.push({ x: view.x, y: view.y });
        if (this.trail.length > CONFIG.rendering.trailLength) this.trail.shift();
      } else if (this.trail.length > 0 && !this.dragging) {
        this.trail.shift();
      }

      const cameraBall = online ? (this.networkSession?.getCameraBall?.() || view) : view;
      const cameraAimPower = !online || this.networkSession?.isCameraFollowingLocal?.() ? this.aimPower() : 0;
      this.camera.update(cameraBall, this.hole, this.viewport(), viewDt, cameraAimPower);

      // Telemetría del tiro y modo de foco del HUD: apuntando y en vuelo la
      // interfaz baja intensidad para dejar leer el terreno.
      const aiming = this.dragging && !this.ball.moving && !this.inputLocked;
      const launch = aiming ? this.computeLaunchVelocity() : null;
      this.hud.setShot({
        active: aiming,
        power: aiming ? this.aimPower() : 0,
        angle: launch ? Math.atan2(launch.y, launch.x) : 0,
      });
      this.hud.setFocus(this.inputLocked ? 'idle' : aiming ? 'aim' : this.ball.moving ? 'motion' : 'idle');
      const wind = this.physics.currentWind(this.hole.windBase);
      const distanceMeters = Math.hypot(this.hole.cup.x - this.ball.x, this.hole.cup.y - this.ball.y) * CONFIG.course.metersPerPixel;
      this.hud.update({
        seed: this.seed,
        holeIndex: this.holeIndex,
        holeCount: this.holes.length,
        strokes: this.strokes,
        par: this.hole.par,
        score: this.totalScore,
        arcadePoints: this.arcadePoints,
        multiplierFound: !!this.hole.scoreMultiplierCollected,
        wind,
        environment: this.hole.environment,
        biome: this.hole.archetypeLabel,
        mapSize: this.hole.mapSize,
        difficulty: this.hole.difficultyLabel,
        distanceMeters,
      });
    }

    draw() {
      this.renderer.draw(this.ctx, this);
    }

    frame(timestamp) {
      const rawDt = this.lastTimestamp ? (timestamp - this.lastTimestamp) / 1000 : 1 / 60;
      // El techo alto ya no es peligroso: la simulación va en pasos fijos y el
      // acumulador descarta el exceso. Lo que se limita aquí es la
      // presentación (cámara, partículas, HUD), que sí usa el dt real.
      const dt = clamp(rawDt, 0, 0.25);
      this.lastTimestamp = timestamp;
      this.update(dt);
      this.draw();
      window.requestAnimationFrame((t) => this.frame(t));
    }

    start() {
      window.requestAnimationFrame((t) => this.frame(t));
    }
  }

  NG.GolfGame = GolfGame;
}(window.NoiseGolf = window.NoiseGolf || {}));
