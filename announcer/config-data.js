// Generado desde announcer/config.json. Fallback para contextos sin fetch().
// Si editas config.json, regenera este archivo para mantenerlos equivalentes.
window.NOISE_GOLF_ANNOUNCER_CONFIG = {
  "schema": "noise-golf-announcer-runtime-v1",
  "version": "1.5.0",
  "enabled": true,
  "language": "es-ES",
  "sync": {
    "leadSeconds": 0.32,
    "lateGraceMs": 900,
    "maxLeadSeconds": 1.1,
    "jitterMarginSeconds": 0.16
  },
  "dialogue": {
    "exchangeChance": 0.58
  },
  "gameplay": {
    "shotWeakPower": 0.34,
    "shotStrongPower": 0.84,
    "shotPerfectMinPower": 0.62,
    "shotPerfectMaxPower": 0.78,
    "longShotMeters": 95,
    "nearMissMeters": 2.2,
    "collisionCueCooldownMs": 950,
    "chainCollisionWindowMs": 1700,
    "rivalryHeatHits": 2,
    "revengeHits": 3,
    "tauntChance": 0.26,
    "favoriteSwitchCooldownMs": 6500,
    "favoriteSwitchMargin": 1.25,
    "favoriteExtraLineChance": 0.42,
    "announceTurnStart": true
  },
  "socialNarrative": {
    "allowSpeculativeAlliance": false,
    "allowSpeculativeBetrayal": false
  },
  "stateMachine": {
    "aimLeaseMs": 60000,
    "postMatchSummaryDelayMs": 1400,
    "postMatchSummaryCooldownMs": 10000,
    "postMatchSummaryMax": 2,
    "guaranteedEvents": [
      "HOLE",
      "HOLE_IN_ONE"
    ]
  },
  "mapPresentation": {
    "enabled": true,
    "suppressGenericMatchStart": true,
    "silencePreFirstTouch": true,
    "recentMemory": 8,
    "introPriority": 96,
    "firstTouchPriority": 94,
    "persistentUntilSpoken": true
  },
  "flow": {
    "enabled": true,
    "burstWindowMs": 220,
    "maxLinesPerWindow": 6,
    "rateWindowMs": 15000,
    "semanticCooldownMs": 2600,
    "globalMinGapMs": 140,
    "staleShortMs": 1800,
    "staleLongMs": 4500,
    "staleDropMs": 9000,
    "yieldOnHigherClass": true,
    "speechBudget": 0.62
  },
  "focus": {
    "enabled": true,
    "offFocusPriorityScale": 0.55,
    "offFocusDemote": true,
    "minHoldMs": 3200,
    "switchCooldownMs": 15000,
    "switchAnnounceChance": 0.32
  },
  "modeProfiles": {
    "offline": {
      "dialogueScale": 1,
      "maxItems": 3,
      "maxWordsScale": 1,
      "maxLinesPerWindow": 5,
      "semanticCooldownMs": 2200,
      "focus": false,
      "focusMode": "local",
      "speechBudget": 0.5
    },
    "turn": {
      "dialogueScale": 1.35,
      "maxItems": 3,
      "maxWordsScale": 1.15,
      "maxLinesPerWindow": 5,
      "semanticCooldownMs": 2400,
      "focus": true,
      "focusMode": "turn",
      "eventOverrides": {
        "TURN_START": {
          "class": "important",
          "priority": 66,
          "mode": "opportunistic",
          "ttlMs": 2600
        }
      },
      "speechBudget": 0.55
    },
    "battle": {
      "dialogueScale": 0.45,
      "maxItems": 2,
      "maxWordsScale": 0.8,
      "maxLinesPerWindow": 7,
      "semanticCooldownMs": 3200,
      "burstWindowMs": 260,
      "focus": true,
      "focusMode": "relevance",
      "eventOverrides": {
        "AIMING": {
          "mode": "trace"
        },
        "BOUNCE": {
          "mode": "trace"
        },
        "MULTI_BOUNCE": {
          "mode": "trace"
        },
        "WALL_HIT": {
          "class": "progressive",
          "priority": 40,
          "mode": "trace"
        },
        "SAND_ENTER": {
          "mode": "trace"
        },
        "SAND_EXIT": {
          "mode": "trace"
        },
        "ICE_ENTER": {
          "mode": "trace"
        },
        "TUNNEL_ENTER": {
          "mode": "trace"
        },
        "SHOT_TAKEN": {
          "class": "progressive",
          "priority": 44,
          "mode": "opportunistic"
        },
        "SHOT_WEAK": {
          "class": "progressive",
          "priority": 44,
          "mode": "opportunistic"
        },
        "BOOSTER": {
          "class": "progressive",
          "priority": 46,
          "mode": "opportunistic"
        },
        "PORTAL_ENTER": {
          "class": "progressive",
          "priority": 50,
          "mode": "opportunistic"
        },
        "PLAYER_COLLISION": {
          "priority": 88
        }
      },
      "speechBudget": 0.72
    }
  },
  "derivedEvents": {
    "enabled": true,
    "tickMs": 260,
    "afkWaitMs": 14000,
    "slowPlayerMs": 24000,
    "streakGoodAt": 3,
    "streakBadAt": 3,
    "comebackRankGain": 2,
    "leadChangeMinGap": 1,
    "chainCollisionWindowMs": 1700,
    "sabotageBackfireWindowMs": 2600,
    "sabotageAttemptWindowMs": 2200,
    "rivalSaveProgressGain": 0.07,
    "scoreUpdateCooldownMs": 24000,
    "scoreEventCooldownMs": 9000,
    "airborneSpeed": 60,
    "highRiseSpeed": 190,
    "fastSpeed": 250,
    "fallSpeed": 200,
    "edgeSaveMeters": 1.7,
    "powerMaxThreshold": 0.97,
    "powerLowThreshold": 0.12,
    "badShotPower": 0.2,
    "badShotDistanceMeters": 28,
    "finalTurnMargin": 1,
    "afkEnabled": true,
    "allianceWindowMs": 4200,
    "allianceMemoryMs": 45000,
    "eliminationPairWindowMs": 2600,
    "ballCueCooldownMs": 5200
  },
  "booth": {
    "enabled": true,
    "disagreementChance": 0.22,
    "disagreementCooldownMs": 26000,
    "betChance": 0.3,
    "betCooldownMs": 34000,
    "betWindowMs": 16000,
    "agreementChance": 0.08,
    "favoriteBanterChance": 0.28,
    "favoriteBanterCooldownMs": 30000
  },
  "memory": {
    "enabled": true,
    "gagCooldownMs": 12000,
    "repeatEvery": 2,
    "thresholds": {
      "water": 3,
      "outOfBounds": 3,
      "reset": 3,
      "sabotageSuffered": 3,
      "sabotageDone": 3,
      "goodStreak": 3,
      "sand": 3,
      "nearMiss": 2
    }
  },
  "playerRivalry": {
    "enabled": true,
    "bornAtHits": 1,
    "escalateEvery": 2,
    "lineCooldownMs": 15000,
    "persistBetweenHoles": true
  }
};
