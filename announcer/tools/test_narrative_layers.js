#!/usr/bin/env node
'use strict';

/**
 * Comprueba las capas narrativas añadidas sobre la máquina de estados original:
 * léxico y bancos antes muertos, perfiles por modo, control de caudal, foco,
 * rivalidad de cabina, memoria de partida, frescura y eventos derivados.
 *
 * No sustituye a test_state_machine.js: aquel valida el director de voz, este
 * valida qué se decide decir y cuánto.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..');
global.window = global;
global.window.NoiseGolf = {
  CONFIG: { course: { metersPerPixel: 1 / 18 } },
  TerrainUtil: { waterAt: () => null },
};
global.CustomEvent = class CustomEvent { constructor(type, init = {}) { this.type = type; this.detail = init.detail; } };
global.window.dispatchEvent = () => {};
global.window.addEventListener = () => {};
global.window.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
// Sin fetch: el sistema debe caer en los fallbacks *-data.js, que es exactamente
// el camino que usa el juego cuando se abre desde file://.
global.fetch = () => Promise.reject(new Error('sin red en test'));

for (const rel of ['announcer/config-data.js', 'announcer/persona-data.js', 'announcer/map-intro-data.js',
  'announcer/rivalry-data.js', 'announcer/engine.js', 'announcer/manager.js']) {
  vm.runInThisContext(fs.readFileSync(path.join(ROOT, rel), 'utf8'), { filename: rel });
}

const NG = window.NoiseGolf;
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const notes = [];

// ── Dobles de prueba ────────────────────────────────────────────────────────
function fakeGame() {
  return {
    seed: 'seed-test', holeIndex: 0, holes: [{}, {}, {}], strokes: 3, totalScore: 0, arcadePoints: 0,
    hole: { id: 'h1', par: 3, difficulty: 0.5, bounds: { minX: 0, maxX: 4000, minY: 0, maxY: 1800 }, hazards: [], surfaces: [] },
    ball: { x: 100, y: 900, vx: 0, vy: 0, moving: false, holed: false, onSurface: true, lastSurfaceId: 's1' },
  };
}

function fakeSession(mode, players) {
  const map = new Map();
  for (const player of players) map.set(player.playerKey, player);
  return {
    role: 'host', online: true, netTime: 0, courseRound: 0,
    settings: { mode, maxTurnsPerWorld: 6 },
    players: map,
    listeners: new Map(),
    on(type, fn) { this.listeners.set(type, fn); return () => this.listeners.delete(type); },
    getStatus() { return { online: true, mode }; },
    anyBallRolling() { return false; },
    broadcastAnnouncerBundle() { return true; },
    getStandings() {
      return [...this.players.values()]
        .sort((a, b) => b.points - a.points || a.strokes - b.strokes)
        .map((p, index) => ({
          rank: index + 1, playerKey: p.playerKey, username: p.username, points: p.points, strokes: p.strokes,
          turnsUsed: p.turnsUsed || 0, role: 'player', connected: true, finished: !!p.finished,
          timedOut: !!p.timedOut, finishReason: p.finishReason || '', finishOrder: p.finishOrder || 0,
          progress: p.progress ?? 0.2, turn: !!p.turn, local: index === 0,
        }));
    },
  };
}

const player = (playerKey, username, points, extra = {}) => ({
  playerKey, username, points, strokes: 2, role: 'player', connected: true, turnsUsed: 0,
  ball: { x: 200, y: 900, vx: 0, vy: 0, moving: false, holed: false, onSurface: true, lastSurfaceId: 's1' },
  ...extra,
});

async function makeSystem(mode = 'battle', players = null) {
  const game = fakeGame();
  const system = new NG.AnnouncerSystem(game, null);
  await system.init();
  system.setLocalPlayerName('Kly');
  if (mode !== 'offline') {
    system.attachSession(fakeSession(mode, players || [
      player('p1', 'Kly', 900), player('p2', 'Nina', 600), player('p3', 'Bruno', 300), player('p4', 'Oto', 100),
    ]));
  }
  system.setMatchActive(true);
  // La presentación de mapa silencia todo hasta el primer toque; para probar el
  // resto de capas se consume ese estado explícitamente.
  system.mapIntroState = { stage: 'consumed', signature: 'x', introDelivered: true, firstTouchArmed: false, firstTouchConsumed: true };
  system.director.stop();
  return system;
}

// ── T1 · El texto generado sale limpio en los 74 eventos ────────────────────
async function testTextIntegrity() {
  const system = await makeSystem('battle');
  const keys = Object.keys(system.personas.commentator.events);
  let lines = 0;
  for (const eventKey of keys) {
    for (let i = 0; i < 6; i += 1) {
      const ctx = { player: 'Kly', opponent: 'Nina', mode: 'battle', distance: 20, goodStreak: 1, badStreak: 0 };
      const bundle = system.composer.buildBundle(eventKey, ctx, 'test', system.bundleShape(system.effectivePolicy(eventKey)));
      for (const item of bundle.items) {
        assert(!/\{[a-z_]+\}/i.test(item.text), `Token sin resolver en ${eventKey}: ${item.text}`);
        assert(!/\s{2,}/.test(item.text), `Espacios dobles en ${eventKey}: ${item.text}`);
        assert(!/[.!?…]\s*[,;]/.test(item.text), `Puntuación rota en ${eventKey}: ${item.text}`);
        assert(/[.!?…]["'”’)]?$/.test(item.text), `Frase sin cierre en ${eventKey}: ${item.text}`);
        lines += 1;
      }
    }
  }
  notes.push(`texto limpio en ${keys.length} eventos (${lines} líneas generadas)`);
}

// ── T2 · Variedad: el banco tonal vuelve a rotación ─────────────────────────
async function testVariety() {
  const system = await makeSystem('turn');
  const seen = new Set();
  const total = 120;
  for (let i = 0; i < total; i += 1) {
    const result = system.composer.engines.commentator.compose('WATER', { player: 'Kly', mode: 'turn' }, { maxWords: 22 });
    seen.add(result.text);
  }
  const ratio = seen.size / total;
  assert(ratio > 0.75, `Variedad insuficiente en WATER: ${seen.size}/${total}`);
  notes.push(`variedad WATER ${seen.size}/${total} frases distintas`);
}

// ── T3 · El banco battleRoyale y el léxico dejan de estar muertos ───────────
async function testDeadBanksAlive() {
  const system = await makeSystem('battle');
  const taunts = system.personas.commentator.battleRoyale.taunts;
  let tauntHit = false;
  for (let i = 0; i < 200 && !tauntHit; i += 1) {
    const cores = system.composer.engines.commentator.eventCores(
      system.personas.commentator.events.PLAYER_TAUNT, 'PLAYER_TAUNT', { mode: 'battle' },
    );
    if (cores.some((core) => taunts.includes(core))) tauntHit = true;
  }
  assert(tauntHit, 'battleRoyale.taunts sigue sin entrar en el pool de PLAYER_TAUNT');

  const tokens = system.composer.engines.commentator.lexiconTokens();
  assert(tokens.connector && tokens.high_exclamation && tokens.praise_noun, 'El léxico del comentarista no se está leyendo');
  const infoTokens = system.composer.engines.informant.lexiconTokens();
  assert(infoTokens.measurement && infoTokens.analysis_verb && infoTokens.confidence, 'El léxico del informante no se está leyendo');
  notes.push('battleRoyale + lexicon en rotación');
}

// ── T4 · Perfil por modo: battle recorta, turnos amplía ─────────────────────
async function testModeProfiles() {
  const battle = await makeSystem('battle');
  assert(battle.currentMode() === 'battle', 'Modo battle mal detectado');
  assert(battle.modeProfile().maxItems === 2, 'battle debería limitar el bloque a 2 líneas');
  assert(battle.effectivePolicy('WALL_HIT').mode === 'trace', 'WALL_HIT debería ser traza en battle');
  assert(battle.effectivePolicy('SHOT_TAKEN').class === 'progressive', 'SHOT_TAKEN debería bajar de clase en battle');

  const turn = await makeSystem('turn');
  assert(turn.currentMode() === 'turn', 'Modo turnos mal detectado');
  assert(turn.effectivePolicy('WALL_HIT').mode === 'immediate', 'En turnos WALL_HIT conserva su política original');
  assert(turn.effectivePolicy('TURN_START').class === 'important', 'En turnos TURN_START debería subir de clase');
  assert(turn.modeProfile().dialogueScale > 1, 'En turnos debería haber más diálogo, no menos');

  for (let i = 0; i < 40; i += 1) {
    const bundle = battle.composer.buildBundle('HOLE', { player: 'Kly', mode: 'battle' }, 'test', battle.bundleShape(battle.effectivePolicy('HOLE')));
    assert(bundle.items.length <= 2, `battle generó un bloque de ${bundle.items.length} líneas`);
  }
  notes.push('perfiles de modo aplicados (battle 2 líneas / turnos diálogo ampliado)');
}

// ── T5 · Caudal: ocho desgracias simultáneas no son ocho locuciones ─────────
async function testFlowControl() {
  const system = await makeSystem('battle');
  const accepted = [];
  for (const key of ['p1', 'p2', 'p3', 'p4']) {
    for (const eventKey of ['WATER', 'OUT_OF_BOUNDS']) {
      const result = system.announceEvent(eventKey, {
        playerKey: key, playerName: key, strokes: 4, source: 'test',
      });
      if (result?.accepted) accepted.push(`${key}:${eventKey}`);
    }
  }
  // Ocho desgracias idénticas y simultáneas son UNA noticia, no ocho.
  assert(accepted.length < 8, `El caudal no filtró nada: ${accepted.length}/8 aceptados`);
  assert(accepted.length >= 1, 'El caudal se comió absolutamente todo');

  // El presupuesto de habla es el freno real: una locución tarda segundos en
  // decirse, así que el caudal se mide en tiempo hablado, no en número de líneas.
  // Con la ventana casi llena de habla, un suceso nuevo tiene que esperar.
  const now = Date.now();
  const windowMs = Number(system.flowConfig().rateWindowMs || 15000);
  const budgetMs = windowMs * Number(system.flowConfig().speechBudget || 0.62);
  system.flow.recent = [{ at: now, ms: budgetMs }];
  const saturated = system.flowAllows('PLAYER_COLLISION', system.effectivePolicy('PLAYER_COLLISION'), now + 200);
  assert(!saturated.ok && saturated.reason === 'flow-speech-budget',
    `Con el presupuesto de habla agotado debería frenar, dio ${saturated.reason || 'paso libre'}`);

  // Con presupuesto libre, un suceso de otra clase semántica sí pasa: el
  // enfriamiento es por naturaleza del suceso, no un silencio general.
  system.flow.recent.length = 0;
  const other = system.flowAllows('PLAYER_COLLISION', system.effectivePolicy('PLAYER_COLLISION'), Date.now() + 200);
  assert(other.ok, `Un suceso de otra clase quedó bloqueado: ${other.reason}`);

  // Y HOLE/HOLE_IN_ONE nunca se filtran, pase lo que pase.
  system.flow.recent = new Array(40).fill(null).map(() => ({ at: Date.now(), ms: 5000 }));
  const hole = system.flowAllows('HOLE', { class: 'supercritical', guaranteed: true, priority: 1000 }, Date.now());
  assert(hole.ok, 'El caudal llegó a bloquear un evento garantizado');
  notes.push(`caudal: ${accepted.length}/8 sucesos idénticos simultáneos; freno por presupuesto de habla; garantizados intactos`);
}

// ── T6 · Foco: lo que pasa fuera de plano pesa menos ────────────────────────
async function testFocus() {
  const system = await makeSystem('battle');
  system.announceEvent('HOLE_IN_ONE', { playerKey: 'p1', playerName: 'Kly', strokes: 1, source: 'test' });
  assert(system.focus.playerKey === 'p1', `El foco debería estar en p1, está en ${system.focus.playerKey}`);

  const onFocus = system.effectivePolicy('PLAYER_COLLISION');
  const offFocus = system.effectivePolicy('PLAYER_COLLISION');
  system.applyFocusWeight(onFocus, 'p1');
  system.applyFocusWeight(offFocus, 'p4');
  assert(offFocus.priority < onFocus.priority, 'El evento fuera de foco no perdió prioridad');
  assert(offFocus.class === 'progressive', 'El evento fuera de foco no bajó de clase');

  const offline = await makeSystem('offline');
  assert(!offline.focusEnabled(), 'En offline no debería haber foco: solo hay un jugador');
  notes.push(`foco activo (${onFocus.priority} en plano vs ${offFocus.priority} fuera)`);
}

// ── T7 · Eventos derivados del marcador ────────────────────────────────────
async function testDerivedStandings() {
  const roster = [player('p1', 'Kly', 900), player('p2', 'Nina', 600), player('p3', 'Bruno', 300), player('p4', 'Oto', 100)];
  const system = await makeSystem('battle', roster);
  const fired = [];
  const original = system.announceEvent.bind(system);
  system.announceEvent = (eventKey, payload) => { fired.push(eventKey); return original(eventKey, payload); };

  system.narrativeTick();               // primera lectura: fija líder y puestos
  assert(!fired.includes('SCORE_UPDATE'), 'El repaso de marcador no debe sonar en el primer tick');

  roster[1].points = 2000;              // Nina adelanta a Kly
  system.derived.lastScoreEventAt = 0;
  system.narrativeTick();
  assert(fired.includes('LEAD_CHANGE'), `LEAD_CHANGE no se derivó (${fired.join(', ')})`);

  roster[3].points = 1500;              // Oto sube del cuarto al segundo puesto
  system.derived.lastScoreEventAt = 0;
  system.narrativeTick();
  assert(fired.includes('COMEBACK'), `COMEBACK no se derivó (${fired.join(', ')})`);

  roster[0].points = 2000;              // empate en cabeza
  system.derived.lastScoreEventAt = 0;
  system.derived.leaderKey = '';
  system.derived.tieActive = false;
  system.narrativeTick();
  assert(fired.includes('TIE'), `TIE no se derivó (${fired.join(', ')})`);

  roster[2].finished = true;
  roster[2].timedOut = true;
  roster[2].finishOrder = 0;
  system.narrativeTick();
  system.derived.eliminations[0].at -= 5000;
  system.narrativeTick();
  assert(fired.includes('PLAYER_ELIMINATED'), `PLAYER_ELIMINATED no se derivó (${fired.join(', ')})`);
  notes.push('derivados de marcador: LEAD_CHANGE, COMEBACK, TIE, PLAYER_ELIMINATED');
}

// ── T8 · Eventos derivados del vuelo de la bola ────────────────────────────
async function testDerivedFlight() {
  const roster = [player('p1', 'Kly', 100), player('p2', 'Nina', 90)];
  const system = await makeSystem('battle', roster);
  const fired = [];
  const original = system.announceEvent.bind(system);
  system.announceEvent = (eventKey, payload) => { fired.push(eventKey); return original(eventKey, payload); };

  const ball = roster[0].ball;
  ball.moving = true;
  ball.onSurface = false;
  ball.vy = -1400;                      // subida fuerte
  system.narrativeTick();
  assert(fired.includes('BALL_AIR'), `BALL_AIR no se derivó (${fired.join(', ')})`);
  assert(fired.includes('BALL_HIGH'), `BALL_HIGH no se derivó (${fired.join(', ')})`);

  ball.vx = 1600;
  system.narrativeTick();
  assert(fired.includes('BALL_FAST'), `BALL_FAST no se derivó (${fired.join(', ')})`);

  ball.y = 2600;                        // por debajo del suelo del mundo
  system.narrativeTick();
  assert(fired.includes('VOID_FALL'), `VOID_FALL no se derivó (${fired.join(', ')})`);
  notes.push('derivados de vuelo: BALL_AIR, BALL_HIGH, BALL_FAST, VOID_FALL');
}

// ── T9 · Clasificación de golpe: SHOT_BAD, POWER_MAX, POWER_LOW ────────────
async function testShotClassification() {
  const system = await makeSystem('turn');
  system.contexts.set('p1', { distance: 60 });
  assert(system.classifyShot(0.1, 'p1').eventKey === 'SHOT_BAD', 'Golpe flojo con el hoyo lejos debería ser SHOT_BAD');
  assert(system.classifyShot(0.1, 'p1').aside === 'POWER_LOW', 'Un golpe mínimo debería añadir POWER_LOW');
  assert(system.classifyShot(0.99, 'p1').aside === 'POWER_MAX', 'Un golpe al máximo debería añadir POWER_MAX');
  system.contexts.set('p1', { distance: 3 });
  assert(system.classifyShot(0.1, 'p1').eventKey === 'SHOT_WEAK', 'Un toque suave junto al hoyo no es un mal golpe');
  assert(system.classifyShot(0.7, 'p1').eventKey === 'SHOT_PERFECT', 'La ventana de golpe perfecto se rompió');
  notes.push('clasificación de golpe con SHOT_BAD / POWER_MAX / POWER_LOW');
}

// ── T10 · Memoria de partida: el tercer baño se convierte en chiste ────────
async function testRunningGags() {
  const system = await makeSystem('turn');
  const ctx = { player: 'Kly', goodStreak: 0, badStreak: 2 };
  for (let i = 0; i < 3; i += 1) system.noteLedger('WATER', 'p1', {}, ctx);
  assert(system.ledgerFor('p1').water === 3, 'El registro de aguas no cuenta');
  const gag = system.maybeGag('WATER', 'p1', ctx);
  assert(gag && /3/.test(gag.text), `El gag acumulativo no salió: ${gag && gag.text}`);
  assert(!system.maybeGag('WATER', 'p1', ctx), 'El gag no respeta su propio enfriamiento');
  notes.push(`memoria de partida: "${gag.text.slice(0, 60)}…"`);
}

// ── T11 · Cabina: apuesta abierta y cobrada ───────────────────────────────
async function testBoothBets() {
  const system = await makeSystem('turn');
  const ctx = { player: 'Kly' };
  let opened = null;
  for (let i = 0; i < 60 && !opened; i += 1) {
    system.booth.lastBetAt = 0;
    opened = system.maybeOpenBet('RISKY_AIM', 'p1', ctx);
  }
  assert(opened && opened.length === 2, 'La apuesta no se abrió con las dos voces');
  assert(opened[0].speaker === 'commentator' && opened[1].speaker === 'informant', 'La apuesta no reparte bien las voces');
  assert(system.booth.pendingBet, 'La apuesta no quedó pendiente de cobro');

  const win = system.resolveBet('HOLE', 'p1', ctx);
  assert(win && win.speaker === 'commentator', 'Rafa debería cobrar la apuesta tras un HOLE');
  assert(!system.booth.pendingBet, 'La apuesta cobrada no se cerró');

  system.booth.lastBetAt = 0;
  let second = null;
  for (let i = 0; i < 60 && !second; i += 1) {
    system.booth.lastBetAt = 0;
    second = system.maybeOpenBet('RISKY_AIM', 'p2', ctx);
  }
  const loss = system.resolveBet('WATER', 'p2', ctx);
  assert(loss && loss.speaker === 'informant', 'Álex debería cobrar la apuesta tras un WATER');
  notes.push('apuestas de cabina abiertas y cobradas en ambos sentidos');
}

// ── T12 · Cabina: desacuerdo solo donde cabe ──────────────────────────────
async function testBoothDisagreement() {
  const turn = await makeSystem('turn');
  let pair = null;
  for (let i = 0; i < 200 && !pair; i += 1) {
    turn.booth.lastDisagreementAt = 0;
    pair = turn.maybeDisagreement('HOLE');
  }
  assert(pair && pair.length === 2, 'El desacuerdo de cabina no aparece en modo por turnos');
  assert(pair[0].speaker === 'commentator' && pair[1].speaker === 'informant', 'El desacuerdo no enfrenta a los dos locutores');

  const battle = await makeSystem('battle');
  for (let i = 0; i < 50; i += 1) {
    battle.booth.lastDisagreementAt = 0;
    assert(!battle.maybeDisagreement('HOLE'), 'En battle no hay sitio para un desacuerdo de dos líneas');
  }
  notes.push('desacuerdo de cabina activo en turnos y suprimido en battle');
}

// ── T13 · Rivalidad entre jugadores acumulada ─────────────────────────────
async function testPlayerRivalry() {
  const system = await makeSystem('battle');
  const seen = [];
  for (let i = 0; i < 6; i += 1) {
    const ctx = { player: 'Kly', opponent: 'Nina', mode: 'battle' };
    const result = system.socializeEvent('PLAYER_COLLISION', ctx, {
      playerKey: 'p1', playerName: 'Kly', opponentKey: 'p2', opponentName: 'Nina',
      attackerKey: i % 2 ? 'p2' : 'p1', victimKey: i % 2 ? 'p1' : 'p2', mode: 'battle',
    });
    if (result.rivalry) seen.push(result.rivalry.text);
    system.rivalries.get(['p1', 'p2'].sort().join('|')).lastLineAt = 0;
  }
  assert(seen.length >= 2, `La rivalidad no produjo líneas acumuladas (${seen.length})`);
  for (let i = 1; i < seen.length; i += 1) {
    assert(seen[i] !== seen[i - 1], 'La rivalidad repitió la misma frase dos veces seguidas');
  }
  assert(new Set(seen).size >= Math.min(3, seen.length), `La rivalidad rota demasiado poco: ${new Set(seen).size} frases distintas`);
  notes.push(`rivalidad entre jugadores: ${seen.length} líneas encadenadas, ${new Set(seen).size} distintas`);
}

// ── T14 · Choque contra el líder y colisión de favoritos suben de evento ──
async function testSocialEscalation() {
  const system = await makeSystem('battle');
  const ctx = { player: 'Nina', opponent: 'Kly', mode: 'battle' };
  const attack = system.socializeEvent('PLAYER_COLLISION', ctx, {
    playerKey: 'p2', playerName: 'Nina', opponentKey: 'p1', opponentName: 'Kly',
    attackerKey: 'p2', victimKey: 'p1', mode: 'battle',
  });
  assert(attack.primary === 'LEADER_ATTACKED', `Atacar al líder debería elevar el evento, dio ${attack.primary}`);

  const favSystem = await makeSystem('battle');
  favSystem.favorite = { commentator: 'p3', informant: 'p4' };
  const favCtx = { player: 'Bruno', opponent: 'Oto', mode: 'battle' };
  const clash = favSystem.socializeEvent('PLAYER_COLLISION', favCtx, {
    playerKey: 'p3', playerName: 'Bruno', opponentKey: 'p4', opponentName: 'Oto',
    attackerKey: 'p3', victimKey: 'p4', mode: 'battle',
  });
  assert(clash.primary === 'FAVORITES_COLLIDE', `El choque de favoritos debería elevar el evento, dio ${clash.primary}`);
  notes.push('escalada social: LEADER_ATTACKED y FAVORITES_COLLIDE');
}

// ── T15 · Sabotaje que sale por la culata ─────────────────────────────────
async function testSabotageBackfire() {
  const system = await makeSystem('battle');
  system.socializeEvent('PLAYER_COLLISION', { player: 'Nina', opponent: 'Kly', mode: 'battle' }, {
    playerKey: 'p2', playerName: 'Nina', opponentKey: 'p1', opponentName: 'Kly',
    attackerKey: 'p2', victimKey: 'p1', mode: 'battle',
  });
  const backfire = system.socializeEvent('WATER', { player: 'Nina', mode: 'battle' }, {
    playerKey: 'p2', playerName: 'Nina', mode: 'battle',
  });
  assert(backfire.primary === 'SABOTAGE_BACKFIRE', `El sabotaje fallido debería ser SABOTAGE_BACKFIRE, dio ${backfire.primary}`);
  notes.push('SABOTAGE_BACKFIRE detectado tras contacto propio');
}

// ── T16 · Frescura: lo que esperó demasiado se cuenta como recuerdo ───────
async function testStaleness() {
  const system = await makeSystem('turn');
  const bundle = {
    eventKey: 'HOLE', eventAt: Date.now() - 5000, policy: { class: 'important' },
    items: [{ speaker: 'commentator', text: '¡Al hoyo!' }],
  };
  const verdict = system.decorateStaleBundle(bundle, 5000);
  assert(verdict === 'decorated', `Un bloque de 5 s debería narrarse en pasado, dio ${verdict}`);
  assert(bundle.items[0].text !== '¡Al hoyo!', 'El bloque tardío no recibió conector retrospectivo');

  const fresh = { eventKey: 'HOLE', eventAt: Date.now(), policy: { class: 'important' }, items: [{ speaker: 'commentator', text: 'directo' }] };
  assert(system.decorateStaleBundle(fresh, 200) === true, 'Un bloque reciente no debería decorarse');
  assert(fresh.items[0].text === 'directo', 'Un bloque reciente fue alterado');

  const ancient = { eventKey: 'BOUNCE', eventAt: Date.now() - 20000, policy: { class: 'important' }, items: [{ speaker: 'commentator', text: 'viejo' }] };
  assert(system.decorateStaleBundle(ancient, 20000) === false, 'Un bloque rancio no garantizado debería descartarse');

  const guaranteed = { eventKey: 'HOLE', eventAt: Date.now() - 20000, policy: { class: 'supercritical', guaranteed: true }, items: [{ speaker: 'commentator', text: 'hoyo' }] };
  assert(system.decorateStaleBundle(guaranteed, 20000) !== false, 'Un HOLE garantizado nunca se descarta por antigüedad');
  notes.push('frescura: recuerdo, descarte y garantía intacta');
}

// ── T17 · La cabina no habla antes del primer toque ni fuera de partida ───
async function testAuthorityGuards() {
  const system = await makeSystem('turn');
  system.mapIntroState.firstTouchArmed = true;
  assert(!system.narrativeAuthority(), 'El tick no debe derivar nada antes del primer toque del mapa');
  system.mapIntroState.firstTouchArmed = false;
  assert(system.narrativeAuthority(), 'El tick debería estar activo en gameplay');
  system.setNarrativePhase('postmatch', 'test');
  assert(!system.narrativeAuthority(), 'El tick no debe derivar nada en postmatch');
  system.setMatchActive(false);
  assert(!system.narrativeAuthority(), 'El tick no debe derivar nada fuera de partida');
  notes.push('guardas de autoridad del tick narrativo');
}

(async () => {
  const tests = [
    testTextIntegrity, testVariety, testDeadBanksAlive, testModeProfiles, testFlowControl, testFocus,
    testDerivedStandings, testDerivedFlight, testShotClassification, testRunningGags, testBoothBets,
    testBoothDisagreement, testPlayerRivalry, testSocialEscalation, testSabotageBackfire, testStaleness,
    testAuthorityGuards,
  ];
  for (const test of tests) {
    try {
      await test();
    } catch (error) {
      console.error(`FALLO en ${test.name}: ${error.message}`);
      process.exit(1);
    }
  }
  console.log('ANNOUNCER NARRATIVE LAYERS TEST OK');
  for (const note of notes) console.log(` - ${note}`);
  process.exit(0);
})();
