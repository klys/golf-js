(function (NG) {
  'use strict';

  class AnnouncerSettingsUI {
    constructor(system, menu) {
      this.system = system;
      this.menu = menu;
      this.bound = false;
      this.onVoices = () => this.renderVoices();
      this.bind();
      this.render();
    }

    bind() {
      if (this.bound) return;
      this.bound = true;
      document.querySelector('#announcerSettingsBtn')?.addEventListener('click', () => {
        this.render();
        this.menu.showScreen('announcers');
      });
      for (const speaker of ['commentator', 'informant']) {
        const name = document.querySelector(`#announcer-${speaker}-name`);
        const voice = document.querySelector(`#announcer-${speaker}-voice`);
        const pitch = document.querySelector(`#announcer-${speaker}-pitch`);
        const rate = document.querySelector(`#announcer-${speaker}-rate`);
        name?.addEventListener('change', () => this.commitSpeaker(speaker));
        voice?.addEventListener('change', () => this.commitSpeaker(speaker));
        pitch?.addEventListener('input', () => { this.commitSpeaker(speaker); this.renderValues(); });
        rate?.addEventListener('input', () => { this.commitSpeaker(speaker); this.renderValues(); });
      }
      document.querySelector('#announcerSharedVolume')?.addEventListener('input', (event) => {
        this.system.updateSettings({ sharedVolume: Number(event.target.value) / 100 });
        this.renderValues();
      });
      window.addEventListener('noisegolf:announcer-voices', this.onVoices);
    }

    commitSpeaker(speaker) {
      const value = {
        name: document.querySelector(`#announcer-${speaker}-name`)?.value || '',
        voiceURI: document.querySelector(`#announcer-${speaker}-voice`)?.value || '',
        pitch: Number(document.querySelector(`#announcer-${speaker}-pitch`)?.value || 1),
        rate: Number(document.querySelector(`#announcer-${speaker}-rate`)?.value || 1),
      };
      this.system.updateSettings({ [speaker]: value });
    }

    render() {
      const settings = this.system.getSettings();
      for (const speaker of ['commentator', 'informant']) {
        const name = document.querySelector(`#announcer-${speaker}-name`);
        const pitch = document.querySelector(`#announcer-${speaker}-pitch`);
        const rate = document.querySelector(`#announcer-${speaker}-rate`);
        if (name && document.activeElement !== name) name.value = settings[speaker].name;
        if (pitch && document.activeElement !== pitch) pitch.value = String(settings[speaker].pitch);
        if (rate && document.activeElement !== rate) rate.value = String(settings[speaker].rate);
      }
      const volume = document.querySelector('#announcerSharedVolume');
      if (volume && document.activeElement !== volume) volume.value = String(Math.round(settings.sharedVolume * 100));
      this.renderVoices();
      this.renderValues();
    }

    renderVoices() {
      const settings = this.system.getSettings();
      const voices = this.system.refreshVoices();
      for (const speaker of ['commentator', 'informant']) {
        const select = document.querySelector(`#announcer-${speaker}-voice`);
        if (!select) continue;
        const current = settings[speaker].voiceURI || '';
        select.innerHTML = '';
        const automatic = document.createElement('option');
        automatic.value = '';
        automatic.textContent = 'Automática · español';
        select.appendChild(automatic);
        const preferred = voices.filter((voice) => /^es(?:-|_)/i.test(voice.lang || ''));
        const rest = voices.filter((voice) => !/^es(?:-|_)/i.test(voice.lang || ''));
        for (const voice of [...preferred, ...rest]) {
          const option = document.createElement('option');
          option.value = voice.voiceURI;
          option.textContent = `${voice.name} · ${voice.lang || 'sin idioma'}`;
          select.appendChild(option);
        }
        select.value = [...select.options].some((option) => option.value === current) ? current : '';
      }
    }

    renderValues() {
      const settings = this.system.getSettings();
      for (const speaker of ['commentator', 'informant']) {
        const pitch = document.querySelector(`#announcer-${speaker}-pitch-value`);
        const rate = document.querySelector(`#announcer-${speaker}-rate-value`);
        if (pitch) pitch.textContent = `${settings[speaker].pitch.toFixed(2)}×`;
        if (rate) rate.textContent = `${settings[speaker].rate.toFixed(2)}×`;
      }
      const volume = document.querySelector('#announcerSharedVolumeValue');
      if (volume) volume.textContent = `${Math.round(settings.sharedVolume * 100)}%`;
    }
  }

  class AnnouncerTranscriptUI {
    constructor(system) {
      this.system = system;
      this.root = document.querySelector('#announcerLivePanel');
      this.toggle = document.querySelector('#announcerLiveToggle');
      this.preview = document.querySelector('#announcerLivePreview');
      this.linesRoot = document.querySelector('#announcerLiveLines');
      this.empty = document.querySelector('#announcerLiveEmpty');
      this.history = [];
      this.maxHistory = 8;
      this.activeLine = null;
      this.matchActive = false;
      this.bound = false;
      this.bind();
      this.applyCollapsed(Boolean(this.system.getSettings()?.captionsCollapsed), false);
      this.setMatchActive(Boolean(this.system.matchActive));
      this.render();
    }

    bind() {
      if (this.bound || !this.root) return;
      this.bound = true;
      this.toggle?.addEventListener('click', () => {
        const collapsed = this.root.dataset.collapsed !== 'true';
        this.applyCollapsed(collapsed, true);
      });
      window.addEventListener('noisegolf:announcer-line', (event) => this.onLine(event.detail || {}));
      window.addEventListener('noisegolf:announcer-matchactive', (event) => this.setMatchActive(Boolean(event.detail?.active)));
      window.addEventListener('noisegolf:announcer-settings', (event) => {
        if (event.detail && Object.prototype.hasOwnProperty.call(event.detail, 'captionsCollapsed')) {
          this.applyCollapsed(Boolean(event.detail.captionsCollapsed), false);
        }
      });
    }

    setMatchActive(active) {
      if (!this.root) return;
      const wasActive = this.matchActive;
      this.matchActive = Boolean(active);
      this.root.classList.toggle('hidden', !this.matchActive);
      if (this.matchActive && !wasActive) {
        this.history.length = 0;
        this.activeLine = null;
        this.root.dataset.speaking = 'false';
        this.render();
      }
      if (!this.matchActive) {
        this.root.dataset.speaking = 'false';
        this.activeLine = null;
      }
    }

    applyCollapsed(collapsed, persist) {
      if (!this.root) return;
      this.root.dataset.collapsed = collapsed ? 'true' : 'false';
      this.toggle?.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
      this.toggle?.setAttribute('aria-label', collapsed ? 'Desplegar locución en vivo' : 'Plegar locución en vivo');
      this.toggle?.setAttribute('title', collapsed ? 'Desplegar locución' : 'Plegar locución');
      if (persist) this.system.updateSettings({ captionsCollapsed: collapsed });
    }

    onLine(detail) {
      const text = String(detail.text || '').trim();
      if (!text) return;
      if (detail.state === 'end') {
        if (this.activeLine && this.activeLine.text === text && this.activeLine.speaker === detail.speaker) {
          this.activeLine = null;
          if (this.root) this.root.dataset.speaking = 'false';
        }
        return;
      }
      if (detail.state !== 'start') return;
      const line = {
        speaker: detail.speaker === 'informant' ? 'informant' : 'commentator',
        speakerName: String(detail.speakerName || (detail.speaker === 'informant' ? 'Álex Prisma' : 'Rafa Voltio')),
        text,
        eventLabel: String(detail.eventLabel || detail.eventKey || ''),
        at: Number(detail.at) || Date.now(),
      };
      this.activeLine = line;
      this.history.push(line);
      if (this.history.length > this.maxHistory) this.history.splice(0, this.history.length - this.maxHistory);
      if (this.root) this.root.dataset.speaking = 'true';
      this.render();
    }

    render() {
      if (!this.linesRoot) return;
      this.linesRoot.innerHTML = '';
      const lines = this.history.slice().reverse();
      if (this.empty) this.empty.hidden = lines.length > 0;
      for (const line of lines) {
        const row = document.createElement('div');
        row.className = 'announcer-live-line';
        row.dataset.speaker = line.speaker;
        const meta = document.createElement('div');
        meta.className = 'announcer-live-meta';
        const name = document.createElement('strong');
        name.textContent = line.speakerName;
        const event = document.createElement('small');
        event.textContent = line.eventLabel || 'LOCUCIÓN';
        meta.append(name, event);
        const text = document.createElement('p');
        text.textContent = line.text;
        row.append(meta, text);
        this.linesRoot.appendChild(row);
      }
      const latest = this.history[this.history.length - 1];
      if (this.preview) this.preview.textContent = latest ? `${latest.speakerName}: ${latest.text}` : 'Esperando la primera intervención…';
    }
  }

  NG.AnnouncerSettingsUI = AnnouncerSettingsUI;
  NG.AnnouncerTranscriptUI = AnnouncerTranscriptUI;
  NG.AnnouncerSystem.prototype.bindMenu = function bindMenu(menu) {
    if (!this.settingsUI) this.settingsUI = new AnnouncerSettingsUI(this, menu);
    else this.settingsUI.render();
    if (!this.transcriptUI) this.transcriptUI = new AnnouncerTranscriptUI(this);
    return this.settingsUI;
  };
}(window.NoiseGolf = window.NoiseGolf || {}));
