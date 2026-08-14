(function (NG) {
  'use strict';

  const { CONFIG } = NG;
  const { clamp } = NG.MathUtil;

  class ParticleSystem {
    constructor() {
      this.items = [];
    }

    clear() {
      this.items.length = 0;
    }

    emitBurst(x, y, options = {}) {
      const count = options.count ?? 10;
      const speedMin = options.speedMin ?? 35;
      const speedMax = options.speedMax ?? 155;
      const lifeMin = options.lifeMin ?? 0.25;
      const lifeMax = options.lifeMax ?? 0.75;
      const angle = options.angle ?? -Math.PI / 2;
      const spread = options.spread ?? Math.PI * 2;
      const gravity = options.gravity ?? 260;
      const sizeMin = options.sizeMin ?? 2;
      const sizeMax = options.sizeMax ?? 5;
      const colors = options.colors || ['#ffffff'];
      for (let i = 0; i < count; i += 1) {
        if (this.items.length >= CONFIG.rendering.particleCap) this.items.shift();
        const a = angle + (Math.random() - 0.5) * spread;
        const speed = speedMin + Math.random() * (speedMax - speedMin);
        const life = lifeMin + Math.random() * (lifeMax - lifeMin);
        this.items.push({
          x, y,
          vx: Math.cos(a) * speed,
          vy: Math.sin(a) * speed,
          life,
          maxLife: life,
          gravity,
          drag: options.drag ?? 0.985,
          size: sizeMin + Math.random() * (sizeMax - sizeMin),
          color: colors[Math.floor(Math.random() * colors.length)],
          glow: options.glow ?? 0,
          shape: options.shape || 'circle',
        });
      }
    }

    update(dt) {
      for (let i = this.items.length - 1; i >= 0; i -= 1) {
        const p = this.items[i];
        p.life -= dt;
        if (p.life <= 0) {
          this.items.splice(i, 1);
          continue;
        }
        p.vy += p.gravity * dt;
        p.vx *= Math.pow(p.drag, dt * 60);
        p.vy *= Math.pow(p.drag, dt * 60);
        p.x += p.vx * dt;
        p.y += p.vy * dt;
      }
    }

    draw(ctx, visible) {
      for (const p of this.items) {
        if (visible && (p.x < visible.minX || p.x > visible.maxX || p.y < visible.minY || p.y > visible.maxY)) continue;
        const alpha = clamp(p.life / p.maxLife, 0, 1);
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.fillStyle = p.color;
        if (p.glow > 0) {
          ctx.shadowColor = p.color;
          ctx.shadowBlur = p.glow;
        }
        if (p.shape === 'spark') {
          ctx.translate(p.x, p.y);
          ctx.rotate(Math.atan2(p.vy, p.vx));
          ctx.fillRect(-p.size * 1.8, -p.size * 0.35, p.size * 3.6, p.size * 0.7);
        } else {
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.size * (0.45 + alpha * 0.55), 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
      }
    }
  }

  NG.ParticleSystem = ParticleSystem;
}(window.NoiseGolf = window.NoiseGolf || {}));
