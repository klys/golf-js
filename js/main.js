(function (NG) {
  'use strict';

  const BOOT_STEPS = [
    [0.25, 'Leyendo configuración local…'],
    [0.50, 'Generando terreno procedural…'],
    [0.75, 'Preparando interfaz…'],
    [1.00, 'Listo'],
  ];

  function bootProgress(step) {
    const [value, text] = BOOT_STEPS[Math.min(step, BOOT_STEPS.length - 1)];
    const bar = document.querySelector('#bootProgressBar');
    const status = document.querySelector('#bootStatus');
    if (bar) bar.style.width = `${value * 100}%`;
    if (status) status.textContent = text;
  }

  function hideBootScreen() {
    const boot = document.querySelector('#bootScreen');
    if (!boot) return;
    boot.classList.add('hidden');
    // Se retira del árbol al terminar la transición para no dejar una capa muerta.
    window.setTimeout(() => boot.remove(), 600);
  }

  async function boot() {
    try {
      bootProgress(0);
      if (NG.ClientEnv?.ready) await NG.ClientEnv.ready;
      if (NG.ApplyClientEnvConfig) NG.ApplyClientEnvConfig();

      // Antes que el juego: si se entra ya con zoom, la pantalla debe estar
      // tapada desde el primer frame, no después de generar el campo.
      const zoomGuard = NG.ZoomGuard ? new NG.ZoomGuard() : null;

      const canvas = document.querySelector('#game');
      if (!NG.GolfGame) throw new Error('GolfGame no se cargó. Revisa el orden de scripts.');
      if (!NG.PlayerProfile || !NG.MenuController || !NG.NetworkHUD) throw new Error('El frontend/networking no se cargó completamente.');

      bootProgress(1);
      const game = new NG.GolfGame(canvas);
      // Tapar la pantalla no basta: un arrastre a ciegas seguiría contando
      // como tiro, así que el juego suelta cualquier apunte en curso.
      if (zoomGuard) zoomGuard.onChange = (blocked) => { if (blocked) game.cancelDrag(); };
      const profile = new NG.PlayerProfile();
      const announcer = NG.AnnouncerSystem ? new NG.AnnouncerSystem(game, profile) : null;
      if (announcer) {
        await announcer.init();
        announcer.setLocalPlayerName(profile.username || 'Jugador');
        game.setAnnouncer(announcer);
      }

      bootProgress(2);
      const metrics = NG.MetricsOverlay ? new NG.MetricsOverlay(game) : null;
      const networkHud = new NG.NetworkHUD(game.hud);
      const menu = new NG.MenuController(game, profile, networkHud, metrics);

      game.start();
      // Latido de interfaz separado del render: 4 Hz basta para marcador,
      // métricas y votaciones, y no compite con el bucle de física.
      window.setInterval(() => menu.update(), 250);

      bootProgress(3);
      window.setTimeout(hideBootScreen, 260);

      window.__noiseGolf = game;
      window.__noiseGolfProfile = profile;
      window.__noiseGolfMenu = menu;
      window.__noiseGolfMetrics = metrics;
      window.__noiseGolfAnnouncer = announcer;
      window.__noiseGolfZoomGuard = zoomGuard;
      window.__noiseGolfReady = true;
    } catch (error) {
      console.error('[Noise Golf 2D] Error de arranque:', error);
      hideBootScreen();
      const panel = document.querySelector('#bootError');
      const detail = document.querySelector('#bootErrorDetail');
      if (panel) panel.classList.remove('hidden');
      if (detail) detail.textContent = error && error.message ? error.message : String(error);
      window.__noiseGolfReady = false;
    }
  }

  boot();
}(window.NoiseGolf = window.NoiseGolf || {}));
