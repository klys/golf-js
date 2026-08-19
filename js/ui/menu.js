(function (NG) {
  'use strict';

  const VOTE_RING_CIRCUMFERENCE = 2 * Math.PI * 52;

  // Sugerencias de nombre generadas en local: ninguna llamada externa.
  const NAME_PREFIX = ['Águila', 'Birdie', 'Bunker', 'Caddie', 'Driver', 'Eagle', 'Hierro', 'Putt', 'Sand', 'Wedge', 'Green', 'Fairway'];
  const NAME_SUFFIX = ['Veloz', 'Táctico', 'Cósmico', 'Sur', 'Norte', 'Nitro', 'Prisma', 'Turbo', 'Zen', 'Volcán', 'Ártico', 'Neón'];

  const formatInt = (value) => Math.max(0, Math.round(Number(value) || 0)).toLocaleString('es-ES');
  const WORLD_IDS = Object.freeze(['meadow', 'sky-islands', 'cavern', 'aqua-cavern', 'hybrid', 'glacier']);
  const WORLD_LABELS = Object.freeze({
    meadow: 'Pradera alta',
    'sky-islands': 'Islas flotantes',
    cavern: 'Cañón y túneles',
    'aqua-cavern': 'Cuevas submarinas',
    hybrid: 'Ruta híbrida',
    glacier: 'Glaciar cinético',
  });
  const CREATE_DEFAULTS = Object.freeze({
    maxPlayers: 8,
    maxPoints: 5000,
    pointsEnabled: true,
    worldTimeSeconds: 180,
    worldTimeEnabled: false,
    finishTimeSeconds: 45,
    finishTimeEnabled: true,
    turnLimit: 12,
    turnLimitEnabled: false,
    collisionsEnabled: true,
  });

  const boundedInt = (value, fallback, min, max) => {
    const numeric = value === '' || value == null ? NaN : Number(value);
    return Math.max(min, Math.min(max, Math.round(Number.isFinite(numeric) ? numeric : fallback)));
  };
  const durationText = (seconds) => {
    const total = Math.max(0, Math.round(Number(seconds) || 0));
    if (total >= 60 && total % 60 === 0) return `${total / 60} min`;
    if (total >= 60) return `${Math.floor(total / 60)} min ${total % 60} s`;
    return `${total} s`;
  };

  class MenuController {
    constructor(game, profile, networkHud, metrics) {
      this.game = game;
      this.profile = profile;
      this.networkHud = networkHud;
      this.metrics = metrics || null;
      this.session = null;
      this.servers = [];
      this.serverPings = new Map();
      this.selectedLobby = null;
      this.selectedMode = 'turn';
      this.modeFilter = 'all';
      this.onlineAvailable = false;
      this.preflightRunning = false;
      this.preflightLobbyIds = new Set();
      this.preflightRtt = null;
      this.unloadHandled = false;
      this.currentScreen = 'preflight';
      this.autoRefreshTimer = null;
      this.autoRefreshCountdown = 0;
      this.refreshing = false;

      const $ = (selector) => document.querySelector(selector);
      this.root = $('#frontEnd');
      this.notice = $('#menuNotice');
      this.serverList = $('#serverList');
      this.serverCount = $('#serverCount');
      this.autoRefreshLabel = $('#autoRefreshLabel');
      this.searchInput = $('#serverSearchInput');
      this.sortSelect = $('#serverSort');
      this.hideFullToggle = $('#hideFullToggle');
      this.joinPanel = $('#joinPasswordPanel');
      this.joinPasswordInput = $('#joinPasswordInput');
      this.joinPasswordTitle = $('#joinPasswordTitle');
      this.joinTitle = $('#joinTitle');
      this.joinStatus = $('#joinStatus');
      this.joinProgress = $('#joinProgressBar');
      this.joinSteps = $('#joinSteps');
      this.runtimeMode = $('#runtimeModeLabel');
      this.gameMenu = $('#gameMenuPanel');
      this.votePanel = $('#mapVotePanel');
      this.reconnectPanel = $('#reconnectPanel');
      this.reconnectCountdown = $('#reconnectCountdown');
      this.reconnectAttempts = $('#reconnectAttempts');
      this.reconnectBar = $('#reconnectBar');
      this.reconnectDetail = $('#reconnectDetail');
      this.reconnectTitle = $('#reconnectTitle');
      this.matchConfigPanel = $('#matchConfigPanel');
      this.matchConfigTrigger = $('#openMatchConfigBtn');
      this.relayPill = $('#relayPill');
      this.relayPillText = $('#relayPillText');

      this.bind();
      this.game.announcer?.bindMenu?.(this);
      this.refreshProfileUI();
      this.updateOnlineConfigStatus();
      this.updateReconnectButton();
      this.updateCreateSummary();
      this.game.setInputLocked(true);
      this.setOfflineHud();

      if (this.profile.username) {
        this.runPreflight({ initial: true });
      } else {
        // Sin nombre no se toca la red: el preflight arrancará al guardar el perfil.
        this.setRelayPill('idle', 'Relay sin comprobar');
        this.showScreen('profile');
      }
    }

    env() { return NG.ClientEnv?.config || {}; }

    ensureSession() {
      if (!this.session) {
        this.session = new NG.MultiplayerSession(this.game, this.profile);
        this.wireSession(this.session);
      }
      return this.session;
    }

    prepareSession() {
      if (this.session) {
        // Sustituir una sesión desde el menú es una salida explícita, no una recarga.
        // Retiramos cualquier reserva/lobby anterior para no dejar slots fantasma.
        if (this.session.role !== 'offline' && this.session.lobby?.id && this.session.signaling?.connected) {
          try { this.session.signaling.send('lobby:leave', { lobbyId: this.session.lobby.id }); } catch (_) { /* noop */ }
          try { this.profile.clearLastSession(); } catch (_) { /* noop */ }
        }
        try { this.session.relay.close(true); } catch (_) { /* noop */ }
        try { if (this.session.transport) this.session.transport.close(); } catch (_) { /* noop */ }
      }
      this.session = new NG.MultiplayerSession(this.game, this.profile);
      this.wireSession(this.session);
      return this.session;
    }

    bind() {
      const $ = (selector) => document.querySelector(selector);
      $('#playOfflineBtn')?.addEventListener('click', () => this.playOffline());
      $('#onlineBtn')?.addEventListener('click', () => this.openOnline());
      $('#reconnectBtn')?.addEventListener('click', () => this.reconnectLast());
      $('#reconnectNowBtn')?.addEventListener('click', () => this.session?.beginReconnect('manual'));
      $('#reconnectLeaveBtn')?.addEventListener('click', () => {
        this.session?.cancelReconnect();
        this.hideReconnectPanel();
        this.leaveOnline();
      });
      $('#profileButton')?.addEventListener('click', () => this.showScreen('profile'));
      $('#createMatchBtn')?.addEventListener('click', () => this.openCreate());
      $('#browseMatchBtn')?.addEventListener('click', () => this.openBrowser());
      $('#refreshServersBtn')?.addEventListener('click', () => this.refreshServers());
      $('#cancelJoinBtn')?.addEventListener('click', () => this.cancelJoin());
      $('#cancelPasswordBtn')?.addEventListener('click', () => this.hidePasswordModal());
      $('#gameMenuBtn')?.addEventListener('click', () => this.openGameMenu());
      $('#resumeGameBtn')?.addEventListener('click', () => this.closeGameMenu());
      $('#resetShotBtn')?.addEventListener('click', () => this.returnToShotOrigin());
      $('#returnHomeBtn')?.addEventListener('click', () => this.returnHome());
      $('#requestMapVoteBtn')?.addEventListener('click', () => this.requestMapVote());
      $('#mapVoteYesBtn')?.addEventListener('click', () => this.castMapVote('yes'));
      $('#mapVoteNoBtn')?.addEventListener('click', () => this.castMapVote('no'));
      $('#preflightRetryBtn')?.addEventListener('click', () => this.runPreflight());
      $('#preflightOfflineBtn')?.addEventListener('click', () => this.playOffline());
      $('#preflightMenuBtn')?.addEventListener('click', () => this.showScreen('main'));
      $('#randomNameBtn')?.addEventListener('click', () => this.suggestName());
      $('#musicVolume')?.addEventListener('input', (event) => {
        this.game.music?.setVolume(Number(event.target.value) / 100);
        this.renderAudioSettings();
      });
      $('#musicMuteBtn')?.addEventListener('click', () => {
        this.game.music?.toggleMuted();
        this.renderAudioSettings();
      });
      this.matchConfigTrigger?.addEventListener('click', () => this.openMatchConfig());
      $('#closeMatchConfigBtn')?.addEventListener('click', () => this.closeMatchConfig());
      $('#saveMatchConfigBtn')?.addEventListener('click', () => this.saveMatchConfig());
      $('#resetMatchConfigBtn')?.addEventListener('click', () => this.resetMatchConfig());
      this.matchConfigPanel?.addEventListener('click', (event) => {
        if (event.target === event.currentTarget) this.closeMatchConfig();
      });

      window.addEventListener('keydown', (event) => {
        if (event.key === 'Tab' && !this.matchConfigPanel?.classList.contains('hidden')) {
          const focusable = [...this.matchConfigPanel.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])')]
            .filter((element) => !element.hidden && element.offsetParent !== null);
          if (focusable.length) {
            const first = focusable[0], last = focusable[focusable.length - 1];
            if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
            else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
          }
          return;
        }
        if (event.key !== 'Escape') return;
        if (!this.matchConfigPanel?.classList.contains('hidden')) {
          this.closeMatchConfig();
          return;
        }
        if (!this.root?.classList.contains('hidden')) return;
        if (!this.votePanel?.classList.contains('hidden')) return;
        if (this.gameMenu?.classList.contains('hidden')) this.openGameMenu();
        else this.closeGameMenu();
      });
      window.addEventListener('pagehide', () => this.handlePageExit());
      window.addEventListener('beforeunload', () => this.handlePageExit());

      document.querySelectorAll('[data-back]').forEach((button) => button.addEventListener('click', () => this.showScreen(button.dataset.back)));
      document.querySelectorAll('.mode-option').forEach((button) => button.addEventListener('click', () => {
        this.selectedMode = button.dataset.mode === 'battle' ? 'battle' : 'turn';
        document.querySelectorAll('.mode-option').forEach((item) => {
          const selected = item === button;
          item.classList.toggle('active', selected);
          item.setAttribute('aria-pressed', String(selected));
        });
        this.syncCreateConfig();
      }));
      document.querySelectorAll('#modeFilter button').forEach((button) => button.addEventListener('click', () => {
        this.modeFilter = button.dataset.filter || 'all';
        document.querySelectorAll('#modeFilter button').forEach((item) => item.classList.toggle('active', item === button));
        this.renderServers();
      }));

      const dependentRules = [
        ['#createPointsEnabled', '#createMaxPoints'],
        ['#createWorldTimeEnabled', '#createWorldTimeSeconds'],
        ['#createFinishTimeEnabled', '#createFinishTimeSeconds'],
        ['#createTurnLimitEnabled', '#createTurnLimit'],
      ];
      for (const [toggleSelector] of dependentRules) {
        $(toggleSelector)?.addEventListener('change', () => this.syncCreateConfig({ announce: true }));
      }
      $('#createCollisionsEnabled')?.addEventListener('change', () => this.updateCreateSummary());
      document.querySelectorAll('input[name="allowedWorld"]').forEach((input) => input.addEventListener('change', (event) => {
        const selected = document.querySelectorAll('input[name="allowedWorld"]:checked');
        if (!selected.length) {
          event.currentTarget.checked = true;
          const live = $('#configLiveStatus');
          if (live) live.textContent = 'Debe quedar al menos un mundo ambiental activo.';
        }
        this.updateCreateSummary();
      }));
      for (const id of ['#createName', '#createPassword', '#createMaxPlayers', '#createMaxPoints', '#createWorldTimeSeconds', '#createFinishTimeSeconds', '#createTurnLimit']) {
        $(id)?.addEventListener('input', () => this.updateCreateSummary());
      }
      $('#createForm')?.addEventListener('submit', (event) => { event.preventDefault(); this.createMatch(); });

      $('#usernameInput')?.addEventListener('input', (event) => this.renderProfilePreview(event.currentTarget.value));
      $('#profileForm')?.addEventListener('submit', (event) => {
        event.preventDefault();
        try {
          this.profile.setUsername($('#usernameInput')?.value || '');
          this.refreshProfileUI();
          this.showNotice('Perfil guardado en este navegador.', 'good');
          this.runPreflight({ initial: true });
        } catch (error) { this.showNotice(error.message, 'bad'); }
      });
      $('#joinPasswordForm')?.addEventListener('submit', (event) => {
        event.preventDefault();
        const password = this.joinPasswordInput?.value || '';
        this.hidePasswordModal();
        this.joinSelected(password);
      });
      this.searchInput?.addEventListener('input', () => this.renderServers());
      this.sortSelect?.addEventListener('change', () => this.renderServers());
      this.hideFullToggle?.addEventListener('change', () => this.renderServers());
    }

    handlePageExit() {
      if (this.unloadHandled) return;
      this.unloadHandled = true;
      if (this.session?.getStatus?.().online) {
        // No se hace lobby:leave: la reserva cliente queda temporalmente en el relay.
        // Así una recarga NO auto-reconecta, pero el siguiente arranque puede ofrecer
        // "Reconectar" si la sala aún existe.
        try { this.session.disconnectForUnload(); } catch (_) { /* noop */ }
      }
    }

    /* ── Perfil ─────────────────────────────────────────────────────────── */

    hashName(text) {
      let h = 2166136261;
      for (const ch of String(text || '')) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
      return h >>> 0;
    }

    colorFor(name) {
      const colors = NG.NET_CONFIG.colors;
      return colors[this.hashName(name) % colors.length];
    }

    refreshProfileUI() {
      const username = this.profile.username || 'Sin nombre';
      const input = document.querySelector('#usernameInput');
      if (input) input.value = this.profile.username || '';
      const label = document.querySelector('#profileName');
      if (label) label.textContent = username;
      const dot = document.querySelector('#profileDot');
      const initial = document.querySelector('#profileInitial');
      if (dot) dot.style.background = this.colorFor(username);
      if (initial) initial.textContent = (username.trim()[0] || 'J').toUpperCase();
      const createName = document.querySelector('#createName');
      if (createName && !createName.value) createName.value = `${username} · Campo`;
      this.renderProfilePreview(this.profile.username || '');
      this.game.announcer?.setLocalPlayerName?.(this.profile.username || 'Jugador');
      this.updateCreateSummary();
    }

    renderProfilePreview(value) {
      const raw = String(value || '');
      const name = raw.trim() || 'Jugador';
      const dot = document.querySelector('#profilePreviewDot');
      const initial = document.querySelector('#profilePreviewInitial');
      const label = document.querySelector('#profilePreviewName');
      const counter = document.querySelector('#nameCounter');
      if (dot) dot.style.background = this.colorFor(name);
      if (initial) initial.textContent = (name[0] || 'J').toUpperCase();
      if (label) label.textContent = name;
      if (counter) counter.textContent = `${raw.length}/${NG.NET_CONFIG.maxNameLength}`;
    }

    suggestName() {
      const pick = (list) => list[Math.floor(Math.random() * list.length)];
      const name = `${pick(NAME_PREFIX)}${pick(NAME_SUFFIX)}`.slice(0, NG.NET_CONFIG.maxNameLength);
      const input = document.querySelector('#usernameInput');
      if (input) { input.value = name; input.focus(); }
      this.renderProfilePreview(name);
    }

    /* ── Estado de red del menú ─────────────────────────────────────────── */

    setRelayPill(state, text) {
      if (this.relayPill) this.relayPill.dataset.state = state;
      if (this.relayPillText) this.relayPillText.textContent = text;
    }

    updateOnlineConfigStatus() {
      const el = document.querySelector('#onlineConfigStatus');
      if (!el) return;
      const span = el.querySelector('span');
      const source = NG.ClientEnv?.source === 'config' ? 'config.json cargado' : 'config.json no disponible';
      const latency = Number.isFinite(this.preflightRtt) && this.preflightRtt > 0 ? ` · ${this.preflightRtt} ms` : '';
      if (span) {
        span.textContent = this.onlineAvailable
          ? `Relay conectado${latency} · ${source}. Los parámetros de cliente/host se leen del archivo, no de la interfaz.`
          : `Relay pendiente o no disponible · ${source}. Crear, Unirse y Reconectar quedan bloqueados hasta que el preflight pase.`;
      }
      el.dataset.state = this.onlineAvailable ? 'online' : 'offline';
    }

    setPreflightRow(id, state, text) {
      const row = document.querySelector(`#${id}`);
      if (!row) return;
      row.dataset.state = state;
      const value = row.querySelector('strong');
      if (value) value.textContent = text;
    }

    setOnlineAvailability(available) {
      this.onlineAvailable = !!available;
      const button = document.querySelector('#onlineBtn');
      if (button) {
        button.disabled = !this.onlineAvailable;
        button.dataset.network = this.onlineAvailable ? 'online' : 'offline';
        const small = button.querySelector('small');
        if (small) small.textContent = this.onlineAvailable
          ? `Relay disponible · crear, unirse y reconectar · hasta ${NG.NET_CONFIG.maxPlayers} jugadores`
          : 'Multiplayer deshabilitado · relay no disponible';
      }
      if (this.onlineAvailable) {
        const latency = Number.isFinite(this.preflightRtt) && this.preflightRtt > 0 ? `${this.preflightRtt} ms` : 'conectado';
        this.setRelayPill('ok', `Relay ${latency}`);
      } else if (!this.preflightRunning) {
        this.setRelayPill('fail', 'Relay no disponible');
      }
      this.updateOnlineConfigStatus();
      this.updateReconnectButton();
    }

    async runPreflight(options = {}) {
      if (!this.profile.username || this.preflightRunning) return;
      this.preflightRunning = true;
      this.preflightLobbyIds.clear();
      this.preflightRtt = null;
      this.setOnlineAvailability(false);
      this.setRelayPill('working', 'Comprobando relay…');
      this.showScreen('preflight');
      this.showNotice('');

      const cfg = this.env();
      const status = document.querySelector('#preflightStatusText');
      const retry = document.querySelector('#preflightRetryBtn');
      const offline = document.querySelector('#preflightOfflineBtn');
      const menu = document.querySelector('#preflightMenuBtn');
      if (retry) retry.disabled = true;
      offline?.classList.add('hidden');
      menu?.classList.add('hidden');
      if (status) status.textContent = 'Comprobando configuración y conexión con el relay…';

      this.setPreflightRow('preflightConfigRow', 'working', 'COMPROBANDO');
      this.setPreflightRow('preflightRelayRow', 'idle', 'PENDIENTE');
      this.setPreflightRow('preflightProtocolRow', 'idle', 'PENDIENTE');
      this.setPreflightRow('preflightLobbyRow', 'idle', 'PENDIENTE');

      let probe = null;
      try {
        if (NG.ClientEnv?.source !== 'config') throw new Error(NG.ClientEnv?.loadError || 'No se pudo cargar config.json.');
        if (!cfg.onlineEnabled) throw new Error('Multiplayer está desactivado en config.json.');
        if (!String(cfg.relayUrl || '').trim()) throw new Error('relayUrl no está configurado en config.json.');
        const relayUrl = this.profile.setRelayUrl(this.profile.getRelayUrl());
        this.setPreflightRow('preflightConfigRow', 'ok', 'CONFIG OK');
        this.setPreflightRow('preflightRelayRow', 'working', 'CONECTANDO');

        probe = new NG.RelayClient(this.profile);
        const welcome = await probe.connect(relayUrl, {
          autoReconnect: false,
          timeoutMs: Math.max(1500, Number(cfg.preflightTimeoutMs) || Number(cfg.relayConnectTimeoutMs) || 6500),
        });
        this.preflightRtt = Math.round(probe.lastRelayRtt || 0);
        this.setPreflightRow('preflightRelayRow', 'ok', `${this.preflightRtt} MS`);

        const protocol = Number(welcome?.protocolVersion ?? NG.NET_CONFIG.protocolVersion);
        if (protocol !== NG.NET_CONFIG.protocolVersion) throw new Error(`Protocolo incompatible: relay ${protocol}, cliente ${NG.NET_CONFIG.protocolVersion}.`);
        this.setPreflightRow('preflightProtocolRow', 'ok', `V${protocol} COMPATIBLE`);

        this.setPreflightRow('preflightLobbyRow', 'working', 'LEYENDO');
        const list = await probe.request('lobby:list', {});
        const lobbies = Array.isArray(list?.lobbies) ? list.lobbies : [];
        for (const lobby of lobbies) if (lobby?.id) this.preflightLobbyIds.add(String(lobby.id));
        this.setPreflightRow('preflightLobbyRow', 'ok', `${lobbies.length} SALAS`);

        this.setOnlineAvailability(true);
        this.refreshReconnectAgainstKnownLobbies();
        if (status) status.textContent = `Relay conectado correctamente${welcome?.relayName ? ` · ${welcome.relayName}` : ''}. Multiplayer habilitado.`;
        if (menu) menu.classList.remove('hidden');
        if (options.initial) window.setTimeout(() => this.showScreen('main'), 550);
      } catch (error) {
        this.setOnlineAvailability(false);
        const failedRows = ['preflightConfigRow', 'preflightRelayRow', 'preflightProtocolRow', 'preflightLobbyRow'];
        for (const id of failedRows) {
          const row = document.querySelector(`#${id}`);
          if (row && ['working', 'idle'].includes(row.dataset.state)) this.setPreflightRow(id, 'fail', 'NO DISPONIBLE');
        }
        if (status) status.textContent = `${error.message} Solo Offline está habilitado.`;
        this.setRelayPill('fail', 'Relay no disponible');
        offline?.classList.remove('hidden');
        menu?.classList.remove('hidden');
      } finally {
        if (probe) probe.close(true);
        if (retry) retry.disabled = false;
        this.preflightRunning = false;
      }
    }

    /* ── Navegación ─────────────────────────────────────────────────────── */

    showScreen(name) {
      const ids = {
        preflight: 'screenPreflight', main: 'screenMain', online: 'screenOnline', create: 'screenCreate',
        browser: 'screenBrowser', profile: 'screenProfile', joining: 'screenJoining', announcers: 'screenAnnouncers',
      };
      const target = ids[name] ? name : 'main';
      if (target !== 'create') this.closeMatchConfig({ restoreFocus: false });
      this.currentScreen = target;
      document.querySelectorAll('.menu-screen').forEach((screen) => screen.classList.remove('active'));
      document.querySelector(`#${ids[target]}`)?.classList.add('active');
      if (target !== 'browser') this.stopAutoRefresh();
      if (target === 'profile') window.setTimeout(() => document.querySelector('#usernameInput')?.focus(), 30);
    }

    /**
     * Refleja el estado real del reproductor en el control.
     *
     * El relleno del deslizador va por variable CSS porque WebKit no sabe
     * pintar el tramo recorrido de un `input[type=range]` por su cuenta.
     */
    renderAudioSettings() {
      const music = this.game.music;
      if (!music) return;
      const slider = document.querySelector('#musicVolume');
      const value = document.querySelector('#musicVolumeValue');
      const mute = document.querySelector('#musicMuteBtn');
      const icon = document.querySelector('#musicMuteIcon');
      const hint = document.querySelector('#musicStateHint');
      const percent = Math.round(music.getVolume() * 100);
      const muted = music.isMuted();
      if (slider) {
        if (document.activeElement !== slider) slider.value = String(percent);
        slider.style.setProperty('--fill', `${percent}%`);
        slider.closest('.audio-row')?.setAttribute('data-muted', muted ? 'true' : 'false');
      }
      if (value) value.textContent = muted ? 'OFF' : `${percent}%`;
      if (mute) {
        mute.setAttribute('aria-pressed', muted ? 'true' : 'false');
        mute.setAttribute('aria-label', muted ? 'Activar música' : 'Silenciar música');
      }
      if (icon) icon.setAttribute('href', muted ? '#i-mute' : '#i-sound');
      // Si el navegador bloqueó el audio, decirlo: si no, parece que el juego
      // no tiene música y el jugador toquetea el volumen sin resultado.
      if (hint) {
        if (music.isBlocked()) hint.textContent = 'El navegador bloqueó el audio · toca la pantalla para activarlo.';
        // Sin Web Audio la pista suena, pero plana. Decirlo evita que alguien
        // busque por qué no se le abre el hoyo como a los demás.
        else if (music.isPlaying() && !music.hasEffects()) hint.textContent = 'Sonando · este navegador no admite los efectos de mezcla.';
        else hint.textContent = 'Reacciona al juego: crece cerca del hoyo y se apaga al caer al agua.';
      }
    }

    showNotice(text, tone = 'neutral') {
      if (!this.notice) return;
      this.notice.textContent = String(text || '');
      this.notice.dataset.tone = tone;
      this.notice.classList.toggle('hidden', !text);
    }

    requireProfile() {
      if (this.profile.username) return true;
      this.showNotice('Elige un nombre de jugador antes de continuar.', 'neutral');
      this.showScreen('profile');
      return false;
    }

    setOfflineHud() {
      if (this.runtimeMode) this.runtimeMode.textContent = 'EXPEDICIÓN PROCEDURAL · OFFLINE';
      this.game.hud.setRuntime('offline');
      this.game.hud.setMatchBar({
        mode: 'offline',
        state: 'idle',
        title: 'Partida libre',
        hint: 'Sin red · recorrido procedural de 3 hoyos',
        timer: null,
      });
      this.game.hud.setNetChip({ ping: '—', bars: 0, role: 'OFFLINE', quality: 'offline' });
    }

    playOffline() {
      if (!this.requireProfile()) return;
      this.game.networkSession = null;
      this.metrics?.setSession(null);
      this.game.setInputLocked(false);
      this.root?.classList.add('hidden');
      this.networkHud.detach();
      this.setOfflineHud();
      document.querySelector('#newCourseBtn')?.classList.remove('hidden');
      this.showNotice('');
    }

    openOnline() {
      if (!this.requireProfile()) return;
      if (!this.onlineAvailable) {
        this.showNotice('Multiplayer está bloqueado hasta que el preflight conecte correctamente con el relay.', 'bad');
        this.runPreflight();
        return;
      }
      this.updateOnlineConfigStatus();
      this.showNotice('');
      this.showScreen('online');
    }

    openCreate() {
      if (!this.requireProfile() || !this.onlineAvailable) return this.openOnline();
      const input = document.querySelector('#createName');
      if (input) input.value = `${this.profile.username} · Campo`;
      this.syncCreateConfig();
      this.showScreen('create');
    }

    async openBrowser() {
      if (!this.requireProfile() || !this.onlineAvailable) return this.openOnline();
      this.showScreen('browser');
      // El contador arranca antes de medir pings: un host que no responde tarda
      // en agotar su probe y no debe retrasar la cuenta atrás visible.
      this.startAutoRefresh();
      await this.refreshServers();
    }

    /* ── Crear partida ──────────────────────────────────────────────────── */

    readCreateSettings() {
      const $ = (selector) => document.querySelector(selector);
      const pointsEnabled = !!$('#createPointsEnabled')?.checked;
      const worldTimeEnabled = !!$('#createWorldTimeEnabled')?.checked;
      const finishTimeEnabled = !!$('#createFinishTimeEnabled')?.checked;
      const turnLimitEnabled = !!$('#createTurnLimitEnabled')?.checked;
      const allowedWorlds = [...document.querySelectorAll('input[name="allowedWorld"]:checked')]
        .map((input) => String(input.value || ''))
        .filter((value) => WORLD_IDS.includes(value));

      return {
        name: String($('#createName')?.value || '').trim() || `${this.profile.username || 'Jugador'} · Campo`,
        password: String($('#createPassword')?.value || ''),
        mode: this.selectedMode === 'battle' ? 'battle' : 'turn',
        maxPlayers: boundedInt($('#createMaxPlayers')?.value, CREATE_DEFAULTS.maxPlayers, 2, NG.NET_CONFIG.maxPlayers),
        maxPoints: pointsEnabled ? boundedInt($('#createMaxPoints')?.value, CREATE_DEFAULTS.maxPoints, 500, 1000000) : null,
        infinitePoints: !pointsEnabled,
        worldTimeSeconds: worldTimeEnabled ? boundedInt($('#createWorldTimeSeconds')?.value, CREATE_DEFAULTS.worldTimeSeconds, 30, 1800) : null,
        finishCountdownSeconds: finishTimeEnabled ? boundedInt($('#createFinishTimeSeconds')?.value, CREATE_DEFAULTS.finishTimeSeconds, 10, 300) : null,
        maxTurnsPerWorld: turnLimitEnabled ? boundedInt($('#createTurnLimit')?.value, CREATE_DEFAULTS.turnLimit, 1, 100) : null,
        allowedWorlds: allowedWorlds.length ? allowedWorlds : [...WORLD_IDS],
        collisionsEnabled: this.selectedMode === 'battle' && !!$('#createCollisionsEnabled')?.checked,
      };
    }

    syncCreateConfig(options = {}) {
      const $ = (selector) => document.querySelector(selector);
      const rules = [
        { toggle: '#createPointsEnabled', input: '#createMaxPoints', state: '#pointsRuleState', card: '[data-rule="points"]', offText: 'INFINITO' },
        { toggle: '#createWorldTimeEnabled', input: '#createWorldTimeSeconds', state: '#worldTimeRuleState', card: '[data-rule="world-time"]', offText: 'INFINITO' },
        { toggle: '#createFinishTimeEnabled', input: '#createFinishTimeSeconds', state: '#finishTimeRuleState', card: '[data-rule="finish-time"]', offText: 'DESACTIVADO' },
        { toggle: '#createTurnLimitEnabled', input: '#createTurnLimit', state: '#turnLimitRuleState', card: '[data-rule="turn-limit"]', offText: 'INFINITO' },
      ];
      for (const rule of rules) {
        const enabled = !!$(rule.toggle)?.checked;
        const input = $(rule.input);
        const state = $(rule.state);
        const card = this.matchConfigPanel?.querySelector(rule.card);
        if (input) input.disabled = !enabled;
        if (card) card.dataset.enabled = String(enabled);
        if (state) {
          state.textContent = enabled ? 'ACTIVO' : rule.offText;
          state.dataset.off = String(!enabled);
        }
      }

      const collisions = $('#createCollisionsEnabled');
      const collisionRule = $('#collisionRule');
      const battle = this.selectedMode === 'battle';
      if (collisions) collisions.disabled = !battle;
      if (collisionRule) collisionRule.dataset.unavailable = String(!battle);
      this.updateCreateSummary();

      if (options.announce) {
        const live = $('#configLiveStatus');
        if (live) live.textContent = 'Configuración actualizada.';
      }
    }

    openMatchConfig() {
      if (this.currentScreen !== 'create') return;
      this.syncCreateConfig();
      this.matchConfigPanel?.classList.remove('hidden');
      this.matchConfigTrigger?.setAttribute('aria-expanded', 'true');
      window.setTimeout(() => document.querySelector('#closeMatchConfigBtn')?.focus(), 20);
    }

    closeMatchConfig(options = {}) {
      const wasOpen = !this.matchConfigPanel?.classList.contains('hidden');
      this.matchConfigPanel?.classList.add('hidden');
      this.matchConfigTrigger?.setAttribute('aria-expanded', 'false');
      if (wasOpen && options.restoreFocus !== false) this.matchConfigTrigger?.focus();
    }

    saveMatchConfig() {
      const settings = this.readCreateSettings();
      const setNumber = (selector, value) => {
        const input = document.querySelector(selector);
        if (input && value != null) input.value = String(value);
      };
      setNumber('#createMaxPlayers', settings.maxPlayers);
      setNumber('#createMaxPoints', settings.maxPoints);
      setNumber('#createWorldTimeSeconds', settings.worldTimeSeconds);
      setNumber('#createFinishTimeSeconds', settings.finishCountdownSeconds);
      setNumber('#createTurnLimit', settings.maxTurnsPerWorld);
      this.syncCreateConfig({ announce: true });
      this.closeMatchConfig();
    }

    resetMatchConfig() {
      const setValue = (selector, value) => {
        const input = document.querySelector(selector);
        if (!input) return;
        if (typeof value === 'boolean') input.checked = value;
        else input.value = String(value);
      };
      setValue('#createMaxPlayers', CREATE_DEFAULTS.maxPlayers);
      setValue('#createPointsEnabled', CREATE_DEFAULTS.pointsEnabled);
      setValue('#createMaxPoints', CREATE_DEFAULTS.maxPoints);
      setValue('#createWorldTimeEnabled', CREATE_DEFAULTS.worldTimeEnabled);
      setValue('#createWorldTimeSeconds', CREATE_DEFAULTS.worldTimeSeconds);
      setValue('#createFinishTimeEnabled', CREATE_DEFAULTS.finishTimeEnabled);
      setValue('#createFinishTimeSeconds', CREATE_DEFAULTS.finishTimeSeconds);
      setValue('#createTurnLimitEnabled', CREATE_DEFAULTS.turnLimitEnabled);
      setValue('#createTurnLimit', CREATE_DEFAULTS.turnLimit);
      setValue('#createCollisionsEnabled', CREATE_DEFAULTS.collisionsEnabled);
      document.querySelectorAll('input[name="allowedWorld"]').forEach((input) => { input.checked = true; });
      this.syncCreateConfig();
      const live = document.querySelector('#configLiveStatus');
      if (live) live.textContent = 'Se restauraron las reglas recomendadas.';
    }

    updateCreateSummary() {
      const $ = (selector) => document.querySelector(selector);
      const settings = this.readCreateSettings();
      const locked = !!settings.password.length;

      const summaryName = $('#summaryName');
      if (summaryName) summaryName.textContent = settings.name;
      const summaryMode = $('#summaryMode');
      if (summaryMode) summaryMode.textContent = this.selectedMode === 'battle' ? 'Battle Royale' : 'Por turnos';
      const summaryPlayers = $('#summaryPlayers');
      if (summaryPlayers) summaryPlayers.textContent = `${settings.maxPlayers} máx.`;
      const summaryPoints = $('#summaryPoints');
      if (summaryPoints) summaryPoints.textContent = settings.maxPoints == null ? 'Sin límite' : `${formatInt(settings.maxPoints)} pts`;
      const summaryTiming = $('#summaryTiming');
      if (summaryTiming) {
        summaryTiming.textContent = settings.finishCountdownSeconds != null
          ? `${durationText(settings.finishCountdownSeconds)} al llegar`
          : settings.worldTimeSeconds != null ? durationText(settings.worldTimeSeconds) : 'Sin reloj';
      }
      const summaryWorlds = $('#summaryWorlds');
      if (summaryWorlds) summaryWorlds.textContent = `${settings.allowedWorlds.length} activo${settings.allowedWorlds.length === 1 ? '' : 's'}`;
      const summaryAccess = $('#summaryAccess');
      if (summaryAccess) summaryAccess.textContent = locked ? 'Privada' : 'Pública';
      const triggerSummary = $('#configTriggerSummary');
      if (triggerSummary) {
        triggerSummary.textContent = `${settings.maxPlayers} jugadores · ${settings.maxPoints == null ? '∞ puntos' : `${formatInt(settings.maxPoints)} puntos`} · ${settings.allowedWorlds.length} ambiente${settings.allowedWorlds.length === 1 ? '' : 's'}`;
      }
      const summaryHint = $('#summaryHint');
      if (summaryHint) {
        summaryHint.textContent = this.selectedMode === 'battle'
          ? `Todos lanzan a la vez${settings.collisionsEnabled ? ' y las bolas colisionan' : ''}; llegar antes suma bonus de posición.`
          : 'Un jugador lanza cada vez. La cámara sigue al turno activo y el orden avanza al detenerse la bola.';
      }
    }

    wireSession(session) {
      session.on('progress', ({ value, text }) => this.setProgress(value, text));
      session.on('error', (error) => this.showNotice(error?.message || String(error), 'bad'));
      session.on('ready', ({ spectator }) => {
        this.root?.classList.add('hidden');
        this.closeGameMenu();
        this.game.setNetworkSession(session);
        this.game.setInputLocked(false);
        this.networkHud.attach(session, () => this.leaveOnline());
        this.metrics?.setSession(session);
        if (this.runtimeMode) this.runtimeMode.textContent = spectator ? 'ONLINE · ESPECTADOR' : `ONLINE · ${session.role === 'host' ? 'HOST' : 'CLIENTE'}`;
        document.querySelector('#newCourseBtn')?.classList.add('hidden');
      });
      session.on('connection', ({ state, text }) => {
        if (state === 'reconnecting' || state === 'degraded' || state === 'relay-disconnected') this.game.hud.flashStatus(text, 'neutral', 1.4);
      });
      session.on('iceerror', () => this.game.hud.flashStatus('ICE no pudo usar una ruta configurada', 'neutral', 1.2));
      session.on('reconnect', (status) => this.renderReconnect(status));
      session.on('rejected', ({ text }) => {
        this.hideReconnectPanel();
        this.showNotice(text || 'El host rechazó la conexión.', 'bad');
        this.leaveOnline();
      });
      session.on('closed', ({ reason, text } = {}) => {
        this.hideReconnectPanel();
        const message = text
          || (reason === 'host-timeout' ? 'El host no volvió a tiempo.' : 'El host cerró la partida.');
        this.showNotice(message, 'bad');
        this.leaveOnline();
      });
      session.on('mapvote', () => this.renderMapVote());
      session.on('gameevent', (event) => {
        // El golpe de ambiente va con la bola que tiene el foco de cámara, la
        // misma que gobierna el resto de la mezcla. Online la penalización la
        // resuelve el host y llega como evento: el `inWater` de esa bola puede
        // no aparecer en ningún snapshot, así que hay que engancharse aquí.
        if (event?.event === 'penalty' && event.playerKey === session.getCameraPlayerKey?.()) {
          if (event.reason === 'Agua') this.game.music?.hit('water');
          else if (event.reason === 'Fuera del mapa') this.game.music?.hit('lost');
        }
        if (event?.event === 'map-changed') this.game.hud.flashStatus('Mapa cambiado por votación unánime', 'good', 1.35);
        else if (event?.event === 'next-hole') this.game.hud.flashStatus('Nuevo hoyo', 'good', 1.1);
        else if (event?.event === 'finish-countdown') {
          this.game.hud.flashStatus(`${Math.round(event.seconds || 0)} s para que los demás lleguen`, 'penalty', 1.6);
        } else if (event?.event === 'world:expired') {
          const text = event.reason === 'finish-countdown' ? 'Se acabó el tiempo restante' : 'Se acabó el tiempo del mundo';
          // Con bolas aún rodando el mundo no avanza todavía: se las deja
          // terminar el tiro, y decirlo evita que parezca que se ha colgado.
          const rolling = Number(event.rolling) || 0;
          const tail = rolling
            ? (rolling === 1 ? ' · la bola en juego termina su tiro' : ` · las ${rolling} bolas en juego terminan su tiro`)
            : ' · avanzando';
          this.game.hud.flashStatus(`${text}${tail}`, 'penalty', 1.5);
        }
        else if (event?.event === 'penalty' && event.playerKey === session.localPlayerKey) {
          const text = event.sabotageBy
            ? `Sabotaje de ${event.sabotageByUsername || 'otro jugador'} · vuelves al inicio · +${event.penalty || 1}`
            : `${event.reason || 'Penalización'} · +${event.penalty || 1}`;
          this.game.hud.flashStatus(text, 'penalty', event.sabotageBy ? 1.8 : 1.05);
        } else if (event?.event === 'penalty' && event.sabotageBy === session.localPlayerKey) {
          this.game.hud.flashStatus(`¡Sabotaje! ${event.sabotageVictimUsername || 'Otra bola'} vuelve al inicio`, 'good', 1.6);
        }
      });
    }

    async createMatch() {
      if (!this.requireProfile() || !this.onlineAvailable) return this.openOnline();
      const session = this.prepareSession();
      const settings = this.readCreateSettings();
      this.showScreen('joining');
      if (this.joinTitle) this.joinTitle.textContent = 'Creando partida online…';
      this.setProgress(0.04, 'Inicializando host autoritativo…');
      try {
        await session.createMatch(settings, this.profile.getRelayUrl());
        this.updateReconnectButton();
      } catch (error) {
        this.showNotice(error.message, 'bad');
        this.showScreen('create');
      }
    }

    /* ── Server browser ─────────────────────────────────────────────────── */

    serverKey(lobby) { return String(lobby.id || ''); }

    startAutoRefresh() {
      this.stopAutoRefresh();
      this.autoRefreshCountdown = Math.max(5, Number(NG.NET_CONFIG.browserRefreshSeconds) || 12);
      this.autoRefreshTimer = window.setInterval(() => {
        if (this.currentScreen !== 'browser') return this.stopAutoRefresh();
        this.autoRefreshCountdown -= 1;
        if (this.autoRefreshLabel) this.autoRefreshLabel.textContent = `Auto ${this.autoRefreshCountdown}s`;
        if (this.autoRefreshCountdown > 0) return;
        this.autoRefreshCountdown = Math.max(5, Number(NG.NET_CONFIG.browserRefreshSeconds) || 12);
        this.refreshServers();
      }, 1000);
    }

    stopAutoRefresh() {
      if (this.autoRefreshTimer) window.clearInterval(this.autoRefreshTimer);
      this.autoRefreshTimer = null;
      if (this.autoRefreshLabel) this.autoRefreshLabel.textContent = '';
    }

    async refreshServers() {
      if (!this.requireProfile() || !this.onlineAvailable) return;
      // Medir el ping de cada sala puede tardar; evitamos solapar dos refrescos
      // (el manual y el automático) sobre la misma sesión de relay.
      if (this.refreshing) return;
      this.refreshing = true;
      // Un refresco manual reinicia la cuenta atrás para no encadenar dos seguidos.
      if (this.autoRefreshTimer) this.autoRefreshCountdown = Math.max(5, Number(NG.NET_CONFIG.browserRefreshSeconds) || 12);
      const session = this.session && this.session.role === 'offline' ? this.session : this.prepareSession();
      this.servers = [];
      this.serverPings.clear();
      if (this.serverList) this.serverList.innerHTML = '<div class="empty-state"><span class="spinner-small"></span> Consultando el relay público…</div>';
      if (this.serverCount) this.serverCount.textContent = 'Consultando…';
      try {
        await session.ensureRelay(this.profile.getRelayUrl());
        const result = await session.relay.request('lobby:list', {});
        this.servers = (result.lobbies || []).map((lobby) => ({ ...lobby, scope: 'public' }));
        this.preflightLobbyIds = new Set(this.servers.map((lobby) => String(lobby.id)));
        this.refreshReconnectAgainstKnownLobbies();
        this.renderServers();
        await Promise.allSettled(this.servers.slice(0, 32).map(async (lobby) => {
          try { this.serverPings.set(this.serverKey(lobby), await session.relay.measureLobbyPing(lobby.id)); }
          catch (_) { this.serverPings.set(this.serverKey(lobby), Infinity); }
          this.renderServers();
        }));
        this.showNotice('');
      } catch (error) {
        this.servers = [];
        this.renderServers();
        this.showNotice(`Relay: ${error.message}`, 'bad');
      } finally {
        this.refreshing = false;
      }
    }

    filteredServers() {
      const query = String(this.searchInput?.value || '').trim().toLocaleLowerCase('es');
      const hideFull = !!this.hideFullToggle?.checked;
      const list = this.servers.filter((lobby) => {
        if (query && !String(lobby.name || '').toLocaleLowerCase('es').includes(query)) return false;
        if (this.modeFilter !== 'all') {
          const mode = lobby.mode === 'battle' ? 'battle' : 'turn';
          if (mode !== this.modeFilter) return false;
        }
        if (hideFull && (lobby.currentPlayers || 0) >= (lobby.maxPlayers || 0)) return false;
        return true;
      });
      const sort = this.sortSelect?.value || 'ping';
      return [...list].sort((a, b) => {
        if (sort === 'players') return (b.currentPlayers || 0) - (a.currentPlayers || 0) || String(a.name).localeCompare(String(b.name));
        if (sort === 'name') return String(a.name).localeCompare(String(b.name));
        if (sort === 'status') return Number(!!a.started) - Number(!!b.started) || String(a.name).localeCompare(String(b.name));
        return (this.serverPings.get(this.serverKey(a)) ?? 999999) - (this.serverPings.get(this.serverKey(b)) ?? 999999);
      });
    }

    renderServers() {
      if (!this.serverList) return;
      const list = this.filteredServers();
      this.serverList.textContent = '';

      if (this.serverCount) {
        this.serverCount.textContent = this.servers.length
          ? `${list.length} de ${this.servers.length} partida${this.servers.length === 1 ? '' : 's'} visibles`
          : 'Sin partidas publicadas';
      }

      if (!list.length) {
        const empty = document.createElement('div');
        empty.className = 'empty-state';
        empty.textContent = this.servers.length
          ? 'Ninguna partida coincide con los filtros activos.'
          : 'No hay partidas públicas visibles ahora mismo.';
        const hint = document.createElement('small');
        hint.textContent = this.servers.length ? 'Prueba a limpiar la búsqueda o el filtro de modo.' : 'Puedes crear la tuya desde “Crear partida”.';
        empty.appendChild(hint);
        this.serverList.appendChild(empty);
        return;
      }

      for (const lobby of list) this.serverList.appendChild(this.buildServerRow(lobby));
    }

    buildServerDetails(lobby) {
      const panel = document.createElement('div');
      panel.className = 'server-tooltip';
      panel.id = `server-details-${String(lobby.id || 'room').replace(/[^a-zA-Z0-9_-]/g, '')}`;
      panel.setAttribute('role', 'tooltip');

      const world = lobby.worldLabel || WORLD_LABELS[lobby.worldArchetype] || 'Aún por generar';
      const difficulty = lobby.difficultyLabel || 'Por definir';
      const current = document.createElement('div');
      current.className = 'server-tooltip-current';
      const eyebrow = document.createElement('span');
      eyebrow.textContent = lobby.started ? `MUNDO ${(lobby.holeIndex || 0) + 1} EN CURSO` : 'PRÓXIMO MUNDO';
      const worldName = document.createElement('strong');
      worldName.textContent = world;
      const worldMeta = document.createElement('small');
      worldMeta.textContent = `${difficulty}${lobby.mapSize ? ` · ${lobby.mapSize}` : ''}`;
      current.append(eyebrow, worldName, worldMeta);

      const rules = document.createElement('div');
      rules.className = 'server-tooltip-rules';
      const addRule = (label, value, wide = false) => {
        const item = document.createElement('span');
        item.className = `server-tooltip-rule${wide ? ' wide' : ''}`;
        const key = document.createElement('small'); key.textContent = label;
        const read = document.createElement('b'); read.textContent = value;
        item.append(key, read);
        rules.appendChild(item);
      };

      addRule('Jugadores', `${lobby.currentPlayers || 0} / ${lobby.maxPlayers || 0}`);
      addRule('Objetivo', lobby.maxPoints == null ? 'Sin límite' : `${formatInt(lobby.maxPoints)} pts`);
      addRule('Tiempo del mundo', lobby.worldTimeSeconds == null ? 'Sin límite' : durationText(lobby.worldTimeSeconds));
      addRule('Cuando alguien emboca', lobby.finishCountdownSeconds == null ? 'Desactivado' : durationText(lobby.finishCountdownSeconds));
      addRule('Lanzamientos', lobby.maxTurnsPerWorld == null ? 'Sin límite' : `${lobby.maxTurnsPerWorld} por mundo`);
      addRule('Colisiones', lobby.mode === 'battle' ? (lobby.collisionsEnabled !== false ? 'Activadas' : 'Desactivadas') : 'No aplica');
      addRule('Cambio de mapa', 'Votación unánime · cada 1 min');
      const allowed = Array.isArray(lobby.allowedWorlds) && lobby.allowedWorlds.length ? lobby.allowedWorlds : WORLD_IDS;
      const allowedText = allowed.length === WORLD_IDS.length
        ? 'Todos los ambientes'
        : allowed.map((id) => WORLD_LABELS[id] || id).join(' · ');
      addRule('Mundos permitidos', allowedText, true);

      panel.append(current, rules);
      return panel;
    }

    buildServerRow(lobby) {
      const svg = (id, className) => {
        const el = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        el.setAttribute('class', className || 'ico');
        el.setAttribute('aria-hidden', 'true');
        const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
        use.setAttribute('href', id);
        el.appendChild(use);
        return el;
      };

      const battle = lobby.mode === 'battle';
      const started = !!lobby.started;
      const current = lobby.currentPlayers || 0;
      const max = lobby.maxPlayers || 0;
      const full = max > 0 && current >= max;

      const row = document.createElement('div');
      row.className = 'server-row';
      row.dataset.started = String(started);
      row.tabIndex = 0;

      const info = document.createElement('div'); info.className = 'server-name-cell';
      const top = document.createElement('div'); top.className = 'server-name-line';
      const lock = svg(lobby.locked ? '#i-lock' : '#i-unlock', lobby.locked ? 'ico locked' : 'ico');
      const name = document.createElement('strong'); name.textContent = lobby.name || 'Partida';
      top.append(lock, name);
      const sub = document.createElement('div'); sub.className = 'server-sub';
      const statusDot = document.createElement('i'); statusDot.className = 'status-dot'; statusDot.dataset.status = started ? 'started' : 'waiting';
      const subText = document.createElement('small');
      subText.textContent = started
        ? `En curso · mundo ${(lobby.holeIndex || 0) + 1} · ${lobby.worldLabel || WORLD_LABELS[lobby.worldArchetype] || 'generado'} · ${lobby.difficultyLabel || 'dificultad por definir'}`
        : 'Esperando jugadores · el primer tiro inicia';
      sub.append(statusDot, subText);
      info.append(top, sub);

      const mode = document.createElement('div'); mode.className = 'server-mode';
      const modeBadge = document.createElement('span');
      modeBadge.className = 'mode-badge sm';
      modeBadge.dataset.mode = battle ? 'battle' : 'turn';
      const modeIcon = svg(battle ? '#i-swords' : '#i-turns');
      const modeText = document.createElement('b'); modeText.textContent = battle ? 'BATTLE' : 'TURNOS';
      modeBadge.append(modeIcon, modeText);
      const modeSub = document.createElement('small');
      modeSub.textContent = lobby.maxPoints == null ? '∞ puntos' : `${formatInt(lobby.maxPoints)} pts`;
      mode.append(modeBadge, modeSub);

      const players = document.createElement('div'); players.className = 'server-players';
      const playersValue = document.createElement('strong');
      playersValue.textContent = String(current);
      const playersMax = document.createElement('span'); playersMax.textContent = ` / ${max}`;
      playersValue.appendChild(playersMax);
      const meter = document.createElement('div'); meter.className = 'player-meter'; meter.dataset.full = String(full);
      const meterFill = document.createElement('i');
      meterFill.style.width = `${max > 0 ? Math.round((current / max) * 100) : 0}%`;
      meter.appendChild(meterFill);
      players.append(playersValue, meter);

      const ping = this.serverPings.get(this.serverKey(lobby));
      const q = NG.NetworkQuality(Number.isFinite(ping) ? ping : null);
      const signal = document.createElement('div'); signal.className = 'server-signal';
      const bars = document.createElement('i'); bars.className = 'signal-bars'; bars.dataset.bars = String(q.bars);
      bars.innerHTML = '<b></b><b></b><b></b><b></b>';
      const pingText = document.createElement('strong');
      pingText.textContent = Number.isFinite(ping) ? `${ping} ms` : '…';
      const qText = document.createElement('small'); qText.textContent = q.label;
      signal.append(bars, pingText, qText);

      const join = document.createElement('button');
      join.className = 'join-server-button'; join.type = 'button';
      join.disabled = full;
      join.dataset.kind = started ? 'spectate' : 'join';
      join.textContent = full ? 'LLENA' : (started ? 'ESPECTAR' : 'UNIRME');
      join.addEventListener('click', () => this.chooseLobby(lobby));

      const details = this.buildServerDetails(lobby);
      row.setAttribute('aria-describedby', details.id);
      row.append(info, mode, players, signal, join, details);
      return row;
    }

    chooseLobby(lobby) {
      this.selectedLobby = lobby;
      if (lobby.locked) {
        if (this.joinPasswordTitle) this.joinPasswordTitle.textContent = lobby.name || 'Partida privada';
        if (this.joinPasswordInput) this.joinPasswordInput.value = '';
        this.joinPanel?.classList.remove('hidden');
        window.setTimeout(() => this.joinPasswordInput?.focus(), 30);
      } else this.joinSelected('');
    }

    hidePasswordModal() {
      this.joinPanel?.classList.add('hidden');
      if (this.joinPasswordInput) this.joinPasswordInput.value = '';
    }

    async joinSelected(password) {
      const lobby = this.selectedLobby;
      if (!lobby || !this.onlineAvailable) return;
      const session = this.prepareSession();
      this.showScreen('joining');
      if (this.joinTitle) this.joinTitle.textContent = `Uniéndote a ${lobby.name}`;
      this.setProgress(0.1, 'Verificando sala en el relay…');
      try {
        await session.joinMatch(lobby, password, this.profile.getRelayUrl());
        this.updateReconnectButton();
      } catch (error) {
        this.showNotice(error.message, 'bad');
        this.showScreen('browser');
      }
    }

    async reconnectLast() {
      if (!this.requireProfile() || !this.onlineAvailable) return this.openOnline();
      const last = this.profile.getLastSession();
      if (!last) { this.updateReconnectButton(); return; }
      const session = this.prepareSession();
      this.showScreen('joining');
      if (this.joinTitle) this.joinTitle.textContent = `Reconectando a ${last.lobbyName || 'tu última partida'}`;
      this.setProgress(0.06, 'Confirmando que la partida todavía existe…');
      try {
        await session.ensureRelay(last.relayUrl || this.profile.getRelayUrl());
        const list = await session.relay.request('lobby:list', {});
        const exists = (list.lobbies || []).some((lobby) => String(lobby.id) === String(last.lobbyId));
        if (!exists) {
          this.profile.clearLastSession();
          this.preflightLobbyIds.delete(String(last.lobbyId));
          this.updateReconnectButton();
          throw new Error('La última partida ya no existe en el relay.');
        }
        this.setProgress(0.18, 'Reserva encontrada · recuperando identidad…');
        await session.resumeLast(last);
      } catch (error) {
        this.showNotice(error.message, 'bad');
        this.updateReconnectButton();
        this.showScreen('main');
      }
    }

    refreshReconnectAgainstKnownLobbies() {
      const last = this.profile.getLastSession();
      if (last && this.onlineAvailable && !this.preflightLobbyIds.has(String(last.lobbyId))) this.profile.clearLastSession();
      this.updateReconnectButton();
    }

    /* ── Pantalla de conexión ───────────────────────────────────────────── */

    setProgress(value, text) {
      const ratio = Math.max(0, Math.min(1, Number(value) || 0));
      if (this.joinProgress) this.joinProgress.style.width = `${ratio * 100}%`;
      if (this.joinStatus) this.joinStatus.textContent = text || 'Conectando…';
      this.renderJoinSteps(ratio);
    }

    renderJoinSteps(ratio) {
      if (!this.joinSteps) return;
      // Umbrales alineados con los `progress` que emite MultiplayerSession.
      const thresholds = { relay: 0.28, lobby: 0.5, p2p: 0.78, world: 1 };
      let activeAssigned = false;
      for (const item of this.joinSteps.children) {
        const done = ratio >= thresholds[item.dataset.step];
        let state = 'todo';
        if (done) state = 'done';
        else if (!activeAssigned) { state = 'active'; activeAssigned = true; }
        if (item.dataset.state !== state) item.dataset.state = state;
      }
    }

    async cancelJoin() {
      if (this.session) try { await this.session.leave({ keepLast: false }); } catch (_) { /* noop */ }
      this.metrics?.setSession(null);
      this.game.setNetworkSession(null);
      this.showScreen('main');
    }

    async leaveOnline() {
      if (this.session) try { await this.session.leave({ keepLast: false }); } catch (_) { /* noop */ }
      this.networkHud.detach();
      this.metrics?.setSession(null);
      this.votePanel?.classList.add('hidden');
      this.game.setNetworkSession(null);
      this.game.startNewCourse(this.game.makeSeed(), { quiet: true });
      this.game.setInputLocked(true);
      this.setOfflineHud();
      document.querySelector('#newCourseBtn')?.classList.remove('hidden');
      this.root?.classList.remove('hidden');
      this.showScreen('main');
      this.updateReconnectButton();
    }

    /* ── Menú de partida y votación ─────────────────────────────────────── */

    openGameMenu() {
      if (!this.root?.classList.contains('hidden')) return;
      this.gameMenu?.classList.remove('hidden');
      this.game.setInputLocked(true);
      const online = this.session?.getStatus().online;
      const context = document.querySelector('#gameMenuContext');
      const vote = document.querySelector('#requestMapVoteBtn');
      const resetShot = document.querySelector('#resetShotBtn');
      const home = document.querySelector('#returnHomeBtn');
      if (context) {
        context.textContent = online
          ? `${this.session.getStatus().settings?.mode === 'battle' ? 'Battle Royale' : 'Por turnos'} · ${this.session.role === 'host' ? 'Host' : 'Cliente'}`
          : 'Partida offline · recorrido procedural';
      }
      vote?.classList.toggle('hidden', !online);
      if (resetShot) resetShot.disabled = !this.game.canReturnToShotOrigin();
      if (home) {
        const label = home.querySelector('span');
        const text = online ? 'DESCONECTAR Y VOLVER AL INICIO' : 'VOLVER AL INICIO';
        if (label) label.textContent = text;
        else home.lastChild.textContent = text;
      }
      this.updateMapVoteButton();
      this.renderAudioSettings();
    }

    closeGameMenu() {
      this.gameMenu?.classList.add('hidden');
      if (this.root?.classList.contains('hidden')) this.game.setInputLocked(false);
    }

    returnToShotOrigin() {
      if (this.game.returnToShotOrigin()) this.closeGameMenu();
    }

    async returnHome() {
      this.closeGameMenu();
      if (this.session?.getStatus().online) return this.leaveOnline();
      this.game.setInputLocked(true);
      this.root?.classList.remove('hidden');
      this.showScreen('main');
    }

    requestMapVote() {
      if (!this.session?.getStatus().online) return;
      const status = this.session.getMapVoteStatus();
      if (status.active) {
        this.closeGameMenu();
        this.renderMapVote();
        return;
      }
      if (status.cooldownRemainingMs > 0) {
        this.game.hud.flashStatus(`Cambio de mapa disponible en ${this.formatRemaining(status.cooldownRemainingMs)}`, 'neutral', 1.2);
        return;
      }
      if (!this.session.requestMapVote()) {
        this.game.hud.flashStatus('No se pudo enviar la votación · revisa la conexión', 'neutral', 1.1);
        return;
      }
      this.closeGameMenu();
    }

    castMapVote(choice) {
      if (!this.session?.castLocalMapVote(choice)) return;
      if (choice === 'no') this.votePanel?.classList.add('hidden');
      this.renderMapVote();
    }

    renderMapVote() {
      if (!this.session?.getStatus().online) { this.votePanel?.classList.add('hidden'); return; }
      const status = this.session.getMapVoteStatus();
      if (!status.active) { this.votePanel?.classList.add('hidden'); return; }
      const eligible = status.vote.electorate.includes(this.session.localPlayerKey);
      const voted = status.vote.yes.includes(this.session.localPlayerKey);
      const yes = document.querySelector('#mapVoteYesBtn');
      const no = document.querySelector('#mapVoteNoBtn');
      const text = document.querySelector('#mapVoteText');
      const y = document.querySelector('#mapVoteYesCount');
      const n = document.querySelector('#mapVoteNeedCount');
      const arc = document.querySelector('#mapVoteArc');
      if (y) y.textContent = String(status.yes);
      if (n) n.textContent = String(status.required);
      if (arc) {
        const ratio = status.required > 0 ? Math.min(1, status.yes / status.required) : 0;
        arc.style.strokeDashoffset = String(VOTE_RING_CIRCUMFERENCE * (1 - ratio));
      }
      if (text) {
        text.textContent = eligible
          ? (voted ? 'Tu voto ya es Sí. Esperando unanimidad del resto.' : 'Todos los jugadores conectados deben votar Sí. Un solo No cancela.')
          : 'Eres espectador: puedes ver la votación, pero no formas parte del electorado.';
      }
      if (yes) yes.disabled = !eligible || voted;
      if (no) no.disabled = !eligible || voted;
      this.votePanel?.classList.remove('hidden');
    }

    updateMapVoteButton() {
      const button = document.querySelector('#requestMapVoteBtn');
      const label = document.querySelector('#requestMapVoteLabel');
      if (!button || !label) return;
      const status = this.session?.getStatus().online ? this.session.getMapVoteStatus() : null;
      const remain = status ? status.cooldownRemainingMs : 0;
      button.classList.toggle('hidden', !status);
      button.disabled = !status || remain > 0 || status.active;
      label.textContent = status?.active
        ? 'VOTACIÓN EN CURSO'
        : remain > 0
          ? `ENFRIAMIENTO · ${this.formatRemaining(remain)}`
          : 'VOTAR CAMBIO DE MAPA';
      button.title = remain > 0 ? `Disponible en ${this.formatRemaining(remain)}` : '';
    }

    formatRemaining(ms) {
      const total = Math.max(0, Math.ceil(ms / 1000));
      const m = Math.floor(total / 60), s = total % 60;
      return m ? `${m}:${String(s).padStart(2, '0')}` : `${s}s`;
    }

    updateReconnectButton() {
      const button = document.querySelector('#reconnectBtn');
      const label = document.querySelector('#reconnectLabel');
      const last = this.profile.getLastSession();
      const known = !!(last && this.onlineAvailable && this.preflightLobbyIds.has(String(last.lobbyId)));
      button?.classList.toggle('hidden', !known);
      if (button) button.disabled = !known;
      if (label && known) label.textContent = `${last.lobbyName || 'Última partida'} · reservar tu sitio en el relay`;
    }

    /* ── Ventana de reconexión ──────────────────────────────────────────── */

    /**
     * Muestra cuánto queda de la reserva que el host mantiene abierta.
     * Mientras la ventana está activa el juego queda bloqueado: seguir
     * apuntando sobre un estado congelado solo confundiría.
     */
    renderReconnect(status) {
      if (!this.reconnectPanel) return;
      if (!status?.active) {
        this.hideReconnectPanel();
        return;
      }
      const wasHidden = this.reconnectPanel.classList.contains('hidden');
      if (wasHidden) {
        this.reconnectPanel.classList.remove('hidden');
        this.game.setInputLocked(true);
      }
      const remaining = Math.max(0, Number(status.remainingMs) || 0);
      const total = Math.max(1, Number(status.totalMs) || 1);
      const seconds = Math.ceil(remaining / 1000);
      if (this.reconnectCountdown) {
        this.reconnectCountdown.textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
      }
      if (this.reconnectAttempts) {
        this.reconnectAttempts.textContent = status.busy
          ? `Intento ${status.attempts}…`
          : `Intento ${Math.max(1, status.attempts)}`;
      }
      if (this.reconnectBar) this.reconnectBar.style.width = `${Math.max(0, Math.min(100, (remaining / total) * 100))}%`;
      if (this.reconnectTitle) {
        this.reconnectTitle.textContent = status.lobbyName
          ? `Recuperando “${status.lobbyName}”…`
          : 'Recuperando la partida…';
      }
      if (this.reconnectDetail) {
        this.reconnectDetail.textContent = status.lastError || 'Reintentando contra el relay y el host…';
        this.reconnectDetail.dataset.tone = status.lastError ? 'bad' : 'neutral';
      }
    }

    hideReconnectPanel() {
      if (!this.reconnectPanel || this.reconnectPanel.classList.contains('hidden')) return;
      this.reconnectPanel.classList.add('hidden');
      // Solo devolvemos el control si seguimos dentro de una partida online.
      if (this.session?.getStatus().online && this.root?.classList.contains('hidden')) this.game.setInputLocked(false);
    }

    /** Latido de interfaz a 4 Hz desde main.js. No toca el bucle de render. */
    update() {
      // Estar en partida = tener el menú principal escondido. Se deduce aquí en
      // vez de marcarlo en cada punto de entrada y salida —jugar offline,
      // entrar online, volver al inicio, desconectar, reconectar— porque
      // olvidarse de uno solo dejaría la música sonando encima del menú. El
      // latido va a 4 Hz: nadie nota un cuarto de segundo en una entrada con
      // fundido de más de un segundo.
      this.game.setMatchActive(!!this.root?.classList.contains('hidden'));
      this.networkHud.update();
      this.metrics?.update();
      if (this.session?.getStatus().online) {
        this.renderMapVote();
        this.updateMapVoteButton();
        this.renderReconnect(this.session.getReconnectStatus());
      }
    }
  }

  NG.MenuController = MenuController;
}(window.NoiseGolf = window.NoiseGolf || {}));
