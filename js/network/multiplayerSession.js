(function (NG) {
  'use strict';

  const { clamp } = NG.MathUtil;
  const WORLD_IDS = Object.freeze(['meadow', 'sky-islands', 'cavern', 'aqua-cavern', 'hybrid', 'glacier']);
  const normalizeWorlds = (value) => {
    const selected = Array.isArray(value) ? value.filter((world) => WORLD_IDS.includes(world)) : [];
    return selected.length ? [...new Set(selected)] : [...WORLD_IDS];
  };
  const boundedInt = (value, fallback, min, max) => {
    const numeric = value === '' || value == null ? NaN : Number(value);
    return clamp(Math.round(Number.isFinite(numeric) ? numeric : fallback), min, max);
  };
  const nullableInt = (value, fallback, min, max) => value == null ? null : boundedInt(value, fallback, min, max);

  // Serialización de bola compartida con la capa de suavizado (netSmoothing.js).
  const copyBall = (ball) => NG.NetBall.copy(ball);

  /** Nombre comparable: sin acentos, sin dobles espacios y en minúsculas. */
  const nameKey = (value) => String(value || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

  class MultiplayerSession {
    constructor(game, profile) {
      this.game = game;
      this.profile = profile;
      this.relay = new NG.RelayClient(profile);
      this.signaling = null;
      this.scope = 'public';
      this.transport = null;
      this.role = 'offline';
      this.state = 'idle';
      this.lobby = null;
      this.settings = null;
      this.players = new Map();
      this.clientToPlayer = new Map();
      this.pendingPeerMeta = new Map();
      this.localPlayerKey = profile.playerKey;
      this.worldTime = 0;
      this.elapsed = 0;
      this.holeElapsed = 0;
      this.finishCountdownRemaining = null;
      // Prórroga del cierre del mundo. `null` = no hay prórroga en curso; un
      // número son los segundos que aún se está dispuesto a esperar a que las
      // bolas en movimiento terminen su tiro.
      this.graceRemaining = null;
      this.graceReason = null;
      this.startedAt = 0;
      this.matchStarted = false;
      this.matchOver = false;
      this.winnerPlayerKey = null;
      this.turnPlayerKey = null;
      // Cámara libre de quien ya ha terminado el hoyo. `null` significa
      // automática (el turno en POR TURNOS, la bola propia en Battle Royale);
      // en cuanto el jugador elige a quién mirar, aquí queda su clave.
      this.spectateKey = null;
      this.finishOrder = 0;
      this.snapshotAccumulator = 0;
      this.snapshotSeq = 0;
      this.lastSnapshotSeq = -1;
      this.lobbyUpdateAccumulator = 0;
      this.transitionTimer = 0;
      // Cuánto lleva la transición de hoyo esperando a que se pare la última
      // bola. Acotado para que una bola atrapada no cuelgue la sala.
      this.transitionHold = 0;
      this.courseRound = 0;
      this.listeners = new Map();
      this.resumeToken = null;
      this.hostResumeToken = null;
      this.hostClientId = null;
      this.lastSnapshotAt = 0;
      this.connectionQuality = 'offline';
      this.mapVote = null;
      this.snapshotSeq = 0;
      this.lastSnapshotSeq = -1;
      this.mapChangeCooldownUntil = 0;

      // ── Temporización ───────────────────────────────────────────────────
      // `netTime` es el reloj de simulación del host: monótono y continuo
      // aunque cambie el hoyo o el mapa (`worldTime` sí se reinicia). Es la
      // base temporal de todos los snapshots y de la interpolación.
      this.netTime = 0;
      this.fixedStep = new NG.FixedStep(NG.NET_CONFIG.simulationHz);
      this.hostClock = new NG.NetClock();
      this.predictor = new NG.LocalPredictor();
      // Motor aparte para extrapolar bolas remotas sin tocar el del juego.
      this.viewPhysics = new NG.PhysicsEngine();
      this.renderTime = 0;
      this.interpolationDelayMs = NG.NET_CONFIG.minInterpolationMs;
      // Ancla para reconstruir `worldTime` (fase de plataformas, muros,
      // spinners y viento) en el mismo instante que se dibujan las bolas.
      this.worldBase = null;

      // ── Reconexión ──────────────────────────────────────────────────────
      this.reconnect = { active: false, until: 0, attempts: 0, reason: '', busy: false, lastError: '' };
      this.reconnectTimer = 0;
      this.lastLinkAt = 0;

      // Telemetría de presentación. No participa en autoridad ni en el protocolo:
      // solo alimenta el chip de red y el panel de métricas (F3).
      this.netStats = {
        snapshotTimes: [],
        pingSamples: [],
        arrivalJitter: 0,
        sampleAccumulator: 0,
        received: 0,
        dropped: 0,
      };
      this.bindRelayEvents();
    }

    on(type, handler) {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set());
      this.listeners.get(type).add(handler);
      return () => this.listeners.get(type)?.delete(handler);
    }

    emit(type, payload) {
      for (const fn of this.listeners.get(type) || []) {
        try { fn(payload); } catch (error) { console.error('[MultiplayerSession listener]', error); }
      }
    }

    bindRelayEvents() {
      this.relay.on('disconnect', () => {
        if (this.role !== 'offline') this.emit('connection', { state: 'relay-disconnected', text: 'Relay desconectado · P2P puede seguir activo' });
      });
      this.relay.on('reconnect', async () => {
        if (!this.lobby) return;
        // Si la ventana de reconexión está abierta, ese driver ya lleva el
        // resume: duplicarlo aquí provocaría dos ofertas WebRTC seguidas.
        if (this.reconnect.active) return;
        try {
          if (this.role === 'host' && this.hostResumeToken) {
            await this.relay.request('lobby:host-resume', {
              lobbyId: this.lobby.id,
              hostResumeToken: this.hostResumeToken,
              playerKey: this.localPlayerKey,
            });
            this.hostClientId = this.signaling.clientId;
            if (this.transport) this.transport.hostClientId = this.hostClientId;
            this.emit('connection', { state: 'connected', text: 'Relay reconectado' });
          } else if (this.role === 'client' && this.resumeToken) {
            const resumed = await this.relay.request('lobby:resume', {
              lobbyId: this.lobby.id,
              resumeToken: this.resumeToken,
              playerKey: this.localPlayerKey,
            });
            this.hostClientId = resumed.hostClientId;
            if (this.transport) this.transport.hostClientId = this.hostClientId;
            this.emit('connection', { state: 'reconnecting', text: 'Relay recuperado · renovando enlace con host…' });
          }
        } catch (error) { this.emit('error', error); }
      });
      this.relay.on('host:rebound', async (payload) => {
        if (this.role !== 'client' || !this.lobby || payload?.lobbyId !== this.lobby.id || !payload?.hostClientId) return;
        this.hostClientId = payload.hostClientId;
        if (this.transport) this.transport.hostClientId = this.hostClientId;
        this.emit('connection', { state: 'reconnecting', text: 'El host volvió al relay · recuperando P2P…' });
        if (!this.resumeToken || !this.relay.connected) return;
        try {
          const resumed = await this.relay.request('lobby:resume', {
            lobbyId: this.lobby.id,
            resumeToken: this.resumeToken,
            playerKey: this.localPlayerKey,
          });
          this.hostClientId = resumed.hostClientId || this.hostClientId;
          if (this.transport) this.transport.hostClientId = this.hostClientId;
        } catch (error) { this.emit('error', error); }
      });
      this.relay.on('lobby:closed', (payload) => {
        if (!this.lobby || payload?.lobbyId !== this.lobby.id) return;
        this.emit('closed', { reason: payload?.reason || 'host-left' });
      });
    }


    async ensureRelay(url) {
      const relayUrl = this.profile.setRelayUrl(url || this.profile.getRelayUrl());
      this.emit('progress', { value: 0.12, text: 'Conectando con relay…' });
      const welcome = await this.relay.connect(relayUrl, { autoReconnect: true, timeoutMs: Number(NG.ClientEnv?.config?.relayConnectTimeoutMs) || NG.NET_CONFIG.requestTimeoutMs });
      this.signaling = this.relay;
      this.emit('progress', { value: 0.28, text: 'Relay conectado' });
      return welcome;
    }

    normalizeSettings(settings) {
      const mode = settings?.mode === 'battle' ? 'battle' : 'turn';
      const maxPlayers = boundedInt(settings?.maxPlayers, 8, 2, NG.NET_CONFIG.maxPlayers);
      const infinite = !!settings?.infinitePoints;
      const maxPoints = infinite ? null : boundedInt(settings?.maxPoints, 5000, 500, 1000000);
      return {
        name: String(settings?.name || `${this.profile.username} · Campo`).trim().slice(0, NG.NET_CONFIG.maxLobbyNameLength),
        password: String(settings?.password || ''),
        maxPlayers,
        maxPoints,
        infinitePoints: infinite,
        mode,
        worldTimeSeconds: nullableInt(settings?.worldTimeSeconds, 180, 30, 1800),
        finishCountdownSeconds: nullableInt(settings?.finishCountdownSeconds, 45, 10, 300),
        maxTurnsPerWorld: nullableInt(settings?.maxTurnsPerWorld, 12, 1, 100),
        allowedWorlds: normalizeWorlds(settings?.allowedWorlds),
        collisionsEnabled: mode === 'battle' && settings?.collisionsEnabled !== false,
        mapVoteEnabled: true,
      };
    }

    courseOptions() {
      return { quiet: true, allowedArchetypes: normalizeWorlds(this.settings?.allowedWorlds) };
    }

    async createMatch(settings, relayUrl = null) {
      await this.leave({ keepRelay: true, keepLast: true });
      this.scope = 'public';
      await this.ensureRelay(relayUrl || this.profile.getRelayUrl());
      const normalized = { ...this.normalizeSettings(settings), scope: 'public' };
      this.emit('progress', { value: 0.38, text: 'Registrando partida en el relay público…' });
      const result = await this.signaling.request('lobby:create', normalized);
      this.role = 'host';
      this.state = 'lobby';
      this.settings = normalized;
      this.lobby = result.lobby;
      this.resumeToken = result.resumeToken;
      this.hostResumeToken = result.hostResumeToken;
      this.hostClientId = this.signaling.clientId;
      this.setupTransport('host', this.lobby.id, this.hostClientId);
      this.startHostWorld(result.seed || this.game.makeSeed(), result.colorIndex ?? 0);
      // La autoridad del host vive en esta pestaña. No ofrecemos una falsa
      // reconexión tras recargar el navegador porque el relay no conserva gameplay.
      this.emit('progress', { value: 1, text: 'Partida creada' });
      this.emit('ready', { role: this.role, lobby: this.lobby });
      this.broadcastRoster();
      return result;
    }

    async joinMatch(lobby, password = '', relayUrl = null) {
      if (!lobby?.id) throw new Error('Partida inválida.');
      await this.leave({ keepRelay: true, keepLast: true });
      this.scope = 'public';
      await this.ensureRelay(relayUrl || this.profile.getRelayUrl());
      this.role = 'client';
      this.state = 'joining';
      this.lobby = { ...lobby };
      this.setupTransport('client', lobby.id, lobby.hostClientId || null);
      this.emit('progress', { value: 0.42, text: 'Solicitando acceso…' });
      const result = await this.signaling.request('lobby:join', { lobbyId: lobby.id, password: String(password || '') });
      this.lobby = result.lobby;
      this.settings = result.lobby;
      this.resumeToken = result.resumeToken;
      this.hostClientId = result.hostClientId;
      this.transport.becomeClient(lobby.id, this.hostClientId);
      this.profile.saveLastSession({
        lobbyId: lobby.id,
        lobbyName: result.lobby.name,
        resumeToken: this.resumeToken,
        scope: 'public',
        relayUrl: this.relay.url,
      });
      this.emit('progress', { value: 0.58, text: result.role === 'spectator' ? 'Partida iniciada · entrando como espectador…' : 'Creando enlace P2P…' });
      return result;
    }

    async resumeLast(lastSession) {
      const last = lastSession || this.profile.getLastSession();
      if (!last) throw new Error('No existe una sesión reciente guardada.');
      await this.leave({ keepRelay: true, keepLast: true });
      this.scope = 'public';
      await this.ensureRelay(last.relayUrl || this.profile.getRelayUrl());
      this.role = 'client';
      this.state = 'joining';
      this.lobby = { id: last.lobbyId, name: last.lobbyName || 'Partida reciente' };
      this.setupTransport('client', last.lobbyId, null);
      this.emit('progress', { value: 0.42, text: 'Buscando tu última sesión…' });
      try {
        const result = await this.signaling.request('lobby:resume', {
          lobbyId: last.lobbyId,
          resumeToken: last.resumeToken,
          playerKey: this.profile.playerKey,
        });
        this.lobby = result.lobby;
        this.settings = result.lobby;
        this.resumeToken = result.resumeToken || last.resumeToken;
        this.hostClientId = result.hostClientId;
        this.transport.becomeClient(last.lobbyId, this.hostClientId);
        this.emit('progress', { value: 0.60, text: 'Identidad recuperada · enlazando con host…' });
        return result;
      } catch (error) {
        this.profile.clearLastSession();
        throw error;
      }
    }

    setupTransport(role, lobbyId, hostClientId) {
      if (this.transport) this.transport.close();
      this.transport = new NG.WebRTCHostClient(this.signaling);
      if (role === 'host') this.transport.becomeHost(lobbyId);
      else this.transport.becomeClient(lobbyId, hostClientId);
      this.transport.on('peerpending', (meta) => {
        if (meta?.clientId) this.pendingPeerMeta.set(meta.clientId, meta);
      });
      this.transport.on('peeropen', ({ peerId }) => this.handlePeerOpen(peerId));
      this.transport.on('peerclose', ({ peerId }) => this.handlePeerClose(peerId));
      this.transport.on('message', (packet) => this.handlePeerMessage(packet));
      this.transport.on('rtt', ({ peerId, rtt }) => {
        const key = this.clientToPlayer.get(peerId);
        const player = key ? this.players.get(key) : null;
        if (player) player.ping = rtt;
      });
      this.transport.on('iceerror', (info) => this.emit('iceerror', info));
    }

    startHostWorld(seed, colorIndex) {
      this.game.startNewCourse(seed, this.courseOptions());
      this.worldTime = 0;
      this.netTime = 0;
      this.fixedStep.reset();
      this.elapsed = 0;
      this.holeElapsed = 0;
      this.finishCountdownRemaining = null;
      this.graceRemaining = null;
      this.graceReason = null;
      this.transitionHold = 0;
      this.startedAt = 0;
      this.matchStarted = false;
      this.matchOver = false;
      this.winnerPlayerKey = null;
      this.turnPlayerKey = this.localPlayerKey;
      this.finishOrder = 0;
      this.courseRound = 0;
      this.snapshotSeq = 0;
      this.lastSnapshotSeq = -1;
      this.mapVote = null;
      this.mapChangeCooldownUntil = 0;
      this.players.clear();
      const player = this.makePlayer({
        playerKey: this.localPlayerKey,
        clientId: this.signaling.clientId,
        username: this.profile.username,
        colorIndex,
        role: 'player',
        connected: true,
      });
      this.players.set(player.playerKey, player);
      this.clientToPlayer.set(this.signaling.clientId, player.playerKey);
      this.syncGameToLocal();
      this.updateDiscoveryLobby(true);
    }

    makeBall(hole = this.game.hole) {
      return {
        x: hole.tee.x, y: hole.tee.y, vx: 0, vy: 0, moving: false, holed: false, inWater: false, crushed: false,
        boosterCooldown: 0, portalCooldown: 0, specialCooldown: 0, boosterPulse: 0, fanPulse: 0,
        lastSafe: { x: hole.tee.x, y: hole.tee.y, surfaceId: hole.tee.surfaceId },
        shotOrigin: { x: hole.tee.x, y: hole.tee.y, surfaceId: hole.tee.surfaceId },
        lastSurfaceId: hole.tee.surfaceId, impactSerial: 0, boosterSerial: 0, holeSerial: 0, portalSerial: 0,
        cannonSerial: 0, multiplierSerial: 0, caveSerial: 0, caveExitSerial: 0, gravityPulse: 0,
        movingWallSerial: 0, spinnerSerial: 0, lastPortalPairId: null, lastPortalExitIndex: null, lastCaveId: null,
        sabotageByPlayerKey: null, sabotageTouchAt: 0, caveRide: null,
      };
    }

    makePlayer(meta) {
      const ball = meta.role === 'spectator' ? null : this.makeBall();
      return {
        playerKey: meta.playerKey,
        clientId: meta.clientId || null,
        username: String(meta.username || 'Jugador'),
        colorIndex: clamp(Math.round(meta.colorIndex || 0), 0, NG.NET_CONFIG.colors.length - 1),
        role: meta.role === 'spectator' ? 'spectator' : 'player',
        connected: meta.connected !== false,
        disconnectedAt: 0,
        ball,
        renderX: ball?.x || 0,
        renderY: ball?.y || 0,
        renderVX: 0,
        renderVY: 0,
        // Estado justo antes del último paso fijo: el host interpola entre
        // este y el actual para no enseñar los 60 pasos por segundo.
        prevX: ball?.x || 0,
        prevY: ball?.y || 0,
        // Bola de presentación: la que manda flags y serials al render, para
        // que los efectos suenen en el frame en el que se ven.
        presentationBall: ball,
        netReceivedAt: 0,
        // Buffer de snapshots + corrección suave de esta bola en el cliente.
        interpolator: this.role === 'client' ? new NG.EntityInterpolator() : null,
        physics: this.role === 'host' ? new NG.PhysicsEngine() : null,
        strokes: 0,
        turnsUsed: 0,
        points: Number(meta.points) || 0,
        finished: false,
        timedOut: false,
        finishReason: null,
        finishOrder: 0,
        holePoints: 0,
        shotInProgress: false,
        multiplierFound: false,
        lastMultiplierSerial: 0,
        lastCaveSerial: 0,
        discoveredCaves: new Set(Array.isArray(meta.discoveredCaves) ? meta.discoveredCaves : []),
        ping: null,
      };
    }

    /** ¿Este jugador todavía conserva su plaza reservada? */
    withinGrace(player) {
      if (!player) return false;
      if (player.connected) return true;
      if (!player.disconnectedAt) return true;
      return Date.now() - player.disconnectedAt <= NG.NET_CONFIG.playerGraceMs;
    }

    /**
     * Guard de identidad del host.
     *
     * El identificador real es `playerKey` (aleatorio y persistente en el
     * navegador); el nombre es solo una etiqueta. Aquí impedimos que dos
     * perfiles distintos compartan nombre visible en la misma partida, incluso
     * si el titular está desconectado pero dentro de su ventana de gracia: su
     * plaza, su color y su puntuación siguen siendo suyos.
     */
    identityRejection(playerKey, username) {
      const wanted = nameKey(username);
      if (!wanted) return null;
      for (const other of this.players.values()) {
        if (other.playerKey === playerKey) continue;
        if (nameKey(other.username) !== wanted) continue;
        if (!this.withinGrace(other)) continue;
        return {
          code: other.connected ? 'name-taken' : 'name-reserved',
          text: other.connected
            ? `Ya hay un jugador llamado "${username}" en esta partida.`
            : `"${username}" es de un jugador desconectado que aún puede volver. Usa otro nombre.`,
        };
      }
      return null;
    }

    /** Rechaza un peer explicando el motivo antes de cerrar el canal. */
    rejectPeer(peerId, code, text) {
      this.pendingPeerMeta.delete(peerId);
      this.transport?.sendReliable(peerId, { type: 'session:reject', code, text });
      // Un instante para que el canal fiable llegue a vaciar el mensaje.
      window.setTimeout(() => this.transport?.closePeer(peerId, `rejected-${code}`), 260);
      this.emit('gameevent', { event: 'peer-rejected', code, text });
    }

    handlePeerOpen(peerId) {
      if (this.role === 'host') {
        const meta = this.pendingPeerMeta.get(peerId) || {};
        // La identidad la certifica el relay en peer:join / peer:resume.
        // El canal de datos NUNCA puede declarar quién es: si pudiera, bastaría
        // con enviar el playerKey ajeno para robar plaza y puntuación.
        const playerKey = meta.playerKey || this.clientToPlayer.get(peerId);
        if (!playerKey) {
          this.rejectPeer(peerId, 'identity', 'El relay no confirmó tu identidad. Vuelve a entrar desde la lista de partidas.');
          return;
        }
        const rejection = this.identityRejection(playerKey, meta.username);
        if (rejection) {
          this.rejectPeer(peerId, rejection.code, rejection.text);
          return;
        }
        let player = this.players.get(playerKey) || null;
        if (!player) {
          player = this.makePlayer({
            playerKey,
            clientId: peerId,
            username: meta.username,
            colorIndex: meta.colorIndex,
            role: meta.role,
            connected: true,
          });
          this.players.set(playerKey, player);
        }
        if (player) {
          const previousClientId = player.clientId;
          if (previousClientId && previousClientId !== peerId) {
            this.clientToPlayer.delete(previousClientId);
            this.transport?.closePeer(previousClientId, 'player-reconnected');
          }
          player.clientId = peerId;
          player.connected = true;
          player.disconnectedAt = 0;
          this.clientToPlayer.set(peerId, player.playerKey);
          if (this.mapVote && !this.mapVote.electorate.has(player.playerKey)) {
            this.mapVote.electorate.add(player.playerKey);
            this.broadcastMapVote();
          }
        }
        this.pendingPeerMeta.delete(peerId);
        this.sendInit(peerId);
        this.broadcastRoster();
        this.updateDiscoveryLobby(true);
      } else {
        // Tras rebind/reconexión el host puede tener un clientId nuevo. Fijamos
        // primero el canal bueno y luego retiramos los anteriores: así el cierre
        // del canal viejo no se confunde con una caída del enlace.
        this.hostClientId = peerId;
        this.transport.hostClientId = peerId;
        for (const otherId of [...this.transport.peers.keys()]) {
          if (otherId !== peerId) this.transport.closePeer(otherId, 'host-peer-replaced');
        }
        this.state = 'syncing';
        this.emit('progress', { value: 0.78, text: 'Canal P2P conectado · sincronizando mundo…' });
        this.transport.sendReliable(peerId, { type: 'client:ready', playerKey: this.localPlayerKey, username: this.profile.username });
      }
    }

    handlePeerClose(peerId) {
      if (this.role !== 'host') {
        // Cerrar un canal antiguo tras reconectar no es una caída.
        if (this.hostClientId && peerId !== this.hostClientId) return;
        this.beginReconnect('enlace-perdido');
        return;
      }
      const key = this.clientToPlayer.get(peerId);
      const player = key ? this.players.get(key) : null;
      // Si el jugador ya volvió con un canal nuevo, el cierre del canal viejo
      // no debe marcarlo como caído.
      if (player && player.clientId === peerId) {
        player.connected = false;
        player.disconnectedAt = Date.now();
        player.clientId = null;
        if ((this.settings?.mode || 'turn') === 'turn' && this.turnPlayerKey === player.playerKey) this.advanceTurnFrom(player.playerKey);
        if (this.mapVote?.electorate?.has(player.playerKey)) {
          this.mapVote.electorate.delete(player.playerKey);
          this.mapVote.yes.delete(player.playerKey);
          if (!this.mapVote.electorate.size) this.closeMapVote('no-players');
          else if (this.mapVote.yes.size >= this.mapVote.electorate.size) this.passMapVote();
          else this.broadcastMapVote();
        }
        this.broadcastReliable({
          type: 'session:event',
          event: 'player-disconnected',
          playerKey: player.playerKey,
          username: player.username,
          graceMs: NG.NET_CONFIG.playerGraceMs,
        });
      }
      this.clientToPlayer.delete(peerId);
      this.broadcastRoster();
      this.updateDiscoveryLobby(true);
    }

    /**
     * Retira definitivamente a quien agotó la ventana de gracia.
     *
     * Hasta ese momento el jugador sigue en el marcador con su puntuación,
     * su color y su bola congelada, y puede recuperarlo todo reconectando.
     * Al expirar se libera la plaza y el color para otro jugador.
     */
    pruneDisconnectedPlayers() {
      if (this.role !== 'host') return;
      const now = Date.now();
      const grace = NG.NET_CONFIG.playerGraceMs;
      let removed = false;
      for (const [key, player] of [...this.players]) {
        if (key === this.localPlayerKey) continue;
        if (player.connected || !player.disconnectedAt) continue;
        if (now - player.disconnectedAt <= grace) continue;
        this.players.delete(key);
        for (const [clientId, mapped] of [...this.clientToPlayer]) if (mapped === key) this.clientToPlayer.delete(clientId);
        if (this.mapVote?.electorate?.has(key)) {
          this.mapVote.electorate.delete(key);
          this.mapVote.yes.delete(key);
        }
        if (this.turnPlayerKey === key) this.advanceTurnFrom(key);
        this.broadcastReliable({
          type: 'session:event', event: 'player-removed', playerKey: key, username: player.username, reason: 'grace-expired',
        });
        this.emit('gameevent', { event: 'player-removed', playerKey: key, username: player.username, reason: 'grace-expired' });
        removed = true;
      }
      if (!removed) return;
      if (this.mapVote && !this.mapVote.electorate.size) this.closeMapVote('no-players');
      else if (this.mapVote && this.mapVote.yes.size >= this.mapVote.electorate.size) this.passMapVote();
      this.broadcastRoster();
      this.updateDiscoveryLobby(true);
    }

    handlePeerMessage({ peerId, message }) {
      if (this.role === 'host') {
        const playerKey = this.clientToPlayer.get(peerId);
        const player = playerKey ? this.players.get(playerKey) : null;
        if (message.type === 'client:ready') {
          this.sendInit(peerId);
        } else if (message.type === 'shot' && player) {
          this.applyShot(player, message.velocity);
        } else if (message.type === 'reset' && player) {
          if (this.canPlayerReset(player)) this.resetPlayerBall(player, 1, 'Vuelta al punto del tiro', 'shot');
        } else if (message.type === 'client:resync') {
          this.sendInit(peerId);
        } else if (message.type === 'map:vote:start' && player) {
          this.startMapVote(player.playerKey);
        } else if (message.type === 'map:vote:cast' && player) {
          this.castMapVote(player.playerKey, message.choice === 'yes' ? 'yes' : 'no');
        }
        return;
      }

      if (peerId !== this.hostClientId && this.hostClientId) return;
      if (message.type === 'session:reject') {
        // El host nos deniega la entrada (nombre en uso, identidad sin
        // confirmar…). Reintentar no arreglaría nada: se cierra la ventana.
        this.cancelReconnect();
        this.emit('rejected', { code: message.code || 'rejected', text: message.text || 'El host rechazó la conexión.' });
        return;
      }
      if (message.type === 'session:init') this.applyInit(message);
      else if (message.type === 'session:roster') this.applyRoster(message.players || []);
      else if (message.type === 'session:event') this.emit('gameevent', message);
      else if (message.type === 'state:snapshot') this.applySnapshot(message);
      else if (message.type === 'map:vote:update') { this.mapVote = this.normalizeRemoteVote(message.vote); this.emit('mapvote', this.getMapVoteStatus()); }
      else if (message.type === 'map:vote:closed') { this.mapVote = null; this.emit('mapvote', this.getMapVoteStatus()); }
      else if (message.type === 'match:over') {
        this.matchOver = true;
        this.winnerPlayerKey = message.winnerPlayerKey;
        this.emit('matchover', { winnerPlayerKey: message.winnerPlayerKey, standings: this.getStandings() });
      }
    }

    sendInit(peerId) {
      const playerKey = this.clientToPlayer.get(peerId);
      const player = playerKey ? this.players.get(playerKey) : null;
      this.transport.sendReliable(peerId, {
        type: 'session:init',
        seed: this.game.seed,
        holeIndex: this.game.holeIndex,
        courseRound: this.courseRound,
        snapshotSeq: this.snapshotSeq,
        netTime: this.netTime,
        worldTime: this.worldTime,
        elapsed: this.elapsed,
        holeElapsed: this.holeElapsed,
        finishCountdownRemaining: this.finishCountdownRemaining,
        graceRemaining: this.graceRemaining,
        matchStarted: this.matchStarted,
        matchOver: this.matchOver,
        winnerPlayerKey: this.winnerPlayerKey,
        turnPlayerKey: this.turnPlayerKey,
        mapVote: this.serializeMapVote(),
        worldState: this.serializeWorldState(),
        mapChangeCooldownRemainingMs: Math.max(0, this.mapChangeCooldownUntil - Date.now()),
        settings: this.publicSettings(),
        localRole: player?.role || 'spectator',
        players: this.serializePlayers(true),
      });
    }

    applyInit(message) {
      this.settings = message.settings || this.settings || {};
      this.courseRound = message.courseRound || 0;
      this.matchStarted = !!message.matchStarted;
      this.matchOver = !!message.matchOver;
      this.winnerPlayerKey = message.winnerPlayerKey || null;
      this.turnPlayerKey = message.turnPlayerKey || null;
      this.lastSnapshotSeq = Number.isFinite(Number(message.snapshotSeq)) ? Number(message.snapshotSeq) : -1;
      this.mapVote = this.normalizeRemoteVote(message.mapVote);
      this.mapChangeCooldownUntil = Date.now() + Math.max(0, Number(message.mapChangeCooldownRemainingMs) || 0);
      this.elapsed = Number(message.elapsed) || 0;
      this.holeElapsed = Number(message.holeElapsed) || 0;
      this.finishCountdownRemaining = message.finishCountdownRemaining == null ? null : Math.max(0, Number(message.finishCountdownRemaining) || 0);
      this.graceRemaining = message.graceRemaining == null ? null : Math.max(0, Number(message.graceRemaining) || 0);
      this.syncWorld(message.seed, message.holeIndex || 0);
      this.applyWorldState(message.worldState);
      this.worldTime = Number(message.worldTime) || 0;
      this.netTime = Number(message.netTime) || 0;
      this.game.physics.time = this.worldTime;
      // Sincronización completa: reloj, buffers e historial arrancan de cero
      // con el estado que acaba de enviar la autoridad.
      const now = performance.now();
      this.hostClock.reset(this.netTime, now);
      this.worldBase = { net: this.netTime, world: this.worldTime };
      this.renderTime = this.netTime;
      this.interpolationDelayMs = NG.NET_CONFIG.minInterpolationMs;
      this.netStats.arrivalJitter = 0;
      this.applyRoster(message.players || []);
      this.resetPresentation();
      this.state = message.localRole === 'spectator' ? 'spectating' : 'playing';
      this.emit('progress', { value: 1, text: message.localRole === 'spectator' ? 'Conectado como espectador' : 'Listo para jugar' });
      this.emit('ready', { role: this.role, lobby: this.lobby, spectator: message.localRole === 'spectator' });
      this.lastSnapshotAt = now;
      this.endReconnect();
    }

    /**
     * Reinicia la capa de presentación del cliente contra el estado actual.
     * Se usa al entrar, al resincronizar y en cada cambio de hoyo o de mapa:
     * un buffer con muestras del mundo anterior produciría un barrido de la
     * bola por toda la pantalla.
     */
    resetPresentation() {
      if (this.role !== 'client') return;
      for (const p of this.players.values()) {
        if (!p.ball) continue;
        if (!p.interpolator) p.interpolator = new NG.EntityInterpolator();
        p.interpolator.reset(p.ball, this.netTime);
        p.renderX = p.ball.x;
        p.renderY = p.ball.y;
        p.renderVX = Number(p.ball.vx) || 0;
        p.renderVY = Number(p.ball.vy) || 0;
        p.presentationBall = p.ball;
      }
      const local = this.players.get(this.localPlayerKey);
      this.predictor.reset(local?.ball || null, this.netTime);
    }

    syncWorld(seed, holeIndex) {
      if (!seed) return;
      if (this.game.seed !== seed || !this.game.holes?.length) this.game.startNewCourse(seed, this.courseOptions());
      if (this.game.holeIndex !== holeIndex) this.game.loadHole(clamp(holeIndex, 0, this.game.holes.length - 1));
    }

    publicSettings() {
      return {
        name: this.settings?.name || this.lobby?.name || 'Partida',
        mode: this.settings?.mode || 'turn',
        maxPlayers: this.settings?.maxPlayers || this.lobby?.maxPlayers || 8,
        maxPoints: this.settings?.maxPoints ?? null,
        infinitePoints: this.settings?.infinitePoints ?? (this.settings?.maxPoints == null),
        worldTimeSeconds: this.settings?.worldTimeSeconds ?? null,
        finishCountdownSeconds: this.settings?.finishCountdownSeconds ?? null,
        maxTurnsPerWorld: this.settings?.maxTurnsPerWorld ?? null,
        allowedWorlds: normalizeWorlds(this.settings?.allowedWorlds),
        collisionsEnabled: (this.settings?.mode || 'turn') === 'battle' && this.settings?.collisionsEnabled !== false,
        mapVoteEnabled: true,
        scope: this.scope,
      };
    }

    serializeWorldState() {
      const consumedPortalPairs = new Set();
      for (const hazard of this.game.hole?.hazards || []) {
        if (hazard.type === 'portal' && hazard.consumed && hazard.pairId) consumedPortalPairs.add(hazard.pairId);
      }
      return { consumedPortalPairs: [...consumedPortalPairs] };
    }

    applyWorldState(state) {
      const consumed = new Set(Array.isArray(state?.consumedPortalPairs) ? state.consumedPortalPairs : []);
      for (const hazard of this.game.hole?.hazards || []) {
        if (hazard.type === 'portal') hazard.consumed = consumed.has(hazard.pairId);
      }
    }

    applyLocalWorldPresentation() {
      const local = this.players.get(this.localPlayerKey);
      const discovered = local?.role === 'player' && local.discoveredCaves instanceof Set
        ? local.discoveredCaves
        : new Set();
      for (const hazard of this.game.hole?.hazards || []) {
        if (hazard.type === 'secret-cave') hazard.discovered = discovered.has(hazard.caveId);
      }
    }

    serializePlayers(includeBall = false) {
      return [...this.players.values()].map((p) => ({
        playerKey: p.playerKey,
        clientId: p.clientId,
        username: p.username,
        colorIndex: p.colorIndex,
        role: p.role,
        connected: p.connected,
        strokes: p.strokes,
        turnsUsed: p.turnsUsed,
        points: p.points,
        finished: p.finished,
        timedOut: p.timedOut,
        finishReason: p.finishReason,
        finishOrder: p.finishOrder,
        holePoints: p.holePoints,
        discoveredCaves: [...(p.discoveredCaves || [])],
        ping: p.clientId ? this.transport?.getRtt(p.clientId) ?? p.ping : p.ping,
        ball: includeBall ? copyBall(p.ball) : undefined,
      }));
    }

    applyRoster(players, options = {}) {
      const seen = new Set();
      for (const meta of players) {
        if (!meta?.playerKey) continue;
        seen.add(meta.playerKey);
        let p = this.players.get(meta.playerKey);
        if (!p) {
          p = this.makePlayer(meta);
          this.players.set(meta.playerKey, p);
        }
        p.clientId = meta.clientId || p.clientId;
        p.username = meta.username || p.username;
        p.colorIndex = Number.isFinite(meta.colorIndex) ? meta.colorIndex : p.colorIndex;
        p.role = meta.role || p.role;
        p.connected = meta.connected !== false;
        const previousStrokes = p.strokes || 0;
        p.strokes = Number(meta.strokes) || 0;
        p.turnsUsed = Number(meta.turnsUsed) || 0;
        if (p.shotInProgress && (p.strokes > previousStrokes || meta.ball?.moving)) p.shotInProgress = false;
        p.points = Number(meta.points) || 0;
        p.finished = !!meta.finished;
        p.timedOut = !!meta.timedOut;
        p.finishReason = meta.finishReason || null;
        p.finishOrder = Number(meta.finishOrder) || 0;
        p.holePoints = Number(meta.holePoints) || 0;
        p.discoveredCaves = new Set(Array.isArray(meta.discoveredCaves) ? meta.discoveredCaves : []);
        if (meta.ball) {
          p.ball = { ...(p.ball || {}), ...meta.ball };
          if (!Number.isFinite(p.renderX)) p.renderX = p.ball.x;
          if (!Number.isFinite(p.renderY)) p.renderY = p.ball.y;
          if (!Number.isFinite(p.renderVX)) p.renderVX = Number(p.ball.vx) || 0;
          if (!Number.isFinite(p.renderVY)) p.renderVY = Number(p.ball.vy) || 0;
          if (!p.presentationBall) p.presentationBall = p.ball;
          if (options.snapshot && this.role === 'client') {
            p.netReceivedAt = performance.now();
            this.ingestAuthoritativeBall(p, options.netTime, !!options.worldChanged);
          }
        }
      }
      for (const key of [...this.players.keys()]) if (!seen.has(key) && this.role !== 'host') this.players.delete(key);
      this.syncGameToLocal(this.role === 'client');
      this.emit('standings', this.getStandings());
    }

    /**
     * Entrega el estado confirmado a la capa de presentación.
     *
     * Las bolas ajenas entran en su buffer de interpolación. La propia va
     * además al reconciliador, que reproyecta la autoridad hasta el presente
     * y absorbe la diferencia como corrección visual en lugar de un tirón.
     */
    ingestAuthoritativeBall(player, netTime, worldChanged) {
      if (!player?.ball) return;
      if (!player.interpolator) player.interpolator = new NG.EntityInterpolator();
      const t = Number.isFinite(Number(netTime)) ? Number(netTime) : this.netTime;
      if (worldChanged) {
        player.interpolator.reset(player.ball, t);
      } else {
        player.interpolator.push(t, player.ball, { context: { physics: this.viewPhysics, hole: this.game.hole } });
      }
      if (player.playerKey !== this.localPlayerKey) return;

      if (worldChanged || !NG.NET_CONFIG.predictionEnabled || !this.predictor.ball) {
        this.predictor.reset(player.ball, t);
        return;
      }
      // También reconciliamos con la bola parada: así el error residual del
      // último tramo del tiro se disuelve en vez de saltar al detenerse.
      // `shotInProgress` sigue en pie mientras el host no confirme el tiro
      // (applyRoster lo baja al ver el golpe contado o la bola en marcha).
      this.predictor.reconcile(
        player.ball,
        t,
        this.hostClock.now() + this.oneWaySeconds(),
        this.game.hole,
        { pendingShot: !!player.shotInProgress },
      );
    }

    applySnapshot(snapshot) {
      const seq = Number(snapshot?.seq);
      if (Number.isFinite(seq)) {
        if (seq <= this.lastSnapshotSeq) return;
        // Un salto en la secuencia significa snapshots perdidos en el canal no fiable.
        if (this.lastSnapshotSeq >= 0 && seq > this.lastSnapshotSeq + 1) {
          this.netStats.dropped += seq - this.lastSnapshotSeq - 1;
        }
        this.lastSnapshotSeq = seq;
      }
      this.trackSnapshot();
      const arrivedAt = performance.now();
      this.lastSnapshotAt = arrivedAt;
      const previousSeed = this.game.seed;
      const previousHole = this.game.holeIndex;
      this.syncWorld(snapshot.seed, snapshot.holeIndex || 0);
      this.applyWorldState(snapshot.worldState);
      const worldChanged = previousSeed !== this.game.seed || previousHole !== this.game.holeIndex;

      // El reloj de red del host es la única referencia temporal: con él
      // ordenamos las muestras y decidimos qué instante dibujar.
      const incomingNetTime = Number(snapshot.netTime);
      if (Number.isFinite(incomingNetTime)) {
        this.netTime = incomingNetTime;
        this.hostClock.push(incomingNetTime, arrivedAt, worldChanged);
      }
      const incomingWorldTime = Number(snapshot.worldTime);
      if (Number.isFinite(incomingWorldTime) && Number.isFinite(this.netTime)) {
        this.worldBase = { net: this.netTime, world: incomingWorldTime };
        if (worldChanged) this.worldTime = incomingWorldTime;
      }
      this.elapsed = Number(snapshot.elapsed) || 0;
      this.holeElapsed = Number(snapshot.holeElapsed) || 0;
      this.finishCountdownRemaining = snapshot.finishCountdownRemaining == null ? null : Math.max(0, Number(snapshot.finishCountdownRemaining) || 0);
      this.graceRemaining = snapshot.graceRemaining == null ? null : Math.max(0, Number(snapshot.graceRemaining) || 0);
      this.matchStarted = !!snapshot.matchStarted;
      this.matchOver = !!snapshot.matchOver;
      this.turnPlayerKey = snapshot.turnPlayerKey || null;
      this.winnerPlayerKey = snapshot.winnerPlayerKey || null;
      this.mapVote = this.normalizeRemoteVote(snapshot.mapVote);
      if (snapshot.mapChangeCooldownRemainingMs !== undefined) this.mapChangeCooldownUntil = Date.now() + Math.max(0, Number(snapshot.mapChangeCooldownRemainingMs) || 0);
      this.applyRoster(snapshot.players || [], { snapshot: true, netTime: this.netTime, worldChanged });
      if (worldChanged) this.resetPresentation();
      this.game.physics.time = this.worldTime;
    }

    canLocalShoot() {
      if (this.role === 'offline') return true;
      if (this.matchOver || this.state === 'joining' || this.state === 'syncing') return false;
      // El mundo ya está cerrado: la prórroga solo deja acabar los tiros que
      // ya estaban en el aire, no empezar otros nuevos.
      if (this.graceRemaining != null) return false;
      const player = this.players.get(this.localPlayerKey);
      if (!player || player.role !== 'player' || !player.ball || player.finished || !player.connected) return false;
      if (this.settings?.maxTurnsPerWorld != null && player.turnsUsed >= this.settings.maxTurnsPerWorld) return false;
      if (player.ball.moving || player.ball.holed || player.ball.inWater || player.shotInProgress) return false;
      if ((this.settings?.mode || this.lobby?.mode) === 'turn' && this.turnPlayerKey !== player.playerKey) return false;
      return true;
    }

    submitShot(velocity) {
      if (!this.canLocalShoot()) return false;
      const safeVelocity = {
        x: Number(velocity?.x) || 0,
        y: Number(velocity?.y) || 0,
      };
      if (this.role === 'host') return this.applyShot(this.players.get(this.localPlayerKey), safeVelocity);
      const ok = this.transport?.sendReliable(this.hostClientId, { type: 'shot', velocity: safeVelocity });
      if (ok) {
        const player = this.players.get(this.localPlayerKey);
        if (player) {
          player.shotInProgress = true;
          player.shotSentAt = performance.now();
          if (NG.NET_CONFIG.predictionEnabled) {
            // El host sigue decidiendo el tiro; en local solo adelantamos la
            // MISMA simulación para que la bola salga en este frame. La
            // diferencia contra la autoridad se reconcilia con cada snapshot.
            const offsetX = Number(player.renderX) - Number(player.ball.x);
            const offsetY = Number(player.renderY) - Number(player.ball.y);
            if (this.predictor.begin(player.ball, safeVelocity, this.hostClock.now() + this.oneWaySeconds())) {
              // Arrancamos exactamente donde estaba dibujada: ni un píxel de salto.
              this.predictor.errorX = Number.isFinite(offsetX) ? offsetX : 0;
              this.predictor.errorY = Number.isFinite(offsetY) ? offsetY : 0;
            }
          }
          player.renderVX = safeVelocity.x;
          player.renderVY = safeVelocity.y;
        }
      }
      return !!ok;
    }

    canPlayerReset(player) {
      if (this.matchOver || this.graceRemaining != null) return false;
      if (!player || player.role !== 'player' || !player.ball || player.finished || player.ball.holed) return false;
      const mode = this.settings?.mode || this.lobby?.mode || 'turn';
      return mode !== 'turn' || !this.turnPlayerKey || this.turnPlayerKey === player.playerKey;
    }

    canRequestReset() {
      if (this.role === 'offline') return false;
      return this.canPlayerReset(this.players.get(this.localPlayerKey));
    }

    requestReset() {
      if (!this.canRequestReset()) return false;
      const player = this.players.get(this.localPlayerKey);
      if (this.role === 'host') {
        this.resetPlayerBall(player, 1, 'Vuelta al punto del tiro', 'shot');
        return true;
      }
      return !!this.transport?.sendReliable(this.hostClientId, { type: 'reset' });
    }

    applyShot(player, velocity) {
      if (!player || player.role !== 'player' || !player.ball || player.finished || !player.connected || this.matchOver) return false;
      if (this.graceRemaining != null) return false;
      const speed = Math.hypot(Number(velocity?.x) || 0, Number(velocity?.y) || 0);
      if (!Number.isFinite(speed) || speed < NG.CONFIG.shot.minLaunchSpeed || speed > NG.CONFIG.ball.maxSpeed * 1.03) return false;
      if (player.ball.moving || player.ball.holed || player.ball.inWater) return false;
      if (this.settings?.maxTurnsPerWorld != null && player.turnsUsed >= this.settings.maxTurnsPerWorld) return false;
      if ((this.settings?.mode || 'turn') === 'turn' && this.turnPlayerKey !== player.playerKey) return false;
      this.clearSabotageAttribution(player.ball);
      player.physics?.resetMotionGuard?.(player.ball);
      player.ball.shotOrigin = {
        x: player.ball.x,
        y: player.ball.y,
        surfaceId: player.ball.lastSurfaceId || player.ball.lastSafe?.surfaceId || this.game.hole.tee.surfaceId,
      };
      player.ball.vx = velocity.x;
      player.ball.vy = velocity.y;
      player.ball.moving = true;
      player.ball.inWater = false;
      player.ball.crushed = false;
      player.ball.lastImpactSpeed = 0;
      player.strokes += 1;
      player.turnsUsed += 1;
      player.shotInProgress = true;
      if (!this.matchStarted) {
        this.matchStarted = true;
        this.startedAt = Date.now();
        this.elapsed = 0;
        this.updateDiscoveryLobby(true);
      }
      this.broadcastReliable({ type: 'session:event', event: 'shot', playerKey: player.playerKey, strokes: player.strokes });
      this.syncGameToLocal();
      return true;
    }

    update(dt) {
      if (this.role === 'offline' || !this.transport) return;
      this.transport.update(dt);
      this.sampleNetStats(dt);
      if (this.role === 'host') {
        this.fixedStep.run(dt, (step) => this.stepHost(step));
        this.presentHost(dt);
      } else this.updateClient(dt);
    }

    /** Registra la llegada (cliente) o el envío (host) de un snapshot. */
    trackSnapshot() {
      const times = this.netStats.snapshotTimes;
      const now = performance.now();
      const previous = times.length ? times[times.length - 1] : null;
      times.push(now);
      this.netStats.received += 1;
      while (times.length && now - times[0] > 3000) times.shift();
      if (previous == null) return;
      // Jitter de llegada: cuánto se desvía cada paquete del ritmo nominal.
      // Es lo que decide el tamaño del buffer de interpolación.
      const nominal = 1000 / Math.max(1, NG.NET_CONFIG.snapshotHz);
      const deviation = Math.abs((now - previous) - nominal);
      this.netStats.arrivalJitter = this.netStats.arrivalJitter * 0.85 + deviation * 0.15;
    }

    /** Ritmo real de snapshots medido sobre la ventana de 3 s. */
    getSnapshotHz() {
      const times = this.netStats.snapshotTimes;
      if (times.length < 2) return null;
      const span = (times[times.length - 1] - times[0]) / 1000;
      return span > 0.2 ? (times.length - 1) / span : null;
    }

    /** Muestrea el RTT local dos veces por segundo para poder derivar jitter. */
    sampleNetStats(dt) {
      this.netStats.sampleAccumulator += Number(dt) || 0;
      if (this.netStats.sampleAccumulator < 0.5) return;
      this.netStats.sampleAccumulator = 0;
      const ping = this.role === 'host'
        ? this.signaling?.lastRelayRtt
        : this.transport?.getRtt(this.hostClientId);
      if (!Number.isFinite(ping) || ping <= 0) return;
      const samples = this.netStats.pingSamples;
      samples.push(ping);
      if (samples.length > 24) samples.shift();
    }

    /**
     * Instantánea legible del estado de red para la interfaz.
     * Todos los campos pueden ser null cuando aún no hay medición.
     */
    getNetStats() {
      const samples = this.netStats.pingSamples;
      const ping = this.role === 'host'
        ? (this.signaling?.lastRelayRtt ?? null)
        : (this.transport?.getRtt(this.hostClientId) ?? null);

      let jitter = null;
      if (samples.length >= 2) {
        let total = 0;
        for (let i = 1; i < samples.length; i += 1) total += Math.abs(samples[i] - samples[i - 1]);
        jitter = total / (samples.length - 1);
      }

      const snapshotHz = this.getSnapshotHz();
      const total = this.netStats.received + this.netStats.dropped;
      let correction = null;
      if (this.role === 'client') {
        correction = 0;
        for (const p of this.players.values()) {
          const distance = p.playerKey === this.localPlayerKey
            ? Math.hypot(this.predictor.errorX, this.predictor.errorY)
            : (p.interpolator?.correctionDistance || 0);
          if (distance > correction) correction = distance;
        }
      }
      return {
        role: this.role,
        ping: Number.isFinite(ping) && ping > 0 ? ping : null,
        jitter,
        snapshotHz,
        lossPercent: total > 0 ? (this.netStats.dropped / total) * 100 : null,
        relayRtt: Number.isFinite(this.signaling?.lastRelayRtt) ? this.signaling.lastRelayRtt : null,
        peers: this.transport ? [...this.transport.peers.values()].filter((p) => p.open).length : 0,
        players: this.players.size,
        // Diagnóstico de la capa de suavizado (panel F3).
        simulationHz: this.fixedStep.hz,
        stepsLastFrame: this.fixedStep.steps,
        interpolationMs: this.role === 'client' ? Math.round(this.interpolationDelayMs) : null,
        arrivalJitter: this.netStats.arrivalJitter || null,
        clockDriftMs: this.role === 'client' ? Math.round(this.hostClock.driftMs()) : null,
        correctionDistance: correction,
      };
    }

    turnLimitReached(player) {
      const limit = this.settings?.maxTurnsPerWorld;
      return limit != null && (Number(player?.turnsUsed) || 0) >= limit;
    }

    finishPlayerWithoutPoints(player, reason) {
      if (!player || player.finished) return false;
      player.finished = true;
      player.timedOut = reason === 'world-time' || reason === 'finish-countdown';
      player.finishReason = reason;
      player.finishOrder = 0;
      player.holePoints = 0;
      player.shotInProgress = false;
      if (player.ball) {
        player.ball.vx = 0;
        player.ball.vy = 0;
        player.ball.moving = false;
      }
      this.broadcastReliable({ type: 'session:event', event: 'world:dnf', playerKey: player.playerKey, reason });
      if (reason === 'turn-limit' && (this.settings?.mode || 'turn') === 'turn') this.advanceTurnFrom(player.playerKey);
      return true;
    }

    /** Bola que todavía está resolviendo su tiro: nadie debería cortarla. */
    isBallInPlay(player) {
      return !!(player
        && player.role === 'player'
        && !player.finished
        && player.ball
        && player.ball.moving
        && !player.ball.holed);
    }

    /** ¿Queda alguna bola rodando en el mundo, de quien sea? */
    anyBallRolling() {
      for (const p of this.players.values()) {
        if (p.role !== 'player' || !p.ball) continue;
        if (p.ball.moving && !p.ball.holed) return true;
      }
      return false;
    }

    /**
     * Se acabó el mundo: o el reloj del hoyo, o el contador que arranca cuando
     * alguien emboca.
     *
     * A nadie se le corta la bola en el aire. El golpe ya estaba dado cuando
     * sonó la bocina, y congelarlo a media parábola es lo único que el jugador
     * no puede ni prever ni evitar; además deja la cámara mirando una bola que
     * se para en el vacío. Los que ya estaban parados se retiran ahora mismo,
     * y los que ruedan entran en prórroga hasta detenerse.
     */
    expireCurrentWorld(reason) {
      if (this.matchOver) return;
      this.turnPlayerKey = null;
      this.finishCountdownRemaining = null;
      let rolling = 0;
      for (const player of this.players.values()) {
        if (player.role !== 'player' || player.finished) continue;
        if (this.isBallInPlay(player)) rolling += 1;
        else this.finishPlayerWithoutPoints(player, reason);
      }
      this.graceReason = rolling ? reason : null;
      this.graceRemaining = rolling ? Math.max(0, NG.NET_CONFIG.worldGraceMaxSeconds) : null;
      if (!rolling && !this.transitionTimer) this.transitionTimer = 2.35;
      this.broadcastReliable({ type: 'session:event', event: 'world:expired', reason, rolling });
      this.emit('gameevent', { event: 'world:expired', reason, rolling });
    }

    /**
     * Prórroga tras el cierre. Cada bola se retira en cuanto se para —no tiene
     * por qué esperar a las demás— y el hoyo no avanza hasta que la última lo
     * hace. El tope existe por si alguna se queda dando vueltas en un molino:
     * sin él, una bola en bucle dejaría la sala colgada para siempre.
     */
    tickWorldGrace(dt) {
      this.graceRemaining = Math.max(0, this.graceRemaining - dt);
      const expired = this.graceRemaining <= 0;
      let rolling = 0;
      for (const p of this.players.values()) {
        if (p.role !== 'player' || p.finished) continue;
        if (!expired && this.isBallInPlay(p)) rolling += 1;
        else this.finishPlayerWithoutPoints(p, this.graceReason || 'world-time');
      }
      if (rolling > 0) return;
      this.graceRemaining = null;
      this.graceReason = null;
      if (!this.transitionTimer) this.transitionTimer = 2.35;
    }

    /**
     * Un paso fijo de simulación autoritativa.
     * Se invoca desde el acumulador: con 20 FPS o con 240, cada paso vale
     * exactamente lo mismo, así que la física no depende del rendimiento.
     */
    stepHost(dt) {
      if (this.matchOver) {
        this.game.physics.time = this.worldTime;
        return;
      }
      if (this.mapVote && Date.now() >= this.mapVote.expiresAt) this.closeMapVote('timeout');
      const startTime = this.worldTime;
      if (this.matchStarted) {
        this.elapsed += dt;
        this.holeElapsed += dt;
      }
      const activePlayers = [...this.players.values()].filter((p) => p.role === 'player' && p.ball && !p.finished);
      for (const p of activePlayers) {
        p.prevX = p.ball.x;
        p.prevY = p.ball.y;
        // Un jugador caído conserva su plaza durante toda la ventana de gracia.
        // Su bola termina el tiro que ya estaba en el aire y después se
        // congela: ni desaparece ni se le da por retirado.
        if (!p.connected && !p.ball.moving) continue;
        p.physics.time = startTime;
        p.physics.update(p.ball, this.game.hole, dt);
        if ((p.ball.multiplierSerial || 0) > p.lastMultiplierSerial) {
          p.lastMultiplierSerial = p.ball.multiplierSerial || 0;
          p.multiplierFound = true;
        }
        if ((p.ball.caveSerial || 0) > p.lastCaveSerial) {
          p.lastCaveSerial = p.ball.caveSerial || 0;
          if (p.ball.lastCaveId) p.discoveredCaves.add(p.ball.lastCaveId);
        }
        if (p.ball.crushed) this.resetPlayerBall(p, NG.CONFIG.gameplay.crushPenaltyStroke, 'Aplastado');
        else if (p.ball.inWater) this.resetPlayerAfterEnvironment(p, NG.CONFIG.gameplay.waterPenaltyStroke, 'Agua');
        else if (this.game.isOutOfWorld(p.ball)) this.resetPlayerAfterEnvironment(p, NG.CONFIG.gameplay.outOfBoundsPenaltyStroke, 'Fuera del mapa');
        if (p.ball?.holed && !p.finished) this.finishPlayerHole(p);
        if (p.shotInProgress && p.ball && !p.ball.moving && !p.ball.holed && !p.ball.inWater) {
          p.shotInProgress = false;
          // Con el mundo ya cerrado no hay turno que pasar ni límite que
          // aplicar: de retirar a quien se para se encarga la prórroga.
          if (this.graceRemaining == null) {
            if (this.turnLimitReached(p)) this.finishPlayerWithoutPoints(p, 'turn-limit');
            else if ((this.settings?.mode || 'turn') === 'turn') this.advanceTurnFrom(p.playerKey);
          }
        }
        if (p.ball && !p.ball.moving && !p.ball.inWater && !p.ball.holed) this.clearSabotageAttribution(p.ball);
      }
      this.worldTime = startTime + dt;
      // Reloj de red: nunca se reinicia, ni al cambiar de hoyo ni de mapa.
      // Es la referencia con la que el cliente ordena e interpola snapshots.
      this.netTime += dt;
      this.game.physics.time = this.worldTime;
      if ((this.settings?.mode || 'turn') === 'battle' && this.settings?.collisionsEnabled !== false) this.resolveBallCollisions();

      if (this.matchStarted && !this.matchOver && !this.transitionTimer) {
        if (this.graceRemaining != null) {
          this.tickWorldGrace(dt);
        } else if (this.finishCountdownRemaining != null) {
          this.finishCountdownRemaining = Math.max(0, this.finishCountdownRemaining - dt);
          if (this.finishCountdownRemaining <= 0) this.expireCurrentWorld('finish-countdown');
        } else if (this.settings?.worldTimeSeconds != null && this.holeElapsed >= this.settings.worldTimeSeconds) {
          this.expireCurrentWorld('world-time');
        }
      }

      const stillPlaying = [...this.players.values()].filter((p) => p.role === 'player' && !p.finished);
      if (this.matchStarted && stillPlaying.length === 0 && !this.transitionTimer && !this.matchOver) this.transitionTimer = 2.35;
      if (this.transitionTimer > 0) {
        // No se cambia de mapa con una bola aún rodando: el reloj de
        // transición se congela hasta que la última se para. Con el mismo tope
        // que la prórroga, para no depender de que toda bola acabe parándose.
        if (this.anyBallRolling() && this.transitionHold < NG.NET_CONFIG.worldGraceMaxSeconds) {
          this.transitionHold += dt;
        } else {
          this.transitionTimer -= dt;
          if (this.transitionTimer <= 0) {
            this.transitionHold = 0;
            this.advanceHole();
          }
        }
      }

      this.snapshotAccumulator += dt;
      if (this.snapshotAccumulator >= 1 / NG.NET_CONFIG.snapshotHz) {
        this.snapshotAccumulator = 0;
        this.broadcastSnapshot();
      }
      this.lobbyUpdateAccumulator += dt;
      if (this.lobbyUpdateAccumulator > 4) {
        this.lobbyUpdateAccumulator = 0;
        this.updateDiscoveryLobby(false);
      }
    }

    /**
     * Presentación del host: una vez por frame, no por paso de simulación.
     * Mezcla el estado anterior con el actual usando la fracción de paso
     * sobrante para que el paso fijo no se note en pantallas rápidas.
     */
    presentHost(dt) {
      // La caducidad de las reservas se revisa a 1 Hz: es una decisión de
      // minutos, no hace falta pagarla en cada paso de simulación.
      const now = performance.now();
      if (now - (this.lastPruneAt || 0) > 1000) {
        this.lastPruneAt = now;
        this.pruneDisconnectedPlayers();
      }
      const alpha = this.fixedStep.alpha;
      for (const p of this.players.values()) {
        if (!p.ball) continue;
        const dx = Number(p.ball.x) - Number(p.prevX);
        const dy = Number(p.ball.y) - Number(p.prevY);
        const teleported = !Number.isFinite(dx) || !Number.isFinite(dy) || Math.hypot(dx, dy) > 260;
        if (teleported || !p.ball.moving) {
          p.renderX = p.ball.x;
          p.renderY = p.ball.y;
        } else {
          p.renderX = p.prevX + dx * alpha;
          p.renderY = p.prevY + dy * alpha;
        }
        p.renderVX = Number(p.ball.vx) || 0;
        p.renderVY = Number(p.ball.vy) || 0;
        p.presentationBall = p.ball;
      }
      this.syncGameToLocal(true);
      this.emit('standings', this.getStandings());
    }

    /**
     * Retardo de interpolación adaptativo.
     *
     * Dibujamos el pasado reciente para tener siempre dos muestras que
     * interpolar. Cuánto pasado depende de la red: con jitter alto hay que
     * mirar más atrás o el buffer se vacía y volvemos a extrapolar. Sube
     * rápido (proteger la fluidez es urgente) y baja despacio (recuperar
     * respuesta puede esperar).
     */
    updateInterpolationDelay(dt) {
      const cfg = NG.NET_CONFIG;
      const hz = this.getSnapshotHz() || cfg.snapshotHz;
      const interval = 1000 / Math.max(1, hz);
      const target = clamp(
        interval * 1.6 + this.netStats.arrivalJitter * cfg.jitterSafetyFactor,
        cfg.minInterpolationMs,
        cfg.maxInterpolationMs,
      );
      const rate = target > this.interpolationDelayMs ? 8 : cfg.interpolationAdaptRate;
      const t = 1 - Math.exp(-rate * Math.max(0, dt));
      this.interpolationDelayMs += (target - this.interpolationDelayMs) * t;
    }

    /** Medio RTT en segundos, acotado para que un pico no dispare la predicción. */
    oneWaySeconds() {
      const rtt = Number(this.transport?.getRtt(this.hostClientId));
      if (!Number.isFinite(rtt) || rtt <= 0) return 0.045;
      return clamp(rtt / 2000, 0, 0.35);
    }

    /** ¿Merece la pena predecir la bola local ahora mismo? */
    predictionActive() {
      if (!NG.NET_CONFIG.predictionEnabled || this.matchOver) return false;
      const local = this.players.get(this.localPlayerKey);
      if (!local?.ball || local.role !== 'player' || local.finished) return false;
      return !!(local.shotInProgress || local.ball.moving || this.predictor.active);
    }

    updateClient(dt) {
      const now = performance.now();
      const hostNow = this.hostClock.advance(now);
      this.updateInterpolationDelay(dt);
      const renderTime = hostNow - this.interpolationDelayMs / 1000;
      this.renderTime = renderTime;

      // Los obstáculos dinámicos se dibujan en el MISMO instante que las
      // bolas. Si el mundo fuera por delante, un rebote contra un muro móvil
      // se vería contra el aire.
      if (this.worldBase) {
        const world = this.worldBase.world + (renderTime - this.worldBase.net);
        if (Number.isFinite(world)) this.worldTime = Math.max(0, world);
      } else if (Number.isFinite(dt) && dt > 0 && !this.matchOver) {
        this.worldTime += Math.min(dt, 0.1);
      }
      this.game.physics.time = this.worldTime;

      const context = { physics: this.viewPhysics, hole: this.game.hole };
      for (const p of this.players.values()) {
        if (!p.ball) continue;
        if (!p.interpolator) p.interpolator = new NG.EntityInterpolator();
        const view = p.interpolator.sample(renderTime, dt, context);
        if (!view) {
          if (!Number.isFinite(p.renderX)) { p.renderX = p.ball.x; p.renderY = p.ball.y; }
          p.presentationBall = p.ball;
          continue;
        }
        p.renderX = view.x;
        p.renderY = view.y;
        p.renderVX = view.vx;
        p.renderVY = view.vy;
        p.presentationBall = view.ball || p.ball;
      }

      // La bola propia no espera al host: se simula en local con la misma
      // física y se reconcilia con cada snapshot. Es lo que hace que un tiro
      // con 200 ms de ping salga igual de inmediato que uno con 20 ms.
      // Mientras la partida dura, la bola local SIEMPRE la dibuja el
      // predictor: alternar entre predictor e interpolación al detenerse
      // provocaría un salto hacia atrás del tamaño del retardo de interpolación.
      const local = this.players.get(this.localPlayerKey);
      this.expireUnconfirmedShot(local, now);
      if (local?.ball && NG.NET_CONFIG.predictionEnabled && this.predictor.ball) {
        this.predictor.advanceTo(hostNow + this.oneWaySeconds(), this.game.hole);
        this.predictor.decay(dt);
        const view = this.predictor.view();
        if (view) {
          local.renderX = view.x;
          local.renderY = view.y;
          local.renderVX = view.vx;
          local.renderVY = view.vy;
          local.presentationBall = view.ball;
        }
      }

      this.syncGameToLocal(true);
      this.emit('standings', this.getStandings());
      this.watchLink();
    }

    /**
     * Si el host descarta un tiro (turno perdido por milímetros, límite de
     * golpes…) nunca llega confirmación. Sin este corte el jugador quedaría
     * bloqueado sin poder volver a tirar y la predicción repetiría un tiro
     * fantasma para siempre.
     */
    expireUnconfirmedShot(player, now) {
      if (!player?.shotInProgress || !player.shotSentAt) return;
      const rtt = Number(this.transport?.getRtt(this.hostClientId)) || 120;
      if (now - player.shotSentAt < Math.max(1500, rtt * 3)) return;
      if (player.ball?.moving) return;
      player.shotInProgress = false;
      player.shotSentAt = 0;
      this.predictor.pending = null;
      this.predictor.reset(player.ball, this.netTime);
      this.emit('gameevent', { event: 'shot-unconfirmed', playerKey: player.playerKey });
    }

    /**
     * Vigila el enlace con el host. Sin snapshots durante `linkTimeoutMs`
     * damos el canal por caído y abrimos la ventana de reconexión.
     */
    watchLink() {
      if (this.role !== 'client' || this.state === 'joining' || this.state === 'syncing' || this.state === 'leaving') return;
      if (this.reconnect.active || !this.lastSnapshotAt) return;
      const silence = performance.now() - this.lastSnapshotAt;
      if (silence > NG.NET_CONFIG.linkTimeoutMs) this.beginReconnect('sin-snapshots');
      else if (silence > NG.NET_CONFIG.linkTimeoutMs * 0.6) {
        this.emit('connection', { state: 'degraded', text: 'Sin snapshots recientes del host' });
      }
    }

    /* ── Reconexión del cliente ───────────────────────────────────────────
     * Perder el canal P2P no es perder la partida: el host guarda la plaza
     * durante `playerGraceMs`. Durante esa ventana reintentamos en bucle
     * `lobby:resume` contra el relay; el relay avisa al host, el host abre un
     * canal nuevo y envía `session:init`, que resincroniza el mundo entero.
     * ------------------------------------------------------------------- */

    getReconnectStatus() {
      return {
        active: !!this.reconnect.active,
        busy: !!this.reconnect.busy,
        attempts: this.reconnect.attempts || 0,
        remainingMs: this.reconnect.active ? Math.max(0, this.reconnect.until - Date.now()) : 0,
        totalMs: NG.NET_CONFIG.reconnectWindowMs,
        reason: this.reconnect.reason || '',
        lastError: this.reconnect.lastError || '',
        lobbyName: this.lobby?.name || '',
      };
    }

    beginReconnect(reason) {
      if (this.role !== 'client') return;
      if (['leaving', 'unloading', 'idle'].includes(this.state)) return;
      if (!this.reconnect.active) {
        this.reconnect = {
          active: true,
          until: Date.now() + NG.NET_CONFIG.reconnectWindowMs,
          attempts: 0,
          reason: reason || '',
          busy: false,
          lastError: '',
        };
        this.state = 'reconnecting';
        this.emit('connection', { state: 'reconnecting', text: 'Conexión con el host interrumpida · recuperando…' });
        this.emit('reconnect', this.getReconnectStatus());
      }
      this.scheduleReconnectAttempt(150);
    }

    scheduleReconnectAttempt(delayMs) {
      if (!this.reconnect.active) return;
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = window.setTimeout(() => this.attemptReconnect(), Math.max(0, delayMs));
    }

    async attemptReconnect() {
      if (!this.reconnect.active || this.reconnect.busy) return;
      if (Date.now() >= this.reconnect.until) {
        this.failReconnect('Se agotó el tiempo de reconexión. El host ya liberó tu plaza.');
        return;
      }
      this.reconnect.busy = true;
      this.reconnect.attempts += 1;
      this.emit('reconnect', this.getReconnectStatus());
      try {
        if (!this.relay.connected) {
          // El propio RelayClient reintenta con backoff. Si ya está en ello,
          // esperamos al siguiente ciclo en vez de abrir un socket paralelo.
          if (this.relay.connecting) throw new Error('Conectando con el relay…');
          await this.relay.connect(this.relay.url || this.profile.getRelayUrl(), {
            autoReconnect: true,
            timeoutMs: NG.NET_CONFIG.requestTimeoutMs,
          });
          this.signaling = this.relay;
        }
        if (!this.lobby?.id || !this.resumeToken) throw new Error('No hay reserva guardada de esta partida.');
        const resumed = await this.signaling.request('lobby:resume', {
          lobbyId: this.lobby.id,
          resumeToken: this.resumeToken,
          playerKey: this.localPlayerKey,
        });
        this.lobby = resumed.lobby || this.lobby;
        this.resumeToken = resumed.resumeToken || this.resumeToken;
        this.hostClientId = resumed.hostClientId || this.hostClientId;
        if (this.transport) this.transport.becomeClient(this.lobby.id, this.hostClientId);
        else this.setupTransport('client', this.lobby.id, this.hostClientId);
        this.profile.saveLastSession({
          lobbyId: this.lobby.id,
          lobbyName: this.lobby.name,
          resumeToken: this.resumeToken,
          scope: 'public',
          relayUrl: this.relay.url,
        });
        this.reconnect.lastError = '';
        // El éxito real no es esta respuesta: es `session:init` llegando por el
        // canal P2P nuevo, que es quien cierra la ventana (endReconnect).
      } catch (error) {
        this.reconnect.lastError = error?.message || String(error);
      } finally {
        this.reconnect.busy = false;
        if (this.reconnect.active) {
          this.emit('reconnect', this.getReconnectStatus());
          this.scheduleReconnectAttempt(NG.NET_CONFIG.reconnectRetryMs);
        }
      }
    }

    endReconnect() {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = 0;
      if (!this.reconnect.active) return;
      this.reconnect = { active: false, until: 0, attempts: 0, reason: '', busy: false, lastError: '' };
      this.emit('reconnect', this.getReconnectStatus());
      this.emit('connection', { state: 'connected', text: 'Enlace recuperado · partida resincronizada' });
    }

    /** Cierre de la ventana sin éxito: el jugador vuelve al menú. */
    failReconnect(text) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = 0;
      const wasActive = this.reconnect.active;
      this.reconnect = { active: false, until: 0, attempts: 0, reason: '', busy: false, lastError: text || '' };
      this.emit('reconnect', this.getReconnectStatus());
      if (wasActive) this.emit('closed', { reason: 'reconnect-failed', text: text || 'No fue posible recuperar la partida.' });
    }

    /** El usuario decide abandonar durante la ventana de reconexión. */
    cancelReconnect() {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = 0;
      this.reconnect = { active: false, until: 0, attempts: 0, reason: '', busy: false, lastError: '' };
      this.emit('reconnect', this.getReconnectStatus());
    }


    clearSabotageAttribution(ball) {
      if (!ball) return;
      ball.sabotageByPlayerKey = null;
      ball.sabotageTouchAt = 0;
    }

    sabotageContext(player) {
      const attackerKey = player?.ball?.sabotageByPlayerKey;
      if (!attackerKey || attackerKey === player.playerKey) return null;
      const attacker = this.players.get(attackerKey);
      return {
        sabotageBy: attackerKey,
        sabotageByUsername: attacker?.username || 'Otro jugador',
        sabotageVictimUsername: player.username,
      };
    }

    resetPlayerAfterEnvironment(player, penalty, reason) {
      const sabotage = this.sabotageContext(player);
      this.resetPlayerBall(player, penalty, reason, sabotage ? 'tee' : 'safe', sabotage);
    }

    resetPlayerBall(player, penalty, reason, target = 'safe', context = null) {
      if (!player?.ball) return;
      player.strokes += penalty;
      const tee = { x: this.game.hole.tee.x, y: this.game.hole.tee.y, surfaceId: this.game.hole.tee.surfaceId };
      const safe = target === 'tee'
        ? tee
        : target === 'shot' ? (player.ball.shotOrigin || player.ball.lastSafe || tee) : (player.ball.lastSafe || tee);
      const fresh = this.makeBall();
      fresh.x = Number.isFinite(safe.x) ? safe.x : this.game.hole.tee.x;
      fresh.y = Number.isFinite(safe.y) ? safe.y : this.game.hole.tee.y;
      fresh.lastSafe = { x: fresh.x, y: fresh.y, surfaceId: safe.surfaceId || this.game.hole.tee.surfaceId };
      fresh.shotOrigin = { ...fresh.lastSafe };
      fresh.lastSurfaceId = fresh.lastSafe.surfaceId;
      player.ball = fresh;
      player.physics.time = this.worldTime;
      player.shotInProgress = false;
      if (this.graceRemaining == null) {
        if (this.turnLimitReached(player)) this.finishPlayerWithoutPoints(player, 'turn-limit');
        else if ((this.settings?.mode || 'turn') === 'turn') this.advanceTurnFrom(player.playerKey);
      }
      const event = {
        type: 'session:event', event: 'penalty', playerKey: player.playerKey, reason, penalty,
        resetTarget: target, ...(context || {}),
      };
      this.broadcastReliable(event);
      this.emit('gameevent', event);
    }

    finishPlayerHole(player) {
      player.finished = true;
      player.timedOut = false;
      player.finishReason = 'holed';
      player.shotInProgress = false;
      player.finishOrder = ++this.finishOrder;
      const performance = clamp(this.game.hole.par - player.strokes + 2, 0, 6);
      const base = Math.round(650 + this.game.hole.difficulty * 700 + performance * 280);
      const raceBonus = (this.settings?.mode || 'turn') === 'battle' ? Math.max(0, 620 - (player.finishOrder - 1) * 110) : 0;
      const multiplier = player.multiplierFound ? NG.CONFIG.gameplay.scoreMultiplier : 1;
      player.holePoints = (base + raceBonus) * multiplier;
      player.points += player.holePoints;
      if ((this.settings?.mode || 'turn') === 'turn') this.advanceTurnFrom(player.playerKey);
      this.broadcastReliable({
        type: 'session:event', event: 'holed', playerKey: player.playerKey, finishOrder: player.finishOrder,
        points: player.holePoints, totalPoints: player.points,
      });
      if (this.settings?.maxPoints != null && player.points >= this.settings.maxPoints) {
        this.finishMatch(player.playerKey);
        return;
      }
      const othersPlaying = [...this.players.values()].some((candidate) => candidate.role === 'player' && !candidate.finished);
      // Durante la prórroga el mundo ya está cerrado: embocar en el último
      // segundo cuenta, pero no vuelve a abrir el contador de cierre.
      if (othersPlaying && this.graceRemaining == null && this.settings?.finishCountdownSeconds != null && this.finishCountdownRemaining == null) {
        this.finishCountdownRemaining = this.settings.finishCountdownSeconds;
        this.broadcastReliable({ type: 'session:event', event: 'finish-countdown', seconds: this.finishCountdownRemaining });
        this.emit('gameevent', { event: 'finish-countdown', seconds: this.finishCountdownRemaining });
      }
    }

    finishMatch(winnerPlayerKey) {
      if (this.matchOver) return;
      this.matchOver = true;
      this.winnerPlayerKey = winnerPlayerKey;
      this.finishCountdownRemaining = null;
      this.graceRemaining = null;
      this.graceReason = null;
      this.transitionTimer = 0;
      this.transitionHold = 0;
      this.broadcastReliable({ type: 'match:over', winnerPlayerKey });
      this.updateDiscoveryLobby(true);
      this.emit('matchover', { winnerPlayerKey, standings: this.getStandings() });
    }

    normalizeRemoteVote(vote) {
      if (!vote?.id) return null;
      const remainingMs = Math.max(0, Number(vote.remainingMs) || 0);
      return {
        id: String(vote.id),
        initiatorPlayerKey: vote.initiatorPlayerKey || null,
        electorate: Array.isArray(vote.electorate) ? [...vote.electorate] : [],
        yes: Array.isArray(vote.yes) ? [...vote.yes] : [],
        expiresAt: Date.now() + remainingMs,
      };
    }

    serializeMapVote() {
      if (!this.mapVote) return null;
      return {
        id: this.mapVote.id,
        initiatorPlayerKey: this.mapVote.initiatorPlayerKey,
        electorate: Array.isArray(this.mapVote.electorate) ? [...this.mapVote.electorate] : [...this.mapVote.electorate],
        yes: Array.isArray(this.mapVote.yes) ? [...this.mapVote.yes] : [...this.mapVote.yes],
        remainingMs: Math.max(0, Number(this.mapVote.expiresAt) - Date.now()),
      };
    }

    getMapVoteStatus() {
      const vote = this.serializeMapVote();
      const now = Date.now();
      return {
        active: !!vote,
        vote,
        required: vote?.electorate?.length || 0,
        yes: vote?.yes?.length || 0,
        localVote: vote ? (vote.yes.includes(this.localPlayerKey) ? 'yes' : null) : null,
        cooldownRemainingMs: Math.max(0, this.mapChangeCooldownUntil - now),
        retryRemainingMs: 0,
      };
    }

    requestMapVote() {
      if (this.role === 'offline') return false;
      const local = this.players.get(this.localPlayerKey);
      if (!local || !local.connected) return false;
      if (this.role === 'host') return this.startMapVote(local.playerKey);
      return !!this.transport?.sendReliable(this.hostClientId, { type: 'map:vote:start' });
    }

    castLocalMapVote(choice) {
      if (!this.mapVote) return false;
      const vote = choice === 'yes' ? 'yes' : 'no';
      if (this.role === 'host') return this.castMapVote(this.localPlayerKey, vote);
      return !!this.transport?.sendReliable(this.hostClientId, { type: 'map:vote:cast', choice: vote });
    }

    startMapVote(playerKey) {
      if (this.role !== 'host' || this.mapVote) return false;
      const now = Date.now();
      if (now < this.mapChangeCooldownUntil) return false;
      const electorate = [...this.players.values()]
        .filter((p) => p.connected)
        .map((p) => p.playerKey);
      if (!electorate.includes(playerKey) || !electorate.length) return false;
      this.mapVote = {
        id: `map-${now.toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
        initiatorPlayerKey: playerKey,
        electorate: new Set(electorate),
        yes: new Set([playerKey]),
        expiresAt: now + NG.NET_CONFIG.mapVoteTimeoutMs,
      };
      this.broadcastMapVote();
      if (this.mapVote.yes.size === this.mapVote.electorate.size) this.passMapVote();
      return true;
    }

    castMapVote(playerKey, choice) {
      if (this.role !== 'host' || !this.mapVote || !this.mapVote.electorate.has(playerKey)) return false;
      if (choice === 'no') {
        this.closeMapVote('no');
        return true;
      }
      this.mapVote.yes.add(playerKey);
      this.broadcastMapVote();
      if (this.mapVote && this.mapVote.yes.size >= this.mapVote.electorate.size) this.passMapVote();
      return true;
    }

    broadcastMapVote() {
      const vote = this.serializeMapVote();
      this.broadcastReliable({ type: 'map:vote:update', vote });
      this.emit('mapvote', this.getMapVoteStatus());
    }

    closeMapVote(reason) {
      if (!this.mapVote) return;
      this.mapVote = null;
      this.broadcastReliable({ type: 'map:vote:closed', reason, retryRemainingMs: 0 });
      this.emit('mapvote', this.getMapVoteStatus());
    }

    passMapVote() {
      if (!this.mapVote) return;
      this.mapVote = null;
      this.changeMapFromVote();
      this.broadcastReliable({ type: 'map:vote:closed', reason: 'passed', retryRemainingMs: 0 });
      this.emit('mapvote', this.getMapVoteStatus());
    }

    changeMapFromVote() {
      if (this.role !== 'host') return false;
      this.matchOver = false;
      this.winnerPlayerKey = null;
      this.courseRound += 1;
      const seed = `${this.lobby?.id || 'match'}-vote-${this.courseRound.toString(36)}-${Date.now().toString(36).slice(-6)}`;
      this.game.startNewCourse(seed, this.courseOptions());
      this.game.loadHole(0);
      this.worldTime = 0;
      this.holeElapsed = 0;
      this.finishCountdownRemaining = null;
      this.graceRemaining = null;
      this.graceReason = null;
      this.finishOrder = 0;
      this.transitionTimer = 0;
      this.transitionHold = 0;
      this.mapChangeCooldownUntil = Date.now() + NG.NET_CONFIG.mapVoteCooldownMs;
      for (const p of this.players.values()) {
        if (p.role === 'spectator' && p.connected) p.role = 'player';
        if (p.role !== 'player') continue;
        p.ball = this.makeBall();
        p.physics = new NG.PhysicsEngine();
        p.strokes = 0;
        p.turnsUsed = 0;
        p.finished = false;
        p.timedOut = false;
        p.finishReason = null;
        p.finishOrder = 0;
        p.holePoints = 0;
        p.shotInProgress = false;
        p.multiplierFound = false;
        p.lastMultiplierSerial = 0;
        p.lastCaveSerial = 0;
        p.discoveredCaves.clear();
        p.renderX = p.ball.x;
        p.renderY = p.ball.y;
        p.renderVX = 0;
        p.renderVY = 0;
        p.netReceivedAt = performance.now();
        p.prevX = p.ball.x;
        p.prevY = p.ball.y;
        p.presentationBall = p.ball;
        p.interpolator?.reset(p.ball, this.netTime);
      }
      this.turnPlayerKey = [...this.players.values()].find((p) => p.role === 'player' && p.connected)?.playerKey || null;
      this.broadcastReliable({ type: 'session:event', event: 'map-changed', seed: this.game.seed, holeIndex: 0, cooldownRemainingMs: NG.NET_CONFIG.mapVoteCooldownMs });
      this.broadcastRoster();
      this.broadcastSnapshot();
      this.updateDiscoveryLobby(true);
      this.emit('gameevent', { event: 'map-changed' });
      return true;
    }

    advanceTurnFrom(playerKey) {
      const eligible = [...this.players.values()].filter((p) => p.role === 'player' && p.connected && !p.finished && p.ball);
      if (!eligible.length) { this.turnPlayerKey = null; return; }
      const all = [...this.players.values()];
      const start = Math.max(0, all.findIndex((p) => p.playerKey === playerKey));
      for (let offset = 1; offset <= all.length; offset += 1) {
        const p = all[(start + offset) % all.length];
        if (p.role === 'player' && p.connected && !p.finished && p.ball) { this.turnPlayerKey = p.playerKey; return; }
      }
      this.turnPlayerKey = eligible[0].playerKey;
    }

    advanceHole() {
      if (this.matchOver) return;
      this.finishOrder = 0;
      this.transitionTimer = 0;
      this.transitionHold = 0;
      let next = this.game.holeIndex + 1;
      if (next >= this.game.holes.length) {
        this.courseRound += 1;
        const seed = `${this.lobby?.id || 'match'}-${this.courseRound.toString(36)}-${Date.now().toString(36).slice(-5)}`;
        this.game.startNewCourse(seed, this.courseOptions());
        next = 0;
      } else this.game.loadHole(next);
      this.worldTime = 0;
      this.holeElapsed = 0;
      this.finishCountdownRemaining = null;
      this.graceRemaining = null;
      this.graceReason = null;
      for (const p of this.players.values()) {
        if (p.role === 'spectator') p.role = 'player';
        p.ball = this.makeBall();
        p.physics = new NG.PhysicsEngine();
        p.strokes = 0;
        p.turnsUsed = 0;
        p.finished = false;
        p.timedOut = false;
        p.finishReason = null;
        p.finishOrder = 0;
        p.holePoints = 0;
        p.shotInProgress = false;
        p.multiplierFound = false;
        p.lastMultiplierSerial = 0;
        p.lastCaveSerial = 0;
        p.discoveredCaves.clear();
        p.renderX = p.ball.x;
        p.renderY = p.ball.y;
        p.renderVX = 0;
        p.renderVY = 0;
        p.netReceivedAt = performance.now();
        p.prevX = p.ball.x;
        p.prevY = p.ball.y;
        p.presentationBall = p.ball;
        p.interpolator?.reset(p.ball, this.netTime);
      }
      this.turnPlayerKey = [...this.players.values()].find((p) => p.role === 'player' && p.connected)?.playerKey || null;
      this.broadcastReliable({ type: 'session:event', event: 'next-hole', seed: this.game.seed, holeIndex: this.game.holeIndex });
      this.broadcastRoster();
      this.broadcastSnapshot();
      this.updateDiscoveryLobby(true);
    }

    markSabotageContact(victim, attacker) {
      if (!victim?.ball || !attacker?.playerKey || victim.playerKey === attacker.playerKey) return;
      victim.ball.sabotageByPlayerKey = attacker.playerKey;
      victim.ball.sabotageTouchAt = this.worldTime;
    }

    resolveBallCollisions() {
      const list = [...this.players.values()].filter((p) => p.role === 'player' && p.ball && !p.finished && !p.ball.holed);
      const r = NG.CONFIG.ball.radius;
      const minDist = r * 2;
      for (let i = 0; i < list.length; i += 1) {
        for (let j = i + 1; j < list.length; j += 1) {
          const playerA = list[i], playerB = list[j];
          const a = playerA.ball, b = playerB.ball;
          if (!a.moving && !b.moving) continue;
          const dx = b.x - a.x, dy = b.y - a.y;
          const d2 = dx * dx + dy * dy;
          if (d2 >= minDist * minDist) continue;
          let d = Math.sqrt(Math.max(0.0001, d2));
          let nx = dx / d, ny = dy / d;
          if (!Number.isFinite(nx)) { nx = 1; ny = 0; d = 0.001; }
          const overlap = minDist - d;
          a.x -= nx * overlap * 0.5; a.y -= ny * overlap * 0.5;
          b.x += nx * overlap * 0.5; b.y += ny * overlap * 0.5;
          const speedA = Math.hypot(Number(a.vx) || 0, Number(a.vy) || 0);
          const speedB = Math.hypot(Number(b.vx) || 0, Number(b.vy) || 0);
          const restGuardSpeed = Math.max(28, NG.CONFIG.ball.settleSpeed * 1.4);
          if (Math.max(speedA, speedB) <= restGuardSpeed) {
            if (typeof playerA.physics?.sleepBall === 'function') playerA.physics.sleepBall(a, false);
            else { a.vx = 0; a.vy = 0; a.moving = false; }
            if (typeof playerB.physics?.sleepBall === 'function') playerB.physics.sleepBall(b, false);
            else { b.vx = 0; b.vy = 0; b.moving = false; }
            this.clearSabotageAttribution(a);
            this.clearSabotageAttribution(b);
            continue;
          }
          const aTowardB = Math.max(0, (Number(a.vx) || 0) * nx + (Number(a.vy) || 0) * ny);
          const bTowardA = Math.max(0, -((Number(b.vx) || 0) * nx + (Number(b.vy) || 0) * ny));
          const rel = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
          if (rel < 0) {
            const impulse = -(1 + 0.84) * rel * 0.5;
            a.vx -= impulse * nx; a.vy -= impulse * ny;
            b.vx += impulse * nx; b.vy += impulse * ny;
            playerA.physics?.resetMotionGuard?.(a);
            playerB.physics?.resetMotionGuard?.(b);
            a.moving = true; b.moving = true;
            const meaningfulContact = Math.max(32, NG.CONFIG.ball.settleSpeed * 1.35);
            if (impulse >= meaningfulContact * 0.3) {
              if (aTowardB >= meaningfulContact) this.markSabotageContact(playerB, playerA);
              if (bTowardA >= meaningfulContact) this.markSabotageContact(playerA, playerB);
            }
          }
        }
      }
    }

    broadcastReliable(message) { if (this.role === 'host') this.transport.broadcastReliable(message); }

    broadcastRoster() {
      if (this.role !== 'host') return;
      this.transport.broadcastReliable({ type: 'session:roster', players: this.serializePlayers(true) });
      this.emit('standings', this.getStandings());
    }

    broadcastSnapshot() {
      if (this.role !== 'host') return;
      this.trackSnapshot();
      this.transport.broadcastState({
        type: 'state:snapshot', seq: ++this.snapshotSeq, seed: this.game.seed, holeIndex: this.game.holeIndex,
        netTime: this.netTime,
        worldTime: this.worldTime, elapsed: this.elapsed, holeElapsed: this.holeElapsed,
        finishCountdownRemaining: this.finishCountdownRemaining, graceRemaining: this.graceRemaining,
        matchStarted: this.matchStarted,
        matchOver: this.matchOver, winnerPlayerKey: this.winnerPlayerKey, turnPlayerKey: this.turnPlayerKey,
        mapVote: this.serializeMapVote(), worldState: this.serializeWorldState(),
        mapChangeCooldownRemainingMs: Math.max(0, this.mapChangeCooldownUntil - Date.now()),
        players: this.serializePlayers(true),
      });
    }

    async updateDiscoveryLobby(force) {
      if (this.role !== 'host' || !this.signaling?.connected || !this.lobby) return;
      if (!force && this.state === 'leaving') return;
      const currentPlayers = [...this.players.values()].filter((p) => p.connected).length;
      try {
        const updated = await this.signaling.request('lobby:update', {
          lobbyId: this.lobby.id,
          currentPlayers,
          started: this.matchStarted,
          status: this.matchOver ? 'finished' : (this.matchStarted ? 'started' : 'waiting'),
          holeIndex: this.game.holeIndex,
          worldArchetype: this.game.hole?.archetype,
          worldLabel: this.game.hole?.archetypeLabel,
          difficultyLabel: this.game.hole?.difficultyLabel,
          mapSize: this.game.hole?.mapSize,
          connectedClientIds: [...this.players.values()].filter((p) => p.connected && p.clientId).map((p) => p.clientId),
        }, 3500);
        if (updated?.lobby) this.lobby = updated.lobby;
      } catch (_) { /* una caída de discovery no debe detener el gameplay P2P */ }
    }

    syncGameToLocal(useRender = false) {
      if (this.role === 'offline') return;
      this.applyLocalWorldPresentation();
      let player = this.players.get(this.localPlayerKey);
      if (!player || player.role === 'spectator' || !player.ball) {
        // Sin bola propia se toma prestada la de alguien: la que estás
        // mirando si has elegido, y si no la del líder.
        player = this.getSpectateTarget()
          || [...this.players.values()].filter((p) => p.ball && p.role === 'player').sort((a, b) => b.points - a.points)[0]
          || null;
      }
      if (!player?.ball) return;
      if (this.role === 'host') {
        // El host es la autoridad: el juego trabaja sobre la bola viva (los
        // pulsos de acelerador y gravedad se apagan mutándola). La versión
        // interpolada va aparte, solo para dibujar.
        this.game.ball = player.ball;
        this.game.renderBall = useRender ? this.presentationOf(player) : player.ball;
      } else if (useRender) {
        this.game.ball = this.presentationOf(player);
        this.game.renderBall = this.game.ball;
      } else {
        this.game.ball = player.ball;
        this.game.renderBall = player.ball;
      }
      const local = this.players.get(this.localPlayerKey);
      this.game.strokes = local?.strokes || 0;
      this.game.arcadePoints = local?.points || 0;
    }

    /**
     * Bola tal y como debe verse este frame.
     *
     * Los flags y serials vienen de la bola de presentación (la muestra ya
     * alcanzada por el reloj de render o la predicción local), de modo que el
     * impacto, el acelerador o el portal se ven exactamente cuando la bola
     * llega allí. Las posiciones vienen del suavizado.
     */
    presentationOf(player) {
      if (!player?.ball) return null;
      if (this.role === 'host') {
        return { ...player.ball, x: player.renderX, y: player.renderY };
      }
      const source = player.presentationBall || player.ball;
      return {
        ...player.ball,
        ...source,
        x: player.renderX,
        y: player.renderY,
        vx: player.renderVX,
        vy: player.renderVY,
      };
    }

    getRenderBalls() {
      if (this.role === 'offline') return this.game.ball ? [{ playerKey: 'offline', username: '', color: '#f7fbff', ball: this.game.ball, local: true, turn: false, battleLocal: false }] : [];
      const mode = this.settings?.mode || this.lobby?.mode || 'turn';
      const spectatedKey = this.getSpectateTarget()?.playerKey || null;
      return [...this.players.values()].filter((p) => p.ball && p.role === 'player').map((p) => {
        const local = p.playerKey === this.localPlayerKey;
        return {
          playerKey: p.playerKey,
          username: p.username,
          color: NG.NET_CONFIG.colors[p.colorIndex % NG.NET_CONFIG.colors.length],
          local,
          turn: this.turnPlayerKey === p.playerKey,
          // Marca de presentación local: la bola que estás mirando con la
          // cámara libre lleva anillo. No viaja por red ni toca autoridad.
          spectated: !!spectatedKey && spectatedKey === p.playerKey && !local,
          // En Battle Royale cada navegador destaca exclusivamente SU propia bola.
          // Es una marca de presentación local; no se replica ni altera autoridad/snapshots.
          battleLocal: mode === 'battle' && local,
          ball: this.presentationOf(p),
        };
      });
    }

    /** Jugador que enfoca la cámara cuando nadie ha elegido a quién mirar. */
    autoCameraPlayer() {
      const mode = this.settings?.mode || this.lobby?.mode || 'turn';
      let p = null;
      if (mode === 'turn' && this.turnPlayerKey) p = this.players.get(this.turnPlayerKey) || null;
      if (!p?.ball) p = this.players.get(this.localPlayerKey) || null;
      if (!p?.ball) p = [...this.players.values()].find((candidate) => candidate.role === 'player' && candidate.ball) || null;
      return p?.ball ? p : null;
    }

    /**
     * A quién puede apuntar la cámara quien ya ha terminado.
     *
     * Primero los que siguen jugando —son exactamente aquellos a los que se
     * está esperando— y al final la bola propia, para poder volver a la vista
     * de siempre sin tener que dar la vuelta entera a la lista.
     */
    getSpectateOptions() {
      if (this.role === 'offline') return [];
      const options = [];
      for (const p of this.players.values()) {
        if (p.role !== 'player' || !p.ball || p.finished || !p.connected) continue;
        if (p.playerKey === this.localPlayerKey) continue;
        options.push(p);
      }
      const local = this.players.get(this.localPlayerKey);
      if (local?.ball && local.role === 'player') options.push(local);
      return options;
    }

    /**
     * Solo se abre la cámara libre a quien ya no tiene nada que jugar en este
     * hoyo: el que embocó, el que agotó lanzamientos o tiempo, y el espectador
     * que entró con la partida empezada. Mientras te toca jugar, la cámara
     * sigue siendo la de siempre.
     */
    canSpectate() {
      if (this.role === 'offline' || this.matchOver) return false;
      const local = this.players.get(this.localPlayerKey);
      if (!local) return false;
      if (local.role === 'player' && !local.finished) return false;
      return this.getSpectateOptions().some((p) => p.playerKey !== this.localPlayerKey);
    }

    /** Jugador elegido a mano, o null si la cámara sigue en automático. */
    getSpectateTarget() {
      if (!this.canSpectate()) {
        // Al volver a jugar (hoyo nuevo, mapa nuevo) la elección se suelta:
        // el siguiente hoyo debe empezar con la cámara en tu propia bola.
        this.spectateKey = null;
        return null;
      }
      const options = this.getSpectateOptions();
      if (!this.spectateKey) {
        // Sin elección todavía. En POR TURNOS el automático ya enfoca a quien
        // está jugando, así que no hay nada que corregir; en Battle Royale
        // enfocaría tu propia bola ya embocada, y ahí la cámara se pasa sola
        // al primero que siga en juego en vez de mirar a un hoyo vacío.
        const auto = this.autoCameraPlayer();
        if (auto && auto.playerKey !== this.localPlayerKey) return null;
        return options.find((p) => p.playerKey !== this.localPlayerKey) || null;
      }
      const current = options.find((p) => p.playerKey === this.spectateKey);
      if (current) return current;
      // El jugador al que mirabas ha embocado o se ha ido: se salta al
      // siguiente que siga en juego en vez de devolver la cámara de golpe.
      const next = options.find((p) => p.playerKey !== this.localPlayerKey) || null;
      this.spectateKey = next?.playerKey || null;
      return next;
    }

    describeSpectatePlayer(player) {
      if (!player) return null;
      return {
        playerKey: player.playerKey,
        username: player.username,
        color: NG.NET_CONFIG.colors[player.colorIndex % NG.NET_CONFIG.colors.length],
        local: player.playerKey === this.localPlayerKey,
      };
    }

    /** Avanza (+1) o retrocede (-1) por la lista de jugadores observables. */
    cycleSpectate(direction = 1) {
      if (!this.canSpectate()) return null;
      const options = this.getSpectateOptions();
      if (!options.length) return null;
      const step = direction < 0 ? -1 : 1;
      const currentKey = (this.getSpectateTarget() || this.autoCameraPlayer())?.playerKey || null;
      const index = options.findIndex((p) => p.playerKey === currentKey);
      const nextIndex = index < 0
        ? (step > 0 ? 0 : options.length - 1)
        : (index + step + options.length) % options.length;
      this.spectateKey = options[nextIndex].playerKey;
      return this.describeSpectatePlayer(options[nextIndex]);
    }

    setSpectateTarget(playerKey) {
      if (!this.canSpectate()) return null;
      const target = this.getSpectateOptions().find((p) => p.playerKey === playerKey);
      if (!target) return null;
      this.spectateKey = target.playerKey;
      return this.describeSpectatePlayer(target);
    }

    /** Todo lo que la interfaz necesita saber de la cámara libre. */
    getSpectateStatus() {
      const available = this.canSpectate();
      if (!available) {
        this.getSpectateTarget();
        return { available: false, manual: false, count: 0, index: -1, options: [], following: null };
      }
      const options = this.getSpectateOptions();
      const followed = this.getSpectateTarget() || this.autoCameraPlayer();
      return {
        available: true,
        manual: !!this.spectateKey,
        count: options.length,
        index: followed ? options.findIndex((p) => p.playerKey === followed.playerKey) : -1,
        options: options.map((p) => this.describeSpectatePlayer(p)),
        following: this.describeSpectatePlayer(followed),
      };
    }

    getCameraBall() {
      if (this.role === 'offline') return this.game.ball;
      const p = this.getSpectateTarget() || this.autoCameraPlayer();
      if (!p?.ball) return this.game.ball;
      return this.presentationOf(p) || p.ball;
    }

    isCameraFollowingLocal() {
      if (this.role === 'offline') return true;
      const spectated = this.getSpectateTarget();
      if (spectated) return spectated.playerKey === this.localPlayerKey;
      const mode = this.settings?.mode || this.lobby?.mode || 'turn';
      if (mode === 'battle') return true;
      return !this.turnPlayerKey || this.turnPlayerKey === this.localPlayerKey;
    }

    /**
     * Avance del jugador hacia el hoyo, de 0 (salida) a 1 (embocado).
     * Solo se usa como dato de presentación en el marcador.
     */
    holeProgress(player) {
      const hole = this.game?.hole;
      if (!hole?.cup || !hole?.tee || !player?.ball) return null;
      if (player.finished || player.ball.holed) return 1;
      const total = Math.hypot(hole.cup.x - hole.tee.x, hole.cup.y - hole.tee.y);
      if (!Number.isFinite(total) || total <= 1) return null;
      const x = this.role === 'client' && Number.isFinite(player.renderX) ? player.renderX : player.ball.x;
      const y = this.role === 'client' && Number.isFinite(player.renderY) ? player.renderY : player.ball.y;
      return clamp(1 - Math.hypot(hole.cup.x - x, hole.cup.y - y) / total, 0, 1);
    }

    getStandings() {
      return [...this.players.values()].sort((a, b) => b.points - a.points || a.strokes - b.strokes || a.username.localeCompare(b.username)).map((p, index) => ({
        rank: index + 1,
        playerKey: p.playerKey,
        username: p.username,
        color: NG.NET_CONFIG.colors[p.colorIndex % NG.NET_CONFIG.colors.length],
        points: p.points,
        strokes: p.strokes,
        turnsUsed: p.turnsUsed,
        role: p.role,
        connected: p.connected,
        finished: p.finished,
        timedOut: p.timedOut,
        finishReason: p.finishReason,
        finishOrder: p.finishOrder,
        progress: this.holeProgress(p),
        turn: this.turnPlayerKey === p.playerKey,
        local: p.playerKey === this.localPlayerKey,
        ping: p.playerKey === this.localPlayerKey
          ? (this.role === 'host' ? Math.round(this.signaling?.lastRelayRtt || 0) : this.transport?.getRtt(this.hostClientId))
          : p.ping,
      }));
    }

    getStatus() {
      const worldRemaining = this.settings?.worldTimeSeconds == null
        ? null
        : Math.max(0, this.settings.worldTimeSeconds - this.holeElapsed);
      const timerPhase = this.graceRemaining != null
        ? 'grace'
        : (this.finishCountdownRemaining != null
          ? 'finish'
          : (worldRemaining != null ? 'world' : 'elapsed'));
      return {
        role: this.role,
        state: this.state,
        online: this.role !== 'offline',
        lobby: this.lobby,
        settings: this.publicSettings(),
        elapsed: this.elapsed,
        holeElapsed: this.holeElapsed,
        finishCountdownRemaining: this.finishCountdownRemaining,
        graceRemaining: this.graceRemaining,
        // Cuántas bolas siguen rodando: es lo que el mundo está esperando.
        rollingBalls: [...this.players.values()].filter((p) => this.isBallInPlay(p)).length,
        timerPhase,
        timerRemaining: timerPhase === 'grace'
          ? this.graceRemaining
          : (timerPhase === 'finish' ? this.finishCountdownRemaining : worldRemaining),
        matchStarted: this.matchStarted,
        matchOver: this.matchOver,
        winnerPlayerKey: this.winnerPlayerKey,
        turnPlayerKey: this.turnPlayerKey,
        relayRtt: this.signaling?.lastRelayRtt ?? null,
        scope: this.scope,
        mapVote: this.getMapVoteStatus(),
        mapChangeCooldownRemainingMs: Math.max(0, this.mapChangeCooldownUntil - Date.now()),
      };
    }

    disconnectForUnload() {
      // Recarga/cierre: desconecta esta pestaña SIN enviar lobby:leave.
      // El relay conserva temporalmente la reserva del cliente para que el botón
      // "Reconectar" pueda recuperarla si la partida continúa existiendo.
      // El host no guarda una falsa sesión recuperable: su autoridad de gameplay
      // vive únicamente en esta pestaña.
      if (this.state === 'unloading') return;
      this.cancelReconnect();
      this.state = 'unloading';
      // El host intenta retirar su lobby para no dejar una sala sin autoridad visible.
      // Es best-effort porque los navegadores no garantizan trabajo asíncrono durante unload.
      if (this.role === 'host' && this.lobby?.id && this.relay?.connected) {
        try { this.relay.send('lobby:leave', { lobbyId: this.lobby.id }); } catch (_) { /* noop */ }
      }
      try { if (this.transport) this.transport.close(); } catch (_) { /* noop */ }
      this.transport = null;
      try { this.relay.close(true); } catch (_) { /* noop */ }
      this.signaling = null;
      this.game.networkSession = null;
    }

    async leave(options = {}) {
      if (this.state === 'leaving') return;
      this.cancelReconnect();
      this.state = 'leaving';
      if (this.lobby && this.signaling?.connected) {
        try { await this.signaling.request('lobby:leave', { lobbyId: this.lobby.id }, 1800); } catch (_) { /* noop */ }
      }
      if (this.transport) this.transport.close();
      this.transport = null;
      this.players.clear();
      this.clientToPlayer.clear();
      this.pendingPeerMeta.clear();
      this.role = 'offline';
      this.state = 'idle';
      this.lobby = null;
      this.settings = null;
      this.matchStarted = false;
      this.matchOver = false;
      this.winnerPlayerKey = null;
      this.turnPlayerKey = null;
      this.finishCountdownRemaining = null;
      this.graceRemaining = null;
      this.graceReason = null;
      this.transitionTimer = 0;
      this.transitionHold = 0;
      this.mapVote = null;
      this.mapChangeCooldownUntil = 0;
      this.signaling = null;
      this.worldBase = null;
      this.netTime = 0;
      this.fixedStep.reset();
      this.hostClock.reset();
      this.predictor.reset(null, 0);
      if (!options.keepLast) this.profile.clearLastSession();
      if (!options.keepRelay) this.relay.close(true);
      this.game.networkSession = null;
    }
  }

  NG.MultiplayerSession = MultiplayerSession;
}(window.NoiseGolf = window.NoiseGolf || {}));
