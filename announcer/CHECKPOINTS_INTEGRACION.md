# CHECKPOINTS — Integración de locutores en Noise Golf

## CP-01 · Mapeo
- Localizado flujo de menú, `GolfGame`, `MultiplayerSession`, reloj `netTime`, canal fiable y estados `turn`/`battle`.
- Verificado que el prototipo de locución contiene 74 eventos compartidos y bloqueo de conversación sin preempción.

## CP-02 · Aislamiento
- Creada carpeta `announcer/` con motor, manager, UI, estilos, JSON internos, fallback y calibración.
- Ningún banco narrativo fue movido al código de física o red.

## CP-03 · Menú
- Añadida pantalla `LOCUTORES` al menú principal.
- Únicos controles visibles: nombre, voz, tono, velocidad por locutor y volumen compartido.
- Preferencias locales persistentes mediante `localStorage`.

## CP-04 · Offline
- Conectados tiros, rebotes/obstáculos, peligros, hoyos, near miss y tiro largo.
- Añadido control de deduplicación y estados `trace` para que eventos secundarios den contexto sin secuestrar el micrófono.

## CP-05 · Online autoritativo
- Solo el host genera cues narrativos.
- El host compone el bloque final y lo distribuye como `announcer:bundle`.
- `startAtNetTime` alinea el inicio usando el reloj de red ya existente.
- Se amplía TTL únicamente para cubrir transporte/alineación; no se rompe la prioridad ni una conversación en curso.
- Clientes reproducen el mismo bloque pero conservan sus voces y parámetros TTS locales.

## CP-06 · Battle Royale
- Colisiones reales alimentan rivalidades, revancha/provocación y favoritos.
- Sabotaje solo se anuncia como éxito cuando una penalización confirma atribución del atacante.
- Final Four/Three/Two/Last Stand se derivan de jugadores aún no finalizados.
- Victoria usa `BATTLE_ROYALE_WINNER`.
- Alianzas/traiciones inventadas permanecen desactivadas.

## CP-07 · Verificación
- `node --check` para archivos JS modificados/nuevos.
- Parseo JSON para `config.json`, `commentator.json`, `informant.json`.
- Suite original: validate, coherence, priority, turn-lock, battle-royale y DOM.
- Validador de integración comprueba IDs del menú, orden de scripts, canal `announcer:bundle`, hooks autoritativos y carpeta dedicada.

## CP-0006 · Estados / persistencia crítica

- [x] `HOLE` y `HOLE_IN_ONE` pasan a cola `supercritical` persistente hasta ser pronunciados.
- [x] La cola garantizada espera el final de la intervención actual y tiene prioridad sobre hot-slots normales.
- [x] Un bundle supercrítico llegado tarde por red no se descarta por `lateGraceMs`.
- [x] Estado `postmatch`: invalida tiros/fillers programados que ya no representan el juego.
- [x] Estado `informative`: solo entra cuando no hay apuntado, bola rodando, intro o transición activa.
- [x] Una acción real hace ceder una conversación informativa al terminar la frase actual y recupera el micrófono.
- [x] `aim-start/aim-end` de clientes se reporta al host y nunca genera narrativa independiente en cada peer.
- [x] Offline final entra en post-partida sin cancelar el HOLE/HIO pendiente.
- [x] Al iniciar otro campo offline se reinicia la máquina narrativa a `gameplay`.
- [x] Prueba automática `announcer/tools/test_state_machine.js` valida los cuatro invariantes principales.


## CP-0007 · FIX HOYO + PAUSA INFORMATIVA ONE-SHOT

**Objetivo:** eliminar el crash visual al embocar y detener el bucle de información durante inactividad.

- [x] `spawnShockwave` protegido por detección de API antes de llamarse.
- [x] `spawnWaterRipple` protegido por la misma causa de compatibilidad.
- [x] cache-bust de `worldRenderer.js`, `game.js`, `config-data.js` y `manager.js`.
- [x] pausa informativa bloqueada después de una reproducción.
- [x] solo una acción real rearma otra futura pausa.
- [x] eliminadas frases meta de mapa estable/sin acción.
- [x] test de one-shot y guardas visuales añadido.
