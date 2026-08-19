(function (NG) {
  'use strict';

  const { CONFIG } = NG;
  const { clamp, lerp } = NG.MathUtil;

  // Puntos de la trayectoria. 64 dan una curva suave sin que el suavizado
  // posterior cueste nada medible: se calcula una vez por hoyo.
  const PATH_SAMPLES = 64;
  // Altura sobre el suelo a la que vuela la cámara. Suficiente para leer el
  // terreno sin que el recorrido se convierta en un plano del cielo.
  const FLIGHT_HEIGHT = 96;

  const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const easeOut = (t) => 1 - Math.pow(1 - t, 3);

  /**
   * Presentación del hoyo.
   *
   * Antes de dar el control, la cámara enseña primero la bandera y después
   * recorre el campo hacia atrás hasta la salida. El jugador llega al primer
   * golpe sabiendo dónde está el hoyo y qué hay por el camino, en vez de
   * descubrirlo arrastrando la bola a ciegas.
   *
   * Es presentación pura: no toca la física, ni la autoridad de red, ni el
   * reloj de la sala. Si se salta, el estado del juego es exactamente el
   * mismo que si se hubiera visto entera.
   */
  class HoleIntro {
    constructor() {
      this.active = false;
      this.time = 0;
      this.path = null;
      this.hole = null;
      this.duration = 0;
      this.phases = null;
      this.onFinish = null;
    }

    /**
     * Recorrido cámara: de la copa a la salida, siguiendo el relieve.
     *
     * Una recta entre los dos puntos atravesaría el suelo en cualquier hoyo
     * con desnivel. Se muestrea la superficie y luego se suaviza: interesa la
     * silueta del campo, no cada bache.
     */
    buildPath(hole) {
      const from = hole.cup;
      const to = hole.tee;
      const points = [];
      for (let i = 0; i < PATH_SAMPLES; i += 1) {
        const t = i / (PATH_SAMPLES - 1);
        const x = lerp(from.x, to.x, t);
        const straightY = lerp(from.y, to.y, t);
        points.push({ x, y: this.groundAt(hole, x, straightY) - FLIGHT_HEIGHT });
      }
      // Los extremos son sagrados: el plano tiene que abrir en la bandera y
      // cerrar en la salida, no cerca de ellas.
      points[0].y = from.y - FLIGHT_HEIGHT * 0.55;
      points[points.length - 1].y = to.y - FLIGHT_HEIGHT * 0.55;
      this.smooth(points, 3);

      // Longitud acumulada: permite avanzar a velocidad constante en vez de a
      // saltos, que es lo que delata una interpolación por índice.
      let total = 0;
      points[0].s = 0;
      for (let i = 1; i < points.length; i += 1) {
        total += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
        points[i].s = total;
      }
      return { points, length: Math.max(1, total) };
    }

    /**
     * Altura del terreno bajo un punto.
     * Se queda con la superficie más cercana a la línea recta cámara-hoyo: en
     * mapas con islas o cuevas, la más alta o la más baja mandarían el plano a
     * un sitio que no tiene nada que ver con el recorrido de juego.
     */
    groundAt(hole, x, referenceY) {
      let best = null;
      let bestDistance = Infinity;
      for (const surface of hole.surfaces || []) {
        if (surface.side !== 'top') continue;
        if (x < surface.xMin || x > surface.xMax) continue;
        const y = NG.TerrainUtil.sampleSurface(surface, x);
        if (!Number.isFinite(y)) continue;
        const distance = Math.abs(y - referenceY);
        if (distance < bestDistance) {
          bestDistance = distance;
          best = y;
        }
      }
      return best == null ? referenceY : best;
    }

    /** Media móvil de 3 puntos, con los extremos fijos. */
    smooth(points, passes) {
      for (let pass = 0; pass < passes; pass += 1) {
        const previous = points.map((p) => p.y);
        for (let i = 1; i < points.length - 1; i += 1) {
          points[i].y = (previous[i - 1] + previous[i] * 2 + previous[i + 1]) * 0.25;
        }
      }
    }

    /** Punto del recorrido a una fracción 0..1 de su longitud. */
    sampleAt(t) {
      const points = this.path.points;
      const target = clamp(t, 0, 1) * this.path.length;
      let lo = 0;
      let hi = points.length - 1;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (points[mid].s <= target) lo = mid;
        else hi = mid;
      }
      const a = points[lo];
      const b = points[hi];
      const span = Math.max(0.0001, b.s - a.s);
      const k = clamp((target - a.s) / span, 0, 1);
      return { x: lerp(a.x, b.x, k), y: lerp(a.y, b.y, k) };
    }

    start(hole, onFinish) {
      const cfg = CONFIG.holeIntro;
      if (!cfg?.enabled || !hole?.tee || !hole?.cup) {
        this.active = false;
        onFinish?.();
        return false;
      }
      this.hole = hole;
      this.path = this.buildPath(hole);
      this.phases = {
        hold: Math.max(0, cfg.holdSeconds),
        travel: Math.max(0.2, cfg.travelSeconds),
        settle: Math.max(0, cfg.settleSeconds),
      };
      this.duration = this.phases.hold + this.phases.travel + this.phases.settle;
      this.time = 0;
      this.active = true;
      this.onFinish = onFinish || null;
      return true;
    }

    /**
     * Encuadre de este frame, o null si ya no hay presentación.
     * Devuelve punto de foco, zoom y anclaje; el último tramo aterriza justo
     * en el encuadre de juego para que el traspaso no se note.
     */
    update(dt) {
      if (!this.active) return null;
      this.time += Math.max(0, Number(dt) || 0);
      const cfg = CONFIG.holeIntro;
      const cam = CONFIG.camera;
      const { hold, travel, settle } = this.phases;

      if (this.time >= this.duration) return this.finish();

      // Fase 1 · la bandera. Un respiro quieto sobre la copa: es el dato que
      // el jugador necesita antes que ningún otro.
      if (this.time < hold) {
        const t = hold > 0 ? this.time / hold : 1;
        return {
          x: this.hole.cup.x,
          y: this.hole.cup.y - FLIGHT_HEIGHT * 0.55,
          zoom: lerp(cfg.cupZoom, cfg.travelZoom, easeOut(clamp(t, 0, 1)) * 0.35),
          anchorX: 0.5,
          anchorY: 0.5,
          phase: 'cup',
        };
      }

      // Fase 2 · el recorrido. Plano abierto para que se lea el trazado, con
      // arranque y frenada suaves: un barrido a velocidad constante se percibe
      // como un tirón al empezar y otro al parar.
      if (this.time < hold + travel) {
        const t = easeInOut(clamp((this.time - hold) / travel, 0, 1));
        const point = this.sampleAt(t);
        // El zoom respira: se abre en mitad del trayecto y se cierra al llegar.
        const breath = Math.sin(clamp(t, 0, 1) * Math.PI);
        return {
          x: point.x,
          y: point.y,
          zoom: lerp(cfg.travelZoom, cfg.travelZoom * 0.94, breath),
          anchorX: lerp(0.5, cam.anchorX, t * t),
          anchorY: lerp(0.5, cam.anchorY, t * t),
          phase: 'travel',
        };
      }

      // Fase 3 · aterrizaje. Se acaba exactamente en el encuadre de juego, así
      // que cuando la cámara normal toma el mando no hay ningún salto.
      const t = settle > 0 ? easeOut(clamp((this.time - hold - travel) / settle, 0, 1)) : 1;
      return {
        x: this.hole.tee.x,
        y: lerp(this.hole.tee.y - FLIGHT_HEIGHT * 0.55, this.hole.tee.y, t),
        zoom: lerp(cfg.travelZoom, cam.restZoom, t),
        anchorX: cam.anchorX,
        anchorY: cam.anchorY,
        phase: 'settle',
      };
    }

    /** Corta la presentación. Se usa igual al terminar que al saltarla. */
    finish() {
      if (!this.active) return null;
      this.active = false;
      this.time = 0;
      this.path = null;
      const callback = this.onFinish;
      this.onFinish = null;
      callback?.();
      return null;
    }

    skip() {
      if (!this.active) return false;
      this.finish();
      return true;
    }

    isActive() {
      return this.active;
    }
  }

  NG.HoleIntro = HoleIntro;
}(window.NoiseGolf = window.NoiseGolf || {}));
