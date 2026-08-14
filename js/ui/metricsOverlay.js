(function (NG) {
  'use strict';

  const HISTORY = 60;

  function tone(value, good, fair) {
    if (!Number.isFinite(value)) return '';
    if (value <= good) return 'good';
    if (value <= fair) return 'fair';
    return 'bad';
  }

  /**
   * Panel técnico opcional (F3 o clic en el chip de red).
   *
   * Está fuera del flujo normal a propósito: los datos duros de red interesan
   * cuando algo va mal, no mientras juegas. Se refresca a ~4 Hz desde el menú.
   */
  class MetricsOverlay {
    constructor(game) {
      const $ = (selector) => document.querySelector(selector);
      this.game = game;
      this.session = null;
      this.root = $('#metricsPanel');
      this.canvas = $('#metricsGraph');
      this.ctx = this.canvas ? this.canvas.getContext('2d') : null;
      this.history = [];
      this.visible = false;

      this.fields = {
        fps: $('#mFps'), frame: $('#mFrame'), ping: $('#mPing'), jitter: $('#mJitter'),
        snap: $('#mSnap'), loss: $('#mLoss'), relay: $('#mRelay'), role: $('#mRole'),
        peers: $('#mPeers'), particles: $('#mParticles'),
        sim: $('#mSim'), interp: $('#mInterp'), clock: $('#mClock'), correction: $('#mCorrection'),
      };

      $('#metricsClose')?.addEventListener('click', () => this.close());
      $('#netChip')?.addEventListener('click', () => this.toggle());
      window.addEventListener('keydown', (event) => {
        if (event.key === 'F3') { event.preventDefault(); this.toggle(); }
      });
    }

    setSession(session) {
      this.session = session && session.getStatus && session.getStatus().online ? session : null;
      if (!this.session) this.history.length = 0;
    }

    toggle() { if (this.visible) this.close(); else this.open(); }

    open() {
      this.visible = true;
      this.root?.classList.remove('hidden');
      this.update();
    }

    close() {
      this.visible = false;
      this.root?.classList.add('hidden');
    }

    set(field, value, toneValue) {
      const el = this.fields[field];
      if (!el) return;
      if (el.textContent !== value) el.textContent = value;
      const next = toneValue || '';
      if (el.dataset.tone !== next) el.dataset.tone = next;
    }

    update() {
      const hud = this.game?.hud;
      if (this.session) {
        const stats = this.session.getNetStats ? this.session.getNetStats() : null;
        if (stats && Number.isFinite(stats.ping)) {
          this.history.push(stats.ping);
          if (this.history.length > HISTORY) this.history.shift();
        }
        if (!this.visible) return;
        this.set('ping', Number.isFinite(stats?.ping) ? `${Math.round(stats.ping)} ms` : '—', tone(stats?.ping, 70, 150));
        this.set('jitter', Number.isFinite(stats?.jitter) ? `${Math.round(stats.jitter)} ms` : '—', tone(stats?.jitter, 12, 35));
        this.set('snap', Number.isFinite(stats?.snapshotHz) ? `${stats.snapshotHz.toFixed(1)} Hz` : '—');
        this.set('loss', Number.isFinite(stats?.lossPercent) ? `${stats.lossPercent.toFixed(1)} %` : '—', tone(stats?.lossPercent, 1, 5));
        this.set('relay', Number.isFinite(stats?.relayRtt) ? `${Math.round(stats.relayRtt)} ms` : '—', tone(stats?.relayRtt, 90, 200));
        this.set('role', String(stats?.role || 'OFFLINE').toUpperCase());
        this.set('peers', String(stats?.peers ?? 0));
        // Pasos de simulación consumidos en el último frame: 1 es lo normal a
        // 60 FPS, 0 significa frame sin paso (pantalla más rápida que la
        // simulación) y >2 que los FPS van por debajo del ritmo fijo.
        this.set('sim', stats?.simulationHz ? `${stats.simulationHz} Hz · ${stats.stepsLastFrame ?? 0}×` : '—');
        this.set('interp', Number.isFinite(stats?.interpolationMs) ? `${stats.interpolationMs} ms` : '—',
          tone(stats?.interpolationMs, 90, 160));
        this.set('clock', Number.isFinite(stats?.clockDriftMs) ? `${stats.clockDriftMs} ms` : '—',
          tone(Math.abs(stats?.clockDriftMs ?? NaN), 12, 45));
        this.set('correction', Number.isFinite(stats?.correctionDistance) ? `${stats.correctionDistance.toFixed(1)} px` : '—',
          tone(stats?.correctionDistance, 8, 40));
      } else {
        if (!this.visible) return;
        for (const key of ['ping', 'jitter', 'snap', 'loss', 'relay', 'interp', 'clock', 'correction']) this.set(key, '—', '');
        this.set('role', 'OFFLINE');
        this.set('peers', '0');
        this.set('sim', '—', '');
      }

      if (hud) {
        this.set('fps', hud.fps ? `${hud.fps}` : '—', hud.fps >= 55 ? 'good' : hud.fps >= 35 ? 'fair' : 'bad');
        this.set('frame', hud.frameMs ? `${hud.frameMs.toFixed(1)} ms` : '—');
      }
      this.set('particles', String(this.game?.particles?.items?.length || 0));
      this.drawGraph();
    }

    drawGraph() {
      const ctx = this.ctx;
      if (!ctx || !this.visible) return;
      const w = this.canvas.width;
      const h = this.canvas.height;
      ctx.clearRect(0, 0, w, h);

      ctx.strokeStyle = 'rgba(255,255,255,.07)';
      ctx.lineWidth = 1;
      for (let i = 1; i < 3; i += 1) {
        const y = Math.round((h / 3) * i) + 0.5;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();
      }
      if (this.history.length < 2) return;

      const max = Math.max(60, ...this.history) * 1.15;
      const step = w / (HISTORY - 1);
      const pointY = (value) => h - (Math.min(value, max) / max) * (h - 4) - 2;

      ctx.beginPath();
      this.history.forEach((value, index) => {
        const x = index * step;
        const y = pointY(value);
        if (index === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      const last = this.history[this.history.length - 1];
      ctx.strokeStyle = last <= 70 ? '#5ff3d2' : last <= 150 ? '#ffd479' : '#ff7f70';
      ctx.lineWidth = 1.6;
      ctx.stroke();

      ctx.lineTo((this.history.length - 1) * step, h);
      ctx.lineTo(0, h);
      ctx.closePath();
      ctx.fillStyle = last <= 70 ? 'rgba(95,243,210,.13)' : last <= 150 ? 'rgba(255,212,121,.13)' : 'rgba(255,127,112,.13)';
      ctx.fill();
    }
  }

  NG.MetricsOverlay = MetricsOverlay;
}(window.NoiseGolf = window.NoiseGolf || {}));
