#!/usr/bin/env node
'use strict';

/**
 * Audita qué eventos del banco tienen un emisor real en el juego.
 *
 * Un evento con frases escritas y sin ningún camino de código que lo dispare es
 * contenido muerto: ocupa el JSON, se mantiene, se traduce y nunca suena. Este
 * script existe para que esa deuda no vuelva a acumularse en silencio.
 *
 *   node announcer/tools/audit_event_coverage.js
 *
 * Sale con código 1 si aparece un evento muerto que no esté en ALLOWED_DEAD.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const SOURCES = ['js/core/game.js', 'js/network/multiplayerSession.js', 'announcer/manager.js'];

// Eventos sin emisor a propósito, con el motivo por el que se conservan.
const ALLOWED_DEAD = {
  WIND_PUSH: 'El juego no simula viento: solo ventiladores, que ya emiten FAN_PUSH.',
};

const bank = JSON.parse(fs.readFileSync(path.join(ROOT, 'announcer/data/commentator.json'), 'utf8'));
const events = Object.keys(bank.events);
const code = SOURCES.map((rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')).join('\n');

const alive = [];
const dead = [];
for (const eventKey of events) {
  // Cubre las formas reales de emisión: llamada directa, ternario, serie de
  // física, variable intermedia y reasignación social dentro del manager.
  const quoted = `'${eventKey}'`;
  const hit = code.includes(quoted)
    && new RegExp(`(announceEvent|onOfflineEvent\\??\\.?\\(?|emitAnnouncerCue|fireSerial|fire\\(|phaseEvent\\s*=|primary\\s*=|extra\\s*=|eventKey\\s*=|aside\\s*=|\\?|:)\\s*[^\\n]{0,120}${quoted}`).test(code);
  (hit ? alive : dead).push(eventKey);
}

const unexpected = dead.filter((eventKey) => !ALLOWED_DEAD[eventKey]);

console.log(`COBERTURA DE EVENTOS · ${alive.length}/${events.length} con emisor`);
for (const eventKey of dead) {
  const reason = ALLOWED_DEAD[eventKey];
  console.log(`  ${reason ? '·' : '✗'} ${eventKey}${reason ? ` — ${reason}` : ' — SIN EMISOR'}`);
}
if (unexpected.length) {
  console.error(`\nHay ${unexpected.length} evento(s) con frases escritas y sin emisor: ${unexpected.join(', ')}`);
  console.error('Cablea el evento o documéntalo en ALLOWED_DEAD explicando por qué no existe.');
  process.exit(1);
}
console.log('\nSin contenido muerto no justificado.');
process.exit(0);
