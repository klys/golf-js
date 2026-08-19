(function (NG) {
  'use strict';

  NG.CONFIG = Object.freeze({
    course: Object.freeze({
      holeCount: 3,
      minWidth: 4200,
      maxWidth: 12800,
      minHeight: 1600,
      maxHeight: 3400,
      terrainStep: 20,
      metersPerPixel: 1 / 18,
      startPadding: 300,
      cupPadding: 420,
      worldMargin: 220,
      topFlightMargin: 2600,
      bottomFallMargin: 820,
    }),
    generation: Object.freeze({
      minSurfaceClearance: 185,
      islandMinWidth: 480,
      islandMaxWidth: 2200,
      islandMaxRise: 520,
      islandMaxGap: 900,
      caveMinClearance: 210,
      caveMaxClearance: 430,
      maxGroundSlope: 0.78,
      safeRadiusTee: 245,
      safeRadiusCup: 165,
      portalPairsMax: 2,
      fanZonesMax: 3,
      movingPlatformsMax: 2,
      cannonMax: 2,
      // Uno por mundo y punto: ver abajo por qué.
      reverseCannonMax: 1,
      secretCavesMax: 2,
      gravityWellsMax: 2,
      movingWallsMax: 3,
      spinnersMax: 3,
      iceZonesMax: 6,
      cupWorldInsetX: 260,
      cupWorldInsetTop: 170,
      cupWorldInsetBottom: 120,
      cupSurfaceEdgeClearance: 118,
      cupReachMaxRise: 980,
      cupReachMaxGap: 1850,
    }),
    ball: Object.freeze({
      radius: 13,
      gravity: 790,
      airDrag: 0.998,
      fairwayFriction: 0.985,
      roughFriction: 0.950,
      sandFriction: 0.885,
      iceFriction: 0.9965,
      groundBounce: 0.42,
      roofBounce: 0.58,
      settleSpeed: 24,
      maxSpeed: 1660,
      rollingGravityScale: 0.40,
    }),
    // — Rebote en el agua (piedra picada) —
    // El agua deja de ser un muro que castiga y pasa a ser una apuesta: un
    // tiro RASO y RÁPIDO no se hunde al tocarla, pica y sale despedido, igual
    // que una piedra lanzada de canto. Cruzar la charca por arriba es la
    // jugada de riesgo, y por eso pide las dos cosas a la vez —ángulo y
    // velocidad—: sin las dos, la bola entra al agua como siempre.
    water: Object.freeze({
      // Picados máximos por charca y tiro. Al siguiente contacto gana el agua.
      skipMaxBounces: 2,
      // Por debajo de esta velocidad no hay energía para picar.
      skipMinSpeed: 430,
      // Velocidad a la que la ventana de ángulo se abre del todo.
      skipFullSpeed: 1050,
      // Ventana de ángulo contra la lámina (grados): rasante rebota, picado se
      // hunde. La velocidad ENSANCHA la ventana —un misil raso perdona más
      // ángulo que un globo—, que es lo que premia tirar fuerte y plano.
      skipMinAngleDegrees: 20,
      skipMaxAngleDegrees: 38,
      // Qué conserva el bote: el horizontal casi entero (picar apenas frena)
      // y menos de la mitad del vertical, así los picados se van aplanando y
      // el segundo sale solo si el primero fue bueno.
      skipVerticalBounce: 0.48,
      skipHorizontalKeep: 0.90,
      // Empujón vertical mínimo: un roce rasante tiene que despegar de verdad
      // en vez de quedarse rozando la lámina y gastar los dos picados en el
      // mismo sitio.
      skipMinLift: 96,
      // Margen sobre la lámina al salir y tolerancia del cruce hacia abajo.
      skipClearance: 2.5,
      skipEntryTolerance: 8,
    }),

    // — Pozos de gravedad —
    // Repulsión y atracción NO son el mismo campo con el signo cambiado.
    // Empujar hacia fuera es seguro por construcción: por muy fuerte que sea,
    // un repulsor no puede quedarse con la bola. Atraer sí es peligroso —un
    // tirón radial fuerte acaba con la bola orbitando el centro para siempre,
    // y eso no es un obstáculo, es una partida colgada—. Así que la atracción
    // se diseña para DOBLAR la trayectoria, nunca para capturarla.
    gravityWell: Object.freeze({
      influenceScale: 1.5,

      // Repulsión: radial pura y a plena potencia.
      repelScale: 1.85,
      repelFalloff: 1.4,
      repelSwirl: 0.16,

      // Atracción, con tres seguros contra la captura. Subir más de aquí no
      // desvía más: al curvar antes, la bola sale antes del campo y el efecto
      // se satura solo. Lo único que crece pasados estos valores es el tiempo
      // que la bola pasa dentro, que es justo lo que no interesa.
      attractScale: 2.80,
      attractFalloff: 1.15,
      // 1) Núcleo muerto. Dentro de esta fracción del radio el tirón se apaga:
      //    no hay fondo al que caer, así que la bola cruza el centro recta en
      //    vez de quedarse dando vueltas dentro.
      attractCoreRatio: 0.55,
      // 2) Reparto del tirón. La componente PERPENDICULAR a la velocidad —la
      //    que curva sin cambiar la rapidez— va entera; la radial solo actúa
      //    mientras la bola SE ACERCA. Nunca frena a la que se va, así que
      //    cada pasada sale con más energía de la que entró: escapar está
      //    garantizado por la propia forma del campo.
      attractPullScale: 0.55,
      attractSwirl: 0.09,
      // 3) Suelo de velocidad: a una bola lenta el pozo la suelta. Sin esto,
      //    una que llega rodando se quedaría pegada a la ladera de debajo.
      attractMinSpeed: 105,
      attractFullSpeed: 320,
      // Válvula de escape final: si un pozo lleva más de este tiempo tirando
      // de la misma bola, se apaga poco a poco. Es la red que garantiza que
      // ninguna partida se quede colgada de un imán.
      holdReleaseSeconds: 1.15,
      holdFadeSeconds: 0.55,
    }),

    // — Cañón de retroceso —
    // Un cañón montado al revés: en vez de acercarte al hoyo te devuelve campo
    // atrás, y con bastante más fuerza que uno normal. Es la única pieza del
    // mapa que QUITA progreso en lugar de darlo, y eso obliga a tres cosas:
    // que haya como mucho una por mundo, que se vea desde lejos, y que su
    // colocación esté calculada. Pisarla tiene que ser un error del jugador,
    // nunca una emboscada.
    reverseCannon: Object.freeze({
      width: 104,
      // Ángulo de disparo sobre la horizontal (grados), alrededor de los 45º
      // que dan el alcance máximo. Arco alto a propósito: así el retroceso es
      // un viaje largo que se puede seguir con la vista, no un empujón seco
      // que deja al jugador sin saber qué le ha pasado.
      minAngleDegrees: 34,
      maxAngleDegrees: 48,
      // Fuerza. El suelo ya supera al cañón normal (760-1060): esa es la gracia.
      minPower: 1180,
      maxPower: 1520,
      // La potencia real NO es aleatoria: sale de la pista que queda por
      // detrás. El generador mide cuánto mapa hay hacia atrás y dispara lo
      // justo para aprovecharlo. Esta fracción es solo la parte VOLADA: medido
      // en simulación, la bola recorre rodando y rebotando otro tanto o más
      // después de aterrizar, así que reservar la mitad de la pista para ese
      // segundo tramo es lo que evita que el retroceso acabe fuera del mundo.
      runwayUsage: 0.50,
      // Pista mínima por detrás para que la pieza pueda existir siquiera. Sin
      // ella el retroceso acabaría fuera del mapa, y eso ya no es perder
      // terreno: es un golpe de penalización con otro nombre.
      minRunway: 3200,
      runwayMargin: 260,
      // Holgura mínima por DELANTE (el lado del hoyo). Parece innecesaria —la
      // pieza dispara hacia el otro lado— pero medida en simulación es la
      // causa principal de que la bola acabe fuera: sale hacia atrás, rebota
      // contra el terreno y se escapa por el lado contrario, que es justo el
      // que nadie había comprobado.
      minForwardClearance: 900,
      // Por debajo de esta dificultad no aparece: los hoyos fáciles enseñan a
      // jugar y no son el sitio para la pieza que castiga. El valor está
      // medido, no elegido a ojo —la dificultad generada va de 0.35 a 0.98 con
      // mediana 0.75—, así que 0.55 deja fuera el cuarto más asequible. Un
      // umbral por debajo de 0.35 no haría absolutamente nada.
      minDifficulty: 0.55,
    }),

    // — Música —
    // Una sola pista y suena solo dentro de la partida: el menú se queda en
    // silencio a propósito, para que darle a JUGAR tenga entrada musical.
    audio: Object.freeze({
      musicTrack: './assets/music/INTERESTELLAR.mp3',
      // Volumen la primera vez que se juega. A partir de ahí manda lo que el
      // jugador deje en el control, que se guarda en su navegador.
      defaultMusicVolume: 0.45,
      // La pista se repite mientras dure el mapa; los hoyos duran más que ella.
      loop: true,
      // Fundidos. Cortar una pista en seco se oye como un fallo del juego, y
      // aquí hay un corte cada vez que cambia el mapa. La salida es más rápida
      // que la entrada porque al salir el jugador ya está mirando otra cosa.
      fadeInSeconds: 1.2,
      fadeOutSeconds: 0.5,

      // — Mezcla viva —
      // TODO lo que sigue se mueve dentro del volumen del jugador: su ajuste
      // es el techo, no el nivel. Por eso el reposo está por debajo de 1, para
      // que quede sitio donde crecer sin pasarse nunca de lo que pidió.
      // El reparto del techo: la música vive al 60 % del volumen del jugador y
      // el 40 % restante NO se usa nunca en juego normal — está guardado
      // entero para la aproximación al hoyo. Ese margen es el efecto: lo que
      // convierte acercarse a la copa en algo que se oye, no en un detalle.
      baseLevel: 0.60,
      baseCutoff: 20000,
      baseReverb: 0.10,
      maxReverb: 0.85,
      // Cuánto se aparta el sonido seco al mojar la mezcla. Con reverb fuerte
      // esto deja de ser cosmético: sin ceder sitio, la sala se suma entera al
      // seco y lo que se oye es un subidón de volumen, no un espacio grande.
      dryDuck: 0.55,
      // Suavizados (1/s). El nivel manda: demasiado rápido suena a automático
      // de radio, demasiado lento y el efecto llega cuando ya no viene a cuento.
      levelResponse: 2.4,
      bassResponse: 1.6,
      cutoffResponse: 5.5,
      // Mientras dura un golpe la mezcla reacciona mucho más rápido. Es lo
      // mismo que hace un compresor de verdad: ataque corto y recuperación
      // larga. Con el suavizado musical, el hundimiento del agua llegaba a
      // media caída justo cuando el sobre ya estaba subiendo, y en vez de un
      // chapuzón se oía un bajón vago.
      impactResponse: 9,

      // Cercanía al hoyo — cuenta la bola que enfoca la cámara.
      // El radio es deliberadamente enorme: más ancho que una pantalla de
      // juego, así que la aproximación no es un interruptor que salta al final
      // sino una cuesta larga que se va sintiendo. La curva sigue guardando lo
      // más gordo para los últimos metros: acercarse se insinúa, llegar suena
      // a final. Y la sala se abre de par en par, que es lo que hace épico un
      // final: no más volumen, más sitio.
      holeRange: 2600,
      holeCurve: 1.8,
      holeLevel: 1.0,
      holeReverb: 0.72,

      // Vuelo largo. Una bola que sigue viva pasados unos segundos es una bola
      // a la que está pasando algo: graves que crecen y algo más de cuerpo.
      rallySeconds: 5,
      rallyRampSeconds: 4,
      rallyBassDb: 9,
      rallyLevel: 0.16,
      rallyReverb: 0.16,
      // Al pararse, la tensión se deshace más rápido de lo que se acumuló: si
      // se vaciara al mismo ritmo, el tiro siguiente empezaría cargado.
      rallyReleaseRate: 3.5,
      bassFrequency: 160,

      // Golpes de ambiente. `curve` alta = el hundimiento es inmediato y la
      // recuperación lenta, que es como suena de verdad caerse al agua.
      impactCurve: 1.6,
      impacts: Object.freeze({
        // Agua: se hunde. Filtro cerrado, casi sin volumen y la sala se apaga.
        water: Object.freeze({ level: 0.20, cutoff: 380, reverb: 0.05, bassDb: -3, seconds: 1.8 }),
        // Fuera del mapa: no se hunde, se aleja. Menos filtro y más sala, como
        // si la música se quedara atrás con el resto del mundo.
        lost: Object.freeze({ level: 0.26, cutoff: 1100, reverb: 0.50, bassDb: 0, seconds: 1.5 }),
      }),

      // — Ventana en segundo plano —
      // Minimizar o irse a otra ventana no para la música: la TAPA. Baja
      // mucho y se filtra, como si sonara desde la habitación de al lado.
      // Irse es rápido (estorba en cuanto dejas de mirar) y volver es lento a
      // propósito: el regreso progresivo es lo que hace que se note.
      awayLevel: 0.16,
      awayCutoff: 620,
      awaySeconds: 0.35,
      returnSeconds: 2.4,

      // Cola del reverb generado. Se sintetiza al vuelo: un impulso de sala es
      // ruido que se apaga, y traerlo como archivo sería otro asset que
      // mantener para algo que nadie distinguiría.
      reverbSeconds: 3.4,
      reverbDecay: 2.1,
      // Limitador de salida. Con la sala abierta al máximo, el reverb suma
      // energía encima del seco y el maestro ya está al tope del jugador: sin
      // techo duro, los picos se salen del rango y eso no se oye como fuerza,
      // se oye como distorsión. Es la red que permite pedir reverb fuerte sin
      // pagarlo en calidad.
      limiterThresholdDb: -1.5,
      limiterRatio: 20,
      limiterAttack: 0.003,
      limiterRelease: 0.25,
    }),

    shot: Object.freeze({
      maxDrag: 220,
      powerScale: 6.15,
      minLaunchSpeed: 44,
      previewSteps: 94,
      previewDt: 1 / 36,
    }),
    wind: Object.freeze({
      minMps: 0.4,
      maxMps: 7.6,
      gustStrength: 0.20,
      directionWobbleRadians: 0.10,
      accelerationPerMps: 12.5,
    }),
    camera: Object.freeze({
      // Punto de la pantalla donde vive la bola (0..1). La bola va algo a la
      // izquierda y ligeramente bajo el centro para dejar ver hacia dónde va.
      anchorX: 0.34,
      anchorY: 0.54,

      lookAheadX: 205,
      lookAheadY: 150,
      // Velocidad a la que el adelanto llega a su máximo.
      lookAheadRefSpeed: 900,
      // El adelanto tiene su propio filtro: un rebote invierte la velocidad en
      // un frame y sin esto la cámara daría un latigazo en cada bote.
      lookAheadResponsiveness: 3.2,

      // Tiempo de asentamiento del muelle críticamente amortiguado. Más alto =
      // más suave y más "cinematográfico"; más bajo = más pegado a la bola.
      followSmoothTime: 0.34,
      fastSmoothTime: 0.13,
      zoomSmoothTime: 0.30,
      // Techo de velocidad de la cámara. Una recuperación larga la lanzaba a
      // varias veces la velocidad máxima de la bola y luego frenaba en seco al
      // alcanzarla. Con techo, ese barrido se lee como una panorámica.
      maxFollowSpeed: 2400,

      // Zona muerta (píxeles de pantalla): dentro de ella la cámara NO se
      // mueve. Es lo que mata el temblor de la bola rodando o asentándose.
      deadZoneX: 46,
      deadZoneY: 38,

      // Correa de seguridad: margen mínimo hasta el borde. Si el suavizado se
      // queda atrás, la cámara se pega a la bola aquí. Nunca se pierde.
      leashMarginX: 0.24,
      leashMarginY: 0.22,
      // Salto de foco mayor que esto = corte (portal, penalización, cambio de
      // turno). Ahí se corta en seco en vez de barrer el mapa.
      cutDistance: 900,

      // Sacudida de impacto: un golpe direccional que oscila y muere, no ruido
      // blanco por frame (que es lo que se percibe como "zumbido").
      shakeFrequency: 14,
      shakeDamping: 6.5,
      maxShake: 13,

      zoomResponsiveness: 5.0,
      minZoom: 0.60,
      maxZoom: 1.10,
      restZoom: 0.98,
      flightZoom: 0.80,
      aimZoom: 0.90,
    }),
    // Presentación del hoyo: la cámara enseña la bandera y recorre el campo
    // hasta la salida antes de dar el control. Es solo cámara —no toca física
    // ni red— y se salta con cualquier tecla o clic.
    holeIntro: Object.freeze({
      enabled: true,

      // 1 · Panorámica: el mapa entero en pantalla.
      panoramaSeconds: 1.5,
      // Se abre un pelín de más y se cierra despacio hasta el encuadre exacto.
      // Un plano completamente fijo no se lee como una cámara.
      panoramaOvershoot: 0.93,
      // Margen que queda alrededor del mapa al encuadrarlo entero.
      panoramaFit: 0.94,
      // Suelo de zoom durante la presentación, muy por debajo del de juego.
      // Los mapas grandes rondan los 11.000 px de ancho: con un suelo alto la
      // "panorámica" se quedaba sin enseñar el mapa entero, que es su motivo
      // de existir. Solo es un tope de seguridad.
      panoramaMinZoom: 0.07,

      // 2 · Bajada del plano general hasta la bandera.
      approachSeconds: 1.8,
      // 3 · Quieto sobre la copa, abriendo plano.
      holdSeconds: 0.85,
      // 4 · Recorrido de la copa a la salida siguiendo el relieve.
      // Es un SUELO, no una duración fija: el recorrido se alarga en los mapas
      // largos para que el barrido se vea siempre al mismo ritmo. Con duración
      // fija, un mapa de 11.000 px salía disparado y uno corto se arrastraba.
      travelSeconds: 3.0,
      travelMaxSeconds: 4.6,
      // Velocidad aparente máxima del barrido, en píxeles de PANTALLA por
      // segundo. Es lo que de verdad percibe el ojo, y de ahí sale la duración.
      travelPeakScreenSpeed: 1380,
      // 5 · Aterrizaje en el encuadre de juego.
      settleSeconds: 0.8,

      cupZoom: 1.02,
      travelZoom: 0.72,
      // Cuánto se abre el plano en mitad del recorrido, como fracción de
      // `travelZoom`. Abrir ahí cumple dos funciones: deja leer el trazado
      // entero y, sobre todo, reduce la velocidad APARENTE del barrido, que
      // es lo que separa una panorámica de un latigazo. Vuelve a 1 en los dos
      // extremos, así que el enlace con la bandera y con el aterrizaje sigue
      // siendo continuo.
      travelBreath: 0.55,
      // Suelo de esa apertura. En los mapas más largos el tope de tiempo se
      // queda corto y el respiro se abre solo hasta aquí para mantener el
      // ritmo sin alargar más la presentación.
      travelBreathMin: 0.2,
    }),

    gameplay: Object.freeze({
      waterPenaltyStroke: 1,
      outOfBoundsPenaltyStroke: 1,
      crushPenaltyStroke: 1,
      crushMinWallSpeed: 28,
      crushSupportGap: 5,
      holeRadius: 22,
      cupDepth: 17,

      // — Succión de la copa —
      // Imán corto pero decidido. El radio es pequeño a propósito: no está
      // para corregir tiros malos, sino para que rozar el borde termine
      // dentro en vez de pasar de largo por dos píxeles.
      holeSuctionRadius: 76,
      holeSuctionStrength: 1500,
      // Exponente de caída. Alto = casi todo el tirón vive pegado al borde.
      holeSuctionFalloff: 1.8,
      // Por encima de esta velocidad la bola lleva demasiada energía para que
      // el imán la doble: pasa de largo, como debe ser.
      holeSuctionMaxSpeed: 640,
      holeSuctionMinFactor: 0.14,
      // Captura por succión: radial (más redonda que la entrada clásica) y algo
      // más permisiva, para que un roce lento no se escape por el ángulo.
      holeCaptureRadius: 19,
      holeCaptureSpeed: 250,
      // Una bola YA PARADA dentro de este radio se despierta y cae dentro.
      // Es el labio de la copa: quedarse clavado ahí es lo que más frustra de
      // un putt. Se mantiene corto para que no regale hoyos desde lejos.
      holeSettleRadius: 34,

      // — Onda expansiva al embocar —
      // Un frente que se expande desde la copa y empuja a quien siga en juego.
      // Con impulso 0 queda desactivada sin tocar nada más.
      shockwaveRadius: 340,
      shockwaveSpeed: 900,
      shockwaveImpulse: 430,
      shockwaveLift: 155,
      steepHoleEntryDegrees: 50,
      resetDelaySeconds: 0.16,
      safeRestSeconds: 0.16,
      portalCooldownSeconds: 0.45,
      portalExitClearance: 12,
      specialCooldownSeconds: 0.35,
      scoreMultiplier: 2,
      secretCaveCooldownSeconds: 0.75,
    }),
    rendering: Object.freeze({
      maxDpr: 1.85,
      particleCap: 220,
      worldCullMargin: 340,
      trailLength: 24,
      shadowMaxHeight: 86,
    }),
  });
}(window.NoiseGolf = window.NoiseGolf || {}));
