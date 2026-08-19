(function (NG) {
  'use strict';

  const { CONFIG } = NG;
  const { clamp, expSmoothing, lerp } = NG.MathUtil;

  /**
   * Muelle críticamente amortiguado (SmoothDamp).
   *
   * Frente al suavizado exponencial, aquí la cámara tiene VELOCIDAD propia y
   * continua: cuando el objetivo cambia de golpe —un rebote invierte la
   * velocidad de la bola en un frame— la cámara no da un tirón, sino que
   * frena y reacelera. Es la diferencia entre "seguir" y "temblar".
   *
   * La forma cerrada es estable con cualquier dt, así que un frame perdido no
   * dispara la cámara.
   */
  function smoothDamp(current, target, state, axis, smoothTime, dt) {
    const time = Math.max(0.0001, smoothTime);
    const omega = 2 / time;
    const x = omega * dt;
    const decay = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
    const change = current - target;
    const temp = (state[axis] + omega * change) * dt;
    state[axis] = (state[axis] - omega * temp) * decay;
    return target + (change + temp) * decay;
  }

  class Camera2D {
    constructor() {
      this.x = 0;
      this.y = 0;
      this.zoom = 1;
      this.targetZoom = 1;
      this.shakeX = 0;
      this.shakeY = 0;
      this.shakeStrength = 0;
      this.shakeAngle = 0;
      this.shakePhase = 0;
      this.initialized = false;

      // Velocidad propia del muelle en cada eje.
      this.velocity = { x: 0, y: 0 };
      // Adelanto ya filtrado, en unidades de mundo.
      this.aheadX = 0;
      this.aheadY = 0;
      // Velocidad de la bola suavizada: la usan el zoom y el adelanto para no
      // reaccionar a la pérdida brusca de energía de cada bote.
      this.trackedSpeed = 0;
      // Último punto enfocado, para detectar cortes (portal, cambio de turno).
      this.lastFocusX = null;
      this.lastFocusY = null;
      // Se incrementa en cada corte. Permite distinguir un corte intencionado
      // de un temblor, tanto en depuración como para quien quiera reaccionar.
      this.cuts = 0;
    }

    /** Encuadre instantáneo. Se usa al cargar hoyo y tras un corte. */
    snapTo(ball, hole, viewport) {
      if (!ball || !hole) return;
      const viewWorldW = viewport.width / this.zoom;
      const viewWorldH = viewport.height / this.zoom;
      this.x = ball.x - viewWorldW * CONFIG.camera.anchorX;
      this.y = ball.y - viewWorldH * CONFIG.camera.anchorY;
      this.velocity.x = 0;
      this.velocity.y = 0;
      this.aheadX = 0;
      this.aheadY = 0;
      this.trackedSpeed = 0;
      this.lastFocusX = ball.x;
      this.lastFocusY = ball.y;
      this.clampToBounds(hole, viewport);
      this.initialized = true;
      this.cuts += 1;
    }

    /**
     * Encuadre directo sobre un punto del mundo, sin muelle ni suavizado.
     * Lo usa la presentación del hoyo: ahí manda el guion, no el seguimiento.
     * Deja el estado del muelle a cero para que el traspaso a la cámara normal
     * arranque limpio en vez de heredar una velocidad inventada.
     */
    frame(point, hole, viewport, options = {}) {
      if (!point || !hole || viewport.width <= 0 || viewport.height <= 0) return;
      const cfg = CONFIG.camera;
      // El guion puede pedir un plano más abierto que el mínimo de juego: la
      // panorámica del mapa entero vive muy por debajo de `minZoom`. El suelo
      // lo pone quien encuadra, no el seguimiento.
      const floor = Number.isFinite(options.minZoom) ? Math.min(options.minZoom, cfg.minZoom) : cfg.minZoom;
      const anchorX = options.anchorX;
      const anchorY = options.anchorY;
      this.zoom = clamp(Number(options.zoom) || cfg.restZoom, floor, cfg.maxZoom);
      this.targetZoom = this.zoom;
      const worldW = viewport.width / this.zoom;
      const worldH = viewport.height / this.zoom;
      this.x = point.x - worldW * (Number.isFinite(anchorX) ? anchorX : 0.5);
      this.y = point.y - worldH * (Number.isFinite(anchorY) ? anchorY : 0.5);
      this.velocity.x = 0;
      this.velocity.y = 0;
      this.aheadX = 0;
      this.aheadY = 0;
      this.trackedSpeed = 0;
      // El foco queda registrado como el punto encuadrado: si no, el primer
      // update() de juego mediría un salto enorme y lo tomaría por un corte.
      this.lastFocusX = point.x;
      this.lastFocusY = point.y;

      // Recorte a los límites del mundo, dosificado.
      //
      // Aplicarlo a saco rompe una panorámica: mientras el mapa cabe entero en
      // pantalla, `boundsFor` CENTRA el eje e ignora a dónde apunta el guion,
      // así que la cámara se queda clavada; y en cuanto el mapa deja de caber,
      // el recorte la suelta de golpe donde el guion ya había llegado. Ese
      // salto medía más de cien píxeles por frame en los mapas largos.
      //
      // Por eso quien encuadra decide cuánto recorte quiere: cero mientras el
      // plano es general, y entrando poco a poco en el aterrizaje, de modo que
      // el último frame coincide exactamente con el encuadre de juego.
      const blend = options.clamp == null ? 1 : clamp(Number(options.clamp) || 0, 0, 1);
      if (blend > 0) {
        const limits = this.boundsFor(hole, worldW, worldH);
        const boundedX = limits.centerX != null ? limits.centerX : clamp(this.x, limits.minX, limits.maxX);
        const boundedY = limits.centerY != null ? limits.centerY : clamp(this.y, limits.minY, limits.maxY);
        this.x = lerp(this.x, boundedX, blend);
        this.y = lerp(this.y, boundedY, blend);
      }
      this.initialized = true;
    }

    /**
     * Impulso de sacudida direccional.
     * Un golpe flojo no reinicia una sacudida fuerte que ya está sonando: si
     * lo hiciera, una serie de botes pequeños mantendría la cámara vibrando.
     */
    addShake(strength) {
      const value = clamp(Number(strength) || 0, 0, CONFIG.camera.maxShake);
      if (value <= 0.15) return;
      const current = this.shakeStrength * Math.exp(-this.shakePhase * CONFIG.camera.shakeDamping);
      if (value <= current * 0.75) return;
      this.shakeStrength = Math.max(value, current);
      this.shakeAngle = Math.random() * Math.PI * 2;
      this.shakePhase = 0;
    }

    update(ball, hole, viewport, dt, aimPower = 0) {
      if (!ball || !hole || viewport.width <= 0 || viewport.height <= 0) return;
      if (!this.initialized) this.snapTo(ball, hole, viewport);
      const step = clamp(Number(dt) || 0, 0, 1 / 15);
      const cfg = CONFIG.camera;

      const vx = Number(ball.vx) || 0;
      const vy = Number(ball.vy) || 0;

      // Un salto imposible del foco es un corte, no un movimiento: portal,
      // penalización o cambio de turno. Barrer el mapa a cámara lenta ahí
      // significaría perder la bola de vista durante segundos.
      if (this.lastFocusX != null) {
        const jump = Math.hypot(ball.x - this.lastFocusX, ball.y - this.lastFocusY);
        if (jump > Math.max(cfg.cutDistance, CONFIG.ball.maxSpeed * step * 3)) {
          this.snapTo(ball, hole, viewport);
        }
      }
      // Velocidad REAL del punto enfocado. La de la bola no basta: dentro de
      // una cueva secreta, montada en una plataforma o siguiendo a otro
      // jugador por red, la bola se desplaza con vx/vy a cero y la cámara se
      // quedaba atrás hasta que la correa tiraba de ella en seco.
      let focusVX = vx;
      let focusVY = vy;
      if (this.lastFocusX != null && step > 0) {
        const cap = CONFIG.ball.maxSpeed * 1.5;
        const measuredX = clamp((ball.x - this.lastFocusX) / step, -cap, cap);
        const measuredY = clamp((ball.y - this.lastFocusY) / step, -cap, cap);
        if (Math.abs(measuredX) > Math.abs(focusVX)) focusVX = measuredX;
        if (Math.abs(measuredY) > Math.abs(focusVY)) focusVY = measuredY;
      }
      this.lastFocusX = ball.x;
      this.lastFocusY = ball.y;

      // Velocidad suavizada: sube deprisa (hay que abrir plano ya) y baja
      // despacio (el bote pierde energía de golpe y el zoom no debe "respirar").
      const speed = Math.hypot(focusVX, focusVY);
      this.trackedSpeed = expSmoothing(this.trackedSpeed, speed, speed > this.trackedSpeed ? 12 : 2.2, step);
      const speedT = clamp(this.trackedSpeed / CONFIG.ball.maxSpeed, 0, 1);

      const flightZoom = lerp(cfg.restZoom, cfg.flightZoom, speedT);
      this.targetZoom = aimPower > 0.02
        ? Math.min(flightZoom, lerp(cfg.restZoom, cfg.aimZoom, aimPower))
        : flightZoom;
      this.targetZoom = clamp(this.targetZoom, cfg.minZoom, cfg.maxZoom);
      this.zoom = expSmoothing(this.zoom, this.targetZoom, 2 / Math.max(0.05, cfg.zoomSmoothTime), step);

      const worldW = viewport.width / this.zoom;
      const worldH = viewport.height / this.zoom;

      // Adelanto CONTINUO. Antes se usaba Math.sign(vx), que en cada rebote
      // invertía el objetivo 410 px de golpe, y con la bola casi parada
      // cambiaba de signo cada frame. Ahora es proporcional a la velocidad,
      // pasa suavemente por cero y encima va filtrado.
      const ref = Math.max(1, cfg.lookAheadRefSpeed);
      const wantAheadX = clamp(focusVX / ref, -1, 1) * cfg.lookAheadX;
      const wantAheadY = clamp(focusVY / ref, -1, 1) * cfg.lookAheadY;
      this.aheadX = expSmoothing(this.aheadX, wantAheadX, cfg.lookAheadResponsiveness, step);
      this.aheadY = expSmoothing(this.aheadY, wantAheadY, cfg.lookAheadResponsiveness, step);

      let targetX = ball.x + this.aheadX - worldW * cfg.anchorX;
      let targetY = ball.y + this.aheadY - worldH * cfg.anchorY;

      // Zona muerta: mientras el objetivo se mueva poco alrededor del encuadre
      // actual, la cámara se queda quieta del todo. Es lo que elimina el
      // temblor de la bola rodando, asentándose o vibrando sobre una
      // plataforma. Se encoge con la velocidad para no ir suelta en vuelo.
      const relax = 1 - speedT * 0.85;
      const deadX = (cfg.deadZoneX / this.zoom) * relax;
      const deadY = (cfg.deadZoneY / this.zoom) * relax;
      targetX = this.applyDeadZone(this.x, targetX, deadX);
      targetY = this.applyDeadZone(this.y, targetY, deadY);

      // Perseguir un objetivo fuera del mundo hace que la cámara se "pegue" al
      // borde y luego pegue un tirón al volver. Se acota antes de suavizar.
      const limits = this.boundsFor(hole, worldW, worldH);
      targetX = limits.centerX != null ? limits.centerX : clamp(targetX, limits.minX, limits.maxX);
      targetY = limits.centerY != null ? limits.centerY : clamp(targetY, limits.minY, limits.maxY);

      // Urgencia: cuanto más cerca del borde está la bola, más corto es el
      // tiempo de asentamiento. Es una mezcla continua, no un interruptor.
      const urgency = Math.max(speedT * speedT, this.edgeUrgency(ball, viewport));
      const smoothTime = lerp(cfg.followSmoothTime, cfg.fastSmoothTime, clamp(urgency, 0, 1));
      const maxTravel = Math.max(1, cfg.maxFollowSpeed) * step;
      this.x = this.travel(this.x, smoothDamp(this.x, targetX, this.velocity, 'x', smoothTime, step), 'x', maxTravel);
      this.y = this.travel(this.y, smoothDamp(this.y, targetY, this.velocity, 'y', smoothTime, step), 'y', maxTravel);

      // Orden deliberado: primero el mundo, y la correa DESPUÉS. Ver la bola
      // manda sobre no enseñar cielo de más; si se hiciera al revés, una bola
      // pegada al límite del mapa se iría del encuadre.
      this.clampToBounds(hole, viewport);
      this.applyLeash(ball, viewport, hole);
      this.updateShake(step);
    }

    /**
     * Acerca el objetivo solo hasta el borde de la zona muerta.
     * Es continuo: al salir de la zona no hay escalón, el objetivo empieza a
     * moverse desde cero.
     */
    applyDeadZone(current, target, radius) {
      const delta = target - current;
      const distance = Math.abs(delta);
      if (distance <= radius) return current;
      return current + Math.sign(delta) * (distance - radius);
    }

    /**
     * Limita cuánto puede recorrer la cámara en un frame.
     * Sin techo, una recuperación larga arranca a varias veces la velocidad
     * máxima de la bola y al alcanzarla frena de golpe: justo el latigazo que
     * más se nota. Al topar, la velocidad del muelle se fija al techo para que
     * la salida del límite tampoco sea un escalón.
     */
    travel(current, next, axis, maxTravel) {
      const delta = next - current;
      if (Math.abs(delta) <= maxTravel) return next;
      const direction = Math.sign(delta);
      this.velocity[axis] = direction * CONFIG.camera.maxFollowSpeed;
      return current + direction * maxTravel;
    }

    /** 0 en el centro del encuadre, 1 pegada al margen de seguridad. */
    edgeUrgency(ball, viewport) {
      const cfg = CONFIG.camera;
      const screenX = (ball.x - this.x) * this.zoom;
      const screenY = (ball.y - this.y) * this.zoom;
      const marginX = viewport.width * cfg.leashMarginX;
      const marginY = viewport.height * cfg.leashMarginY;
      const overX = Math.max(marginX - screenX, screenX - (viewport.width - marginX), 0);
      const overY = Math.max(marginY - screenY, screenY - (viewport.height - marginY), 0);
      return clamp(Math.max(overX / Math.max(1, marginX), overY / Math.max(1, marginY)), 0, 1);
    }

    /**
     * Garantía dura: pase lo que pase con el suavizado, la bola no sale del
     * encuadre. Si la correa tira, la velocidad del muelle en ese eje se anula
     * para que no rebote contra el límite.
     */
    applyLeash(ball, viewport, hole) {
      const cfg = CONFIG.camera;
      const marginX = Math.min(viewport.width * cfg.leashMarginX, viewport.width * 0.45);
      const marginY = Math.min(viewport.height * cfg.leashMarginY, viewport.height * 0.45);
      const screenX = (ball.x - this.x) * this.zoom;
      const screenY = (ball.y - this.y) * this.zoom;
      // Si el mundo cabe entero en pantalla, ese eje está centrado y la bola
      // ya se ve: mover la cámara ahí solo rompería el encuadre fijo.
      const limits = hole
        ? this.boundsFor(hole, viewport.width / this.zoom, viewport.height / this.zoom)
        : { centerX: null, centerY: null };

      if (limits.centerX != null) { /* eje centrado: nada que perseguir */ } else if (screenX < marginX) {
        this.x = ball.x - marginX / this.zoom;
        this.velocity.x = Number(ball.vx) || 0;
      } else if (screenX > viewport.width - marginX) {
        this.x = ball.x - (viewport.width - marginX) / this.zoom;
        this.velocity.x = Number(ball.vx) || 0;
      }
      if (limits.centerY != null) { /* eje centrado: nada que perseguir */ } else if (screenY < marginY) {
        this.y = ball.y - marginY / this.zoom;
        this.velocity.y = Number(ball.vy) || 0;
      } else if (screenY > viewport.height - marginY) {
        this.y = ball.y - (viewport.height - marginY) / this.zoom;
        this.velocity.y = Number(ball.vy) || 0;
      }
    }

    updateShake(dt) {
      if (this.shakeStrength <= 0.05) {
        this.shakeStrength = 0;
        this.shakeX = 0;
        this.shakeY = 0;
        return;
      }
      const cfg = CONFIG.camera;
      this.shakePhase += dt;
      const envelope = Math.exp(-this.shakePhase * cfg.shakeDamping);
      if (envelope < 0.03) {
        this.shakeStrength = 0;
        this.shakeX = 0;
        this.shakeY = 0;
        return;
      }
      // Golpe direccional que oscila y se apaga: se lee como un impacto, no
      // como ruido. El ruido blanco por frame era gran parte del temblor.
      const wave = Math.sin(this.shakePhase * cfg.shakeFrequency * Math.PI * 2);
      const amplitude = this.shakeStrength * envelope * wave;
      this.shakeX = Math.cos(this.shakeAngle) * amplitude;
      this.shakeY = Math.sin(this.shakeAngle) * amplitude;
    }

    /** Límites válidos de la esquina superior izquierda de la cámara. */
    boundsFor(hole, worldW, worldH) {
      const margin = CONFIG.course.worldMargin;
      const minX = hole.bounds.minX - margin;
      const maxX = hole.bounds.maxX + margin - worldW;
      const minY = hole.bounds.minY - CONFIG.course.topFlightMargin;
      const maxY = hole.bounds.maxY + CONFIG.course.bottomFallMargin - worldH;
      return {
        minX,
        maxX,
        minY,
        maxY,
        // Si el mundo cabe entero en pantalla, se centra y no hay nada que seguir.
        centerX: maxX < minX ? (hole.bounds.minX + hole.bounds.maxX - worldW) * 0.5 : null,
        centerY: maxY < minY ? (hole.bounds.minY + hole.bounds.maxY - worldH) * 0.5 : null,
      };
    }

    clampToBounds(hole, viewport) {
      const worldW = viewport.width / this.zoom;
      const worldH = viewport.height / this.zoom;
      const limits = this.boundsFor(hole, worldW, worldH);
      this.x = limits.centerX != null ? limits.centerX : clamp(this.x, limits.minX, limits.maxX);
      this.y = limits.centerY != null ? limits.centerY : clamp(this.y, limits.minY, limits.maxY);
    }

    apply(ctx) {
      ctx.translate(this.shakeX, this.shakeY);
      ctx.scale(this.zoom, this.zoom);
      ctx.translate(-this.x, -this.y);
    }

    worldToScreen(point) {
      return {
        x: (point.x - this.x) * this.zoom + this.shakeX,
        y: (point.y - this.y) * this.zoom + this.shakeY,
      };
    }

    screenToWorld(x, y) {
      return {
        x: (x - this.shakeX) / this.zoom + this.x,
        y: (y - this.shakeY) / this.zoom + this.y,
      };
    }

    visibleBounds(viewport, margin = CONFIG.rendering.worldCullMargin) {
      const worldW = viewport.width / this.zoom;
      const worldH = viewport.height / this.zoom;
      return {
        minX: this.x - margin,
        maxX: this.x + worldW + margin,
        minY: this.y - margin,
        maxY: this.y + worldH + margin,
      };
    }
  }

  NG.Camera2D = Camera2D;
}(window.NoiseGolf = window.NoiseGolf || {}));
