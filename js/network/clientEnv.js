(function (NG) {
  'use strict';

  const defaults = Object.freeze({
    onlineEnabled: true,
    maxPlayers: 16,
    snapshotHz: 20,
    reliablePingSeconds: 2,
    requestTimeoutMs: 6500,
    webRtcConnectTimeoutMs: 14000,
    mapVoteTimeoutMs: 30000,
    relayUrl: '',
    relayConnectTimeoutMs: 6500,
    preflightTimeoutMs: 6500,
    publicIceServers: [],
    interpolationMs: 70,
    maxExtrapolationMs: 125,
    smoothingResponsiveness: 18,
    snapDistance: 210,
    simulationHz: 60,
    correctionHalfLifeMs: 105,
    predictionEnabled: true,
    playerGraceSeconds: 180,
  });

  function parseBoolean(value, fallback) {
    if (value == null || value === '') return fallback;
    return /^(1|true|yes|on|si|sí)$/i.test(String(value).trim());
  }

  function parseNumber(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  function parseJson(value, fallback) {
    if (value == null || String(value).trim() === '') return fallback;
    try {
      const parsed = JSON.parse(String(value));
      return parsed == null ? fallback : parsed;
    } catch (_) { return fallback; }
  }

  function parseDotEnv(text) {
    const out = Object.create(null);
    for (const rawLine of String(text || '').split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      out[key] = value;
    }
    return out;
  }

  function mapEnv(env) {
    return {
      onlineEnabled: parseBoolean(env.NG_ONLINE_ENABLED, defaults.onlineEnabled),
      maxPlayers: parseNumber(env.NG_MAX_PLAYERS, defaults.maxPlayers),
      snapshotHz: parseNumber(env.NG_SNAPSHOT_HZ, defaults.snapshotHz),
      reliablePingSeconds: parseNumber(env.NG_RELIABLE_PING_SECONDS, defaults.reliablePingSeconds),
      requestTimeoutMs: parseNumber(env.NG_REQUEST_TIMEOUT_MS, defaults.requestTimeoutMs),
      webRtcConnectTimeoutMs: parseNumber(env.NG_WEBRTC_CONNECT_TIMEOUT_MS, defaults.webRtcConnectTimeoutMs),
      mapVoteTimeoutMs: parseNumber(env.NG_MAP_VOTE_TIMEOUT_SECONDS, defaults.mapVoteTimeoutMs / 1000) * 1000,
      relayUrl: String(env.NG_RELAY_URL || '').trim(),
      relayConnectTimeoutMs: parseNumber(env.NG_RELAY_CONNECT_TIMEOUT_MS, defaults.relayConnectTimeoutMs),
      preflightTimeoutMs: parseNumber(env.NG_PREFLIGHT_TIMEOUT_MS, defaults.preflightTimeoutMs),
      publicIceServers: parseJson(env.NG_PUBLIC_ICE_SERVERS_JSON, defaults.publicIceServers),
      interpolationMs: parseNumber(env.NG_CLIENT_INTERPOLATION_MS, defaults.interpolationMs),
      maxExtrapolationMs: parseNumber(env.NG_CLIENT_MAX_EXTRAPOLATION_MS, defaults.maxExtrapolationMs),
      smoothingResponsiveness: parseNumber(env.NG_CLIENT_SMOOTHING_RESPONSIVENESS, defaults.smoothingResponsiveness),
      snapDistance: parseNumber(env.NG_CLIENT_SNAP_DISTANCE, defaults.snapDistance),
      simulationHz: parseNumber(env.NG_SIMULATION_HZ, defaults.simulationHz),
      correctionHalfLifeMs: parseNumber(env.NG_CLIENT_CORRECTION_HALFLIFE_MS, defaults.correctionHalfLifeMs),
      predictionEnabled: parseBoolean(env.NG_CLIENT_PREDICTION, defaults.predictionEnabled),
      playerGraceSeconds: parseNumber(env.NG_PLAYER_GRACE_SECONDS, defaults.playerGraceSeconds),
    };
  }

  const state = {
    config: { ...defaults },
    source: 'pending',
    loadError: null,
  };

  state.ready = (async () => {
    if (location.protocol === 'file:') {
      state.source = 'env-unavailable-file';
      state.loadError = 'El modo Online necesita que el juego esté servido por HTTP/HTTPS para poder leer .env.';
      return state.config;
    }
    try {
      const response = await fetch('./.env', { cache: 'no-store', credentials: 'same-origin' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const raw = parseDotEnv(await response.text());
      const mapped = mapEnv(raw);
      state.config = { ...defaults, ...mapped };
      state.source = 'env';
      state.loadError = null;
    } catch (error) {
      state.source = 'env-error';
      state.loadError = `No se pudo cargar .env (${error.message || error}).`;
      console.warn('[ClientEnv]', state.loadError);
    }
    return state.config;
  })();

  NG.ClientEnv = state;
}(window.NoiseGolf = window.NoiseGolf || {}));
