(function (NG) {
  'use strict';

  const colors = Object.freeze([
    '#61f5d0', '#ff6b6b', '#69a8ff', '#ffd166',
    '#c77dff', '#ff8fab', '#8ce99a', '#f4a261',
    '#56cfe1', '#e9c46a', '#80ed99', '#b8c0ff',
    '#ff9f1c', '#72efdd', '#f28482', '#a8dadc',
  ]);

  const cfg = {
    protocolVersion: 1,
    clientVersion: '0011p1',
    defaultRelayUrl: 'ws://127.0.0.1:8787',
    maxPlayers: 16,
    browserRefreshSeconds: 12,
    requestTimeoutMs: 6500,
    webRtcConnectTimeoutMs: 14000,
    preflightTimeoutMs: 6500,
    snapshotHz: 20,
    interpolationMs: 70,
    maxExtrapolationMs: 125,
    smoothingResponsiveness: 18,
    snapDistance: 210,
    reliablePingSeconds: 2.0,
    reconnectBaseMs: 700,
    reconnectMaxMs: 7000,
    mapVoteCooldownMs: 60000,
    mapVoteTimeoutMs: 30000,
    maxNameLength: 24,
    maxLobbyNameLength: 40,

    // ── Simulación determinista ───────────────────────────────────────────
    // El host y la predicción del cliente avanzan SIEMPRE en pasos de este
    // tamaño. Bajar los FPS solo cambia cuántos pasos se consumen por frame,
    // nunca el resultado de la física.
    simulationHz: 60,
    // Techo de pasos por frame: evita la "espiral de la muerte" si el
    // navegador se congela (pestaña en segundo plano, GC largo, alt-tab).
    maxStepsPerFrame: 6,
    // Si el retraso acumulado supera esto, se descarta: preferimos perder
    // tiempo de simulación antes que bloquear el hilo recuperándolo.
    maxAccumulatorSeconds: 0.35,

    // ── Presentación del cliente ──────────────────────────────────────────
    // Retardo de interpolación adaptativo: el cliente dibuja el pasado
    // reciente para tener siempre dos muestras que interpolar.
    minInterpolationMs: 55,
    maxInterpolationMs: 260,
    // Margen sobre el jitter medido antes de ampliar el buffer.
    jitterSafetyFactor: 2.2,
    // Cuánto tarda el buffer en volver a encogerse cuando la red mejora.
    interpolationAdaptRate: 0.75,
    // Corrección suave: semivida del error de posición que arrastramos como
    // desplazamiento visual en vez de teletransportar la bola.
    correctionHalfLifeMs: 105,
    // Error por encima del cual la corrección deja de ser suave (snap duro).
    hardSnapDistance: 420,
    snapshotBufferSize: 32,

    // ── Predicción local ──────────────────────────────────────────────────
    // El cliente simula su propia bola con la física real y reconcilia contra
    // el host. Es lo que hace que tu tiro responda al instante con ping alto.
    predictionEnabled: true,
    maxPredictionMs: 1500,
    // Error tolerado sin reconciliar (evita micro-tirones con ruido de red).
    predictionToleranceDistance: 6,

    // ── Cierre del mundo ──────────────────────────────────────────────────
    // Prórroga tras agotarse el reloj del mundo o el contador de cierre.
    // El golpe ya dado cuando suena la bocina se termina de resolver: solo se
    // deja de esperar si una bola se queda atrapada dando vueltas.
    worldGraceMaxSeconds: 12,

    // ── Reconexión y gracia ───────────────────────────────────────────────
    // El host reserva la plaza del jugador caído durante este tiempo.
    // Al agotarse, el jugador se elimina por completo de la partida.
    playerGraceMs: 180000,
    // Ventana en la que el cliente reintenta recuperar la partida.
    reconnectWindowMs: 180000,
    reconnectRetryMs: 2000,
    // Sin snapshots durante este tiempo damos el enlace por perdido.
    linkTimeoutMs: 5000,
    colors,
  };

  NG.ApplyClientEnvConfig = function () {
    const env = NG.ClientEnv?.config || {};
    cfg.maxPlayers = Math.max(2, Math.min(16, Number(env.maxPlayers) || 16));
    cfg.requestTimeoutMs = Number(env.requestTimeoutMs) || 6500;
    cfg.webRtcConnectTimeoutMs = Number(env.webRtcConnectTimeoutMs) || 14000;
    cfg.snapshotHz = Math.max(5, Math.min(60, Number(env.snapshotHz) || 20));
    cfg.interpolationMs = Math.max(0, Math.min(180, Number(env.interpolationMs) || 70));
    cfg.maxExtrapolationMs = Math.max(0, Math.min(400, Number(env.maxExtrapolationMs) || 125));
    cfg.smoothingResponsiveness = Math.max(5, Math.min(40, Number(env.smoothingResponsiveness) || 18));
    cfg.snapDistance = Math.max(60, Math.min(600, Number(env.snapDistance) || 210));
    cfg.reliablePingSeconds = Math.max(1, Math.min(10, Number(env.reliablePingSeconds) || 2));
    cfg.simulationHz = Math.max(30, Math.min(120, Number(env.simulationHz) || 60));
    cfg.correctionHalfLifeMs = Math.max(20, Math.min(400, Number(env.correctionHalfLifeMs) || 105));
    cfg.predictionEnabled = env.predictionEnabled !== false;
    cfg.playerGraceMs = Math.max(15000, Math.min(900000, Number(env.playerGraceSeconds) * 1000 || 180000));
    // El 0 es un valor válido (cierre inmediato), así que no vale `|| 12`.
    cfg.worldGraceMaxSeconds = env.worldGraceSeconds == null
      ? 12
      : Math.max(0, Math.min(60, Number(env.worldGraceSeconds) || 0));
    cfg.reconnectWindowMs = cfg.playerGraceMs;
    // El retardo mínimo nunca debe bajar de un intervalo de snapshot: sin eso
    // el cliente se queda sin muestras que interpolar y vuelve a extrapolar.
    cfg.minInterpolationMs = Math.max(1000 / cfg.snapshotHz, cfg.interpolationMs);
    cfg.mapVoteTimeoutMs = Math.max(10000, Number(env.mapVoteTimeoutMs) || 30000);
    cfg.defaultRelayUrl = String(env.relayUrl || cfg.defaultRelayUrl);
    cfg.preflightTimeoutMs = Math.max(1500, Number(env.preflightTimeoutMs) || Number(env.relayConnectTimeoutMs) || 6500);
    return cfg;
  };

  NG.NET_CONFIG = cfg;
}(window.NoiseGolf = window.NoiseGolf || {}));
