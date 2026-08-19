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
      // Quieto sobre la copa.
      holdSeconds: 0.85,
      // Barrido de la copa a la salida.
      travelSeconds: 1.75,
      // Aterrizaje en el encuadre de juego.
      settleSeconds: 0.55,
      cupZoom: 1.02,
      travelZoom: 0.72,
    }),

    gameplay: Object.freeze({
      waterPenaltyStroke: 1,
      outOfBoundsPenaltyStroke: 1,
      crushPenaltyStroke: 1,
      crushMinWallSpeed: 28,
      crushSupportGap: 5,
      holeRadius: 22,
      cupDepth: 17,
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
