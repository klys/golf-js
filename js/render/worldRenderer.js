(function (NG) {
  'use strict';

  const { CONFIG, TerrainUtil, ARCHETYPES } = NG;
  const { clamp, lerp } = NG.MathUtil;

  class WorldRenderer {
    constructor() {
      this.time = 0;
    }

    update(dt) {
      this.time += dt;
    }

    draw(ctx, game) {
      const { canvas, hole, ball, camera, particles } = game;
      if (!hole || !ball) return;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      const viewport = { width: w, height: h };
      ctx.clearRect(0, 0, w, h);
      this.drawSky(ctx, w, h, hole, camera);
      this.drawParallax(ctx, w, h, hole, camera);

      ctx.save();
      camera.apply(ctx);
      const visible = camera.visibleBounds(viewport);
      this.drawWorldBackdrop(ctx, hole, visible);
      this.drawGround(ctx, hole, visible);
      this.drawSecretCaves(ctx, hole, visible);
      this.drawRoofs(ctx, hole, visible);
      this.drawIslands(ctx, hole, visible);
      this.drawSurfaceZones(ctx, hole, visible);
      this.drawHazards(ctx, game, visible);
      this.drawDecorations(ctx, hole, visible);
      this.drawCup(ctx, game, w, h);
      this.drawTrail(ctx, game.trail || []);
      particles.draw(ctx, visible);
      const renderBalls = game.networkSession?.getRenderBalls?.()
        || [{ ball: game.renderBall || ball, color: '#f7fbff', username: '', local: true, turn: false, battleLocal: false }];
      // Prioridad de presentación:
      // - Por Turnos: el jugador con turno queda delante.
      // - Battle Royale: la bola LOCAL de cada cliente queda delante en ESE cliente.
      // Esto evita perder la propia bola cuando varios jugadores se amontonan.
      const presentationPriority = (item) => item.battleLocal ? 4 : (item.turn ? 3 : (item.local ? 2 : 1));
      renderBalls.sort((a, b) => presentationPriority(a) - presentationPriority(b));
      for (const item of renderBalls) this.drawBall(ctx, item.ball, hole, game, item);
      if (game.dragging && !ball.moving) this.drawAim(ctx, game);
      ctx.restore();

      if (hole.environment === 'underwater') this.drawUnderwaterOverlay(ctx, w, h, hole);
      this.drawVignette(ctx, w, h, hole);
      this.drawEdgeIndicator(ctx, game, w, h);
    }

    drawSky(ctx, w, h, hole, camera) {
      const theme = hole.theme;
      const g = ctx.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, theme.skyTop);
      g.addColorStop(0.58, theme.skyBottom);
      g.addColorStop(1, theme.haze);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);

      const sunX = w * (0.72 + Math.sin(hole.paletteShift * 5) * 0.12);
      const sunY = h * (hole.environment === 'underwater' ? 0.08 : 0.16);
      const sunR = hole.environment === 'underwater' ? 70 : 46;
      const sun = ctx.createRadialGradient(sunX, sunY, 0, sunX, sunY, sunR * 2.5);
      sun.addColorStop(0, hole.environment === 'underwater' ? 'rgba(130,239,255,.45)' : 'rgba(255,250,205,.96)');
      sun.addColorStop(0.22, hole.environment === 'underwater' ? 'rgba(77,212,235,.24)' : 'rgba(255,226,146,.42)');
      sun.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = sun;
      ctx.fillRect(sunX - sunR * 3, sunY - sunR * 3, sunR * 6, sunR * 6);

      if (hole.environment !== 'underwater') {
        for (let i = 0; i < 9; i += 1) {
          const drift = this.time * (5 + i * 0.35);
          const span = w + 420;
          const x = ((i * 283 - camera.x * (0.035 + i * 0.002) + drift) % span + span) % span - 180;
          const y = 72 + (i % 4) * 74 + Math.sin(i * 4.7) * 18;
          const scale = 0.64 + (i % 3) * 0.2;
          ctx.save();
          ctx.globalAlpha = 0.11 + (i % 3) * 0.035;
          ctx.fillStyle = '#ffffff';
          ctx.beginPath();
          ctx.ellipse(x, y, 82 * scale, 18 * scale, 0, 0, Math.PI * 2);
          ctx.ellipse(x + 54 * scale, y - 5 * scale, 52 * scale, 24 * scale, 0, 0, Math.PI * 2);
          ctx.ellipse(x - 48 * scale, y + 2 * scale, 46 * scale, 16 * scale, 0, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
        }
      }
    }

    drawParallax(ctx, w, h, hole, camera) {
      if (hole.environment === 'underwater') {
        ctx.save();
        ctx.globalAlpha = 0.16;
        for (let band = 0; band < 3; band += 1) {
          ctx.strokeStyle = band === 0 ? '#9ef7ff' : '#71d9e6';
          ctx.lineWidth = 2 + band;
          ctx.beginPath();
          for (let x = -40; x <= w + 40; x += 32) {
            const y = 110 + band * 72 + Math.sin(x * 0.009 + this.time * 0.6 + band) * 24;
            if (x === -40) ctx.moveTo(x, y); else ctx.lineTo(x, y);
          }
          ctx.stroke();
        }
        ctx.restore();
        return;
      }

      const theme = hole.theme;
      const layers = [
        { base: 0.63, amp: 74, speed: 0.10, alpha: 0.12 },
        { base: 0.72, amp: 52, speed: 0.18, alpha: 0.18 },
      ];
      for (let li = 0; li < layers.length; li += 1) {
        const layer = layers[li];
        ctx.save();
        ctx.globalAlpha = layer.alpha;
        ctx.fillStyle = li === 0 ? theme.soilDark : theme.grassDark;
        ctx.beginPath();
        ctx.moveTo(-20, h + 30);
        for (let x = -20; x <= w + 20; x += 32) {
          const wx = x + camera.x * layer.speed;
          const y = h * layer.base + Math.sin(wx * 0.0018 + li) * layer.amp + Math.sin(wx * 0.0041) * 22;
          ctx.lineTo(x, y);
        }
        ctx.lineTo(w + 20, h + 30);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      }
    }

    drawWorldBackdrop(ctx, hole, visible) {
      if (hole.environment === 'underwater') {
        const g = ctx.createLinearGradient(0, hole.bounds.minY, 0, hole.bounds.maxY);
        g.addColorStop(0, 'rgba(15,92,118,.08)');
        g.addColorStop(1, 'rgba(2,26,46,.34)');
        ctx.fillStyle = g;
        ctx.fillRect(visible.minX, visible.minY, visible.maxX - visible.minX, visible.maxY - visible.minY);

        ctx.fillStyle = 'rgba(140,244,244,.16)';
        for (let x = Math.floor(visible.minX / 190) * 190; x < visible.maxX; x += 190) {
          const y = hole.height * 0.18 + Math.sin(x * 0.006 + this.time * 0.7) * 80;
          ctx.beginPath();
          ctx.arc(x + Math.sin(this.time + x) * 16, y, 3 + (Math.abs(x) % 7), 0, Math.PI * 2);
          ctx.fill();
        }
      } else if (hole.archetype === ARCHETYPES.CAVERN) {
        ctx.fillStyle = 'rgba(10,18,27,.10)';
        ctx.fillRect(visible.minX, visible.minY, visible.maxX - visible.minX, visible.maxY - visible.minY);
      }
    }

    drawGround(ctx, hole, visible) {
      const ground = hole.surfaces.find((s) => s.kind === 'ground' && s.side === 'top');
      if (!ground) return;
      const theme = hole.theme;
      const bottomY = hole.bounds.maxY + 420;
      const g = ctx.createLinearGradient(0, hole.height * 0.42, 0, bottomY);
      g.addColorStop(0, theme.soil);
      g.addColorStop(0.28, theme.soilDark);
      g.addColorStop(1, '#111a21');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(ground.points[0].x, bottomY);
      for (const p of ground.points) ctx.lineTo(p.x, p.y);
      ctx.lineTo(ground.points[ground.points.length - 1].x, bottomY);
      ctx.closePath();
      ctx.fill();

      this.drawStrata(ctx, ground, visible, theme);
      this.drawGrassLip(ctx, ground, visible, theme);
    }

    drawStrata(ctx, surface, visible, theme) {
      ctx.save();
      ctx.globalAlpha = 0.15;
      ctx.strokeStyle = theme.skyBottom;
      ctx.lineWidth = 2;
      for (let layer = 0; layer < 4; layer += 1) {
        ctx.beginPath();
        let started = false;
        for (let x = Math.max(surface.xMin, visible.minX); x <= Math.min(surface.xMax, visible.maxX); x += 52) {
          const y = TerrainUtil.sampleSurface(surface, x) + 55 + layer * 52 + Math.sin(x * 0.008 + layer) * 14;
          if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
        }
        if (started) ctx.stroke();
      }
      ctx.restore();
    }

    drawGrassLip(ctx, surface, visible, theme) {
      const minX = Math.max(surface.xMin, visible.minX);
      const maxX = Math.min(surface.xMax, visible.maxX);
      if (maxX <= minX) return;

      ctx.fillStyle = theme.grassDark;
      ctx.beginPath();
      ctx.moveTo(minX, TerrainUtil.sampleSurface(surface, minX));
      for (let x = minX; x <= maxX; x += 12) ctx.lineTo(x, TerrainUtil.sampleSurface(surface, x));
      for (let x = maxX; x >= minX; x -= 12) ctx.lineTo(x, TerrainUtil.sampleSurface(surface, x) + (theme.isIce ? 18 : 14));
      ctx.closePath();
      ctx.fill();

      ctx.strokeStyle = theme.grass;
      ctx.lineWidth = theme.isIce ? 6 : 4;
      ctx.lineCap = 'round';
      ctx.beginPath();
      for (let x = minX; x <= maxX; x += 12) {
        const y = TerrainUtil.sampleSurface(surface, x);
        if (x === minX) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();

      if (theme.isIce) {
        ctx.save();
        ctx.globalAlpha = 0.72;
        ctx.strokeStyle = '#efffff';
        ctx.lineWidth = 2;
        ctx.beginPath();
        for (let x = minX; x <= maxX; x += 18) {
          const y = TerrainUtil.sampleSurface(surface, x) - 2;
          if (x === minX) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.stroke();
        ctx.globalAlpha = 0.42;
        ctx.fillStyle = '#bffaff';
        const start = Math.ceil(minX / 110) * 110;
        for (let x = start; x < maxX - 12; x += 110) {
          const y = TerrainUtil.sampleSurface(surface, x) + 13;
          const len = 10 + ((Math.floor(x / 110) * 7) % 14);
          ctx.beginPath();
          ctx.moveTo(x - 5, y - 2);
          ctx.lineTo(x, y + len);
          ctx.lineTo(x + 5, y - 2);
          ctx.closePath();
          ctx.fill();
        }
        ctx.restore();
      }
      ctx.lineCap = 'butt';
    }

    drawRoofs(ctx, hole, visible) {
      const theme = hole.theme;
      for (const roof of hole.surfaces) {
        if (roof.kind !== 'roof' || roof.side !== 'bottom') continue;
        if (roof.xMax < visible.minX || roof.xMin > visible.maxX) continue;
        const g = ctx.createLinearGradient(0, hole.bounds.minY - 200, 0, hole.height * 0.55);
        g.addColorStop(0, '#10161f');
        g.addColorStop(1, theme.soilDark);
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.moveTo(roof.xMin, hole.bounds.minY - 420);
        ctx.lineTo(roof.xMax, hole.bounds.minY - 420);
        for (let i = roof.points.length - 1; i >= 0; i -= 1) ctx.lineTo(roof.points[i].x, roof.points[i].y);
        ctx.closePath();
        ctx.fill();

        ctx.strokeStyle = 'rgba(160,235,211,.22)';
        ctx.lineWidth = 3;
        ctx.beginPath();
        roof.points.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));
        ctx.stroke();

        for (let x = Math.max(roof.xMin + 45, visible.minX); x < Math.min(roof.xMax - 45, visible.maxX); x += 90) {
          const y = TerrainUtil.sampleSurface(roof, x);
          const len = 14 + ((Math.floor(x) ^ roof.seed) & 31);
          ctx.fillStyle = 'rgba(18,26,32,.78)';
          ctx.beginPath();
          ctx.moveTo(x - 8, y - 1);
          ctx.lineTo(x + 8, y - 1);
          ctx.lineTo(x + 2, y + len);
          ctx.closePath();
          ctx.fill();
        }
      }
    }

    drawIslands(ctx, hole, visible) {
      const theme = hole.theme;
      const tops = hole.surfaces.filter((s) => s.kind === 'island' && s.side === 'top');
      for (const top of tops) {
        if (top.xMax < visible.minX || top.xMin > visible.maxX) continue;
        const underside = hole.surfaces.find((s) => s.parentId === top.id && s.kind === 'island-under');
        if (!underside) continue;
        const topY = Math.min(...top.points.map((p) => p.y));
        const bottomY = Math.max(...underside.points.map((p) => p.y));

        const islandPath = () => {
          ctx.beginPath();
          ctx.moveTo(top.points[0].x, top.points[0].y);
          for (let i = 1; i < top.points.length; i += 1) ctx.lineTo(top.points[i].x, top.points[i].y);
          for (let i = underside.points.length - 1; i >= 0; i -= 1) ctx.lineTo(underside.points[i].x, underside.points[i].y);
          ctx.closePath();
        };

        const g = ctx.createLinearGradient(0, topY, 0, bottomY);
        g.addColorStop(0, theme.soil);
        g.addColorStop(0.24, theme.soilDark);
        g.addColorStop(0.72, '#28303b');
        g.addColorStop(1, '#151c27');
        ctx.fillStyle = g;
        islandPath();
        ctx.fill();

        ctx.save();
        islandPath();
        ctx.clip();
        // Estratos que siguen la silueta en vez del abanico triangular antiguo.
        for (let layer = 0; layer < 4; layer += 1) {
          const t = 0.20 + layer * 0.17;
          ctx.strokeStyle = `rgba(198,220,205,${0.10 - layer * 0.012})`;
          ctx.lineWidth = 2;
          ctx.beginPath();
          let started = false;
          for (let x = Math.max(top.xMin, visible.minX - 80); x <= Math.min(top.xMax, visible.maxX + 80); x += 46) {
            const yt = TerrainUtil.sampleSurface(top, x);
            const yu = TerrainUtil.sampleSurface(underside, x);
            if (!Number.isFinite(yt) || !Number.isFinite(yu)) continue;
            const y = lerp(yt, yu, t) + Math.sin(x * 0.012 + layer * 1.9) * 10;
            if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
          }
          ctx.stroke();
        }

        // Grietas verticales/diagonales de longitud variable.
        ctx.strokeStyle = 'rgba(8,15,22,.26)';
        ctx.lineWidth = 2;
        for (let x = top.xMin + 70; x < top.xMax - 70; x += 105) {
          const yt = TerrainUtil.sampleSurface(top, x);
          const yu = TerrainUtil.sampleSurface(underside, x);
          const len = Math.max(30, (yu - yt) * (0.24 + ((Math.floor(x + top.seed) % 37) / 100)));
          ctx.beginPath();
          ctx.moveTo(x, yt + 20);
          ctx.quadraticCurveTo(x + Math.sin(x * 0.03) * 18, yt + len * 0.55, x + Math.sin(x * 0.017) * 12, yt + len);
          ctx.stroke();
        }
        ctx.restore();

        // Laterales sólidos más legibles.
        ctx.strokeStyle = 'rgba(8,16,24,.68)';
        ctx.lineWidth = 3.2;
        ctx.beginPath();
        ctx.moveTo(top.points[0].x, top.points[0].y);
        ctx.lineTo(underside.points[0].x, underside.points[0].y);
        ctx.moveTo(top.points[top.points.length - 1].x, top.points[top.points.length - 1].y);
        ctx.lineTo(underside.points[underside.points.length - 1].x, underside.points[underside.points.length - 1].y);
        ctx.stroke();

        this.drawGrassLip(ctx, top, visible, theme);

        ctx.strokeStyle = 'rgba(67,66,54,.46)';
        ctx.lineWidth = 2;
        for (let x = top.xMin + 48; x < top.xMax - 45; x += 82) {
          const y = TerrainUtil.sampleSurface(underside, x);
          const rootLen = 18 + ((Math.floor(x) + top.seed) % 58);
          ctx.beginPath();
          ctx.moveTo(x, y - 2);
          ctx.bezierCurveTo(x + 9, y + rootLen * 0.32, x - 11, y + rootLen * 0.70, x - 3, y + rootLen);
          ctx.stroke();
        }
      }
    }

    drawSecretCaves(ctx, hole, visible) {
      for (const cave of hole.hazards) {
        if (cave.type !== 'secret-cave' || !cave.discovered) continue;
        const minX = Math.min(cave.entranceX, cave.exitX, cave.controlX) - 90;
        const maxX = Math.max(cave.entranceX, cave.exitX, cave.controlX) + 90;
        const minY = Math.min(cave.entranceY, cave.exitY, cave.controlY) - 90;
        const maxY = Math.max(cave.entranceY, cave.exitY, cave.controlY) + 90;
        if (maxX < visible.minX || minX > visible.maxX || maxY < visible.minY || minY > visible.maxY) continue;

        ctx.save();
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        const drawPath = () => {
          ctx.beginPath();
          ctx.moveTo(cave.entranceX, cave.entranceY + 4);
          ctx.quadraticCurveTo(cave.controlX, cave.controlY, cave.exitX, cave.exitY + 4);
        };

        drawPath();
        ctx.strokeStyle = 'rgba(10,20,30,.48)';
        ctx.lineWidth = 78;
        ctx.stroke();
        drawPath();
        ctx.strokeStyle = 'rgba(14,30,39,.94)';
        ctx.lineWidth = 56;
        ctx.stroke();
        drawPath();
        ctx.strokeStyle = 'rgba(95,238,214,.20)';
        ctx.lineWidth = 3;
        ctx.setLineDash([13, 18]);
        ctx.lineDashOffset = -this.time * 34;
        ctx.stroke();
        ctx.setLineDash([]);

        for (const endpoint of [
          { x: cave.entranceX, y: cave.entranceY, label: 'IN' },
          { x: cave.exitX, y: cave.exitY, label: 'OUT' },
        ]) {
          const glow = ctx.createRadialGradient(endpoint.x, endpoint.y, 2, endpoint.x, endpoint.y, cave.entranceRadius + 16);
          glow.addColorStop(0, 'rgba(8,18,25,.95)');
          glow.addColorStop(0.65, 'rgba(36,91,91,.72)');
          glow.addColorStop(1, 'rgba(81,230,196,0)');
          ctx.fillStyle = glow;
          ctx.beginPath();
          ctx.arc(endpoint.x, endpoint.y, cave.entranceRadius + 16, 0, Math.PI * 2);
          ctx.fill();
          ctx.strokeStyle = 'rgba(119,255,224,.52)';
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(endpoint.x, endpoint.y, cave.entranceRadius * 0.78, 0, Math.PI * 2);
          ctx.stroke();
        }
        ctx.restore();
      }
    }

    drawSurfaceZones(ctx, hole, visible) {
      for (const hazard of hole.hazards) {
        if (!['rough', 'sand', 'ice'].includes(hazard.type)) continue;
        if (hazard.x + hazard.width / 2 < visible.minX || hazard.x - hazard.width / 2 > visible.maxX) continue;
        const surface = TerrainUtil.findSurface(hole, hazard.surfaceId);
        if (!surface) continue;
        const x0 = Math.max(surface.xMin, hazard.x - hazard.width / 2);
        const x1 = Math.min(surface.xMax, hazard.x + hazard.width / 2);
        const span = Math.max(1, x1 - x0);
        const depthBase = hazard.type === 'sand' ? 30 : hazard.type === 'ice' ? 19 : 23;
        const depthAt = (x) => {
          const t = clamp((x - x0) / span, 0, 1);
          const envelope = Math.pow(Math.sin(t * Math.PI), 0.62);
          const noise = 1 + Math.sin(x * 0.047) * 0.09 + Math.sin(x * 0.017 + 1.7) * 0.06;
          return depthBase * envelope * noise;
        };

        ctx.save();
        ctx.beginPath();
        ctx.moveTo(x0, TerrainUtil.sampleSurface(surface, x0));
        for (let x = x0; x <= x1; x += 8) ctx.lineTo(x, TerrainUtil.sampleSurface(surface, x) - 0.5);
        for (let x = x1; x >= x0; x -= 8) ctx.lineTo(x, TerrainUtil.sampleSurface(surface, x) + depthAt(x));
        ctx.closePath();

        if (hazard.type === 'sand') {
          const grad = ctx.createLinearGradient(0, Math.min(TerrainUtil.sampleSurface(surface, x0), TerrainUtil.sampleSurface(surface, x1)) - 2, 0, Math.max(TerrainUtil.sampleSurface(surface, x0), TerrainUtil.sampleSurface(surface, x1)) + depthBase + 10);
          grad.addColorStop(0, '#f5dda0');
          grad.addColorStop(0.36, '#e2c475');
          grad.addColorStop(1, '#b98745');
          ctx.fillStyle = grad;
          ctx.fill();
          ctx.strokeStyle = 'rgba(255,243,192,.66)';
          ctx.lineWidth = 2.2;
          ctx.beginPath();
          for (let x = x0 + 4; x <= x1 - 4; x += 9) {
            const y = TerrainUtil.sampleSurface(surface, x) + Math.sin(x * 0.19) * 1.2;
            if (x <= x0 + 5) ctx.moveTo(x, y); else ctx.lineTo(x, y);
          }
          ctx.stroke();
          ctx.fillStyle = 'rgba(110,76,39,.26)';
          const grainCount = Math.min(56, Math.max(8, Math.floor(span / 18)));
          for (let i = 0; i < grainCount; i += 1) {
            const t = (i + 0.35 + ((i * 17) % 7) * 0.07) / grainCount;
            const x = lerp(x0 + 9, x1 - 9, clamp(t, 0, 1));
            const depth = Math.max(4, depthAt(x));
            const y = TerrainUtil.sampleSurface(surface, x) + 5 + ((i * 23) % Math.max(6, Math.floor(depth - 2)));
            ctx.beginPath();
            ctx.arc(x, y, 0.8 + (i % 3) * 0.35, 0, Math.PI * 2);
            ctx.fill();
          }
        } else if (hazard.type === 'ice') {
          const topY = Math.min(TerrainUtil.sampleSurface(surface, x0), TerrainUtil.sampleSurface(surface, x1));
          const grad = ctx.createLinearGradient(0, topY - 6, 0, topY + depthBase + 14);
          grad.addColorStop(0, 'rgba(226,255,255,.98)');
          grad.addColorStop(0.34, 'rgba(122,224,244,.96)');
          grad.addColorStop(1, 'rgba(43,129,174,.92)');
          ctx.fillStyle = grad;
          ctx.shadowColor = 'rgba(152,245,255,.42)';
          ctx.shadowBlur = 8;
          ctx.fill();
          ctx.shadowBlur = 0;
          ctx.strokeStyle = 'rgba(242,255,255,.92)';
          ctx.lineWidth = 2.4;
          ctx.beginPath();
          for (let x = x0 + 3; x <= x1 - 3; x += 8) {
            const y = TerrainUtil.sampleSurface(surface, x) - 1.5 + Math.sin(x * 0.09) * 0.55;
            if (x <= x0 + 4) ctx.moveTo(x, y); else ctx.lineTo(x, y);
          }
          ctx.stroke();
          ctx.strokeStyle = 'rgba(31,111,158,.34)';
          ctx.lineWidth = 1.15;
          const cracks = Math.min(18, Math.max(3, Math.floor(span / 92)));
          for (let i = 0; i < cracks; i += 1) {
            const x = x0 + 24 + ((i * 83 + Math.floor(hazard.x)) % Math.max(30, Math.floor(span - 48)));
            const y = TerrainUtil.sampleSurface(surface, x) + 4;
            ctx.beginPath();
            ctx.moveTo(x, y);
            ctx.lineTo(x + ((i % 2) ? 9 : -8), y + 6);
            ctx.lineTo(x + ((i % 3) - 1) * 13, y + 12);
            ctx.stroke();
          }
        } else {
          const grad = ctx.createLinearGradient(0, 0, 0, depthBase + 10);
          grad.addColorStop(0, 'rgba(47,137,72,.96)');
          grad.addColorStop(1, 'rgba(22,78,42,.93)');
          ctx.fillStyle = grad;
          ctx.fill();
          ctx.strokeStyle = 'rgba(120,224,139,.58)';
          ctx.lineWidth = 1.55;
          const bladeStep = span > 680 ? 13 : 10;
          for (let x = x0 + 7; x < x1 - 7; x += bladeStep) {
            const t = clamp((x - x0) / span, 0, 1);
            const envelope = Math.pow(Math.sin(t * Math.PI), 0.45);
            if (envelope < 0.15) continue;
            const y = TerrainUtil.sampleSurface(surface, x);
            const height = (7 + (Math.sin(x * 0.31) + 1) * 3.5) * envelope;
            ctx.beginPath();
            ctx.moveTo(x, y + 5);
            ctx.quadraticCurveTo(x + Math.sin(x * 0.18) * 2.5, y - height * 0.45, x + Math.sin(x) * 1.6, y - height);
            ctx.stroke();
          }
        }
        ctx.restore();
      }
    }

    drawHazards(ctx, game, visible) {
      const { hole, physics } = game;
      for (const water of hole.hazards) {
        if (water.type !== 'water') continue;
        if (water.x + water.width / 2 < visible.minX || water.x - water.width / 2 > visible.maxX) continue;
        const x0 = water.x - water.width / 2;
        const x1 = water.x + water.width / 2;
        const y = water.surfaceY;
        const surface = TerrainUtil.findSurface(hole, water.surfaceId);
        if (!surface) continue;
        const waveY = (x) => y + Math.sin(x * 0.055 + this.time * 3.2) * 2.6;

        ctx.save();
        ctx.beginPath();
        ctx.moveTo(x0, waveY(x0));
        for (let x = x0 + 12; x <= x1; x += 12) ctx.lineTo(Math.min(x, x1), waveY(Math.min(x, x1)));
        for (let x = x1; x >= x0; x -= 12) {
          const sx = Math.max(x0, x);
          const floorY = Math.max(y + 3, TerrainUtil.sampleSurface(surface, sx));
          ctx.lineTo(sx, floorY);
        }
        ctx.lineTo(x0, Math.max(y + 3, TerrainUtil.sampleSurface(surface, x0)));
        ctx.closePath();

        const wg = ctx.createLinearGradient(0, y, 0, y + water.depth + 30);
        wg.addColorStop(0, hole.theme.water);
        wg.addColorStop(0.34, hole.theme.waterDeep);
        wg.addColorStop(1, '#082d52');
        ctx.fillStyle = wg;
        ctx.fill();

        ctx.clip();
        ctx.globalAlpha = 0.18;
        ctx.strokeStyle = 'rgba(185,250,255,.72)';
        ctx.lineWidth = 1.4;
        for (let band = 0; band < 3; band += 1) {
          ctx.beginPath();
          for (let x = x0 - 20; x <= x1 + 20; x += 26) {
            const cy = y + 25 + band * 27 + Math.sin(x * 0.035 + this.time * 1.7 + band) * 7;
            if (x === x0 - 20) ctx.moveTo(x, cy); else ctx.lineTo(x, cy);
          }
          ctx.stroke();
        }

        ctx.globalAlpha = 0.28;
        ctx.fillStyle = 'rgba(210,251,255,.9)';
        for (let x = x0 + 18; x < x1; x += 38) {
          const floorY = Math.max(y + 10, TerrainUtil.sampleSurface(surface, x));
          const span = Math.max(12, floorY - y - 10);
          const phase = ((this.time * 22 + x * 0.37) % span + span) % span;
          const by = floorY - phase;
          ctx.beginPath();
          ctx.arc(x + Math.sin(this.time * 1.4 + x) * 4, by, 1.7 + ((Math.floor(x) % 3) * 0.35), 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();

        ctx.strokeStyle = 'rgba(232,255,255,.88)';
        ctx.lineWidth = 2.4;
        ctx.beginPath();
        for (let x = x0; x <= x1; x += 12) {
          const sx = Math.min(x, x1);
          const wy = waveY(sx);
          if (x === x0) ctx.moveTo(sx, wy); else ctx.lineTo(sx, wy);
        }
        ctx.stroke();

        ctx.strokeStyle = 'rgba(225,250,240,.52)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(x0 - 10, TerrainUtil.sampleSurface(surface, x0 - 10));
        ctx.quadraticCurveTo(x0, y - 2, x0 + 15, y + 1);
        ctx.moveTo(x1 + 10, TerrainUtil.sampleSurface(surface, x1 + 10));
        ctx.quadraticCurveTo(x1, y - 2, x1 - 15, y + 1);
        ctx.stroke();
      }

      for (const booster of hole.hazards) {
        if (booster.type !== 'booster') continue;
        if (booster.x + booster.width / 2 < visible.minX || booster.x - booster.width / 2 > visible.maxX) continue;
        const surface = TerrainUtil.findSurface(hole, booster.surfaceId);
        if (!surface) continue;
        const y = TerrainUtil.sampleSurface(surface, booster.x) - 3;
        const slope = TerrainUtil.surfaceSlope(surface, booster.x);
        const dir = booster.direction < 0 ? -1 : 1;
        const warning = !!booster.trapBooster;
        ctx.save();
        ctx.translate(booster.x, y);
        ctx.rotate(Math.atan(slope));

        const pulse = 0.72 + Math.sin(this.time * 6.4 + booster.x * 0.01) * 0.28;
        const left = -booster.width / 2;
        const right = booster.width / 2;
        const grad = ctx.createLinearGradient(left, 0, right, 0);
        if (warning) {
          grad.addColorStop(0, '#8b2d62');
          grad.addColorStop(0.55, '#ff7a6d');
          grad.addColorStop(1, '#ffd86b');
        } else if (dir > 0) {
          grad.addColorStop(0, '#165a8a');
          grad.addColorStop(0.52, '#37d8da');
          grad.addColorStop(1, '#7aff9c');
        } else {
          grad.addColorStop(0, '#7aff9c');
          grad.addColorStop(0.48, '#37d8da');
          grad.addColorStop(1, '#165a8a');
        }

        // Base hundida en el terreno.
        ctx.fillStyle = 'rgba(8,27,38,.82)';
        this.roundedRect(ctx, left - 5, -5, booster.width + 10, 18, 7);
        ctx.fill();
        ctx.shadowColor = warning ? `rgba(255,115,98,${0.28 + pulse * 0.24})` : `rgba(88,255,224,${0.30 + pulse * 0.25})`;
        ctx.shadowBlur = 13 + pulse * 10;
        ctx.fillStyle = grad;
        this.roundedRect(ctx, left, -10, booster.width, 13, 6);
        ctx.fill();
        ctx.shadowBlur = 0;
        ctx.strokeStyle = 'rgba(255,255,255,.38)';
        ctx.lineWidth = 1.4;
        ctx.stroke();

        // Chevrones animados; el desplazamiento cambia con la dirección real.
        ctx.save();
        ctx.beginPath();
        this.roundedRect(ctx, left + 2, -9, booster.width - 4, 11, 5);
        ctx.clip();
        ctx.fillStyle = 'rgba(255,255,255,.96)';
        const spacing = 27;
        const shift = (this.time * 78) % spacing;
        for (let base = left - spacing; base <= right + spacing; base += spacing) {
          const x = base + (dir > 0 ? shift : -shift);
          ctx.beginPath();
          if (dir > 0) {
            ctx.moveTo(x - 6, -8);
            ctx.lineTo(x + 7, -4);
            ctx.lineTo(x - 6, 0);
            ctx.lineTo(x - 1, -4);
          } else {
            ctx.moveTo(x + 6, -8);
            ctx.lineTo(x - 7, -4);
            ctx.lineTo(x + 6, 0);
            ctx.lineTo(x + 1, -4);
          }
          ctx.closePath();
          ctx.fill();
        }
        ctx.restore();

        // Flecha grande en el extremo de salida: lectura inmediata incluso con cámara alejada.
        const tipX = dir > 0 ? right + 13 : left - 13;
        ctx.fillStyle = warning ? '#ffd86b' : '#d8fff5';
        ctx.shadowColor = warning ? '#ff8f72' : '#6affda';
        ctx.shadowBlur = 9;
        ctx.beginPath();
        if (dir > 0) {
          ctx.moveTo(tipX + 10, -4);
          ctx.lineTo(tipX - 5, -12);
          ctx.lineTo(tipX - 5, 4);
        } else {
          ctx.moveTo(tipX - 10, -4);
          ctx.lineTo(tipX + 5, -12);
          ctx.lineTo(tipX + 5, 4);
        }
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      }

      for (const well of hole.hazards) {
        if (well.type !== 'gravity-well') continue;
        if (well.x + well.radius * 1.4 < visible.minX || well.x - well.radius * 1.4 > visible.maxX || well.y + well.radius * 1.4 < visible.minY || well.y - well.radius * 1.4 > visible.maxY) continue;
        const repel = well.strength < 0;
        ctx.save();
        ctx.translate(well.x, well.y);
        const field = ctx.createRadialGradient(0, 0, 4, 0, 0, well.radius * 1.15);
        field.addColorStop(0, repel ? 'rgba(255,178,103,.72)' : 'rgba(142,113,255,.74)');
        field.addColorStop(0.22, repel ? 'rgba(255,113,88,.28)' : 'rgba(100,235,255,.24)');
        field.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = field;
        ctx.beginPath();
        ctx.arc(0, 0, well.radius * 1.15, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = repel ? 'rgba(255,211,127,.58)' : 'rgba(158,238,255,.52)';
        ctx.lineWidth = 2;
        for (let i = 0; i < 3; i += 1) {
          const rr = well.radius * (0.34 + i * 0.22) + Math.sin(this.time * 3 + i) * 3;
          ctx.setLineDash([12 + i * 3, 9]);
          ctx.lineDashOffset = -this.time * 24 * (well.spin || 1);
          ctx.beginPath();
          ctx.arc(0, 0, rr, 0, Math.PI * 2);
          ctx.stroke();
        }
        ctx.setLineDash([]);
        ctx.fillStyle = repel ? '#ff9b70' : '#85efff';
        ctx.shadowColor = repel ? '#ff755f' : '#7b6dff';
        ctx.shadowBlur = 14;
        ctx.beginPath();
        ctx.arc(0, 0, 8, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }

      for (const fan of hole.hazards) {
        if (fan.type !== 'fan') continue;
        if (fan.x + fan.range < visible.minX || fan.x - fan.range > visible.maxX) continue;
        ctx.save();
        ctx.translate(fan.x, fan.y);
        ctx.rotate(fan.angle);
        ctx.globalAlpha = 0.15;
        const gust = ctx.createLinearGradient(0, 0, fan.range, 0);
        gust.addColorStop(0, 'rgba(132,240,255,.36)');
        gust.addColorStop(1, 'rgba(132,240,255,0)');
        ctx.fillStyle = gust;
        this.roundedRect(ctx, 0, -fan.fieldHeight * 0.45, fan.range, fan.fieldHeight * 0.9, 20);
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.fillStyle = '#203848';
        ctx.strokeStyle = 'rgba(255,255,255,.28)';
        ctx.lineWidth = 2;
        this.roundedRect(ctx, -18, -18, 36, 36, 12);
        ctx.fill();
        ctx.stroke();
        ctx.strokeStyle = '#8ef8ff';
        ctx.lineWidth = 3;
        for (let i = 0; i < 3; i += 1) {
          const phase = this.time * 5 + i * Math.PI * 0.66;
          ctx.beginPath();
          ctx.moveTo(0, 0);
          ctx.lineTo(Math.cos(phase) * 12, Math.sin(phase) * 12);
          ctx.stroke();
        }
        ctx.lineWidth = 2;
        ctx.strokeStyle = 'rgba(158,247,255,.58)';
        for (let i = 0; i < 3; i += 1) {
          const start = 34 + ((this.time * 120 + i * 34) % Math.max(40, fan.range - 40));
          ctx.beginPath();
          ctx.moveTo(start, -18 + i * 14);
          ctx.quadraticCurveTo(start + 16, -12 + i * 12, start + 36, -6 + i * 12);
          ctx.stroke();
        }
        ctx.restore();
      }

      for (const portal of hole.hazards) {
        if (portal.type !== 'portal' || portal.consumed) continue;
        if (portal.x + portal.radius < visible.minX || portal.x - portal.radius > visible.maxX) continue;
        const isEntry = portal.portalRole !== 'exit' && portal.entryEnabled !== false;
        const spin = this.time * (isEntry ? 2.6 : -1.7) + portal.portalIndex * 0.9;
        ctx.save();
        ctx.translate(portal.x, portal.y);
        const outer = ctx.createRadialGradient(0, 0, 4, 0, 0, portal.radius + 9);
        outer.addColorStop(0, 'rgba(255,255,255,.96)');
        outer.addColorStop(0.42, isEntry ? '#765dff' : '#50e6c8');
        outer.addColorStop(0.72, isEntry ? '#c77bff' : '#2aa6d8');
        outer.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = outer;
        ctx.beginPath();
        ctx.arc(0, 0, portal.radius + 8, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalCompositeOperation = 'destination-out';
        ctx.beginPath();
        ctx.arc(0, 0, portal.radius - 3, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalCompositeOperation = 'source-over';
        ctx.strokeStyle = 'rgba(255,255,255,.78)';
        ctx.lineWidth = 2.4;
        ctx.beginPath(); ctx.arc(0, 0, portal.radius + Math.sin(spin) * 1.5, 0, Math.PI * 2); ctx.stroke();
        ctx.rotate(portal.heading || 0);
        ctx.fillStyle = isEntry ? 'rgba(255,255,255,.92)' : 'rgba(190,255,244,.94)';
        ctx.beginPath();
        if (isEntry) {
          ctx.moveTo(-8, -7); ctx.lineTo(5, 0); ctx.lineTo(-8, 7); ctx.lineTo(-4, 0); ctx.closePath();
        } else {
          ctx.moveTo(9, 0); ctx.lineTo(-4, -7); ctx.lineTo(-4, 7); ctx.closePath();
        }
        ctx.fill();
        ctx.restore();
      }

      for (const platform of hole.hazards) {
        if (platform.type !== 'platform') continue;
        const state = physics.platformState(platform);
        if (state.x + platform.width / 2 < visible.minX || state.x - platform.width / 2 > visible.maxX) continue;
        ctx.save();
        ctx.translate(state.x, state.y);
        const grad = ctx.createLinearGradient(0, -10, 0, 12);
        grad.addColorStop(0, '#91f4ff');
        grad.addColorStop(0.35, '#6acac9');
        grad.addColorStop(1, '#224a5f');
        ctx.fillStyle = grad;
        this.roundedRect(ctx, -platform.width / 2, -10, platform.width, 20, 10);
        ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,.35)';
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.strokeStyle = 'rgba(255,255,255,.18)';
        ctx.setLineDash([12, 8]);
        ctx.beginPath();
        ctx.moveTo(-platform.width / 2 + 10, 0);
        ctx.lineTo(platform.width / 2 - 10, 0);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.restore();
      }

      for (const wall of hole.hazards) {
        if (wall.type !== 'moving-wall') continue;
        const state = physics.movingWallState(wall);
        if (state.x + wall.width / 2 < visible.minX || state.x - wall.width / 2 > visible.maxX || state.y + wall.height / 2 < visible.minY || state.y - wall.height / 2 > visible.maxY) continue;
        ctx.save();
        ctx.strokeStyle = 'rgba(120,225,245,.17)';
        ctx.lineWidth = Math.max(4, wall.width * 0.26);
        ctx.beginPath();
        ctx.moveTo(wall.baseX, wall.baseY - wall.amplitude);
        ctx.lineTo(wall.baseX, wall.baseY + wall.amplitude);
        ctx.stroke();
        ctx.translate(state.x, state.y);
        const g = ctx.createLinearGradient(-wall.width / 2, 0, wall.width / 2, 0);
        g.addColorStop(0, '#17394b');
        g.addColorStop(0.48, '#55d6df');
        g.addColorStop(1, '#17394b');
        ctx.fillStyle = g;
        ctx.shadowColor = 'rgba(78,221,234,.36)';
        ctx.shadowBlur = 10;
        this.roundedRect(ctx, -wall.width / 2, -wall.height / 2, wall.width, wall.height, Math.min(10, wall.width * 0.3));
        ctx.fill();
        ctx.shadowBlur = 0;
        ctx.strokeStyle = 'rgba(255,255,255,.40)';
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.strokeStyle = 'rgba(7,38,51,.48)';
        ctx.lineWidth = 3;
        for (let y = -wall.height / 2 + 18; y < wall.height / 2 - 12; y += 34) {
          ctx.beginPath(); ctx.moveTo(-wall.width / 2 + 5, y); ctx.lineTo(wall.width / 2 - 5, y + 12); ctx.stroke();
        }
        ctx.restore();
      }

      for (const spinner of hole.hazards) {
        if (spinner.type !== 'spinner') continue;
        if (spinner.x + spinner.armLength < visible.minX || spinner.x - spinner.armLength > visible.maxX || spinner.y + spinner.armLength < visible.minY || spinner.y - spinner.armLength > visible.maxY) continue;
        const state = physics.spinnerState(spinner);
        ctx.save();
        ctx.translate(spinner.x, spinner.y);
        ctx.rotate(state.angle);
        ctx.lineCap = 'round';
        ctx.strokeStyle = 'rgba(255,119,92,.96)';
        ctx.shadowColor = 'rgba(255,112,82,.36)';
        ctx.shadowBlur = 9;
        ctx.lineWidth = spinner.thickness;
        ctx.beginPath(); ctx.moveTo(-spinner.armLength, 0); ctx.lineTo(spinner.armLength, 0); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(0, -spinner.armLength); ctx.lineTo(0, spinner.armLength); ctx.stroke();
        ctx.shadowBlur = 0;
        ctx.strokeStyle = 'rgba(255,232,156,.84)';
        ctx.lineWidth = Math.max(3, spinner.thickness * 0.24);
        ctx.setLineDash([13, 12]);
        ctx.beginPath(); ctx.moveTo(-spinner.armLength + 8, 0); ctx.lineTo(spinner.armLength - 8, 0); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(0, -spinner.armLength + 8); ctx.lineTo(0, spinner.armLength - 8); ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = '#203846';
        ctx.strokeStyle = 'rgba(255,255,255,.58)';
        ctx.lineWidth = 2.5;
        ctx.beginPath(); ctx.arc(0, 0, 18, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        ctx.restore();
      }

      for (const cannon of hole.hazards) {
        if (cannon.type !== 'cannon') continue;
        if (cannon.x + cannon.width / 2 < visible.minX || cannon.x - cannon.width / 2 > visible.maxX) continue;
        ctx.save();
        ctx.translate(cannon.x, cannon.y);
        ctx.rotate(cannon.angle);
        ctx.fillStyle = '#172632';
        ctx.beginPath();
        ctx.arc(-12, 7, 18, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#304a5b';
        this.roundedRect(ctx, -16, -8, 44, 16, 7);
        ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,.22)';
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.fillStyle = 'rgba(128,255,242,.65)';
        ctx.beginPath();
        ctx.moveTo(28, -6);
        ctx.lineTo(42, 0);
        ctx.lineTo(28, 6);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      }

      for (const multiplier of hole.hazards) {
        if (multiplier.type !== 'multiplier' || multiplier.collected) continue;
        if (multiplier.hiddenReward && !hole.hazards.some((hazard) => hazard.type === 'secret-cave' && hazard.discovered)) continue;
        if (multiplier.x + multiplier.radius * 2 < visible.minX || multiplier.x - multiplier.radius * 2 > visible.maxX) continue;
        const pulse = 1 + Math.sin(this.time * 4.6 + multiplier.x) * 0.08;
        ctx.save();
        ctx.translate(multiplier.x, multiplier.y);
        ctx.scale(pulse, pulse);
        ctx.rotate(this.time * 0.42);
        ctx.shadowColor = '#ffe477';
        ctx.shadowBlur = 19;
        const g = ctx.createLinearGradient(-16, -16, 16, 16);
        g.addColorStop(0, '#fff5a6');
        g.addColorStop(0.48, '#ffcc5c');
        g.addColorStop(1, '#ff8a62');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.moveTo(0, -multiplier.radius * 1.25);
        ctx.lineTo(multiplier.radius * 1.05, 0);
        ctx.lineTo(0, multiplier.radius * 1.25);
        ctx.lineTo(-multiplier.radius * 1.05, 0);
        ctx.closePath();
        ctx.fill();
        ctx.shadowBlur = 0;
        ctx.rotate(-this.time * 0.42);
        ctx.fillStyle = '#17252d';
        ctx.font = '900 12px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(`×${multiplier.multiplier || 2}`, 0, 0.5);
        ctx.restore();
      }

      for (const bumper of hole.hazards) {
        if (bumper.type !== 'bumper') continue;
        if (bumper.x + bumper.radius < visible.minX || bumper.x - bumper.radius > visible.maxX || bumper.y + bumper.radius < visible.minY || bumper.y - bumper.radius > visible.maxY) continue;
        const palettes = [
          ['#fff6aa', '#ff9b47', '#9f3352'],
          ['#dbffff', '#48e0e8', '#2552a8'],
          ['#edddff', '#b975ff', '#5731a4'],
        ];
        const p = palettes[bumper.hue % palettes.length];
        const grad = ctx.createRadialGradient(bumper.x - bumper.radius * 0.28, bumper.y - bumper.radius * 0.35, 2, bumper.x, bumper.y, bumper.radius);
        grad.addColorStop(0, '#ffffff');
        grad.addColorStop(0.28, p[0]);
        grad.addColorStop(0.70, p[1]);
        grad.addColorStop(1, p[2]);
        ctx.save();
        ctx.shadowColor = p[1];
        ctx.shadowBlur = 14;
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(bumper.x, bumper.y, bumper.radius, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;
        ctx.strokeStyle = 'rgba(255,255,255,.65)';
        ctx.lineWidth = 3;
        ctx.stroke();
        ctx.globalAlpha = 0.24;
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(bumper.x, bumper.y, bumper.radius * (0.50 + Math.sin(this.time * 4 + bumper.x) * 0.06), 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
    }

    drawDecorations(ctx, hole, visible) {
      const theme = hole.theme;
      for (const d of hole.decorations) {
        if (d.x < visible.minX || d.x > visible.maxX || d.y < visible.minY || d.y > visible.maxY) continue;
        const sway = Math.sin(this.time * 1.8 + d.phase) * 2.4;
        ctx.save();
        ctx.translate(d.x, d.y);
        ctx.scale(d.scale, d.scale);
        if (d.type === 'grass') {
          ctx.strokeStyle = theme.grassDark;
          ctx.lineWidth = 2;
          for (let i = -1; i <= 1; i += 1) {
            ctx.beginPath();
            ctx.moveTo(i * 3, 1);
            ctx.quadraticCurveTo(i * 5 + sway, -8, i * 3 + sway, -15 - Math.abs(i) * 3);
            ctx.stroke();
          }
        } else if (d.type === 'shrub') {
          ctx.fillStyle = 'rgba(51,120,72,.92)';
          ctx.beginPath();
          ctx.arc(-4, -8, 6, 0, Math.PI * 2);
          ctx.arc(2, -10, 7, 0, Math.PI * 2);
          ctx.arc(8, -7, 5, 0, Math.PI * 2);
          ctx.fill();
        } else if (d.type === 'flower') {
          ctx.strokeStyle = theme.grassDark;
          ctx.lineWidth = 1.5;
          ctx.beginPath(); ctx.moveTo(0, 1); ctx.lineTo(sway * 0.4, -14); ctx.stroke();
          ctx.fillStyle = theme.accent;
          for (let a = 0; a < 5; a += 1) {
            const ang = a * Math.PI * 2 / 5;
            ctx.beginPath(); ctx.arc(Math.cos(ang) * 4 + sway * 0.4, -14 + Math.sin(ang) * 4, 2.6, 0, Math.PI * 2); ctx.fill();
          }
        } else if (d.type === 'rock') {
          ctx.fillStyle = 'rgba(37,45,48,.72)';
          ctx.beginPath();
          ctx.moveTo(-8, 0); ctx.lineTo(-5, -10); ctx.lineTo(3, -14); ctx.lineTo(10, -4); ctx.lineTo(7, 0); ctx.closePath(); ctx.fill();
          ctx.strokeStyle = 'rgba(255,255,255,.12)'; ctx.stroke();
        } else if (d.type === 'crystal') {
          ctx.shadowColor = theme.accent;
          ctx.shadowBlur = 10;
          ctx.fillStyle = theme.accent;
          ctx.globalAlpha = 0.72;
          ctx.beginPath();
          ctx.moveTo(0, -24); ctx.lineTo(7, -7); ctx.lineTo(3, 0); ctx.lineTo(-5, -4); ctx.closePath(); ctx.fill();
        } else if (d.type === 'ice-crystal') {
          ctx.shadowColor = '#a8f5ff';
          ctx.shadowBlur = 9;
          ctx.fillStyle = 'rgba(183,245,255,.82)';
          ctx.beginPath();
          ctx.moveTo(0, -27); ctx.lineTo(8, -8); ctx.lineTo(3, 0); ctx.lineTo(-7, -5); ctx.closePath(); ctx.fill();
          ctx.shadowBlur = 0;
        } else if (d.type === 'snow-tuft') {
          ctx.fillStyle = 'rgba(238,253,255,.82)';
          ctx.beginPath();
          ctx.ellipse(-5, -2, 8, 4, -0.15, 0, Math.PI * 2);
          ctx.ellipse(5, -3, 9, 5, 0.12, 0, Math.PI * 2);
          ctx.fill();
        } else if (d.type === 'coral') {
          ctx.strokeStyle = '#ff8fa5';
          ctx.lineWidth = 4;
          ctx.lineCap = 'round';
          ctx.beginPath(); ctx.moveTo(0, 0); ctx.quadraticCurveTo(-1, -12, 2 + sway * 0.3, -24); ctx.stroke();
          ctx.beginPath(); ctx.moveTo(0, -10); ctx.quadraticCurveTo(-10, -13, -10, -20); ctx.stroke();
          ctx.beginPath(); ctx.moveTo(1, -15); ctx.quadraticCurveTo(11, -17, 12, -25); ctx.stroke();
          ctx.lineCap = 'butt';
        }
        ctx.restore();
      }
    }

    drawCup(ctx, game, viewportW, viewportH) {
      const { hole, camera } = game;
      const { x, y } = hole.cup;
      const screen = camera.worldToScreen(hole.cup);
      // Nunca dibujamos media copa/asta cortada por el viewport. Mientras no quepa
      // completa, el indicador de borde es la única representación del objetivo.
      if (screen.x < 88 || screen.x > viewportW - 88 || screen.y < 158 || screen.y > viewportH - 82) return;
      ctx.save();
      ctx.fillStyle = '#071914';
      ctx.beginPath();
      ctx.ellipse(x, y + 4, CONFIG.gameplay.holeRadius, 8, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,.92)';
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(x, y + 2);
      ctx.lineTo(x, y - 124);
      ctx.stroke();
      const wave = Math.sin(this.time * 3.5) * 6;
      ctx.fillStyle = hole.theme.accent;
      ctx.shadowColor = hole.theme.accent;
      ctx.shadowBlur = hole.environment === 'underwater' ? 12 : 0;
      ctx.beginPath();
      ctx.moveTo(x + 2, y - 122);
      ctx.quadraticCurveTo(x + 34, y - 112 + wave, x + 61, y - 102);
      ctx.lineTo(x + 2, y - 82);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }

    drawTrail(ctx, trail) {
      if (!trail || trail.length < 2) return;
      ctx.save();
      ctx.lineCap = 'round';
      for (let i = 1; i < trail.length; i += 1) {
        const a = trail[i - 1];
        const b = trail[i];
        const alpha = (i / trail.length) * 0.20;
        ctx.strokeStyle = `rgba(226,252,255,${alpha})`;
        ctx.lineWidth = 1 + (i / trail.length) * 3;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
      ctx.restore();
    }

    drawBall(ctx, ball, hole, game, style = null) {
      if (ball.holed) return;
      const r = CONFIG.ball.radius;
      const shadow = this.findShadowSurface(ball, hole, game);
      if (shadow) {
        const height = Math.max(0, shadow.y - ball.y);
        const maxHeight = CONFIG.rendering.shadowMaxHeight;
        const proximity = clamp(1 - height / Math.max(1, maxHeight), 0, 1);
        ctx.save();
        ctx.globalAlpha = 0.10 + proximity * 0.24;
        ctx.fillStyle = '#07141b';
        ctx.beginPath();
        ctx.ellipse(shadow.x, shadow.y + 3, r * (0.72 + proximity * 0.33), r * (0.18 + proximity * 0.12), 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }

      ctx.save();
      const ballColor = style?.color || '#f7fbff';
      ctx.fillStyle = ballColor;
      ctx.strokeStyle = style?.local ? 'rgba(255,255,255,.92)' : 'rgba(20,39,50,.66)';
      ctx.lineWidth = 1.35;
      ctx.beginPath();
      ctx.arc(ball.x, ball.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      if (style?.username) {
        const isBattleLocal = !!style.battleLocal;
        ctx.font = isBattleLocal
          ? '900 12px Inter, ui-sans-serif, system-ui, sans-serif'
          : '800 11px Inter, ui-sans-serif, system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        const safeName = String(style.username).slice(0, 18);
        const label = isBattleLocal ? `TÚ · ${safeName}` : safeName;
        const width = ctx.measureText(label).width + (isBattleLocal ? 20 : 14);
        const labelY = ball.y - r - (isBattleLocal ? 32 : 29);
        const labelH = isBattleLocal ? 22 : 19;
        ctx.fillStyle = isBattleLocal
          ? 'rgba(3,20,30,.98)'
          : (style?.turn ? 'rgba(7,28,38,.96)' : 'rgba(4,18,27,.76)');
        this.roundedRect(ctx, ball.x - width / 2, labelY, width, labelH, isBattleLocal ? 10 : 8);
        ctx.fill();
        if (style?.turn || isBattleLocal) {
          ctx.strokeStyle = style.color || '#ffffff';
          ctx.lineWidth = isBattleLocal ? 2.5 : 2;
          ctx.stroke();
        }
        if (isBattleLocal) {
          // Pequeño puntero de identidad hacia la bola local.
          ctx.fillStyle = style.color || '#ffffff';
          ctx.beginPath();
          ctx.moveTo(ball.x - 5, labelY + labelH);
          ctx.lineTo(ball.x + 5, labelY + labelH);
          ctx.lineTo(ball.x, labelY + labelH + 6);
          ctx.closePath();
          ctx.fill();
        }
        ctx.fillStyle = '#f7fbff';
        ctx.fillText(label, ball.x, labelY + labelH - (isBattleLocal ? 5 : 4));
      }
      ctx.restore();
    }

    findShadowSurface(ball, hole, game) {
      let best = null;
      let bestDist = Infinity;
      const candidates = [];
      for (const surface of hole.surfaces) {
        if (surface.side !== 'top') continue;
        if (ball.x < surface.xMin || ball.x > surface.xMax) continue;
        const y = TerrainUtil.sampleSurface(surface, ball.x);
        if (!Number.isFinite(y) || y < ball.y) continue;
        const dist = y - ball.y;
        if (dist < bestDist) {
          bestDist = dist;
          best = { x: ball.x, y };
        }
      }
      for (const hazard of hole.hazards) {
        if (hazard.type !== 'platform') continue;
        const state = game.physics.platformState(hazard);
        if (ball.x < state.x - hazard.width / 2 || ball.x > state.x + hazard.width / 2) continue;
        if (state.y < ball.y) continue;
        const dist = state.y - ball.y;
        if (dist < bestDist) {
          bestDist = dist;
          best = { x: ball.x, y: state.y };
        }
      }
      return bestDist <= CONFIG.rendering.shadowMaxHeight ? best : null;
    }

    drawAim(ctx, game) {
      const { ball, pointer, physics, hole } = game;
      const velocity = game.computeLaunchVelocity();
      const dx = pointer.x - ball.x;
      const dy = pointer.y - ball.y;
      const dragLength = Math.min(CONFIG.shot.maxDrag, Math.hypot(dx, dy));
      const a = Math.atan2(dy, dx);
      const handleX = ball.x + Math.cos(a) * dragLength;
      const handleY = ball.y + Math.sin(a) * dragLength;
      const power = clamp(Math.hypot(velocity.x, velocity.y) / CONFIG.ball.maxSpeed, 0, 1);

      ctx.save();
      ctx.strokeStyle = 'rgba(255,255,255,.82)';
      ctx.lineWidth = 3.5;
      ctx.setLineDash([8, 8]);
      ctx.beginPath();
      ctx.moveTo(ball.x, ball.y);
      ctx.lineTo(handleX, handleY);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.fillStyle = 'rgba(4,22,31,.84)';
      ctx.beginPath();
      ctx.arc(handleX, handleY, 10, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,.7)';
      ctx.lineWidth = 2;
      ctx.stroke();

      const preview = physics.simulatePreview(ball, velocity, hole);
      for (let i = 0; i < preview.length; i += 1) {
        const p = preview[i];
        const t = i / Math.max(1, preview.length - 1);
        const alpha = 0.88 * (1 - t * 0.55);
        const hue = lerp(170, 52, power);
        ctx.fillStyle = `hsla(${hue},92%,72%,${alpha})`;
        ctx.beginPath();
        ctx.arc(p.x, p.y, Math.max(2.0, 4.8 - t * 2.5), 0, Math.PI * 2);
        ctx.fill();
      }
      if (preview.length) {
        const last = preview[preview.length - 1];
        ctx.strokeStyle = 'rgba(255,255,255,.52)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(last.x, last.y, 14 + Math.sin(this.time * 6) * 2, 0, Math.PI * 2);
        ctx.stroke();
      }

      const barW = 140;
      const barX = ball.x - barW / 2;
      const barY = ball.y - 52;
      ctx.fillStyle = 'rgba(4,20,30,.82)';
      this.roundedRect(ctx, barX - 4, barY - 4, barW + 8, 16, 8);
      ctx.fill();
      const pg = ctx.createLinearGradient(barX, 0, barX + barW, 0);
      pg.addColorStop(0, '#72f0a0');
      pg.addColorStop(0.6, '#f3df65');
      pg.addColorStop(1, '#ff705f');
      ctx.fillStyle = pg;
      this.roundedRect(ctx, barX, barY, barW * power, 8, 4);
      ctx.fill();
      ctx.restore();
    }

    drawUnderwaterOverlay(ctx, w, h) {
      ctx.save();
      const overlay = ctx.createLinearGradient(0, 0, 0, h);
      overlay.addColorStop(0, 'rgba(22,124,151,.06)');
      overlay.addColorStop(1, 'rgba(0,46,73,.20)');
      ctx.fillStyle = overlay;
      ctx.fillRect(0, 0, w, h);
      ctx.globalAlpha = 0.10;
      ctx.strokeStyle = '#d5ffff';
      ctx.lineWidth = 12;
      for (let x = -100; x < w + 160; x += 170) {
        ctx.beginPath();
        ctx.moveTo(x + Math.sin(this.time) * 20, -40);
        ctx.quadraticCurveTo(x + 90, h * 0.38, x + 35 + Math.sin(this.time * 0.7 + x) * 28, h + 60);
        ctx.stroke();
      }
      ctx.restore();
    }

    drawVignette(ctx, w, h, hole) {
      const radial = ctx.createRadialGradient(w * 0.5, h * 0.45, Math.min(w, h) * 0.18, w * 0.5, h * 0.5, Math.max(w, h) * 0.72);
      radial.addColorStop(0, 'rgba(0,0,0,0)');
      radial.addColorStop(1, hole.environment === 'underwater' ? 'rgba(0,16,32,.26)' : 'rgba(5,18,26,.14)');
      ctx.fillStyle = radial;
      ctx.fillRect(0, 0, w, h);
    }

    drawEdgeIndicator(ctx, game, w, h) {
      const { hole, ball, camera } = game;
      const focusBall = game.networkSession?.getCameraBall?.() || game.renderBall || ball;
      const cupScreen = camera.worldToScreen(hole.cup);
      const margin = 88;
      const topMargin = 158;
      if (cupScreen.x >= margin && cupScreen.x <= w - margin && cupScreen.y >= topMargin && cupScreen.y <= h - margin) return;

      const cx = w / 2;
      const cy = h / 2;
      const dx = cupScreen.x - cx;
      const dy = cupScreen.y - cy;
      const angle = Math.atan2(dy, dx);
      const rx = Math.max(50, w / 2 - margin);
      const ry = Math.max(50, h / 2 - margin);
      const denom = Math.sqrt((Math.cos(angle) ** 2) / (rx ** 2) + (Math.sin(angle) ** 2) / (ry ** 2)) || 1;
      const d = 1 / denom;
      const tx = clamp(cx + Math.cos(angle) * d, margin, w - margin);
      const ty = clamp(cy + Math.sin(angle) * d, topMargin, h - margin);
      const distanceMeters = Math.max(0, Math.hypot(hole.cup.x - focusBall.x, hole.cup.y - focusBall.y) * CONFIG.course.metersPerPixel);

      ctx.save();
      ctx.translate(tx, ty);
      ctx.fillStyle = 'rgba(5,20,30,.86)';
      ctx.strokeStyle = 'rgba(255,255,255,.25)';
      ctx.lineWidth = 1;
      this.roundedRect(ctx, -62, -27, 124, 54, 17);
      ctx.fill();
      ctx.stroke();
      ctx.save();
      ctx.rotate(angle);
      ctx.fillStyle = hole.theme.accent;
      ctx.shadowColor = hole.theme.accent;
      ctx.shadowBlur = 9;
      ctx.beginPath();
      ctx.moveTo(38, 0);
      ctx.lineTo(20, -10);
      ctx.lineTo(20, 10);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
      ctx.shadowBlur = 0;
      ctx.fillStyle = '#ffffff';
      ctx.font = '800 12px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(`${distanceMeters.toFixed(0)} m`, -5, 1);
      ctx.restore();
    }

    drawStar(ctx, x, y, innerRadius, outerRadius, points) {
      ctx.beginPath();
      for (let i = 0; i < points * 2; i += 1) {
        const radius = i % 2 === 0 ? outerRadius : innerRadius;
        const angle = (Math.PI / points) * i - Math.PI / 2;
        const px = x + Math.cos(angle) * radius;
        const py = y + Math.sin(angle) * radius;
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.closePath();
    }

    roundedRect(ctx, x, y, w, h, r) {
      if (w <= 0 || h <= 0) return;
      if (typeof ctx.roundRect === 'function') {
        ctx.beginPath();
        ctx.roundRect(x, y, w, h, Math.min(r, w / 2, h / 2));
        return;
      }
      const radius = Math.min(r, w / 2, h / 2);
      ctx.beginPath();
      ctx.moveTo(x + radius, y);
      ctx.lineTo(x + w - radius, y);
      ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
      ctx.lineTo(x + w, y + h - radius);
      ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
      ctx.lineTo(x + radius, y + h);
      ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
      ctx.lineTo(x, y + radius);
      ctx.quadraticCurveTo(x, y, x + radius, y);
      ctx.closePath();
    }
  }

  NG.WorldRenderer = WorldRenderer;
}(window.NoiseGolf = window.NoiseGolf || {}));
