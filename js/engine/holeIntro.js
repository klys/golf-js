(function (NG) {
  'use strict';

  const { CONFIG } = NG;
  const { clamp, lerp } = NG.MathUtil;

  // Puntos de la trayectoria. Se calcula una vez por hoyo, así que salen
  // gratis y cuantos más haya menos se nota el muestreo del terreno.
  const PATH_SAMPLES = 96;
  // Altura sobre el suelo a la que vuela la cámara. Suficiente para leer el
  // terreno sin que el recorrido se convierta en un plano del cielo.
  const FLIGHT_HEIGHT = 96;

  /**
   * Quíntica de Perlin: velocidad Y aceleración nulas en los dos extremos.
   * La cúbica clásica solo anula la velocidad, y ese resto de aceleración es
   * lo que se percibe como un pequeño tirón al arrancar y al frenar.
   */
  const smoother = (t) => {
    const k = clamp(t, 0, 1);
    return k * k * k * (k * (k * 6 - 15) + 10);
  };

  /**
   * Interpolación GEOMÉTRICA del zoom.
   * El zoom se percibe en proporciones, no en diferencias: pasar de 0,2 a 1,0
   * en línea recta se ve como un frenazo al final, porque la primera mitad
   * duplica la escala y la segunda apenas la cambia un 20 %.
   */
  const lerpZoom = (from, to, t) => {
    const a = Math.max(0.0001, from);
    const b = Math.max(0.0001, to);
    return a * Math.pow(b / a, clamp(t, 0, 1));
  };

  /**
   * Presentación del hoyo.
   *
   * Cinco tiempos encadenados: panorámica del mapa entero, bajada hasta la
   * bandera, respiro sobre la copa, recorrido del campo hasta la salida y
   * aterrizaje en el encuadre de juego. El jugador llega al primer golpe
   * sabiendo cómo es el mapa, dónde está el hoyo y qué hay por el camino.
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
      this.travelBreath = 1;
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
      this.smooth(points, 5);

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

    /** Centro del mapa: el punto sobre el que se abre la panorámica. */
    worldCenter(hole) {
      return {
        x: (hole.bounds.minX + hole.bounds.maxX) * 0.5,
        y: (hole.bounds.minY + hole.bounds.maxY) * 0.5,
      };
    }

    /**
     * Zoom al que el mapa entero cabe en pantalla.
     * Se calcula cada frame porque depende del viewport: redimensionar la
     * ventana a mitad de presentación no debe dejar medio mapa fuera.
     */
    panoramaZoom(hole, viewport) {
      const cfg = CONFIG.holeIntro;
      const width = (hole.bounds.maxX - hole.bounds.minX) + CONFIG.course.worldMargin * 2;
      const height = (hole.bounds.maxY - hole.bounds.minY) * 1.06;
      const fit = Math.min(
        viewport.width / Math.max(1, width),
        viewport.height / Math.max(1, height),
      );
      // El techo es el zoom de juego: en un mapa diminuto la panorámica no
      // tiene por qué acercarse más de lo que ya se ve jugando.
      return clamp(fit * cfg.panoramaFit, cfg.panoramaMinZoom, CONFIG.camera.restZoom);
    }

    start(hole, viewport, onFinish) {
      const cfg = CONFIG.holeIntro;
      if (!cfg?.enabled || !hole?.tee || !hole?.cup || !hole?.bounds) {
        this.active = false;
        onFinish?.();
        return false;
      }
      this.hole = hole;
      this.path = this.buildPath(hole);
      const view = viewport && viewport.width > 0 ? viewport : { width: 1280, height: 720 };
      const travelZoom = Math.max(cfg.travelZoom, this.panoramaZoom(hole, view));
      const tuned = this.tuneTravel(cfg, travelZoom, view);
      this.travelBreath = tuned.breath;
      this.phases = {
        panorama: Math.max(0, cfg.panoramaSeconds),
        approach: Math.max(0.2, cfg.approachSeconds),
        hold: Math.max(0, cfg.holdSeconds),
        travel: tuned.duration,
        settle: Math.max(0, cfg.settleSeconds),
      };
      this.duration = this.phases.panorama + this.phases.approach
        + this.phases.hold + this.phases.travel + this.phases.settle;
      this.time = 0;
      this.active = true;
      this.onFinish = onFinish || null;
      return true;
    }

    /**
     * Encuadre del barrido en un instante dado, en coordenadas de mundo.
     *
     * Se usa igual para dibujar que para medir el ritmo antes de empezar, así
     * que lo que se mide es exactamente lo que se verá.
     */
    travelFrameAt(t, breath, travelZoom, viewport) {
      const cam = CONFIG.camera;
      const k = smoother(t);
      const point = this.sampleAt(k);
      const zoom = lerpZoom(travelZoom, travelZoom * breath, Math.sin(k * Math.PI));
      const worldW = viewport.width / zoom;
      const worldH = viewport.height / zoom;
      // Centro del encuadre: el anclaje se desplaza de centrado al de juego
      // durante el barrido, y ese desplazamiento también mueve la imagen.
      return {
        x: point.x + worldW * (0.5 - lerp(0.5, cam.anchorX, k)),
        y: point.y + worldH * (0.5 - lerp(0.5, cam.anchorY, k)),
        zoom,
      };
    }

    /** Velocidad aparente máxima del barrido, en píxeles de pantalla/s. */
    travelPeakSpeed(duration, breath, travelZoom, viewport) {
      const steps = 140;
      const dt = Math.max(0.0001, duration / steps);
      let peak = 0;
      let previous = this.travelFrameAt(0, breath, travelZoom, viewport);
      for (let i = 1; i <= steps; i += 1) {
        const current = this.travelFrameAt(i / steps, breath, travelZoom, viewport);
        const zoom = (current.zoom + previous.zoom) * 0.5;
        const speed = (Math.hypot(current.x - previous.x, current.y - previous.y) * zoom) / dt;
        if (speed > peak) peak = speed;
        previous = current;
      }
      return peak;
    }

    /**
     * Duración y apertura del barrido, ajustadas al ritmo objetivo.
     *
     * No se estiman con una fórmula: se MIDE el recorrido completo y se
     * corrige hasta que la velocidad aparente entra en el objetivo. Una
     * fórmula cerrada se quedaba corta porque, además del avance por el
     * trazado, mueven la imagen el zoom respirando y el anclaje desplazándose,
     * y esos dos términos dependen entre sí.
     *
     * El orden de las correcciones no es casual: primero se abre el plano
     * —cuesta cero tiempo y encima enseña más trazado— y solo cuando ya no da
     * más de sí se alarga la toma.
     */
    tuneTravel(cfg, travelZoom, viewport) {
      const target = Math.max(200, cfg.travelPeakScreenSpeed);
      const maxDuration = Math.max(cfg.travelSeconds, cfg.travelMaxSeconds);
      let duration = Math.max(0.2, cfg.travelSeconds);
      let breath = clamp(cfg.travelBreath, cfg.travelBreathMin, 1);
      for (let pass = 0; pass < 8; pass += 1) {
        const peak = this.travelPeakSpeed(duration, breath, travelZoom, viewport);
        if (peak <= target) break;
        const excess = peak / target;
        const wantBreath = clamp(breath / excess, cfg.travelBreathMin, cfg.travelBreath);
        if (wantBreath < breath - 0.0001) { breath = wantBreath; continue; }
        const wantDuration = Math.min(maxDuration, duration * excess);
        if (wantDuration <= duration + 0.0001) break;
        duration = wantDuration;
      }
      return { duration, breath };
    }

    /**
     * Encuadre de este frame, o null si ya no hay presentación.
     *
     * Cada tramo entrega el encuadre EXACTO con el que arranca el siguiente
     * —posición, zoom y anclaje—, así que entre fases no hay ningún salto: lo
     * único que cambia es hacia dónde se mueve la cámara a partir de ahí.
     */
    update(dt, viewport) {
      if (!this.active) return null;
      this.time += Math.max(0, Number(dt) || 0);
      const cfg = CONFIG.holeIntro;
      const cam = CONFIG.camera;
      const { panorama, approach, hold, travel, settle } = this.phases;

      if (this.time >= this.duration) return this.finish();

      const view = viewport && viewport.width > 0 ? viewport : { width: 1280, height: 720 };
      const wide = this.panoramaZoom(this.hole, view);
      const center = this.worldCenter(this.hole);
      const cup = { x: this.hole.cup.x, y: this.hole.cup.y - FLIGHT_HEIGHT * 0.55 };
      // El zoom de la copa nunca debe quedar por debajo de la panorámica: en
      // un mapa minúsculo eso invertiría el sentido del movimiento.
      const cupZoom = Math.max(cfg.cupZoom, wide);
      const travelZoom = Math.max(cfg.travelZoom, wide);
      let mark = 0;

      // Fase 1 · el mapa entero. Un empuje lentísimo desde un plano algo más
      // abierto: un encuadre completamente fijo no se lee como una cámara,
      // se lee como una captura de pantalla.
      mark += panorama;
      if (this.time < mark) {
        const t = smoother(panorama > 0 ? this.time / panorama : 1);
        return {
          x: center.x,
          y: center.y,
          zoom: lerpZoom(wide * cfg.panoramaOvershoot, wide, t),
          minZoom: cfg.panoramaMinZoom,
          anchorX: 0.5,
          anchorY: 0.5,
          clamp: 0,
          phase: 'panorama',
        };
      }

      // Fase 2 · bajada del plano general a la bandera. Aquí es donde el zoom
      // geométrico se nota: recorre un factor grande y tiene que hacerlo a
      // ritmo constante en proporción, no en píxeles.
      mark += approach;
      if (this.time < mark) {
        const t = smoother((this.time - (mark - approach)) / approach);
        // El zoom va DETRÁS del desplazamiento. Es el truco de toda toma de
        // acercamiento: se recorre el mapa mientras el plano aún es general
        // —donde mil píxeles de mundo son diez de pantalla— y solo se cierra
        // al final, ya casi parados. Cerrar y desplazar a la vez es lo que
        // convierte un acercamiento en un latigazo.
        // `t²` conserva derivada nula en los dos extremos, así que el enlace
        // con la panorámica y con la bandera sigue siendo continuo.
        return {
          x: lerp(center.x, cup.x, t),
          y: lerp(center.y, cup.y, t),
          zoom: lerpZoom(wide, cupZoom, t * t),
          minZoom: cfg.panoramaMinZoom,
          anchorX: 0.5,
          anchorY: 0.5,
          clamp: 0,
          phase: 'approach',
        };
      }

      // Fase 3 · la bandera. Quieto sobre la copa, abriendo plano muy despacio
      // hasta el encuadre exacto con el que arranca el recorrido.
      mark += hold;
      if (this.time < mark) {
        const t = smoother(hold > 0 ? (this.time - (mark - hold)) / hold : 1);
        return {
          x: cup.x,
          y: cup.y,
          zoom: lerpZoom(cupZoom, travelZoom, t),
          minZoom: cfg.panoramaMinZoom,
          anchorX: 0.5,
          anchorY: 0.5,
          clamp: 0,
          phase: 'cup',
        };
      }

      // Fase 4 · el recorrido. Plano abierto para que se lea el trazado, con
      // arranque y frenada suaves: un barrido a velocidad constante se percibe
      // como un tirón al empezar y otro al parar.
      mark += travel;
      if (this.time < mark) {
        const raw = clamp((this.time - (mark - travel)) / travel, 0, 1);
        const t = smoother(raw);
        const point = this.sampleAt(t);
        // El zoom respira: se abre en mitad del trayecto y vuelve al de partida
        // al llegar, de modo que el enlace con el aterrizaje es continuo. La
        // apertura cae justo donde el barrido va más rápido, así que además de
        // enseñar el trazado entero frena lo que el ojo percibe.
        const breath = Math.sin(t * Math.PI);
        return {
          x: point.x,
          y: point.y,
          zoom: lerpZoom(travelZoom, travelZoom * this.travelBreath, breath),
          minZoom: cfg.panoramaMinZoom,
          anchorX: lerp(0.5, cam.anchorX, t),
          anchorY: lerp(0.5, cam.anchorY, t),
          clamp: 0,
          phase: 'travel',
        };
      }

      // Fase 5 · aterrizaje. Se acaba exactamente en el encuadre de juego, así
      // que cuando la cámara normal toma el mando no hay ningún salto.
      const t = smoother(settle > 0 ? (this.time - mark) / settle : 1);
      return {
        x: this.hole.tee.x,
        y: lerp(this.hole.tee.y - FLIGHT_HEIGHT * 0.55, this.hole.tee.y, t),
        zoom: lerpZoom(travelZoom, cam.restZoom, t),
        minZoom: cfg.panoramaMinZoom,
        anchorX: cam.anchorX,
        anchorY: cam.anchorY,
        // El recorte a los límites entra aquí, con la misma curva que el resto
        // del aterrizaje: el último frame es ya el encuadre de juego exacto.
        clamp: t,
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
