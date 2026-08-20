#!/usr/bin/env node
'use strict';

/**
 * Imprime la transcripción que produciría la cabina en una partida simulada.
 * No valida nada: sirve para escuchar con los ojos y calibrar tono y ritmo.
 *
 *   node announcer/tools/preview_transcript.js battle
 *   node announcer/tools/preview_transcript.js turn
 *   node announcer/tools/preview_transcript.js offline
 *
 * El reloj es simulado, así que los enfriamientos, cooldowns y ventanas de
 * apuesta se comportan igual que en una partida real de la misma duración.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..');
const MODE = (process.argv[2] || 'battle').toLowerCase();

let clock = Date.UTC(2026, 0, 1, 12, 0, 0);
const realNow = Date.now;
Date.now = () => clock;
const advance = (ms) => { clock += ms; };

global.window = global;
global.window.NoiseGolf = {
  CONFIG: { course: { metersPerPixel: 1 / 18 } },
  TerrainUtil: { waterAt: () => null },
};
global.CustomEvent = class CustomEvent { constructor(type, init = {}) { this.type = type; this.detail = init.detail; } };
global.window.dispatchEvent = () => {};
global.window.addEventListener = () => {};
global.window.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
global.window.setInterval = () => 0;
global.window.clearInterval = () => {};
// El reloj es simulado: los temporizadores se encolan y se vacían tras cada paso
// del guion, en orden de retardo, para reproducir el orden real sin esperar.
let timerId = 0;
const pendingTimers = new Map();
global.window.setTimeout = (fn, delay = 0) => { timerId += 1; pendingTimers.set(timerId, { fn, delay }); return timerId; };
global.window.clearTimeout = (id) => { pendingTimers.delete(id); };
global.flushTimers = () => {
  for (let pass = 0; pass < 6 && pendingTimers.size; pass += 1) {
    const batch = [...pendingTimers.entries()].sort((a, b) => a[1].delay - b[1].delay);
    for (const [id, entry] of batch) {
      pendingTimers.delete(id);
      try { entry.fn(); } catch (error) { console.error('[timer]', error.message); }
    }
  }
};
global.fetch = () => Promise.reject(new Error('sin red'));

for (const rel of ['announcer/config-data.js', 'announcer/persona-data.js', 'announcer/map-intro-data.js',
  'announcer/rivalry-data.js', 'announcer/engine.js', 'announcer/manager.js']) {
  vm.runInThisContext(fs.readFileSync(path.join(ROOT, rel), 'utf8'), { filename: rel });
}

const NG = window.NoiseGolf;
const NAMES = { commentator: 'RAFA ', informant: 'ÁLEX ' };

const roster = [
  { playerKey: 'p1', username: 'Kly', points: 0 },
  { playerKey: 'p2', username: 'Nina', points: 0 },
  { playerKey: 'p3', username: 'Bruno', points: 0 },
  { playerKey: 'p4', username: 'Oto', points: 0 },
].map((p) => ({
  ...p, strokes: 0, role: 'player', connected: true, turnsUsed: 0, finished: false, progress: 0.2, turn: false,
  ball: { x: 200, y: 900, vx: 0, vy: 0, moving: false, holed: false, onSurface: true, lastSurfaceId: 's1' },
}));

function session(mode) {
  const map = new Map();
  for (const p of roster) map.set(p.playerKey, p);
  return {
    role: 'host', netTime: 0, courseRound: 0, settings: { mode, maxTurnsPerWorld: 6 }, players: map,
    on() { return () => {}; },
    getStatus() { return { online: true, mode }; },
    anyBallRolling() { return false; },
    broadcastAnnouncerBundle() { return true; },
    getStandings() {
      return [...map.values()].sort((a, b) => b.points - a.points || a.strokes - b.strokes).map((p, index) => ({
        rank: index + 1, playerKey: p.playerKey, username: p.username, points: p.points, strokes: p.strokes,
        turnsUsed: p.turnsUsed, role: 'player', connected: true, finished: p.finished, timedOut: false,
        finishReason: '', finishOrder: p.finished ? 1 : 0, progress: p.progress, turn: p.turn, local: index === 0,
      }));
    },
  };
}

// Guion de partida: [dtMs, eventKey, playerIndex, extraPayload]
const SCRIPT = [
  [0, 'AIMING', 0, { power: 0.5 }],
  [900, 'SHOT_TAKEN', 0, { power: 0.72 }],
  [1400, 'BOUNCE', 0, {}],
  [800, 'NEAR_MISS', 0, { distanceMeters: 1.4 }],
  [3200, 'RISKY_AIM', 1, { power: 0.93 }],
  [1100, 'SHOT_STRONG', 1, { power: 0.9 }],
  [700, 'BOOSTER', 1, {}],
  [900, 'WATER', 1, { strokes: 3 }],
  [2600, 'SHOT_TAKEN', 2, { power: 0.4 }],
  [1200, 'PLAYER_COLLISION', 2, { opponent: 0, attacker: 2, victim: 0 }],
  [1800, 'PLAYER_COLLISION', 0, { opponent: 2, attacker: 0, victim: 2 }],
  [2400, 'SABOTAGE_SUCCESS', 0, { opponent: 2, attacker: 0, victim: 2 }],
  [3000, 'WATER', 2, { strokes: 5 }],
  [4200, 'HOLE', 3, { strokes: 3, points: 900 }],
  [5200, 'TURN_START', 1, {}],
  [1600, 'SHOT_PERFECT', 1, { power: 0.7 }],
  [1500, 'LONG_SHOT', 1, { distanceMeters: 120 }],
  [2200, 'WATER', 1, { strokes: 6 }],
  [3400, 'PORTAL_ENTER', 3, {}],
  [1900, 'PLAYER_COLLISION', 1, { opponent: 3, attacker: 1, victim: 3 }],
  [1500, 'PLAYER_COLLISION', 3, { opponent: 1, attacker: 3, victim: 1 }],
  [1500, 'PLAYER_COLLISION', 1, { opponent: 3, attacker: 1, victim: 3 }],
  [4000, 'WATER', 1, { strokes: 8 }],
  [3800, 'HOLE_IN_ONE', 2, { strokes: 1, points: 1800 }],
  [5000, 'FINAL_TWO', 0, { survivorCount: 2 }],
  [4200, 'HOLE', 0, { strokes: 2, points: 1200 }],
];

(async () => {
  const game = {
    seed: 'preview', holeIndex: 0, holes: [{}, {}, {}], strokes: 0, totalScore: 0, arcadePoints: 0,
    hole: { id: 'h1', par: 3, difficulty: 0.5, bounds: { minX: 0, maxX: 4000, minY: 0, maxY: 1800 }, hazards: [], surfaces: [] },
    ball: { x: 100, y: 900, vx: 0, vy: 0, moving: false, holed: false, onSurface: true, lastSurfaceId: 's1' },
  };
  const system = new NG.AnnouncerSystem(game, null);
  await system.init();
  system.setLocalPlayerName('Kly');
  if (MODE !== 'offline') system.attachSession(session(MODE === 'turn' ? 'turn' : 'battle'));
  system.setMatchActive(true);

  // El director real reproduce con TTS; aquí solo se recoge lo que habría dicho.
  const transcript = [];
  system.director.submitBundle = (bundle) => {
    if (!bundle?.items?.length) return { accepted: false };
    transcript.push({ at: clock, bundle });
    return { accepted: true, reason: 'preview' };
  };
  system.director.isBusy = () => false;

  system.mapIntroState = { stage: 'consumed', signature: 'x', introDelivered: true, firstTouchArmed: false, firstTouchConsumed: true };

  for (const [dt, eventKey, index, extra] of SCRIPT) {
    advance(dt);
    const actor = roster[index];
    const payload = {
      playerKey: actor.playerKey, playerName: actor.username, strokes: extra.strokes ?? actor.strokes,
      points: extra.points, power: extra.power, distanceMeters: extra.distanceMeters, source: 'preview',
      mode: MODE === 'turn' ? 'turn' : 'battle',
    };
    if (extra.opponent != null) {
      payload.opponentKey = roster[extra.opponent].playerKey;
      payload.opponentName = roster[extra.opponent].username;
    }
    if (extra.attacker != null) {
      payload.attackerKey = roster[extra.attacker].playerKey;
      payload.attackerName = roster[extra.attacker].username;
    }
    if (extra.victim != null) {
      payload.victimKey = roster[extra.victim].playerKey;
      payload.victimName = roster[extra.victim].username;
    }
    if (extra.points) actor.points += extra.points;
    if (eventKey === 'TURN_START') {
      for (const p of roster) p.turn = false;
      actor.turn = true;
    }
    system.announceEvent(eventKey, payload);
    system.narrativeTick();
    global.flushTimers();
  }

  const start = transcript[0]?.at || clock;
  console.log(`\n═══ TRANSCRIPCIÓN · modo ${MODE.toUpperCase()} ═══\n`);
  let lines = 0;
  for (const entry of transcript) {
    const seconds = ((entry.at - start) / 1000).toFixed(1).padStart(5);
    const label = entry.bundle.items[0]?.eventLabel || entry.bundle.eventKey;
    console.log(`[${seconds}s] ── ${entry.bundle.eventKey} (${label})`);
    for (const item of entry.bundle.items) {
      console.log(`          ${NAMES[item.speaker] || '???  '}│ ${item.text}`);
      lines += 1;
    }
    console.log('');
  }
  const spanSeconds = Math.max(1, (clock - start) / 1000);
  console.log(`═══ ${transcript.length} intervenciones · ${lines} líneas · ${(lines / spanSeconds * 60).toFixed(1)} líneas/min ═══`);
  Date.now = realNow;
  process.exit(0);
})();
