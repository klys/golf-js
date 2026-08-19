(function (NG) {
  'use strict';

  const STORAGE_PROFILE = 'noiseGolf.profile.v1';
  const STORAGE_LAST = 'noiseGolf.lastSession.v1';

  function randomId(prefix) {
    const bytes = new Uint8Array(16);
    if (window.crypto && window.crypto.getRandomValues) window.crypto.getRandomValues(bytes);
    else for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
    return `${prefix}-${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
  }

  function safeStorageGet(key) {
    try { return window.localStorage ? window.localStorage.getItem(key) : null; } catch (_) { return null; }
  }
  function safeStorageSet(key, value) {
    try { if (window.localStorage) window.localStorage.setItem(key, value); return true; } catch (_) { return false; }
  }
  function safeStorageRemove(key) {
    try { if (window.localStorage) window.localStorage.removeItem(key); } catch (_) { /* noop */ }
  }
  function clone(value) {
    try { return JSON.parse(JSON.stringify(value)); } catch (_) { return null; }
  }

  class PlayerProfile {
    constructor() { this.data = this.load(); }

    load() {
      let parsed = null;
      try { parsed = JSON.parse(safeStorageGet(STORAGE_PROFILE) || 'null'); } catch (_) { parsed = null; }
      const playerKey = parsed && typeof parsed.playerKey === 'string' && parsed.playerKey.length >= 12
        ? parsed.playerKey : randomId('player');
      const username = parsed && typeof parsed.username === 'string' ? this.sanitizeName(parsed.username) : '';
      // Las preferencias locales del locutor forman parte del perfil del usuario.
      // No son estado de partida ni configuración del servidor y nunca se sincronizan.
      const announcer = parsed && parsed.announcer && typeof parsed.announcer === 'object' && !Array.isArray(parsed.announcer)
        ? clone(parsed.announcer) : null;
      const value = { playerKey, username, announcer };
      safeStorageSet(STORAGE_PROFILE, JSON.stringify(value));
      return value;
    }

    persist() { return safeStorageSet(STORAGE_PROFILE, JSON.stringify(this.data)); }

    sanitizeName(value) {
      return String(value || '').replace(/[<>\u0000-\u001f]/g, '').replace(/\s+/g, ' ').trim().slice(0, NG.NET_CONFIG.maxNameLength);
    }
    get playerKey() { return this.data.playerKey; }
    get username() { return this.data.username; }

    setUsername(value) {
      const username = this.sanitizeName(value);
      if (username.length < 2) throw new Error('El nombre debe tener al menos 2 caracteres.');
      this.data.username = username;
      this.persist();
      return username;
    }

    getAnnouncerSettings() {
      return this.data.announcer && typeof this.data.announcer === 'object' ? clone(this.data.announcer) : null;
    }

    setAnnouncerSettings(value) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return this.getAnnouncerSettings();
      this.data.announcer = clone(value) || {};
      this.persist();
      return this.getAnnouncerSettings();
    }

    getRelayUrl() { return String(NG.ClientEnv?.config?.relayUrl || NG.NET_CONFIG.defaultRelayUrl || '').trim(); }
    setRelayUrl(url) {
      const value = String(url || this.getRelayUrl()).trim();
      if (!/^wss?:\/\//i.test(value)) throw new Error('El relay configurado en config.json debe usar ws:// o wss://.');
      if (window.location?.protocol === 'https:' && /^ws:\/\//i.test(value)) {
        throw new Error('La web usa HTTPS: configura relayUrl con wss:// para evitar contenido mixto bloqueado por el navegador.');
      }
      return value;
    }

    getLastSession() {
      try {
        const value = JSON.parse(safeStorageGet(STORAGE_LAST) || 'null');
        if (!value || !value.lobbyId || !value.resumeToken || !value.relayUrl) return null;
        // Migración: reservas antiguas no públicas no son válidas en 0009.
        if (value.scope && value.scope !== 'public') { safeStorageRemove(STORAGE_LAST); return null; }
        return {
          lobbyId: String(value.lobbyId),
          lobbyName: String(value.lobbyName || 'Partida'),
          resumeToken: String(value.resumeToken),
          relayUrl: String(value.relayUrl),
          playerKey: String(value.playerKey || this.playerKey),
          savedAt: Number(value.savedAt) || 0,
          scope: 'public',
        };
      } catch (_) { return null; }
    }

    saveLastSession(value) {
      if (!value || !value.lobbyId || !value.resumeToken) return;
      safeStorageSet(STORAGE_LAST, JSON.stringify({
        lobbyId: value.lobbyId,
        lobbyName: String(value.lobbyName || 'Partida'),
        resumeToken: value.resumeToken,
        relayUrl: String(value.relayUrl || this.getRelayUrl()),
        playerKey: this.playerKey,
        scope: 'public',
        savedAt: Date.now(),
      }));
    }

    clearLastSession() { safeStorageRemove(STORAGE_LAST); }
  }

  NG.PlayerProfile = PlayerProfile;
}(window.NoiseGolf = window.NoiseGolf || {}));
