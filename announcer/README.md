# Noise Golf — Subsistema de locución

Esta carpeta contiene el sistema completo de locución integrado en el juego.

## Estructura

- `engine.js`: composición de frases, memoria semántica, conversaciones Rafa → Álex → Rafa y director TTS sin interrupciones.
- `manager.js`: puente entre eventos del juego, contexto competitivo, favoritos/rivalidades y sincronización host → clientes. Aquí viven también el perfil por modo, el control de caudal, el foco narrativo, la cabina viva, la memoria de partida y el tick de eventos derivados.
- `ui.js` / `ui.css`: pantalla **LOCUTORES** del menú principal y ventana plegable de locución en vivo durante la partida.
- `data/commentator.json`: banco interno del locutor principal.
- `data/informant.json`: banco interno del locutor analista.
- `data/map-intro.json`: presentación de mapa y primer toque.
- `data/rivalry.json`: rivalidad de cabina, rivalidad entre jugadores, gags acumulativos, cambio de foco, conectores retrospectivos y frases propias de cada modo.
- `persona-data.js` / `map-intro-data.js` / `rivalry-data.js`: copias fallback de los bancos para contextos donde `fetch()` no pueda leer JSON (por ejemplo `file://`).
- `config.json`: **archivo interno de calibración narrativa**. Los defaults visibles del usuario ya no viven aquí.
- `config-data.js`: fallback de `config.json`. **Se genera desde él**, no se edita a mano.
- `tools/`: validación y calibración (ver más abajo).

## Configuración visible al jugador

La interfaz solo expone:

1. nombre de cada locutor;
2. voz TTS de cada locutor;
3. tono de cada locutor;
4. velocidad de cada locutor;
5. un volumen compartido para ambos.

Estas preferencias se guardan dentro del perfil local `noiseGolf.profile.v1` bajo la clave `announcer` y NO se sincronizan por red: cada jugador puede elegir cómo oye a los locutores. Los valores iniciales para usuarios nuevos se configuran en el `config.json` general, dentro de `announcerUserDefaults`. Si existe una configuración antigua `noiseGolf.announcer.v1`, se migra una sola vez al perfil.

## Autoridad online

En online el cliente nunca decide qué frase toca.

1. El **host** detecta el hecho de gameplay.
2. El host emite un cue interno con jugador, rival, golpes, puntos y modo.
3. `manager.js` actualiza contexto, prioridad, rivalidades/favoritos y compone el bloque definitivo.
4. El host envía `announcer:bundle` por el canal fiable con `startAtNetTime`.
5. Host y clientes programan el mismo bloque contra el reloj autoritativo; el host amplía el lead si detecta RTT alto en la sala.
6. Cada máquina lo reproduce con sus voces/nombres/tono/velocidad/volumen locales.

De esta forma se sincroniza **qué se dice y cuándo empieza**, sin obligar a que todos tengan instalada la misma voz del sistema operativo.

El **tick narrativo** que deriva eventos nuevos corre solo en el host (o en offline). Los clientes no derivan nada: siguen limitándose a reproducir el bundle que reciben.

## Eventos conectados

**73 de los 74 eventos del banco tienen emisor.** El único sin emisor es `WIND_PUSH`, porque el juego no simula viento: solo ventiladores, que ya disparan `FAN_PUSH`. `tools/audit_event_coverage.js` verifica esto y falla si aparece contenido muerto nuevo sin justificar.

Los eventos llegan por tres caminos:

1. **Físicos directos** — `game.js` (offline) y `multiplayerSession.js` (host) disparan rebotes, boosters, portales, cañones, túneles, agua, fuera de mapa, hoyo, hole-in-one, colisiones, fases de battle royale y victoria.
2. **Derivados del gesto** — `classifyShot()` en el manager convierte potencia + distancia al hoyo en `SHOT_WEAK` / `SHOT_STRONG` / `SHOT_PERFECT` / `SHOT_BAD`, y añade `POWER_MAX` / `POWER_LOW` como lectura aparte.
3. **Derivados del tick narrativo** (`narrativeTick`, ~4 Hz, solo host/offline) — vuelo de la bola (`BALL_AIR`, `BALL_HIGH`, `BALL_FAST`, `FALL_START`, `VOID_FALL`, `EDGE_SAVE`), marcador (`LEAD_CHANGE`, `TIE`, `COMEBACK`, `SCORE_UPDATE`, `PLAYER_ELIMINATED`, `DOUBLE_ELIMINATION`) y turnos (`FINAL_TURN`, `AFK_WAIT`, demora de turno).

Y por lectura social dentro de `socializeEvent()`, que puede **elevar** un evento a otro: un choque contra el líder pasa a `LEADER_ATTACKED`, un choque entre los favoritos de ambos locutores pasa a `FAVORITES_COLLIDE`, dos choques seguidos pasan a `CHAIN_COLLISION`, y una penalización propia justo después de empujar a otro pasa a `SABOTAGE_BACKFIRE`.

