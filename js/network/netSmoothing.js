(function (NG) {
  'use strict';

  const { CONFIG } = NG;

  const BALL_KEYS = Object.freeze([
    'x', 'y', 'vx', 'vy', 'moving', 'holed', 'inWater', 'crushed', 'boosterCooldown', 'portalCooldown',
    'specialCooldown', 'boosterPulse', 'fanPulse', 'impactSerial', 'boosterSerial', 'holeSerial', 'portalSerial',
    'cannonSerial', 'reverseSerial', 'multiplierSerial', 'caveSerial', 'caveExitSerial', 'gravityPulse', 'gravityHold',
    'movingWallSerial', 'spinnerSerial', 'waterSkips', 'waterSkipZone', 'waterSkipSerial', 'reverseCannonSpent', 'lastWaterSkipX',
    'lastWaterSkipY', 'lastPortalPairId', 'lastPortalExitIndex', 'lastCaveId', 'lastSurfaceId', 'lastImpactSpeed',
    'sabotageByPlayerKey', 'sabotageTouchAt',
  ]);

  // Del hazard de cueva solo viajan los campos que la física necesita para
  // completar el trayecto. Enviar el hazard entero multiplicaba por diez el
  // tamaño del snapshot mientras alguien estaba dentro de una cueva.
  const CAVE_KEYS = Object.freeze([
    'caveId', 'entranceX', 'entranceY', 'exitX', 'exitY', 'controlX', 'controlY',
    'entranceSurfaceId', 'exitSurfaceId', 'exitPower', 'duration',
  ]);

  /** Copia de red: solo el estado que define la simulación de una bola. */
  function copyBall(ball) {
    if (!ball) return null;
    const out = {};
    for (const key of BALL_KEYS) if (ball[key] !== undefined) out[key] = ball[key];
    out.lastSafe = ball.lastSafe ? { x: ball.lastSafe.x, y: ball.lastSafe.y, surfaceId: ball.lastSafe.surfaceId } : null;
    out.shotOrigin = ball.shotOrigin ? { x: ball.shotOrigin.x, y: ball.shotOrigin.y, surfaceId: ball.shotOrigin.surfaceId } : null;
    if (ball.caveRide && ball.caveRide.cave) {
      const cave = {};
      for (const key of CAVE_KEYS) if (ball.caveRide.cave[key] !== undefined) cave[key] = ball.caveRide.cave[key];
      out.caveRide = {
        cave,
        reverse: !!ball.caveRide.reverse,
        t: Number(ball.caveRide.t) || 0,
        duration: Number(ball.caveRide.duration) || 0.9,
        entrySpeed: Number(ball.caveRide.entrySpeed) || 0,
      };
    } else out.caveRide = null;
    return out;
  }

  /** Clon local para simular sin tocar el estado autoritativo recibido. */
  function cloneBall(ball) {
    if (!ball) return null;
    const out = { ...ball };
    out.lastSafe = ball.lastSafe ? { ...ball.lastSafe } : null;
    out.shotOrigin = ball.shotOrigin ? { ...ball.shotOrigin } : null;
    out.caveRide = ball.caveRide ? { ...ball.caveRide } : null;
    return out;
  }

  const num = (value, fallback = 0) => (Number.isFinite(Number(value)) ? Number(value) : fallback);

  /**
   * ¿Hay una discontinuidad real entre dos estados consecutivos?
   * Un portal, una cueva o un reinicio por penalización mueven la bola de golpe:
   * interpolar entre ambos puntos la haría "volar" a través del mapa.
   */
  function isDiscontinuity(previous, next) {
    if (!previous || !next) return true;
    if (!!previous.holed !== !!next.holed) return true;
    if (!!previous.inWater !== !!next.inWater) return true;
    if (!!previous.crushed !== !!next.crushed) return true;
    if (num(previous.portalSerial) !== num(next.portalSerial)) return true;
    if (num(previous.caveSerial) !== num(next.caveSerial)) return true;
    if (num(previous.caveExitSerial) !== num(next.caveExitSerial)) return true;
    if ((previous.lastSafe?.surfaceId ?? null) !== (next.lastSafe?.surfaceId ?? null) && !next.moving) return true;
    const jump = Math.hypot(num(next.x) - num(previous.x), num(next.y) - num(previous.y));
    return jump > NG.NET_CONFIG.hardSnapDistance;
  }

  /**
   * Presentación de una bola remota.
   *
   * El cliente NUNCA dibuja el último snapshot recibido: dibuja el pasado
   * reciente (renderTime = reloj de host − retardo de interpolación) y compone
   * la posición con una Hermite cúbica entre las dos muestras que lo rodean.
   * Como la Hermite usa también las velocidades, la curva es continua en
   * posición y en velocidad: no hay "escalones" en cada tick de red.
   *
   * Si por pérdida de paquetes nos quedamos sin muestra futura, extrapolamos
   * con la física real (no en línea recta), de modo que un rebote extrapolado
   * sigue pareciendo un rebote. La diferencia entre lo extrapolado y lo que
   * después confirma el host no se corrige de golpe: se guarda como un
   * desplazamiento visual que se disuelve con una semivida corta.
   */
  class EntityInterpolator {
    constructor() {
      this.samples = [];
      this.errorX = 0;
      this.errorY = 0;
      this.lastRenderTime = 0;
      this.lastAuthX = 0;
      this.lastAuthY = 0;
      this.hasSampled = false;
      this.extrapolation = null;
      this.extrapolatedSeconds = 0;
    }

    reset(ball, hostTime) {
      this.samples = ball ? [{ t: num(hostTime), ball: cloneBall(ball) }] : [];
      this.errorX = 0;
      this.errorY = 0;
      this.hasSampled = false;
      this.extrapolation = null;
      this.extrapolatedSeconds = 0;
    }

    get newest() { return this.samples.length ? this.samples[this.samples.length - 1] : null; }

    push(hostTime, ball, options = {}) {
      if (!ball) return;
      const t = num(hostTime);
      const previous = this.newest;
      // Un snapshot fuera de orden (canal no fiable) no debe rebobinar la vista.
      if (previous && t <= previous.t) return;

      const teleport = !!options.teleport || (previous ? isDiscontinuity(previous.ball, ball) : true);
      const beforeX = this.lastAuthX;
      const beforeY = this.lastAuthY;
      const hadView = this.hasSampled;

      this.samples.push({ t, ball: cloneBall(ball), teleport });
      const cap = Math.max(4, NG.NET_CONFIG.snapshotBufferSize);
      while (this.samples.length > cap) this.samples.shift();
      this.extrapolation = null;

      if (teleport || !hadView) {
        this.errorX = 0;
        this.errorY = 0;
        return;
      }
      // La trayectoria acaba de cambiar bajo nuestros pies (estábamos
      // extrapolando). Guardamos la diferencia como error visual en vez de
      // saltar: el jugador ve una convergencia suave, no un tirón.
      const corrected = this.evaluate(this.lastRenderTime, options.context || null);
      if (!corrected) return;
      this.errorX += beforeX - corrected.x;
      this.errorY += beforeY - corrected.y;
      if (Math.hypot(this.errorX, this.errorY) > NG.NET_CONFIG.hardSnapDistance) {
        this.errorX = 0;
        this.errorY = 0;
      }
    }

    /** Posición autoritativa (sin corrección visual) en `t`. */
    evaluate(t, context) {
      if (!this.samples.length) return null;
      const first = this.samples[0];
      if (t <= first.t) return { x: num(first.ball.x), y: num(first.ball.y), vx: num(first.ball.vx), vy: num(first.ball.vy), ball: first.ball, extrapolated: false };

      for (let i = this.samples.length - 1; i > 0; i -= 1) {
        const b = this.samples[i];
        const a = this.samples[i - 1];
        if (t < a.t || t > b.t) continue;
        // Una discontinuidad no se interpola: se mantiene el estado anterior
        // hasta que el reloj alcanza la muestra nueva, y entonces salta.
        if (b.teleport) {
          const step = t >= b.t ? b : a;
          return { x: num(step.ball.x), y: num(step.ball.y), vx: num(step.ball.vx), vy: num(step.ball.vy), ball: step.ball, extrapolated: false };
        }
        return this.hermite(a, b, t);
      }
      return this.extrapolate(t, context);
    }

    hermite(a, b, t) {
      const h = b.t - a.t;
      if (!(h > 1e-6)) return { x: num(b.ball.x), y: num(b.ball.y), vx: num(b.ball.vx), vy: num(b.ball.vy), ball: b.ball, extrapolated: false };
      const u = Math.max(0, Math.min(1, (t - a.t) / h));
      const u2 = u * u;
      const u3 = u2 * u;
      const h00 = 2 * u3 - 3 * u2 + 1;
      const h10 = u3 - 2 * u2 + u;
      const h01 = -2 * u3 + 3 * u2;
      const h11 = u3 - u2;
      const d00 = (6 * u2 - 6 * u) / h;
      const d10 = 3 * u2 - 4 * u + 1;
      const d01 = (-6 * u2 + 6 * u) / h;
      const d11 = 3 * u2 - 2 * u;

      const x0 = num(a.ball.x); const y0 = num(a.ball.y);
      const x1 = num(b.ball.x); const y1 = num(b.ball.y);
      const vx0 = num(a.ball.vx); const vy0 = num(a.ball.vy);
      const vx1 = num(b.ball.vx); const vy1 = num(b.ball.vy);

      let x = h00 * x0 + h10 * h * vx0 + h01 * x1 + h11 * h * vx1;
      let y = h00 * y0 + h10 * h * vy0 + h01 * y1 + h11 * h * vy1;
      let vx = d00 * x0 + d10 * vx0 + d01 * x1 + d11 * vx1;
      let vy = d00 * y0 + d10 * vy0 + d01 * y1 + d11 * vy1;

      // Guardarraíl: si entre las dos muestras hubo un rebote fuerte, la curva
      // cúbica puede abombarse y atravesar el suelo. Cuando se aleja demasiado
      // de la recta, volvemos a la mezcla lineal, que nunca sobrepasa.
      const lx = x0 + (x1 - x0) * u;
      const ly = y0 + (y1 - y0) * u;
      const span = Math.hypot(x1 - x0, y1 - y0);
      const limit = span * 0.6 + CONFIG.ball.radius * 1.5;
      if (Math.hypot(x - lx, y - ly) > limit) {
        x = lx;
        y = ly;
        vx = vx0 + (vx1 - vx0) * u;
        vy = vy0 + (vy1 - vy0) * u;
      }
      // Los flags/serials salen de la muestra ya alcanzada: así el impacto se
      // ve y se oye exactamente cuando la bola llega, no 100 ms antes.
      return { x, y, vx, vy, ball: a.ball, extrapolated: false };
    }

    /**
     * Más allá de la última muestra avanzamos un clon con la física real.
     * El avance es incremental (el reloj de render es monótono), así que cada
     * frame solo cuesta los pasos nuevos.
     */
    extrapolate(t, context) {
      const newest = this.newest;
      if (!newest) return null;
      const maxLead = Math.max(0, NG.NET_CONFIG.maxExtrapolationMs) / 1000;
      const target = Math.min(t, newest.t + maxLead);
      this.extrapolatedSeconds = Math.max(0, target - newest.t);

      const ball = newest.ball;
      if (!ball.moving || ball.holed) {
        return { x: num(ball.x), y: num(ball.y), vx: 0, vy: 0, ball, extrapolated: false };
      }

      if (!this.extrapolation || this.extrapolation.baseT !== newest.t) {
        this.extrapolation = { baseT: newest.t, t: newest.t, ball: cloneBall(ball) };
      }
      const state = this.extrapolation;

      if (context?.physics && context?.hole) {
        const stepDt = 1 / Math.max(20, NG.NET_CONFIG.simulationHz);
        let guard = 24;
        while (state.t < target - 1e-6 && guard > 0) {
          const step = Math.min(stepDt, target - state.t);
          context.physics.time = state.t;
          context.physics.update(state.ball, context.hole, step, { speculative: true });
          state.t += step;
          guard -= 1;
          if (!state.ball.moving) break;
        }
      } else {
        // Sin física disponible (mundo aún no cargado) caemos a balística.
        const lead = Math.max(0, target - state.t);
        state.ball.x = num(state.ball.x) + num(state.ball.vx) * lead;
        state.ball.y = num(state.ball.y) + num(state.ball.vy) * lead + 0.5 * CONFIG.ball.gravity * lead * lead;
        state.ball.vy = num(state.ball.vy) + CONFIG.ball.gravity * lead;
        state.t = target;
      }
      return { x: num(state.ball.x), y: num(state.ball.y), vx: num(state.ball.vx), vy: num(state.ball.vy), ball: state.ball, extrapolated: true };
    }

    /**
     * Posición visible en `renderTime`. Aplica y disuelve la corrección.
     * @returns {{x:number,y:number,vx:number,vy:number,ball:object,extrapolated:boolean}|null}
     */
    sample(renderTime, dt, context) {
      const auth = this.evaluate(renderTime, context);
      if (!auth) return null;
      this.lastRenderTime = renderTime;
      this.lastAuthX = auth.x;
      this.lastAuthY = auth.y;
      this.hasSampled = true;

      const halfLife = Math.max(16, NG.NET_CONFIG.correctionHalfLifeMs);
      const decay = Math.pow(0.5, (Math.max(0, dt) * 1000) / halfLife);
      this.errorX *= decay;
      this.errorY *= decay;
      if (Math.abs(this.errorX) < 0.08) this.errorX = 0;
      if (Math.abs(this.errorY) < 0.08) this.errorY = 0;

      // Descartamos histórico que ya nadie va a interpolar.
      while (this.samples.length > 2 && this.samples[1].t < renderTime - 1.5) this.samples.shift();

      return {
        x: auth.x + this.errorX,
        y: auth.y + this.errorY,
        vx: auth.vx,
        vy: auth.vy,
        ball: auth.ball,
        extrapolated: auth.extrapolated,
      };
    }

    /** Distancia que todavía queda por corregir. Diagnóstico para el panel F3. */
    get correctionDistance() { return Math.hypot(this.errorX, this.errorY); }
  }

  /**
   * Predicción local de la propia bola.
   *
   * El host sigue siendo la autoridad absoluta: aquí no se decide nada de
   * puntuación ni de reglas. Lo único que hace este objeto es simular la MISMA
   * física en local para que tu tiro salga en el frame en el que sueltas, y
   * después reconciliar contra lo que confirma el host.
   *
   * La reconciliación reproyecta el estado autoritativo hacia el "presente"
   * (hora de host + medio RTT) y mete la diferencia en el mismo mecanismo de
   * error visual que usan las bolas remotas.
   */
  class LocalPredictor {
    constructor() {
      this.physics = new NG.PhysicsEngine();
      this.ball = null;
      this.time = 0;
      this.active = false;
      this.errorX = 0;
      this.errorY = 0;
      // Tiro enviado al host y todavía sin confirmar en ningún snapshot.
      this.pending = null;
    }

    reset(ball, hostTime) {
      this.ball = cloneBall(ball);
      this.time = num(hostTime);
      this.active = false;
      this.errorX = 0;
      this.errorY = 0;
      this.pending = null;
    }

    /** Arranca el tiro en local sin esperar al round-trip. */
    begin(ball, velocity, hostTime) {
      this.ball = cloneBall(ball);
      if (!this.ball) return false;
      this.time = num(hostTime);
      this.ball.vx = num(velocity?.x);
      this.ball.vy = num(velocity?.y);
      this.ball.moving = true;
      this.ball.inWater = false;
      this.ball.crushed = false;
      this.ball.lastImpactSpeed = 0;
      this.ball.shotOrigin = {
        x: num(this.ball.x),
        y: num(this.ball.y),
        surfaceId: this.ball.lastSurfaceId || this.ball.lastSafe?.surfaceId || null,
      };
      this.physics.resetMotionGuard(this.ball);
      this.active = true;
      this.pending = { vx: this.ball.vx, vy: this.ball.vy, time: this.time };
      return true;
    }

    /** Avanza la predicción hasta `targetTime` en pasos fijos. */
    advanceTo(targetTime, hole) {
      if (!this.active || !this.ball || !hole) return;
      const stepDt = 1 / Math.max(20, NG.NET_CONFIG.simulationHz);
      const maxLead = Math.max(0, NG.NET_CONFIG.maxPredictionMs) / 1000;
      const target = Math.min(num(targetTime), this.time + maxLead);
      let guard = Math.max(2, NG.NET_CONFIG.maxStepsPerFrame) + 4;
      while (this.time < target - 1e-6 && guard > 0) {
        const step = Math.min(stepDt, target - this.time);
        this.physics.time = this.time;
        this.physics.update(this.ball, hole, step, { speculative: true });
        this.time += step;
        guard -= 1;
      }
      if (this.time < target) this.time = target;
    }

    /**
     * Alinea la predicción con el último estado confirmado.
     * @param {object} authBall estado autoritativo del snapshot.
     * @param {number} authTime hora de host de ese snapshot.
     * @param {number} presentTime hora de host que queremos representar.
     * @param {object} hole mundo actual (idéntico al del host: misma seed).
     * @param {object} options `pendingShot`: el host aún no ha confirmado el
     *   tiro que enviamos. En ese caso el snapshot todavía describe la bola en
     *   reposo; reconciliar contra él sin más devolvería la bola al tee y
     *   anularía la predicción, así que reproducimos el tiro sobre el estado
     *   confirmado antes de simular. Es el equivalente al "replay de entradas
     *   no confirmadas" de cualquier netcode con predicción.
     */
    reconcile(authBall, authTime, presentTime, hole, options = {}) {
      if (!authBall) return;
      const previous = this.ball;
      const sim = cloneBall(authBall);
      let t = num(authTime);
      const maxLead = Math.max(0, NG.NET_CONFIG.maxPredictionMs) / 1000;
      const target = Math.min(num(presentTime), t + maxLead);

      const pending = options.pendingShot ? this.pending : null;
      if (!options.pendingShot) this.pending = null;
      if (pending && !sim.holed) {
        t = Math.max(t, num(pending.time));
        sim.vx = pending.vx;
        sim.vy = pending.vy;
        sim.moving = true;
        sim.inWater = false;
        sim.crushed = false;
        sim.lastImpactSpeed = 0;
        sim.shotOrigin = { x: num(sim.x), y: num(sim.y), surfaceId: sim.lastSurfaceId || sim.lastSafe?.surfaceId || null };
        this.physics.resetMotionGuard(sim);
      }

      if (hole && sim.moving && !sim.holed) {
        const stepDt = 1 / Math.max(20, NG.NET_CONFIG.simulationHz);
        let guard = 90;
        while (t < target - 1e-6 && guard > 0) {
          const step = Math.min(stepDt, target - t);
          this.physics.time = t;
          this.physics.update(sim, hole, step, { speculative: true });
          t += step;
          guard -= 1;
          if (!sim.moving) break;
        }
      }
      this.time = Math.max(t, num(authTime));
      this.active = (!!sim.moving && !sim.holed) || !!pending;

      if (!previous) {
        this.ball = sim;
        this.errorX = 0;
        this.errorY = 0;
        return;
      }
      const dx = num(previous.x) - num(sim.x);
      const dy = num(previous.y) - num(sim.y);
      this.ball = sim;
      if (isDiscontinuity(previous, sim) || Math.hypot(dx, dy) > NG.NET_CONFIG.hardSnapDistance) {
        this.errorX = 0;
        this.errorY = 0;
        return;
      }
      this.errorX += dx;
      this.errorY += dy;
    }

    decay(dt) {
      const halfLife = Math.max(16, NG.NET_CONFIG.correctionHalfLifeMs);
      const factor = Math.pow(0.5, (Math.max(0, dt) * 1000) / halfLife);
      this.errorX *= factor;
      this.errorY *= factor;
      if (Math.abs(this.errorX) < 0.08) this.errorX = 0;
      if (Math.abs(this.errorY) < 0.08) this.errorY = 0;
    }

    view() {
      if (!this.ball) return null;
      return {
        x: num(this.ball.x) + this.errorX,
        y: num(this.ball.y) + this.errorY,
        vx: num(this.ball.vx),
        vy: num(this.ball.vy),
        ball: this.ball,
      };
    }
  }

  NG.NetBall = { copy: copyBall, clone: cloneBall, isDiscontinuity };
  NG.EntityInterpolator = EntityInterpolator;
  NG.LocalPredictor = LocalPredictor;
}(window.NoiseGolf = window.NoiseGolf || {}));
