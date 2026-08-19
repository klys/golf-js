(function (NG) {
  'use strict';

  const CLASS_RANK = Object.freeze({ ambient: 1, progressive: 2, important: 3, critical: 4, manual: 0 });
  const clamp = (v, min, max) => Math.min(max, Math.max(min, Number(v) || 0));
  const chance = (p) => Math.random() < clamp(p, 0, 1);
  const pick = (arr) => Array.isArray(arr) && arr.length ? arr[Math.floor(Math.random() * arr.length)] : '';
  const sleep = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));
  const clone = (value) => JSON.parse(JSON.stringify(value));

  function normalizedWords(text) {
    return String(text || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9ñáéíóúü]+/gi, ' ').trim().split(/\s+/).filter(Boolean);
  }

  function similarity(a, b) {
    const A = new Set(normalizedWords(a));
    const B = new Set(normalizedWords(b));
    if (!A.size || !B.size) return 0;
    let shared = 0;
    for (const word of A) if (B.has(word)) shared += 1;
    return shared / Math.max(A.size, B.size);
  }

  function weightedChoice(weights) {
    const entries = Object.entries(weights || {}).filter(([, value]) => Number(value) > 0);
    const total = entries.reduce((sum, [, value]) => sum + Number(value), 0);
    if (!total) return entries[0]?.[0] || 'neutral';
    let cursor = Math.random() * total;
    for (const [key, value] of entries) {
      cursor -= Number(value);
      if (cursor <= 0) return key;
    }
    return entries[entries.length - 1]?.[0] || 'neutral';
  }

  function ensureTerminalText(text) {
    let out = String(text || '').replace(/\s+/g, ' ').replace(/\s+([,.;:!?])/g, '$1').trim();
    if (!out) return '';
    out = out.replace(/\.{2,}/g, (dots) => dots.length >= 3 ? '...' : '.');
    out = out.replace(/([!?…])\.+/g, '$1').replace(/\.(?=[!?…])/g, '');
    out = out.replace(/[:;,]\s*$/, '.');
    if (!/[.!?…]["'”’)]?$/.test(out)) out += '.';
    return out;
  }

  function splitCompleteSentences(text) {
    const clean = String(text || '').replace(/\s+/g, ' ').trim();
    if (!clean) return [];
    const matches = clean.match(/[^.!?…]+[.!?…]+["'”’)]*|[^.!?…]+$/g) || [clean];
    return matches.map((value) => ensureTerminalText(value.trim())).filter(Boolean);
  }

  function joinCompleteText(...parts) {
    return ensureTerminalText(parts.filter(Boolean).map((value) => ensureTerminalText(value)).join(' '));
  }

  function trimAfterPartnerCue(text, partnerName = 'Álex') {
    const sentences = splitCompleteSentences(text);
    const needle = String(partnerName || '').toLowerCase();
    const index = sentences.findIndex((sentence) => sentence.toLowerCase().includes(needle));
    if (index < 0) return ensureTerminalText(text);
    return ensureTerminalText(sentences.slice(0, index + 1).join(' '));
  }

  function looksIncomplete(text) {
    const clean = String(text || '').trim();
    if (!clean || /[:;,]\s*$/.test(clean)) return true;
    const bare = clean.replace(/[.!?…"'”’)]*\s*$/, '').trim();
    return /\b(y|o|pero|porque|que|de|del|con|para|por|sin|aunque|mientras|como|si|cuando|donde|a|al|en|la|el|un|una)$/i.test(bare);
  }

  function speechChunks(text, maxChars = 230) {
    const sentences = splitCompleteSentences(text);
    const chunks = [];
    let current = '';
    for (const sentence of sentences) {
      const candidate = current ? `${current} ${sentence}` : sentence;
      if (current && candidate.length > maxChars) {
        chunks.push(current);
        current = sentence;
      } else current = candidate;
    }
    if (current) chunks.push(current);
    return chunks;
  }

  function eventPolicy(configs, eventKey) {
    return configs?.commentator?.events?.[eventKey]?.delivery || {
      class: 'ambient', priority: 20, ttlMs: 1000, mode: 'filler', dedupeMs: 700,
      preempt: 'none', nearEndMs: 0, maxWords: 24, partnerChance: 0.15, cooldownMs: 1800,
    };
  }

  class PersonaEngine {
    constructor(key, config) {
      this.key = key;
      this.config = config;
      this.recentPhrases = [];
      this.recentFragments = [];
    }

    resetMemory() {
      this.recentPhrases.length = 0;
      this.recentFragments.length = 0;
    }

    settings() {
      return {
        profile: this.config.generation?.defaultProfile || Object.keys(this.config.personalityProfiles || {})[0],
        tone: 'auto',
        creativity: clamp(this.config.generation?.creativity ?? 0.72, 0, 1),
        sarcasm: clamp(this.config.generation?.sarcasmStrength ?? 0.65, 0, 1),
      };
    }

    chooseFresh(list, tag = 'fragment') {
      if (!Array.isArray(list) || !list.length) return '';
      const recentWindow = this.config.generation?.recentFragmentMemory || 20;
      const blocked = new Set(this.recentFragments.slice(-recentWindow).map((item) => item.text));
      let candidates = list.filter((value) => !blocked.has(value));
      if (!candidates.length) candidates = list;
      const text = pick(candidates);
      this.recentFragments.push({ tag, text });
      if (this.recentFragments.length > recentWindow * 3) {
        this.recentFragments.splice(0, this.recentFragments.length - recentWindow * 2);
      }
      return text;
    }

    chooseTone(eventKey, forcedTone = null) {
      if (forcedTone && forcedTone !== 'auto' && this.config.tones?.[forcedTone]) return forcedTone;
      const event = this.config.events?.[eventKey] || this.config.events?.TURN_START || {};
      const settings = this.settings();
      const weights = { ...(event.toneWeights || { neutral: 1 }) };
      const profile = this.config.personalityProfiles?.[settings.profile] || {};
      for (const [tone, bias] of Object.entries(profile.toneBias || {})) {
        if (weights[tone] != null) weights[tone] *= Number(bias);
      }
      if (weights.sarcastic != null) weights.sarcastic *= 0.65 + settings.sarcasm * 2.1;
      if (weights.mocking != null) weights.mocking *= 0.55 + settings.sarcasm * 1.8;
      return weightedChoice(weights);
    }

    contextTokens(ctx) {
      const distance = Math.max(0, Number(ctx.distance || 0));
      return {
        player: ctx.player || 'el jugador', turn: String(ctx.turn || 1),
        distance: `${distance > 0 && distance < 2 ? distance.toFixed(2) : Math.round(distance)} m`,
        speed: `${Math.max(0, Math.round(ctx.speed || 0))} km/h`,
        height: `${Math.max(0, Math.round(ctx.height || 0))} m`, bounces: String(ctx.bounces || 0),
        water_count: String(ctx.waterCount || 0), score: ctx.score || 'sin cambios',
        leader: ctx.leader || ctx.player || 'el jugador', hazard: ctx.hazard || 'el obstáculo',
        previous_event_label: ctx.previousEventLabel || 'la jugada anterior', previous_result: ctx.previousResult || 'el estado anterior',
        good_streak: String(ctx.goodStreak || 0), bad_streak: String(ctx.badStreak || 0), streak_text: ctx.streakText || 'neutral',
        opponent: ctx.opponent || 'su rival', attacker: ctx.attacker || ctx.player || 'el atacante', victim: ctx.victim || ctx.opponent || 'el rival',
        eliminated_player: ctx.eliminatedPlayer || ctx.victim || 'el eliminado', alliance_partner: ctx.alliancePartner || ctx.opponent || 'su aliado temporal',
        survivor_count: String(ctx.survivorCount || 0), survivors: ctx.survivors || '', rafa_favorite: ctx.rafaFavorite || 'sin favorito',
        alex_favorite: ctx.alexFavorite || 'sin favorito', favorite: ctx.favorite || ctx.rafaFavorite || ctx.player || 'el favorito',
        favorite_owner: ctx.favoriteOwner || 'la cabina', favorite_reason: ctx.favoriteReason || 'su rendimiento reciente',
        rivalry_level: String(ctx.rivalryLevel || 0), battle_rank: String(ctx.battleRank || 0),
      };
    }

    fill(text, ctx) {
      const tokens = this.contextTokens(ctx);
      let out = String(text || '').replace(/\{([a-z_]+)\}/gi, (match, key) => tokens[key] ?? '');
      out = out.replace(/\s+/g, ' ').replace(/\s+([,.;:!?])/g, '$1').trim();
      out = out.replace(/(^|[.!?…]\s+)([¡¿"'“‘]*)([a-záéíóúüñ])/gi, (_, prefix, marks, letter) => prefix + marks + letter.toUpperCase());
      out = out.replace(/\.\s*\./g, '.').replace(/;\s*;/g, ';');
      return ensureTerminalText(out);
    }

    semanticKey(event) { return event?.semanticClass || 'general'; }
    semanticBank(event) { return this.config.semanticBanks?.[this.semanticKey(event)] || {}; }

    chooseSegment(event, toneBank, kind, tag) {
      const semantic = this.semanticBank(event)?.[kind] || [];
      const tonal = toneBank?.[kind] || [];
      const bias = clamp(this.config.generation?.semanticBias ?? 0.72, 0, 1);
      if ((kind === 'tails' || kind === 'reactions') && semantic.length) return this.chooseFresh(semantic, `${tag}:semantic-locked`);
      if (semantic.length && (!tonal.length || chance(bias))) return this.chooseFresh(semantic, `${tag}:semantic`);
      if (tonal.length) return this.chooseFresh(tonal, `${tag}:tone`);
      return this.chooseFresh(semantic, `${tag}:semantic-fallback`);
    }

    compose(eventKey, ctx, options = {}) {
      const event = this.config.events?.[eventKey] || this.config.events?.TURN_START || { label: eventKey, cores: [eventKey] };
      const tone = this.chooseTone(eventKey, options.tone);
      const bank = this.config.tones?.[tone] || this.config.tones?.neutral || {};
      const settings = this.settings();
      const maxWords = Number(options.maxWords || 0);
      const compact = Boolean(options.compact);
      let patterns = compact
        ? (this.config.generation?.compactPatterns || ['{core}', '{lead} {core}', '{core}. {tail}'])
        : (this.config.generation?.sentencePatterns || ['{lead} {core}', '{core}. {tail}', '{lead} {core}. {tail}']);
      if (!compact) {
        if (settings.creativity < 0.30) patterns = patterns.slice(0, 2);
        else if (settings.creativity < 0.60) patterns = patterns.slice(0, Math.max(3, Math.ceil(patterns.length * 0.75)));
      }

      const attempts = Number(this.config.generation?.coherenceAttempts || 20);
      let best = '';
      let bestScore = -Infinity;
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        const core = this.chooseFresh(event.cores || [], `${eventKey}:core`);
        const lead = this.chooseSegment(event, bank, 'leads', `${eventKey}:${tone}:lead`);
        const tail = this.chooseSegment(event, bank, 'tails', `${eventKey}:${tone}:tail`);
        const reaction = this.chooseSegment(event, bank, 'reactions', `${eventKey}:${tone}:reaction`);
        const pattern = pick(patterns);
        let sentence = String(pattern || '{core}')
          .replaceAll('{lead}', lead).replaceAll('{core}', core).replaceAll('{tail}', tail).replaceAll('{reaction}', reaction);
        sentence = ensureTerminalText(this.fill(sentence, ctx).replace(/([.!?])\s*\1+/g, '$1'));
        const wordCount = normalizedWords(sentence).length;
        const tooSimilar = this.recentPhrases.slice(-(this.config.generation?.recentPhraseMemory || 18))
          .some((previous) => similarity(sentence, previous) > 0.73);
        const localRepeat = Math.max(similarity(lead, core), similarity(core, tail), similarity(lead, tail));
        let score = 100;
        if (looksIncomplete(sentence)) score -= 1000;
        if (tooSimilar) score -= 35;
        if (localRepeat > 0.56) score -= 42 + (localRepeat - 0.56) * 80;
        if (maxWords) score -= Math.max(0, wordCount - maxWords) * 2.4;
        if (wordCount < 7) score -= 8;
        if (score > bestScore) { best = sentence; bestScore = score; }
        if (score >= 100 && (!maxWords || wordCount <= maxWords)) break;
      }
      best = ensureTerminalText(best || this.fill(this.chooseFresh(event.cores || [eventKey], `${eventKey}:fallback`), ctx));
      this.recentPhrases.push(best);
      const max = (this.config.generation?.recentPhraseMemory || 18) * 3;
      if (this.recentPhrases.length > max) this.recentPhrases.splice(0, Math.ceil(this.recentPhrases.length - max * 0.7));
      return { text: best, tone, eventKey, eventLabel: event.label || eventKey, semanticClass: this.semanticKey(event) };
    }

    question(eventKey, ctx) {
      const event = this.config.events?.[eventKey] || {};
      const semantic = this.semanticKey(event);
      const bySemantic = this.config.interaction?.questionsBySemantic?.[semantic] || [];
      const list = event.questions?.length ? event.questions : (bySemantic.length ? bySemantic : this.config.interaction?.genericQuestions || []);
      return ensureTerminalText(this.fill(this.chooseFresh(list, `${eventKey}:question`), ctx));
    }

    answer(eventKey, ctx, options = {}) {
      const event = this.config.events?.[eventKey] || this.config.events?.SCORE_UPDATE || {};
      const semantic = this.semanticKey(event);
      const tone = this.chooseTone(eventKey, options.tone || 'auto');
      const bank = this.config.tones?.[tone] || this.config.tones?.informative || {};
      const semanticBank = this.semanticBank(event);
      const semanticStarters = this.config.interaction?.answerStartersBySemantic?.[semantic] || [];
      const starters = event.answerStarters?.length ? event.answerStarters : (semanticStarters.length ? semanticStarters : this.config.interaction?.answerStarters || []);
      const starter = this.chooseFresh(starters, `${eventKey}:answerStarter`);
      const core = this.chooseFresh(event.answers?.length ? event.answers : event.cores || [], `${eventKey}:answerCore`);
      const tailPool = semanticBank.tails?.length ? semanticBank.tails : bank.tails || [];
      const tail = this.chooseFresh(tailPool, `${semantic}:answerTail`);
      const patterns = this.config.generation?.answerPatterns || ['{answerStarter} {core}', '{answerStarter} {core}. {tail}'];
      const maxWords = Number(options.maxWords || 30);
      let best = '';
      let bestScore = -Infinity;
      for (let attempt = 0; attempt < 14; attempt += 1) {
        const sentence = ensureTerminalText(this.fill(pick(patterns)
          .replaceAll('{answerStarter}', starter).replaceAll('{core}', core).replaceAll('{tail}', tail), ctx));
        const words = normalizedWords(sentence).length;
        const score = 100 - Math.max(0, words - maxWords) * 2.2 - (looksIncomplete(sentence) ? 1000 : 0);
        if (score > bestScore) { best = sentence; bestScore = score; }
        if (score >= 100) break;
      }
      best = ensureTerminalText(best);
      this.recentPhrases.push(best);
      return { text: best, tone, eventKey, eventLabel: event.label || eventKey, semanticClass: semantic };
    }

    comment(eventKey, ctx, options = {}) {
      const event = this.config.events?.[eventKey] || this.config.events?.SCORE_UPDATE || {};
      const semantic = this.semanticKey(event);
      const starters = this.config.interaction?.unsolicitedStartersBySemantic?.[semantic] || this.config.interaction?.answerStarters || [];
      const starter = this.chooseFresh(starters, `${semantic}:unsolicitedStarter`);
      const core = this.chooseFresh(event.answers?.length ? event.answers : event.cores || [], `${eventKey}:unsolicitedCore`);
      return {
        text: ensureTerminalText(this.fill(`${starter} ${core}`, ctx)), tone: this.chooseTone(eventKey, options.tone || 'auto'),
        eventKey, eventLabel: event.label || eventKey, semanticClass: semantic,
      };
    }

    acknowledgement(eventKey, ctx) {
      const event = this.config.events?.[eventKey] || {};
      const semantic = this.semanticKey(event);
      const semanticList = this.config.interaction?.afterAnswerBySemantic?.[semantic] || [];
      const list = semanticList.length ? semanticList : (this.config.interaction?.afterAnswerReactions || this.config.interaction?.closingToPartner || []);
      return {
        text: ensureTerminalText(this.fill(this.chooseFresh(list, `${semantic}:ack`), ctx)), tone: 'sarcastic',
        eventKey: 'DIALOGUE_ACK', eventLabel: 'Cierre entre locutores', semanticClass: semantic,
      };
    }
  }

  class AnnouncerComposer {
    constructor(personas, runtimeConfig) {
      this.personas = personas;
      this.runtimeConfig = runtimeConfig || {};
      this.engines = {
        commentator: new PersonaEngine('commentator', personas.commentator),
        informant: new PersonaEngine('informant', personas.informant),
      };
    }

    reset() {
      this.engines.commentator.resetMemory();
      this.engines.informant.resetMemory();
    }

    policy(eventKey) { return clone(eventPolicy(this.personas, eventKey)); }

    buildBundle(eventKey, context, source = 'game') {
      const policy = this.policy(eventKey);
      const exchange = clamp(this.runtimeConfig.dialogue?.exchangeChance ?? 0.58, 0, 1);
      const eventCfg = this.personas.commentator.events?.[eventKey] || {};
      const askBase = Number(eventCfg.askChance || 0);
      const partnerChance = Number(policy.partnerChance ?? 0.15);
      const plannedAsk = chance(clamp(askBase * 0.55 + exchange * partnerChance, 0, 0.58));
      const main = this.engines.commentator.compose(eventKey, context, { maxWords: Number(policy.maxWords || 24), compact: plannedAsk });
      main.speaker = 'commentator';
      const items = [];
      const embeddedInvite = /álex/i.test(main.text) && (/\?/.test(main.text) || /\b(dime|confirma|explica|ponle|traduce|lectura)\b/i.test(main.text));
      const shouldAsk = plannedAsk || embeddedInvite;

      if (shouldAsk) {
        if (embeddedInvite) main.text = trimAfterPartnerCue(main.text, 'Álex');
        if (!embeddedInvite) main.text = joinCompleteText(main.text, this.engines.commentator.question(eventKey, context));
        items.push(main);
        const answer = this.engines.informant.answer(eventKey, context, { maxWords: 30 });
        answer.speaker = 'informant';
        items.push(answer);
        if (chance(clamp(exchange * 0.48 + partnerChance * 0.18, 0, 0.55))) {
          const ack = this.engines.commentator.acknowledgement(eventKey, context);
          ack.speaker = 'commentator';
          items.push(ack);
        }
      } else {
        items.push(main);
        if (chance(exchange * partnerChance) && policy.class !== 'progressive') {
          const info = this.engines.informant.comment(eventKey, context, { maxWords: 28 });
          info.speaker = 'informant';
          items.push(info);
          if (chance(clamp(exchange * 0.22, 0, 0.24))) {
            const ack = this.engines.commentator.acknowledgement(eventKey, context);
            ack.speaker = 'commentator';
            items.push(ack);
          }
        }
      }

      const now = Date.now();
      return {
        id: `ann-${now}-${Math.random().toString(36).slice(2)}`,
        eventKey, eventAt: now, expiresAt: now + Number(policy.ttlMs || 1200),
        conversationExpiresAt: now + Math.max(Number(policy.ttlMs || 1200) + 2600, 4200),
        player: context.player || '', source, policy, context: clone(context), items: items.filter((item) => item?.text),
      };
    }

    buildExtraItem(eventKey, context, speaker = 'commentator') {
      const engine = this.engines[speaker] || this.engines.commentator;
      const result = engine.compose(eventKey, context, { compact: true, maxWords: 24 });
      result.speaker = speaker;
      return result;
    }
  }

  class SpeechDirector {
    constructor(system) {
      this.system = system;
      this.currentBundle = null;
      this.current = null;
      this.hotSlot = null;
      this.session = 0;
      this.estimatedBundleEndAt = 0;
      this.stats = { spoken: 0, expired: 0, replaced: 0, folded: 0 };
    }

    estimateSpeechMs(text, speaker = 'commentator') {
      const words = normalizedWords(text).length || 1;
      const rate = Math.max(0.45, Number(this.system.getSpeakerSettings(speaker).rate) || 1);
      return clamp((words / (2.55 * rate)) * 1000 + 280, 650, 9000);
    }

    submitBundle(bundle) {
      if (!bundle?.items?.length || !this.system.enabled) return { accepted: false, reason: 'disabled-or-empty' };
      const now = Date.now();
      if (now > Number(bundle.expiresAt || Infinity)) return this.drop(bundle, 'expired');
      if (!this.currentBundle) {
        this.startBundle(bundle);
        return { accepted: true, reason: 'idle' };
      }
      const policy = bundle.policy || {};
      if (policy.class === 'ambient') return this.drop(bundle, 'busy-filler');
      const remaining = Math.max(0, this.estimatedBundleEndAt - now);
      const rank = CLASS_RANK[policy.class] || 0;
      if (now + remaining <= Number(bundle.expiresAt || 0) && rank >= CLASS_RANK.important) {
        this.setHot(bundle);
        return { accepted: true, reason: 'hot-slot' };
      }
      return this.drop(bundle, 'expired-before-mic');
    }

    setHot(bundle) {
      if (!this.hotSlot) { this.hotSlot = bundle; return; }
      const old = this.hotSlot;
      const oldScore = (CLASS_RANK[old.policy?.class] || 0) * 100 + Number(old.policy?.priority || 0);
      const newScore = (CLASS_RANK[bundle.policy?.class] || 0) * 100 + Number(bundle.policy?.priority || 0);
      if (newScore > oldScore || (newScore === oldScore && Number(bundle.eventAt || 0) > Number(old.eventAt || 0))) {
        this.hotSlot = bundle;
        this.stats.replaced += 1;
      } else this.drop(bundle, 'lost-hot-slot');
    }

    drop(bundle, reason) {
      if (String(reason).includes('expired')) this.stats.expired += 1;
      return { accepted: false, reason };
    }

    startBundle(bundle) {
      if (!bundle) return;
      if (Date.now() > Number(bundle.expiresAt || Infinity)) return this.startNextAvailable();
      this.session += 1;
      const token = this.session;
      this.currentBundle = bundle;
      const total = bundle.items.reduce((sum, item) => sum + this.estimateSpeechMs(item.text, item.speaker), 0);
      this.estimatedBundleEndAt = Date.now() + total + Math.max(0, bundle.items.length - 1) * 110;
      this.playBundle(bundle, token);
    }

    async playBundle(bundle, token) {
      for (let index = 0; index < bundle.items.length; index += 1) {
        if (token !== this.session) return;
        const item = { ...bundle.items[index] };
        this.current = item;
        const rest = bundle.items.slice(index).reduce((sum, next) => sum + this.estimateSpeechMs(next.text, next.speaker), 0);
        this.estimatedBundleEndAt = Date.now() + rest + Math.max(0, bundle.items.length - index - 1) * 110;
        await this.speakItem(item, token);
        if (token !== this.session) return;
        this.stats.spoken += 1;
        this.current = null;
        if (index + 1 < bundle.items.length) await sleep(110);
      }
      if (token !== this.session) return;
      this.current = null;
      this.currentBundle = null;
      this.estimatedBundleEndAt = 0;
      this.startNextAvailable();
    }

    startNextAvailable() {
      const hot = this.hotSlot;
      this.hotSlot = null;
      if (hot && Date.now() <= Number(hot.expiresAt || 0)) this.startBundle(hot);
    }

    async speakItem(item, token) {
      const text = this.system.personalizeText(item.text);
      if (!text) return;
      const supported = 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window;
      const settings = this.system.getSpeakerSettings(item.speaker);
      if (!supported || Number(settings.volume) <= 0) {
        await sleep(Math.min(1200, Math.max(180, text.length * 7)));
        return;
      }
      for (const chunk of speechChunks(text, 230)) {
        if (token !== this.session) return;
        await this.speakChunk(chunk, item, token);
      }
    }

    speakChunk(text, item, token) {
      return new Promise((resolve) => {
        const synth = window.speechSynthesis;
        const settings = this.system.getSpeakerSettings(item.speaker);
        const utterance = new SpeechSynthesisUtterance(text);
        const voice = this.system.voiceByURI(settings.voiceURI, item.speaker);
        if (voice) utterance.voice = voice;
        utterance.lang = voice?.lang || this.system.language || 'es-ES';
        utterance.rate = clamp(settings.rate, 0.5, 2);
        utterance.pitch = clamp(settings.pitch, 0, 2);
        utterance.volume = clamp(settings.volume, 0, 1);
        let settled = false;
        let watchdog = 0;
        const finish = () => {
          if (settled) return;
          settled = true;
          if (watchdog) window.clearInterval(watchdog);
          resolve();
        };
        utterance.onend = finish;
        utterance.onerror = finish;
        if (token !== this.session) return finish();
        synth.speak(utterance);
        let quietTicks = 0;
        watchdog = window.setInterval(() => {
          if (synth.paused) return;
          if (!synth.speaking && !synth.pending) quietTicks += 1;
          else quietTicks = 0;
          if (quietTicks > 2) finish();
        }, 450);
      });
    }

    stop() {
      this.session += 1;
      this.hotSlot = null;
      this.currentBundle = null;
      this.current = null;
      this.estimatedBundleEndAt = 0;
      if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    }

    pause() { if ('speechSynthesis' in window) window.speechSynthesis.pause(); }
    resume() { if ('speechSynthesis' in window) window.speechSynthesis.resume(); }
    isBusy() { return Boolean(this.currentBundle || this.current || this.hotSlot); }
  }

  NG.AnnouncerPersonaEngine = PersonaEngine;
  NG.AnnouncerComposer = AnnouncerComposer;
  NG.AnnouncerSpeechDirector = SpeechDirector;
  NG.AnnouncerUtils = Object.freeze({ clone, clamp, chance, pick, ensureTerminalText, eventPolicy, CLASS_RANK });
}(window.NoiseGolf = window.NoiseGolf || {}));