Las alianzas/traiciones especulativas siguen desactivadas por defecto (`socialNarrative`). La detección existe, pero no se narran como hechos si el gameplay no las ha confirmado.

## Perfiles por modo

Una partida por turnos y un battle royale de ocho bolas no son el mismo trabajo de locución. `config.json → modeProfiles` define tres perfiles:

| | `offline` | `turn` | `battle` |
|---|---|---|---|
| líneas por bloque | 3 | 3 | 2 |
| escala de diálogo | 1 | 1,35 | 0,45 |
| escala de longitud | 1 | 1,15 | 0,8 |
| presupuesto de habla | 50 % | 55 % | 72 % |
| foco narrativo | no | por turno | por relevancia |
| overrides de evento | — | `TURN_START` sube de clase | rebotes/terreno bajan a traza, tiros bajan de clase |

En turnos hay huecos naturales entre tiros: cabe la conversación Rafa → Álex → Rafa, el análisis largo y el desacuerdo de cabina. En battle hay caos simultáneo: líneas cortas, sin desacuerdos de dos líneas, y filtrado agresivo.

## Control de caudal

Antes el dedupe era solo por jugador+evento: ocho bolas cayendo al agua a la vez producían ocho bloques y ninguno filtraba a otro. `config.json → flow` añade cuatro frenos, todos exentos para `HOLE` / `HOLE_IN_ONE`:

1. **Hueco global** (`globalMinGapMs`) — protege contra ráfagas del mismo frame del host.
2. **Enfriamiento por clase semántica** (`semanticCooldownMs`) — ocho desgracias idénticas y simultáneas son una noticia, no ocho.
3. **Tope de líneas por ventana** (`maxLinesPerWindow`).
4. **Presupuesto de habla** (`speechBudget`) — el freno que de verdad importa. Una línea tarda entre 2 y 5 segundos en decirse; contar líneas no basta. Se mide el tiempo hablado estimado dentro de la ventana y se compara con una fracción de ella.

Los eventos `critical` pagan tarifa reducida (×0,45 en enfriamientos, ×1,25 en presupuesto). Los `supercritical`/garantizados no pagan nada.

## Foco narrativo

Un comentarista mira a alguien. `config.json → focus` define a quién:

- `turn`: el jugador al que le toca.
- `relevance`: cambia cuando ocurre algo importante (`importance >= 4`) o cuando el foco actual ya se mantuvo `minHoldMs`.
- `local` / desactivado: en offline no hay a quién elegir.

Lo que pasa **fuera del foco** no se calla, pero pesa menos: prioridad ×`offFocusPriorityScale` y una bajada de clase (`critical` → `important`, `important` → `progressive`). Así una bola cualquiera no le quita el micrófono al duelo que la cabina está narrando, sin dejar de contar lo verdaderamente grave.

El cambio de plano puede anunciarse (`focusSwitch.*` en `rivalry.json`), pero es cosmético: si no cabe en el presupuesto de habla, cede. En modo por turnos no se anuncia nunca, porque `TURN_START` ya cuenta ese relevo.

## Cabina viva

- **Apuestas** — Rafa apuesta sobre un apuntado arriesgado o un golpe fuerte, Álex acepta con datos, y el resultado siguiente del mismo jugador la cobra (`booth.bets`). Si la ventana expira sin resolverse, se cierra con una línea de apuesta huérfana.
- **Desacuerdos** — Álex contradice la lectura de Rafa en eventos importantes (`booth.disagreement`). Necesita las dos mitades para entenderse, así que solo aparece donde caben tres líneas: turnos y offline.
- **Favoritos** — defensa del propio favorito y pulla al del otro (`booth.favoriteDefense`, `booth.favoriteMockery`). `FAVORITE_FALL` se dispara cuando un favorito es desplazado.

Nunca se permiten tres frases seguidas de la misma voz dentro de un bloque: la tercera se descarta antes que romper la sensación de cabina.

## Memoria de partida

`ledger` cuenta por jugador aguas, salidas del mapa, reinicios, arena, casi-hoyos, sabotajes hechos y sufridos, hoyos y mejor racha. Al cruzar el umbral (`memory.thresholds`) y cada `repeatEvery` repeticiones después, sale un gag acumulativo de `runningGags.*`: *"Agua otra vez. Van 3. Nina está haciendo un estudio hidrográfico completo del mapa."*

## Frescura

El texto se compone cuando ocurre el hecho, pero suena cuando hay micrófono. Si el bloque esperó:

- menos de `staleShortMs` → se narra tal cual;
- más → se le antepone un conector retrospectivo (*"Rescato lo que el caos no me dejó contar:"*);
- más de `staleDropMs` y no es garantizado → se descarta.

