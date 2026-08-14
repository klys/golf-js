(function (NG) {
  'use strict';

  const { formatScore, clamp } = NG.MathUtil;

  const WIND_RING_CIRCUMFERENCE = 2 * Math.PI * 19;

  function formatInt(value) {
    return Math.max(0, Math.round(Number(value) || 0)).toLocaleString('es-ES');
  }

  /**
   * HUD de partida.
   *
   * Escribe en el DOM solo cuando el valor cambia: el bucle de juego llama a
   * update() 60 veces por segundo y reescribir textContent en cada frame
   * provoca layout thrashing innecesario.
   */
  class HUD {
    constructor() {
      const $ = (selector) => document.querySelector(selector);

      this.seed = $('#seedLabel');
      this.hole = $('#holeLabel');
      this.holeDots = $('#holeDots');
      this.stroke = $('#strokeLabel');
      this.strokeDelta = $('#strokeDelta');
      this.par = $('#parLabel');
      this.score = $('#scoreLabel');
      this.points = $('#pointsLabel');
      this.multiplier = $('#multiplierLabel');
      this.windTitle = $('#windTitleLabel');
      this.wind = $('#windLabel');
      this.windArrow = $('#windArrow');
      this.windArc = $('#windRingArc');
      this.biome = $('#biomeLabel');
      this.map = $('#mapLabel');
      this.difficulty = $('#difficultyLabel');
      this.distance = $('#distanceLabel');

      this.shotMeter = $('#shotMeter');
      this.shotFill = $('#shotMeterFill');
      this.shotPower = $('#shotPowerLabel');
      this.shotAngle = $('#shotAngleLabel');

      this.matchBar = $('#matchBar');
      this.matchBadge = $('#matchModeBadge');
      this.matchBadgeText = this.matchBadge ? this.matchBadge.querySelector('b') : null;
      this.matchBadgeIcon = this.matchBadge ? this.matchBadge.querySelector('use') : null;
      this.matchState = $('#matchStateLabel');
      this.matchHint = $('#matchStateHint');
      this.matchTimer = $('#matchTimer');

      this.netChip = $('#netChip');
      this.netChipPing = $('#netChipPing');
      this.netChipBars = $('#netChipBars');
      this.netChipRole = $('#netChipRole');

      this.panel = $('#messagePanel');
      this.eyebrow = $('#messageEyebrow');
      this.title = $('#messageTitle');
      this.body = $('#messageBody');
      this.resultStats = $('#messageStats');

      this.toast = $('#statusToast');
      this.toastTimer = 0;

      this.cache = Object.create(null);
      this.holeDotCount = 0;
      this.focus = 'idle';

      // Muestreo de FPS con media móvil: el panel de métricas lo consume.
      this.fps = 0;
      this.frameMs = 0;
      this.frameAccumulator = 0;
      this.frameSamples = 0;
    }

    /** Escribe textContent solo si cambió. */
    setText(el, key, value) {
      if (!el) return;
      const text = String(value);
      if (this.cache[key] === text) return;
      this.cache[key] = text;
      el.textContent = text;
    }

    setAttr(el, key, name, value) {
      if (!el) return;
      const text = String(value);
      if (this.cache[key] === text) return;
      this.cache[key] = text;
      if (name === 'style:width') el.style.width = text;
      else if (name === 'style:transform') el.style.transform = text;
      else if (name === 'style:strokeDashoffset') el.style.strokeDashoffset = text;
      else el.setAttribute(name, text);
    }

    update(state) {
      const {
        seed, holeIndex, holeCount, strokes, par, score, arcadePoints, multiplierFound,
        wind, environment, biome, mapSize, difficulty, distanceMeters,
      } = state;

      this.setText(this.seed, 'seed', seed);
      this.setText(this.hole, 'hole', `${holeIndex + 1} / ${holeCount}`);
      this.renderHoleDots(holeIndex, holeCount);

      this.setText(this.stroke, 'strokes', strokes);
      this.setText(this.par, 'par', par);
      if (this.strokeDelta) {
        const delta = Number(strokes) - Number(par);
        this.setText(this.strokeDelta, 'strokeDelta', formatScore(delta));
        this.setAttr(this.strokeDelta, 'strokeDeltaTone', 'data-tone', delta < 0 ? 'under' : delta > 0 ? 'over' : 'even');
      }
      this.setText(this.score, 'score', formatScore(score));
      this.setText(this.points, 'points', formatInt(arcadePoints));

      if (this.multiplier) {
        const factor = NG.CONFIG.gameplay.scoreMultiplier;
        this.setText(this.multiplier, 'multiplier', multiplierFound ? `×${factor} ACTIVO` : `×${factor} POR ENCONTRAR`);
        this.setAttr(this.multiplier, 'multiplierFound', 'data-found', multiplierFound ? 'true' : 'false');
      }

      const windSpeed = wind && Number.isFinite(wind.speed) ? wind.speed : 0;
      const windAngle = wind && Number.isFinite(wind.angle) ? wind.angle : 0;
      this.setText(this.windTitle, 'windTitle', environment === 'underwater' ? 'CORRIENTE' : 'VIENTO');
      this.setText(this.wind, 'wind', `${windSpeed.toFixed(1)} m/s`);
      this.setAttr(this.windArrow, 'windAngle', 'style:transform', `rotate(${(windAngle * 180 / Math.PI).toFixed(0)}deg)`);
      if (this.windArc) {
        const ratio = clamp(windSpeed / NG.CONFIG.wind.maxMps, 0, 1);
        this.setAttr(this.windArc, 'windArc', 'style:strokeDashoffset', (WIND_RING_CIRCUMFERENCE * (1 - ratio)).toFixed(1));
        this.setAttr(this.windArc, 'windArcColor', 'stroke', ratio > 0.72 ? '#ff7f70' : ratio > 0.42 ? '#ffd479' : '#5ff3d2');
      }

      this.setText(this.biome, 'biome', biome || 'Procedural');
      this.setText(this.map, 'map', mapSize || '—');
      if (this.difficulty) {
        this.setText(this.difficulty, 'difficulty', difficulty || '—');
        this.setAttr(this.difficulty, 'difficultyLevel', 'data-level', String(difficulty || '').toLowerCase());
      }
      this.setText(this.distance, 'distance', `${Math.max(0, distanceMeters || 0).toFixed(0)} m`);
    }

    renderHoleDots(holeIndex, holeCount) {
      if (!this.holeDots) return;
      const count = Math.max(1, Number(holeCount) || 1);
      if (this.holeDotCount !== count) {
        this.holeDotCount = count;
        this.holeDots.textContent = '';
        for (let i = 0; i < count; i += 1) this.holeDots.appendChild(document.createElement('i'));
      }
      const dots = this.holeDots.children;
      for (let i = 0; i < dots.length; i += 1) {
        const state = i < holeIndex ? 'done' : i === holeIndex ? 'current' : 'todo';
        if (dots[i].dataset.state !== state) dots[i].dataset.state = state;
      }
    }

    /**
     * Telemetría del tiro. `active` es true mientras se arrastra la bola.
     */
    setShot({ active, power, angle }) {
      if (!this.shotMeter) return;
      this.setAttr(this.shotMeter, 'shotActive', 'data-active', active ? 'true' : 'false');
      const value = clamp(Number(power) || 0, 0, 1);
      this.setAttr(this.shotFill, 'shotFill', 'style:width', `${(value * 100).toFixed(1)}%`);
      this.setText(this.shotPower, 'shotPower', `${Math.round(value * 100)}%`);
      if (active) {
        const degrees = Math.round(((-(Number(angle) || 0) * 180 / Math.PI) + 360) % 360);
        this.setText(this.shotAngle, 'shotAngle', `${degrees}°`);
      } else if (this.cache.shotAngle !== '—') {
        this.setText(this.shotAngle, 'shotAngle', '—');
      }
    }

    /**
     * Modo de foco: el HUD baja intensidad mientras apuntas o la bola vuela,
     * para no competir con el juego. Nunca oculta información crítica.
     */
    setFocus(mode) {
      const value = mode === 'aim' || mode === 'motion' ? mode : 'idle';
      if (this.focus === value) return;
      this.focus = value;
      document.body.dataset.focus = value;
    }

    setRuntime(mode) {
      const value = mode === 'online' ? 'online' : 'offline';
      if (document.body.dataset.runtime !== value) document.body.dataset.runtime = value;
    }

    /**
     * Barra central de estado. La rellena NetworkHUD en online y el propio
     * juego en offline, de modo que siempre haya un titular legible.
     */
    setMatchBar({ mode, state, title, hint, timer, icon }) {
      if (!this.matchBar) return;
      this.setAttr(this.matchBar, 'matchMode', 'data-mode', mode || 'offline');
      this.setAttr(this.matchBar, 'matchState', 'data-state', state || 'idle');
      this.setAttr(this.matchBadge, 'matchBadgeMode', 'data-mode', mode || 'offline');
      if (this.matchBadgeText) {
        const label = mode === 'battle' ? 'BATTLE ROYALE' : mode === 'turn' ? 'POR TURNOS' : 'OFFLINE';
        this.setText(this.matchBadgeText, 'matchBadgeText', label);
      }
      if (this.matchBadgeIcon) {
        const href = icon || (mode === 'battle' ? '#i-swords' : mode === 'turn' ? '#i-turns' : '#i-flag');
        this.setAttr(this.matchBadgeIcon, 'matchBadgeIcon', 'href', href);
      }
      this.setText(this.matchState, 'matchStateText', title || 'Partida libre');
      this.setText(this.matchHint, 'matchHint', hint || '');
      if (this.matchTimer) {
        const show = !!timer;
        if (this.matchTimer.hidden === show) this.matchTimer.hidden = !show;
        if (show) this.setText(this.matchTimer, 'matchTimer', timer);
      }
    }

    setNetChip({ ping, bars, role, quality }) {
      this.setAttr(this.netChip, 'netQuality', 'data-quality', quality || 'offline');
      this.setText(this.netChipPing, 'netPing', ping);
      this.setText(this.netChipRole, 'netRole', role);
      this.setAttr(this.netChipBars, 'netBars', 'data-bars', String(bars || 0));
    }

    tick(dt) {
      // FPS por media móvil de medio segundo: estable de leer, barato de calcular.
      if (Number.isFinite(dt) && dt > 0) {
        this.frameAccumulator += dt;
        this.frameSamples += 1;
        if (this.frameAccumulator >= 0.5) {
          this.fps = Math.round(this.frameSamples / this.frameAccumulator);
          this.frameMs = (this.frameAccumulator / this.frameSamples) * 1000;
          this.frameAccumulator = 0;
          this.frameSamples = 0;
        }
      }
      if (this.toastTimer <= 0 || !this.toast) return;
      this.toastTimer -= dt;
      if (this.toastTimer <= 0) this.toast.classList.remove('show');
    }

    flashStatus(text, tone = 'neutral', seconds = 1.1) {
      if (!this.toast) return;
      this.toast.textContent = text;
      this.toast.dataset.tone = tone;
      this.toast.classList.add('show');
      this.toastTimer = seconds;
    }

    showResult(strokes, par, final = false, courseScore = 0, arcadePoints = 0, holePoints = 0, multiplier = 1) {
      const delta = strokes - par;
      const name = delta <= -3 ? 'Albatross' : delta === -2 ? 'Eagle' : delta === -1 ? 'Birdie'
        : delta === 0 ? 'Par' : delta === 1 ? 'Bogey' : delta === 2 ? 'Doble bogey' : `+${delta}`;
      const scoreText = formatScore(courseScore);
      if (this.eyebrow) this.eyebrow.textContent = final ? 'CAMPO COMPLETADO' : 'HOYO COMPLETADO';
      if (this.title) this.title.textContent = final ? '¡Recorrido listo!' : name;
      if (this.body) {
        this.body.textContent = final
          ? `Terminaste los ${NG.CONFIG.course.holeCount} hoyos con score ${scoreText}.`
          : `${strokes} golpes en un par ${par}.`;
      }
      if (this.resultStats) {
        this.resultStats.textContent = '';
        const cells = [
          ['GOLPES', String(strokes)],
          ['SCORE', scoreText],
          ['HOYO', `+${formatInt(holePoints)}`],
          ['TOTAL', formatInt(arcadePoints)],
        ];
        if (multiplier > 1) cells.splice(3, 0, ['BONUS', `×${multiplier}`]);
        for (const [label, value] of cells) {
          const cell = document.createElement('div');
          const span = document.createElement('span'); span.textContent = label;
          const strong = document.createElement('strong'); strong.textContent = value;
          cell.append(span, strong);
          this.resultStats.appendChild(cell);
        }
      }
      if (this.panel) this.panel.classList.remove('hidden');
    }

    hideResult() {
      if (this.panel) this.panel.classList.add('hidden');
    }
  }

  NG.HUD = HUD;
}(window.NoiseGolf = window.NoiseGolf || {}));
