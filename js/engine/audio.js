(function (NG) {
  'use strict';

  const { CONFIG } = NG;
  const { clamp, lerp, expSmoothing } = NG.MathUtil;

  const STORAGE_KEY = 'noiseGolf.audio.v1';

  function safeGet(key) {
    try { return window.localStorage ? window.localStorage.getItem(key) : null; } catch (_) { return null; }
  }
  function safeSet(key, value) {
    try { if (window.localStorage) window.localStorage.setItem(key, value); } catch (_) { /* noop */ }
  }

  /**
   * Música de partida, con mezcla viva.
   *
   * Tres reglas de siempre:
   *   1. Suena solo dentro de la partida; el menú se queda en silencio.
   *   2. Vuelve a empezar desde cero en cada mapa nuevo.
   *   3. El volumen lo manda el jugador y se recuerda en este navegador.
   *
   * Y la regla que gobierna todo lo demás: **el volumen del jugador es el
   * TECHO, no el nivel**. Todos los modificadores —cercanía al hoyo, tensión
   * del vuelo largo, hundirse en el agua— se mueven dentro de [0, 1] y se
   * multiplican por él. Subir de volumen nunca significa pasarse de lo que el
   * jugador pidió: significa acercarse a su máximo. Por eso la música en
   * reposo suena por debajo del tope, para que quede sitio donde crecer.
   *
   * La mezcla va por Web Audio:
   *
   *     <audio> ─► paso bajo ─► realce de graves ─┬─► seco ──────────┐
   *              (hundimiento)   (tensión)        └─► reverb ─► húmedo ─┴─► maestro ─► salida
   *
   * Si el navegador no tiene Web Audio (o lo bloquea, típico en `file://`), el
   * grafo se descarta entero y queda el volumen del elemento: se pierden los
   * efectos, no la música.
   */
  class MusicPlayer {
    constructor() {
      const cfg = CONFIG.audio;
      const stored = this.load();
      this.volume = stored.volume;
      this.muted = stored.muted;

      // Ganancia del fundido de entrada/salida (0..1), independiente de todo
      // lo demás para que un fundido no pise la mezcla ni al revés.
      this.gain = 0;
      this.fade = null;
      this.wanted = false;
      this.blocked = false;
      this.audio = null;
      this.graph = null;
      this.graphFailed = false;

      // Estado de la mezcla. Se arranca ya en reposo para que el primer frame
      // no dé un salto audible.
      this.level = cfg.baseLevel;
      this.cutoff = cfg.baseCutoff;
      this.bassDb = 0;
      this.wetMix = cfg.baseReverb;

      // Lectura del partido.
      this.movingSeconds = 0;
      this.impact = null;

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
     * lo que el navegador rechazó, y de paso se despierta el AudioContext, que
     * nace suspendido por la misma política.
     */
    bindUnlock() {
      const retry = () => {
        if (this.graph?.ctx.state === 'suspended') this.graph.ctx.resume().catch(() => {});
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

    /**
     * Cola de reverb generada, no grabada.
     *
     * Un impulso de sala es ruido que se apaga, y sintetizarlo cuesta un
     * milisegundo. Traerlo como archivo significaría otro asset que descargar,
     * versionar y mantener para algo que nadie va a distinguir de esto.
     */
    buildImpulse(ctx) {
      const cfg = CONFIG.audio;
      const rate = ctx.sampleRate;
      const length = Math.max(1, Math.floor(rate * cfg.reverbSeconds));
      const buffer = ctx.createBuffer(2, length, rate);
      for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
        const data = buffer.getChannelData(channel);
        for (let i = 0; i < length; i += 1) {
          data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, cfg.reverbDecay);
        }
      }
      return buffer;
    }

    ensureGraph() {
      if (this.graph || this.graphFailed || !this.audio) return this.graph;
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) { this.graphFailed = true; return null; }
      try {
        const cfg = CONFIG.audio;
        const ctx = new Ctx();
        const source = ctx.createMediaElementSource(this.audio);

        const muffle = ctx.createBiquadFilter();
        muffle.type = 'lowpass';
        muffle.frequency.value = cfg.baseCutoff;
        muffle.Q.value = 0.7;

        const bass = ctx.createBiquadFilter();
        bass.type = 'lowshelf';
        bass.frequency.value = cfg.bassFrequency;
        bass.gain.value = 0;

        const verb = ctx.createConvolver();
        verb.buffer = this.buildImpulse(ctx);

        const dry = ctx.createGain();
        const wet = ctx.createGain();
        const master = ctx.createGain();
        dry.gain.value = 1;
        wet.gain.value = cfg.baseReverb;
        master.gain.value = 0;

        source.connect(muffle);
        muffle.connect(bass);
        bass.connect(dry);
        bass.connect(verb);
        verb.connect(wet);
        dry.connect(master);
        wet.connect(master);
        master.connect(ctx.destination);

        // A partir de aquí el nivel lo manda el grafo, no el elemento.
        this.audio.volume = 1;
        this.graph = { ctx, muffle, bass, verb, dry, wet, master };
        return this.graph;
      } catch (_) {
        // `file://`, políticas raras o navegadores viejos. Que falte el
        // reverb no es motivo para quedarse sin música.
        this.graphFailed = true;
        return null;
      }
    }

    /** Empieza (o reinicia) la pista desde el segundo cero. */
    start() {
      const cfg = CONFIG.audio;
      this.wanted = true;
      const el = this.ensureAudio();
      try { el.currentTime = 0; } catch (_) { /* aún sin metadatos */ }
      this.gain = 0;
      this.fade = { from: 0, to: 1, elapsed: 0, duration: Math.max(0.01, cfg.fadeInSeconds), pauseAtEnd: false };
      // Mapa nuevo, mezcla nueva: la tensión del tiro anterior no se hereda.
      this.movingSeconds = 0;
      this.impact = null;
      this.level = cfg.baseLevel;
      this.cutoff = cfg.baseCutoff;
      this.bassDb = 0;
      this.wetMix = cfg.baseReverb;
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
      this.ensureGraph();
      if (this.graph?.ctx.state === 'suspended') this.graph.ctx.resume().catch(() => {});
      const attempt = el.play();
      if (!attempt || typeof attempt.then !== 'function') return;
      attempt.then(() => { this.blocked = false; }).catch(() => { this.blocked = true; });
    }

    /**
     * Golpe de ambiente: la bola se ha ido al agua o fuera del mapa.
     *
     * Se dispara como evento y no como estado porque el estado dura un frame:
     * la penalización devuelve la bola casi al instante. Aquí se guarda un
     * sobre que la mezcla va gastando sola.
     */
    hit(kind) {
      const preset = CONFIG.audio.impacts[kind];
      if (!preset) return;
      this.impact = { preset, remaining: preset.seconds, duration: preset.seconds };
    }

    /**
     * Mezcla del frame.
     *
     * `scene` es lo poco que la música necesita saber de la partida: a qué
     * distancia está NUESTRA bola de la copa y si sigue rodando. Se pasa desde
     * fuera para que este módulo no tenga que conocer el juego.
     */
    update(dt, scene = null) {
      const cfg = CONFIG.audio;
      const step = Math.max(0, Number(dt) || 0);

      if (this.fade && this.audio) {
        this.fade.elapsed += step;
        const t = clamp(this.fade.elapsed / this.fade.duration, 0, 1);
        this.gain = lerp(this.fade.from, this.fade.to, t);
        if (t >= 1) {
          const finished = this.fade;
          this.fade = null;
          if (finished.pauseAtEnd) this.audio.pause();
        }
      }

      // Cronómetro del tiro: sube mientras la bola rueda y se vacía cuando
      // para. Vaciarlo más rápido de lo que sube es lo que hace que la tensión
      // se deshaga sola al detenerse en vez de arrastrarse al tiro siguiente.
      if (scene?.moving) this.movingSeconds += step;
      else this.movingSeconds = Math.max(0, this.movingSeconds - step * cfg.rallyReleaseRate);

      if (this.impact) {
        this.impact.remaining -= step;
        if (this.impact.remaining <= 0) this.impact = null;
      }

      const target = this.computeTargets(scene);
      // Un golpe pide ataque corto; el resto de la mezcla, respiración lenta.
      // La forma de la recuperación ya la lleva el sobre, así que aquí el
      // suavizado rápido solo evita el chasquido.
      const response = this.impact ? cfg.impactResponse : cfg.levelResponse;
      this.level = expSmoothing(this.level, target.level, response, step);
      this.wetMix = expSmoothing(this.wetMix, target.wet, response, step);
      this.bassDb = expSmoothing(this.bassDb, target.bass, cfg.bassResponse, step);
      // El filtro se interpola en octavas: en lineal, bajar de 20 kHz a 400 Hz
      // se come todo el recorrido audible en el primer 2 % del trayecto.
      const cutoffRate = this.impact ? Math.max(cfg.cutoffResponse, cfg.impactResponse) : cfg.cutoffResponse;
      this.cutoff = Math.exp(expSmoothing(Math.log(this.cutoff), Math.log(target.cutoff), cutoffRate, step));

      this.apply();
    }

    /** Adónde quiere ir la mezcla ahora mismo. Todo en fracción del techo. */
    computeTargets(scene) {
      const cfg = CONFIG.audio;
      let level = cfg.baseLevel;
      let wet = cfg.baseReverb;
      let bass = 0;
      let cutoff = cfg.baseCutoff;

      // 1 · Cerca del hoyo. Es el efecto que el jugador va a notar más, así
      // que la curva concentra casi todo cerca de la copa: entrar en el radio
      // se insinúa, los últimos metros son los que suenan a final.
      if (scene && Number.isFinite(scene.distanceToCup)) {
        const near = Math.pow(clamp(1 - scene.distanceToCup / cfg.holeRange, 0, 1), cfg.holeCurve);
        level = lerp(level, cfg.holeLevel, near);
        wet = lerp(wet, cfg.holeReverb, near);
      }

      // 2 · Vuelo largo. Un tiro que sigue vivo pasados unos segundos es un
      // tiro que está pasando algo: graves que crecen y algo más de cuerpo.
      const rally = clamp((this.movingSeconds - cfg.rallySeconds) / Math.max(0.01, cfg.rallyRampSeconds), 0, 1);
      if (rally > 0) {
        level = Math.min(1, level + cfg.rallyLevel * rally);
        wet = Math.min(cfg.maxReverb, wet + cfg.rallyReverb * rally);
        bass = cfg.rallyBassDb * rally;
      }

      // 3 · Agua o fuera del mapa. Manda sobre lo anterior: da igual lo cerca
      // que estuvieras del hoyo, ese tiro se acabó.
      if (this.impact) {
        const preset = this.impact.preset;
        // 1 en el momento del golpe, 0 cuando la mezcla ya se ha recuperado.
        const depth = Math.pow(clamp(this.impact.remaining / this.impact.duration, 0, 1), cfg.impactCurve);
        level = lerp(level, preset.level, depth);
        cutoff = Math.exp(lerp(Math.log(cutoff), Math.log(preset.cutoff), depth));
        wet = lerp(wet, preset.reverb, depth);
        bass = lerp(bass, preset.bassDb, depth);
      }

      return { level: clamp(level, 0, 1), wet: clamp(wet, 0, cfg.maxReverb), bass, cutoff };
    }

    apply() {
      if (!this.audio) return;
      // El techo: volumen del jugador × fundido × mezcla, y la mezcla nunca
      // pasa de 1. Silenciado corta por completo sin tocar nada más.
      const level = this.muted ? 0 : clamp(this.volume * this.gain * this.level, 0, 1);
      const g = this.graph;
      if (!g) { this.audio.volume = level; return; }
      g.master.gain.value = level;
      g.muffle.frequency.value = clamp(this.cutoff, 60, 22000);
      g.bass.gain.value = this.bassDb;
      g.wet.gain.value = this.wetMix;
      // El seco cede algo de sitio al reverb en vez de sumarse entero: si no,
      // la mezcla húmeda se percibe como un subidón de volumen.
      g.dry.gain.value = 1 - this.wetMix * CONFIG.audio.dryDuck;
    }

    getVolume() { return this.volume; }
    isMuted() { return this.muted; }
    isPlaying() { return !!this.audio && !this.audio.paused; }
    /** El navegador rechazó el audio y aún no ha habido gesto que lo desbloquee. */
    isBlocked() { return this.wanted && this.blocked; }
    /** ¿Hay efectos, o el navegador dejó al reproductor sin Web Audio? */
    hasEffects() { return !!this.graph; }

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
