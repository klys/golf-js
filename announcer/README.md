# Noise Golf — Subsistema de locución

Esta carpeta contiene el sistema completo de locución integrado en el juego.

## Estructura

- `engine.js`: composición de frases, memoria semántica, conversaciones Rafa → Álex → Rafa y director TTS sin interrupciones.
- `manager.js`: puente entre eventos del juego, contexto competitivo, favoritos/rivalidades y sincronización host → clientes.
- `ui.js` / `ui.css`: pantalla **LOCUTORES** del menú principal.
- `data/commentator.json`: banco interno del locutor principal.
- `data/informant.json`: banco interno del locutor analista.
- `persona-data.js`: copia fallback de los bancos para contextos donde `fetch()` no pueda leer JSON.
- `config.json`: **archivo de calibración** que sí está pensado para editarse más adelante.
- `config-data.js`: fallback de `config.json`.
- `tools/validate_integration.py`: validación estática de la integración.

## Configuración visible al jugador

La interfaz solo expone:

1. nombre de cada locutor;
2. voz TTS de cada locutor;
3. tono de cada locutor;
4. velocidad de cada locutor;
5. un volumen compartido para ambos.

Estas preferencias se guardan localmente en `localStorage` y NO se sincronizan por red: cada jugador puede elegir cómo oye a los locutores.

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

## Calibración futura

Editar `config.json` y mantener `config-data.js` equivalente. Los bancos `data/*.json` son internos y no necesitan tocarse para calibrar umbrales, cadencias, sincronización o probabilidades sociales.
