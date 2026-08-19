window.NOISE_GOLF_ANNOUNCER_CONFIG = {
  schema: 'noise-golf-announcer-runtime-v1',
  version: '1.4.0',
  enabled: true,
  language: 'es-ES',
  sync: { leadSeconds: 0.32, maxLeadSeconds: 1.1, jitterMarginSeconds: 0.16, lateGraceMs: 900 },
  dialogue: { exchangeChance: 0.58 },
  stateMachine: {
    aimLeaseMs: 60000,
    postMatchSummaryDelayMs: 1400, postMatchSummaryCooldownMs: 10000, postMatchSummaryMax: 2,
    guaranteedEvents: ['HOLE', 'HOLE_IN_ONE']
  },
  mapPresentation: {
    enabled: true, suppressGenericMatchStart: true, silencePreFirstTouch: true,
    recentMemory: 8, introPriority: 96, firstTouchPriority: 94, persistentUntilSpoken: true
  },
  gameplay: {
    shotWeakPower: 0.34, shotStrongPower: 0.84, shotPerfectMinPower: 0.62, shotPerfectMaxPower: 0.78,
    ballFastSpeed: 760, ballHighRiseSpeed: 650, longShotMeters: 95, nearMissMeters: 2.2,
    collisionCueCooldownMs: 950, chainCollisionWindowMs: 1700, rivalryHeatHits: 2, revengeHits: 3,
    tauntChance: 0.26, favoriteSwitchCooldownMs: 6500, favoriteSwitchMargin: 1.25,
    favoriteExtraLineChance: 0.42, announceTurnStart: true
  },
  socialNarrative: { allowSpeculativeAlliance: false, allowSpeculativeBetrayal: false }
};
