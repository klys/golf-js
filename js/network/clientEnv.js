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
    announcerUserDefaults: {
      sharedVolume: 0.9,
      captionsCollapsed: false,
      commentator: { name: 'Rafa Voltio', voiceURI: 'Microsoft Pablo - Spanish (Spain)', rate: 1.75, pitch: 1.46 },
      informant: { name: 'Álex Prisma', voiceURI: 'Cleveland', rate: 1.71, pitch: 1.51 },
    },
  });

  function parseBoolean(value, fallback) {
    if (value == null || value === '') return fallback;
    if (typeof value === 'boolean') return value;
    return /^(1|true|yes|on|si|sí)$/i.test(String(value).trim());
  }

  function parseNumber(value, fallback) {
    if (value == null || value === '') return fallback;
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  function parseObject(value, fallback) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return fallback;
    return value;
  }

  function parseList(value, fallback) {
    if (Array.isArray(value)) return value;
    // Tolerancia: también se admite el array serializado como texto JSON.
    if (typeof value === 'string' && value.trim() !== '') {
      try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed : fallback;
      } catch (_) { return fallback; }
    }
    return fallback;
  }

  function mapConfig(raw) {
    return {
      onlineEnabled: parseBoolean(raw.onlineEnabled, defaults.onlineEnabled),
      maxPlayers: parseNumber(raw.maxPlayers, defaults.maxPlayers),
      snapshotHz: parseNumber(raw.snapshotHz, defaults.snapshotHz),
      reliablePingSeconds: parseNumber(raw.reliablePingSeconds, defaults.reliablePingSeconds),
      requestTimeoutMs: parseNumber(raw.requestTimeoutMs, defaults.requestTimeoutMs),
      webRtcConnectTimeoutMs: parseNumber(raw.webRtcConnectTimeoutMs, defaults.webRtcConnectTimeoutMs),
      mapVoteTimeoutMs: parseNumber(raw.mapVoteTimeoutSeconds, defaults.mapVoteTimeoutMs / 1000) * 1000,
      relayUrl: String(raw.relayUrl || '').trim(),
      relayConnectTimeoutMs: parseNumber(raw.relayConnectTimeoutMs, defaults.relayConnectTimeoutMs),
      preflightTimeoutMs: parseNumber(raw.preflightTimeoutMs, defaults.preflightTimeoutMs),
      publicIceServers: parseList(raw.publicIceServers, defaults.publicIceServers),
      interpolationMs: parseNumber(raw.interpolationMs, defaults.interpolationMs),
      maxExtrapolationMs: parseNumber(raw.maxExtrapolationMs, defaults.maxExtrapolationMs),
      smoothingResponsiveness: parseNumber(raw.smoothingResponsiveness, defaults.smoothingResponsiveness),
      snapDistance: parseNumber(raw.snapDistance, defaults.snapDistance),
      simulationHz: parseNumber(raw.simulationHz, defaults.simulationHz),
      correctionHalfLifeMs: parseNumber(raw.correctionHalfLifeMs, defaults.correctionHalfLifeMs),
      predictionEnabled: parseBoolean(raw.predictionEnabled, defaults.predictionEnabled),
      playerGraceSeconds: parseNumber(raw.playerGraceSeconds, defaults.playerGraceSeconds),
      announcerUserDefaults: parseObject(raw.announcerUserDefaults, defaults.announcerUserDefaults),
    };
  }

  const state = {
    config: { ...defaults },
    source: 'pending',
    loadError: null,
  };

  state.ready = (async () => {
    if (location.protocol === 'file:') {
      state.source = 'config-unavailable-file';
      state.loadError = 'El modo Online necesita que el juego esté servido por HTTP/HTTPS para poder leer config.json.';
      return state.config;
    }
    try {
      const response = await fetch('./config.json', { cache: 'no-store', credentials: 'same-origin' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const raw = JSON.parse(await response.text());
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('El contenido no es un objeto JSON.');
      state.config = { ...defaults, ...mapConfig(raw) };
      state.source = 'config';
      state.loadError = null;
    } catch (error) {
      state.source = 'config-error';
      state.loadError = `No se pudo cargar config.json (${error.message || error}).`;
      console.warn('[ClientEnv]', state.loadError);
    }
    return state.config;
  })();

  NG.ClientEnv = state;
}(window.NoiseGolf = window.NoiseGolf || {}));
