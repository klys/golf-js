#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..');
global.window = global;
global.window.NoiseGolf = { CONFIG: { course: { metersPerPixel: 0.1 } } };
global.CustomEvent = class CustomEvent { constructor(type, init = {}) { this.type = type; this.detail = init.detail; } };
global.window.dispatchEvent = () => {};
global.window.addEventListener = () => {};
global.window.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };

for (const rel of ['announcer/engine.js', 'announcer/manager.js']) {
  vm.runInThisContext(fs.readFileSync(path.join(ROOT, rel), 'utf8'), { filename: rel });
}

const NG = window.NoiseGolf;
const assert = (condition, message) => { if (!condition) throw new Error(message); };

function fakeSystem() {
  return {
    enabled: true,
    language: 'es-ES',
    getSpeakerSettings: () => ({ rate: 1, pitch: 1, volume: 0 }),
    personalizeText: (text) => String(text || ''),
    notifySpeechLine: () => {},
    voiceByURI: () => null,
  };
}

// CP-1 · HOLE/HIO: cola persistente, sin caducidad mientras espera micrófono.
{
  const director = new NG.AnnouncerSpeechDirector(fakeSystem());
  director.currentBundle = { id: 'busy', source: 'game', policy: { class: 'important' }, items: [{ text: 'ocupado', speaker: 'commentator' }] };
  director.estimatedBundleEndAt = Date.now() + 5000;
  const hole = {
    id: 'hole-1', guaranteeKey: 'HOLE:p1:course0:hole0', eventKey: 'HOLE', eventAt: Date.now() - 5000,
    expiresAt: Date.now() - 4000, source: 'game', policy: { class: 'supercritical', guaranteed: true, priority: 1000 },
    items: [{ text: '¡Al hoyo!', speaker: 'commentator' }],
  };
  const result = director.submitBundle(hole);
  assert(result.accepted && result.reason === 'guaranteed-queued', 'HOLE no entró en cola garantizada');
  assert(director.guaranteedQueue.length === 1, 'La cola supercrítica no conserva HOLE');
  const duplicate = director.submitBundle({ ...hole, id: 'hole-duplicate' });
  assert(!duplicate.accepted && duplicate.reason === 'guaranteed-dedupe', 'HOLE duplicado no fue deduplicado');
}

// CP-2 · Una acción real recupera el micrófono después de la frase informativa actual.
{
  const director = new NG.AnnouncerSpeechDirector(fakeSystem());
  director.currentBundle = { id: 'info', source: 'idle-information', policy: { class: 'ambient' }, items: [{ text: 'estado', speaker: 'informant' }] };
  director.estimatedBundleEndAt = Date.now() + 6000;
  const shot = {
    id: 'shot', eventKey: 'SHOT_TAKEN', eventAt: Date.now(), expiresAt: Date.now() + 100,
    source: 'game', policy: { class: 'important', priority: 76 }, items: [{ text: 'tiro', speaker: 'commentator' }],
  };
  const result = director.submitBundle(shot);
  assert(result.accepted && result.reason === 'gameplay-after-informative', 'Gameplay no recupera turno desde informativo');
  assert(director.yieldInformativeAfterLine === true, 'La conversación informativa no cede después de la línea actual');
  assert(director.hotSlot?.id === 'shot', 'El tiro no quedó reservado para sonar inmediatamente después');
}

// CP-3 · Post-partida bloquea gameplay viejo, pero conserva HOLE y resúmenes.
{
  const game = {
    holeIndex: 0,
    holes: [{ par: 4, cup: { x: 100, y: 0 } }],
    hole: { par: 4, cup: { x: 100, y: 0 }, difficultyLabel: 'Media' },
    ball: { x: 20, y: 0, moving: false },
    strokes: 3,
    totalScore: -1,
    arcadePoints: 1200,
    isIntroPlaying: () => false,
  };
  const ann = new NG.AnnouncerSystem(game, null);
  ann.runtimeConfig = { stateMachine: { aimLeaseMs: 60000 } };
  ann.matchActive = true;
  ann.narrativePhase = 'postmatch';
  assert(!ann.postMatchAllowsBundle({ eventKey: 'SHOT_TAKEN', source: 'game', policy: { class: 'important' } }), 'Tiro viejo sobrevivió al final');
  assert(ann.postMatchAllowsBundle({ eventKey: 'HOLE', source: 'game', policy: { class: 'supercritical', guaranteed: true } }), 'HOLE se perdió al final');
  assert(ann.postMatchAllowsBundle({ eventKey: 'POST_MATCH_SUMMARY', source: 'postmatch-summary', policy: { class: 'important' } }), 'Resumen final fue bloqueado');
  const summary = ann.buildPostMatchSummaryBundle();
  assert(summary.items.length === 2 && /Recorrido completado/.test(summary.items[0].text), 'Resumen offline incoherente');
}

