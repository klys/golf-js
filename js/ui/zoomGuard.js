(function (NG) {
  'use strict';

  // La referencia se guarda por pantalla: mover la ventana a un monitor con
  // otra densidad cambia devicePixelRatio sin que nadie haya tocado el zoom.
  const STORAGE_KEY = 'noiseGolf.zoomBaseline.v1';
  // Margen de comparación. Los saltos de zoom reales son de 10 puntos como
  // mínimo (90 %, 110 %…); esto solo absorbe el ruido de coma flotante.
  const TOLERANCE = 0.005;
  // Red de seguridad para las vías que no emiten evento: el zoom del menú del
  // navegador en algunas versiones, o la lupa del sistema operativo.
  const POLL_MS = 700;

  const safeGet = (key) => {
    try { return window.localStorage ? window.localStorage.getItem(key) : null; } catch (_) { return null; }
  };
  const safeSet = (key, value) => {
    try { if (window.localStorage) window.localStorage.setItem(key, value); } catch (_) { /* noop */ }
  };

  /**
   * Guardia de zoom.
   *
   * Alejar el zoom del navegador agranda el viewport en píxeles CSS, y como la
   * cámara encuadra a partir de ese tamaño, quien juega al 50 % ve el doble de
   * mapa que el resto. Es una ventaja invisible para los demás y gratis para
   * quien la usa, así que aquí se corta por dos vías:
   *
   *  1. Se bloquea lo bloqueable: Ctrl + rueda, Ctrl con +/-/0 y los gestos de
   *     pellizco de Safari.
   *  2. Lo que el navegador no deja interceptar —su propio menú, la lupa del
   *     sistema— se DETECTA y se tapa la partida hasta volver al 100 %.
   *
   * La detección compara contra la escala con la que se abrió el juego por
   * primera vez en esa pantalla, no contra un 1 absoluto: un portátil HiDPI o
   * un escalado de Windows al 150 % son estados legítimos.
   */
  class ZoomGuard {
    constructor(options = {}) {
      this.root = document.querySelector('#zoomGuard');
      this.value = document.querySelector('#zoomGuardValue');
      this.onChange = typeof options.onChange === 'function' ? options.onChange : null;
      this.active = false;
      this.baseline = this.resolveBaseline();
      this.timer = 0;
      this.bind();
      this.check();
    }

    /** Densidad de referencia: la de la primera visita con esta pantalla. */
    resolveBaseline() {
      const current = this.deviceScale();
      const screenKey = this.screenKey();
      let stored = null;
      try { stored = JSON.parse(safeGet(STORAGE_KEY) || 'null'); } catch (_) { stored = null; }
      // Guardada en otra pantalla: no dice nada de esta, se vuelve a tomar.
      if (stored && stored.screen === screenKey && Number.isFinite(Number(stored.dpr)) && Number(stored.dpr) > 0) {
        return Number(stored.dpr);
      }
      safeSet(STORAGE_KEY, JSON.stringify({ screen: screenKey, dpr: current }));
      return current;
    }

    screenKey() {
      const s = window.screen || {};
      return `${s.width || 0}x${s.height || 0}`;
    }

    /** Zoom de página (Ctrl +/-): se refleja en devicePixelRatio. */
    deviceScale() {
      const dpr = Number(window.devicePixelRatio);
      return Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
    }

    /** Zoom visual (pellizco): vive en visualViewport, no en el DPR. */
    pinchScale() {
      const scale = Number(window.visualViewport?.scale);
      return Number.isFinite(scale) && scale > 0 ? scale : 1;
    }

    /** Escala efectiva respecto a la de referencia. 1 = zoom al 100 %. */
    currentZoom() {
      return (this.deviceScale() / this.baseline) * this.pinchScale();
    }

    bind() {
      // Ctrl/⌘ + rueda. El listener NO puede ser pasivo o preventDefault se
      // ignora, y va en captura para adelantarse a cualquier otro handler.
      window.addEventListener('wheel', (e) => {
        if (e.ctrlKey || e.metaKey) e.preventDefault();
      }, { passive: false, capture: true });

      window.addEventListener('keydown', (e) => {
        if (!e.ctrlKey && !e.metaKey) return;
        const key = String(e.key || '');
        const code = String(e.code || '');
        const isZoomKey = key === '+' || key === '-' || key === '=' || key === '_' || key === '0'
          || code === 'NumpadAdd' || code === 'NumpadSubtract' || code === 'Numpad0'
          || code === 'Equal' || code === 'Minus' || code === 'Digit0';
        if (isZoomKey) e.preventDefault();
      }, { capture: true });

      // Gestos de pellizco de Safari: no generan wheel ni touch estándar.
      for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
        window.addEventListener(type, (e) => e.preventDefault(), { passive: false, capture: true });
      }

      const recheck = () => this.check();
      window.addEventListener('resize', recheck);
      window.visualViewport?.addEventListener('resize', recheck);
      window.visualViewport?.addEventListener('scroll', recheck);
      // matchMedia sobre la resolución actual avisa del cambio de DPR incluso
      // cuando no hay resize (ventana ya maximizada, cambio de monitor).
      this.watchResolution();
      this.timer = window.setInterval(recheck, POLL_MS);
    }

    /** Se re-suscribe en cada cambio porque la consulta lleva el DPR dentro. */
    watchResolution() {
      if (!window.matchMedia) return;
      const query = window.matchMedia(`(resolution: ${this.deviceScale()}dppx)`);
      const handler = () => {
        this.check();
        this.watchResolution();
      };
      if (query.addEventListener) query.addEventListener('change', handler, { once: true });
      else if (query.addListener) query.addListener(handler);
    }

    check() {
      const zoom = this.currentZoom();
      const invalid = Math.abs(zoom - 1) > TOLERANCE;
      if (this.value) {
        const percent = Math.round(zoom * 100);
        this.value.textContent = `${percent}%`;
      }
      if (invalid === this.active) return;
      this.active = invalid;
      if (this.root) {
        this.root.hidden = !invalid;
        this.root.classList.toggle('hidden', !invalid);
      }
      document.body?.classList.toggle('zoom-blocked', invalid);
      this.onChange?.(invalid, zoom);
    }

    isBlocked() {
      return this.active;
    }

    /**
     * Reajusta la referencia a la escala actual. No lo usa la interfaz: existe
     * para soporte, cuando una primera visita quedó registrada ya con zoom.
     */
    recalibrate() {
      this.baseline = this.deviceScale();
      safeSet(STORAGE_KEY, JSON.stringify({ screen: this.screenKey(), dpr: this.baseline }));
      this.check();
      return this.baseline;
    }
  }

  NG.ZoomGuard = ZoomGuard;
}(window.NoiseGolf = window.NoiseGolf || {}));
