(function (NG) {
  'use strict';

  const { CONFIG, ValueNoise1D } = NG;
  const {
    clamp, lerp, smoothstep, seededRandom, pick, randomRange,
  } = NG.MathUtil;

  const ARCHETYPES = Object.freeze({
    MEADOW: 'meadow',
    SKY: 'sky-islands',
    CAVERN: 'cavern',
    AQUA: 'aqua-cavern',
    HYBRID: 'hybrid',
    GLACIER: 'glacier',
  });

  const THEMES = Object.freeze({
    meadow: Object.freeze({
      name: 'Pradera Alta', skyTop: '#45a9e8', skyBottom: '#dff7ff', haze: '#c9f0dc',
      grass: '#62c96a', grassDark: '#20814b', soil: '#72523d', soilDark: '#2d342d', accent: '#ffe06a',
      water: '#2ca8da', waterDeep: '#176fa8', fog: 'rgba(214,246,234,.20)',
    }),
    sunset: Object.freeze({
      name: 'Meseta Solar', skyTop: '#735cc6', skyBottom: '#ffd9a8', haze: '#ffd69e',
      grass: '#79bd62', grassDark: '#346f49', soil: '#7c4f42', soilDark: '#302c37', accent: '#ff7c6d',
      water: '#3da6d8', waterDeep: '#265e9d', fog: 'rgba(255,210,160,.18)',
    }),
    sky: Object.freeze({
      name: 'Archipiélago Celeste', skyTop: '#3b83db', skyBottom: '#d7f8ff', haze: '#bfefff',
      grass: '#7edc78', grassDark: '#2c8b5c', soil: '#6e5a56', soilDark: '#313b45', accent: '#7cf6ff',
      water: '#45c4e6', waterDeep: '#236fa7', fog: 'rgba(192,241,255,.22)',
    }),
    cavern: Object.freeze({
      name: 'Cañón de Cristal', skyTop: '#18293f', skyBottom: '#506f78', haze: '#6d8d86',
      grass: '#63ad67', grassDark: '#285f48', soil: '#5b4b48', soilDark: '#201f2a', accent: '#71f0d0',
      water: '#2f99c5', waterDeep: '#153f72', fog: 'rgba(94,151,145,.18)',
    }),
    aqua: Object.freeze({
      name: 'Gruta Abisal', skyTop: '#082e47', skyBottom: '#176d83', haze: '#4a9ca5',
      grass: '#3d9d79', grassDark: '#175b52', soil: '#39535a', soilDark: '#142c39', accent: '#7bffdc',
      water: '#3fd1df', waterDeep: '#0b5b86', fog: 'rgba(56,168,184,.24)',
    }),
    ice: Object.freeze({
      name: 'Glaciar Cinético', isIce: true, skyTop: '#2f73c9', skyBottom: '#dff8ff', haze: '#bdeeff',
      grass: '#bff7ff', grassDark: '#59b9cf', soil: '#41657d', soilDark: '#172f45', accent: '#b9ffff',
      water: '#50d8ef', waterDeep: '#1c7ba8', fog: 'rgba(201,246,255,.24)',
    }),
  });

  const TerrainUtil = {
    sampleSurface(surface, x) {
      const pts = surface?.points;
      if (!pts || pts.length === 0) return NaN;
      if (x <= pts[0].x) return pts[0].y;
      if (x >= pts[pts.length - 1].x) return pts[pts.length - 1].y;
      let lo = 0;
      let hi = pts.length - 1;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (pts[mid].x <= x) lo = mid;
        else hi = mid;
      }
      const a = pts[lo];
      const b = pts[hi];
      return lerp(a.y, b.y, (x - a.x) / Math.max(0.0001, b.x - a.x));
    },

    surfaceSlope(surface, x, radius = 8) {
      const left = clamp(x - radius, surface.xMin, surface.xMax);
      const right = clamp(x + radius, surface.xMin, surface.xMax);
      if (right <= left) return 0;
      return (this.sampleSurface(surface, right) - this.sampleSurface(surface, left)) / (right - left);
    },

    findSurface(hole, id) {
      return hole?.surfaces?.find((surface) => surface.id === id) || null;
    },

    surfaceMaterialAt(hole, surfaceId, x) {
      const priority = ['water', 'booster', 'ice', 'sand', 'rough'];
      for (const type of priority) {
        const hazard = hole.hazards.find((h) => h.type === type && h.surfaceId === surfaceId && x >= h.x - this.hazardWidth(h) / 2 && x <= h.x + this.hazardWidth(h) / 2);
        if (hazard) return type;
      }
      const surface = this.findSurface(hole, surfaceId);
      return surface?.material || 'fairway';
    },

    waterAt(hole, surfaceId, x) {
      return hole.hazards.find((h) => h.type === 'water' && h.surfaceId === surfaceId && x >= h.x - h.width / 2 && x <= h.x + h.width / 2) || null;
    },

    boosterAt(hole, surfaceId, x) {
      return hole.hazards.find((h) => h.type === 'booster' && h.surfaceId === surfaceId && x >= h.x - h.width / 2 && x <= h.x + h.width / 2) || null;
    },

    hazardWidth(hazard) {
      if (!hazard) return 0;
      if (hazard.type === 'bumper') return hazard.radius * 2;
      if (hazard.type === 'portal') return hazard.radius * 2;
      if (hazard.type === 'fan') return hazard.width || hazard.range || 0;
      if (hazard.type === 'multiplier') return hazard.radius * 2;
      if (hazard.type === 'secret-cave') return hazard.entranceRadius * 2;
      if (hazard.type === 'gravity-well') return hazard.radius * 2;
      if (hazard.type === 'platform') return hazard.width || 0;
      if (hazard.type === 'cannon') return hazard.width || 0;
      if (hazard.type === 'moving-wall') return hazard.width || 0;
      if (hazard.type === 'spinner') return (hazard.armLength || 0) * 2 + (hazard.thickness || 0);
      if (hazard.type === 'ice') return hazard.width || 0;
      return hazard.width || 0;
    },
  };

  class TerrainGenerator {
    constructor(seed, options = {}) {
      this.seed = seed >>> 0;
      this.random = seededRandom(this.seed);
      this.noise = new ValueNoise1D(this.seed ^ 0xA53A9E1D);
      this.detailNoise = new ValueNoise1D(this.seed ^ 0x7F4A7C15);
      this.surfaceCounter = 0;
      this.portalPairCounter = 0;
      this.secretCaveCounter = 0;
      const known = Object.values(ARCHETYPES);
      const requested = Array.isArray(options.allowedArchetypes)
        ? options.allowedArchetypes.filter((value) => known.includes(value))
        : [];
      this.allowedArchetypes = requested.length ? [...new Set(requested)] : known;
    }

    generateHole(index) {
      const random = this.random;
      const widthT = random();
      const width = Math.round(lerp(CONFIG.course.minWidth, CONFIG.course.maxWidth, widthT) / 20) * 20;
      const height = Math.round(lerp(CONFIG.course.minHeight, CONFIG.course.maxHeight, random()) / 20) * 20;
      const compactness = 1 - widthT;
      const difficulty = clamp(0.34 + compactness * 0.42 + random() * 0.25 + index * 0.035, 0.25, 0.98);
      const archetype = this.chooseArchetype(widthT, index);
      const themeKey = this.chooseTheme(archetype);
      const theme = THEMES[themeKey];
      const mirrored = random() < 0.50;

      const teeX = CONFIG.course.startPadding;
      const nominalCupX = width - CONFIG.course.cupPadding;
      const baseYFactor = archetype === ARCHETYPES.SKY ? 0.79 : archetype === ARCHETYPES.AQUA ? 0.73 : 0.71;
      const groundPoints = this.generateGroundPoints(width, height, index, height * baseYFactor, difficulty);
      this.flattenAround(groundPoints, teeX, height * baseYFactor - 8, 210, 0.97);
      this.limitSlopes(groundPoints, CONFIG.generation.maxGroundSlope);

      const groundMaterial = archetype === ARCHETYPES.GLACIER ? 'ice' : 'fairway';
      const surfaces = [this.makeSurface('ground', 'ground', groundPoints, 'top', groundMaterial)];
      const nominalGroundCupY = TerrainUtil.sampleSurface(surfaces[0], nominalCupX) - 10;
      this.flattenAround(groundPoints, nominalCupX, nominalGroundCupY, 250, 0.96);
      this.limitSlopes(groundPoints, CONFIG.generation.maxGroundSlope);
      const roofs = [];
      const islands = [];

      if (archetype === ARCHETYPES.SKY) {
        islands.push(...this.generateIslandRoute(width, height, teeX, nominalCupX, difficulty, true));
      } else if (archetype === ARCHETYPES.HYBRID) {
        islands.push(...this.generateIslandRoute(width, height, teeX + 600, nominalCupX - 180, difficulty, false));
      } else if (archetype === ARCHETYPES.GLACIER) {
        islands.push(...this.generateDecorativeIslands(width, height, teeX, nominalCupX));
      } else if (widthT > 0.58 && archetype === ARCHETYPES.MEADOW && random() > 0.38) {
        islands.push(...this.generateDecorativeIslands(width, height, teeX, nominalCupX));
      }

      if (islands.length) this.ensureIslandClearance(islands, surfaces[0], 92);

      if (archetype === ARCHETYPES.HYBRID) {
        roofs.push(...this.generateCaveRoofs(
          surfaces[0], width, height, teeX, nominalCupX, difficulty,
          Math.max(1, Math.round(width / 2400)),
          islands.filter((s) => s.kind === 'island' && s.side === 'top'),
        ));
      } else if (archetype === ARCHETYPES.CAVERN || archetype === ARCHETYPES.AQUA) {
        roofs.push(...this.generateCaveRoofs(surfaces[0], width, height, teeX, nominalCupX, difficulty, Math.max(2, Math.round(width / 1450))));
      }

      surfaces.push(...islands);
      surfaces.push(...roofs);
      if (archetype === ARCHETYPES.GLACIER) {
        for (const surface of surfaces) {
          if (surface.side === 'top' && (surface.kind === 'ground' || surface.kind === 'island')) surface.material = 'ice';
        }
      }

      const tee = { x: teeX, y: TerrainUtil.sampleSurface(surfaces[0], teeX) - CONFIG.ball.radius, surfaceId: surfaces[0].id };
      const cupPlacement = this.selectCupPlacement({ width, height, surfaces, tee, archetype, difficulty });
      const cup = { x: cupPlacement.x, y: TerrainUtil.sampleSurface(cupPlacement.surface, cupPlacement.x), surfaceId: cupPlacement.surface.id };

      const hazards = this.generateHazards({
        width, height, difficulty, compactness, archetype, surfaces, tee, cup,
      });
      const solidWalls = this.buildSolidWalls(surfaces);
      const decorations = this.generateDecorations({ width, height, archetype, surfaces, hazards, tee, cup });
      const par = this.computePar(tee, cup, hazards, archetype);

      const windSpeed = CONFIG.wind.minMps + random() * (CONFIG.wind.maxMps - CONFIG.wind.minMps);
      const dominant = random() < 0.5 ? 0 : Math.PI;
      const windAngle = dominant + randomRange(random, -0.52, 0.52) + (archetype === ARCHETYPES.SKY ? randomRange(random, -0.24, 0.24) : 0);

      const mapSize = widthT < 0.28 ? 'Compacto' : widthT < 0.66 ? 'Medio' : 'Extenso';
      const difficultyLabel = difficulty < 0.46 ? 'Suave' : difficulty < 0.68 ? 'Técnico' : difficulty < 0.84 ? 'Difícil' : 'Brutal';

      const hole = {
        index,
        width,
        height,
        startX: 0,
        endX: width,
        teeX: tee.x,
        holeX: cup.x,
        holeY: cup.y,
        tee,
        cup,
        par,
        difficulty,
        difficultyLabel,
        mapSize,
        archetype,
        archetypeLabel: this.archetypeLabel(archetype),
        environment: archetype === ARCHETYPES.AQUA ? 'underwater' : 'air',
        themeKey,
        theme,
        surfaces,
        solidWalls,
        hazards,
        decorations,
        windBase: { speed: windSpeed, angle: windAngle },
        bounds: {
          minX: 0,
          maxX: width,
          minY: 0,
          maxY: height,
        },
        paletteShift: random(),
        mirrored,
        scoreMultiplierCollected: false,
      };

      if (mirrored) this.mirrorHole(hole);
      this.validateAndRepairHole(hole);
      return hole;
    }

    chooseArchetype(widthT, index) {
      const r = this.random();
      let selected;
      if (index === 0 && r < 0.28) selected = ARCHETYPES.MEADOW;
      else if (widthT > 0.56 && r < 0.38) selected = ARCHETYPES.SKY;
      else if (r < 0.23) selected = ARCHETYPES.CAVERN;
      else if (r < 0.42) selected = ARCHETYPES.AQUA;
      else if (r < 0.62) selected = ARCHETYPES.HYBRID;
      else if (r < 0.76) selected = ARCHETYPES.GLACIER;
      else selected = r < 0.88 ? ARCHETYPES.MEADOW : ARCHETYPES.SKY;
      if (this.allowedArchetypes.includes(selected)) return selected;
      return this.allowedArchetypes[Math.min(this.allowedArchetypes.length - 1, Math.floor(r * this.allowedArchetypes.length))];
    }

    chooseTheme(archetype) {
      if (archetype === ARCHETYPES.SKY) return 'sky';
      if (archetype === ARCHETYPES.CAVERN) return 'cavern';
      if (archetype === ARCHETYPES.AQUA) return 'aqua';
      if (archetype === ARCHETYPES.HYBRID) return this.random() < 0.5 ? 'sunset' : 'meadow';
      if (archetype === ARCHETYPES.GLACIER) return 'ice';
      return this.random() < 0.30 ? 'sunset' : 'meadow';
    }

    archetypeLabel(archetype) {
      if (archetype === ARCHETYPES.SKY) return 'Islas flotantes';
      if (archetype === ARCHETYPES.CAVERN) return 'Cañón y túneles';
      if (archetype === ARCHETYPES.AQUA) return 'Cuevas submarinas';
      if (archetype === ARCHETYPES.HYBRID) return 'Ruta híbrida';
      if (archetype === ARCHETYPES.GLACIER) return 'Glaciar cinético';
      return 'Pradera procedural';
    }

    generateGroundPoints(width, height, index, baseY, difficulty) {
      const points = [];
      const step = CONFIG.course.terrainStep;
      const amplitude = lerp(115, 220, difficulty);
      for (let x = -320; x <= width + 320; x += step) {
        const nx = x * 0.00084 + index * 11.73 + this.seed * 0.000001;
        const broad = this.noise.fbm(nx, 5, 1.88, 0.53) * amplitude;
        const ridges = this.noise.ridged(nx * 2.1 + 14, 3, 2.03, 0.48) * amplitude * 0.28;
        const detail = this.detailNoise.fbm(nx * 5.8 - 21, 2, 2.0, 0.43) * 18;
        const wave = Math.sin(nx * 4.3) * 24 + Math.sin(nx * 1.22) * 34;
        const y = clamp(baseY + broad + ridges + detail + wave, height * 0.38, height * 0.89);
        points.push({ x, y });
      }
      return points;
    }

    generateIslandRoute(width, height, startX, endX, difficulty, fullRoute) {
      const random = this.random;
      const minGap = CONFIG.ball.radius * 2 + 58;
      const worldMargin = 72;
      const minWidth = CONFIG.generation.islandMinWidth;
      const routeFirst = clamp(
        startX + Math.min(760, Math.max(320, (endX - startX) * 0.18)),
        worldMargin + minWidth / 2,
        width - worldMargin - minWidth / 2,
      );
      const routeLast = clamp(
        endX,
        routeFirst,
        width - worldMargin - minWidth / 2,
      );
      const routeSpan = Math.max(0, routeLast - routeFirst);
      const targetGap = clamp(CONFIG.generation.islandMaxGap - difficulty * 110, 520, 760);
      const desired = clamp(Math.ceil(Math.max(900, endX - startX) / targetGap), fullRoute ? 3 : 1, fullRoute ? 12 : 5);
      const maxFit = Math.max(1, Math.floor((routeSpan + minGap) / (minWidth + minGap)) + 1);
      const count = Math.max(1, Math.min(desired, maxFit));
      const surfaces = [];
      let previousY = height * 0.62;
      const centers = [];
      for (let i = 0; i < count; i += 1) {
        const t = count === 1 ? 1 : i / (count - 1);
        let center = lerp(routeFirst, routeLast, t);
        if (i > 0 && i < count - 1) {
          const nominalSpacing = routeSpan / Math.max(1, count - 1);
          // El jitter nunca puede comerse el corredor físico mínimo entre dos islas.
          // Como dos vecinas pueden desviarse una contra otra, cada una usa menos de
          // la mitad del slack disponible sobre (ancho mínimo + gap seguro).
          const spacingSlack = Math.max(0, nominalSpacing - (minWidth + minGap));
          const jitterLimit = Math.min(92, nominalSpacing * 0.12, spacingSlack * 0.45);
          center += randomRange(random, -jitterLimit, jitterLimit);
        }
        centers.push(center);
      }
      centers.sort((a, b) => a - b);

      for (let i = 0; i < count; i += 1) {
        const center = centers[i];
        const leftDistance = i > 0 ? center - centers[i - 1] : Infinity;
        const rightDistance = i < count - 1 ? centers[i + 1] - center : Infinity;
        const boundsWidth = Math.min((center - worldMargin) * 2, (width - worldMargin - center) * 2);
        const neighborWidth = Math.min(leftDistance - minGap, rightDistance - minGap);
        const localMaxWidth = Math.max(
          Math.min(minWidth, boundsWidth),
          Math.min(CONFIG.generation.islandMaxWidth, boundsWidth, neighborWidth),
        );
        const safeMax = Math.max(260, localMaxWidth);
        const safeMin = Math.min(minWidth, safeMax);
        let islandWidth = randomRange(random, safeMin, safeMax);
        if (routeSpan > 3200 && random() < 0.62) islandWidth = Math.min(safeMax, islandWidth * randomRange(random, 1.16, 1.70));

        const t = count === 1 ? 1 : i / (count - 1);
        const targetY = height * (0.60 - Math.sin(t * Math.PI) * 0.15) + randomRange(random, -90, 70);
        const y = clamp(targetY, previousY - CONFIG.generation.islandMaxRise, previousY + CONFIG.generation.islandMaxRise);
        previousY = y;
        const points = this.makeIslandTop(center, y, islandWidth, 12 + Math.round(random() * 5));
        const surface = this.makeSurface(`island-${i}`, 'island', points, 'top', 'fairway', {
          thickness: randomRange(random, 155, 380),
          seed: Math.floor(random() * 100000),
        });
        surfaces.push(surface);
        surfaces.push(this.makeIslandUnderside(surface));
      }
      return surfaces;
    }

    generateDecorativeIslands(width, height, teeX, cupX) {
      const count = 1 + Math.floor(this.random() * 4);
      const out = [];
      const occupied = [];
      const minGap = CONFIG.ball.radius * 2 + 80;
      for (let i = 0; i < count; i += 1) {
        let center = null;
        let islandWidth = null;
        for (let attempt = 0; attempt < 70; attempt += 1) {
          islandWidth = randomRange(this.random, 520, 1320);
          const minCenter = teeX + 720 + islandWidth / 2;
          const maxCenter = Math.min(cupX - 500 - islandWidth / 2, width - 80 - islandWidth / 2);
          if (maxCenter <= minCenter) break;
          const candidate = randomRange(this.random, minCenter, maxCenter);
          const overlaps = occupied.some((o) => Math.abs(o.x - candidate) < (o.width + islandWidth) * 0.5 + minGap);
          if (overlaps) continue;
          center = candidate;
          break;
        }
        if (center === null) continue;
        occupied.push({ x: center, width: islandWidth });
        const y = randomRange(this.random, height * 0.32, height * 0.55);
        const top = this.makeSurface(`island-d-${i}`, 'island', this.makeIslandTop(center, y, islandWidth, 12), 'top', 'fairway', {
          thickness: randomRange(this.random, 150, 330), seed: Math.floor(this.random() * 100000),
        });
        out.push(top, this.makeIslandUnderside(top));
      }
      return out;
    }

    makeIslandTop(center, y, width, samples) {
      const points = [];
      const start = center - width / 2;
      for (let i = 0; i < samples; i += 1) {
        const t = i / (samples - 1);
        const edgeLift = Math.pow(Math.abs(t - 0.5) * 2, 2) * randomRange(this.random, 18, 34);
        const irregular = this.detailNoise.fbm(center * 0.002 + t * 2.4, 2, 2, 0.45) * 10;
        points.push({ x: start + t * width, y: y + edgeLift + irregular });
      }
      this.limitSlopes(points, 0.45);
      return points;
    }

    makeIslandUnderside(top) {
      const thickness = top.thickness || 160;
      const center = (top.xMin + top.xMax) * 0.5;
      const width = Math.max(1, top.xMax - top.xMin);
      const pts = top.points.map((p, i, arr) => {
        const t = i / Math.max(1, arr.length - 1);
        const core = Math.pow(Math.sin(t * Math.PI), 0.72);
        const asymmetric = 0.78 + 0.22 * Math.sin(t * Math.PI * 3.0 + top.seed * 0.003);
        const crag = Math.abs(this.detailNoise.fbm((center + p.x) * 0.0017 + t * 3.1, 3, 2.0, 0.47)) * thickness * 0.24;
        const needle = Math.pow(core, 2.3) * thickness * randomRange(this.random, 0.20, 0.40);
        const belly = thickness * (0.42 + core * 0.70 * asymmetric) + crag + needle;
        const edgeTaper = lerp(0.70, 1, clamp(width / 1100, 0, 1));
        return { x: p.x, y: p.y + belly * edgeTaper };
      });
      return this.makeSurface(`${top.id}-under`, 'island-under', pts, 'bottom', 'rock', { parentId: top.id });
    }

    ensureIslandClearance(islands, ground, clearance = 92) {
      const tops = islands.filter((s) => s.kind === 'island' && s.side === 'top');
      for (const top of tops) {
        const underside = islands.find((s) => s.kind === 'island-under' && s.parentId === top.id);
        if (!underside) continue;
        let violation = 0;
        for (const point of underside.points) {
          const groundY = TerrainUtil.sampleSurface(ground, point.x);
          if (!Number.isFinite(groundY)) continue;
          violation = Math.max(violation, point.y - (groundY - clearance));
        }
        if (violation <= 0) continue;
        const shift = violation + 8;
        for (const point of top.points) point.y -= shift;
        for (const point of underside.points) point.y -= shift;
      }
    }

    generateCaveRoofs(ground, width, height, teeX, cupX, difficulty, count, exclusions = []) {
      const out = [];
      const occupied = [];
      for (let i = 0; i < count; i += 1) {
        let center = null;
        let roofWidth = null;
        for (let attempt = 0; attempt < 60; attempt += 1) {
          roofWidth = randomRange(this.random, 520, Math.min(1280, width * 0.25));
          center = randomRange(this.random, teeX + 520 + roofWidth / 2, cupX - 260 - roofWidth / 2);
          const minRoofGap = CONFIG.ball.radius * 2 + 56;
          const overlapsRoof = occupied.some((r) => Math.abs(r.x - center) < (r.width + roofWidth) * 0.5 + minRoofGap);
          const candidateStart = center - roofWidth * 0.5;
          const candidateEnd = center + roofWidth * 0.5;
          const sideCorridor = CONFIG.ball.radius * 2 + 62;
          const pinchesIslandSide = exclusions.some((island) => {
            const leftGap = candidateStart - island.xMax;
            const rightGap = island.xMin - candidateEnd;
            return (leftGap > 0 && leftGap < sideCorridor) || (rightGap > 0 && rightGap < sideCorridor);
          });
          if (!overlapsRoof && !pinchesIslandSide) break;
          center = null;
        }
        if (center === null) continue;
        occupied.push({ x: center, width: roofWidth });
        const start = center - roofWidth / 2;
        const samples = Math.max(8, Math.round(roofWidth / 90));
        const clearance = randomRange(this.random, CONFIG.generation.caveMinClearance, CONFIG.generation.caveMaxClearance) - difficulty * 35;
        const points = [];
        for (let p = 0; p < samples; p += 1) {
          const t = p / (samples - 1);
          const x = start + t * roofWidth;
          const groundY = TerrainUtil.sampleSurface(ground, x);
          const arch = Math.sin(t * Math.PI) * randomRange(this.random, 18, 62);
          const wobble = this.detailNoise.fbm(x * 0.003 + i * 7.1, 2, 2, 0.5) * 18;
          points.push({ x, y: clamp(groundY - clearance - arch + wobble, height * 0.10, groundY - 170) });
        }
        this.limitSlopes(points, 0.65);
        let neededLift = 0;
        const requiredIslandClearance = 225;
        for (const island of exclusions) {
          const overlapMin = Math.max(start, island.xMin);
          const overlapMax = Math.min(start + roofWidth, island.xMax);
          if (overlapMax <= overlapMin) continue;
          const samplesCheck = 8;
          for (let c = 0; c <= samplesCheck; c += 1) {
            const x = lerp(overlapMin, overlapMax, c / samplesCheck);
            const roofY = TerrainUtil.sampleSurface({ points, xMin: start, xMax: start + roofWidth }, x);
            const islandY = TerrainUtil.sampleSurface(island, x);
            if (!Number.isFinite(roofY) || !Number.isFinite(islandY)) continue;
            neededLift = Math.max(neededLift, requiredIslandClearance - (islandY - roofY));
          }
        }
        if (neededLift > 0) for (const point of points) point.y -= neededLift + 10;
        out.push(this.makeSurface(`roof-${i}`, 'roof', points, 'bottom', 'rock', { seed: Math.floor(this.random() * 100000) }));
      }
      return out;
    }

    computeReachableSurfaceIds(topSurfaces, tee) {
      const reachable = new Set([tee.surfaceId]);
      const maxGap = CONFIG.generation.cupReachMaxGap;
      const maxRise = CONFIG.generation.cupReachMaxRise;
      const inset = 56;
      const samplePair = (a, b) => {
        const overlap0 = Math.max(a.xMin + inset, b.xMin + inset);
        const overlap1 = Math.min(a.xMax - inset, b.xMax - inset);
        if (overlap1 >= overlap0) {
          const x = (overlap0 + overlap1) * 0.5;
          return { ax: x, bx: x, gap: 0 };
        }
        if (a.xMax < b.xMin) {
          const ax = Math.max(a.xMin, a.xMax - inset);
          const bx = Math.min(b.xMax, b.xMin + inset);
          return { ax, bx, gap: Math.max(0, bx - ax) };
        }
        const ax = Math.min(a.xMax, a.xMin + inset);
        const bx = Math.max(b.xMin, b.xMax - inset);
        return { ax, bx, gap: Math.max(0, ax - bx) };
      };

      for (let pass = 0; pass < topSurfaces.length + 2; pass += 1) {
        let changed = false;
        for (const target of topSurfaces) {
          if (reachable.has(target.id)) continue;
          for (const source of topSurfaces) {
            if (!reachable.has(source.id) || source.id === target.id) continue;
            const pair = samplePair(source, target);
            if (pair.gap > maxGap) continue;
            const sourceY = TerrainUtil.sampleSurface(source, pair.ax) - CONFIG.ball.radius;
            const targetY = TerrainUtil.sampleSurface(target, pair.bx) - CONFIG.ball.radius;
            if (!Number.isFinite(sourceY) || !Number.isFinite(targetY)) continue;
            const rise = sourceY - targetY;
            if (rise > maxRise) continue;
            reachable.add(target.id);
            changed = true;
            break;
          }
        }
        if (!changed) break;
      }
      return reachable;
    }

    selectCupPlacement({ width, height, surfaces, tee, archetype, difficulty }) {
      const candidates = [];
      const topSurfaces = surfaces.filter((s) => s.side === 'top');
      const reachable = this.computeReachableSurfaceIds(topSurfaces, tee);
      const safeMinX = CONFIG.generation.cupWorldInsetX;
      const safeMaxX = width - CONFIG.generation.cupWorldInsetX;
      const safeMinY = CONFIG.generation.cupWorldInsetTop;
      const safeMaxY = height - CONFIG.generation.cupWorldInsetBottom;
      const surfaceClearance = Math.max(CONFIG.generation.cupSurfaceEdgeClearance, CONFIG.gameplay.holeRadius * 3.8);
      const preferredModes = archetype === ARCHETYPES.SKY
        ? ['high', 'island-edge', 'distance']
        : archetype === ARCHETYPES.CAVERN || archetype === ARCHETYPES.AQUA
          ? ['low', 'awkward', 'distance']
          : archetype === ARCHETYPES.GLACIER
            ? ['awkward', 'high', 'distance', 'island-edge']
            : ['awkward', 'high', 'distance', 'island-edge'];
      const preferredMode = pick(this.random, preferredModes);

      for (const surface of topSurfaces) {
        if (!reachable.has(surface.id)) continue;
        const span = surface.xMax - surface.xMin;
        if (span < surfaceClearance * 2 + 40) continue;
        const usableMin = Math.max(surface.xMin + surfaceClearance, safeMinX);
        const usableMax = Math.min(surface.xMax - surfaceClearance, safeMaxX);
        if (usableMax <= usableMin) continue;
        const samples = Math.max(4, Math.floor((usableMax - usableMin) / 115));
        for (let i = 0; i <= samples; i += 1) {
          const u = samples === 0 ? 0.5 : i / samples;
          const x = lerp(usableMin, usableMax, u);
          const y = TerrainUtil.sampleSurface(surface, x);
          const slope = Math.abs(TerrainUtil.surfaceSlope(surface, x));
          if (!Number.isFinite(y) || y < safeMinY || y > safeMaxY || slope > 0.34) continue;

          const dx = Math.abs(x - tee.x);
          const horizontal = dx / Math.max(1, width);
          if (horizontal < 0.36) continue;

          const normalizedY = clamp(y / Math.max(1, height), 0, 1);
          const verticalHigh = 1 - normalizedY;
          const verticalLow = normalizedY;
          const localU = clamp((x - surface.xMin) / Math.max(1, span), 0, 1);
          const edgeBias = Math.abs(localU - 0.5) * 2;
          const islandBias = surface.kind === 'island' ? 1.05 : surface.kind === 'ground' ? 0.12 : 0.52;
          const narrowBias = clamp(1 - span / 1500, 0, 1);
          const distanceBias = clamp(horizontal, 0, 1);

          let score = distanceBias * 2.15 + islandBias + randomRange(this.random, 0, 0.30);
          if (preferredMode === 'high') score += verticalHigh * 2.15 + edgeBias * 0.52;
          else if (preferredMode === 'low') score += verticalLow * 1.85 + narrowBias * 0.35;
          else if (preferredMode === 'awkward') score += edgeBias * 1.28 + narrowBias * 0.80 + Math.abs(verticalHigh - 0.5) * 0.55;
          else if (preferredMode === 'island-edge') score += islandBias * 1.15 + edgeBias * 1.08 + narrowBias * 0.45;
          else score += distanceBias;

          if (archetype === ARCHETYPES.SKY && surface.kind !== 'island') score -= 1.0;
          if ((archetype === ARCHETYPES.CAVERN || archetype === ARCHETYPES.AQUA) && surface.kind === 'ground') score += verticalLow * 0.45;
          if (archetype === ARCHETYPES.GLACIER) score += narrowBias * 0.28 + verticalHigh * 0.22;
          if (difficulty > 0.72) score += edgeBias * 0.42 + narrowBias * 0.38;
          if (difficulty > 0.88 && surface.kind === 'island') score += 0.55;

          candidates.push({ surface, x, y, score, edgeBias, narrowBias, mode: preferredMode });
        }
      }

      candidates.sort((a, b) => b.score - a.score);
      const shortlist = candidates.slice(0, Math.min(7, candidates.length));
      if (shortlist.length) {
        const weightedIndex = Math.floor(Math.pow(this.random(), 2.25) * shortlist.length);
        return shortlist[Math.min(shortlist.length - 1, weightedIndex)];
      }

      const ground = topSurfaces.find((s) => s.kind === 'ground') || topSurfaces[0] || surfaces[0];
      const desired = tee.x < width * 0.5 ? safeMaxX : safeMinX;
      const x = clamp(desired, ground.xMin + surfaceClearance, ground.xMax - surfaceClearance);
      return { surface: ground, x, y: TerrainUtil.sampleSurface(ground, x), mode: 'safe-fallback' };
    }

    validateAndRepairHole(hole) {
      const safeMinX = CONFIG.generation.cupWorldInsetX;
      const safeMaxX = hole.width - CONFIG.generation.cupWorldInsetX;
      const safeMinY = CONFIG.generation.cupWorldInsetTop;
      const safeMaxY = hole.height - CONFIG.generation.cupWorldInsetBottom;
      const edge = CONFIG.generation.cupSurfaceEdgeClearance;
      let surface = TerrainUtil.findSurface(hole, hole.cup.surfaceId);
      let x = hole.cup.x;
      let y = hole.cup.y;
      const reachable = this.computeReachableSurfaceIds(hole.surfaces.filter((s) => s.side === 'top'), hole.tee);
      const invalid = !surface || !Number.isFinite(x) || !Number.isFinite(y)
        || x < safeMinX || x > safeMaxX || y < safeMinY || y > safeMaxY
        || x < (surface?.xMin ?? 0) + edge || x > (surface?.xMax ?? hole.width) - edge
        || Math.abs(TerrainUtil.surfaceSlope(surface, x)) > 0.36
        || !reachable.has(hole.cup.surfaceId);

      let repaired = false;
      if (invalid) {
        repaired = true;
        surface = hole.surfaces.find((s) => s.kind === 'ground' && s.side === 'top')
          || hole.surfaces.find((s) => s.side === 'top');
        const desired = hole.tee.x < hole.width * 0.5 ? safeMaxX : safeMinX;
        x = clamp(desired, surface.xMin + edge, surface.xMax - edge);
        y = TerrainUtil.sampleSurface(surface, x);
        if (y < safeMinY || y > safeMaxY || Math.abs(TerrainUtil.surfaceSlope(surface, x)) > 0.36) {
          let best = null;
          for (let sx = Math.max(surface.xMin + edge, safeMinX); sx <= Math.min(surface.xMax - edge, safeMaxX); sx += 40) {
            const sy = TerrainUtil.sampleSurface(surface, sx);
            const slope = Math.abs(TerrainUtil.surfaceSlope(surface, sx));
            if (!Number.isFinite(sy) || sy < safeMinY || sy > safeMaxY || slope > 0.36) continue;
            const score = Math.abs(sx - desired) + slope * 240;
            if (!best || score < best.score) best = { x: sx, y: sy, score };
          }
          if (best) { x = best.x; y = best.y; }
        }
        hole.cup.surfaceId = surface.id;
        hole.cup.x = x;
        hole.cup.y = y;
      }

      if (repaired) {
        hole.hazards = (hole.hazards || []).filter((hazard) => {
          if (hazard.surfaceId !== hole.cup.surfaceId) return true;
          const width = TerrainUtil.hazardWidth(hazard);
          return Math.abs((hazard.x ?? 0) - hole.cup.x) >= CONFIG.generation.safeRadiusCup + width * 0.5;
        });
        hole.decorations = (hole.decorations || []).filter((deco) => deco.surfaceId !== hole.cup.surfaceId || Math.abs(deco.x - hole.cup.x) >= 105);
        const portalCounts = new Map();
        for (const hazard of hole.hazards) if (hazard.type === 'portal') portalCounts.set(hazard.pairId, (portalCounts.get(hazard.pairId) || 0) + 1);
        hole.hazards = hole.hazards.filter((hazard) => hazard.type !== 'portal' || portalCounts.get(hazard.pairId) === 2);
        hole.par = this.computePar(hole.tee, hole.cup, hole.hazards, hole.archetype);
      }
      hole.holeX = hole.cup.x;
      hole.holeY = hole.cup.y;
      hole.cupSafety = {
        insetX: Math.min(hole.cup.x - hole.bounds.minX, hole.bounds.maxX - hole.cup.x),
        insetTop: hole.cup.y - hole.bounds.minY,
        insetBottom: hole.bounds.maxY - hole.cup.y,
      };
    }

    generateHazards(ctx) {
      const { width, height, difficulty, compactness, archetype, surfaces, tee, cup } = ctx;
      const hazards = [];
      const topSurfaces = surfaces.filter((s) => s.side === 'top');
      const ground = topSurfaces.find((s) => s.kind === 'ground');
      const density = lerp(0.76, 1.68, compactness);
      const lengthUnits = width / 1000;
      const hardBudget = Math.max(3, Math.round(lengthUnits * density));

      const hazardWidth = (hazard) => TerrainUtil.hazardWidth(hazard);
      const conflicts = (surfaceId, x, widthValue, padding = 20, includeSoft = false) => hazards.some((h) => {
        if (h.surfaceId !== surfaceId) return false;
        if (!includeSoft && !['water', 'booster', 'bumper', 'portal', 'fan', 'cannon', 'platform', 'moving-wall', 'spinner', 'secret-cave', 'gravity-well'].includes(h.type)) return false;
        return Math.abs(h.x - x) < (hazardWidth(h) + widthValue) * 0.5 + padding;
      });
      const safeFromEndpoints = (surface, x, widthValue) => {
        if (surface.id === tee.surfaceId && Math.abs(x - tee.x) < CONFIG.generation.safeRadiusTee + widthValue / 2) return false;
        if (surface.id === cup.surfaceId && Math.abs(x - cup.x) < CONFIG.generation.safeRadiusCup + widthValue / 2) return false;
        return true;
      };
      const findX = (surface, widthValue, padding = 24, includeSoft = false) => {
        const worldInset = 96;
        const min = Math.max(surface.xMin + widthValue / 2 + 30, worldInset + widthValue / 2);
        const max = Math.min(surface.xMax - widthValue / 2 - 30, width - worldInset - widthValue / 2);
        if (max <= min) return null;
        for (let attempt = 0; attempt < 120; attempt += 1) {
          const x = randomRange(this.random, min, max);
          if (!safeFromEndpoints(surface, x, widthValue)) continue;
          if (!conflicts(surface.id, x, widthValue, padding, includeSoft)) return x;
        }
        return null;
      };
      const chooseSurface = (allowGround = true) => {
        const candidates = topSurfaces.filter((s) => (allowGround || s.kind !== 'ground')).filter((s) => s.xMax - s.xMin > 260);
        return candidates.length ? pick(this.random, candidates) : ground;
      };
      const addZone = (type, count, minWidth, maxWidth, options = {}) => {
        for (let i = 0; i < count; i += 1) {
          const surface = options.groundOnly ? ground : chooseSurface(options.allowGround !== false);
          if (!surface) continue;
          const maxAllowed = Math.max(70, surface.xMax - surface.xMin - 100);
          let zoneWidth = Math.min(randomRange(this.random, minWidth, maxWidth), maxAllowed);
          if (options.allowLong && this.random() < options.allowLong) zoneWidth = Math.min(maxAllowed, zoneWidth * randomRange(this.random, 1.35, 1.95));
          const x = findX(surface, zoneWidth, options.padding ?? 22, options.includeSoft ?? false);
          if (x === null) continue;
          const y = TerrainUtil.sampleSurface(surface, x);
          hazards.push({ type, surfaceId: surface.id, x, y, width: zoneWidth, ...(options.extra ? options.extra(surface, x, y) : {}) });
        }
      };

      const waterCount = archetype === ARCHETYPES.SKY
        ? (this.random() < 0.42 ? 1 : 0)
        : Math.max(1, Math.round(hardBudget * (0.22 + difficulty * 0.08)));
      addZone('water', waterCount, 190 + compactness * 45, 360 + compactness * 110, {
        groundOnly: true, padding: 88,
        extra: (surface, x, y) => ({
          surfaceY: y,
          depth: randomRange(this.random, 68, 126),
        }),
      });
      this.shapeWaterBasins(hazards, surfaces);

      const boosterCount = Math.max(1, Math.round(hardBudget * 0.38));
      addZone('booster', boosterCount, 132, 245, {
        padding: 58,
        extra: (surface, x) => ({
          power: randomRange(this.random, 480, 860) * (0.90 + difficulty * 0.24),
          direction: Math.sign(cup.x - x) || 1,
        }),
      });

      const bumperCount = Math.max(2, Math.round(hardBudget * (0.56 + difficulty * 0.18)));
      for (let i = 0; i < bumperCount; i += 1) {
        const surface = chooseSurface(true);
        const radius = randomRange(this.random, 26, 48 + compactness * 8);
        const x = findX(surface, radius * 2, 40, false);
        if (x === null) continue;
        const surfaceY = TerrainUtil.sampleSurface(surface, x);
        hazards.push({
          type: 'bumper', surfaceId: surface.id, x,
          y: surfaceY - randomRange(this.random, 44, 122),
          radius,
          bounce: randomRange(this.random, 1.08, 1.34),
          hue: Math.floor(randomRange(this.random, 0, 3)),
        });
      }

      const sandCount = archetype === ARCHETYPES.GLACIER ? Math.max(1, Math.round(lengthUnits * density * 0.22)) : Math.max(2, Math.round(lengthUnits * density * 0.58));
      const roughCount = archetype === ARCHETYPES.GLACIER ? Math.max(1, Math.round(lengthUnits * density * 0.18)) : Math.max(2, Math.round(lengthUnits * density * 0.65));
      addZone('sand', sandCount, 220, 620, { includeSoft: true, padding: 20, allowLong: 0.78 });
      addZone('rough', roughCount, 260, 760, { includeSoft: true, padding: 16, allowLong: 0.82 });
      const iceCount = archetype === ARCHETYPES.GLACIER
        ? Math.min(CONFIG.generation.iceZonesMax, Math.max(2, Math.round(lengthUnits * 0.62)))
        : Math.min(CONFIG.generation.iceZonesMax, Math.max(1, Math.round(lengthUnits * density * 0.24)));
      addZone('ice', iceCount, archetype === ARCHETYPES.GLACIER ? 380 : 220, archetype === ARCHETYPES.GLACIER ? 1050 : 720, {
        includeSoft: true, padding: 16, allowLong: archetype === ARCHETYPES.GLACIER ? 0.88 : 0.48,
      });

      const fanCount = clamp(Math.round(hardBudget * 0.24), 0, CONFIG.generation.fanZonesMax);
      for (let i = 0; i < fanCount; i += 1) {
        const surface = chooseSurface(true);
        if (!surface) continue;
        const widthValue = randomRange(this.random, 90, 140);
        const x = findX(surface, widthValue, 64, false);
        if (x === null) continue;
        const y = TerrainUtil.sampleSurface(surface, x) - randomRange(this.random, 48, 90);
        const dir = Math.sign(cup.x - x) || 1;
        const angle = dir > 0 ? randomRange(this.random, -0.95, -0.12) : randomRange(this.random, Math.PI + 0.12, Math.PI + 0.95);
        hazards.push({
          type: 'fan', surfaceId: surface.id, x, y, width: widthValue,
          range: randomRange(this.random, 180, 320),
          fieldHeight: randomRange(this.random, 120, 220),
          angle,
          force: randomRange(this.random, 520, 820),
        });
      }

      const portalPairs = clamp(Math.round((hardBudget - 1) * 0.14), 0, CONFIG.generation.portalPairsMax);
      for (let pairIndex = 0; pairIndex < portalPairs; pairIndex += 1) {
        const aSurface = chooseSurface(true);
        const bSurface = chooseSurface(true);
        if (!aSurface || !bSurface) continue;
        const radius = randomRange(this.random, 18, 24);
        const aX = findX(aSurface, radius * 2.4, 80, false);
        const bX = findX(bSurface, radius * 2.4, 80, false);
        if (aX === null || bX === null || Math.abs(aX - bX) < Math.max(680, width * 0.18)) continue;
        const forward = Math.sign(cup.x - tee.x) || 1;
        const aProgress = (aX - tee.x) * forward;
        const bProgress = (bX - tee.x) * forward;
        const entrySurface = aProgress <= bProgress ? aSurface : bSurface;
        const exitSurface = aProgress <= bProgress ? bSurface : aSurface;
        const entryX = aProgress <= bProgress ? aX : bX;
        const exitX = aProgress <= bProgress ? bX : aX;
        if ((exitX - entryX) * forward < Math.max(620, width * 0.14)) continue;
        const pairId = `portal-${this.portalPairCounter++}`;
        const entryY = TerrainUtil.sampleSurface(entrySurface, entryX) - (CONFIG.ball.radius + 3);
        const exitY = TerrainUtil.sampleSurface(exitSurface, exitX) - (CONFIG.ball.radius + 3);
        const exitHeading = forward > 0 ? 0 : Math.PI;
        hazards.push({
          type: 'portal', pairId, portalIndex: 0, portalRole: 'entry', entryEnabled: true,
          surfaceId: entrySurface.id, x: entryX, y: entryY, radius, heading: exitHeading, consumed: false,
        });
        hazards.push({
          type: 'portal', pairId, portalIndex: 1, portalRole: 'exit', entryEnabled: false,
          surfaceId: exitSurface.id, x: exitX, y: exitY, radius, heading: exitHeading, consumed: false,
        });
      }

      const gaps = this.findPlayableGaps(topSurfaces, tee, cup);
      const platformCount = Math.min(CONFIG.generation.movingPlatformsMax, gaps.length ? Math.min(gaps.length, 1 + Math.floor(this.random() * 2)) : 0);
      for (let i = 0; i < platformCount; i += 1) {
        const gap = gaps[i % gaps.length];
        if (!gap) continue;
        const gapWidth = gap.right.xMin - gap.left.xMax;
        const widthValue = clamp(gapWidth * randomRange(this.random, 0.36, 0.58), 120, 260);
        const baseX = (gap.left.xMax + gap.right.xMin) * 0.5;
        const edgeY = Math.min(TerrainUtil.sampleSurface(gap.left, gap.left.xMax - 8), TerrainUtil.sampleSurface(gap.right, gap.right.xMin + 8));
        const baseY = edgeY - randomRange(this.random, 36, 120);
        hazards.push({
          type: 'platform', surfaceId: null, x: baseX, y: baseY, baseX, baseY,
          width: widthValue, thickness: 18,
          axis: this.random() < 0.56 ? 'y' : 'x',
          amplitude: randomRange(this.random, 52, 138),
          period: randomRange(this.random, 2.8, 4.8),
          phase: this.random() * Math.PI * 2,
        });
      }

      const movingWallCount = clamp(Math.round(difficulty * 1.8 + hardBudget * 0.06), 0, CONFIG.generation.movingWallsMax);
      for (let i = 0; i < movingWallCount; i += 1) {
        const surface = chooseSurface(true);
        if (!surface) continue;
        const wallWidth = randomRange(this.random, 28, 46);
        const wallHeight = randomRange(this.random, 150, 330);
        const x = findX(surface, wallWidth + 54, 92, false);
        if (x === null) continue;
        const surfaceY = TerrainUtil.sampleSurface(surface, x);
        const amplitude = randomRange(this.random, 70, Math.min(190, wallHeight * 0.72));
        const rawBaseY = surfaceY - wallHeight * 0.5 - 18;
        const minBaseY = wallHeight * 0.5 + amplitude + 54;
        const maxBaseY = height - wallHeight * 0.5 - amplitude - 54;
        if (maxBaseY <= minBaseY) continue;
        const baseY = clamp(rawBaseY, minBaseY, maxBaseY);
        hazards.push({
          type: 'moving-wall', surfaceId: surface.id, x, y: baseY,
          baseX: x, baseY,
          width: wallWidth, height: wallHeight, amplitude,
          period: randomRange(this.random, 2.4, 4.8), phase: this.random() * Math.PI * 2,
          bounce: randomRange(this.random, 0.58, 0.78),
        });
      }

      const spinnerCount = clamp(Math.round(difficulty * 1.65 + hardBudget * 0.05), 0, CONFIG.generation.spinnersMax);
      for (let i = 0; i < spinnerCount; i += 1) {
        const surface = chooseSurface(true);
        if (!surface) continue;
        const span = randomRange(this.random, 92, 172);
        const thickness = randomRange(this.random, 15, 24);
        const x = findX(surface, span * 2 + 30, 105, false);
        if (x === null) continue;
        const surfaceY = TerrainUtil.sampleSurface(surface, x);
        const rawCenterY = surfaceY - randomRange(this.random, 88, 155);
        const minCenterY = span + thickness + 48;
        const maxCenterY = height - span - thickness - 48;
        if (maxCenterY <= minCenterY) continue;
        const centerY = clamp(rawCenterY, minCenterY, maxCenterY);
        hazards.push({
          type: 'spinner', surfaceId: surface.id, x, y: centerY,
          armLength: span, thickness,
          period: randomRange(this.random, 2.0, 4.3),
          phase: this.random() * Math.PI * 2,
          spin: this.random() < 0.5 ? -1 : 1,
          bounce: randomRange(this.random, 0.72, 0.94),
        });
      }

      const cannonCount = clamp(Math.round(difficulty * 1.2), 0, CONFIG.generation.cannonMax);
      for (let i = 0; i < cannonCount; i += 1) {
        const surface = chooseSurface(true);
        if (!surface) continue;
        const widthValue = 92;
        const x = findX(surface, widthValue, 90, false);
        if (x === null) continue;
        const y = TerrainUtil.sampleSurface(surface, x) - 8;
        const dir = Math.sign(cup.x - x) || 1;
        const angle = dir > 0 ? randomRange(this.random, -1.0, -0.38) : randomRange(this.random, Math.PI + 0.38, Math.PI + 1.0);
        hazards.push({
          type: 'cannon', surfaceId: surface.id, x, y, width: widthValue,
          angle,
          power: randomRange(this.random, 760, 1060),
        });
      }




      // Pozos de gravedad: alteran el arco en el aire. Pueden atraer o repeler,
      // pero siempre se telegraphan visualmente y nunca se colocan sobre tee/copa.
      const wellCount = clamp(Math.round(hardBudget * 0.10 + difficulty * 0.8), 0, CONFIG.generation.gravityWellsMax);
      for (let i = 0; i < wellCount; i += 1) {
        const surface = chooseSurface(true);
        if (!surface) continue;
        const radius = randomRange(this.random, 105, 178);
        const x = findX(surface, radius * 1.15, 95, false);
        if (x === null) continue;
        const baseY = TerrainUtil.sampleSurface(surface, x);
        const y = baseY - randomRange(this.random, 150, 310);
        hazards.push({
          type: 'gravity-well', surfaceId: surface.id, x, y, radius,
          strength: randomRange(this.random, 460, 780) * (this.random() < 0.24 ? -1 : 1),
          spin: this.random() < 0.5 ? -1 : 1,
        });
      }

      // Cuevas secretas: al tocar la entrada, la bola entra en un túnel oculto,
      // el túnel se revela y reaparece por una salida segura conservando impulso.
      const caveCount = clamp(Math.round(difficulty * 1.35 + (width > 7600 ? 0.7 : 0)), 0, CONFIG.generation.secretCavesMax);
      for (let i = 0; i < caveCount; i += 1) {
        const entranceSurface = ground;
        const exitSurface = ground;
        if (!entranceSurface || !exitSurface) continue;
        const entranceRadius = randomRange(this.random, 28, 38);
        const entranceX = findX(entranceSurface, entranceRadius * 2.4, 120, false);
        const exitX = findX(exitSurface, entranceRadius * 2.4, 120, false);
        if (entranceX === null || exitX === null) continue;
        if (Math.abs(exitX - entranceX) < 620) continue;
        const entranceSurfaceY = TerrainUtil.sampleSurface(entranceSurface, entranceX);
        const exitSurfaceY = TerrainUtil.sampleSurface(exitSurface, exitX);
        const caveSpan = Math.abs(exitX - entranceX);
        // La profundidad crece con la distancia para que el túnel revelado sea una ruta
        // arqueada legible y no una simple línea oscura casi horizontal bajo el terreno.
        const routeDepth = clamp(randomRange(this.random, 220, 380) + caveSpan * 0.055, 260, 620);
        const controlX = (entranceX + exitX) * 0.5 + randomRange(this.random, -Math.min(220, caveSpan * 0.08), Math.min(220, caveSpan * 0.08));
        const controlY = Math.max(entranceSurfaceY, exitSurfaceY) + routeDepth;
        hazards.push({
          type: 'secret-cave', caveId: `secret-cave-${this.secretCaveCounter++}`, surfaceId: entranceSurface.id,
          entranceSurfaceId: entranceSurface.id, exitSurfaceId: exitSurface.id,
          x: entranceX, y: entranceSurfaceY - 4,
          entranceX, entranceY: entranceSurfaceY - 3,
          exitX, exitY: exitSurfaceY - 3,
          entranceRadius, controlX, controlY,
          duration: randomRange(this.random, 0.72, 1.18),
          exitPower: randomRange(this.random, 320, 560),
          discovered: false,
        });
      }

      this.generateCupGauntlet({ hazards, topSurfaces, tee, cup, difficulty, archetype });

      hazards.sort((a, b) => a.x - b.x || String(a.type).localeCompare(String(b.type)));
      return hazards;
    }

    generateCupGauntlet({ hazards, topSurfaces, tee, cup, difficulty, archetype }) {
      const cupSurface = topSurfaces.find((surface) => surface.id === cup.surfaceId);
      if (!cupSurface) return;
      const towardTee = Math.sign(tee.x - cup.x) || -1;
      const span = cupSurface.xMax - cupSurface.xMin;
      if (span < 260) return;

      const occupied = (x, width, hardOnly = false) => hazards.some((hazard) => {
        if (hazard.surfaceId !== cupSurface.id) return false;
        if (hardOnly && !['water', 'booster', 'bumper', 'fan', 'cannon', 'portal', 'moving-wall', 'spinner', 'secret-cave'].includes(hazard.type)) return false;
        return Math.abs((hazard.x ?? 0) - x) < (TerrainUtil.hazardWidth(hazard) + width) * 0.5 + 24;
      });
      const validX = (x, width) => x - width / 2 > cupSurface.xMin + 20
        && x + width / 2 < cupSurface.xMax - 20
        && Math.abs(x - cup.x) > CONFIG.generation.safeRadiusCup + width * 0.25;
      let placedApproach = false;

      // Una franja de control antes de la copa. Se integra con la superficie, no bloquea el hoyo.
      if (difficulty > 0.42) {
        const width = clamp(260 + difficulty * 330, 280, Math.min(640, span * 0.48));
        const x = cup.x + towardTee * (CONFIG.generation.safeRadiusCup + width * 0.58 + randomRange(this.random, 30, 120));
        if (validX(x, width) && !occupied(x, width, false)) {
          const type = this.random() < 0.56 ? 'sand' : 'rough';
          hazards.push({ type, surfaceId: cupSurface.id, x, y: TerrainUtil.sampleSurface(cupSurface, x), width, approachHazard: true });
          placedApproach = true;
        }
      }

      // Bumper técnico: obliga a controlar altura/velocidad del último tiro.
      if (difficulty > 0.57) {
        const radius = randomRange(this.random, 30, 44);
        const x = cup.x + towardTee * randomRange(this.random, 255, 430);
        if (validX(x, radius * 2) && !occupied(x, radius * 2, true)) {
          const surfaceY = TerrainUtil.sampleSurface(cupSurface, x);
          hazards.push({
            type: 'bumper', surfaceId: cupSurface.id, x,
            y: surfaceY - randomRange(this.random, 58, 108),
            radius, bounce: randomRange(this.random, 1.10, 1.28), hue: 2, approachHazard: true,
          });
          placedApproach = true;
        }
      }

      // En hoyos difíciles puede haber viento local contrario a la copa.
      if (difficulty > 0.70 && this.random() < 0.78) {
        const width = 108;
        const x = cup.x + towardTee * randomRange(this.random, 390, 690);
        if (validX(x, width) && !occupied(x, width, true)) {
          const surfaceY = TerrainUtil.sampleSurface(cupSurface, x);
          const angle = towardTee > 0 ? randomRange(this.random, -0.20, 0.08) : randomRange(this.random, Math.PI - 0.08, Math.PI + 0.20);
          hazards.push({
            type: 'fan', surfaceId: cupSurface.id, x, y: surfaceY - randomRange(this.random, 58, 90),
            width, range: randomRange(this.random, 230, 360), fieldHeight: randomRange(this.random, 135, 210),
            angle, force: randomRange(this.random, 470, 690), approachHazard: true,
          });
          placedApproach = true;
        }
      }

      // Un acelerador trampa solo aparece en dificultad alta y apunta claramente lejos del hoyo.
      if (difficulty > 0.84 && this.random() < 0.42 && archetype !== ARCHETYPES.AQUA) {
        const width = randomRange(this.random, 130, 190);
        const x = cup.x + towardTee * randomRange(this.random, 210, 340);
        if (validX(x, width) && !occupied(x, width, true)) {
          hazards.push({
            type: 'booster', surfaceId: cupSurface.id, x, y: TerrainUtil.sampleSurface(cupSurface, x), width,
            power: randomRange(this.random, 440, 650), direction: towardTee, approachHazard: true, trapBooster: true,
          });
          placedApproach = true;
        }
      }

      // Guarda de diseño: en hoyos claramente difíciles intentamos conservar al menos
      // una decisión técnica cerca de la copa. Es una zona de superficie pequeña, nunca
      // se fuerza encima de un sólido ni invade el radio seguro de embocadura.
      if (!placedApproach && difficulty > 0.62) {
        const width = clamp(165 + difficulty * 85, 180, Math.min(245, span * 0.30));
        const offsets = [
          CONFIG.generation.safeRadiusCup + width * 0.64 + 44,
          CONFIG.generation.safeRadiusCup + width * 0.82 + 96,
        ];
        for (const offset of offsets) {
          const x = cup.x + towardTee * offset;
          if (!validX(x, width) || occupied(x, width, false)) continue;
          const type = archetype === ARCHETYPES.GLACIER ? 'ice' : (this.random() < 0.52 ? 'rough' : 'sand');
          hazards.push({
            type, surfaceId: cupSurface.id, x,
            y: TerrainUtil.sampleSurface(cupSurface, x), width,
            approachHazard: true, fallbackApproach: true,
          });
          placedApproach = true;
          break;
        }
      }
    }

    placeScoreMultiplier(hole) {
      if (!hole) return null;
      hole.hazards = hole.hazards.filter((hazard) => hazard.type !== 'multiplier');
      hole.scoreMultiplierCollected = false;
      const topSurfaces = hole.surfaces.filter((surface) => surface.side === 'top');
      const candidates = [];

      const blockingTypes = new Set(['water', 'bumper', 'fan', 'portal', 'cannon', 'gravity-well', 'platform', 'moving-wall', 'spinner']);
      const blockedByPhysicalHazard = (x, y, surfaceId) => hole.hazards.some((hazard) => {
        if (!blockingTypes.has(hazard.type)) return false;
        if (hazard.surfaceId && surfaceId && hazard.surfaceId !== surfaceId && hazard.type !== 'platform') return false;
        const hx = Number.isFinite(hazard.x) ? hazard.x : (Number.isFinite(hazard.baseX) ? hazard.baseX : x);
        const hy = Number.isFinite(hazard.y) ? hazard.y : (Number.isFinite(hazard.baseY) ? hazard.baseY : y);
        if (hazard.type === 'water') return Math.abs(hx - x) <= (hazard.width || 0) * 0.5 + 42;
        if (hazard.type === 'platform' || hazard.type === 'moving-wall') {
          return Math.abs(hx - x) <= (hazard.width || 0) * 0.5 + 34
            && Math.abs(hy - y) <= ((hazard.height || hazard.thickness || 24) * 0.5) + 56;
        }
        const radius = hazard.type === 'spinner'
          ? (hazard.armLength || 0) + (hazard.thickness || 0) * 0.5
          : Math.max(hazard.radius || 0, (hazard.width || 0) * 0.5, 34);
        return Math.hypot(hx - x, hy - y) <= radius + 38;
      });

      const secretCaves = hole.hazards.filter((hazard) => hazard.type === 'secret-cave');
      for (const cave of secretCaves) {
        const surface = topSurfaces.find((item) => item.id === cave.exitSurfaceId);
        if (!surface) continue;
        const direction = Math.sign(cave.exitX - cave.entranceX) || 1;
        const x = clamp(cave.exitX + direction * randomRange(this.random, 45, 120), surface.xMin + 48, surface.xMax - 48);
        const y = TerrainUtil.sampleSurface(surface, x);
        if (Number.isFinite(y) && !blockedByPhysicalHazard(x, y - 26, surface.id)) candidates.push({ surface, x, y, score: 5.5, secret: true });
      }

      for (const surface of topSurfaces) {
        const span = surface.xMax - surface.xMin;
        if (span < 220) continue;
        const samples = Math.max(3, Math.floor(span / 220));
        for (let i = 0; i <= samples; i += 1) {
          const x = lerp(surface.xMin + 55, surface.xMax - 55, i / Math.max(1, samples));
          const y = TerrainUtil.sampleSurface(surface, x);
          if (!Number.isFinite(y)) continue;
          if (Math.abs(x - hole.tee.x) < 520 || Math.abs(x - hole.cup.x) < 330) continue;
          if (blockedByPhysicalHazard(x, y - 26, surface.id)) continue;
          const nearHard = hole.hazards.filter((hazard) => {
            if (!['water', 'bumper', 'fan', 'portal', 'cannon', 'gravity-well', 'platform', 'moving-wall', 'spinner'].includes(hazard.type)) return false;
            return Math.hypot((hazard.x ?? x) - x, (hazard.y ?? y) - y) < 440;
          }).length;
          const verticalExtreme = Math.abs((y / Math.max(1, hole.height)) - 0.5) * 2;
          const edgeBias = Math.abs(((x - surface.xMin) / Math.max(1, span)) - 0.5) * 2;
          const islandBonus = surface.kind === 'island' ? 1.15 : 0;
          const score = islandBonus + verticalExtreme * 1.1 + edgeBias * 0.65 + nearHard * 0.28 + randomRange(this.random, 0, 0.3);
          candidates.push({ surface, x, y, score, secret: false });
        }
      }

      if (!candidates.length) return null;
      candidates.sort((a, b) => b.score - a.score);
      const choice = candidates[0];
      const multiplier = {
        type: 'multiplier', surfaceId: choice.surface.id,
        x: choice.x, y: choice.y - 26, radius: 16,
        multiplier: CONFIG.gameplay.scoreMultiplier,
        collected: false, hiddenReward: !!choice.secret,
      };
      hole.hazards.push(multiplier);
      hole.hazards.sort((a, b) => (a.x ?? 0) - (b.x ?? 0) || String(a.type).localeCompare(String(b.type)));
      return multiplier;
    }

    findPlayableGaps(topSurfaces, tee, cup) {
      const list = [...topSurfaces].sort((a, b) => a.xMin - b.xMin);
      const gaps = [];
      for (let i = 0; i < list.length - 1; i += 1) {
        const left = list[i];
        const right = list[i + 1];
        const gap = right.xMin - left.xMax;
        if (gap < 180 || gap > 760) continue;
        const mid = (left.xMax + right.xMin) * 0.5;
        if (Math.abs(mid - tee.x) < 380 || Math.abs(mid - cup.x) < 360) continue;
        gaps.push({ left, right, gap });
      }
      return gaps;
    }

    shapeWaterBasins(hazards, surfaces) {
      for (const water of hazards) {
        if (water.type !== 'water') continue;
        const surface = surfaces.find((s) => s.id === water.surfaceId);
        if (!surface || surface.kind !== 'ground' || surface.side !== 'top') continue;
        const waterX0 = water.x - water.width / 2;
        const waterX1 = water.x + water.width / 2;
        const bankWidth = clamp(water.width * 0.24, 52, 92);
        const basinX0 = Math.max(surface.xMin, waterX0 - bankWidth);
        const basinX1 = Math.min(surface.xMax, waterX1 + bankWidth);
        for (const edgeX of [basinX0, waterX0, water.x, waterX1, basinX1]) this.ensureSurfacePoint(surface, edgeX);
        const leftBankY = TerrainUtil.sampleSurface(surface, waterX0);
        const rightBankY = TerrainUtil.sampleSurface(surface, waterX1);
        const centerY = TerrainUtil.sampleSurface(surface, water.x);
        const waterY = Math.max(leftBankY, rightBankY, centerY) + 5;
        const depth = clamp(water.depth, 54, 122);
        for (const point of surface.points) {
          if (point.x <= basinX0 || point.x >= basinX1) continue;
          let target = point.y;
          if (point.x < waterX0) {
            const t = smoothstep(clamp((point.x - basinX0) / Math.max(1, waterX0 - basinX0), 0, 1));
            target = lerp(point.y, waterY, t);
          } else if (point.x > waterX1) {
            const t = smoothstep(clamp((basinX1 - point.x) / Math.max(1, basinX1 - waterX1), 0, 1));
            target = lerp(point.y, waterY, t);
          } else {
            const t = clamp((point.x - waterX0) / Math.max(1, waterX1 - waterX0), 0, 1);
            const bowl = Math.pow(Math.max(0, Math.sin(t * Math.PI)), 0.72);
            const rippleFloor = Math.sin(point.x * 0.037 + water.x * 0.011) * 3.5;
            target = waterY + depth * bowl + rippleFloor * bowl;
          }
          point.y = Math.max(point.y, target);
        }
        water.surfaceY = waterY;
        water.depth = depth;
        water.bankWidth = bankWidth;
        water.basinX0 = basinX0;
        water.basinX1 = basinX1;
        water.y = waterY;
      }
    }

    ensureSurfacePoint(surface, x) {
      if (!surface?.points?.length || x <= surface.xMin || x >= surface.xMax) return;
      const epsilon = 0.001;
      if (surface.points.some((p) => Math.abs(p.x - x) <= epsilon)) return;
      const y = TerrainUtil.sampleSurface(surface, x);
      if (!Number.isFinite(y)) return;
      let index = surface.points.findIndex((p) => p.x > x);
      if (index < 0) index = surface.points.length;
      surface.points.splice(index, 0, { x, y });
    }

    buildSolidWalls(surfaces) {
      const walls = [];
      const tops = surfaces.filter((s) => s.kind === 'island' && s.side === 'top');
      for (const top of tops) {
        const under = surfaces.find((s) => s.kind === 'island-under' && s.parentId === top.id);
        if (!under || !top.points.length || !under.points.length) continue;
        const tl = top.points[0];
        const tr = top.points[top.points.length - 1];
        const ul = under.points[0];
        const ur = under.points[under.points.length - 1];
        walls.push({ id: `${top.id}-wall-left`, kind: 'island-side', parentId: top.id, x1: tl.x, y1: tl.y, x2: ul.x, y2: ul.y, bounce: CONFIG.ball.groundBounce });
        walls.push({ id: `${top.id}-wall-right`, kind: 'island-side', parentId: top.id, x1: tr.x, y1: tr.y, x2: ur.x, y2: ur.y, bounce: CONFIG.ball.groundBounce });
      }
      const roofCapY = -CONFIG.course.topFlightMargin - 360;
      for (const roof of surfaces) {
        if (roof.kind !== 'roof' || roof.side !== 'bottom' || !roof.points.length) continue;
        const left = roof.points[0];
        const right = roof.points[roof.points.length - 1];
        walls.push({ id: `${roof.id}-wall-left`, kind: 'roof-side', parentId: roof.id, x1: left.x, y1: roofCapY, x2: left.x, y2: left.y, bounce: CONFIG.ball.roofBounce });
        walls.push({ id: `${roof.id}-wall-right`, kind: 'roof-side', parentId: roof.id, x1: right.x, y1: roofCapY, x2: right.x, y2: right.y, bounce: CONFIG.ball.roofBounce });
      }
      return walls;
    }

    generateDecorations(ctx) {
      const { width, archetype, surfaces, hazards, tee, cup } = ctx;
      const out = [];
      const topSurfaces = surfaces.filter((s) => s.side === 'top');
      const count = Math.min(110, Math.round(width / 85));
      for (let i = 0; i < count; i += 1) {
        const surface = pick(this.random, topSurfaces);
        if (!surface || surface.xMax - surface.xMin < 100) continue;
        const x = randomRange(this.random, surface.xMin + 20, surface.xMax - 20);
        if ((surface.id === tee.surfaceId && Math.abs(x - tee.x) < 90) || (surface.id === cup.surfaceId && Math.abs(x - cup.x) < 95)) continue;
        if (hazards.some((h) => h.surfaceId === surface.id && Math.abs(h.x - x) < TerrainUtil.hazardWidth(h) * 0.55 + 14)) continue;
        const y = TerrainUtil.sampleSurface(surface, x);
        let type = 'grass';
        if (archetype === ARCHETYPES.AQUA) type = this.random() < 0.52 ? 'coral' : 'crystal';
        else if (archetype === ARCHETYPES.GLACIER) type = this.random() < 0.62 ? 'ice-crystal' : 'snow-tuft';
        else if (archetype === ARCHETYPES.CAVERN) type = this.random() < 0.42 ? 'crystal' : 'rock';
        else if (surface.kind === 'island') type = this.random() < 0.30 ? 'flower' : this.random() < 0.18 ? 'shrub' : 'grass';
        else type = this.random() < 0.14 ? 'flower' : this.random() < 0.20 ? 'rock' : this.random() < 0.16 ? 'shrub' : 'grass';
        out.push({ type, surfaceId: surface.id, x, y, scale: randomRange(this.random, 0.65, 1.35), phase: this.random() * Math.PI * 2 });
      }
      return out;
    }

    computePar(tee, cup, hazards, archetype) {
      const dx = cup.x - tee.x;
      const dy = cup.y - tee.y;
      const meters = Math.hypot(dx, dy) * CONFIG.course.metersPerPixel;
      let par = meters < 145 ? 3 : meters < 245 ? 4 : meters < 360 ? 5 : 6;
      const hardHazards = hazards.filter((h) => ['water', 'bumper', 'fan', 'portal', 'cannon', 'platform', 'moving-wall', 'spinner', 'secret-cave', 'gravity-well'].includes(h.type)).length;
      if (hardHazards >= 6 && par < 6) par += 1;
      if ((archetype === ARCHETYPES.SKY || archetype === ARCHETYPES.CAVERN || archetype === ARCHETYPES.AQUA || archetype === ARCHETYPES.GLACIER) && par < 6) par += 1;
      return clamp(par, 3, 7);
    }

    makeSurface(name, kind, points, side, material, extra = {}) {
      const id = `${name}-${this.surfaceCounter++}`;
      return { id, name, kind, side, material, points, xMin: points[0].x, xMax: points[points.length - 1].x, ...extra };
    }

    flattenAround(points, centerX, targetY, radius, strength = 1) {
      for (const point of points) {
        const d = Math.abs(point.x - centerX);
        if (d >= radius) continue;
        const t = smoothstep(1 - d / radius) * strength;
        point.y = lerp(point.y, targetY, t);
      }
    }

    limitSlopes(points, maxSlope) {
      if (!points || points.length < 2) return;
      for (let pass = 0; pass < 3; pass += 1) {
        for (let i = 1; i < points.length; i += 1) {
          const a = points[i - 1];
          const b = points[i];
          const maxDelta = Math.abs(b.x - a.x) * maxSlope;
          b.y = clamp(b.y, a.y - maxDelta, a.y + maxDelta);
        }
        for (let i = points.length - 2; i >= 0; i -= 1) {
          const a = points[i + 1];
          const b = points[i];
          const maxDelta = Math.abs(b.x - a.x) * maxSlope;
          b.y = clamp(b.y, a.y - maxDelta, a.y + maxDelta);
        }
      }
    }

    mirrorHole(hole) {
      const width = hole.width;
      const mirrorX = (x) => width - x;
      for (const surface of hole.surfaces) {
        surface.points = surface.points.map((p) => ({ x: mirrorX(p.x), y: p.y })).reverse();
        surface.xMin = surface.points[0].x;
        surface.xMax = surface.points[surface.points.length - 1].x;
      }
      for (const wall of hole.solidWalls) {
        wall.x1 = mirrorX(wall.x1);
        wall.x2 = mirrorX(wall.x2);
      }
      for (const hazard of hole.hazards) {
        hazard.x = mirrorX(hazard.x);
        if (Number.isFinite(hazard.baseX)) hazard.baseX = mirrorX(hazard.baseX);
        if (Number.isFinite(hazard.entranceX)) hazard.entranceX = mirrorX(hazard.entranceX);
        if (Number.isFinite(hazard.exitX)) hazard.exitX = mirrorX(hazard.exitX);
        if (Number.isFinite(hazard.controlX)) hazard.controlX = mirrorX(hazard.controlX);
        if (Number.isFinite(hazard.basinX0) && Number.isFinite(hazard.basinX1)) {
          const old0 = hazard.basinX0;
          const old1 = hazard.basinX1;
          hazard.basinX0 = mirrorX(old1);
          hazard.basinX1 = mirrorX(old0);
        }
        if (Number.isFinite(hazard.direction)) hazard.direction *= -1;
        if (Number.isFinite(hazard.angle)) hazard.angle = Math.PI - hazard.angle;
        if (Number.isFinite(hazard.heading)) hazard.heading = Math.PI - hazard.heading;
        if (hazard.type === 'spinner' && Number.isFinite(hazard.phase)) {
          hazard.phase = Math.PI - hazard.phase;
          hazard.spin = -(hazard.spin || 1);
        }
      }
      for (const deco of hole.decorations) deco.x = mirrorX(deco.x);
      hole.tee.x = mirrorX(hole.tee.x);
      hole.cup.x = mirrorX(hole.cup.x);
      hole.teeX = hole.tee.x;
      hole.holeX = hole.cup.x;
      hole.windBase.angle = Math.PI - hole.windBase.angle;
    }
  }

  NG.TerrainGenerator = TerrainGenerator;
  NG.TerrainUtil = TerrainUtil;
  NG.ARCHETYPES = ARCHETYPES;
  NG.THEMES = THEMES;
}(window.NoiseGolf = window.NoiseGolf || {}));