// CP-4 · Un supercrítico de red llegado tarde se reproduce; un evento normal puede caducar.
{
  const game = { ball: { moving: false }, isIntroPlaying: () => false };
  const ann = new NG.AnnouncerSystem(game, null);
  ann.runtimeConfig = { sync: { lateGraceMs: 900 } };
  ann.matchActive = true;
  ann.narrativePhase = 'gameplay';
  ann.session = { role: 'client', hostClock: { now: () => 10 }, netTime: 10 };
  let submitted = 0;
  ann.director = { submitBundle: () => { submitted += 1; return { accepted: true }; } };
  const guaranteed = { eventKey: 'HOLE', policy: { class: 'supercritical', guaranteed: true }, items: [{ text: 'hoyo' }] };
  const normal = { eventKey: 'SHOT_TAKEN', policy: { class: 'important' }, items: [{ text: 'tiro' }] };
  const a = ann.scheduleBundle(guaranteed, 0);
  const b = ann.scheduleBundle(normal, 0);
  assert(a.accepted && submitted === 1, 'Supercrítico tardío fue descartado por sincronización');
  assert(!b.accepted && b.reason === 'too-late', 'Evento normal tardío no respetó lateGrace');
}

// CP-5 · Apuntar o tener la bola en movimiento impide entrar en inactividad.
{
  const game = { dragging: false, ball: { moving: true }, isIntroPlaying: () => false };
  const ann = new NG.AnnouncerSystem(game, null);
  ann.runtimeConfig = { stateMachine: { aimLeaseMs: 60000 } };
  assert(ann.hasLiveGameplayActivity(), 'Bola en movimiento fue tratada como inactividad');
  game.ball.moving = false;
  ann.setAimActivity('p1', true, 0.6);
  assert(ann.hasLiveGameplayActivity(), 'Apuntado activo fue tratado como inactividad');
  ann.setAimActivity('p1', false, 0);
  assert(!ann.hasLiveGameplayActivity(), 'Aim-end no liberó el estado activo');
}

// CP-6 · La pausa informativa se emite una sola vez hasta que aparece una acción real.
{
  const game = {
    holeIndex: 0, holes: [{ par: 4, cup: { x: 100, y: 0 } }],
    hole: { par: 4, cup: { x: 100, y: 0 }, difficultyLabel: 'Media' },
    ball: { x: 20, y: 0, moving: false }, strokes: 2, isIntroPlaying: () => false,
  };
  const ann = new NG.AnnouncerSystem(game, null);
  ann.ready = true;
  ann.enabled = true;
  ann.matchActive = true;
  ann.narrativePhase = 'gameplay';
  ann.runtimeConfig = { dialogue: { allowQuietFiller: true, quietBeforeFillerMs: 1000 }, stateMachine: { idleAfterMs: 1000 } };
  ann.director = { isBusy: () => false };
  let delivered = 0;
  ann.deliverBundle = () => { delivered += 1; return { accepted: true }; };
  ann.lastMeaningfulAt = Date.now() - 5000;
  ann.maybeFillSilence();
  ann.maybeFillSilence();
  ann.maybeFillSilence();
  assert(delivered === 1, 'La pausa informativa se repitió sin una acción nueva');
  assert(ann.informativeDelivered === true, 'No quedó bloqueada la pausa después de reproducirse');
  ann.markGameplayActivity('shot', 'p1');
  assert(ann.informativeDelivered === false, 'Una acción real no volvió a armar la pausa informativa');
  ann.lastMeaningfulAt = Date.now() - 5000;
  ann.maybeFillSilence();
  assert(delivered === 2, 'No se permitió una nueva pausa después de una acción real');
}

