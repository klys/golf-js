(function (NG) {
  'use strict';

  function timeText(seconds) {
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return h > 0
      ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
      : `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  /**
   * Traduce un RTT a barras + etiqueta. Compartido con el server browser para
   * que la señal signifique exactamente lo mismo en el menú y dentro de partida.
   */
  function quality(rtt) {
    if (!Number.isFinite(rtt) || rtt <= 0) return { bars: 0, label: '—', key: 'none' };
    if (rtt <= 60) return { bars: 4, label: 'Excelente', key: 'great' };
    if (rtt <= 120) return { bars: 3, label: 'Buena', key: 'good' };
    if (rtt <= 220) return { bars: 2, label: 'Media', key: 'fair' };
    return { bars: 1, label: 'Débil', key: 'bad' };
  }

  const formatInt = (value) => Math.max(0, Math.round(Number(value) || 0)).toLocaleString('es-ES');

  class NetworkHUD {
    constructor(hud) {
      const $ = (selector) => document.querySelector(selector);
      this.hud = hud || null;

      this.root = $('#networkHud');
      this.mode = $('#netModeLabel');
      this.modeText = this.mode ? this.mode.querySelector('b') : null;
      this.modeIcon = this.mode ? this.mode.querySelector('use') : null;
      this.lobby = $('#netLobbyLabel');
      this.timer = $('#netTimerLabel');
      this.playerCount = $('#netPlayerCount');
      this.signal = $('#netSignalLabel');
      this.bars = $('#netSignalBars');
      this.role = $('#netRoleLabel');
      this.table = $('#scoreboardRows');
      this.metricHead = $('#scoreboardMetric');
      this.turn = $('#turnIndicator');
      this.goalBar = $('#netGoalBar');
      this.goalFill = $('#netGoalFill');
      this.goalLabel = $('#netGoalLabel');
      this.foot = $('#netFootHint');
      this.leave = $('#leaveOnlineBtn');
      this.collapseBtn = $('#scoreboardToggle');

      this.spectateBar = $('#spectateBar');
      this.spectateCount = $('#spectateCount');
      this.spectateDot = $('#spectateDot');
      this.spectateNameText = $('#spectateNameText');

      this.matchOverPanel = $('#matchOverPanel');
      this.matchOverTitle = $('#matchOverTitle');
      this.matchOverSub = $('#matchOverSub');
      this.matchOverRows = $('#matchOverRows');

      this.session = null;
      this.unsubs = [];
      this.onLeave = null;
      this.metricMode = 'strokes';
      this.rowNodes = new Map();
      this.matchOverShown = false;

      this.leave?.addEventListener('click', () => this.onLeave?.());
      this.collapseBtn?.addEventListener('click', () => this.root?.classList.toggle('collapsed'));
      this.metricHead?.addEventListener('click', () => {
        this.metricMode = this.metricMode === 'strokes' ? 'ping' : 'strokes';
        this.update();
      });
      if (this.metricHead) {
        this.metricHead.style.cursor = 'pointer';
        this.metricHead.title = 'Alternar entre golpes y ping';
      }
      $('#spectatePrev')?.addEventListener('click', () => this.moveSpectate(-1));
      $('#spectateNext')?.addEventListener('click', () => this.moveSpectate(1));
      $('#matchOverStay')?.addEventListener('click', () => this.matchOverPanel?.classList.add('hidden'));
      $('#matchOverHome')?.addEventListener('click', () => { this.matchOverPanel?.classList.add('hidden'); this.onLeave?.(); });
    }

    attach(session, onLeave) {
      this.detach();
      this.session = session;
      this.onLeave = onLeave;
      this.matchOverShown = false;
      this.root?.classList.remove('hidden');
      this.root?.classList.remove('collapsed');
      this.hud?.setRuntime('online');
      this.unsubs.push(session.on('standings', (rows) => this.renderRows(rows)));
      this.unsubs.push(session.on('connection', ({ text }) => {
        if (this.signal && text) this.signal.textContent = text;
      }));
      this.unsubs.push(session.on('matchover', (payload) => this.showMatchOver(payload)));
      this.update();
    }

    detach() {
      for (const unsub of this.unsubs) try { unsub(); } catch (_) { /* noop */ }
      this.unsubs.length = 0;
      this.session = null;
      this.onLeave = null;
      this.rowNodes.clear();
      if (this.table) this.table.textContent = '';
      if (this.matchOverRows) this.matchOverRows.textContent = '';
      this.matchOverShown = false;
      this.root?.classList.add('hidden');
      if (this.spectateBar) this.spectateBar.hidden = true;
      this.matchOverPanel?.classList.add('hidden');
      this.hud?.setRuntime('offline');
      this.hud?.setNetChip({ ping: '—', bars: 0, role: 'OFFLINE', quality: 'offline' });
    }

    isOnline() {
      return !!this.session && !this.root?.classList.contains('hidden');
    }

    update() {
      if (!this.isOnline()) return;
      const status = this.session.getStatus();
      if (!status.matchOver && this.matchOverShown) {
        this.matchOverShown = false;
        this.matchOverPanel?.classList.add('hidden');
      }
      const settings = status.settings || {};
      const mode = settings.mode === 'battle' ? 'battle' : 'turn';
      const rows = this.session.getStandings();
      const local = rows.find((p) => p.local);
      const connected = rows.filter((p) => p.connected).length;
      const clockSeconds = status.timerRemaining == null ? status.elapsed : status.timerRemaining;

      // — Cabecera —
      if (this.mode) this.mode.dataset.mode = mode;
      if (this.modeText) this.modeText.textContent = mode === 'battle' ? 'BATTLE ROYALE' : 'POR TURNOS';
      if (this.modeIcon) this.modeIcon.setAttribute('href', mode === 'battle' ? '#i-swords' : '#i-turns');
      if (this.lobby) this.lobby.textContent = status.lobby?.name || settings.name || 'Partida online';
      if (this.timer) {
        this.timer.textContent = timeText(clockSeconds);
        this.timer.dataset.phase = status.timerPhase || 'elapsed';
        this.timer.title = status.timerPhase === 'finish'
          ? 'Tiempo restante para terminar el mundo'
          : (status.timerPhase === 'world' ? 'Tiempo restante del mundo' : 'Tiempo total de partida');
      }
      if (this.playerCount) this.playerCount.textContent = `${connected}/${settings.maxPlayers || rows.length || 0}`;

      // — Señal local —
      const rtt = Number.isFinite(local?.ping) ? local.ping : status.relayRtt;
      const q = quality(rtt);
      if (this.signal) this.signal.textContent = q.key === 'none' ? 'midiendo…' : `${Math.round(rtt)} ms · ${q.label}`;
      if (this.bars) {
        this.bars.dataset.bars = String(q.bars);
        this.bars.setAttribute('aria-label', `${q.bars} de 4 barras de señal`);
      }

      const spectator = local?.role === 'spectator';
      const roleText = spectator ? 'ESPECTADOR' : (status.role === 'host' ? 'HOST' : 'CLIENTE');
      if (this.role) {
        this.role.textContent = roleText;
        this.role.dataset.role = spectator ? 'spectator' : status.role;
      }
      this.hud?.setNetChip({
        ping: q.key === 'none' ? '—' : `${Math.round(rtt)}`,
        bars: q.bars,
        role: roleText,
        quality: q.key === 'none' ? 'offline' : q.key,
      });

      // — Titular de turno / estado —
      const turnRow = rows.find((p) => p.turn);
      const bar = this.resolveState({ status, settings, mode, rows, local, turnRow, spectator });
      if (this.turn) {
        this.turn.textContent = bar.scoreboardText;
        this.turn.dataset.state = bar.tone;
      }
      this.hud?.setMatchBar({
        mode,
        state: bar.tone === 'mine' ? 'your-turn' : bar.tone === 'over' ? 'over' : bar.tone === 'spectator' ? 'spectator' : 'waiting',
        title: bar.title,
        hint: bar.hint,
        timer: timeText(clockSeconds),
      });

      // — Objetivo de puntos —
      const maxPoints = settings.maxPoints;
      if (this.goalBar) {
        const infinite = maxPoints == null;
        this.goalBar.hidden = infinite;
        if (!infinite) {
          const leader = rows.reduce((best, p) => Math.max(best, p.points || 0), 0);
          const ratio = Math.max(0, Math.min(1, leader / Math.max(1, maxPoints)));
          if (this.goalFill) this.goalFill.style.width = `${(ratio * 100).toFixed(1)}%`;
          if (this.goalLabel) this.goalLabel.textContent = `${formatInt(leader)} / ${formatInt(maxPoints)} pts`;
        }
      }

      if (this.metricHead) this.metricHead.textContent = this.metricMode === 'ping' ? 'PING' : 'GOLPES';
      if (this.foot) {
        this.foot.textContent = status.role === 'host'
          ? 'Eres la autoridad de física de esta sala'
          : 'El host es la autoridad de física · tu vista está interpolada';
      }

      this.renderRows(rows);
    }

    /** Un único sitio decide qué se lee arriba y en el marcador. */
    resolveState({ status, settings, mode, rows, local, turnRow, spectator }) {
      if (status.matchOver) {
        const winner = rows.find((p) => p.playerKey === status.winnerPlayerKey);
        return {
          tone: 'over',
          title: winner ? `${winner.username} gana la partida` : 'Partida terminada',
          hint: 'Marcador final disponible',
          scoreboardText: winner ? `🏆 ${winner.username}` : 'FINAL',
        };
      }
      if (status.timerPhase === 'finish' && status.finishCountdownRemaining != null) {
        const remaining = timeText(status.finishCountdownRemaining);
        return {
          tone: 'battle',
          title: 'Tiempo restante',
          hint: `${remaining} para embocar; quien no llegue se queda sin puntos`,
          scoreboardText: `CIERRE DEL MUNDO · ${remaining}`,
        };
      }
      if (spectator) {
        return {
          tone: 'spectator',
          title: 'Espectador',
          hint: 'Entrarás a jugar en el próximo hoyo',
          scoreboardText: 'ESPECTADOR · JUEGAS EN EL PRÓXIMO HOYO',
        };
      }
      // Ya has terminado y el mundo sigue: lo único accionable que te queda es
      // elegir a quién mirar, así que la barra lo dice en vez de repetir turno.
      if (local?.finished && this.session?.canSpectate?.()) {
        const following = this.session.getSpectateStatus?.().following;
        const watching = following ? (following.local ? 'tu bola' : following.username) : 'la partida';
        return {
          tone: 'spectator',
          title: local.finishReason === 'holed' ? 'Hoyo completado' : 'Sin más lanzamientos',
          hint: `Viendo ${watching} · ← → o C para cambiar de jugador`,
          scoreboardText: `ESPERANDO · VIENDO A ${String(following?.username || '—').toUpperCase()}`,
        };
      }
      if (mode === 'battle') {
        const started = status.matchStarted;
        return {
          tone: 'battle',
          title: started ? 'Todos en juego' : 'Battle Royale preparado',
          hint: started
            ? (settings.collisionsEnabled === false ? 'Todos juegan a la vez' : 'Las bolas colisionan entre sí')
            : 'El primer tiro inicia la partida',
          scoreboardText: started ? 'TODOS EN JUEGO' : 'EL PRIMER TIRO INICIA LA PARTIDA',
        };
      }
      if (!turnRow) {
        return { tone: 'idle', title: 'Esperando turno', hint: 'Sin jugadores activos', scoreboardText: 'ESPERANDO TURNO' };
      }
      if (turnRow.local) {
        const turnHint = settings.maxTurnsPerWorld == null
          ? 'Arrastra la bola y suelta para golpear'
          : `Lanzamiento ${Math.min(settings.maxTurnsPerWorld, (turnRow.turnsUsed || 0) + 1)} de ${settings.maxTurnsPerWorld}`;
        return { tone: 'mine', title: 'Es tu turno', hint: turnHint, scoreboardText: 'TU TURNO' };
      }
      return {
        tone: 'idle',
        title: `Turno de ${turnRow.username}`,
        hint: `${rows.filter((p) => p.connected && p.role === 'player').length} jugadores en la sala`,
        scoreboardText: `TURNO DE ${String(turnRow.username).toUpperCase()}`,
      };
    }

    /** Botones ‹ › de la barra de cámara libre. */
    moveSpectate(direction) {
      this.announceSpectate(this.session?.cycleSpectate?.(direction));
    }

    /** Clic en una fila del marcador: la cámara salta a ese jugador. */
    pickSpectate(playerKey) {
      this.announceSpectate(this.session?.setSpectateTarget?.(playerKey));
    }

    announceSpectate(target) {
      if (!target) return;
      this.hud?.flashStatus(target.local ? 'Cámara en tu bola' : `Siguiendo a ${target.username}`, 'neutral', 0.9);
      this.renderSpectate();
    }

    /**
     * Barra de cámara libre. Solo existe mientras la sesión la ofrece: has
     * terminado el hoyo (o eres espectador) y aún queda alguien jugando.
     */
    renderSpectate() {
      const spectate = this.session?.getSpectateStatus?.() || { available: false, options: [], following: null, count: 0, index: -1 };
      this.spectate = spectate;
      if (!this.spectateBar) return spectate;
      this.spectateBar.hidden = !spectate.available;
      if (!spectate.available) return spectate;
      const following = spectate.following;
      if (this.spectateNameText) {
        this.spectateNameText.textContent = following
          ? (following.local ? `${following.username} · tu bola` : following.username)
          : '—';
      }
      if (this.spectateDot) {
        this.spectateDot.style.background = following?.color || 'transparent';
        this.spectateDot.style.color = following?.color || 'transparent';
      }
      if (this.spectateCount) this.spectateCount.textContent = `${Math.max(1, spectate.index + 1)}/${spectate.count}`;
      return spectate;
    }

    renderRows(rows) {
      if (!this.table || !this.session) return;
      const status = this.session.getStatus();
      const mode = (status.settings || {}).mode === 'battle' ? 'battle' : 'turn';
      const spectate = this.renderSpectate();
      this.table.classList.toggle('is-pickable', !!spectate.available);
      const limit = Math.min(rows.length, NG.NET_CONFIG.maxPlayers);
      const seen = new Set();

      for (let index = 0; index < limit; index += 1) {
        const row = rows[index];
        seen.add(row.playerKey);
        let node = this.rowNodes.get(row.playerKey);
        if (!node) {
          node = this.createRow();
          this.rowNodes.set(row.playerKey, node);
        }
        this.paintRow(node, row, mode, spectate);
        if (this.table.children[index] !== node.el) this.table.insertBefore(node.el, this.table.children[index] || null);
      }

      for (const [key, node] of [...this.rowNodes]) {
        if (seen.has(key)) continue;
        node.el.remove();
        this.rowNodes.delete(key);
      }
    }

    createRow() {
      const el = document.createElement('div');
      el.className = 'score-row';
      const rank = document.createElement('span'); rank.className = 'row-rank';
      const id = document.createElement('div'); id.className = 'row-id';
      const dot = document.createElement('i'); dot.className = 'player-color';
      const name = document.createElement('span'); name.className = 'player-name';
      const tag = document.createElement('b'); tag.className = 'row-tag'; tag.hidden = true;
      const ping = document.createElement('i'); ping.className = 'ping-dot';
      id.append(dot, name, tag, ping);
      const metric = document.createElement('span'); metric.className = 'row-metric';
      const points = document.createElement('strong'); points.className = 'row-points';
      const progress = document.createElement('div'); progress.className = 'row-progress'; progress.hidden = true;
      const progressFill = document.createElement('i'); progress.appendChild(progressFill);
      el.append(rank, id, metric, points, progress);
      const node = { el, rank, dot, name, tag, ping, metric, points, progress, progressFill, key: null };
      // La fila solo actúa como selector de cámara cuando la sesión lo marca
      // como observable; el resto del tiempo es un marcador y nada más.
      el.addEventListener('click', () => {
        if (el.dataset.pickable === '1' && node.key) this.pickSpectate(node.key);
      });
      return node;
    }

    paintRow(node, row, mode, spectate = { available: false, options: [], following: null }) {
      const q = quality(row.ping);
      const classes = ['score-row'];
      if (row.local) classes.push('is-local');
      if (row.turn) classes.push('is-turn');
      if (!row.connected) classes.push('is-offline');
      if (row.finished) classes.push('is-finished');
      if (row.rank <= 3) classes.push(`is-podium-${row.rank}`);
      const pickable = !!spectate.available && spectate.options.some((o) => o.playerKey === row.playerKey);
      if (spectate.available && spectate.following?.playerKey === row.playerKey) classes.push('is-spectated');
      const className = classes.join(' ');
      if (node.el.className !== className) node.el.className = className;
      node.key = row.playerKey;
      if (pickable) {
        node.el.dataset.pickable = '1';
        node.el.title = `Ver la cámara desde ${row.username}`;
      } else {
        delete node.el.dataset.pickable;
        node.el.removeAttribute('title');
      }

      node.rank.textContent = String(row.rank);
      node.dot.style.background = row.color;
      node.dot.style.color = row.color;
      node.name.textContent = row.username;

      const tag = row.role === 'spectator' ? 'ESP' : row.local ? 'TÚ' : '';
      if (tag) {
        node.tag.hidden = false;
        node.tag.textContent = tag;
        node.tag.dataset.tag = tag.toLowerCase();
      } else node.tag.hidden = true;

      node.ping.dataset.q = row.connected ? q.key : 'none';
      node.ping.title = Number.isFinite(row.ping) && row.ping > 0 ? `${Math.round(row.ping)} ms · ${q.label}` : 'Ping sin medir';

      if (this.metricMode === 'ping') {
        node.metric.textContent = Number.isFinite(row.ping) && row.ping > 0 ? `${Math.round(row.ping)}ms` : '—';
      } else {
        if (!row.finished) node.metric.textContent = `${row.strokes}g`;
        else if (row.finishReason === 'holed') node.metric.textContent = `✓ ${row.strokes}`;
        else if (row.finishReason === 'turn-limit') node.metric.textContent = `LÍM. ${row.strokes}`;
        else if (row.timedOut) node.metric.textContent = 'TIEMPO';
        else node.metric.textContent = '—';
      }
      node.points.textContent = formatInt(row.points);

      // El avance hacia el hoyo solo aporta información en Battle Royale,
      // donde todos se mueven a la vez.
      const showProgress = mode === 'battle' && row.role === 'player' && Number.isFinite(row.progress);
      node.progress.hidden = !showProgress;
      if (showProgress) {
        node.progress.style.color = row.color;
        node.progressFill.style.width = `${Math.round(Math.max(0, Math.min(1, row.progress)) * 100)}%`;
      }
    }

    showMatchOver(payload) {
      if (!this.session || this.matchOverShown) return;
      this.matchOverShown = true;
      const rows = payload?.standings || this.session.getStandings();
      const winner = rows.find((p) => p.playerKey === payload?.winnerPlayerKey) || rows[0];
      const localWon = !!winner?.local;

      if (this.matchOverTitle) this.matchOverTitle.textContent = localWon ? '¡Has ganado!' : (winner ? `Gana ${winner.username}` : 'Partida terminada');
      if (this.matchOverSub) {
        this.matchOverSub.textContent = winner
          ? `${formatInt(winner.points)} puntos alcanzados. Marcador final de la sala.`
          : 'Marcador final de la sala.';
      }
      if (this.matchOverRows) {
        this.matchOverRows.textContent = '';
        for (const row of rows) {
          const el = document.createElement('div');
          el.className = `matchover-row${row.playerKey === winner?.playerKey ? ' is-winner' : ''}${row.local ? ' is-local' : ''}`;
          const rank = document.createElement('span'); rank.className = 'row-rank'; rank.textContent = String(row.rank);
          const id = document.createElement('div'); id.className = 'row-id';
          const dot = document.createElement('i'); dot.className = 'player-color'; dot.style.background = row.color; dot.style.color = row.color;
          const name = document.createElement('span'); name.className = 'player-name'; name.textContent = row.username;
          id.append(dot, name);
          const strokes = document.createElement('span'); strokes.className = 'row-metric'; strokes.textContent = `${row.strokes}g`;
          const points = document.createElement('strong'); points.className = 'row-points'; points.textContent = formatInt(row.points);
          el.append(rank, id, strokes, points);
          this.matchOverRows.appendChild(el);
        }
      }
      this.matchOverPanel?.classList.remove('hidden');
    }
  }

  NG.NetworkHUD = NetworkHUD;
  NG.NetworkQuality = quality;
}(window.NoiseGolf = window.NoiseGolf || {}));
