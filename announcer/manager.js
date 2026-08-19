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
      this.lastFillerAt = 0;
      this.voices = [];
      this.settings = null;
      this.fillerTimer = 0;
      this.pendingTimers = new Set();
      this.lastByPlayerEvent = new Map();
      this.lastHoleSignature = '';
      this.narrativePhase = 'inactive';
      this.activeAims = new Map();
      this.postMatchInfo = null;
      this.postMatchSummaryCount = 0;
      this.lastPostMatchSummaryAt = 0;
      this.informativeSequence = 0;
    }

    async init() {
      const fallbackConfig = window.NOISE_GOLF_ANNOUNCER_CONFIG || {};
      const fallbackPersonas = window.EMOTIONAL_MACHINE_PERSONAS || null;
      const [runtime, commentator, informant] = await Promise.all([
        this.fetchJson('./announcer/config.json', fallbackConfig),
        this.fetchJson('./announcer/data/commentator.json', fallbackPersonas?.commentator),
        this.fetchJson('./announcer/data/informant.json', fallbackPersonas?.informant),
      ]);
      if (!commentator || !informant) throw new Error('No se pudieron cargar los JSON internos de locución.');
      this.runtimeConfig = merge(fallbackConfig, runtime || {});
      this.personas = { commentator, informant };
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
      this.fillerTimer = window.setInterval(() => this.maybeFillSilence(), 1000);
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
      // Los defaults editables viven en el config.json general del juego.
      // Los cambios del jugador viven dentro de noiseGolf.profile.v1 mediante PlayerProfile.
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
        sharedVolume: clamp(stored.sharedVolume ?? defaults.sharedVolume ?? 0.9, 0, 1),
        captionsCollapsed: Boolean(stored.captionsCollapsed ?? defaults.captionsCollapsed ?? false),
        commentator: {
          name: String(stored.commentator?.name || defaults.commentator?.name || this.personas.commentator.identity?.name || 'Rafa Voltio').slice(0, 32),
          voiceURI: String(stored.commentator?.voiceURI || defaults.commentator?.voiceURI || ''),
          rate: clamp(stored.commentator?.rate ?? defaults.commentator?.rate ?? this.personas.commentator.voiceDefaults?.rate ?? 1, 0.5, 2),
          pitch: clamp(stored.commentator?.pitch ?? defaults.commentator?.pitch ?? this.personas.commentator.voiceDefaults?.pitch ?? 1, 0, 2),
        },
        informant: {
          name: String(stored.informant?.name || defaults.informant?.name || this.personas.informant.identity?.name || 'Álex Prisma').slice(0, 32),
          voiceURI: String(stored.informant?.voiceURI || defaults.informant?.voiceURI || ''),
          rate: clamp(stored.informant?.rate ?? defaults.informant?.rate ?? this.personas.informant.voiceDefaults?.rate ?? 1, 0.5, 2),
          pitch: clamp(stored.informant?.pitch ?? defaults.informant?.pitch ?? this.personas.informant.voiceDefaults?.pitch ?? 1, 0, 2),
        },
      };
      this.saveSettings();
      if (migratedLegacy && this.profile?.getAnnouncerSettings?.()) safeRemoveLegacyStorage();
    }

    saveSettings() {
      if (this.profile?.setAnnouncerSettings) this.profile.setAnnouncerSettings(this.settings);
      else safeWriteLegacyStorage(this.settings); // compatibilidad del demo aislado del subsistema
    }

    updateSettings(next) {
      if (!next || typeof next !== 'object') return this.getSettings();
      if (next.sharedVolume != null) this.settings.sharedVolume = clamp(next.sharedVolume, 0, 1);
      if (next.captionsCollapsed != null) this.settings.captionsCollapsed = Boolean(next.captionsCollapsed);
      for (const key of ['commentator', 'informant']) {
        const source = next[key];
        if (!source) continue;
        if (source.name != null) this.settings[key].name = String(source.name || '').trim().slice(0, 32) || this.personas[key].identity?.name || key;
        if (source.voiceURI != null) this.settings[key].voiceURI = String(source.voiceURI || '');
        if (source.rate != null) this.settings[key].rate = clamp(source.rate, 0.5, 2);
        if (source.pitch != null) this.settings[key].pitch = clamp(source.pitch, 0, 2);
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
    }

    setNarrativePhase(phase, reason = '') {
      const next = ['inactive', 'gameplay', 'informative', 'postmatch'].includes(phase) ? phase : 'gameplay';
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

    hasLiveGameplayActivity() {
      if (this.hasActiveAim()) return true;
      const online = !!this.session?.getStatus?.().online;
      if (online) {
        if (this.session?.anyBallRolling?.()) return true;
        const status = this.session?.getStatus?.() || {};
        if (Number(status.rollingBalls) > 0) return true;
        if (Number(this.session?.transitionTimer) > 0 || Number(this.session?.transitionHold) > 0) return true;
        return false;
      }
      return Boolean(this.game?.dragging || this.game?.ball?.moving || this.game?.isIntroPlaying?.());
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
        this.announceEvent('MATCH_START', { playerName: this.localPlayerName, source: 'offline-match' });
        this.lastHoleSignature = this.offlineHoleSignature();
        this.announceEvent('ROUND_START', { playerName: this.localPlayerName, source: 'offline-round' });
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
      this.lastFillerAt = 0;
      this.lastByPlayerEvent.clear();
      this.lastHoleSignature = '';
      this.activeAims.clear();
      this.postMatchInfo = null;
      this.postMatchSummaryCount = 0;
      this.lastPostMatchSummaryAt = 0;
      this.informativeSequence = 0;
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
      this.announceEvent('ROUND_START', { playerName: this.localPlayerName, source: 'offline-round' });
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

    onShot(payload = {}) {
      if (!this.matchActive || this.session?.getStatus?.().online) return;
      this.activeAims.delete('offline');
      this.markGameplayActivity('shot', 'offline');
      const power = clamp(payload.power ?? 0, 0, 1);
      const cfg = this.runtimeConfig.gameplay || {};
      let eventKey = 'SHOT_TAKEN';
      if (power <= Number(cfg.shotWeakPower ?? 0.34)) eventKey = 'SHOT_WEAK';
      else if (power >= Number(cfg.shotStrongPower ?? 0.84)) eventKey = 'SHOT_STRONG';
      else if (power >= Number(cfg.shotPerfectMinPower ?? 0.62) && power <= Number(cfg.shotPerfectMaxPower ?? 0.78)) eventKey = 'SHOT_PERFECT';
      this.announceEvent(eventKey, { ...payload, playerName: this.localPlayerName, source: 'offline-shot' });
    }

    onOfflineEvent(eventKey, payload = {}) {
      if (!this.matchActive || this.session?.getStatus?.().online) return;
      this.announceEvent(eventKey, { ...payload, playerName: payload.playerName || this.localPlayerName, source: payload.source || 'offline' });
    }

    handleNetworkCue(cue) {
      if (!cue || this.session?.role !== 'host') return;
      let eventKey = cue.eventKey;
      if (eventKey === 'SHOT_TAKEN' && Number.isFinite(Number(cue.power))) {
        const power = clamp(Number(cue.power), 0, 1);
        const cfg = this.runtimeConfig.gameplay || {};
        if (power <= Number(cfg.shotWeakPower ?? 0.34)) eventKey = 'SHOT_WEAK';
        else if (power >= Number(cfg.shotStrongPower ?? 0.84)) eventKey = 'SHOT_STRONG';
        else if (power >= Number(cfg.shotPerfectMinPower ?? 0.62) && power <= Number(cfg.shotPerfectMaxPower ?? 0.78)) eventKey = 'SHOT_PERFECT';
      }
      this.announceEvent(eventKey, { ...cue, eventKey, source: cue.source || 'host-authority' });
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
      this.scheduleBundle(packet.bundle, Number(packet.startAtNetTime));
    }

    enterPostMatch(info = {}) {
      if (!this.matchActive) return;
      this.activeAims.clear();
      this.postMatchInfo = { ...(info || {}), at: Date.now() };
      this.postMatchSummaryCount = 0;
      this.lastPostMatchSummaryAt = 0;
      this.lastMeaningfulAt = Date.now();
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
      this.announceEvent('MATCH_START', { playerName: this.localPlayerName, source: 'offline-new-course' });
    }

    announceEvent(eventKey, payload = {}) {
      if (!this.ready || !this.enabled || !eventKey) return { accepted: false, reason: 'not-ready' };
      const online = !!this.session?.getStatus?.().online;
      if (online && this.session?.role === 'client') return { accepted: false, reason: 'client-not-authority' };
      if (this.narrativePhase === 'postmatch' && !POST_MATCH_ALLOWED_EVENTS.has(eventKey)) {
        return { accepted: false, reason: 'postmatch-gameplay-suppressed' };
      }

      const playerKey = String(payload.playerKey || payload.playerName || this.localPlayerName || 'local');
      const policy = this.composer.policy(eventKey);
      const guaranteed = (this.runtimeConfig.stateMachine?.guaranteedEvents || [...GUARANTEED_EVENTS]).includes(eventKey);
      const now = Date.now();
      this.markGameplayActivity(eventKey, playerKey);
      const dedupeKey = `${playerKey}:${eventKey}`;
      const last = this.lastByPlayerEvent.get(dedupeKey) || 0;
      const dedupeMs = Math.max(0, Number(policy.dedupeMs || 0));
      if (dedupeMs && now - last < dedupeMs) return { accepted: false, reason: 'dedupe' };
      this.lastByPlayerEvent.set(dedupeKey, now);

      const context = this.applyCueToContext(eventKey, payload);
      if (policy.mode === 'trace') {
        this.lastMeaningfulAt = now;
        return { accepted: true, reason: 'trace-folded' };
      }
      if (!guaranteed && (policy.mode === 'opportunistic' || policy.mode === 'filler') && this.director?.isBusy()) {
        return { accepted: false, reason: 'mic-busy' };
      }

      const effective = this.socializeEvent(eventKey, context, payload);
      const bundle = this.composer.buildBundle(effective.primary, clone(context), payload.source || 'game');
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
      const mode = payload.mode || this.session?.settings?.mode || 'offline';
      if (mode === 'battle' && eventKey === 'PLAYER_COLLISION' && ctx.opponent) {
        const a = String(payload.playerKey || ctx.player);
        const b = String(payload.opponentKey || ctx.opponent);
        const pair = [a, b].sort().join('|');
        const state = this.rivalries.get(pair) || { hits: 0, lastAttacker: '' };
        state.hits += 1;
        const attacker = String(payload.attackerKey || payload.playerKey || '');
        const reversed = state.lastAttacker && attacker && state.lastAttacker !== attacker;
        state.lastAttacker = attacker || state.lastAttacker;
        this.rivalries.set(pair, state);
        ctx.rivalryLevel = state.hits;
        if (state.hits >= Number(this.runtimeConfig.gameplay?.revengeHits || 3) && reversed) extra = 'REVENGE_HIT';
        else if (state.hits === Number(this.runtimeConfig.gameplay?.rivalryHeatHits || 2)) extra = 'RIVALRY_HEATS_UP';
        else if (chance(this.runtimeConfig.gameplay?.tauntChance ?? 0.26)) extra = 'PLAYER_TAUNT';
      }

      const favoriteExtra = this.updateFavorites(eventKey, payload, ctx);
      if (favoriteExtra) { extra = favoriteExtra.eventKey; extraSpeaker = favoriteExtra.speaker; }
      return { primary, extra, extraSpeaker };
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
          this.favorite[speaker] = candidate;
          this.lastFavoriteSwitchAt[speaker] = now;
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

    liveInformation() {
      const online = !!this.session?.getStatus?.().online;
      const hole = this.game?.hole;
      const holeNumber = Math.max(1, Number(this.game?.holeIndex || 0) + 1);
      const holeCount = Math.max(holeNumber, Number(this.game?.holes?.length || 1));
      const par = Math.max(1, Number(hole?.par || 0));
      if (online) {
        const standings = this.session?.getStandings?.() || [];
        const leader = standings[0];
        const active = standings.filter((entry) => entry.role === 'player' && !entry.finished);
        const status = this.session?.getStatus?.() || {};
        const mode = this.session?.settings?.mode === 'battle' ? 'Battle Royale' : 'por turnos';
        const timer = Number.isFinite(Number(status.timerRemaining)) ? ` Quedan ${Math.ceil(Number(status.timerRemaining))} segundos en el reloj actual.` : '';
        const leaderText = leader ? `${leader.username} lidera con ${Math.round(Number(leader.points) || 0)} puntos.` : 'El marcador todavía no tiene líder definido.';
        return {
          first: `Pausa informativa. Hoyo ${holeNumber} de ${holeCount}, par ${par}, modo ${mode}. ${leaderText}${timer}`,
          second: active.length
            ? `Siguen activos ${active.length} jugadores: ${active.slice(0, 4).map((entry) => entry.username).join(', ')}${active.length > 4 ? ' y compañía' : ''}. En cuanto vuelva la acción, regresamos a la jugada.`
            : 'No hay bolas activas resolviendo una jugada. La cabina queda en modo de análisis hasta el siguiente estado del host.',
        };
      }

      const ball = this.game?.ball;
      const strokes = Math.max(0, Number(this.game?.strokes || 0));
      const distance = ball && hole?.cup
        ? Math.hypot(hole.cup.x - ball.x, hole.cup.y - ball.y) * Number(NG.CONFIG?.course?.metersPerPixel || 1)
        : 0;
      const difficulty = hole?.difficultyLabel || hole?.archetypeLabel || 'procedural';
      return {
        first: `Pausa informativa. Hoyo ${holeNumber} de ${holeCount}, par ${par}, dificultad ${difficulty}. Van ${strokes} golpes y quedan aproximadamente ${distance < 10 ? distance.toFixed(1) : Math.round(distance)} metros hasta la copa.`,
        second: `El mapa está estable y no hay una acción en curso. Cuando vuelvas a apuntar o la bola entre en movimiento, la narración retorna inmediatamente al juego.`,
      };
    }

    buildInformativeBundle() {
      const info = this.liveInformation();
      const alternate = (this.informativeSequence++ % 2) === 1;
      const items = alternate
        ? [{ speaker: 'commentator', text: info.second }, { speaker: 'informant', text: info.first }]
        : [{ speaker: 'informant', text: info.first }, { speaker: 'commentator', text: info.second }];
      return this.runtimeBundle('INFORMATIVE_STATE', items, { class: 'ambient', priority: 12, ttlMs: 2200 }, 'idle-information');
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
            ? `Resumen final: ${podium}. La partida queda cerrada; a partir de aquí solo analizamos el resultado.`
            : 'La fase de juego terminó. La cabina pasa a resumen y no volverá a describir tiros inexistentes.';
        } else {
          first = winner
            ? `Segundo análisis de cierre: ${winner.username} conserva la victoria; el resultado ya es definitivo y no existe una jugada pendiente capaz de cambiarlo.`
            : 'Segundo análisis de cierre: el estado final sigue congelado y no existen acciones pendientes.';
          second = `Participaron ${totalPlayers || standings.length} jugadores. La narración queda ahora en silencio hasta una nueva partida o un nuevo estado real del juego.`;
        }
      } else {
        const holes = Math.max(1, Number(this.game?.holes?.length || 1));
        const totalScore = Number(this.game?.totalScore || 0);
        const scoreText = totalScore === 0 ? 'par' : (totalScore > 0 ? `más ${totalScore}` : `menos ${Math.abs(totalScore)}`);
        const points = Math.round(Number(this.game?.arcadePoints || 0));
        const strokes = Math.round(Number(this.postMatchInfo?.strokes ?? this.game?.strokes) || 0);
        if (!secondPass) {
          first = `Recorrido completado. ${this.localPlayerName} termina ${holes} hoyos con score ${scoreText} y ${points} puntos acumulados.`;
          second = `Último hoyo resuelto en ${strokes} golpes. El juego ya está en post-partida: ahora toca resumen, no comentarios de una jugada que ya terminó.`;
        } else {
          first = `Balance final: ${holes} hoyos cerrados, score ${scoreText} y ${points} puntos. No queda ninguna bola resolviendo una acción.`;
          second = `La cabina cierra el análisis de ${this.localPlayerName}. Desde este momento no habrá más narración de gameplay hasta iniciar otro recorrido.`;
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
      const guaranteed = packetBundle.policy?.guaranteed === true || packetBundle.policy?.class === 'supercritical';
      if (!guaranteed) {
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
      const guaranteed = bundle?.policy?.guaranteed === true || bundle?.policy?.class === 'supercritical';
      if (!guaranteed && Number.isFinite(startAtNetTime) && deltaMs < -grace) return { accepted: false, reason: 'too-late' };
      const delay = guaranteed && deltaMs < 0 ? 0 : Math.max(0, deltaMs);
      if (delay < 18) return this.director.submitBundle(bundle);
      const timer = window.setTimeout(() => {
        this.pendingTimers.delete(timer);
        if (this.matchActive && this.postMatchAllowsBundle(bundle)) this.director.submitBundle(bundle);
      }, delay);
      this.pendingTimers.add(timer);
      return { accepted: true, reason: 'scheduled' };
    }

    maybeFillSilence() {
      if (!this.ready || !this.matchActive || !this.enabled || this.runtimeConfig.dialogue?.allowQuietFiller === false) return;
      const online = !!this.session?.getStatus?.().online;
      if (online && this.session?.role !== 'host') return;
      if (this.director?.isBusy()) return;
      const now = Date.now();
      const stateCfg = this.runtimeConfig.stateMachine || {};

      if (this.narrativePhase === 'postmatch') {
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
        return;
      }

      // Mientras alguien mantiene el apuntado, la partida NO está inactiva.
      // El host conoce este estado también para clientes remotos mediante
      // reportAnnouncerActivity(), así que ningún peer entra solo en filler.
      if (this.hasLiveGameplayActivity()) {
        this.lastMeaningfulAt = now;
        this.setNarrativePhase('gameplay', 'live-map-activity');
        return;
      }

      const quiet = Math.max(1000, Number(stateCfg.idleAfterMs || this.runtimeConfig.dialogue?.quietBeforeFillerMs || 6200));
      const cooldown = Math.max(1000, Number(stateCfg.informativeCooldownMs || this.runtimeConfig.dialogue?.fillerCooldownMs || 9000));
      if (now - this.lastMeaningfulAt < quiet || now - this.lastFillerAt < cooldown) return;
      this.setNarrativePhase('informative', 'no-gameplay-activity');
      const result = this.deliverBundle(this.buildInformativeBundle());
      if (result?.accepted) this.lastFillerAt = now;
    }
  }

  NG.AnnouncerSystem = AnnouncerSystem;
}(window.NoiseGolf = window.NoiseGolf || {}));