// CP-7 · Las APIs visuales opcionales no pueden romper el game loop por una caché antigua.
{
  const gameSource = fs.readFileSync(path.join(ROOT, 'js/core/game.js'), 'utf8');
  assert(/typeof this\.renderer\?\.spawnShockwave === 'function'/.test(gameSource), 'spawnShockwave no está protegido');
  assert(/typeof this\.renderer\?\.spawnWaterRipple === 'function'/.test(gameSource), 'spawnWaterRipple no está protegido');
}

// CP-8 · Presentación de mapa: líder/favorito y primer toque contextual.
{
  const game = { seed: 'seed-a', holeIndex: 1, hole: { par: 4 }, holes: [{}, {}], ball: { moving: false }, isIntroPlaying: () => false };
  const ann = new NG.AnnouncerSystem(game, null);
  ann.mapIntroData = JSON.parse(fs.readFileSync(path.join(ROOT, 'announcer/data/map-intro.json'), 'utf8'));
  ann.runtimeConfig = { mapPresentation: { introPriority: 96, firstTouchPriority: 94, recentMemory: 8 } };
  const standings = [
    { rank: 1, playerKey: 'a', username: 'Alicia', points: 12, role: 'player', connected: true },
    { rank: 2, playerKey: 'b', username: 'Bruno', points: 4, role: 'player', connected: true },
  ];
  ann.session = {
    role: 'host', courseRound: 2, getStatus: () => ({ online: true }), getStandings: () => standings,
    players: new Map([['a', { username: 'Alicia' }], ['b', { username: 'Bruno' }]]),
  };
  ann.favorite.commentator = 'a';
  const intro = ann.buildMapPresentationBundle({ source: 'test' });
  assert(intro.eventKey === 'MAP_PRESENTATION' && intro.policy.mustSpeak === true, 'Presentación de mapa no es persistente');
  assert(intro.items[0]?.speaker === 'commentator' && /Alicia/.test(intro.items[0]?.text || ''), 'El favorito líder no fue presentado por su comentarista');
  ann.favorite.commentator = '';
  ann.favorite.informant = 'b';
  const first = ann.buildMapFirstTouchBundle({ playerKey: 'b', playerName: 'Bruno', source: 'test' });
  assert(first.eventKey === 'MAP_FIRST_TOUCH' && first.items[0]?.speaker === 'informant', 'El favorito del informante no tomó la voz en el primer toque');
  assert(/Bruno/.test(first.items[0]?.text || ''), 'El primer toque no menciona al jugador correcto');
}

// CP-9 · Postmatch nunca vuelve a abrir una pausa informativa.
{
  const game = { holeIndex: 0, holes: [{}], hole: { par: 4, cup: { x: 1, y: 1 } }, ball: { x: 0, y: 0, moving: false }, isIntroPlaying: () => false };
  const ann = new NG.AnnouncerSystem(game, null);
  ann.ready = true; ann.enabled = true; ann.matchActive = true; ann.narrativePhase = 'postmatch'; ann.informativeDelivered = true;
  ann.runtimeConfig = { dialogue: { allowQuietFiller: true }, stateMachine: { postMatchSummaryMax: 0, idleAfterMs: 1 } };
  ann.director = { isBusy: () => false };
  let delivered = 0;
  ann.deliverBundle = () => { delivered += 1; return { accepted: true }; };
  ann.lastMeaningfulAt = Date.now() - 10000;
  ann.maybeFillSilence();
  assert(delivered === 0, 'Postmatch abrió narración informativa o resumen pese a max=0');
  assert(ann.narrativePhase === 'postmatch' && ann.informativeDelivered === true, 'Postmatch rearmó la pausa informativa');
}

