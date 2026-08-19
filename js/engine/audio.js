(function (NG) {
  'use strict';

  const { CONFIG } = NG;
  const { clamp, lerp } = NG.MathUtil;

  const STORAGE_KEY = 'noiseGolf.audio.v1';

  function safeGet(key) {
    try { return window.localStorage ? window.localStorage.getItem(key) : null; } catch (_) { return null; }
  }
  function safeSet(key, value) {
    try { if (window.localStorage) window.localStorage.setItem(key, value); } catch (_) { /* noop */ }
  }

  /**
   * Música de partida.
   *
   * Tres reglas, y el resto es servidumbre del navegador:
   *   1. Suena solo dentro de la partida. El menú se queda en silencio a
   *      propósito, para que empezar a jugar tenga entrada musical.
   *   2. Vuelve a empezar desde el principio en cada mapa nuevo.
   *   3. El volumen lo manda el jugador y se recuerda en este navegador.
   *
   * La servidumbre: los navegadores bloquean el audio hasta que hay un gesto
   * del usuario, así que un `play()` rechazado NO es un error —es el estado
   * normal antes del primer clic—. Se guarda la intención y se reintenta con
   * el primer gesto que llegue.
   *
   * Las entradas y salidas van con fundido porque cortar una pista en seco se
   * oye como un fallo del juego, y aquí hay un corte cada vez que cambia el
   * mapa.
   */
  class MusicPlayer {
    constructor() {
      const stored = this.load();
      this.volume = stored.volume;
      this.muted = stored.muted;
      // Ganancia del fundido (0..1). Se multiplica por el volumen del jugador:
      // así el fundido no pisa el ajuste ni al revés.
      this.gain = 0;
      this.fade = null;
      this.wanted = false;
      this.blocked = false;
      this.audio = null;
      this.bindUnlock();
    }

    load() {
      let parsed = null;
      try { parsed = JSON.parse(safeGet(STORAGE_KEY) || 'null'); } catch (_) { parsed = null; }
      const fallback = CONFIG.audio.defaultMusicVolume;
      const volume = parsed && Number.isFinite(Number(parsed.volume)) ? clamp(Number(parsed.volume), 0, 1) : fallback;
      return { volume, muted: !!(parsed && parsed.muted) };
    }

    save() {
      safeSet(STORAGE_KEY, JSON.stringify({ volume: this.volume, muted: this.muted }));
    }

    /**
     * Rescate del bloqueo de autoplay: al primer gesto del usuario se reintenta
     * lo que el navegador rechazó. Se registra una sola vez y se desengancha en
     * cuanto sirve, para no dejar escuchas colgados del documento.
     */
    bindUnlock() {
      const retry = () => {
        if (this.wanted && this.blocked) this.play();
        if (!this.blocked) release();
      };
      const release = () => {
        window.removeEventListener('pointerdown', retry, true);
        window.removeEventListener('keydown', retry, true);
      };
      window.addEventListener('pointerdown', retry, true);
      window.addEventListener('keydown', retry, true);
    }

    /**
     * La pista pesa varios megas, así que el elemento no se crea hasta que de
     * verdad hace falta: en el menú no se descarga nada.
     */
    ensureAudio() {
      if (this.audio) return this.audio;
      const el = new Audio();
      el.src = CONFIG.audio.musicTrack;
      el.loop = !!CONFIG.audio.loop;
      el.preload = 'auto';
      el.volume = 0;
      this.audio = el;
      return el;
    }

    /** Empieza (o reinicia) la pista desde el segundo cero. */
    start() {
      const cfg = CONFIG.audio;
      this.wanted = true;
      const el = this.ensureAudio();
      // Antes de tener metadatos esto puede fallar; no es motivo para no sonar.
      try { el.currentTime = 0; } catch (_) { /* noop */ }
      this.gain = 0;
      this.fade = { from: 0, to: 1, elapsed: 0, duration: Math.max(0.01, cfg.fadeInSeconds), pauseAtEnd: false };
      this.apply();
      this.play();
    }

    stop() {
      this.wanted = false;
      if (!this.audio) return;
      this.fade = {
        from: this.gain, to: 0, elapsed: 0,
        duration: Math.max(0.01, CONFIG.audio.fadeOutSeconds), pauseAtEnd: true,
      };
    }

    play() {
      const el = this.ensureAudio();
      const attempt = el.play();
      if (!attempt || typeof attempt.then !== 'function') return;
      attempt.then(() => { this.blocked = false; }).catch(() => { this.blocked = true; });
    }

    /** Avanza el fundido. Lo llama el bucle del juego con su propio dt. */
    update(dt) {
      if (!this.fade || !this.audio) return;
      this.fade.elapsed += dt;
      const t = clamp(this.fade.elapsed / this.fade.duration, 0, 1);
      this.gain = lerp(this.fade.from, this.fade.to, t);
      this.apply();
      if (t < 1) return;
      const finished = this.fade;
      this.fade = null;
      if (finished.pauseAtEnd) this.audio.pause();
    }

    apply() {
      if (!this.audio) return;
      this.audio.volume = clamp(this.muted ? 0 : this.volume * this.gain, 0, 1);
    }

    getVolume() { return this.volume; }
    isMuted() { return this.muted; }
    isPlaying() { return !!this.audio && !this.audio.paused; }
    /** El navegador rechazó el audio y aún no ha habido gesto que lo desbloquee. */
    isBlocked() { return this.wanted && this.blocked; }

    setVolume(value) {
      this.volume = clamp(Number(value) || 0, 0, 1);
      // Mover el control por encima de cero es una forma de decir "quiero oírlo".
      if (this.volume > 0) this.muted = false;
      this.apply();
      this.save();
      return this.volume;
    }

    setMuted(value) {
      this.muted = !!value;
      this.apply();
      this.save();
      return this.muted;
    }

    toggleMuted() { return this.setMuted(!this.muted); }
  }

  NG.MusicPlayer = MusicPlayer;
}(window.NoiseGolf = window.NoiseGolf || {}));
