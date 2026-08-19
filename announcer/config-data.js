window.NOISE_GOLF_ANNOUNCER_CONFIG = {
  schema: 'noise-golf-announcer-runtime-v1',
  version: '1.1.0',
  enabled: true,
  language: 'es-ES',
  sync: { leadSeconds: 0.32, maxLeadSeconds: 1.1, jitterMarginSeconds: 0.16, lateGraceMs: 900 },
  dialogue: { exchangeChance: 0.58, allowQuietFiller: true, quietBeforeFillerMs: 6200, fillerCooldownMs: 9000 },
  stateMachine: {
    idleAfterMs: 6200, informativeCooldownMs: 9000, aimLeaseMs: 60000,
    postMatchSummaryDelayMs: 1400, postMatchSummaryCooldownMs: 10000, postMatchSummaryMax: 2,
    guaranteedEvents: ['HOLE', 'HOLE_IN_ONE']
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
