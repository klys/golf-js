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
      this.holeIntro = NG.HoleIntro ? new NG.HoleIntro() : null;
      this.music = NG.MusicPlayer ? new NG.MusicPlayer() : null;
      // "En partida" NO es lo mismo que "input desbloqueado": el menú de pausa
      // bloquea el input y ahí la música tiene que seguir sonando.
      this.matchActive = false;
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
      this.handledWaterSkipSerial = 0;
      this.handledReverseSerial = 0;
      // Último `holeSerial` visto por jugador. Es lo que dispara el anillo de
      // la onda expansiva sin necesidad de un mensaje de red propio.
      this.handledShockSerials = new Map();
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
        if (e.repeat || e.ctrlKey || e.altKey || e.metaKey) return;
        // Escribiendo en el menú (nombre de sala, contraseña…) las teclas de
        // juego no deben dispararse.
        const target = e.target;
        if (target && (target.isContentEditable || /^(input|textarea|select)$/i.test(target.tagName || ''))) return;
        const key = String(e.key || '');
        // Cualquier tecla corta la presentación del hoyo: nadie debería tener
        // que esperar a una animación que ya ha visto.
        if (this.isIntroPlaying() && key !== 'Shift' && key !== 'Control' && key !== 'Alt' && key !== 'Meta') {
          this.skipHoleIntro();
          return;
        }
        if (key.toLowerCase() === 'r' && !this.pausedForResult && !this.inputLocked) {
          this.returnToShotOrigin();
          return;
        }
        // Cámara libre del que ya ha terminado: recorre a quien sigue jugando.
        if (key === 'ArrowRight' || key === 'ArrowLeft' || key.toLowerCase() === 'c') {
          if (this.cycleSpectateCamera(key === 'ArrowLeft' ? -1 : 1)) e.preventDefault();
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
        reverseSerial: 0,
        multiplierSerial: 0,
        caveSerial: 0,
        caveExitSerial: 0,
        gravityPulse: 0,
        gravityHold: 0,
        movingWallSerial: 0,
        spinnerSerial: 0,
        waterSkips: 0,
        waterSkipZone: null,
        waterSkipSerial: 0,
        reverseCannonSpent: false,
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
      this.handledWaterSkipSerial = 0;
      this.handledReverseSerial = 0;
      this.handledShockSerials.clear();
      this.camera = new Camera2D();
      this.camera.snapTo(this.ball, this.hole, this.viewport());
      this.lastTimestamp = 0;
      this.fixedStep.reset();
      this.simPrev = { x: this.ball.x, y: this.ball.y, valid: false };
      this.renderBall = this.ball;
      this.restartMusicForHole();
      const intro = this.startHoleIntro();
      const label = `${this.hole.archetypeLabel} · ${this.hole.mapSize}`;
      this.hud.flashStatus(intro ? `${label} · pulsa para saltar` : label, 'neutral', intro ? 1.9 : 1.4);
    }

    /**
     * Presentación del hoyo: bandera primero, recorrido del campo después y
     * control al jugador al aterrizar en la salida.
     * Es solo cámara. La física, el reloj de la sala y la autoridad de red
     * siguen su curso, así que saltarla no cambia el estado de la partida.
     */
    /**
     * Lo poco que la música necesita saber de la partida.
     *
     * Se calcula aquí y no dentro del reproductor para que ese módulo no
     * tenga que conocer el juego: recibe números, no el mundo.
     *
     * La bola es la que tiene el FOCO DE LA CÁMARA, no la local. Casi siempre
     * son la misma, pero cuando se mira a otro jugador —turno ajeno, modo
     * espectador— la música tiene que ir con lo que se está viendo: si sonara
     * la tensión de una bola fuera de plano, el efecto se leería como un fallo.
     */
    musicScene() {
      const ball = this.networkSession?.getCameraBall?.() || this.ball;
      if (!ball || !this.hole?.cup) return null;
      return {
        distanceToCup: Math.hypot(ball.x - this.hole.cup.x, ball.y - this.hole.cup.y),
        moving: !!ball.moving && !ball.holed && !ball.inWater,
      };
    }

    /**
     * Mapa nuevo, pista desde el principio. Solo si ya se está jugando: al
     * arrancar el juego se genera un campo con el menú delante, y ahí no debe
     * sonar nada.
     */
    restartMusicForHole() {
      if (this.matchActive) this.music?.start();
    }

    startHoleIntro() {
      if (!this.holeIntro || !this.hole || !this.ball) return false;
      this.dragging = false;
      // El viewport entra aquí porque el ritmo del barrido se calibra midiendo
      // píxeles de PANTALLA, no de mundo.
      return this.holeIntro.start(this.hole, this.viewport(), () => this.onHoleIntroEnd());
    }

    onHoleIntroEnd() {
      // Se salta a media panorámica: la cámara se planta en la bola de una vez
      // en vez de barrer medio mapa a cámara lenta con el jugador esperando.
      this.camera.snapTo(this.ball, this.hole, this.viewport());
      this.hud.flashStatus('¡Adelante!', 'good', 0.75);
    }

    isIntroPlaying() {
      return !!this.holeIntro?.isActive();
    }

    /** Corta la presentación. Devuelve true solo si de verdad había una. */
    skipHoleIntro() {
      return !!this.holeIntro?.skip();
    }

    screenToWorld(clientX, clientY) {
      const rect = this.canvas.getBoundingClientRect();
      return this.camera.screenToWorld(clientX - rect.left, clientY - rect.top);
    }

    onPointerDown(e) {
      // El primer clic salta la presentación; el siguiente ya apunta.
      if (this.skipHoleIntro()) return;
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
        this.ball.waterSkips = 0;
        this.ball.waterSkipZone = null;
        this.ball.reverseCannonSpent = false;
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
      this.ball.gravityHold = 0;
      this.ball.waterSkips = 0;
      this.ball.waterSkipZone = null;
      this.ball.reverseCannonSpent = false;
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

    /**
     * Pasa la cámara al siguiente jugador observable.
     * Solo hace algo cuando la sesión lo permite (has embocado, has agotado el
     * tiempo o eres espectador y queda alguien jugando), así que las flechas
     * no roban nada mientras estás jugando tu turno.
     */
    cycleSpectateCamera(direction) {
      const session = this.networkSession;
      if (!session?.getStatus().online || !session.canSpectate?.()) return false;
      const target = session.cycleSpectate(direction);
      if (!target) return false;
      this.hud.flashStatus(target.local ? 'Cámara en tu bola' : `Siguiendo a ${target.username}`, 'neutral', 0.9);
      return true;
    }

    setInputLocked(value) {
      this.inputLocked = !!value;
      if (this.inputLocked) this.cancelDrag();
    }

    /**
     * Entrar o salir de una partida.
     *
     * Es el interruptor de la música, y por eso no puede colgarse de
     * `setInputLocked`: el menú de pausa también bloquea el input, y con esa
     * señal la pista se cortaría y volvería a empezar cada vez que alguien
     * abre el menú a mitad de hoyo.
     */
    setMatchActive(active) {
      const value = !!active;
      if (value === this.matchActive) return;
      this.matchActive = value;
      if (value) this.music?.start();
      else this.music?.stop();
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

      // Retroceso: se anuncia como penalización, no como truco. El jugador
      // acaba de perder medio hoyo y el aviso tiene que decírselo con esa cara,
      // aunque no le cueste ningún golpe.
      if ((ball.reverseSerial || 0) > this.handledReverseSerial) {
        this.handledReverseSerial = ball.reverseSerial;
        this.hud.flashStatus('¡RETROCESO!', 'penalty', 1.25);
        this.camera.addShake(9);
        this.particles.emitBurst(ball.x, ball.y, {
          count: 26,
          angle: Math.atan2(ball.vy, ball.vx),
          spread: 0.8,
          speedMin: 95,
          speedMax: 300,
          gravity: 120,
          lifeMin: 0.24,
          lifeMax: 0.66,
          colors: ['#ff8a5c', '#ffd08a', '#ffffff'],
          sizeMin: 2,
          sizeMax: 5,
          glow: 10,
          shape: 'spark',
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

      // Picado en el agua: el chapoteo se dibuja en la LÁMINA, no en la bola,
      // que a esa velocidad ya está varios píxeles más allá cuando se lee.
      if ((ball.waterSkipSerial || 0) > this.handledWaterSkipSerial) {
        this.handledWaterSkipSerial = ball.waterSkipSerial;
        const skipX = Number.isFinite(ball.lastWaterSkipX) ? ball.lastWaterSkipX : ball.x;
        const skipY = Number.isFinite(ball.lastWaterSkipY) ? ball.lastWaterSkipY : ball.y;
        const chained = (ball.waterSkips || 1) > 1;
        this.renderer.spawnWaterRipple(skipX, skipY, this.hole.theme.water);
        this.hud.flashStatus(chained ? '¡DOBLE REBOTE EN EL AGUA!' : '¡Rebote en el agua!', 'boost', chained ? 1.1 : 0.8);
        this.camera.addShake(chained ? 4.2 : 2.8);
        this.particles.emitBurst(skipX, skipY, {
          count: chained ? 22 : 16,
          angle: -Math.PI / 2,
          spread: Math.PI * 0.5,
          speedMin: 70,
          speedMax: 235,
          gravity: 430,
          lifeMin: 0.20,
          lifeMax: 0.52,
          colors: ['#e2fdff', this.hole.theme.water, '#ffffff'],
          sizeMin: 1.4,
          sizeMax: 3.6,
          glow: 5,
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

    /**
     * Anillo de la onda expansiva de cada bola que emboca.
     *
     * Se deduce del `holeSerial`, que ya viaja en los snapshots, así que
     * funciona igual offline que online sin añadir un mensaje al protocolo.
     * A un jugador que entra con el hoyo empezado no se le enseña la onda de
     * alguien que embocó antes de que llegara: solo se anuncian los cambios
     * de serial vistos desde dentro.
     */
    trackHoleShockwaves() {
      const balls = this.networkSession?.getRenderBalls?.()
        || (this.ball ? [{ playerKey: 'offline', color: '#eaf6ff', ball: this.ball }] : []);
      for (const item of balls) {
        const key = item?.playerKey;
        const ball = item?.ball;
        if (!key || !ball) continue;
        const serial = Number(ball.holeSerial) || 0;
        const known = this.handledShockSerials.has(key);
        const seen = this.handledShockSerials.get(key) || 0;
        this.handledShockSerials.set(key, serial);
        if (!known || serial <= seen) continue;
        this.renderer.spawnShockwave(this.hole.cup.x, this.hole.cup.y, item.color || this.hole.theme.accent);
        this.camera.addShake(5.5);
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
      this.music?.update(viewDt, this.musicScene());
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
      this.trackHoleShockwaves();

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
          this.music?.hit('water');
          this.hud.flashStatus(`Agua · +${CONFIG.gameplay.waterPenaltyStroke}`, 'penalty', 1.0);
          this.resetBall(false);
        } else if (this.isOutOfWorld(this.ball)) {
          this.strokes += CONFIG.gameplay.outOfBoundsPenaltyStroke;
          this.music?.hit('lost');
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

      // Mientras dura la presentación manda el guion: la cámara va donde dice
      // el recorrido, no donde esté la bola.
      const introFrame = this.holeIntro?.isActive() ? this.holeIntro.update(viewDt, this.viewport()) : null;
      if (introFrame) {
        // El propio encuadre lleva zoom, anclaje y suelo de zoom.
        this.camera.frame(introFrame, this.hole, this.viewport(), introFrame);
      } else {
        const cameraBall = online ? (this.networkSession?.getCameraBall?.() || view) : view;
        const cameraAimPower = !online || this.networkSession?.isCameraFollowingLocal?.() ? this.aimPower() : 0;
        this.camera.update(cameraBall, this.hole, this.viewport(), viewDt, cameraAimPower);
      }

      // Telemetría del tiro y modo de foco del HUD: apuntando y en vuelo la
      // interfaz baja intensidad para dejar leer el terreno.
      const aiming = this.dragging && !this.ball.moving && !this.inputLocked && !this.isIntroPlaying();
      const launch = aiming ? this.computeLaunchVelocity() : null;
      this.hud.setShot({
        active: aiming,
        power: aiming ? this.aimPower() : 0,
        angle: launch ? Math.atan2(launch.y, launch.x) : 0,
      });
      this.hud.setFocus(this.inputLocked || this.isIntroPlaying() ? 'idle' : aiming ? 'aim' : this.ball.moving ? 'motion' : 'idle');
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
