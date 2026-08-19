(function (NG) {
  'use strict';

  const { clamp } = NG.MathUtil;

  function copyBall(ball) {
    if (!ball) return null;
    const keys = [
      'x', 'y', 'vx', 'vy', 'moving', 'holed', 'inWater', 'crushed', 'boosterCooldown', 'portalCooldown',
      'specialCooldown', 'boosterPulse', 'fanPulse', 'impactSerial', 'boosterSerial', 'holeSerial', 'portalSerial',
      'cannonSerial', 'multiplierSerial', 'caveSerial', 'caveExitSerial', 'gravityPulse', 'movingWallSerial',
      'spinnerSerial', 'lastPortalPairId', 'lastPortalExitIndex', 'lastSurfaceId', 'lastImpactSpeed',
    ];
    const out = {};
    for (const key of keys) if (ball[key] !== undefined) out[key] = ball[key];
    out.lastSafe = ball.lastSafe ? { x: ball.lastSafe.x, y: ball.lastSafe.y, surfaceId: ball.lastSafe.surfaceId } : null;
    out.caveRide = ball.caveRide ? { ...ball.caveRide } : null;
    return out;
  }

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
      this.startedAt = 0;
      this.matchStarted = false;
      this.matchOver = false;
      this.winnerPlayerKey = null;
      this.turnPlayerKey = null;
      this.finishOrder = 0;
      this.snapshotAccumulator = 0;
      this.snapshotSeq = 0;
      this.lastSnapshotSeq = -1;
      this.lobbyUpdateAccumulator = 0;
      this.transitionTimer = 0;
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
      this.mapVoteRetryUntil = 0;
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
      const maxPlayers = clamp(Math.round(Number(settings?.maxPlayers) || 8), 2, NG.NET_CONFIG.maxPlayers);
      const infinite = !!settings?.infinitePoints;
      const maxPoints = infinite ? null : clamp(Math.round(Number(settings?.maxPoints) || 5000), 500, 1000000);
      return {
        name: String(settings?.name || `${this.profile.username} · Campo`).trim().slice(0, NG.NET_CONFIG.maxLobbyNameLength),
        password: String(settings?.password || ''),
        maxPlayers,
        maxPoints,
        infinitePoints: infinite,
        mode,
      };
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
      this.game.startNewCourse(seed, { quiet: true });
      this.worldTime = 0;
      this.elapsed = 0;
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
      this.mapVoteRetryUntil = 0;
      this.mapChangeCooldownUntil = Date.now() + NG.NET_CONFIG.mapVoteCooldownMs;
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
    }

    makeBall(hole = this.game.hole) {
      return {
        x: hole.tee.x, y: hole.tee.y, vx: 0, vy: 0, moving: false, holed: false, inWater: false, crushed: false,
        boosterCooldown: 0, portalCooldown: 0, specialCooldown: 0, boosterPulse: 0, fanPulse: 0,
        lastSafe: { x: hole.tee.x, y: hole.tee.y, surfaceId: hole.tee.surfaceId },
        lastSurfaceId: hole.tee.surfaceId, impactSerial: 0, boosterSerial: 0, holeSerial: 0, portalSerial: 0,
        cannonSerial: 0, multiplierSerial: 0, caveSerial: 0, caveExitSerial: 0, gravityPulse: 0,
        movingWallSerial: 0, spinnerSerial: 0, lastPortalPairId: null, lastPortalExitIndex: null, caveRide: null,
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
        netReceivedAt: 0,
        localPredictionUntil: 0,
        physics: this.role === 'host' ? new NG.PhysicsEngine() : null,
        strokes: 0,
        points: Number(meta.points) || 0,
        finished: false,
        finishOrder: 0,
        holePoints: 0,
        shotInProgress: false,
        multiplierFound: false,
        lastMultiplierSerial: 0,
        ping: null,
      };
    }

    handlePeerOpen(peerId) {
      if (this.role === 'host') {
        const meta = this.pendingPeerMeta.get(peerId) || {};
        const playerKey = meta.playerKey || this.clientToPlayer.get(peerId);
        let player = playerKey ? this.players.get(playerKey) : null;
        if (!player && playerKey) {
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
          if (this.mapVote && player.role === 'player' && !this.mapVote.electorate.has(player.playerKey)) {
            this.mapVote.electorate.add(player.playerKey);
            this.broadcastMapVote();
          }
        }
        this.pendingPeerMeta.delete(peerId);
        this.sendInit(peerId);
        this.broadcastRoster();
        this.updateDiscoveryLobby(true);
      } else {
        // Tras rebind/reconexión el host puede tener un clientId nuevo. Una vez que
        // el canal nuevo abre, retiramos peers anteriores para evitar snapshots dobles.
        for (const otherId of [...this.transport.peers.keys()]) {
          if (otherId !== peerId) this.transport.closePeer(otherId, 'host-peer-replaced');
        }
        this.hostClientId = peerId;
        this.transport.hostClientId = peerId;
        this.state = 'syncing';
        this.emit('progress', { value: 0.78, text: 'Canal P2P conectado · sincronizando mundo…' });
        this.transport.sendReliable(peerId, { type: 'client:ready', playerKey: this.localPlayerKey, username: this.profile.username });
      }
    }

    handlePeerClose(peerId) {
      if (this.role !== 'host') {
        this.state = 'reconnecting';
        this.emit('connection', { state: 'reconnecting', text: 'Conexión con host interrumpida · intentando recuperar…' });
        return;
      }
      const key = this.clientToPlayer.get(peerId);
      const player = key ? this.players.get(key) : null;
      if (player) {
        player.connected = false;
        player.disconnectedAt = Date.now();
        if ((this.settings?.mode || 'turn') === 'turn' && this.turnPlayerKey === player.playerKey) this.advanceTurnFrom(player.playerKey);
        if (this.mapVote?.electorate?.has(player.playerKey)) {
          this.mapVote.electorate.delete(player.playerKey);
          this.mapVote.yes.delete(player.playerKey);
          if (!this.mapVote.electorate.size) this.closeMapVote('no-players');
          else if (this.mapVote.yes.size >= this.mapVote.electorate.size) this.passMapVote();
          else this.broadcastMapVote();
        }
      }
      this.clientToPlayer.delete(peerId);
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
          if (player.role === 'player' && player.ball && !player.finished) this.resetPlayerBall(player, 1, 'Reposición');
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
      if (message.type === 'session:init') this.applyInit(message);
      else if (message.type === 'session:roster') this.applyRoster(message.players || []);
      else if (message.type === 'session:event') this.emit('gameevent', message);
      else if (message.type === 'state:snapshot') this.applySnapshot(message);
      else if (message.type === 'map:vote:update') { this.mapVote = this.normalizeRemoteVote(message.vote); this.emit('mapvote', this.getMapVoteStatus()); }
      else if (message.type === 'map:vote:closed') { this.mapVote = null; this.mapVoteRetryUntil = Date.now() + Math.max(0, Number(message.retryRemainingMs) || 0); this.emit('mapvote', this.getMapVoteStatus()); }
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
        worldTime: this.worldTime,
        elapsed: this.elapsed,
        matchStarted: this.matchStarted,
        matchOver: this.matchOver,
        winnerPlayerKey: this.winnerPlayerKey,
        turnPlayerKey: this.turnPlayerKey,
        mapVote: this.serializeMapVote(),
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
      this.syncWorld(message.seed, message.holeIndex || 0);
      this.worldTime = Number(message.worldTime) || 0;
      this.game.physics.time = this.worldTime;
      this.applyRoster(message.players || []);
      this.state = message.localRole === 'spectator' ? 'spectating' : 'playing';
      this.emit('progress', { value: 1, text: message.localRole === 'spectator' ? 'Conectado como espectador' : 'Listo para jugar' });
      this.emit('ready', { role: this.role, lobby: this.lobby, spectator: message.localRole === 'spectator' });
      this.lastSnapshotAt = performance.now();
    }

    syncWorld(seed, holeIndex) {
      if (!seed) return;
      if (this.game.seed !== seed || !this.game.holes?.length) this.game.startNewCourse(seed, { quiet: true });
      if (this.game.holeIndex !== holeIndex) this.game.loadHole(clamp(holeIndex, 0, this.game.holes.length - 1));
    }

    publicSettings() {
      return {
        name: this.settings?.name || this.lobby?.name || 'Partida',
        mode: this.settings?.mode || 'turn',
        maxPlayers: this.settings?.maxPlayers || this.lobby?.maxPlayers || 8,
        maxPoints: this.settings?.maxPoints ?? null,
        infinitePoints: this.settings?.infinitePoints ?? (this.settings?.maxPoints == null),
        scope: this.scope,
      };
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
        points: p.points,
        finished: p.finished,
        finishOrder: p.finishOrder,
        holePoints: p.holePoints,
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
        if (p.shotInProgress && (p.strokes > previousStrokes || meta.ball?.moving)) p.shotInProgress = false;
        p.points = Number(meta.points) || 0;
        p.finished = !!meta.finished;
        p.finishOrder = Number(meta.finishOrder) || 0;
        p.holePoints = Number(meta.holePoints) || 0;
        if (meta.ball) {
          const previousBall = p.ball;
          p.ball = { ...(p.ball || {}), ...meta.ball };
          if (!Number.isFinite(p.renderX)) p.renderX = p.ball.x;
          if (!Number.isFinite(p.renderY)) p.renderY = p.ball.y;
          if (!Number.isFinite(p.renderVX)) p.renderVX = Number(p.ball.vx) || 0;
          if (!Number.isFinite(p.renderVY)) p.renderVY = Number(p.ball.vy) || 0;
          if (options.snapshot) {
            p.netReceivedAt = performance.now();
            // Si la autoridad detuvo, teletransportó o reseteó la bola, no mantenemos
            // una predicción local antigua. La corrección visual se hará con snap/soft-correction.
            if (!p.ball.moving || p.ball.holed || p.ball.inWater || (previousBall && previousBall.lastSafe && p.ball.lastSafe && previousBall.lastSafe.surfaceId !== p.ball.lastSafe.surfaceId)) {
              p.localPredictionUntil = 0;
            }
          }
        }
      }
      for (const key of [...this.players.keys()]) if (!seen.has(key) && this.role !== 'host') this.players.delete(key);
      this.syncGameToLocal();
      this.emit('standings', this.getStandings());
    }

    applySnapshot(snapshot) {
      const seq = Number(snapshot?.seq);
      if (Number.isFinite(seq)) {
        if (seq <= this.lastSnapshotSeq) return;
        this.lastSnapshotSeq = seq;
      }
      this.lastSnapshotAt = performance.now();
      const previousSeed = this.game.seed;
      const previousHole = this.game.holeIndex;
      this.syncWorld(snapshot.seed, snapshot.holeIndex || 0);
      const incomingWorldTime = Number(snapshot.worldTime);
      if (Number.isFinite(incomingWorldTime)) {
        const worldChanged = previousSeed !== this.game.seed || previousHole !== this.game.holeIndex;
        const drift = incomingWorldTime - this.worldTime;
        if (worldChanged || !Number.isFinite(this.worldTime) || Math.abs(drift) > 0.65) this.worldTime = incomingWorldTime;
        else this.worldTime += drift * 0.42;
      }
      this.elapsed = Number(snapshot.elapsed) || 0;
      this.matchStarted = !!snapshot.matchStarted;
      this.matchOver = !!snapshot.matchOver;
      this.turnPlayerKey = snapshot.turnPlayerKey || null;
      this.winnerPlayerKey = snapshot.winnerPlayerKey || null;
      this.mapVote = this.normalizeRemoteVote(snapshot.mapVote);
      if (snapshot.mapChangeCooldownRemainingMs !== undefined) this.mapChangeCooldownUntil = Date.now() + Math.max(0, Number(snapshot.mapChangeCooldownRemainingMs) || 0);
      this.applyRoster(snapshot.players || [], { snapshot: true });
      this.game.physics.time = this.worldTime;
    }

    canLocalShoot() {
      if (this.role === 'offline') return true;
      if (this.matchOver || this.state === 'joining' || this.state === 'syncing') return false;
      const player = this.players.get(this.localPlayerKey);
      if (!player || player.role !== 'player' || !player.ball || player.finished || !player.connected) return false;
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
          // Presentación predictiva: el host sigue siendo la autoridad. Solo adelantamos
          // visualmente el tiro local durante una ventana muy corta para ocultar RTT.
          player.renderVX = safeVelocity.x;
          player.renderVY = safeVelocity.y;
          player.localPredictionUntil = performance.now() + Math.min(220, Math.max(90, (this.transport?.getRtt(this.hostClientId) || 90) * 0.9));
        }
      }
      return !!ok;
    }

    requestReset() {
      if (this.role === 'offline' || this.matchOver) return false;
      const player = this.players.get(this.localPlayerKey);
      if (!player || player.role !== 'player' || !player.ball || player.finished) return false;
      if (this.role === 'host') {
        this.resetPlayerBall(player, 1, 'Reposición');
        return true;
      }
      return !!this.transport?.sendReliable(this.hostClientId, { type: 'reset' });
    }

    applyShot(player, velocity) {
      if (!player || player.role !== 'player' || !player.ball || player.finished || !player.connected || this.matchOver) return false;
      const speed = Math.hypot(Number(velocity?.x) || 0, Number(velocity?.y) || 0);
      if (!Number.isFinite(speed) || speed < NG.CONFIG.shot.minLaunchSpeed || speed > NG.CONFIG.ball.maxSpeed * 1.03) return false;
      if (player.ball.moving || player.ball.holed || player.ball.inWater) return false;
      if ((this.settings?.mode || 'turn') === 'turn' && this.turnPlayerKey !== player.playerKey) return false;
      player.ball.vx = velocity.x;
      player.ball.vy = velocity.y;
      player.ball.moving = true;
      player.ball.inWater = false;
      player.ball.crushed = false;
      player.ball.lastImpactSpeed = 0;
      player.strokes += 1;
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
      if (this.role === 'host') this.updateHost(dt);
      else this.updateClient(dt);
    }

    updateHost(dt) {
      if (this.matchOver) {
        this.game.physics.time = this.worldTime;
        return;
      }
      if (this.mapVote && Date.now() >= this.mapVote.expiresAt) this.closeMapVote('timeout');
      const startTime = this.worldTime;
      if (this.matchStarted) this.elapsed += dt;
      const activePlayers = [...this.players.values()].filter((p) => p.role === 'player' && p.ball && !p.finished);
      for (const p of activePlayers) {
        if (!p.connected && p.disconnectedAt && Date.now() - p.disconnectedAt > 15000) {
          p.finished = true;
          p.holePoints = 0;
          p.shotInProgress = false;
          continue;
        }
        p.physics.time = startTime;
        p.physics.update(p.ball, this.game.hole, dt);
        if ((p.ball.multiplierSerial || 0) > p.lastMultiplierSerial) {
          p.lastMultiplierSerial = p.ball.multiplierSerial || 0;
          p.multiplierFound = true;
        }
        if (p.ball.crushed) this.resetPlayerBall(p, NG.CONFIG.gameplay.crushPenaltyStroke, 'Aplastado');
        else if (p.ball.inWater) this.resetPlayerBall(p, NG.CONFIG.gameplay.waterPenaltyStroke, 'Agua');
        else if (this.game.isOutOfWorld(p.ball)) this.resetPlayerBall(p, NG.CONFIG.gameplay.outOfBoundsPenaltyStroke, 'Fuera del mapa');
        if (p.ball?.holed && !p.finished) this.finishPlayerHole(p);
        if (p.shotInProgress && p.ball && !p.ball.moving && !p.ball.holed && !p.ball.inWater) {
          p.shotInProgress = false;
          if ((this.settings?.mode || 'turn') === 'turn') this.advanceTurnFrom(p.playerKey);
        }
      }
      this.worldTime = startTime + dt;
      this.game.physics.time = this.worldTime;
      if ((this.settings?.mode || 'turn') === 'battle') this.resolveBallCollisions();

      const stillPlaying = [...this.players.values()].filter((p) => p.role === 'player' && !p.finished);
      if (this.matchStarted && stillPlaying.length === 0 && !this.transitionTimer && !this.matchOver) this.transitionTimer = 2.35;
      if (this.transitionTimer > 0) {
        this.transitionTimer -= dt;
        if (this.transitionTimer <= 0) this.advanceHole();
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
      this.syncGameToLocal();
      this.emit('standings', this.getStandings());
    }

    updateClient(dt) {
      if (!this.matchOver && Number.isFinite(dt) && dt > 0) this.worldTime += Math.min(dt, 0.1);
      const now = performance.now();
      const rttMs = Math.max(0, Number(this.transport?.getRtt(this.hostClientId)) || 90);
      const interpDelay = NG.NET_CONFIG.interpolationMs / 1000;
      const maxExtrapolation = NG.NET_CONFIG.maxExtrapolationMs / 1000;
      const responsiveness = NG.NET_CONFIG.smoothingResponsiveness;
      const snapDistance = NG.NET_CONFIG.snapDistance;

      for (const p of this.players.values()) {
        if (!p.ball) continue;
        if (!Number.isFinite(p.renderX)) p.renderX = p.ball.x;
        if (!Number.isFinite(p.renderY)) p.renderY = p.ball.y;
        if (!Number.isFinite(p.renderVX)) p.renderVX = Number(p.ball.vx) || 0;
        if (!Number.isFinite(p.renderVY)) p.renderVY = Number(p.ball.vy) || 0;

        const sinceSnapshot = p.netReceivedAt ? Math.max(0, (now - p.netReceivedAt) / 1000) : 0;
        const networkLead = Math.min(maxExtrapolation, Math.max(0, sinceSnapshot + rttMs / 2000 - interpDelay));
        let targetX = Number(p.ball.x) || 0;
        let targetY = Number(p.ball.y) || 0;
        let targetVX = Number(p.ball.vx) || 0;
        let targetVY = Number(p.ball.vy) || 0;

        if (p.ball.moving && networkLead > 0) {
          targetX += targetVX * networkLead;
          targetY += targetVY * networkLead + 0.5 * NG.CONFIG.ball.gravity * networkLead * networkLead;
          targetVY += NG.CONFIG.ball.gravity * networkLead;
        }

        // El disparo del cliente empieza a moverse en pantalla sin esperar un round-trip.
        // En cuanto llegan snapshots host, la corrección converge a la autoridad.
        if (p.playerKey === this.localPlayerKey && p.localPredictionUntil > now && p.shotInProgress && !p.ball.moving) {
          const step = Math.min(dt, 0.05);
          p.renderX += p.renderVX * step;
          p.renderY += p.renderVY * step + 0.5 * NG.CONFIG.ball.gravity * step * step;
          p.renderVY += NG.CONFIG.ball.gravity * step;
          targetX = p.renderX;
          targetY = p.renderY;
          targetVX = p.renderVX;
          targetVY = p.renderVY;
        }

        const error = Math.hypot(targetX - p.renderX, targetY - p.renderY);
        const authoritativeTeleport = !p.ball.moving && error > Math.max(55, snapDistance * 0.45);
        if (error > snapDistance || authoritativeTeleport) {
          p.renderX = targetX;
          p.renderY = targetY;
          p.renderVX = targetVX;
          p.renderVY = targetVY;
        } else {
          const adaptive = responsiveness + Math.min(18, error * 0.06);
          const t = 1 - Math.exp(-adaptive * Math.max(0, dt));
          p.renderX += (targetX - p.renderX) * t;
          p.renderY += (targetY - p.renderY) * t;
          p.renderVX += (targetVX - p.renderVX) * Math.min(1, t * 1.3);
          p.renderVY += (targetVY - p.renderVY) * Math.min(1, t * 1.3);
        }
      }
      this.game.physics.time = this.worldTime;
      this.syncGameToLocal(true);
      this.emit('standings', this.getStandings());
      if (performance.now() - this.lastSnapshotAt > 4500 && this.state !== 'joining' && this.state !== 'syncing') {
        this.emit('connection', { state: 'degraded', text: 'Sin snapshots recientes del host' });
      }
    }

    resetPlayerBall(player, penalty, reason) {
      if (!player?.ball) return;
      player.strokes += penalty;
      const safe = player.ball.lastSafe || { x: this.game.hole.tee.x, y: this.game.hole.tee.y, surfaceId: this.game.hole.tee.surfaceId };
      const fresh = this.makeBall();
      fresh.x = Number.isFinite(safe.x) ? safe.x : this.game.hole.tee.x;
      fresh.y = Number.isFinite(safe.y) ? safe.y : this.game.hole.tee.y;
      fresh.lastSafe = { x: fresh.x, y: fresh.y, surfaceId: safe.surfaceId || this.game.hole.tee.surfaceId };
      fresh.lastSurfaceId = fresh.lastSafe.surfaceId;
      player.ball = fresh;
      player.physics.time = this.worldTime;
      player.shotInProgress = false;
      if ((this.settings?.mode || 'turn') === 'turn') this.advanceTurnFrom(player.playerKey);
      this.broadcastReliable({ type: 'session:event', event: 'penalty', playerKey: player.playerKey, reason, penalty });
      if (player.playerKey === this.localPlayerKey) this.game.hud.flashStatus(`${reason} · +${penalty}`, 'penalty', 1.05);
    }

    finishPlayerHole(player) {
      player.finished = true;
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
      if (this.settings?.maxPoints != null && player.points >= this.settings.maxPoints) this.finishMatch(player.playerKey);
    }

    finishMatch(winnerPlayerKey) {
      if (this.matchOver) return;
      this.matchOver = true;
      this.winnerPlayerKey = winnerPlayerKey;
      this.transitionTimer = 0;
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
        retryRemainingMs: Math.max(0, this.mapVoteRetryUntil - now),
      };
    }

    requestMapVote() {
      if (this.role === 'offline') return false;
      const local = this.players.get(this.localPlayerKey);
      if (!local || local.role !== 'player' || !local.connected) return false;
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
      if (this.role !== 'host' || this.matchOver || this.mapVote) return false;
      const now = Date.now();
      if (now < this.mapChangeCooldownUntil || now < this.mapVoteRetryUntil) return false;
      const electorate = [...this.players.values()]
        .filter((p) => p.role === 'player' && p.connected)
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
      if (reason === 'no') this.mapVoteRetryUntil = Date.now() + NG.NET_CONFIG.mapVoteRetryAfterNoMs;
      this.broadcastReliable({ type: 'map:vote:closed', reason, retryRemainingMs: Math.max(0, this.mapVoteRetryUntil - Date.now()) });
      this.emit('mapvote', this.getMapVoteStatus());
    }

    passMapVote() {
      if (!this.mapVote) return;
      this.mapVote = null;
      this.mapVoteRetryUntil = 0;
      this.changeMapFromVote();
      this.broadcastReliable({ type: 'map:vote:closed', reason: 'passed', retryRemainingMs: 0 });
      this.emit('mapvote', this.getMapVoteStatus());
    }

    changeMapFromVote() {
      if (this.role !== 'host' || this.matchOver) return false;
      this.courseRound += 1;
      const seed = `${this.lobby?.id || 'match'}-vote-${this.courseRound.toString(36)}-${Date.now().toString(36).slice(-6)}`;
      this.game.startNewCourse(seed, { quiet: true });
      this.game.loadHole(0);
      this.worldTime = 0;
      this.finishOrder = 0;
      this.transitionTimer = 0;
      this.mapChangeCooldownUntil = Date.now() + NG.NET_CONFIG.mapVoteCooldownMs;
      for (const p of this.players.values()) {
        if (p.role === 'spectator' && p.connected) p.role = 'player';
        if (p.role !== 'player') continue;
        p.ball = this.makeBall();
        p.physics = new NG.PhysicsEngine();
        p.strokes = 0;
        p.finished = false;
        p.finishOrder = 0;
        p.holePoints = 0;
        p.shotInProgress = false;
        p.multiplierFound = false;
        p.lastMultiplierSerial = 0;
        p.renderX = p.ball.x;
        p.renderY = p.ball.y;
        p.renderVX = 0;
        p.renderVY = 0;
        p.netReceivedAt = performance.now();
        p.localPredictionUntil = 0;
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
      let next = this.game.holeIndex + 1;
      if (next >= this.game.holes.length) {
        this.courseRound += 1;
        const seed = `${this.lobby?.id || 'match'}-${this.courseRound.toString(36)}-${Date.now().toString(36).slice(-5)}`;
        this.game.startNewCourse(seed, { quiet: true });
        next = 0;
      } else this.game.loadHole(next);
      this.worldTime = 0;
      for (const p of this.players.values()) {
        if (p.role === 'spectator') p.role = 'player';
        p.ball = this.makeBall();
        p.physics = new NG.PhysicsEngine();
        p.strokes = 0;
        p.finished = false;
        p.finishOrder = 0;
        p.holePoints = 0;
        p.shotInProgress = false;
        p.multiplierFound = false;
        p.lastMultiplierSerial = 0;
        p.renderX = p.ball.x;
        p.renderY = p.ball.y;
        p.renderVX = 0;
        p.renderVY = 0;
        p.netReceivedAt = performance.now();
        p.localPredictionUntil = 0;
      }
      this.turnPlayerKey = [...this.players.values()].find((p) => p.role === 'player' && p.connected)?.playerKey || null;
      this.broadcastReliable({ type: 'session:event', event: 'next-hole', seed: this.game.seed, holeIndex: this.game.holeIndex });
      this.broadcastRoster();
      this.broadcastSnapshot();
      this.updateDiscoveryLobby(true);
    }

    resolveBallCollisions() {
      const list = [...this.players.values()].filter((p) => p.role === 'player' && p.ball && !p.finished && !p.ball.holed);
      const r = NG.CONFIG.ball.radius;
      const minDist = r * 2;
      for (let i = 0; i < list.length; i += 1) {
        for (let j = i + 1; j < list.length; j += 1) {
          const a = list[i].ball, b = list[j].ball;
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
          const rel = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
          if (rel < 0) {
            const impulse = -(1 + 0.84) * rel * 0.5;
            a.vx -= impulse * nx; a.vy -= impulse * ny;
            b.vx += impulse * nx; b.vy += impulse * ny;
            a.moving = true; b.moving = true;
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
      this.transport.broadcastState({
        type: 'state:snapshot', seq: ++this.snapshotSeq, seed: this.game.seed, holeIndex: this.game.holeIndex,
        worldTime: this.worldTime, elapsed: this.elapsed, matchStarted: this.matchStarted,
        matchOver: this.matchOver, winnerPlayerKey: this.winnerPlayerKey, turnPlayerKey: this.turnPlayerKey,
        mapVote: this.serializeMapVote(), mapChangeCooldownRemainingMs: Math.max(0, this.mapChangeCooldownUntil - Date.now()),
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
          connectedClientIds: [...this.players.values()].filter((p) => p.connected && p.clientId).map((p) => p.clientId),
        }, 3500);
        if (updated?.lobby) this.lobby = updated.lobby;
      } catch (_) { /* una caída de discovery no debe detener el gameplay P2P */ }
    }

    syncGameToLocal(useRender = false) {
      if (this.role === 'offline') return;
      let player = this.players.get(this.localPlayerKey);
      if (!player || player.role === 'spectator' || !player.ball) {
        player = [...this.players.values()].filter((p) => p.ball && p.role === 'player').sort((a, b) => b.points - a.points)[0] || null;
      }
      if (!player?.ball) return;
      if (useRender) {
        const presentationMoving = !!player.ball.moving || (player.playerKey === this.localPlayerKey && player.shotInProgress && player.localPredictionUntil > performance.now());
        this.game.ball = { ...player.ball, x: player.renderX, y: player.renderY, vx: player.renderVX, vy: player.renderVY, moving: presentationMoving };
      } else this.game.ball = player.ball;
      const local = this.players.get(this.localPlayerKey);
      this.game.strokes = local?.strokes || 0;
      this.game.arcadePoints = local?.points || 0;
    }

    getRenderBalls() {
      if (this.role === 'offline') return this.game.ball ? [{ playerKey: 'offline', username: '', color: '#f7fbff', ball: this.game.ball, local: true, turn: false, battleLocal: false }] : [];
      const mode = this.settings?.mode || this.lobby?.mode || 'turn';
      return [...this.players.values()].filter((p) => p.ball && p.role === 'player').map((p) => {
        const local = p.playerKey === this.localPlayerKey;
        return {
          playerKey: p.playerKey,
          username: p.username,
          color: NG.NET_CONFIG.colors[p.colorIndex % NG.NET_CONFIG.colors.length],
          local,
          turn: this.turnPlayerKey === p.playerKey,
          // En Battle Royale cada navegador destaca exclusivamente SU propia bola.
          // Es una marca de presentación local; no se replica ni altera autoridad/snapshots.
          battleLocal: mode === 'battle' && local,
          ball: this.role === 'client' ? { ...p.ball, x: p.renderX, y: p.renderY, vx: p.renderVX, vy: p.renderVY } : p.ball,
        };
      });
    }

    getCameraBall() {
      if (this.role === 'offline') return this.game.ball;
      const mode = this.settings?.mode || this.lobby?.mode || 'turn';
      let p = null;
      if (mode === 'turn' && this.turnPlayerKey) p = this.players.get(this.turnPlayerKey) || null;
      if (!p?.ball) p = this.players.get(this.localPlayerKey) || null;
      if (!p?.ball) p = [...this.players.values()].find((candidate) => candidate.role === 'player' && candidate.ball) || null;
      if (!p?.ball) return this.game.ball;
      return this.role === 'client'
        ? { ...p.ball, x: p.renderX, y: p.renderY, vx: p.renderVX, vy: p.renderVY }
        : p.ball;
    }

    isCameraFollowingLocal() {
      if (this.role === 'offline') return true;
      const mode = this.settings?.mode || this.lobby?.mode || 'turn';
      if (mode === 'battle') return true;
      return !this.turnPlayerKey || this.turnPlayerKey === this.localPlayerKey;
    }

    getStandings() {
      return [...this.players.values()].sort((a, b) => b.points - a.points || a.strokes - b.strokes || a.username.localeCompare(b.username)).map((p, index) => ({
        rank: index + 1,
        playerKey: p.playerKey,
        username: p.username,
        color: NG.NET_CONFIG.colors[p.colorIndex % NG.NET_CONFIG.colors.length],
        points: p.points,
        strokes: p.strokes,
        role: p.role,
        connected: p.connected,
        finished: p.finished,
        turn: this.turnPlayerKey === p.playerKey,
        local: p.playerKey === this.localPlayerKey,
        ping: p.playerKey === this.localPlayerKey
          ? (this.role === 'host' ? Math.round(this.signaling?.lastRelayRtt || 0) : this.transport?.getRtt(this.hostClientId))
          : p.ping,
      }));
    }

    getStatus() {
      return {
        role: this.role,
        state: this.state,
        online: this.role !== 'offline',
        lobby: this.lobby,
        settings: this.publicSettings(),
        elapsed: this.elapsed,
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
      this.mapVote = null;
      this.mapChangeCooldownUntil = 0;
      this.signaling = null;
      if (!options.keepLast) this.profile.clearLastSession();
      if (!options.keepRelay) this.relay.close(true);
      this.game.networkSession = null;
    }
  }

  NG.MultiplayerSession = MultiplayerSession;
}(window.NoiseGolf = window.NoiseGolf || {}));
