(function (NG) {
  'use strict';

  const LEGACY_STORAGE_KEY = 'noiseGolf.announcer.v1';
  const USER_DEFAULTS = Object.freeze({
    sharedVolume: 0.9,
    captionsCollapsed: false,
    commentator: { name: 'Rafa Voltio', voiceURI: 'Microsoft Pablo - Spanish (Spain)', rate: 1.75, pitch: 1.46 },
    informant: { name: 'Álex Prisma', voiceURI: 'Cleveland', rate: 1.71, pitch: 1.51 },
  });
  const { clamp, chance, clone } = NG.AnnouncerUtils;
  const GUARANTEED_EVENTS = new Set(['HOLE', 'HOLE_IN_ONE']);
  const POST_MATCH_ALLOWED_EVENTS = new Set(['HOLE', 'HOLE_IN_ONE', 'VICTORY', 'BATTLE_ROYALE_WINNER']);
  const MAP_SHOT_EVENTS = new Set(['SHOT_TAKEN', 'SHOT_WEAK', 'SHOT_STRONG', 'SHOT_PERFECT', 'SHOT_BAD']);
  const MAP_PREFIRST_SILENT_EVENTS = new Set(['TURN_START', 'AIMING', 'RISKY_AIM']);
  const UNDERDOG_TRIGGERS = new Set(['HOLE', 'HOLE_IN_ONE', 'SHOT_PERFECT', 'SABOTAGE_SUCCESS', 'LUCKY_SHOT', 'EDGE_SAVE']);
  // Eventos con los que se abre y se cobra una apuesta de cabina.
  const BET_OPENERS = new Set(['RISKY_AIM', 'POWER_MAX', 'SHOT_STRONG', 'LONG_SHOT', 'BALL_HIGH']);
  const BET_WINS = new Set(['HOLE', 'HOLE_IN_ONE', 'NEAR_MISS', 'SHOT_PERFECT', 'EDGE_SAVE', 'LUCKY_SHOT']);
  const BET_LOSSES = new Set(['WATER', 'OUT_OF_BOUNDS', 'VOID_FALL', 'HARD_LANDING', 'SHOT_BAD', 'RESET', 'UNLUCKY_SHOT']);
  // Penalizaciones que un jugador se inflige a sí mismo: si acaba de empujar a
  // otro, esto deja de ser mala suerte y pasa a ser sabotaje que sale por la culata.
  const SELF_PENALTY_EVENTS = new Set(['WATER', 'OUT_OF_BOUNDS', 'VOID_FALL', 'HARD_LANDING', 'RESET']);
  // Contadores de memoria de partida: evento → clave de gag acumulativo.
  const LEDGER_EVENTS = Object.freeze({
    WATER: 'water', OUT_OF_BOUNDS: 'outOfBounds', VOID_FALL: 'outOfBounds', RESET: 'reset',
    SAND_ENTER: 'sand', NEAR_MISS: 'nearMiss',
  });

  const merge = (base, value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return clone(base);
    const out = clone(base);
    for (const [key, item] of Object.entries(value)) {
      if (item && typeof item === 'object' && !Array.isArray(item) && out[key] && typeof out[key] === 'object' && !Array.isArray(out[key])) {
        out[key] = merge(out[key], item);
      } else out[key] = item;
    }
    return out;
  };

  function safeReadLegacyStorage() {
    try { return JSON.parse(window.localStorage?.getItem(LEGACY_STORAGE_KEY) || '{}'); }
    catch (_) { return {}; }
  }

  function safeWriteLegacyStorage(value) {
    try { window.localStorage?.setItem(LEGACY_STORAGE_KEY, JSON.stringify(value)); }
    catch (_) { /* storage may be unavailable in private/file contexts */ }
  }

  function safeRemoveLegacyStorage() {
    try { window.localStorage?.removeItem(LEGACY_STORAGE_KEY); }
    catch (_) { /* noop */ }
  }

  class AnnouncerSystem {
    constructor(game, profile = null) {
      this.game = game;
      this.profile = profile;
      this.ready = false;
      this.enabled = true;
      this.language = 'es-ES';
      this.personas = null;
      this.runtimeConfig = null;
      this.composer = null;
      this.director = null;
      this.session = null;
      this.sessionUnsub = [];
      this.matchActive = false;
      this.localPlayerName = 'Jugador';
      this.contexts = new Map();
      this.favoriteScores = { commentator: new Map(), informant: new Map() };
      this.favorite = { commentator: '', informant: '' };
      this.lastFavoriteSwitchAt = { commentator: 0, informant: 0 };
      this.rivalries = new Map();
      this.lastMeaningfulAt = Date.now();
      this.voices = [];
      this.settings = null;
      this.postMatchTimer = 0;
      this.pendingTimers = new Set();
      this.lastByPlayerEvent = new Map();
      this.lastHoleSignature = '';
      this.narrativePhase = 'inactive';
      this.activeAims = new Map();
      this.postMatchInfo = null;
      this.postMatchSummaryCount = 0;
      this.lastPostMatchSummaryAt = 0;
      this.mapIntroData = null;
      this.mapIntroState = { stage: 'idle', signature: '', introDelivered: false, firstTouchArmed: false, firstTouchConsumed: false };
      this.mapIntroRecent = new Map();

      // ── Cabina consciente del modo, del foco y de su propia memoria ──────────
      this.rivalryData = null;
      this.focus = { playerKey: '', name: '', since: 0, reason: '', announcedAt: 0 };
      this.flow = { lastBundleAt: 0, recent: [], semanticAt: new Map() };
      this.booth = { pendingBet: null, lastBetAt: 0, lastDisagreementAt: 0, lastFavoriteBanterAt: 0 };
      this.ledger = new Map();
      this.gagAt = new Map();
      this.lastGagAt = 0;
      this.derived = {
        timer: 0, leaderKey: '', ranks: new Map(), tieActive: false, turnKey: '', turnSince: 0,
        lastTurnCue: 0, lastScoreUpdateAt: 0, lastScoreEventAt: 0, finalTurnDone: new Set(),
        balls: new Map(), collisions: [], sabotage: new Map(), eliminations: [], depth: 0,
        pendingSaves: [], contacts: new Map(), streakAt: new Map(), allies: new Map(), allyTargets: new Map(),
      };
    }

    async init() {
      const fallbackConfig = window.NOISE_GOLF_ANNOUNCER_CONFIG || {};
      const fallbackPersonas = window.EMOTIONAL_MACHINE_PERSONAS || null;
      const [runtime, commentator, informant, mapIntroData, rivalryData] = await Promise.all([
        this.fetchJson('./announcer/config.json', fallbackConfig),
        this.fetchJson('./announcer/data/commentator.json', fallbackPersonas?.commentator),
        this.fetchJson('./announcer/data/informant.json', fallbackPersonas?.informant),
        this.fetchJson('./announcer/data/map-intro.json', window.NOISE_GOLF_MAP_INTRO_DATA || null),
        this.fetchJson('./announcer/data/rivalry.json', window.NOISE_GOLF_RIVALRY_DATA || null),
      ]);
      if (!commentator || !informant) throw new Error('No se pudieron cargar los JSON internos de locución.');
      this.runtimeConfig = merge(fallbackConfig, runtime || {});
      this.personas = { commentator, informant };
      this.mapIntroData = mapIntroData || window.NOISE_GOLF_MAP_INTRO_DATA || { presentation: {}, firstTouch: {} };
      this.rivalryData = rivalryData || window.NOISE_GOLF_RIVALRY_DATA || {};
      this.enabled = this.runtimeConfig.enabled !== false;
      this.language = this.runtimeConfig.language || 'es-ES';
      this.composer = new NG.AnnouncerComposer(this.personas, this.runtimeConfig);
      this.director = new NG.AnnouncerSpeechDirector(this);
      this.loadSettings();
      this.refreshVoices();
      if ('speechSynthesis' in window) {
        window.speechSynthesis.addEventListener?.('voiceschanged', () => {
          this.refreshVoices();
          window.dispatchEvent(new CustomEvent('noisegolf:announcer-voices'));
        });
      }
      this.postMatchTimer = window.setInterval(() => this.maybeRunPostMatchSummary(), 1000);
      const tickMs = Math.max(120, Number(this.runtimeConfig.derivedEvents?.tickMs || 260));
      this.derived.timer = window.setInterval(() => this.narrativeTick(), tickMs);
      this.ready = true;
      return this;
    }

    async fetchJson(path, fallback) {
      try {
        const response = await fetch(path, { cache: 'no-store' });
        if (!response.ok) throw new Error(`${response.status}`);
        return await response.json();
      } catch (_) {
        return fallback ? clone(fallback) : null;
      }
    }

    loadSettings() {
      // Reparto de responsabilidades sobre los ajustes de voz:
      //
      //   nombre y voz  -> del jugador. Viven en noiseGolf.profile.v1 (PlayerProfile).
      //   tono, velocidad y volumen -> FIJOS, siempre desde el config.json general.
      //
      // Los tres fijos no se leen del perfil ni aunque un perfil antiguo los tenga
      // guardados de cuando existían los deslizadores: la cabina tiene que sonar
      // igual para todo el mundo, y un valor viejo en localStorage no puede
      // sobrevivir a un cambio de calibración en el config.
      const defaults = merge(USER_DEFAULTS, NG.ClientEnv?.config?.announcerUserDefaults || {});
      let stored = this.profile?.getAnnouncerSettings?.() || {};
      let migratedLegacy = false;
      if (!stored || !Object.keys(stored).length) {
        const legacy = safeReadLegacyStorage();
        if (legacy && Object.keys(legacy).length) {
          stored = legacy;
          migratedLegacy = true;
        }
      }
      this.settings = {
        sharedVolume: clamp(defaults.sharedVolume ?? 0.9, 0, 1),
        captionsCollapsed: Boolean(stored.captionsCollapsed ?? defaults.captionsCollapsed ?? false),
        commentator: {
          name: String(stored.commentator?.name || defaults.commentator?.name || this.personas.commentator.identity?.name || 'Rafa Voltio').slice(0, 32),
          voiceURI: String(stored.commentator?.voiceURI || defaults.commentator?.voiceURI || ''),
          rate: clamp(defaults.commentator?.rate ?? this.personas.commentator.voiceDefaults?.rate ?? 1, 0.5, 2),
          pitch: clamp(defaults.commentator?.pitch ?? this.personas.commentator.voiceDefaults?.pitch ?? 1, 0, 2),
        },
        informant: {
          name: String(stored.informant?.name || defaults.informant?.name || this.personas.informant.identity?.name || 'Álex Prisma').slice(0, 32),
          voiceURI: String(stored.informant?.voiceURI || defaults.informant?.voiceURI || ''),
          rate: clamp(defaults.informant?.rate ?? this.personas.informant.voiceDefaults?.rate ?? 1, 0.5, 2),
          pitch: clamp(defaults.informant?.pitch ?? this.personas.informant.voiceDefaults?.pitch ?? 1, 0, 2),
        },
      };
      this.saveSettings();
      if (migratedLegacy && this.profile?.getAnnouncerSettings?.()) safeRemoveLegacyStorage();
    }

    saveSettings() {
      // Se persiste SOLO lo que el jugador puede cambiar. Guardar también tono,
      // velocidad y volumen dejaría copias congeladas en cada perfil, y un ajuste
      // futuro del config.json nunca llegaría a quien ya tuviera perfil creado.
      const persisted = {
        captionsCollapsed: this.settings.captionsCollapsed,
        commentator: { name: this.settings.commentator.name, voiceURI: this.settings.commentator.voiceURI },
        informant: { name: this.settings.informant.name, voiceURI: this.settings.informant.voiceURI },
      };
      if (this.profile?.setAnnouncerSettings) this.profile.setAnnouncerSettings(persisted);
      else safeWriteLegacyStorage(persisted); // compatibilidad del demo aislado del subsistema
    }

    updateSettings(next) {
      if (!next || typeof next !== 'object') return this.getSettings();
      // sharedVolume, rate y pitch se ignoran a propósito aunque lleguen: son
      // calibración del juego, no preferencia del jugador. Se cambian en el
      // config.json general (`announcerUserDefaults`) y afectan a todos por igual.
      if (next.captionsCollapsed != null) this.settings.captionsCollapsed = Boolean(next.captionsCollapsed);
      for (const key of ['commentator', 'informant']) {
        const source = next[key];
        if (!source) continue;
        if (source.name != null) this.settings[key].name = String(source.name || '').trim().slice(0, 32) || this.personas[key].identity?.name || key;
        if (source.voiceURI != null) this.settings[key].voiceURI = String(source.voiceURI || '');
      }
      this.saveSettings();
      window.dispatchEvent(new CustomEvent('noisegolf:announcer-settings', { detail: this.getSettings() }));
      return this.getSettings();
    }

    getSettings() { return clone(this.settings); }

    getSpeakerSettings(key) {
      const speaker = this.settings?.[key] || this.settings?.commentator || {};
      return { ...speaker, volume: clamp(this.settings?.sharedVolume ?? 0.9, 0, 1) };
    }

    refreshVoices() {
      this.voices = 'speechSynthesis' in window ? window.speechSynthesis.getVoices() : [];
      return this.getVoices();
    }

    getVoices() {
      return this.voices.map((voice) => ({
        voiceURI: voice.voiceURI, name: voice.name, lang: voice.lang, localService: !!voice.localService, default: !!voice.default,
      }));
    }

    voiceByURI(uri, speaker) {
      if (!this.voices.length) this.refreshVoices();
      const direct = this.voices.find((voice) => voice.voiceURI === uri);
      if (direct) return direct;
      const lang = String(this.language || 'es').slice(0, 2).toLowerCase();
      const spanish = this.voices.filter((voice) => String(voice.lang || '').toLowerCase().startsWith(lang));
      if (!spanish.length) return this.voices.find((voice) => voice.default) || this.voices[0] || null;
      return speaker === 'informant' && spanish.length > 1 ? spanish[1] : spanish[0];
    }

    personalizeText(text) {
      const commentatorCanonical = this.personas?.commentator?.identity?.name || 'Rafa Voltio';
      const informantCanonical = this.personas?.informant?.identity?.name || 'Álex Prisma';
      const commentatorShort = this.personas?.commentator?.identity?.shortName || 'Rafa';
      const informantShort = this.personas?.informant?.identity?.shortName || 'Álex';
      const cName = this.settings?.commentator?.name || commentatorCanonical;
      const iName = this.settings?.informant?.name || informantCanonical;
      const cShort = cName.split(/\s+/)[0] || cName;
      const iShort = iName.split(/\s+/)[0] || iName;
      return String(text || '')
        .replaceAll(commentatorCanonical, cName).replaceAll(informantCanonical, iName)
        .replace(new RegExp(`\\b${this.escapeRegExp(commentatorShort)}\\b`, 'g'), cShort)
        .replace(new RegExp(`\\b${this.escapeRegExp(informantShort)}\\b`, 'g'), iShort);
    }

    escapeRegExp(value) { return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

    speakerDisplayName(speaker) {
      return this.settings?.[speaker]?.name || this.personas?.[speaker]?.identity?.name || (speaker === 'informant' ? 'Álex Prisma' : 'Rafa Voltio');
    }

    notifySpeechLine(item, text, state = 'start') {
      const detail = {
        state,
        speaker: item?.speaker === 'informant' ? 'informant' : 'commentator',
        speakerName: this.speakerDisplayName(item?.speaker),
        text: String(text || ''),
        eventKey: String(item?.eventKey || ''),
        eventLabel: String(item?.eventLabel || item?.eventKey || ''),
        at: Date.now(),
      };
      window.dispatchEvent(new CustomEvent('noisegolf:announcer-line', { detail }));
    }

    setLocalPlayerName(name) { this.localPlayerName = String(name || 'Jugador').trim() || 'Jugador'; }

    attachSession(session) {
      for (const off of this.sessionUnsub.splice(0)) { try { off(); } catch (_) { /* noop */ } }
      this.session = session || null;
      if (!session) return;
      this.sessionUnsub.push(session.on('announcercue', (cue) => this.handleNetworkCue(cue)));
      this.sessionUnsub.push(session.on('announcerbundle', (packet) => this.receiveNetworkBundle(packet)));
      this.sessionUnsub.push(session.on('announceractivity', (activity) => this.handleNetworkActivity(activity)));
      this.sessionUnsub.push(session.on('matchover', (info) => this.enterPostMatch({ ...info, source: 'online-matchover' })));
      if (this.matchActive && session.role === 'host') this.scheduleMapPresentation({ source: 'online-session-attach' }, 320);
    }

    setNarrativePhase(phase, reason = '') {
      const next = ['inactive', 'gameplay', 'postmatch'].includes(phase) ? phase : 'gameplay';
      if (next === this.narrativePhase) return;
      this.narrativePhase = next;
      window.dispatchEvent(new CustomEvent('noisegolf:announcer-phase', { detail: { phase: next, reason } }));
    }

    markGameplayActivity(reason = 'gameplay', playerKey = '') {
      const now = Date.now();
      this.lastMeaningfulAt = now;
      if (playerKey && this.activeAims.has(String(playerKey)) && /shot|hole|water|out|reset|collision|penalty/i.test(reason)) {
        this.activeAims.delete(String(playerKey));
      }
      if (this.narrativePhase !== 'postmatch') this.setNarrativePhase('gameplay', reason);
    }

    setAimActivity(playerKey, active, power = 0) {
      const key = String(playerKey || this.localPlayerName || 'local');
      if (active) {
        const lease = Math.max(5000, Number(this.runtimeConfig.stateMachine?.aimLeaseMs || 60000));
        this.activeAims.set(key, { until: Date.now() + lease, power: clamp(power, 0, 1) });
        this.markGameplayActivity('aim-start', key);
      } else {
        this.activeAims.delete(key);
        this.markGameplayActivity('aim-end', key);
      }
    }

    hasActiveAim() {
      const now = Date.now();
      for (const [key, state] of this.activeAims.entries()) {
        if (!state || Number(state.until) <= now) this.activeAims.delete(key);
      }
      return this.activeAims.size > 0;
    }

    setMatchActive(active) {
      const next = !!active;
      if (next === this.matchActive) return;
      this.matchActive = next;
      window.dispatchEvent(new CustomEvent('noisegolf:announcer-matchactive', { detail: { active: next } }));
      if (!next) {
        this.setNarrativePhase('inactive', 'left-match');
        this.activeAims.clear();
        this.cancelPendingTimers();
        this.director?.stop();
        return;
      }
      this.resetNarrativeState();
      this.setNarrativePhase('gameplay', 'entered-match');
      const online = !!this.session?.getStatus?.().online;
      if (!online) {
        this.lastHoleSignature = this.offlineHoleSignature();
        this.presentCurrentMap({ playerName: this.localPlayerName, source: 'offline-match-entry' });
      } else if (this.session?.role === 'host') {
        // El host presenta el mapa antes del primer toque. El ROUND_START que
        // pueda llegar después se deduplica por firma de mapa.
        this.scheduleMapPresentation({ source: 'online-match-entry' }, 320);
      }
    }

    resetNarrativeState() {
      this.contexts.clear();
      this.favoriteScores.commentator.clear();
      this.favoriteScores.informant.clear();
      this.favorite = { commentator: '', informant: '' };
      this.lastFavoriteSwitchAt = { commentator: 0, informant: 0 };
      this.rivalries.clear();
      this.lastMeaningfulAt = Date.now();
      this.lastByPlayerEvent.clear();
      this.lastHoleSignature = '';
      this.activeAims.clear();
      this.postMatchInfo = null;
      this.postMatchSummaryCount = 0;
      this.lastPostMatchSummaryAt = 0;
      this.mapIntroState = { stage: 'idle', signature: '', introDelivered: false, firstTouchArmed: false, firstTouchConsumed: false };
      this.mapIntroRecent.clear();
      this.focus = { playerKey: '', name: '', since: 0, reason: '', announcedAt: 0 };
      this.flow = { lastBundleAt: 0, recent: [], semanticAt: new Map() };
      this.booth = { pendingBet: null, lastBetAt: 0, lastDisagreementAt: 0, lastFavoriteBanterAt: 0 };
      this.ledger.clear();
      this.gagAt.clear();
      this.lastGagAt = 0;
      this.derived.leaderKey = '';
      this.derived.ranks.clear();
      this.derived.tieActive = false;
      this.derived.turnKey = '';
      this.derived.turnSince = 0;
      this.derived.lastTurnCue = 0;
      // Arrancan "recién usados": el repaso de marcador no debe sonar en el primer
      // tick de la partida, cuando todavía no hay marcador del que hablar.
      this.derived.lastScoreUpdateAt = Date.now();
      this.derived.lastScoreEventAt = Date.now();
      this.derived.finalTurnDone.clear();
      this.derived.balls.clear();
      this.derived.collisions.length = 0;
      this.derived.sabotage.clear();
      this.derived.eliminations.length = 0;
      this.derived.pendingSaves.length = 0;
      this.derived.contacts.clear();
      this.derived.streakAt.clear();
      this.derived.allies.clear();
      this.derived.allyTargets.clear();
      this.composer?.reset();
      this.director?.stop();
    }

    cancelPendingTimers() {
      for (const timer of this.pendingTimers) window.clearTimeout(timer);
      this.pendingTimers.clear();
    }

    offlineHoleSignature() {
      const hole = this.game?.hole;
      return `${this.game?.seed || ''}:${this.game?.holeIndex ?? ''}:${hole?.id || hole?.name || ''}`;
    }

    onHoleLoaded() {
      if (!this.matchActive || this.session?.getStatus?.().online) return;
      const signature = this.offlineHoleSignature();
      if (signature && signature === this.lastHoleSignature) return;
      this.lastHoleSignature = signature;
      this.presentCurrentMap({ playerName: this.localPlayerName, source: 'offline-round' });
    }

    onAimStart(power = 0) {
      if (!this.matchActive || this.narrativePhase === 'postmatch') return;
      const online = !!this.session?.getStatus?.().online;
      if (online) {
        this.session?.reportAnnouncerActivity?.('aim-start', { power: clamp(power, 0, 1) });
        return;
      }
      this.setAimActivity('offline', true, power);
      this.announceEvent(power > 0.82 ? 'RISKY_AIM' : 'AIMING', { playerName: this.localPlayerName, power, source: 'offline-aim' });
    }

    onAimEnd() {
      if (!this.matchActive) return;
      const online = !!this.session?.getStatus?.().online;
      if (online) this.session?.reportAnnouncerActivity?.('aim-end');
      else this.setAimActivity('offline', false, 0);
    }

    /**
     * Clasificación del golpe. SHOT_BAD tenía banco propio y ningún emisor: es un
     * golpe flojo con el hoyo todavía lejos, no un golpe flojo cualquiera.
     * POWER_MAX y POWER_LOW son lecturas del gesto, no del golpe, así que salen
     * como línea aparte y se descartan solas si el micrófono está ocupado.
     */
    classifyShot(power, playerKey) {
      const cfg = this.runtimeConfig.gameplay || {};
      const derived = this.runtimeConfig.derivedEvents || {};
      const distance = Number(this.contexts.get(String(playerKey))?.distance || 0);
      let eventKey = 'SHOT_TAKEN';
      if (power <= Number(derived.badShotPower ?? 0.2) && distance >= Number(derived.badShotDistanceMeters ?? 28)) eventKey = 'SHOT_BAD';
      else if (power <= Number(cfg.shotWeakPower ?? 0.34)) eventKey = 'SHOT_WEAK';
      else if (power >= Number(cfg.shotStrongPower ?? 0.84)) eventKey = 'SHOT_STRONG';
      else if (power >= Number(cfg.shotPerfectMinPower ?? 0.62) && power <= Number(cfg.shotPerfectMaxPower ?? 0.78)) eventKey = 'SHOT_PERFECT';
      let aside = '';
      if (power >= Number(derived.powerMaxThreshold ?? 0.97)) aside = 'POWER_MAX';
      else if (power <= Number(derived.powerLowThreshold ?? 0.12)) aside = 'POWER_LOW';
      return { eventKey, aside };
    }

    onShot(payload = {}) {
      if (!this.matchActive || this.session?.getStatus?.().online) return;
      this.activeAims.delete('offline');
      this.markGameplayActivity('shot', 'offline');
      const power = clamp(payload.power ?? 0, 0, 1);
      const { eventKey, aside } = this.classifyShot(power, payload.playerKey || this.localPlayerName);
      this.announceEvent(eventKey, { ...payload, playerName: this.localPlayerName, source: 'offline-shot' });
      if (aside) this.announceEvent(aside, { ...payload, playerName: this.localPlayerName, source: 'offline-power' });
    }

    onOfflineEvent(eventKey, payload = {}) {
      if (!this.matchActive || this.session?.getStatus?.().online) return;
      const result = this.announceEvent(eventKey, { ...payload, playerName: payload.playerName || this.localPlayerName, source: payload.source || 'offline' });
      if (eventKey === 'PORTAL_ENTER') this.schedulePortalExit({ ...payload, playerName: payload.playerName || this.localPlayerName });
      return result;
    }

    handleNetworkCue(cue) {
      if (!cue || this.session?.role !== 'host') return;
      let eventKey = cue.eventKey;
      let aside = '';
      if (eventKey === 'SHOT_TAKEN' && Number.isFinite(Number(cue.power))) {
        const classified = this.classifyShot(clamp(Number(cue.power), 0, 1), cue.playerKey);
        eventKey = classified.eventKey;
        aside = classified.aside;
      }
      const result = this.announceEvent(eventKey, { ...cue, eventKey, source: cue.source || 'host-authority' });
      if (aside) this.announceEvent(aside, { ...cue, eventKey: aside, source: 'host-power' });
      // Los portales tienen entrada propia pero nunca notificaron la salida: el
      // contexto se quedaba con hazard='portal' hasta el siguiente evento.
      if (eventKey === 'PORTAL_ENTER') this.schedulePortalExit(cue);
      return result;
    }

    schedulePortalExit(payload = {}) {
      const timer = window.setTimeout(() => {
        this.pendingTimers.delete(timer);
        if (this.matchActive) this.announceEvent('PORTAL_EXIT', { ...payload, eventKey: 'PORTAL_EXIT', source: 'derived-portal' });
      }, 420);
      this.pendingTimers.add(timer);
    }

    handleNetworkActivity(activity) {
      if (!activity || this.session?.role !== 'host' || this.narrativePhase === 'postmatch') return;
      const key = String(activity.playerKey || activity.playerName || 'player');
      if (activity.kind === 'aim-start') {
        this.setAimActivity(key, true, activity.power);
        // El host es quien convierte el gesto en narrativa: todos oyen el
        // mismo comentario y ningún cliente inventa un AIMING por su cuenta.
        this.announceEvent(Number(activity.power) > 0.82 ? 'RISKY_AIM' : 'AIMING', { ...activity, source: 'host-aim-state' });
      } else if (activity.kind === 'aim-end') this.setAimActivity(key, false, 0);
      else this.markGameplayActivity(activity.kind || 'network-activity', key);
    }

    receiveNetworkBundle(packet) {
      if (!packet?.bundle || this.session?.role === 'host') return;
      const bundle = packet.bundle;
      // `eventAt` viene del reloj del host y no es comparable con el local. Para
      // medir cuánto esperó el bloque en ESTA máquina se sella la recepción.
      bundle.localEventAt = Date.now();
      if (bundle.eventKey === 'MAP_PRESENTATION') {
        // Un mapa nuevo rompe explícitamente el postmatch también en clientes.
        // El host sigue siendo la única autoridad: el cliente solo refleja el
        // estado narrativo transportado dentro del bundle.
        this.postMatchInfo = null;
        this.postMatchSummaryCount = 0;
        this.lastPostMatchSummaryAt = 0;
          this.mapIntroState = {
          stage: 'awaiting-first-touch', signature: String(bundle.mapSignature || ''), introDelivered: true,
          firstTouchArmed: true, firstTouchConsumed: false,
        };
        this.setNarrativePhase('gameplay', 'network-map-presentation');
        this.lastMeaningfulAt = Date.now();
      } else if (bundle.eventKey === 'MAP_FIRST_TOUCH') {
        this.mapIntroState.stage = 'consumed';
        this.mapIntroState.firstTouchArmed = false;
        this.mapIntroState.firstTouchConsumed = true;
        this.setNarrativePhase('gameplay', 'network-map-first-touch');
        this.lastMeaningfulAt = Date.now();
      }
      this.scheduleBundle(bundle, Number(packet.startAtNetTime));
    }

    enterPostMatch(info = {}) {
      if (!this.matchActive) return;
      this.activeAims.clear();
      this.postMatchInfo = { ...(info || {}), at: Date.now() };
      this.postMatchSummaryCount = 0;
      this.lastPostMatchSummaryAt = 0;
      this.lastMeaningfulAt = Date.now();
      this.mapIntroState.stage = 'closed';
      this.mapIntroState.firstTouchArmed = false;
      this.setNarrativePhase('postmatch', info.source || 'match-over');
      this.director?.discardNonGuaranteedPending?.([...POST_MATCH_ALLOWED_EVENTS]);
    }

    onOfflineMatchEnd(info = {}) {
      if (!this.matchActive || this.session?.getStatus?.().online) return;
      this.enterPostMatch({ ...info, source: 'offline-matchover' });
    }

    onOfflineNewCourse() {
      if (!this.matchActive || this.session?.getStatus?.().online) return;
      this.resetNarrativeState();
      this.setNarrativePhase('gameplay', 'offline-new-course');
      this.lastHoleSignature = this.offlineHoleSignature();
      this.presentCurrentMap({ playerName: this.localPlayerName, source: 'offline-new-course' });
    }

    announceEvent(eventKey, payload = {}) {
      if (!this.ready || !this.enabled || !eventKey) return { accepted: false, reason: 'not-ready' };
      const online = !!this.session?.getStatus?.().online;
      if (online && this.session?.role === 'client') return { accepted: false, reason: 'client-not-authority' };

      // ROUND_START ya no usa el banco genérico: inaugura la sección dedicada
      // de presentación de mapa. Esto también saca al narrador de postmatch si
      // el host acaba de cargar un mapa nuevo tras una partida terminada.
      if (eventKey === 'ROUND_START') return this.presentCurrentMap(payload);
      if (this.narrativePhase === 'postmatch' && !POST_MATCH_ALLOWED_EVENTS.has(eventKey)) {
        return { accepted: false, reason: 'postmatch-gameplay-suppressed' };
      }
      if (eventKey === 'TURN_START' && this.runtimeConfig.gameplay?.announceTurnStart === false) {
        this.applyCueToContext(eventKey, payload);
        return { accepted: true, reason: 'turn-start-disabled' };
      }

      const playerKey = String(payload.playerKey || payload.playerName || this.localPlayerName || 'local');
      const policy = this.effectivePolicy(eventKey);
      const guaranteed = (this.runtimeConfig.stateMachine?.guaranteedEvents || [...GUARANTEED_EVENTS]).includes(eventKey);
      const now = Date.now();
      this.markGameplayActivity(eventKey, playerKey);

      // La presentación de mapa reemplaza al MATCH_START genérico. Evita que
      // el primer mapa reciba dos bienvenidas antes de que alguien toque bola.
      if (eventKey === 'MATCH_START' && this.runtimeConfig.mapPresentation?.suppressGenericMatchStart !== false) {
        this.applyCueToContext(eventKey, payload);
        return { accepted: true, reason: 'map-presentation-replaces-match-start' };
      }

      const dedupeKey = `${playerKey}:${eventKey}`;
      const last = this.lastByPlayerEvent.get(dedupeKey) || 0;
      const dedupeMs = Math.max(0, Number(policy.dedupeMs || 0));
      if (dedupeMs && now - last < dedupeMs) return { accepted: false, reason: 'dedupe' };
      this.lastByPlayerEvent.set(dedupeKey, now);

      const context = this.applyCueToContext(eventKey, payload);

      // Tras cambiar de mapa dejamos limpia la escena sonora: TURN_START y
      // AIMING actualizan estado, pero no hablan antes del primer toque. El
      // primer tiro tendrá su propio comentario contextual y se consumirá una vez.
      if (this.mapIntroState.firstTouchArmed && MAP_PREFIRST_SILENT_EVENTS.has(eventKey)
        && this.runtimeConfig.mapPresentation?.silencePreFirstTouch !== false) {
        this.lastMeaningfulAt = now;
        return { accepted: true, reason: 'map-prefirst-state-only' };
      }

      if (this.mapIntroState.firstTouchArmed && MAP_SHOT_EVENTS.has(eventKey)) {
        const firstTouchBundle = this.buildMapFirstTouchBundle({ ...payload, playerKey, eventKey });
        this.mapIntroState.stage = 'consumed';
        this.mapIntroState.firstTouchArmed = false;
        this.mapIntroState.firstTouchConsumed = true;
        // El tiro sigue alimentando favoritos/estadísticas, pero su locución
        // genérica se sustituye por la línea especial de salida del mapa.
        this.updateFavorites(eventKey, payload, context);
        this.lastMeaningfulAt = now;
        return this.deliverBundle(firstTouchBundle);
      }

      this.noteLedger(eventKey, playerKey, payload, context);
      this.updateFocus(eventKey, playerKey, payload, context);

      if (policy.mode === 'trace') {
        this.lastMeaningfulAt = now;
        return { accepted: true, reason: 'trace-folded' };
      }

      // Lo que pasa fuera del foco no se calla, pero baja de rango. Así una bola
      // cualquiera del battle royale no le quita el micrófono al duelo que la
      // cabina está narrando, sin dejar de contar lo verdaderamente grave.
      if (!guaranteed) this.applyFocusWeight(policy, playerKey);

      if (!guaranteed && (policy.mode === 'opportunistic' || policy.mode === 'filler') && this.director?.isBusy()) {
        return { accepted: false, reason: 'mic-busy' };
      }
      if (!guaranteed) {
        const gate = this.flowAllows(eventKey, policy, now);
        if (!gate.ok) return { accepted: false, reason: gate.reason };
      }

      const effective = this.socializeEvent(eventKey, context, payload);
      // Si la lectura social eleva el evento (un choque que en realidad es un
      // ataque al líder), la política tiene que ser la del evento resultante.
      let finalPolicy = policy;
      if (effective.primary !== eventKey) {
        finalPolicy = this.effectivePolicy(effective.primary);
        if (!guaranteed) this.applyFocusWeight(finalPolicy, playerKey);
      }
      const bundle = this.composer.buildBundle(effective.primary, clone(context), payload.source || 'game', this.bundleShape(finalPolicy));
      if (guaranteed) {
        const holeToken = online
          ? `${Number(this.session?.courseRound) || 0}:${Number(this.game?.holeIndex) || 0}:${payload.finishOrder ?? ''}`
          : this.offlineHoleSignature();
        bundle.policy = {
          ...bundle.policy, class: 'supercritical', priority: 1000, mode: 'guaranteed',
          guaranteed: true, persistentUntilSpoken: true, preempt: 'none',
        };
        bundle.guaranteeKey = `${eventKey}:${playerKey}:${holeToken}`;
        bundle.expiresAt = Number.MAX_SAFE_INTEGER;
        bundle.conversationExpiresAt = Number.MAX_SAFE_INTEGER;
      }
      if (effective.extra && chance(this.runtimeConfig.gameplay?.favoriteExtraLineChance ?? 0.42)) {
        bundle.items.push(this.composer.buildExtraItem(effective.extra, clone(context), effective.extraSpeaker || 'commentator'));
        bundle.conversationExpiresAt += 1800;
        bundle.expiresAt += 1800;
      }
      this.decorateBundle(bundle, eventKey, playerKey, context, effective);
      this.noteFlow(effective.primary, finalPolicy, bundle);
      this.lastMeaningfulAt = Date.now();
      return this.deliverBundle(bundle);
    }

    applyCueToContext(eventKey, payload) {
      const playerKey = String(payload.playerKey || payload.playerName || this.localPlayerName || 'local');
      const playerName = String(payload.playerName || this.playerNameForKey(payload.playerKey) || this.localPlayerName || 'Jugador');
      let ctx = this.contexts.get(playerKey);
      if (!ctx) {
        ctx = {
          player: playerName, turn: 0, shots: 0, roundShots: 0, waterCount: 0, speed: 0, height: 0, distance: 0, bounces: 0,
          goodStreak: 0, badStreak: 0, streakText: 'Neutral', previousEventLabel: '', previousResult: '', lastEventKey: '', lastEventLabel: '',
          score: '0 golpes', leader: playerName, hazard: '', rivalScore: 0, actionTrace: '', opponent: '', attacker: '', victim: '', eliminatedPlayer: '', alliancePartner: '',
          survivorCount: 0, survivors: '', rafaFavorite: 'aún sin favorito', alexFavorite: 'aún sin favorito', favorite: '', favoriteOwner: '', favoriteReason: '', rivalryLevel: 0, battleRank: 0,
        };
        this.contexts.set(playerKey, ctx);
      }
      ctx.previousEventLabel = ctx.lastEventLabel || 'inicio de la partida';
      ctx.previousResult = ctx.lastEventKey || 'inicio';
      ctx.player = playerName;
      ctx.opponent = String(payload.opponentName || this.playerNameForKey(payload.opponentKey) || ctx.opponent || '');
      ctx.attacker = String(payload.attackerName || this.playerNameForKey(payload.attackerKey) || payload.playerName || ctx.player);
      ctx.victim = String(payload.victimName || this.playerNameForKey(payload.victimKey) || payload.opponentName || ctx.victim || '');
      ctx.eliminatedPlayer = String(payload.eliminatedPlayer || payload.victimName || ctx.eliminatedPlayer || '');
      if (Number.isFinite(Number(payload.speedKmh))) ctx.speed = Math.max(0, Number(payload.speedKmh));
      if (Number.isFinite(Number(payload.heightMeters))) ctx.height = Math.max(0, Number(payload.heightMeters));
      if (Number.isFinite(Number(payload.distanceMeters))) ctx.distance = Math.max(0, Number(payload.distanceMeters));
      if (Number.isFinite(Number(payload.strokes))) { ctx.shots = Math.max(0, Number(payload.strokes)); ctx.roundShots = ctx.shots; }
      if (Number.isFinite(Number(payload.turn))) ctx.turn = Math.max(0, Number(payload.turn));
      if (Number.isFinite(Number(payload.bounces))) ctx.bounces = Math.max(0, Number(payload.bounces));

      switch (eventKey) {
        case 'MATCH_START': ctx.turn = 0; ctx.shots = 0; ctx.roundShots = 0; ctx.waterCount = 0; ctx.goodStreak = 0; ctx.badStreak = 0; break;
        case 'ROUND_START': ctx.roundShots = 0; ctx.bounces = 0; ctx.height = 0; ctx.hazard = ''; break;
        case 'TURN_START': ctx.turn += payload.turn == null ? 1 : 0; break;
        case 'SHOT_TAKEN': case 'SHOT_WEAK': case 'SHOT_STRONG': case 'SHOT_PERFECT': case 'SHOT_BAD':
          if (payload.strokes == null) { ctx.shots += 1; ctx.roundShots += 1; }
          if (eventKey === 'SHOT_PERFECT') this.good(ctx, 1); else if (eventKey === 'SHOT_BAD') this.bad(ctx, 1);
          break;
        case 'BOUNCE': ctx.bounces += 1; break;
        case 'MULTI_BOUNCE': ctx.bounces += Math.max(2, Number(payload.bounces) || 2); break;
        case 'WATER': ctx.waterCount += 1; ctx.hazard = 'agua'; ctx.speed = 0; this.bad(ctx, 2); break;
        case 'OUT_OF_BOUNDS': ctx.hazard = 'fuera de límites'; ctx.speed = 0; this.bad(ctx, 2); break;
        case 'SAND_ENTER': ctx.hazard = 'arena'; break;
        case 'SAND_EXIT': if (ctx.hazard === 'arena') ctx.hazard = ''; break;
        case 'ICE_ENTER': ctx.hazard = 'hielo'; break;
        case 'PORTAL_ENTER': ctx.hazard = 'portal'; break;
        case 'PORTAL_EXIT': if (ctx.hazard === 'portal') ctx.hazard = ''; break;
        case 'TUNNEL_ENTER': ctx.hazard = 'túnel'; break;
        case 'TUNNEL_EXIT': if (ctx.hazard === 'túnel') ctx.hazard = ''; break;
        case 'BOOSTER': this.good(ctx, 0.25); break;
        case 'NEAR_MISS': this.bad(ctx, 0.35); break;
        case 'HOLE': ctx.distance = 0; ctx.speed = 0; this.good(ctx, 2); break;
        case 'HOLE_IN_ONE': ctx.distance = 0; ctx.speed = 0; ctx.roundShots = 1; this.good(ctx, 4); break;
        case 'SABOTAGE_SUCCESS': ctx.hazard = 'rival'; this.good(ctx, 1); break;
        case 'SABOTAGE_BACKFIRE': ctx.hazard = 'rival'; this.bad(ctx, 1.5); break;
        case 'PLAYER_COLLISION': case 'CHAIN_COLLISION': ctx.bounces += 1; break;
        case 'VICTORY': case 'BATTLE_ROYALE_WINNER': ctx.leader = ctx.player; this.good(ctx, 4); break;
        default: break;
      }

      this.refreshCompetitiveContext(ctx, playerKey, payload);
      // El modo viaja dentro del contexto: el compositor lo usa para decidir si
      // puede echar mano de los bancos exclusivos de battle royale.
      ctx.mode = this.currentMode();
      ctx.streakText = ctx.goodStreak >= 2 ? `Positiva ×${Math.floor(ctx.goodStreak)}` : ctx.badStreak >= 2 ? `Negativa ×${Math.floor(ctx.badStreak)}` : 'Neutral';
      ctx.score = payload.scoreText || `${Math.round(ctx.shots)} golpes${payload.points != null ? ` · ${Math.round(payload.points)} pts` : ''}`;
      ctx.lastEventKey = eventKey;
      ctx.lastEventLabel = this.personas.commentator.events?.[eventKey]?.label || eventKey;
      return ctx;
    }

    good(ctx, amount) { ctx.goodStreak = clamp((ctx.goodStreak || 0) + amount, 0, 99); ctx.badStreak = Math.max(0, (ctx.badStreak || 0) - 1); }
    bad(ctx, amount) { ctx.badStreak = clamp((ctx.badStreak || 0) + amount, 0, 99); ctx.goodStreak = Math.max(0, (ctx.goodStreak || 0) - 1); }

    playerNameForKey(key) {
      if (!key || !this.session?.players) return '';
      return this.session.players.get(key)?.username || '';
    }

    refreshCompetitiveContext(ctx, playerKey, payload) {
      const standings = this.session?.getStandings?.() || [];
      if (standings.length) {
        const current = standings.find((entry) => entry.playerKey === playerKey);
        const leader = standings[0];
        ctx.leader = leader?.username || ctx.leader;
        ctx.battleRank = current?.rank || ctx.battleRank || 0;
        const active = standings.filter((entry) => entry.role === 'player' && !entry.finished);
        ctx.survivorCount = Number(payload.survivorCount ?? active.length);
        ctx.survivors = active.map((entry) => entry.username).join(', ');
      } else if (payload.survivorCount != null) ctx.survivorCount = Number(payload.survivorCount) || 0;
      ctx.rafaFavorite = this.playerNameForKey(this.favorite.commentator) || ctx.rafaFavorite;
      ctx.alexFavorite = this.playerNameForKey(this.favorite.informant) || ctx.alexFavorite;
    }

    socializeEvent(eventKey, ctx, payload) {
      let primary = eventKey;
      let extra = '';
      let extraSpeaker = 'commentator';
      let rivalry = null;
      const mode = this.currentMode();
      const now = Date.now();
      const cfg = this.runtimeConfig.derivedEvents || {};
      const leaderKey = this.leaderKey();
      const attackerKey = String(payload.attackerKey || payload.playerKey || '');
      const victimKey = String(payload.victimKey || payload.opponentKey || '');

      if (mode === 'battle' && eventKey === 'PLAYER_COLLISION' && ctx.opponent) {
        const a = String(payload.playerKey || ctx.player);
        const b = String(payload.opponentKey || ctx.opponent);
        const pair = [a, b].sort().join('|');
        const state = this.rivalries.get(pair) || { hits: 0, lastAttacker: '', bornAnnounced: false, lastLineAt: 0, byAttacker: new Map() };
        state.hits += 1;
        const reversed = state.lastAttacker && attackerKey && state.lastAttacker !== attackerKey;
        state.lastAttacker = attackerKey || state.lastAttacker;
        if (attackerKey) state.byAttacker.set(attackerKey, (state.byAttacker.get(attackerKey) || 0) + 1);
        this.rivalries.set(pair, state);
        ctx.rivalryLevel = state.hits;

        // CHAIN_COLLISION existía en el banco desde el principio sin emisor: es
        // simplemente más de un choque dentro de la misma ventana de caos.
        this.derived.collisions.push(now);
        const chainWindow = Math.max(400, Number(cfg.chainCollisionWindowMs || 1700));
        this.derived.collisions = this.derived.collisions.filter((at) => now - at <= chainWindow);
        const rafaFav = String(this.favorite.commentator || '');
        const alexFav = String(this.favorite.informant || '');
        const favoritesInvolved = rafaFav && alexFav && rafaFav !== alexFav
          && [a, b].includes(rafaFav) && [a, b].includes(alexFav);

        if (favoritesInvolved) primary = 'FAVORITES_COLLIDE';
        else if (leaderKey && victimKey && victimKey === leaderKey && attackerKey !== leaderKey) primary = 'LEADER_ATTACKED';
        else if (this.derived.collisions.length >= 2) primary = 'CHAIN_COLLISION';

        if (state.hits >= Number(this.runtimeConfig.gameplay?.revengeHits || 3) && reversed) extra = 'REVENGE_HIT';
        else if (state.hits === Number(this.runtimeConfig.gameplay?.rivalryHeatHits || 2)) extra = 'RIVALRY_HEATS_UP';
        else if (chance(this.runtimeConfig.gameplay?.tauntChance ?? 0.26)) extra = 'PLAYER_TAUNT';

        rivalry = this.playerRivalryLine(pair, state, ctx, payload, leaderKey);

        // Se anota la posición de la víctima para decidir después si el choque la
        // hundió (sabotaje) o, sin querer, la acercó al hoyo (RIVAL_SAVE).
        if (victimKey && attackerKey) {
          this.derived.pendingSaves = this.derived.pendingSaves || [];
          this.derived.pendingSaves.push({ victimKey, attackerKey, at: now, progress: this.progressFor(victimKey), resolved: false });
          this.derived.contacts = this.derived.contacts || new Map();
          this.derived.contacts.set(attackerKey, { at: now, victimKey });
          this.noteAlliance(attackerKey, victimKey, now);
        }
      }

      // SABOTAGE_BACKFIRE: el que acaba de empujar a otro se penaliza a sí mismo
      // acto seguido. El banco lo tenía escrito y jamás llegó a sonar.
      if (SELF_PENALTY_EVENTS.has(eventKey)) {
        const contact = this.derived.contacts?.get(String(payload.playerKey || ''));
        const backfireWindow = Math.max(500, Number(cfg.sabotageBackfireWindowMs || 2600));
        if (contact && now - contact.at <= backfireWindow) {
          primary = 'SABOTAGE_BACKFIRE';
          ctx.victim = this.playerNameForKey(contact.victimKey) || ctx.victim;
          this.derived.contacts.delete(String(payload.playerKey || ''));
        }
      }

      // SABOTAGE_ATTEMPT: hubo contacto con intención y el rival salió ileso.
      if (eventKey === 'PLAYER_COLLISION' && primary === eventKey && attackerKey && victimKey) {
        const attemptWindow = Math.max(600, Number(cfg.sabotageAttemptWindowMs || 2200));
        const timer = window.setTimeout(() => {
          this.pendingTimers.delete(timer);
          const contact = this.derived.contacts?.get(attackerKey);
          if (!contact || contact.victimKey !== victimKey || contact.punished) return;
          this.derived.contacts.delete(attackerKey);
          this.announceEvent('SABOTAGE_ATTEMPT', {
            playerKey: attackerKey, playerName: this.playerNameForKey(attackerKey) || ctx.attacker,
            opponentKey: victimKey, opponentName: this.playerNameForKey(victimKey) || ctx.victim,
            attackerKey, victimKey, source: 'derived-sabotage',
          });
        }, attemptWindow);
        this.pendingTimers.add(timer);
      }

      if (eventKey === 'SABOTAGE_SUCCESS' && attackerKey) {
        const contact = this.derived.contacts?.get(attackerKey);
        if (contact) contact.punished = true;
        const feud = this.derived.sabotage.get(attackerKey) || new Map();
        if (victimKey) feud.set(victimKey, (feud.get(victimKey) || 0) + 1);
        this.derived.sabotage.set(attackerKey, feud);
        const count = victimKey ? (feud.get(victimKey) || 1) : 1;
        if (leaderKey && victimKey === leaderKey && attackerKey !== leaderKey) primary = 'LEADER_ATTACKED';
        if (count >= 2 && !rivalry) {
          rivalry = this.rivalryItem('playerRivalry.sabotageFeud', { ...this.rivalryTokens(ctx, payload), count });
        }
      }

      // UNDERDOG_STRIKE: un jugador de la mitad baja de la tabla firma algo grande.
      if (!extra && UNDERDOG_TRIGGERS.has(eventKey) && this.isUnderdog(payload.playerKey)) extra = 'UNDERDOG_STRIKE';

      // Rachas. El contexto ya las contaba desde el principio; lo que faltaba era
      // convertirlas en evento cuando cruzan el umbral.
      if (!extra) {
        const goodAt = Number(cfg.streakGoodAt || 3);
        const badAt = Number(cfg.streakBadAt || 3);
        const key = String(payload.playerKey || ctx.player || '');
        const lastStreak = this.derived.streakAt?.get(key) || 0;
        if (now - lastStreak >= 12000) {
          if (Math.floor(ctx.goodStreak || 0) >= goodAt) extra = 'STREAK_GOOD';
          else if (Math.floor(ctx.badStreak || 0) >= badAt) extra = 'STREAK_BAD';
          if (extra) {
            this.derived.streakAt = this.derived.streakAt || new Map();
            this.derived.streakAt.set(key, now);
          }
        }
      }

      // Alianzas y traiciones especulativas: siguen apagadas por defecto, pero la
      // detección ya existe para que el interruptor de socialNarrative sirva.
      if (!extra) {
        const social = this.runtimeConfig.socialNarrative || {};
        const ally = this.allianceFor(String(payload.playerKey || ''), now);
        if (ally?.betrayal && social.allowSpeculativeBetrayal === true) extra = 'BETRAYAL';
        else if (ally?.formed && social.allowSpeculativeAlliance === true) extra = 'TEMP_ALLIANCE';
      }

      const favoriteExtra = this.updateFavorites(eventKey, payload, ctx);
      if (favoriteExtra) { extra = favoriteExtra.eventKey; extraSpeaker = favoriteExtra.speaker; }
      return { primary, extra, extraSpeaker, rivalry };
    }

    /**
     * Detección de alianza especulativa: dos atacantes distintos golpean a la
     * misma víctima dentro de una ventana corta. Si esos dos aliados chocan
     * después entre ellos, eso es la traición. Ambas lecturas siguen siendo
     * interpretación, no hecho de juego: por eso viven detrás de socialNarrative.
     */
    noteAlliance(attackerKey, victimKey, now) {
      const cfg = this.runtimeConfig.derivedEvents || {};
      this.derived.allyTargets = this.derived.allyTargets || new Map();
      this.derived.allies = this.derived.allies || new Map();
      const windowMs = Math.max(800, Number(cfg.allianceWindowMs || 4200));
      const memoryMs = Math.max(windowMs, Number(cfg.allianceMemoryMs || 45000));

      const pairKey = [attackerKey, victimKey].sort().join('|');
      const existing = this.derived.allies.get(pairKey);
      if (existing && now - existing.at <= memoryMs) {
        existing.betrayedAt = now;
        this.derived.allies.set(pairKey, existing);
      }

      const history = (this.derived.allyTargets.get(victimKey) || []).filter((item) => now - item.at <= windowMs);
      const partner = history.find((item) => item.key !== attackerKey);
      history.push({ key: attackerKey, at: now });
      this.derived.allyTargets.set(victimKey, history);
      if (partner) {
        const allyPair = [attackerKey, partner.key].sort().join('|');
        if (!this.derived.allies.has(allyPair)) this.derived.allies.set(allyPair, { at: now, target: victimKey, betrayedAt: 0 });
      }
    }

    allianceFor(playerKey, now) {
      if (!playerKey || !this.derived.allies?.size) return null;
      const memoryMs = Math.max(1000, Number(this.runtimeConfig.derivedEvents?.allianceMemoryMs || 45000));
      for (const [pair, state] of this.derived.allies.entries()) {
        if (!pair.split('|').includes(playerKey)) continue;
        if (now - state.at > memoryMs) { this.derived.allies.delete(pair); continue; }
        if (state.betrayedAt && !state.betrayalAnnounced) {
          state.betrayalAnnounced = true;
          return { betrayal: true, pair };
        }
        if (!state.formedAnnounced) {
          state.formedAnnounced = true;
          return { formed: true, pair };
        }
      }
      return null;
    }

    /** Clave del líder real (con ventaja efectiva), o cadena vacía. */
    leaderKey() {
      const standings = this.mapStandings();
      const { leader, meaningful } = this.mapLeaderSnapshot(standings);
      return meaningful ? String(leader.playerKey || '') : '';
    }

    isUnderdog(playerKey) {
      const standings = this.mapStandings();
      if (standings.length < 3) return false;
      const index = standings.findIndex((entry) => String(entry.playerKey) === String(playerKey || ''));
      if (index < 0) return false;
      return index >= Math.ceil(standings.length / 2);
    }

    updateFavorites(eventKey, payload, ctx) {
      const weights = {
        commentator: { HOLE_IN_ONE: 7, SABOTAGE_SUCCESS: 5, HOLE: 3, SHOT_STRONG: 1.5, SHOT_PERFECT: 2, PLAYER_COLLISION: 1, REVENGE_HIT: 3, WATER: -1.5, OUT_OF_BOUNDS: -1.5 },
        informant: { HOLE_IN_ONE: 7, HOLE: 4, SHOT_PERFECT: 3, SHOT_STRONG: 0.5, SABOTAGE_SUCCESS: 1.5, WATER: -2.2, OUT_OF_BOUNDS: -2.2, SHOT_BAD: -1.4 },
      };
      const key = String(payload.playerKey || ctx.player || '');
      if (!key) return null;
      let changed = null;
      for (const speaker of ['commentator', 'informant']) {
        const delta = Number(weights[speaker][eventKey] || 0);
        if (delta) this.favoriteScores[speaker].set(key, (this.favoriteScores[speaker].get(key) || 0) + delta);
        const scores = [...this.favoriteScores[speaker].entries()].sort((a, b) => b[1] - a[1]);
        if (!scores.length) continue;
        const [candidate, score] = scores[0];
        const current = this.favorite[speaker];
        const currentScore = current ? (this.favoriteScores[speaker].get(current) || 0) : -Infinity;
        const now = Date.now();
        const cooldown = Number(this.runtimeConfig.gameplay?.favoriteSwitchCooldownMs || 6500);
        const margin = Number(this.runtimeConfig.gameplay?.favoriteSwitchMargin || 1.25);
        if (candidate !== current && score >= currentScore + margin && now - this.lastFavoriteSwitchAt[speaker] >= cooldown) {
          const displaced = current;
          this.favorite[speaker] = candidate;
          this.lastFavoriteSwitchAt[speaker] = now;
          // Un favorito nuevo implica que otro acaba de caer. FAVORITE_FALL tenía
          // banco propio y ningún emisor; este es su momento natural.
          if (displaced) {
            ctx.favorite = this.playerNameForKey(displaced) || ctx.favorite;
            changed = { eventKey: 'FAVORITE_FALL', speaker };
          }
          ctx.favorite = this.playerNameForKey(candidate) || (candidate === key ? ctx.player : candidate);
          // En red se conserva el nombre canónico dentro del bundle. Cada
          // cliente lo personaliza al reproducir según SU configuración local.
          ctx.favoriteOwner = speaker === 'commentator'
            ? (this.personas.commentator.identity?.name || 'Rafa Voltio')
            : (this.personas.informant.identity?.name || 'Álex Prisma');
          ctx.favoriteReason = speaker === 'commentator' ? 'el espectáculo y el impacto de sus jugadas' : 'la precisión y la eficiencia de sus decisiones';
          changed = { eventKey: 'FAVORITE_RISE', speaker };
        }
      }
      ctx.rafaFavorite = this.playerNameForKey(this.favorite.commentator) || (this.favorite.commentator === key ? ctx.player : ctx.rafaFavorite);
      ctx.alexFavorite = this.playerNameForKey(this.favorite.informant) || (this.favorite.informant === key ? ctx.player : ctx.alexFavorite);
      return changed;
    }

    currentMapSignature() {
      const online = !!this.session?.getStatus?.().online;
      if (online) {
        return `online:${Number(this.session?.courseRound) || 0}:${this.game?.seed || ''}:${Number(this.game?.holeIndex) || 0}`;
      }
      return `offline:${this.offlineHoleSignature()}`;
    }

    mapStandings() {
      if (!this.session?.getStatus?.().online) return [];
      return (this.session?.getStandings?.() || []).filter((entry) => entry?.role === 'player' && entry?.connected !== false);
    }

    mapLeaderSnapshot(standings = this.mapStandings()) {
      const ordered = Array.isArray(standings) ? standings : [];
      const leader = ordered[0] || null;
      const second = ordered[1] || null;
      const meaningful = Boolean(leader && second && Number(leader.points || 0) > Number(second.points || 0));
      const gap = meaningful ? Math.max(0, Number(leader.points || 0) - Number(second.points || 0)) : 0;
      return { leader, second, meaningful, gap };
    }

    mapTemplateContext(extra = {}) {
      const standings = extra.standings || this.mapStandings();
      const { leader, meaningful, gap } = this.mapLeaderSnapshot(standings);
      const mapNumber = Math.max(1, Number(this.game?.holeIndex || 0) + 1);
      const hole = this.game?.hole;
      return {
        player: extra.player?.username || extra.playerName || this.localPlayerName || 'Jugador',
        leader: meaningful ? leader.username : 'nadie todavía',
        leader_points: meaningful ? Math.round(Number(leader.points) || 0) : 0,
        gap: meaningful ? Math.round(gap) : 0,
        rank: Number(extra.player?.rank || 0) || 0,
        total: standings.length || 1,
        points: Math.round(Number(extra.player?.points) || 0),
        map_number: mapNumber,
        hole: mapNumber,
        par: Math.max(1, Number(hole?.par || 0)),
        favorite: extra.favoriteName || this.playerNameForKey(this.favorite.commentator) || this.playerNameForKey(this.favorite.informant) || 'el favorito de la cabina',
        rafa_favorite: this.playerNameForKey(this.favorite.commentator) || 'todavía sin favorito',
        alex_favorite: this.playerNameForKey(this.favorite.informant) || 'todavía sin favorito',
      };
    }

    fillMapTemplate(text, ctx = {}) {
      return String(text || '').replace(/\{([a-z_]+)\}/gi, (match, key) => ctx[key] ?? match)
        .replace(/\s+/g, ' ').replace(/\s+([,.;:!?])/g, '$1').trim();
    }

    pickMapPhrase(poolKey, list) {
      if (!Array.isArray(list) || !list.length) return '';
      const memory = Math.max(3, Number(this.runtimeConfig.mapPresentation?.recentMemory || 8));
      const recent = this.mapIntroRecent.get(poolKey) || [];
      const blocked = new Set(recent.slice(-memory));
      let candidates = list.filter((item) => typeof item === 'string' && !blocked.has(item));
      if (!candidates.length) candidates = list.filter((item) => typeof item === 'string');
      if (!candidates.length) return '';
      const value = candidates[Math.floor(Math.random() * candidates.length)];
      recent.push(value);
      if (recent.length > memory * 3) recent.splice(0, recent.length - memory * 2);
      this.mapIntroRecent.set(poolKey, recent);
      return value;
    }

    buildMapPresentationBundle(payload = {}) {
      const presentation = this.mapIntroData?.presentation || {};
      const standings = this.mapStandings();
      const { leader, meaningful } = this.mapLeaderSnapshot(standings);
      const rafaFav = String(this.favorite.commentator || '');
      const alexFav = String(this.favorite.informant || '');
      const splitFavorites = Boolean(rafaFav && alexFav && rafaFav !== alexFav);
      const sharedFavorite = Boolean(rafaFav && alexFav && rafaFav === alexFav);
      const ctx = this.mapTemplateContext({ standings });
      const items = [];

      if (meaningful) {
        const leaderKey = String(leader.playerKey || '');
        const rafaOwns = leaderKey && leaderKey === rafaFav;
        const alexOwns = leaderKey && leaderKey === alexFav;
        let speaker = 'commentator';
        let poolKey = 'presentation.leaderGeneral';
        let pool = presentation.leaderGeneral;
        if (rafaOwns && !alexOwns) {
          speaker = 'commentator'; poolKey = 'presentation.leaderCommentatorFavorite'; pool = presentation.leaderCommentatorFavorite;
        } else if (alexOwns && !rafaOwns) {
          speaker = 'informant'; poolKey = 'presentation.leaderInformantFavorite'; pool = presentation.leaderInformantFavorite;
        } else if (rafaOwns && alexOwns) {
          const leaderLine = this.pickMapPhrase('presentation.leaderGeneral', presentation.leaderGeneral);
          const shared = this.pickMapPhrase('presentation.sharedFavorite', presentation.sharedFavorite);
          if (leaderLine) items.push({ speaker: 'commentator', text: this.fillMapTemplate(leaderLine, ctx), eventLabel: 'Presentación · líder' });
          if (shared) items.push({ speaker: 'informant', text: this.fillMapTemplate(shared, { ...ctx, favorite: leader.username }), eventLabel: 'Presentación · favorito compartido' });
        }
        if (!items.length) {
          const phrase = this.pickMapPhrase(poolKey, pool) || `{leader} llega al nuevo mapa como líder. Que empiece la defensa del primer puesto.`;
          items.push({ speaker, text: this.fillMapTemplate(phrase, ctx), eventLabel: 'Presentación · líder' });
        }
      } else if (splitFavorites) {
        const duels = Array.isArray(presentation.splitFavoriteDuels) ? presentation.splitFavoriteDuels : [];
        if (duels.length) {
          const duel = duels[Math.floor(Math.random() * duels.length)];
          const c = this.fillMapTemplate(duel?.commentator, ctx);
          const i = this.fillMapTemplate(duel?.informant, ctx);
          if (c) items.push({ speaker: 'commentator', text: c, eventLabel: 'Presentación · rivalidad de favoritos' });
          if (i) items.push({ speaker: 'informant', text: i, eventLabel: 'Presentación · respuesta rival' });
        }
      } else if (sharedFavorite) {
        const phrase = this.pickMapPhrase('presentation.sharedFavorite', presentation.sharedFavorite);
        if (phrase) items.push({ speaker: 'commentator', text: this.fillMapTemplate(phrase, { ...ctx, favorite: ctx.rafa_favorite }), eventLabel: 'Presentación · favorito compartido' });
      } else {
        const phrase = this.pickMapPhrase('presentation.noLeader', presentation.noLeader) || '¡Mapa nuevo! Nadie manda todavía, así que todos conservan unos segundos de optimismo reglamentario.';
        items.push({ speaker: 'commentator', text: this.fillMapTemplate(phrase, ctx), eventLabel: 'Presentación · nuevo mapa' });
      }

      if (!meaningful && !splitFavorites && !sharedFavorite) {
        const soleFavKey = rafaFav || alexFav;
        if (soleFavKey) {
          const favoriteName = this.playerNameForKey(soleFavKey);
          const pool = rafaFav ? presentation.singleFavoriteCommentator : presentation.singleFavoriteInformant;
          const poolKey = rafaFav ? 'presentation.singleFavoriteCommentator' : 'presentation.singleFavoriteInformant';
          const line = this.pickMapPhrase(poolKey, pool);
          if (line) items.push({
            speaker: rafaFav ? 'commentator' : 'informant',
            text: this.fillMapTemplate(line, { ...ctx, favorite: favoriteName || ctx.favorite }),
            eventLabel: 'Presentación · favorito',
          });
        }
      }

      // Si ya existe un líder, añadimos una sola puya social sobre los favoritos.
      // No convertimos la presentación en una conversación interminable.
      if (meaningful && splitFavorites) {
        const stingers = Array.isArray(presentation.splitFavoriteStingers) ? presentation.splitFavoriteStingers : [];
        if (stingers.length) {
          const primarySpeaker = items[0]?.speaker || 'commentator';
          const opposite = stingers.filter((entry) => entry?.speaker && entry.speaker !== primarySpeaker);
          const candidates = opposite.length ? opposite : stingers;
          const stinger = candidates[Math.floor(Math.random() * candidates.length)];
          const line = this.fillMapTemplate(stinger?.text, ctx);
          if (line) items.push({ speaker: stinger?.speaker === 'informant' ? 'informant' : 'commentator', text: line, eventLabel: 'Presentación · rivalidad de favoritos' });
        }
      } else if (meaningful && !sharedFavorite && !splitFavorites) {
        const soleFavKey = rafaFav || alexFav;
        if (soleFavKey && soleFavKey !== String(leader?.playerKey || '')) {
          const favoriteName = this.playerNameForKey(soleFavKey);
          const pool = rafaFav ? presentation.singleFavoriteCommentator : presentation.singleFavoriteInformant;
          const poolKey = rafaFav ? 'presentation.singleFavoriteCommentator' : 'presentation.singleFavoriteInformant';
          const line = this.pickMapPhrase(poolKey, pool);
          if (line) items.push({
            speaker: rafaFav ? 'commentator' : 'informant',
            text: this.fillMapTemplate(line, { ...ctx, favorite: favoriteName || ctx.favorite }),
            eventLabel: 'Presentación · favorito perseguidor',
          });
        }
      }

      const bundle = this.runtimeBundle('MAP_PRESENTATION', items.slice(0, 2), {
        class: 'critical', priority: Number(this.runtimeConfig.mapPresentation?.introPriority || 96),
        ttlMs: 20000, mode: 'opportunistic', mustSpeak: true,
      }, payload.source || 'map-presentation');
      bundle.mapSignature = this.currentMapSignature();
      return bundle;
    }

    buildMapFirstTouchBundle(payload = {}) {
      const pools = this.mapIntroData?.firstTouch || {};
      const standings = this.mapStandings();
      const playerKey = String(payload.playerKey || payload.playerName || this.localPlayerName || 'local');
      let player = standings.find((entry) => String(entry.playerKey) === playerKey) || null;
      if (!player && !standings.length) {
        player = { playerKey, username: payload.playerName || this.localPlayerName || 'Jugador', rank: 1, points: 0 };
      }
      const { leader, meaningful } = this.mapLeaderSnapshot(standings);
      const total = Math.max(1, standings.length || 1);
      const isLeader = Boolean(meaningful && player && String(player.playerKey) === String(leader.playerKey));
      const last = standings[standings.length - 1] || null;
      const isRealLast = Boolean(meaningful && player && last && String(player.playerKey) === String(last.playerKey) && Number(player.points || 0) < Number(leader.points || 0));
      const rafaOwns = Boolean(player && String(player.playerKey) === String(this.favorite.commentator || ''));
      const alexOwns = Boolean(player && String(player.playerKey) === String(this.favorite.informant || ''));
      let poolKey = 'general';
      let speaker = 'commentator';

      if (isRealLast && rafaOwns && alexOwns) { poolKey = 'lastPlaceCommentatorFavorite'; speaker = 'commentator'; }
      else if (isRealLast && rafaOwns && !alexOwns) { poolKey = 'lastPlaceCommentatorFavorite'; speaker = 'commentator'; }
      else if (isRealLast && alexOwns && !rafaOwns) { poolKey = 'lastPlaceInformantFavorite'; speaker = 'informant'; }
      else if (isRealLast) { poolKey = 'lastPlaceGeneral'; speaker = 'commentator'; }
      else if (isLeader && rafaOwns && alexOwns) { poolKey = 'leaderCommentatorFavorite'; speaker = 'commentator'; }
      else if (isLeader && rafaOwns && !alexOwns) { poolKey = 'leaderCommentatorFavorite'; speaker = 'commentator'; }
      else if (isLeader && alexOwns && !rafaOwns) { poolKey = 'leaderInformantFavorite'; speaker = 'informant'; }
      else if (isLeader) { poolKey = 'leaderGeneral'; speaker = 'commentator'; }
      else if (rafaOwns && !alexOwns) { poolKey = 'favoriteCommentator'; speaker = 'commentator'; }
      else if (alexOwns && !rafaOwns) { poolKey = 'favoriteInformant'; speaker = 'informant'; }
      else if (rafaOwns && alexOwns) { poolKey = 'favoriteCommentator'; speaker = 'commentator'; }

      const ctx = this.mapTemplateContext({ standings, player, playerName: player?.username || payload.playerName });
      ctx.total = total;
      const phrase = this.pickMapPhrase(`firstTouch.${poolKey}`, pools[poolKey])
        || '¡Primer toque del mapa para {player}! Que la física abra oficialmente el expediente.';
      const label = poolKey.startsWith('lastPlace') ? 'Primer toque · remontada'
        : poolKey.startsWith('leader') ? 'Primer toque · líder'
          : poolKey.startsWith('favorite') ? 'Primer toque · favorito' : 'Primer toque · apertura';
      const bundle = this.runtimeBundle('MAP_FIRST_TOUCH', [
        { speaker, text: this.fillMapTemplate(phrase, ctx), eventLabel: label, tone: 'sarcastic' },
      ], {
        class: 'critical', priority: Number(this.runtimeConfig.mapPresentation?.firstTouchPriority || 94),
        ttlMs: 18000, mode: 'opportunistic', mustSpeak: true,
      }, payload.source || 'map-first-touch');
      bundle.mapSignature = this.currentMapSignature();
      return bundle;
    }

    presentCurrentMap(payload = {}) {
      if (!this.matchActive) return { accepted: false, reason: 'match-inactive' };
      const online = !!this.session?.getStatus?.().online;
      if (online && this.session?.role === 'client') return { accepted: false, reason: 'client-not-authority' };
      const signature = this.currentMapSignature();
      if (this.mapIntroState.introDelivered && signature && signature === this.mapIntroState.signature) {
        return { accepted: false, reason: 'map-presentation-dedupe' };
      }
      this.postMatchInfo = null;
      this.postMatchSummaryCount = 0;
      this.lastPostMatchSummaryAt = 0;
      this.setNarrativePhase('gameplay', payload.source || 'map-presentation');
      this.markGameplayActivity('map-presentation');
      this.mapIntroState = { stage: 'awaiting-first-touch', signature, introDelivered: true, firstTouchArmed: true, firstTouchConsumed: false };
      this.director?.discardNonGuaranteedPending?.(['HOLE', 'HOLE_IN_ONE']);
      const bundle = this.buildMapPresentationBundle(payload);
      return this.deliverBundle(bundle);
    }

    scheduleMapPresentation(payload = {}, delayMs = 260) {
      const timer = window.setTimeout(() => {
        this.pendingTimers.delete(timer);
        if (this.matchActive) this.presentCurrentMap(payload);
      }, Math.max(0, Number(delayMs) || 0));
      this.pendingTimers.add(timer);
      return timer;
    }

    runtimeBundle(eventKey, items, policy = {}, source = 'runtime') {
      const now = Date.now();
      const normalized = (items || []).filter((item) => item?.text).map((item) => ({
        speaker: item.speaker === 'informant' ? 'informant' : 'commentator',
        text: String(item.text),
        eventKey,
        eventLabel: item.eventLabel || (eventKey === 'POST_MATCH_SUMMARY' ? 'Resumen de partida' : 'Estado informativo'),
        tone: item.tone || 'informative',
      }));
      const finalPolicy = {
        class: 'ambient', priority: 12, ttlMs: 1800, mode: 'filler', dedupeMs: 0,
        preempt: 'none', nearEndMs: 0, maxWords: 36, partnerChance: 0, cooldownMs: 0,
        ...policy,
      };
      return {
        id: `ann-runtime-${now}-${Math.random().toString(36).slice(2)}`,
        eventKey, eventAt: now, expiresAt: now + Number(finalPolicy.ttlMs || 1800),
        conversationExpiresAt: now + Math.max(Number(finalPolicy.ttlMs || 1800) + 2600, 4200),
        player: '', source, policy: finalPolicy, context: {}, items: normalized,
      };
    }

    buildPostMatchSummaryBundle() {
      const online = !!this.session?.getStatus?.().online;
      const secondPass = this.postMatchSummaryCount > 0;
      let first = '';
      let second = '';
      if (online) {
        const standings = this.session?.getStandings?.() || this.postMatchInfo?.standings || [];
        const winnerKey = this.postMatchInfo?.winnerPlayerKey || this.session?.winnerPlayerKey;
        const winner = standings.find((entry) => entry.playerKey === winnerKey) || standings[0];
        const podium = standings.slice(0, 3).map((entry) => `${entry.rank}. ${entry.username} (${Math.round(Number(entry.points) || 0)} pts)`).join(', ');
        const totalPlayers = standings.filter((entry) => entry.role === 'player').length;
        if (!secondPass) {
          first = winner
            ? `Cierre de partida. ${winner.username} termina al frente con ${Math.round(Number(winner.points) || 0)} puntos. Marcador definitivo confirmado por el host.`
            : 'Cierre de partida confirmado por el host. Ya no quedan acciones de juego pendientes.';
          second = podium
            ? `Resumen final: ${podium}. La partida queda cerrada y el marcador final queda confirmado.`
            : 'La fase de juego terminó. La cabina cierra con el resultado definitivo.';
        } else {
          first = winner
            ? `Segundo análisis de cierre: ${winner.username} conserva la victoria; el resultado ya es definitivo y no existe una jugada pendiente capaz de cambiarlo.`
            : 'Segundo análisis de cierre: el resultado final permanece confirmado.';
          second = `Participaron ${totalPlayers || standings.length} jugadores. La narración queda ahora en silencio hasta una nueva partida.`;
        }
      } else {
        const holes = Math.max(1, Number(this.game?.holes?.length || 1));
        const totalScore = Number(this.game?.totalScore || 0);
        const scoreText = totalScore === 0 ? 'par' : (totalScore > 0 ? `más ${totalScore}` : `menos ${Math.abs(totalScore)}`);
        const points = Math.round(Number(this.game?.arcadePoints || 0));
        const strokes = Math.round(Number(this.postMatchInfo?.strokes ?? this.game?.strokes) || 0);
        if (!secondPass) {
          first = `Recorrido completado. ${this.localPlayerName} termina ${holes} hoyos con score ${scoreText} y ${points} puntos acumulados.`;
          second = `Último hoyo resuelto en ${strokes} golpes. El último hoyo queda registrado y el recorrido está oficialmente cerrado.`;
        } else {
          first = `Balance final: ${holes} hoyos cerrados, score ${scoreText} y ${points} puntos. El resultado del recorrido queda confirmado.`;
          second = `La cabina cierra el análisis de ${this.localPlayerName}. Desde este momento la cabina queda en silencio hasta iniciar otro recorrido.`;
        }
      }
      return this.runtimeBundle('POST_MATCH_SUMMARY', [
        { speaker: 'commentator', text: first, eventLabel: 'Resumen de partida' },
        { speaker: 'informant', text: second, eventLabel: 'Análisis final' },
      ], { class: 'important', priority: 88, ttlMs: 7000, mode: 'opportunistic' }, 'postmatch-summary');
    }

    deliverBundle(bundle) {
      const online = !!this.session?.getStatus?.().online;
      if (!online) return this.director.submitBundle(bundle);
      if (this.session?.role !== 'host') return { accepted: false, reason: 'not-host' };
      const baseLead = Math.max(0.05, Number(this.runtimeConfig.sync?.leadSeconds || 0.32));
      const maxLead = Math.max(baseLead, Number(this.runtimeConfig.sync?.maxLeadSeconds || 1.1));
      const margin = Math.max(0, Number(this.runtimeConfig.sync?.jitterMarginSeconds || 0.16));
      const rtts = [...(this.session?.players?.values?.() || [])]
        .map((player) => Number(player?.clientId ? this.session?.transport?.getRtt?.(player.clientId) : player?.ping))
        .filter((value) => Number.isFinite(value) && value > 0);
      const worstOneWay = rtts.length ? Math.max(...rtts) / 2000 : 0;
      const lead = clamp(Math.max(baseLead, worstOneWay + margin), baseLead, maxLead);
      const startAt = this.authoritativeTime() + lead;
      // Los TTL del prototipo estaban pensados para ejecución local inmediata.
      // Al cruzar la red reservamos margen de transporte + alineación sin
      // cambiar la prioridad relativa ni permitir interrupciones.
      const allowance = Math.ceil(lead * 1000) + Math.max(500, Number(this.runtimeConfig.sync?.lateGraceMs || 900));
      const packetBundle = clone(bundle);
      const persistent = packetBundle.policy?.guaranteed === true || packetBundle.policy?.class === 'supercritical' || packetBundle.policy?.mustSpeak === true;
      if (!persistent) {
        packetBundle.expiresAt = Number(packetBundle.expiresAt || Date.now()) + allowance;
        packetBundle.conversationExpiresAt = Number(packetBundle.conversationExpiresAt || packetBundle.expiresAt) + allowance;
      }
      this.session.broadcastAnnouncerBundle?.(packetBundle, startAt);
      this.scheduleBundle(packetBundle, startAt);
      return { accepted: true, reason: 'broadcast' };
    }

    authoritativeTime() {
      if (!this.session) return 0;
      if (this.session.role === 'host') return Number(this.session.netTime) || 0;
      return Number(this.session.hostClock?.now?.()) || Number(this.session.netTime) || 0;
    }

    postMatchAllowsBundle(bundle) {
      if (this.narrativePhase !== 'postmatch') return true;
      if (!bundle) return false;
      if (bundle.policy?.guaranteed === true || bundle.policy?.class === 'supercritical') return true;
      if (bundle.source === 'postmatch-summary' || bundle.eventKey === 'POST_MATCH_SUMMARY') return true;
      return POST_MATCH_ALLOWED_EVENTS.has(String(bundle.eventKey || ''));
    }

    scheduleBundle(bundle, startAtNetTime) {
      if (!this.postMatchAllowsBundle(bundle)) return { accepted: false, reason: 'postmatch-stale-bundle' };
      const now = this.authoritativeTime();
      const deltaMs = Number.isFinite(startAtNetTime) ? (startAtNetTime - now) * 1000 : 0;
      const grace = Math.max(0, Number(this.runtimeConfig.sync?.lateGraceMs || 900));
      const persistent = bundle?.policy?.guaranteed === true || bundle?.policy?.class === 'supercritical' || bundle?.policy?.mustSpeak === true;
      if (!persistent && Number.isFinite(startAtNetTime) && deltaMs < -grace) return { accepted: false, reason: 'too-late' };
      const delay = persistent && deltaMs < 0 ? 0 : Math.max(0, deltaMs);
      if (delay < 18) return this.director.submitBundle(bundle);
      const timer = window.setTimeout(() => {
        this.pendingTimers.delete(timer);
        if (this.matchActive && this.postMatchAllowsBundle(bundle)) this.director.submitBundle(bundle);
      }, delay);
      this.pendingTimers.add(timer);
      return { accepted: true, reason: 'scheduled' };
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Perfil de modo. Una partida por turnos y un battle royale de ocho bolas no
    // son el mismo trabajo de locución: en turnos hay huecos naturales y cabe el
    // análisis; en battle hay caos simultáneo y lo que hace falta es elegir bien.
    // ══════════════════════════════════════════════════════════════════════════

    currentMode() {
      if (!this.session?.getStatus?.().online) return 'offline';
      return (this.session?.settings?.mode || 'turn') === 'battle' ? 'battle' : 'turn';
    }

    modeProfile() {
      return this.runtimeConfig.modeProfiles?.[this.currentMode()] || {};
    }

    flowConfig() {
      const flow = this.runtimeConfig.flow || {};
      const profile = this.modeProfile();
      return {
        ...flow,
        burstWindowMs: profile.burstWindowMs ?? flow.burstWindowMs ?? 220,
        maxLinesPerWindow: profile.maxLinesPerWindow ?? flow.maxLinesPerWindow ?? 6,
        semanticCooldownMs: profile.semanticCooldownMs ?? flow.semanticCooldownMs ?? 2600,
        speechBudget: profile.speechBudget ?? flow.speechBudget ?? 0.62,
      };
    }

    effectivePolicy(eventKey) {
      const base = this.composer.policy(eventKey);
      const override = this.modeProfile().eventOverrides?.[eventKey];
      return override ? { ...base, ...override } : base;
    }

    bundleShape(policy) {
      const profile = this.modeProfile();
      return {
        policy,
        dialogueScale: Number(profile.dialogueScale ?? 1),
        maxItems: Number(profile.maxItems ?? 3),
        maxWordsScale: Number(profile.maxWordsScale ?? 1),
      };
    }

    semanticOf(eventKey) {
      return String(this.personas?.commentator?.events?.[eventKey]?.semanticClass || 'general');
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Control de caudal. El dedupe original era por jugador+evento: ocho bolas
    // cayendo al agua a la vez producían ocho bloques y ninguno filtraba a otro.
    // ══════════════════════════════════════════════════════════════════════════

    flowAllows(eventKey, policy, now) {
      const flow = this.flowConfig();
      if (flow.enabled === false) return { ok: true };
      if (policy.class === 'supercritical' || policy.guaranteed === true) return { ok: true };
      const critical = policy.class === 'critical';
      const scale = critical ? 0.45 : 1;

      const gap = Math.max(0, Number(flow.globalMinGapMs || 0)) * scale;
      if (gap && now - this.flow.lastBundleAt < gap) return { ok: false, reason: 'flow-min-gap' };

      const windowMs = Math.max(1000, Number(flow.rateWindowMs || 10000));
      this.flow.recent = this.flow.recent.filter((entry) => now - entry.at <= windowMs);
      const cap = Math.max(1, Number(flow.maxLinesPerWindow || 6)) * (critical ? 1.5 : 1);
      if (this.flow.recent.length >= cap) return { ok: false, reason: 'flow-rate-cap' };

      // Tope real: el tiempo. Contar líneas no basta porque una línea tarda entre
      // 2 y 5 segundos en decirse; sin presupuesto de habla la cabina componía
      // tres veces más locución de la que cabe en el reloj, y todo ese exceso
      // acababa descartado o cediendo micrófono a media conversación.
      const budget = clamp(Number(flow.speechBudget ?? 0.62), 0.1, 1) * (critical ? 1.25 : 1);
      const spoken = this.flow.recent.reduce((sum, entry) => sum + Number(entry.ms || 0), 0);
      if (spoken + this.estimatePolicyMs(policy) > windowMs * budget) return { ok: false, reason: 'flow-speech-budget' };

      const cooldown = Math.max(0, Number(flow.semanticCooldownMs || 0)) * scale;
      const semantic = this.semanticOf(eventKey);
      if (cooldown && now - (this.flow.semanticAt.get(semantic) || 0) < cooldown) {
        return { ok: false, reason: 'flow-semantic-cooldown' };
      }
      return { ok: true };
    }

    /** Coste de habla estimado de un evento antes de componerlo, en ms. */
    estimatePolicyMs(policy) {
      const words = Math.max(6, Number(policy?.maxWords || 24));
      const rate = Math.max(0.45, Number(this.getSpeakerSettings('commentator').rate) || 1);
      return (words / (2.55 * rate)) * 1000 + 280;
    }

    noteFlow(eventKey, policy, bundle) {
      const now = Date.now();
      this.flow.lastBundleAt = now;
      for (const item of bundle?.items || []) {
        this.flow.recent.push({ at: now, ms: this.director?.estimateSpeechMs?.(item.text, item.speaker) ?? this.estimatePolicyMs(policy) });
      }
      if (!bundle?.items?.length) this.flow.recent.push({ at: now, ms: this.estimatePolicyMs(policy) });
      this.flow.semanticAt.set(this.semanticOf(eventKey), now);
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Foco narrativo: a quién está mirando la cabina. Sin esto, en battle royale
    // todos los jugadores compiten por el micrófono con el mismo peso y el relato
    // salta de bola en bola sin construir nada.
    // ══════════════════════════════════════════════════════════════════════════

    focusEnabled() {
      if (this.runtimeConfig.focus?.enabled === false) return false;
      return this.modeProfile().focus !== false;
    }

    updateFocus(eventKey, playerKey, payload, ctx) {
      if (!this.focusEnabled()) { this.focus.playerKey = ''; return; }
      const mode = this.modeProfile().focusMode || 'relevance';
      const now = Date.now();
      let next = '';
      let reason = mode;

      if (mode === 'local') next = String(playerKey || '');
      else if (mode === 'turn') {
        const turnEntry = this.mapStandings().find((entry) => entry.turn);
        next = String(turnEntry?.playerKey || playerKey || '');
        reason = 'turn';
      } else {
        const importance = Number(this.personas.commentator.events?.[eventKey]?.importance || 0);
        const held = now - Number(this.focus.since || 0) < Math.max(0, Number(this.runtimeConfig.focus?.minHoldMs || 3200));
        // Un rebote no mueve la cámara. Solo un suceso grande interrumpe el plano
        // actual, y la rotación normal exige al menos un hecho con entidad: si no,
        // el foco perseguiría a la última bola que tocó una pared.
        if (!this.focus.playerKey || importance >= 4 || (!held && importance >= 3)) {
          next = String(playerKey || '');
          reason = importance >= 4 ? 'action' : 'rotation';
        } else next = this.focus.playerKey;
      }

      if (!next || next === this.focus.playerKey) return;
      const previous = { key: this.focus.playerKey, name: this.focus.name };
      this.focus = {
        playerKey: next,
        name: this.playerNameForKey(next) || String(payload?.playerName || ctx?.player || ''),
        since: now, reason, announcedAt: this.focus.announcedAt,
      };
      this.maybeAnnounceFocusSwitch(previous, reason, ctx, payload);
    }

    applyFocusWeight(policy, playerKey) {
      if (!this.focusEnabled() || !this.focus.playerKey) return;
      if (String(playerKey) === this.focus.playerKey) return;
      const cfg = this.runtimeConfig.focus || {};
      policy.priority = Math.round(Number(policy.priority || 0) * clamp(cfg.offFocusPriorityScale ?? 0.55, 0.1, 1));
      if (cfg.offFocusDemote === false) return;
      if (policy.class === 'important') policy.class = 'progressive';
      else if (policy.class === 'critical') policy.class = 'important';
    }

    maybeAnnounceFocusSwitch(previous, reason, ctx, payload) {
      const cfg = this.runtimeConfig.focus || {};
      const now = Date.now();
      if (!previous?.key) return;
      // En modo por turnos el cambio de foco YA lo cuenta TURN_START. Anunciarlo
      // otra vez convierte cada relevo en dos frases que dicen lo mismo.
      if ((this.modeProfile().focusMode || 'relevance') === 'turn') return;
      if (this.mapStandings().length < 2) return;
      if (this.director?.isBusy()) return;
      if (now - Number(this.focus.announcedAt || 0) < Math.max(0, Number(cfg.switchCooldownMs || 7000))) return;
      if (!chance(cfg.switchAnnounceChance ?? 0.45)) return;

      const standings = this.mapStandings();
      const index = standings.findIndex((entry) => String(entry.playerKey) === this.focus.playerKey);
      const leaderKey = this.leaderKey();
      let path = 'focusSwitch.general';
      if (leaderKey && this.focus.playerKey === leaderKey) path = 'focusSwitch.toLeader';
      else if (index === 1) path = 'focusSwitch.toChaser';
      else if (index >= 0 && index === standings.length - 1 && standings.length >= 3) path = 'focusSwitch.toStruggler';
      else if (reason === 'action' && ctx?.opponent) path = 'focusSwitch.toRival';

      const tokens = {
        ...this.rivalryTokens(ctx, payload),
        player: this.focus.name || ctx?.player || 'el jugador',
        previous_focus: previous.name || 'el anterior',
      };
      const policy = { class: 'progressive', priority: 42, ttlMs: 1600, mode: 'opportunistic', maxWords: 24 };
      // El aviso de cambio de plano es cosmético: si no cabe en el presupuesto de
      // habla, cede sin discutir. Nunca debe robarle tiempo a un hecho de juego.
      if (!this.flowAllows('FOCUS_SWITCH', policy, now).ok) return;
      const item = this.rivalryItem(path, tokens, 'commentator', 'Cabina · cambio de foco');
      if (!item) return;
      this.focus.announcedAt = now;
      const bundle = this.runtimeBundle('FOCUS_SWITCH', [item], policy, 'focus-switch');
      const result = this.deliverBundle(bundle);
      if (result?.accepted) this.noteFlow('FOCUS_SWITCH', policy, bundle);
      return result;
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Banco de rivalidad (announcer/data/rivalry.json)
    // ══════════════════════════════════════════════════════════════════════════

    rivalryPool(path) {
      let node = this.rivalryData;
      for (const part of String(path || '').split('.')) {
        if (!node || typeof node !== 'object') return null;
        node = node[part];
      }
      return Array.isArray(node) ? node : null;
    }

    rivalryTokens(ctx = {}, payload = {}) {
      const standings = this.mapStandings();
      const { leader, second, meaningful, gap } = this.mapLeaderSnapshot(standings);
      return {
        player: ctx.player || payload.playerName || this.localPlayerName || 'el jugador',
        opponent: ctx.opponent || payload.opponentName || 'su rival',
        attacker: ctx.attacker || payload.attackerName || ctx.player || 'el atacante',
        victim: ctx.victim || payload.victimName || ctx.opponent || 'el rival',
        leader: meaningful ? leader.username : (ctx.leader || 'nadie todavía'),
        chaser: second?.username || 'el perseguidor',
        gap: meaningful ? Math.round(gap) : 0,
        favorite: ctx.favorite || this.playerNameForKey(this.favorite.commentator) || 'el favorito de la cabina',
        rafa_favorite: this.playerNameForKey(this.favorite.commentator) || 'todavía sin favorito',
        alex_favorite: this.playerNameForKey(this.favorite.informant) || 'todavía sin favorito',
        survivor_count: Number(ctx.survivorCount || standings.filter((entry) => !entry.finished).length || 0),
        score: ctx.score || 'sin cambios',
        count: Number(payload.count || 0),
        previous_focus: '',
      };
    }

    rivalryItem(path, tokens, speaker = 'commentator', label = 'Cabina') {
      const pool = this.rivalryPool(path);
      const phrase = this.pickMapPhrase(`rivalry.${path}`, pool);
      if (!phrase) return null;
      const text = this.fillMapTemplate(phrase, tokens);
      if (!text) return null;
      return {
        speaker: speaker === 'informant' ? 'informant' : 'commentator',
        text, eventLabel: label, tone: speaker === 'informant' ? 'informative' : 'sarcastic',
      };
    }

    playerRivalryLine(pair, state, ctx, payload, leaderKey) {
      const cfg = this.runtimeConfig.playerRivalry || {};
      if (cfg.enabled === false) return null;
      const now = Date.now();
      if (now - Number(state.lastLineAt || 0) < Math.max(0, Number(cfg.lineCooldownMs || 15000))) return null;
      const tokens = { ...this.rivalryTokens(ctx, payload), count: state.hits };
      const [a, b] = String(pair).split('|');
      const involvesLeader = leaderKey && (a === leaderKey || b === leaderKey);
      const attackerHits = [...state.byAttacker.values()];
      const oneSided = attackerHits.length === 1 && state.hits >= 3;
      const escalateEvery = Math.max(1, Number(cfg.escalateEvery || 2));

      let path = '';
      if (!state.bornAnnounced && state.hits >= Number(cfg.bornAtHits || 1)) {
        path = 'playerRivalry.born';
        state.bornAnnounced = true;
      } else if (involvesLeader && chance(0.6)) path = 'playerRivalry.leaderVsChaser';
      else if (oneSided) path = 'playerRivalry.oneSided';
      else if (state.hits % escalateEvery === 0) path = 'playerRivalry.escalate';
      if (!path) return null;
      state.lastLineAt = now;
      return this.rivalryItem(path, tokens, 'commentator', 'Rivalidad entre jugadores');
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Cabina viva: apuestas con cobro posterior, desacuerdos y pullas de favoritos
    // ══════════════════════════════════════════════════════════════════════════

    decorateBundle(bundle, eventKey, playerKey, ctx, effective) {
      if (!bundle?.items?.length) return;
      const extras = [];
      const settled = this.resolveBet(eventKey, playerKey, ctx);
      if (settled) extras.push(settled);
      else {
        const opened = this.maybeOpenBet(eventKey, playerKey, ctx);
        if (opened) extras.push(...opened);
      }
      if (effective?.rivalry) extras.push(effective.rivalry);
      const gag = this.maybeGag(eventKey, playerKey, ctx);
      if (gag) extras.push(gag);
      if (!extras.length) {
        const disagreement = this.maybeDisagreement(eventKey);
        if (disagreement) extras.push(...disagreement);
        else {
          const banter = this.maybeFavoriteBanter(ctx);
          if (banter) extras.push(banter);
        }
      }
      if (!extras.length) return;

      const cap = Math.max(2, Number(this.modeProfile().maxItems ?? 3) + 1);
      let added = 0;
      for (const item of extras) {
        if (bundle.items.length >= cap) break;
        // Tres frases seguidas de la misma voz dejan de sonar a cabina y empiezan
        // a sonar a monólogo. La tercera se descarta antes que romper el diálogo.
        const tail = bundle.items.slice(-2);
        if (tail.length === 2 && tail.every((previous) => previous.speaker === item.speaker)) continue;
        bundle.items.push({ ...item, eventKey: bundle.eventKey });
        added += 1;
      }
      if (!added) return;
      const room = added * 1600;
      if (Number.isFinite(bundle.expiresAt) && bundle.expiresAt < 1e15) bundle.expiresAt += room;
      if (Number.isFinite(bundle.conversationExpiresAt) && bundle.conversationExpiresAt < 1e15) bundle.conversationExpiresAt += room;
    }

    maybeOpenBet(eventKey, playerKey, ctx) {
      const cfg = this.runtimeConfig.booth || {};
      if (cfg.enabled === false || !BET_OPENERS.has(eventKey)) return null;
      if (this.booth.pendingBet) return null;
      if (Number(this.modeProfile().maxItems ?? 3) < 2) return null;
      const now = Date.now();
      if (now - Number(this.booth.lastBetAt || 0) < Math.max(0, Number(cfg.betCooldownMs || 34000))) return null;
      if (!chance(cfg.betChance ?? 0.3)) return null;
      const pool = this.rivalryPool('booth.bets.open');
      if (!pool?.length) return null;
      const entry = pool[Math.floor(Math.random() * pool.length)];
      const tokens = this.rivalryTokens(ctx, {});
      const first = this.fillMapTemplate(entry?.commentator, tokens);
      const second = this.fillMapTemplate(entry?.informant, tokens);
      if (!first || !second) return null;
      this.booth.pendingBet = { playerKey: String(playerKey || ''), openedAt: now };
      this.booth.lastBetAt = now;
      return [
        { speaker: 'commentator', text: first, eventLabel: 'Cabina · apuesta', tone: 'excited' },
        { speaker: 'informant', text: second, eventLabel: 'Cabina · apuesta aceptada', tone: 'informative' },
      ];
    }

    resolveBet(eventKey, playerKey, ctx) {
      const bet = this.booth.pendingBet;
      if (!bet) return null;
      const now = Date.now();
      const windowMs = Math.max(2000, Number(this.runtimeConfig.booth?.betWindowMs || 16000));
      if (now - bet.openedAt > windowMs) {
        this.booth.pendingBet = null;
        return this.rivalryItem('booth.bets.noResolution', this.rivalryTokens(ctx, {}), 'commentator', 'Cabina · apuesta sin resolver');
      }
      if (String(playerKey || '') !== bet.playerKey) return null;
      let path = '';
      let speaker = 'commentator';
      if (BET_WINS.has(eventKey)) path = 'booth.bets.commentatorWins';
      else if (BET_LOSSES.has(eventKey)) { path = 'booth.bets.informantWins'; speaker = 'informant'; }
      if (!path) return null;
      this.booth.pendingBet = null;
      return this.rivalryItem(path, this.rivalryTokens(ctx, {}), speaker, 'Cabina · apuesta resuelta');
    }

    maybeDisagreement(eventKey) {
      const cfg = this.runtimeConfig.booth || {};
      if (cfg.enabled === false) return null;
      // El desacuerdo necesita las dos mitades para entenderse: la lectura de Rafa
      // y la corrección de Álex. En battle no hay sitio para dos líneas extra.
      if (Number(this.modeProfile().maxItems ?? 3) < 3) return null;
      const now = Date.now();
      if (now - Number(this.booth.lastDisagreementAt || 0) < Math.max(0, Number(cfg.disagreementCooldownMs || 26000))) return null;
      if (Number(this.personas.commentator.events?.[eventKey]?.importance || 0) < 4) return null;
      if (!chance(cfg.disagreementChance ?? 0.22)) return null;
      const pool = this.rivalryPool('booth.disagreement');
      if (!pool?.length) return null;
      const entry = pool[Math.floor(Math.random() * pool.length)];
      if (!entry?.commentator || !entry?.informant) return null;
      this.booth.lastDisagreementAt = now;
      return [
        { speaker: 'commentator', text: entry.commentator, eventLabel: 'Cabina · desacuerdo', tone: 'excited' },
        { speaker: 'informant', text: entry.informant, eventLabel: 'Cabina · réplica', tone: 'sarcastic' },
      ];
    }

    maybeFavoriteBanter(ctx) {
      const cfg = this.runtimeConfig.booth || {};
      if (cfg.enabled === false) return null;
      const rafa = String(this.favorite.commentator || '');
      const alex = String(this.favorite.informant || '');
      if (!rafa && !alex) return null;
      const now = Date.now();
      if (now - Number(this.booth.lastFavoriteBanterAt || 0) < Math.max(0, Number(cfg.favoriteBanterCooldownMs || 30000))) return null;
      if (!chance(cfg.favoriteBanterChance ?? 0.28)) return null;
      const tokens = this.rivalryTokens(ctx, {});
      const split = rafa && alex && rafa !== alex;
      let path = '';
      let speaker = 'commentator';
      if (split && chance(0.55)) {
        speaker = chance(0.5) ? 'commentator' : 'informant';
        path = `booth.favoriteMockery.${speaker}`;
      } else {
        speaker = rafa ? 'commentator' : 'informant';
        path = `booth.favoriteDefense.${speaker}`;
        tokens.favorite = this.playerNameForKey(speaker === 'commentator' ? rafa : alex) || tokens.favorite;
      }
      const item = this.rivalryItem(path, tokens, speaker, 'Cabina · favoritos');
      if (item) this.booth.lastFavoriteBanterAt = now;
      return item;
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Memoria de partida: lo que convierte frases sueltas en chistes recurrentes
    // ══════════════════════════════════════════════════════════════════════════

    ledgerFor(playerKey) {
      const key = String(playerKey || 'local');
      let entry = this.ledger.get(key);
      if (!entry) {
        entry = { water: 0, outOfBounds: 0, reset: 0, sand: 0, nearMiss: 0, sabotageDone: 0, sabotageSuffered: 0, holes: 0, bestGoodStreak: 0 };
        this.ledger.set(key, entry);
      }
      return entry;
    }

    noteLedger(eventKey, playerKey, payload, ctx) {
      if (this.runtimeConfig.memory?.enabled === false) return;
      const entry = this.ledgerFor(playerKey);
      const bucket = LEDGER_EVENTS[eventKey];
      if (bucket) entry[bucket] += 1;
      if (eventKey === 'HOLE' || eventKey === 'HOLE_IN_ONE') entry.holes += 1;
      if (eventKey === 'SABOTAGE_SUCCESS') {
        entry.sabotageDone += 1;
        const victimKey = String(payload.victimKey || payload.opponentKey || '');
        if (victimKey) this.ledgerFor(victimKey).sabotageSuffered += 1;
      }
      entry.bestGoodStreak = Math.max(entry.bestGoodStreak, Math.floor(Number(ctx?.goodStreak || 0)));
    }

    maybeGag(eventKey, playerKey, ctx) {
      const cfg = this.runtimeConfig.memory || {};
      if (cfg.enabled === false) return null;
      const now = Date.now();
      if (now - Number(this.lastGagAt || 0) < Math.max(0, Number(cfg.gagCooldownMs || 12000))) return null;

      const candidates = [];
      const bucket = LEDGER_EVENTS[eventKey];
      if (bucket) candidates.push({ key: String(playerKey || ''), bucket });
      if (eventKey === 'SABOTAGE_SUCCESS') {
        candidates.push({ key: String(playerKey || ''), bucket: 'sabotageDone' });
        const victimKey = String(ctx?.victim ? this.victimKeyFrom(ctx) : '');
        if (victimKey) candidates.push({ key: victimKey, bucket: 'sabotageSuffered' });
      }
      if (eventKey === 'STREAK_GOOD') candidates.push({ key: String(playerKey || ''), bucket: 'goodStreak' });

      for (const candidate of candidates) {
        const entry = this.ledgerFor(candidate.key);
        const count = candidate.bucket === 'goodStreak' ? Math.floor(Number(ctx?.goodStreak || 0)) : Number(entry[candidate.bucket] || 0);
        const threshold = Number(cfg.thresholds?.[candidate.bucket] ?? 3);
        const repeat = Math.max(1, Number(cfg.repeatEvery || 2));
        if (count < threshold || (count - threshold) % repeat !== 0) continue;
        const gagKey = `${candidate.key}:${candidate.bucket}:${count}`;
        if (this.gagAt.has(gagKey)) continue;
        const tokens = { ...this.rivalryTokens(ctx, {}), count };
        if (candidate.key !== String(playerKey || '')) tokens.player = this.playerNameForKey(candidate.key) || tokens.player;
        const item = this.rivalryItem(`runningGags.${candidate.bucket}`, tokens, 'commentator', 'Memoria de partida');
        if (!item) continue;
        this.gagAt.set(gagKey, now);
        this.lastGagAt = now;
        return item;
      }
      return null;
    }

    victimKeyFrom(ctx) {
      if (!ctx?.victim || !this.session?.players) return '';
      for (const [key, player] of this.session.players.entries()) {
        if (player?.username === ctx.victim) return key;
      }
      return '';
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Frescura: el texto se compone al ocurrir el hecho, pero suena al haber
    // micrófono. Si esperó demasiado se narra como recuerdo, no como directo.
    // ══════════════════════════════════════════════════════════════════════════

    decorateStaleBundle(bundle, waitedMs) {
      const flow = this.flowConfig();
      if (flow.enabled === false || !bundle?.items?.length) return true;
      const persistent = bundle.policy?.guaranteed === true || bundle.policy?.class === 'supercritical' || bundle.policy?.mustSpeak === true;
      if (!persistent && waitedMs > Math.max(1000, Number(flow.staleDropMs || 9000))) return false;
      if (bundle.staleDecorated) return true;
      const shortMs = Math.max(400, Number(flow.staleShortMs || 1800));
      if (waitedMs < shortMs) return true;
      const longMs = Math.max(shortMs, Number(flow.staleLongMs || 4500));
      const pool = waitedMs >= longMs ? 'retrospective.long' : 'retrospective.short';
      const prefix = this.pickMapPhrase(`rivalry.${pool}`, this.rivalryPool(pool));
      if (!prefix) return true;
      bundle.items[0].text = `${prefix} ${bundle.items[0].text}`;
      bundle.staleDecorated = true;
      return 'decorated';
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Tick narrativo. Aquí nacen los eventos que el juego ya conocía pero nadie
    // traducía a locución: cambios de liderato, remontadas, empates, vuelo de la
    // bola, eliminaciones, turnos eternos y salvadas al borde del hoyo.
    // Todo se deriva desde el manager: multiplayerSession.js no se toca.
    // ══════════════════════════════════════════════════════════════════════════

    narrativeAuthority() {
      if (!this.ready || !this.enabled || !this.matchActive) return false;
      if (this.narrativePhase !== 'gameplay') return false;
      if (this.runtimeConfig.derivedEvents?.enabled === false) return false;
      if (this.mapIntroState.firstTouchArmed) return false;
      const online = !!this.session?.getStatus?.().online;
      if (online && this.session?.role !== 'host') return false;
      return true;
    }

    narrativeTick() {
      if (!this.narrativeAuthority() || this.derived.depth) return;
      this.derived.depth += 1;
      try {
        const now = Date.now();
        this.deriveBallEvents(now);
        this.deriveStandingsEvents(now);
        this.deriveTurnEvents(now);
        this.derived.pendingSaves = (this.derived.pendingSaves || []).filter((entry) => now - entry.at <= 2600);
      } catch (error) {
        console.error('[Announcer narrativeTick]', error);
      } finally {
        this.derived.depth -= 1;
      }
    }

    narrativeBalls() {
      const out = [];
      if (this.session?.getStatus?.().online) {
        for (const player of this.session.players?.values?.() || []) {
          if (player?.role !== 'player' || !player.ball || player.finished) continue;
          out.push({ key: String(player.playerKey), name: player.username, ball: player.ball });
        }
      } else if (this.game?.ball) {
        out.push({ key: 'offline', name: this.localPlayerName, ball: this.game.ball });
      }
      return out;
    }

    deriveBallEvents(now) {
      const hole = this.game?.hole;
      if (!hole) return;
      const cfg = this.runtimeConfig.derivedEvents || {};
      const mpp = Number(window.NoiseGolf?.CONFIG?.course?.metersPerPixel) || (1 / 18);
      const toKmh = (value) => Math.abs(Number(value) || 0) * mpp * 3.6;
      const cooldown = Math.max(1200, Number(cfg.ballCueCooldownMs || 5200));

      for (const { key, name, ball } of this.narrativeBalls()) {
        let track = this.derived.balls.get(key);
        if (!track) {
          track = { moving: false, airborne: false, rising: false, falling: false, fast: false, void: false, cues: new Map(), x: ball.x, y: ball.y };
          this.derived.balls.set(key, track);
        }
        const speedKmh = toKmh(Math.hypot(Number(ball.vx) || 0, Number(ball.vy) || 0));
        const riseKmh = toKmh(Math.min(0, Number(ball.vy) || 0));
        const fallKmh = toKmh(Math.max(0, Number(ball.vy) || 0));
        const airborne = !!ball.moving && ball.onSurface === false;
        const payload = { playerKey: key, playerName: name, speedKmh, source: 'derived-flight' };
        const fire = (eventKey, extra = {}) => {
          const last = track.cues.get(eventKey) || 0;
          if (now - last < cooldown) return;
          track.cues.set(eventKey, now);
          this.announceEvent(eventKey, { ...payload, ...extra });
        };

        // Vuelo. BALL_AIR/BALL_HIGH/FALL_START son eventos de traza: alimentan el
        // contexto de la jugada aunque casi nunca lleguen a hablar por sí solos.
        if (airborne && !track.airborne) fire('BALL_AIR');
        if (airborne && riseKmh >= Number(cfg.highRiseSpeed || 190) && !track.rising) {
          fire('BALL_HIGH', { heightMeters: Math.max(0, (hole.bounds.maxY - ball.y) * mpp) });
        }
        if (airborne && fallKmh >= Number(cfg.fallSpeed || 200) && track.rising && !track.falling) fire('FALL_START');
        if (speedKmh >= Number(cfg.fastSpeed || 250) && !track.fast) fire('BALL_FAST');

        // VOID_FALL: caer por debajo del mundo no es lo mismo que salirse por un
        // lateral, y el banco tenía frases distintas para cada cosa.
        const belowWorld = Number(ball.y) > Number(hole.bounds?.maxY || Infinity);
        if (belowWorld && !track.void && ball.moving) fire('VOID_FALL', { source: 'derived-void' });

        // EDGE_SAVE: la bola se detiene con agua al lado y no se cae dentro.
        if (track.moving && !ball.moving && !ball.holed && !ball.inWater) {
          const reach = Math.max(0.4, Number(cfg.edgeSaveMeters || 1.7)) / mpp;
          const util = window.NoiseGolf?.TerrainUtil;
          const surfaceId = ball.lastSurfaceId;
          const nearWater = util?.waterAt && (util.waterAt(hole, surfaceId, ball.x - reach) || util.waterAt(hole, surfaceId, ball.x + reach));
          if (nearWater) fire('EDGE_SAVE', { source: 'derived-edge' });
        }

        // RIVAL_SAVE: un choque que, sin querer, acerca a la víctima al hoyo.
        for (const entry of this.derived.pendingSaves || []) {
          if (entry.victimKey !== key || entry.resolved || now - entry.at < 900) continue;
          entry.resolved = true;
          const progress = this.progressFor(key);
          if (progress != null && entry.progress != null && progress - entry.progress >= Number(cfg.rivalSaveProgressGain || 0.07)) {
            this.announceEvent('RIVAL_SAVE', {
              playerKey: entry.attackerKey, playerName: this.playerNameForKey(entry.attackerKey) || 'el rival',
              opponentKey: key, opponentName: name, victimKey: key, victimName: name, source: 'derived-rival-save',
            });
          }
        }

        track.moving = !!ball.moving;
        track.airborne = airborne;
        track.rising = airborne && riseKmh >= Number(cfg.highRiseSpeed || 190) * 0.5;
        track.falling = airborne && fallKmh >= Number(cfg.fallSpeed || 200);
        track.fast = speedKmh >= Number(cfg.fastSpeed || 250);
        track.void = belowWorld;
        track.x = ball.x;
        track.y = ball.y;
      }
    }

    progressFor(playerKey) {
      const entry = this.mapStandings().find((row) => String(row.playerKey) === String(playerKey));
      const value = Number(entry?.progress);
      return Number.isFinite(value) ? value : null;
    }

    deriveStandingsEvents(now) {
      const standings = this.mapStandings();
      if (standings.length < 2) return;
      const cfg = this.runtimeConfig.derivedEvents || {};
      const cooldown = Math.max(1500, Number(cfg.scoreEventCooldownMs || 9000));
      const canSpeak = now - Number(this.derived.lastScoreEventAt || 0) >= cooldown;
      const leader = standings[0];
      const second = standings[1];
      const leaderKey = String(leader?.playerKey || '');
      const gap = Number(leader?.points || 0) - Number(second?.points || 0);

      // Eliminaciones: terminar sin puntos (tiempo agotado o límite de turnos) es
      // lo que en battle royale significa quedar fuera.
      for (const entry of standings) {
        const key = String(entry.playerKey);
        if (!entry.finished || Number(entry.finishOrder || 0) > 0) continue;
        if (this.derived.eliminations.some((item) => item.key === key)) continue;
        this.derived.eliminations.push({ key, at: now, name: entry.username });
      }
      const window = Math.max(600, Number(cfg.eliminationPairWindowMs || 2600));
      const fresh = this.derived.eliminations.filter((item) => !item.announced && now - item.at <= window * 2);
      if (fresh.length >= 2) {
        for (const item of fresh) item.announced = true;
        this.announceEvent('DOUBLE_ELIMINATION', {
          playerKey: fresh[0].key, playerName: fresh[0].name,
          opponentKey: fresh[1].key, opponentName: fresh[1].name,
          eliminatedPlayer: `${fresh[0].name} y ${fresh[1].name}`, source: 'derived-elimination',
        });
      } else if (fresh.length === 1 && now - fresh[0].at >= window * 0.4) {
        fresh[0].announced = true;
        this.announceEvent('PLAYER_ELIMINATED', {
          playerKey: fresh[0].key, playerName: fresh[0].name, eliminatedPlayer: fresh[0].name,
          survivorCount: standings.filter((entry) => !entry.finished).length, source: 'derived-elimination',
        });
      }

      if (canSpeak && this.derived.leaderKey && leaderKey && leaderKey !== this.derived.leaderKey
        && gap >= Number(cfg.leadChangeMinGap || 1)) {
        this.derived.lastScoreEventAt = now;
        this.announceEvent('LEAD_CHANGE', {
          playerKey: leaderKey, playerName: leader.username, points: leader.points, source: 'derived-standings',
        });
      }
      if (leaderKey) this.derived.leaderKey = leaderKey;

      const tied = gap === 0 && Number(leader?.points || 0) > 0;
      if (tied && !this.derived.tieActive && now - Number(this.derived.lastScoreEventAt || 0) >= cooldown) {
        this.derived.lastScoreEventAt = now;
        this.announceEvent('TIE', {
          playerKey: leaderKey, playerName: leader.username, opponentKey: String(second.playerKey),
          opponentName: second.username, points: leader.points, source: 'derived-standings',
        });
      }
      this.derived.tieActive = tied;

      const gainNeeded = Math.max(1, Number(cfg.comebackRankGain || 2));
      for (const entry of standings) {
        const key = String(entry.playerKey);
        const previous = this.derived.ranks.get(key);
        if (previous != null && previous - Number(entry.rank) >= gainNeeded
          && now - Number(this.derived.lastScoreEventAt || 0) >= cooldown) {
          this.derived.lastScoreEventAt = now;
          this.announceEvent('COMEBACK', {
            playerKey: key, playerName: entry.username, points: entry.points, source: 'derived-standings',
          });
          break;
        }
      }
      for (const entry of standings) this.derived.ranks.set(String(entry.playerKey), Number(entry.rank));

      // SCORE_UPDATE es ambiente puro: solo con micrófono libre y muy de tarde en
      // tarde. No es un relleno de inactividad, es un repaso de marcador.
      if (!this.director?.isBusy()
        && now - Number(this.derived.lastScoreUpdateAt || 0) >= Math.max(8000, Number(cfg.scoreUpdateCooldownMs || 24000))) {
        this.derived.lastScoreUpdateAt = now;
        this.announceEvent('SCORE_UPDATE', {
          playerKey: leaderKey, playerName: leader.username, points: leader.points,
          scoreText: `${leader.username} manda con ${Math.round(Number(leader.points) || 0)} puntos`, source: 'derived-score',
        });
      }
    }

    deriveTurnEvents(now) {
      if (this.currentMode() !== 'turn') return;
      const cfg = this.runtimeConfig.derivedEvents || {};
      const standings = this.mapStandings();
      const turnEntry = standings.find((entry) => entry.turn);
      const key = String(turnEntry?.playerKey || '');
      if (key !== this.derived.turnKey) {
        this.derived.turnKey = key;
        this.derived.turnSince = now;
        this.derived.lastTurnCue = 0;
        return;
      }
      if (!key || !turnEntry) return;

      // FINAL_TURN: al jugador le queda el último turno de este mundo.
      const limit = Number(this.session?.settings?.maxTurnsPerWorld);
      if (Number.isFinite(limit) && limit > 0) {
        const left = limit - Number(turnEntry.turnsUsed || 0);
        if (left > 0 && left <= Math.max(1, Number(cfg.finalTurnMargin || 1)) && !this.derived.finalTurnDone.has(key)) {
          this.derived.finalTurnDone.add(key);
          this.announceEvent('FINAL_TURN', {
            playerKey: key, playerName: turnEntry.username, turn: turnEntry.turnsUsed, source: 'derived-turn',
          });
          return;
        }
      }

      // Turno eterno. No es relleno de silencio: es un jugador bloqueando la
      // partida de los demás, que en modo por turnos sí es un hecho de juego.
      if (cfg.afkEnabled === false) return;
      if (this.session?.anyBallRolling?.()) return;
      const waited = now - Number(this.derived.turnSince || now);
      const slow = Math.max(4000, Number(cfg.slowPlayerMs || 24000));
      const afk = Math.max(3000, Number(cfg.afkWaitMs || 14000));
      if (waited >= slow && this.derived.lastTurnCue < 2) {
        this.derived.lastTurnCue = 2;
        const policy = { class: 'ambient', priority: 18, ttlMs: 2200, mode: 'filler', maxWords: 24 };
        if (!this.flowAllows('TURN_SLOW', policy, now).ok) return;
        const item = this.rivalryItem('turnMode.slowPlayer', { player: turnEntry.username }, 'commentator', 'Turnos · demora');
        if (item) {
          const bundle = this.runtimeBundle('TURN_SLOW', [item], policy, 'derived-turn');
          if (this.deliverBundle(bundle)?.accepted) this.noteFlow('TURN_SLOW', policy, bundle);
        }
      } else if (waited >= afk && this.derived.lastTurnCue < 1) {
        this.derived.lastTurnCue = 1;
        this.announceEvent('AFK_WAIT', { playerKey: key, playerName: turnEntry.username, source: 'derived-turn' });
      }
    }

    maybeRunPostMatchSummary() {
      if (!this.ready || !this.matchActive || !this.enabled) return;
      if (this.narrativePhase !== 'postmatch') return;
      const online = !!this.session?.getStatus?.().online;
      if (online && this.session?.role !== 'host') return;
      if (this.director?.isBusy()) return;

      const now = Date.now();
      const stateCfg = this.runtimeConfig.stateMachine || {};
      const delay = Math.max(0, Number(stateCfg.postMatchSummaryDelayMs || 1400));
      const cooldown = Math.max(delay, Number(stateCfg.postMatchSummaryCooldownMs || 10000));
      const max = Math.max(0, Math.floor(Number(stateCfg.postMatchSummaryMax ?? 2)));
      if (this.postMatchSummaryCount >= max) return;
      if (now - this.lastMeaningfulAt < delay) return;
      if (this.lastPostMatchSummaryAt && now - this.lastPostMatchSummaryAt < cooldown) return;

      const result = this.deliverBundle(this.buildPostMatchSummaryBundle());
      if (result?.accepted) {
        this.postMatchSummaryCount += 1;
        this.lastPostMatchSummaryAt = now;
      }
    }
  }

  NG.AnnouncerSystem = AnnouncerSystem;
}(window.NoiseGolf = window.NoiseGolf || {}));
