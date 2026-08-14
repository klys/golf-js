(function (NG) {
  'use strict';

  class RelayClient {
    constructor(profile) {
      this.profile = profile;
      this.url = '';
      this.ws = null;
      this.clientId = null;
      this.iceServers = [];
      this.connected = false;
      this.connecting = false;
      this.manualClose = false;
      this.listeners = new Map();
      this.pending = new Map();
      this.seq = 0;
      this.lastRelayRtt = null;
      this.reconnectAttempt = 0;
      this.reconnectTimer = 0;
      this.lastWelcome = null;
    }

    on(type, handler) {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set());
      this.listeners.get(type).add(handler);
      return () => this.listeners.get(type)?.delete(handler);
    }

    emit(type, payload) {
      for (const fn of this.listeners.get(type) || []) {
        try { fn(payload); } catch (error) { console.error('[RelayClient listener]', error); }
      }
    }

    async connect(url, options = {}) {
      const target = String(url || this.profile.getRelayUrl() || NG.NET_CONFIG.defaultRelayUrl).trim();
      if (!/^wss?:\/\//i.test(target)) throw new Error('Dirección de relay inválida. Usa ws:// o wss://.');
      if (this.connected && this.url === target && this.ws?.readyState === WebSocket.OPEN) return this.lastWelcome;
      this.close(false);
      this.url = target;
      this.manualClose = false;
      this.connecting = true;
      const timeoutMs = options.timeoutMs || NG.NET_CONFIG.requestTimeoutMs;
      const started = performance.now();
      const welcome = await new Promise((resolve, reject) => {
        let settled = false;
        const ws = new WebSocket(target);
        this.ws = ws;
        const timer = window.setTimeout(() => {
          if (settled) return;
          settled = true;
          try { ws.close(); } catch (_) { /* noop */ }
          reject(new Error('El relay no respondió a tiempo.'));
        }, timeoutMs);
        ws.addEventListener('open', () => {
          this.sendRaw({
            v: NG.NET_CONFIG.protocolVersion,
            type: 'hello',
            payload: {
              playerKey: this.profile.playerKey,
              username: this.profile.username,
              clientVersion: NG.NET_CONFIG.clientVersion,
            },
          });
        });
        ws.addEventListener('message', (event) => {
          const msg = this.parse(event.data);
          if (!msg) return;
          if (!settled && msg.type === 'welcome') {
            settled = true;
            window.clearTimeout(timer);
            this.connected = true;
            this.connecting = false;
            this.clientId = msg.payload?.clientId || null;
            const envIce = NG.ClientEnv?.config?.publicIceServers;
            this.iceServers = Array.isArray(envIce) && envIce.length
              ? envIce.slice(0, 8)
              : (Array.isArray(msg.payload?.iceServers) ? msg.payload.iceServers : []);
            this.lastRelayRtt = Math.max(0, performance.now() - started);
            this.lastWelcome = msg.payload || {};
            this.reconnectAttempt = 0;
            resolve(this.lastWelcome);
          }
          this.handleMessage(msg);
        });
        ws.addEventListener('error', () => {
          if (!settled) {
            settled = true;
            window.clearTimeout(timer);
            reject(new Error('No fue posible conectar con el relay.'));
          }
        });
        ws.addEventListener('close', () => {
          window.clearTimeout(timer);
          const wasConnected = this.connected;
          this.connected = false;
          this.connecting = false;
          if (!settled) {
            settled = true;
            reject(new Error('El relay cerró la conexión durante el inicio.'));
          }
          this.rejectPending('Conexión con relay cerrada.');
          if (wasConnected) this.emit('disconnect', { url: this.url });
          if (!this.manualClose && options.autoReconnect !== false) this.scheduleReconnect();
        });
      });
      return welcome;
    }

    scheduleReconnect() {
      window.clearTimeout(this.reconnectTimer);
      const delay = Math.min(NG.NET_CONFIG.reconnectMaxMs, NG.NET_CONFIG.reconnectBaseMs * (2 ** this.reconnectAttempt));
      this.reconnectAttempt += 1;
      this.reconnectTimer = window.setTimeout(async () => {
        if (this.manualClose || this.connected || this.connecting) return;
        try {
          await this.connect(this.url, { autoReconnect: true });
          this.emit('reconnect', { url: this.url });
        } catch (_) {
          this.scheduleReconnect();
        }
      }, delay + Math.random() * 240);
    }

    parse(data) {
      try {
        const value = JSON.parse(String(data));
        return value && typeof value.type === 'string' ? value : null;
      } catch (_) { return null; }
    }

    handleMessage(msg) {
      if (msg.type === 'response' && msg.requestId) {
        const pending = this.pending.get(msg.requestId);
        if (!pending) return;
        this.pending.delete(msg.requestId);
        window.clearTimeout(pending.timer);
        if (msg.ok) pending.resolve(msg.payload);
        else pending.reject(new Error(msg.error || 'El relay rechazó la operación.'));
        return;
      }
      if (msg.type === 'host:probe') {
        this.send('probe:ack', {
          requesterClientId: msg.payload?.requesterClientId,
          nonce: msg.payload?.nonce,
          lobbyId: msg.payload?.lobbyId,
        });
        return;
      }
      this.emit(msg.type, msg.payload || {});
      this.emit('*', msg);
    }

    sendRaw(message) {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
      try { this.ws.send(JSON.stringify(message)); return true; } catch (_) { return false; }
    }

    send(type, payload = {}) {
      return this.sendRaw({ v: NG.NET_CONFIG.protocolVersion, type, payload });
    }

    request(type, payload = {}, timeoutMs = NG.NET_CONFIG.requestTimeoutMs) {
      if (!this.connected || !this.ws || this.ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Relay desconectado.'));
      const requestId = `${Date.now().toString(36)}-${(++this.seq).toString(36)}`;
      return new Promise((resolve, reject) => {
        const timer = window.setTimeout(() => {
          this.pending.delete(requestId);
          reject(new Error(`Tiempo agotado esperando ${type}.`));
        }, timeoutMs);
        this.pending.set(requestId, { resolve, reject, timer });
        if (!this.sendRaw({ v: NG.NET_CONFIG.protocolVersion, type, requestId, payload })) {
          window.clearTimeout(timer);
          this.pending.delete(requestId);
          reject(new Error('No se pudo enviar al relay.'));
        }
      });
    }

    async measureLobbyPing(lobbyId) {
      const nonce = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const t0 = performance.now();
      await this.request('probe', { lobbyId, nonce }, 4500);
      return Math.round(performance.now() - t0);
    }

    rejectPending(message) {
      for (const pending of this.pending.values()) {
        window.clearTimeout(pending.timer);
        pending.reject(new Error(message));
      }
      this.pending.clear();
    }

    close(manual = true) {
      this.manualClose = manual;
      window.clearTimeout(this.reconnectTimer);
      this.rejectPending('Conexión cerrada.');
      if (this.ws) {
        try { this.ws.close(1000, 'client-close'); } catch (_) { /* noop */ }
      }
      this.ws = null;
      this.connected = false;
      this.connecting = false;
    }
  }

  NG.RelayClient = RelayClient;
}(window.NoiseGolf = window.NoiseGolf || {}));