En cliente el retraso se mide desde `localEventAt` (sello de recepción), no desde `eventAt` (reloj del host), que no es comparable.

## Ventana de locución en vivo

Durante una partida aparece un panel plegable en el HUD con el historial reciente de las líneas que realmente entraron al director TTS. Muestra el nombre local configurado de cada locutor y sigue funcionando visualmente aunque el volumen TTS esté a 0. El estado plegado también queda guardado en el perfil local.

## Máquina de estados narrativa actual

La cabina trabaja con tres fases reales:

- `gameplay`: partida activa; solo hablan eventos reales, presentación de mapa, primer toque y narrativa competitiva.
- `postmatch`: la partida terminó; se descartan comentarios viejos de gameplay y solo sobreviven `HOLE`/`HOLE_IN_ONE`, cierre/victoria y los resúmenes post-partida explícitos.
- `inactive`: fuera de una partida.

La antigua fase de pausa `informative` fue **eliminada en PATCH 0009** y sigue eliminada. No hay filler periódico ni comentario automático porque el jugador esté esperando. La única excepción es `AFK_WAIT` en modo por turnos, que no es relleno de silencio sino un hecho de juego: un jugador está bloqueando la partida de los demás. Se puede apagar con `derivedEvents.afkEnabled: false`.

`HOLE` y `HOLE_IN_ONE` siguen siendo eventos **supercríticos garantizados**. No expiran mientras esperan el micrófono, no cortan una frase ya iniciada, no los frena el control de caudal y se consumen exactamente una vez al reproducirse.

## No cortar, pero tampoco bloquear

El director nunca corta una frase a mitad. Lo que sí hace ahora:

- **Lee `nearEndMs`** de cada política: un evento tolera algo de margen sobre su TTL cuando el micrófono está a punto de quedar libre. Sin esto, en el caos casi nada llegaba a entrar.
- **Lee `preempt`**: si llega algo de clase superior, el bloque en curso cede el micrófono **al terminar la frase que está diciendo**. El corte se produce entre oraciones, nunca dentro de una.
- **Espera al `onstart` de la voz** antes de armar el watchdog de silencio. Antes, una voz lenta en cargar se interpretaba como frase terminada: los subtítulos se adelantaban al audio y la estimación de fin de bloque quedaba corrupta.

## Herramientas

```bash
node announcer/tools/test_state_machine.js       # director de voz y garantías
node announcer/tools/test_narrative_layers.js    # capas narrativas nuevas
node announcer/tools/audit_event_coverage.js     # eventos sin emisor
python announcer/tools/validate_integration.py   # integración con el resto del juego
node announcer/tools/preview_transcript.js battle|turn|offline
```

`preview_transcript.js` imprime la transcripción de una partida simulada con reloj falso: es la forma barata de calibrar tono, ritmo y densidad sin abrir el navegador. Al final da la densidad en líneas por minuto, que es la métrica a vigilar (una línea cuesta entre 2 y 5 segundos de habla real).

## Calibración

- Defaults de usuario: `config.json` **general** del juego (`announcerUserDefaults`).
- Lógica narrativa: `announcer/config.json`. Después regenera el fallback:

  ```bash
  node -e "const fs=require('fs');const j=JSON.parse(fs.readFileSync('announcer/config.json','utf8'));fs.writeFileSync('announcer/config-data.js','// Generado desde announcer/config.json. Fallback para contextos sin fetch().\n// Si editas config.json, regenera este archivo para mantenerlos equivalentes.\nwindow.NOISE_GOLF_ANNOUNCER_CONFIG = '+JSON.stringify(j,null,2)+';\n','utf8')"
  ```

- Frases: los `data/*.json`. Tras tocarlos regenera `persona-data.js` / `rivalry-data.js` igual (`window.EMOTIONAL_MACHINE_PERSONAS` y `window.NOISE_GOLF_RIVALRY_DATA`), **conservando la indentación original de cada JSON** (2 espacios) para que el diff siga siendo legible.

### Perillas más útiles

| Quiero… | Toco |
|---|---|
| que hable más o menos | `modeProfiles.<modo>.speechBudget` |
| menos repetición de la misma clase de suceso | `flow.semanticCooldownMs` |
| más o menos diálogo entre locutores | `modeProfiles.<modo>.dialogueScale` |
| que el foco cambie más despacio | `focus.minHoldMs`, `focus.switchCooldownMs` |
| más o menos apuestas y desacuerdos | `booth.betChance`, `booth.disagreementChance` |
| gags recurrentes más pronto o más tarde | `memory.thresholds`, `memory.repeatEvery` |
| apagar el aviso de turno eterno | `derivedEvents.afkEnabled: false` |
| que vuelva a rotar menos el banco tonal | `generation.semanticBiasByKind` en cada persona |
