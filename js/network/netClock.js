(function (NG) {
  'use strict';

  /**
   * Estimador del reloj de simulación del host.
   *
   * Cada snapshot trae el `worldTime` del host. Comparándolo con la hora local
   * de llegada obtenemos un offset; el problema es que ese offset lleva encima
   * el jitter de la red, así que usarlo crudo hace vibrar todo lo que depende
   * del tiempo (plataformas móviles, muros, spinners, viento).
   *
   * Aquí guardamos una ventana de offsets y nos quedamos con el MÍNIMO
   * reciente: el paquete que menos tardó es el que menos ruido acumula, igual
   * que en NTP. El reloj expuesto nunca salta, solo acelera o frena un poco
   * hasta alcanzar la estimación, de forma que el tiempo que ve el render es
   * siempre monótono y continuo.
   */
  class NetClock {
    constructor(options = {}) {
      this.windowMs = Number(options.windowMs) || 5000;
      // Ritmo máximo de corrección: ±12% es imperceptible y absorbe la deriva
      // entre el reloj del host y el nuestro sin producir tirones.
      this.maxRate = Number(options.maxRate) || 0.12;
      // Por encima de este desfase asumimos cambio de mundo/resync y saltamos.
      this.resyncThreshold = Number(options.resyncThreshold) || 1.2;
      this.reset();
    }

    reset(hostTime = null, localNowMs = null) {
      this.samples = [];
      this.offset = null;
      this.targetOffset = null;
      this.lastLocalMs = Number.isFinite(localNowMs) ? localNowMs : null;
      this.value = 0;
      this.initialized = false;
      if (Number.isFinite(hostTime) && Number.isFinite(localNowMs)) this.push(hostTime, localNowMs, true);
    }

    /**
     * Registra la llegada de un snapshot.
     * @param {number} hostTime  worldTime del host, en segundos.
     * @param {number} localNowMs performance.now() del momento de llegada.
     * @param {boolean} hard  fuerza salto inmediato (init/resync/cambio de mapa).
     */
    push(hostTime, localNowMs, hard = false) {
      if (!Number.isFinite(hostTime) || !Number.isFinite(localNowMs)) return;
      const offset = hostTime - localNowMs / 1000;
      this.samples.push({ offset, at: localNowMs });
      const cutoff = localNowMs - this.windowMs;
      while (this.samples.length && this.samples[0].at < cutoff) this.samples.shift();
      if (this.samples.length > 240) this.samples.shift();

      // El menor offset de la ventana equivale al viaje más rápido observado.
      let best = this.samples[0].offset;
      for (const sample of this.samples) if (sample.offset < best) best = sample.offset;
      this.targetOffset = best;

      const jump = !this.initialized || hard
        || (this.offset != null && Math.abs(best - this.offset) > this.resyncThreshold);
      if (jump) {
        this.samples = [{ offset, at: localNowMs }];
        this.targetOffset = offset;
        this.offset = offset;
        this.value = hostTime;
        this.lastLocalMs = localNowMs;
        this.initialized = true;
      }
    }

    /**
     * Avanza el reloj hasta `localNowMs`. Devuelve el tiempo de host estimado.
     * Se llama una vez por frame, antes de muestrear posiciones.
     */
    advance(localNowMs) {
      if (!this.initialized) return this.value;
      const previous = this.lastLocalMs == null ? localNowMs : this.lastLocalMs;
      const dt = Math.max(0, (localNowMs - previous) / 1000);
      this.lastLocalMs = localNowMs;

      const ideal = this.targetOffset == null ? this.offset : this.targetOffset;
      const error = ideal - this.offset;
      // Corregimos el offset a ritmo limitado: el tiempo percibido avanza a
      // 1±maxRate, nunca hacia atrás.
      const step = Math.max(-this.maxRate * dt, Math.min(this.maxRate * dt, error));
      this.offset += step;

      const next = localNowMs / 1000 + this.offset;
      this.value = Math.max(this.value, next);
      return this.value;
    }

    now() { return this.value; }

    /** Desfase pendiente de absorber, en milisegundos. Solo diagnóstico. */
    driftMs() {
      if (!this.initialized || this.targetOffset == null) return 0;
      return (this.targetOffset - this.offset) * 1000;
    }
  }

  /**
   * Acumulador de paso fijo.
   *
   * La simulación avanza siempre en pasos de `stepDt`, pase lo que pase con
   * los FPS: a 144 Hz habrá frames sin paso y a 25 Hz habrá varios pasos
   * seguidos, pero el resultado físico es el mismo. `alpha` es la fracción de
   * paso sobrante y sirve para interpolar el render entre el estado anterior y
   * el actual, de modo que el paso fijo no se ve a más FPS que la simulación.
   */
  class FixedStep {
    constructor(hz) {
      this.setRate(hz);
      this.accumulator = 0;
      this.alpha = 0;
      this.steps = 0;
      this.dropped = 0;
    }

    setRate(hz) {
      const rate = Math.max(20, Math.min(240, Number(hz) || 60));
      this.hz = rate;
      this.stepDt = 1 / rate;
    }

    /**
     * @param {number} dt segundos reales transcurridos.
     * @param {(stepDt:number)=>void} run se invoca una vez por paso fijo.
     */
    run(dt, run) {
      const maxSteps = Math.max(1, Number(NG.NET_CONFIG?.maxStepsPerFrame) || 6);
      const maxAccumulator = Math.max(this.stepDt * 2, Number(NG.NET_CONFIG?.maxAccumulatorSeconds) || 0.35);
      this.accumulator += Math.max(0, Number(dt) || 0);
      if (this.accumulator > maxAccumulator) {
        // Congelación larga (pestaña en segundo plano, GC): descartamos el
        // retraso en vez de intentar recuperarlo con una ráfaga de pasos.
        this.dropped += this.accumulator - maxAccumulator;
        this.accumulator = maxAccumulator;
      }
      let steps = 0;
      while (this.accumulator >= this.stepDt && steps < maxSteps) {
        run(this.stepDt);
        this.accumulator -= this.stepDt;
        steps += 1;
      }
      if (steps >= maxSteps && this.accumulator > this.stepDt) {
        this.dropped += this.accumulator;
        this.accumulator = 0;
      }
      this.steps = steps;
      this.alpha = Math.max(0, Math.min(1, this.accumulator / this.stepDt));
      return steps;
    }

    reset() {
      this.accumulator = 0;
      this.alpha = 0;
      this.steps = 0;
    }
  }

  NG.NetClock = NetClock;
  NG.FixedStep = FixedStep;
}(window.NoiseGolf = window.NoiseGolf || {}));