// CP-10 · HOLE/HIO saltan delante de presentaciones mustSpeak aún no iniciadas.
{
  const director = new NG.AnnouncerSpeechDirector(fakeSystem());
  director.currentBundle = { id: 'busy', source: 'game', policy: { class: 'important' }, items: [{ text: 'ocupado', speaker: 'commentator' }] };
  const intro = { id: 'intro', eventKey: 'MAP_PRESENTATION', policy: { class: 'critical', mustSpeak: true }, items: [{ text: 'intro', speaker: 'commentator' }] };
  const hole = { id: 'hole-priority', guaranteeKey: 'HOLE:p1:m1', eventKey: 'HOLE', policy: { class: 'supercritical', guaranteed: true }, items: [{ text: 'hoyo', speaker: 'commentator' }] };
  director.submitBundle(intro);
  director.submitBundle(hole);
  assert(director.guaranteedQueue[0]?.eventKey === 'HOLE', 'HOLE no saltó delante del mustSpeak pendiente');
  assert(director.guaranteedQueue[1]?.eventKey === 'MAP_PRESENTATION', 'La presentación mustSpeak se perdió al priorizar HOLE');
}

// CP-11 · Un MAP_PRESENTATION del host saca al cliente de postmatch antes de programar audio.
{
  const game = { ball: { moving: false }, isIntroPlaying: () => false };
  const ann = new NG.AnnouncerSystem(game, null);
  ann.matchActive = true;
  ann.narrativePhase = 'postmatch';
  ann.informativeDelivered = true;
  ann.session = { role: 'client' };
  let scheduled = null;
  ann.scheduleBundle = (bundle) => { scheduled = bundle; return { accepted: true }; };
  ann.receiveNetworkBundle({
    startAtNetTime: 10,
    bundle: { eventKey: 'MAP_PRESENTATION', mapSignature: 'online:3:seed:0', policy: { class: 'critical', mustSpeak: true }, items: [{ text: 'mapa', speaker: 'commentator' }] },
  });
  assert(ann.narrativePhase === 'gameplay', 'Cliente siguió atrapado en postmatch al recibir mapa nuevo');
  assert(ann.mapIntroState.firstTouchArmed === true, 'Cliente no armó el primer toque al recibir presentación');
  assert(scheduled?.eventKey === 'MAP_PRESENTATION', 'Cliente no programó la presentación recibida');
}

// CP-12 · Al cambiar mapa/postmatch una conversación vieja cede tras la línea actual, sin cortar HOLE.
{
  const director = new NG.AnnouncerSpeechDirector(fakeSystem());
  director.currentBundle = { id: 'old-shot', eventKey: 'SHOT_STRONG', source: 'game', policy: { class: 'important' }, items: [{ text: 'a', speaker: 'commentator' }, { text: 'b', speaker: 'informant' }] };
  director.discardNonGuaranteedPending(['HOLE', 'HOLE_IN_ONE']);
  assert(director.yieldCurrentAfterLine === true, 'Conversación vieja no cede tras la línea actual');
  const protectedDirector = new NG.AnnouncerSpeechDirector(fakeSystem());
  protectedDirector.currentBundle = { id: 'hole-current', eventKey: 'HOLE', guaranteeKey: 'h', source: 'game', policy: { class: 'supercritical', guaranteed: true }, items: [{ text: 'hoyo', speaker: 'commentator' }] };
  protectedDirector.discardNonGuaranteedPending(['HOLE', 'HOLE_IN_ONE']);
  assert(protectedDirector.yieldCurrentAfterLine === false, 'HOLE en curso fue marcado para truncarse');
}

console.log('ANNOUNCER STATE MACHINE TEST OK');
console.log(' - supercritical HOLE/HIO persistent queue');
console.log(' - informative -> gameplay handoff');
console.log(' - postmatch stale gameplay suppression');
console.log(' - late network guarantee');
console.log(' - aiming/moving activity gate');
console.log(' - informative one-shot until real action');
console.log(' - renderer optional API guards');
console.log(' - map presentation leader/favorite + contextual first touch');
console.log(' - no informative pause after postmatch');
console.log(' - HOLE priority over pending mustSpeak map lines');
console.log(' - network MAP_PRESENTATION exits client postmatch');
console.log(' - stale conversations yield after current line; HOLE remains protected');
