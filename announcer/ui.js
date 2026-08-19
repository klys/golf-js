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

  NG.AnnouncerSettingsUI = AnnouncerSettingsUI;
  NG.AnnouncerSystem.prototype.bindMenu = function bindMenu(menu) {
    if (!this.settingsUI) this.settingsUI = new AnnouncerSettingsUI(this, menu);
    else this.settingsUI.render();
    return this.settingsUI;
  };
}(window.NoiseGolf = window.NoiseGolf || {}));
