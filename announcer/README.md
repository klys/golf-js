# Noise Golf — Subsistema de locución

Esta carpeta contiene el sistema completo de locución integrado en el juego.

## Estructura

- `engine.js`: composición de frases, memoria semántica, conversaciones Rafa → Álex → Rafa y director TTS sin interrupciones.
- `manager.js`: puente entre eventos del juego, contexto competitivo, favoritos/rivalidades y sincronización host → clientes.
- `ui.js` / `ui.css`: pantalla **LOCUTORES** del menú principal y ventana plegable de locución en vivo durante la partida.
- `data/commentator.json`: banco interno del locutor principal.
- `data/informant.json`: banco interno del locutor analista.
- `persona-data.js`: copia fallback de los bancos para contextos donde `fetch()` no pueda leer JSON.
- `config.json`: **archivo interno de calibración narrativa**. Los defaults visibles del usuario ya no viven aquí.
- `config-data.js`: fallback de `config.json`.
- `tools/validate_integration.py`: validación estática de la integración.

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

## Eventos conectados

Offline y online cubren, entre otros: inicio de partida/ronda, turnos, potencia del tiro, rebotes, boosters, portales, cañones, retroceso, multiplicadores, cuevas/túneles, saltos de agua, arena, hielo, ventiladores, muros móviles, casi-hoyo, tiro largo, agua, fuera de mapa, aplastamiento, hoyo, hole-in-one, colisiones entre jugadores, rivalidad, provocaciones, sabotaje confirmado, favoritos, fases finales y victoria/Battle Royale winner.

Las alianzas/traiciones especulativas están desactivadas por defecto: no se narran como hechos si el gameplay no las ha confirmado.

## Ventana de locución en vivo

Durante una partida aparece un panel plegable en el HUD con el historial reciente de las líneas que realmente entraron al director TTS. Muestra el nombre local configurado de cada locutor y sigue funcionando visualmente aunque el volumen TTS esté a 0. El estado plegado también queda guardado en el perfil local.

## Calibración futura

Para defaults de usuario editar el `config.json` general (`announcerUserDefaults`). Para lógica narrativa editar `announcer/config.json` y mantener `announcer/config-data.js` equivalente. Los bancos `data/*.json` siguen siendo internos.

## PATCH 0006 · Máquina de estados narrativa

La narración ya no depende únicamente de eventos aislados. El host mantiene una fase narrativa coherente:

- `gameplay`: existe actividad real (apuntado, bola en movimiento, obstáculos, tiros o eventos de mapa).
- `informative`: tras el umbral sin acciones, la cabina emite **una sola** pausa factual y queda en silencio. No vuelve a informar hasta que ocurra una acción real y después exista otra pausa.
- `postmatch`: la partida terminó; se descartan comentarios de gameplay que hubieran quedado programados y solo se permiten cierre, resultado y análisis final.
- `inactive`: fuera de una partida.

`HOLE` y `HOLE_IN_ONE` son eventos **supercríticos garantizados**. No expiran mientras esperan el micrófono, no cortan una frase ya iniciada y se consumen exactamente una vez al reproducirse. En online el host conserva esa garantía dentro del `announcer:bundle`, por lo que un cliente que llegue tarde al `startAtNetTime` lo reproduce inmediatamente en vez de descartarlo por TTL.

El apuntado online también forma parte del estado autoritativo: el cliente informa `aim-start/aim-end` al host y solamente el host decide si ese estado produce narración. Esto evita entrar en modo informativo mientras alguien sigue preparando un tiro.


## PATCH 0007 · pausa informativa one-shot y compatibilidad de renderer

- La pausa informativa dejó de ser periódica: se reproduce una vez por ciclo de inactividad.
- Una acción real (apuntado, tiro, bola en movimiento o evento del host) rearma una futura pausa.
- Se eliminaron las frases meta repetitivas sobre “mapa estable” o “sin acción en curso”.
- `game.js` protege `spawnShockwave()` y `spawnWaterRipple()` para que una caché de renderer antigua no rompa el bucle principal.
- `index.html` fuerza una versión nueva de los scripts críticos del renderer/juego/manager para evitar mezclas de caché.

## PATCH 0008 · Presentación de mapa y primer toque

La locución de cada mapa/hoyo tiene ahora una sección propia, separada del comentario normal de gameplay:

1. **MAP_PRESENTATION** se dispara una sola vez cuando cambia el mapa. Es `mustSpeak`: espera su turno y no se pierde por un micrófono ocupado, pero sigue por debajo de `HOLE`/`HOLE_IN_ONE` supercríticos.
2. Si existe un líder real por puntos, la presentación lo nombra con sarcasmo. Si no existe un líder claro, usa una bienvenida absurda.
3. Los favoritos persistentes de Rafa/Álex se cruzan con el líder. Si uno de los locutores tiene como favorito al líder, ese locutor toma la voz. Si los favoritos son distintos, se añade una puya de rivalidad de cabina.
4. Después de la presentación queda armado **MAP_FIRST_TOUCH**. `TURN_START`, `AIMING` y `RISKY_AIM` actualizan el estado, pero no hablan antes del primer tiro del mapa.
5. El primer tiro se comenta una sola vez según la posición del jugador: líder, último, favorito del comentarista, favorito del informante o apertura general. Después el estado pasa a `consumed` y el resto del mapa vuelve a la narrativa normal.
6. En online el host decide presentación, favorito, posición, texto y `startAtNetTime`; los clientes solo reproducen el bundle. Un `MAP_PRESENTATION` nuevo también saca a los clientes de `postmatch`.
7. En `postmatch` no se vuelve a abrir una pausa informativa. Solo sobreviven `HOLE`/`HOLE_IN_ONE`, victoria/cierre y los resúmenes post-partida explícitos.

Los textos exclusivos de esta sección viven en `announcer/data/map-intro.json` y su fallback `announcer/map-intro-data.js`. El banco incorpora 257 frases/fragmentos dedicados a bienvenida, líder, favoritos, rivalidad y primer toque, sin modificar los 74 eventos originales de `commentator.json` / `informant.json`.
