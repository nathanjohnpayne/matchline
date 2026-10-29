// Label-swipe decision core: shuffle, reducer, export.
//
// A classic script (no `export`) so index.html works from file://, where
// browsers refuse ES-module scripts. It publishes `globalThis.LabelCore`;
// the vitest suite imports this file for that side effect. Every function is
// pure: state in, new state out. State holds item ids, labels, notes and
// timings only, never card text, so it is safe to persist in localStorage.

(function () {
  const MIXED_TYPES = ["fact-correct", "requirement-equivalent"];
  const LABELS = ["true", "false", "mixed", "unsure"];

  // mulberry32: small, fast, good enough for a reproducible shuffle.
  function prng(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Fisher-Yates with the seeded PRNG; the input array is not modified.
  function shuffle(items, seed) {
    const out = items.slice();
    const rand = prng(seed);
    for (let i = out.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rand() * (i + 1));
      const tmp = out[i];
      out[i] = out[j];
      out[j] = tmp;
    }
    return out;
  }

  function randomUint32() {
    const buf = new Uint32Array(1);
    globalThis.crypto.getRandomValues(buf);
    return buf[0];
  }

  function newSessionId() {
    return globalThis.crypto.randomUUID ? globalThis.crypto.randomUUID() : `s-${Date.now().toString(36)}-${randomUint32().toString(36)}`;
  }

  function allowsMixed(type) {
    return MIXED_TYPES.includes(type);
  }

  // FNV-1a over the deck's cards and sources. Saved progress is tied to it, so
  // a regenerated deck with the same item ids but changed text starts fresh.
  // Only the hash is stored, never the text.
  function deckFingerprint(deck) {
    const text = JSON.stringify([deck.cards, deck.sources]);
    let h = 2166136261;
    for (let i = 0; i < text.length; i += 1) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
    return (h >>> 0).toString(16).padStart(8, "0") + ":" + text.length;
  }

  function initState(deck, seed) {
    const types = {};
    for (const card of deck.cards) types[card.item_id] = card.type;
    return {
      deck_id: deck.deck_id,
      fingerprint: deckFingerprint(deck),
      seed,
      queue: shuffle(
        deck.cards.map((c) => c.item_id),
        seed,
      ),
      types,
      decisions: {},
      history: [],
      undos: {},
      elapsed: {},
      requeued: {},
      counter: 0,
    };
  }

  function current(state) {
    return state.queue.length ? state.queue[0] : null;
  }

  // Record a decision on the current card. `unsure` the first time re-queues
  // the card at the end (to be shown again with its source expanded); a
  // second `unsure` is final. `mixed` on a true/false-only card is ignored.
  function decide(state, label, ms) {
    const id = current(state);
    if (id === null || !LABELS.includes(label)) return state;
    if (label === "mixed" && !allowsMixed(state.types[id])) return state;
    const spent = Math.max(0, Math.round(ms || 0));
    if (label === "unsure" && !state.requeued[id]) {
      return {
        ...state,
        queue: [...state.queue.slice(1), id],
        requeued: { ...state.requeued, [id]: true },
        elapsed: { ...state.elapsed, [id]: (state.elapsed[id] || 0) + spent },
        history: [...state.history, { kind: "requeue", id, ms: spent }],
      };
    }
    const order = state.counter + 1;
    return {
      ...state,
      queue: state.queue.slice(1),
      counter: order,
      decisions: {
        ...state.decisions,
        [id]: { label, note: "", ms: (state.elapsed[id] || 0) + spent, order },
      },
      history: [...state.history, { kind: "decide", id, ms: spent }],
    };
  }

  // Attach a one-line note to a decided `false` / `mixed` item.
  function setNote(state, id, note) {
    const d = state.decisions[id];
    if (!d || (d.label !== "false" && d.label !== "mixed")) return state;
    const text = String(note || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 300);
    return { ...state, decisions: { ...state.decisions, [id]: { ...d, note: text } } };
  }

  // Undo the last decide/requeue: the card returns to the front of the queue.
  function undo(state) {
    const last = state.history[state.history.length - 1];
    if (!last) return state;
    const history = state.history.slice(0, -1);
    const undos = { ...state.undos, [last.id]: (state.undos[last.id] || 0) + 1 };
    if (last.kind === "requeue") {
      const queue = state.queue.slice();
      queue.splice(queue.lastIndexOf(last.id), 1);
      const requeued = { ...state.requeued };
      delete requeued[last.id];
      return {
        ...state,
        history,
        undos,
        requeued,
        // Like an undone decision, the time already spent keeps counting.
        queue: [last.id, ...queue],
      };
    }
    const decisions = { ...state.decisions };
    const undone = decisions[last.id];
    delete decisions[last.id];
    return {
      ...state,
      history,
      undos,
      decisions,
      counter: state.counter - 1,
      queue: [last.id, ...state.queue],
      // Time already spent on the card keeps counting when it is decided again.
      elapsed: { ...state.elapsed, [last.id]: undone ? undone.ms : state.elapsed[last.id] || 0 },
    };
  }

  function progress(state) {
    const done = Object.keys(state.decisions).length;
    return { done, total: Object.keys(state.types).length };
  }

  function buildExport(deck, state, sessionId) {
    const byId = {};
    for (const card of deck.cards) byId[card.item_id] = card;
    const items = Object.keys(state.decisions)
      .map((id) => {
        const d = state.decisions[id];
        const card = byId[id];
        return {
          item_id: id,
          type: card ? card.type : state.types[id],
          label: d.label,
          note: d.note,
          ms: d.ms,
          order: d.order,
          undos: state.undos[id] || 0,
          catch: Boolean(card && card.catch),
        };
      })
      .sort((a, b) => a.order - b.order);
    const catches = items.filter((i) => i.catch);
    return {
      deck_id: deck.deck_id,
      seed: state.seed,
      session_id: sessionId,
      items,
      attention: {
        catch_cards: catches.length,
        catch_correct: catches.filter((i) => byId[i.item_id].expected === i.label).length,
      },
    };
  }

  function exportFilename(deckId, date) {
    const stamp = date
      .toISOString()
      .replace(/\.\d+Z$/, "Z")
      .replace(/[-:]/g, "");
    return `labels-${deckId}-${stamp}.json`;
  }

  // A persisted state is usable only if it describes exactly this deck.
  function stateMatchesDeck(state, deck) {
    if (!state || state.deck_id !== deck.deck_id || !state.types) return false;
    if (state.fingerprint !== deckFingerprint(deck)) return false;
    // A partial write or a hand edit must start a fresh session, not throw later.
    if (!Array.isArray(state.queue) || !Array.isArray(state.history)) return false;
    for (const field of ["decisions", "requeued", "undos", "elapsed"]) if (!state[field] || typeof state[field] !== "object") return false;
    const ids = deck.cards.map((c) => c.item_id);
    return ids.length === Object.keys(state.types).length && ids.every((id) => state.types[id]);
  }

  globalThis.LabelCore = {
    LABELS,
    MIXED_TYPES,
    allowsMixed,
    prng,
    shuffle,
    randomUint32,
    newSessionId,
    initState,
    current,
    decide,
    setNote,
    undo,
    progress,
    buildExport,
    exportFilename,
    stateMatchesDeck,
    deckFingerprint,
  };
})();
