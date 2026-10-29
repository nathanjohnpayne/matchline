// Label Swipe page controller. Swipe mechanics adapted from swipewatch
// (100 px swipe threshold, 10 px before a press becomes a drag); decisions,
// undo and export live in core.js. No network: decks come from a file
// picker and stay in memory; localStorage holds ids, labels, notes, timings.

(function () {
  const Core = globalThis.LabelCore;
  const STORAGE_PREFIX = "label-swipe:v1:";
  const DRAG_START_THRESHOLD = 10;
  const SWIPE_THRESHOLD = 100;
  const SWIPE_ANIMATION_MS = 180;

  const QUESTIONS = {
    "fact-correct": ["Fact correct?", "Is this a true fact from the résumé?"],
    verbatim: ["Verbatim?", "Is the raw_text a quote from one résumé line?"],
    "keep-unmatched-unit": ["Keep extra Unit?", "Is this a real résumé fact the labels missed (not a duplicate or non-fact)?"],
    "requirement-equivalent": ["Same requirement?", "Does the parsed requirement say the same thing as the expected one?"],
    "must-have-right": ["Must-have right?", "Is the parsed must-have / nice-to-have flag right for this JD line?"],
    "keep-unmatched-requirement": ["Keep extra requirement?", "Is this a real JD requirement the labels missed (not a duplicate or split)?"],
    "match-pair-agree": ["Still agree?", "Does this résumé fact answer this requirement?"],
  };

  const $ = (id) => document.getElementById(id);
  const els = {
    start: $("start-screen"),
    cardScreen: $("card-screen"),
    end: $("end-screen"),
    input: $("deck-input"),
    loadError: $("load-error"),
    progressWrap: $("progress-wrap"),
    progressBar: $("progress-bar"),
    progressLabel: $("progress-label"),
    download: $("download-btn"),
    card: $("card"),
    type: $("card-type"),
    requeue: $("requeue-flag"),
    question: $("card-question"),
    claim: $("card-claim"),
    evidence: $("card-evidence"),
    expand: $("expand-btn"),
    source: $("card-source"),
    noteBar: $("note-bar"),
    noteOpen: $("note-open"),
    noteForm: $("note-form"),
    noteInput: $("note-input"),
    undo: $("undo-btn"),
    toast: $("toast"),
    endTitle: $("end-title"),
    endStats: $("end-stats"),
    endDownload: $("end-download"),
    endUndo: $("end-undo"),
    endNext: $("end-next"),
  };

  // Session: all decks opened together, in cell order; one active at a time.
  let decks = [];
  let deckIndex = 0;
  let deck = null;
  let cardsById = {};
  let session = null; // { session_id, state }
  let expanded = false;
  let animating = false;
  let noteTarget = null;
  let shownAt = 0;
  let pausedAt = null;

  // ---------- persistence (ids and labels only) ----------

  function storageGet(key) {
    try {
      const raw = globalThis.localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (_) {
      return null;
    }
  }

  function storageSet(key, value) {
    try {
      globalThis.localStorage.setItem(key, JSON.stringify(value));
    } catch (_) {}
  }

  function save() {
    if (deck && session) storageSet(STORAGE_PREFIX + deck.deck_id, session);
  }

  // ---------- timing ----------

  function startTimer() {
    shownAt = performance.now();
    pausedAt = null;
  }

  function pauseTimer() {
    if (pausedAt === null) pausedAt = performance.now();
  }

  function resumeTimer() {
    if (pausedAt !== null) {
      shownAt += performance.now() - pausedAt;
      pausedAt = null;
    }
  }

  function elapsed() {
    return (pausedAt ?? performance.now()) - shownAt;
  }

  document.addEventListener("visibilitychange", () => (document.hidden ? pauseTimer() : resumeTimer()));

  // ---------- loading ----------

  function readFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsText(file);
    });
  }

  function validDeck(d) {
    return d && d.format === "matchline-label-deck/1" && typeof d.deck_id === "string" && Array.isArray(d.cards) && d.sources;
  }

  els.input.addEventListener("change", async () => {
    els.loadError.hidden = true;
    const files = Array.from(els.input.files || []);
    const loaded = [];
    for (const file of files) {
      try {
        const d = JSON.parse(await readFile(file));
        if (!validDeck(d)) throw new Error("not a label-swipe deck");
        loaded.push(d);
      } catch (err) {
        els.loadError.textContent = `${file.name}: ${err.message}`;
        els.loadError.hidden = false;
        return;
      }
    }
    if (!loaded.length) return;
    decks = loaded.sort((a, b) => (a.cell_order ?? 0) - (b.cell_order ?? 0));
    // Resume at the first cell with cards left.
    deckIndex = decks.findIndex((d) => {
      const saved = storageGet(STORAGE_PREFIX + d.deck_id);
      return !(saved && Core.stateMatchesDeck(saved.state, d) && saved.state.queue.length === 0);
    });
    openDeck(deckIndex < 0 ? decks.length - 1 : deckIndex);
  });

  function openDeck(index) {
    deckIndex = index;
    deck = decks[index];
    cardsById = {};
    for (const c of deck.cards) cardsById[c.item_id] = c;
    const saved = storageGet(STORAGE_PREFIX + deck.deck_id);
    if (saved && Core.stateMatchesDeck(saved.state, deck)) {
      session = saved;
    } else {
      session = { session_id: Core.newSessionId(), state: Core.initState(deck, Core.randomUint32()) };
      save();
    }
    hideNoteBar();
    els.download.hidden = false;
    els.progressWrap.hidden = false;
    els.start.hidden = true;
    render();
  }

  // ---------- rendering ----------

  function setScreen(name) {
    els.cardScreen.hidden = name !== "card";
    els.end.hidden = name !== "end";
  }

  function updateProgress() {
    const p = Core.progress(session.state);
    els.progressBar.style.width = `${p.total ? (p.done / p.total) * 100 : 0}%`;
    els.progressLabel.textContent = `Cell ${deckIndex + 1} of ${decks.length} · ${p.done} of ${p.total} labelled`;
  }

  function fieldList(container, fields) {
    container.textContent = "";
    for (const f of fields) {
      const block = document.createElement("div");
      block.className = "field";
      const label = document.createElement("div");
      label.className = "field-label";
      label.textContent = f.label;
      const text = document.createElement("p");
      text.className = "field-text";
      text.textContent = f.text;
      block.append(label, text);
      container.append(block);
    }
  }

  function renderSource(card) {
    els.source.textContent = "";
    const parts = card.source === "both" ? ["resume", "jd"] : [card.source];
    let first = null;
    for (const part of parts) {
      const src = deck.sources[part];
      const heading = document.createElement("h4");
      heading.textContent = src.title;
      const pre = document.createElement("div");
      pre.className = "source-text";
      const marks = new Set((card.highlight && card.highlight[part]) || []);
      src.text.split("\n").forEach((line, i) => {
        const row = document.createElement("div");
        row.className = marks.has(i) ? "src-line hit" : "src-line";
        row.textContent = line || " ";
        if (marks.has(i) && !first) first = row;
        pre.append(row);
      });
      els.source.append(heading, pre);
    }
    return first;
  }

  function setExpanded(open) {
    expanded = open;
    els.source.hidden = !open;
    els.expand.textContent = open ? "Hide full source (Space)" : "Show full source (Space)";
    if (open) {
      const card = cardsById[Core.current(session.state)];
      const first = card ? renderSource(card) : null;
      if (first) first.scrollIntoView({ block: "center" });
    }
  }

  function render() {
    updateProgress();
    const id = Core.current(session.state);
    if (id === null) return showEnd();
    setScreen("card");
    const card = cardsById[id];
    const [chip, question] = QUESTIONS[card.type] || [card.type, ""];
    els.type.textContent = chip;
    els.question.textContent = question;
    fieldList(els.claim, card.claim);
    fieldList(els.evidence, card.evidence);
    const second = Boolean(session.state.requeued[id]);
    els.requeue.hidden = !second;
    document.querySelector(".btn-mixed").disabled = !Core.allowsMixed(card.type);
    els.undo.disabled = session.state.history.length === 0;
    els.card.className = "card";
    els.card.style.transform = "";
    els.card.style.opacity = "";
    hideIndicators();
    setExpanded(second);
    els.card.scrollTop = 0;
    startTimer();
  }

  function showEnd() {
    setScreen("end");
    const st = session.state;
    const items = Object.values(st.decisions);
    const times = items.map((d) => d.ms).sort((a, b) => a - b);
    const median = times.length ? times[Math.floor(times.length / 2)] : 0;
    const counts = { true: 0, false: 0, mixed: 0, unsure: 0 };
    for (const d of items) counts[d.label] += 1;
    const undos = Object.values(st.undos).reduce((a, b) => a + b, 0);
    els.endTitle.textContent = `Cell ${deckIndex + 1} of ${decks.length} done`;
    els.endStats.textContent = "";
    const rows = [
      ["Labelled", String(items.length)],
      ["True · False · Mixed · Can't tell", `${counts.true} · ${counts.false} · ${counts.mixed} · ${counts.unsure}`],
      ["Median time per card", `${(median / 1000).toFixed(1)} s`],
      ["Undos", String(undos)],
    ];
    for (const [k, v] of rows) {
      const dt = document.createElement("dt");
      dt.textContent = k;
      const dd = document.createElement("dd");
      dd.textContent = v;
      els.endStats.append(dt, dd);
    }
    els.endNext.hidden = deckIndex >= decks.length - 1;
  }

  // ---------- decisions ----------

  const INDICATOR = { right: "true", left: "false", down: "mixed", up: "unsure" };
  const DIRECTION = { true: "right", false: "left", mixed: "down", unsure: "up" };

  function hideIndicators() {
    document.querySelectorAll(".indicator").forEach((el) => {
      el.style.opacity = "0";
    });
  }

  function showIndicator(label, progress) {
    hideIndicators();
    const el = document.querySelector(`.indicator-${label}`);
    if (el) el.style.opacity = String(progress);
  }

  let toastTimer = null;
  function toast(text) {
    els.toast.textContent = text;
    els.toast.classList.add("visible");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.toast.classList.remove("visible"), 1600);
  }

  function decide(label) {
    if (animating || !session) return;
    const id = Core.current(session.state);
    if (id === null) return;
    const card = cardsById[id];
    if (label === "mixed" && !Core.allowsMixed(card.type)) {
      toast("This card is True / False only");
      snapBack();
      return;
    }
    closeNoteForm();
    const ms = elapsed();
    session = { ...session, state: Core.decide(session.state, label, ms) };
    save();
    animating = true;
    const offsets = { right: "translateX(140%) rotate(20deg)", left: "translateX(-140%) rotate(-20deg)", down: "translateY(120%)", up: "translateY(-120%)" };
    els.card.classList.add("animating");
    els.card.style.transform = offsets[DIRECTION[label]];
    els.card.style.opacity = "0";
    if (label === "unsure" && session.state.requeued[id] && !session.state.decisions[id]) toast("Moved to the end, with the source open");
    setTimeout(() => {
      animating = false;
      if (label === "false" || label === "mixed") showNoteBar(id);
      else hideNoteBar();
      render();
    }, SWIPE_ANIMATION_MS);
  }

  function undo() {
    if (animating || !session || session.state.history.length === 0) return;
    closeNoteForm();
    hideNoteBar();
    session = { ...session, state: Core.undo(session.state) };
    save();
    toast("Undone");
    render();
  }

  function snapBack() {
    els.card.classList.add("animating");
    els.card.style.transform = "";
    hideIndicators();
    setTimeout(() => els.card.classList.remove("animating"), SWIPE_ANIMATION_MS);
  }

  // ---------- notes ----------

  function showNoteBar(id) {
    noteTarget = id;
    els.noteBar.hidden = false;
    els.noteOpen.hidden = false;
    els.noteForm.hidden = true;
  }

  function hideNoteBar() {
    noteTarget = null;
    els.noteBar.hidden = true;
  }

  function openNoteForm() {
    if (!noteTarget || !session.state.decisions[noteTarget]) return;
    pauseTimer();
    els.noteOpen.hidden = true;
    els.noteForm.hidden = false;
    els.noteInput.value = session.state.decisions[noteTarget].note || "";
    els.noteInput.focus();
  }

  function closeNoteForm() {
    if (els.noteForm.hidden) return;
    els.noteForm.hidden = true;
    els.noteOpen.hidden = false;
    els.noteInput.blur();
    resumeTimer();
  }

  els.noteOpen.addEventListener("click", openNoteForm);
  els.noteForm.addEventListener("submit", (e) => {
    e.preventDefault();
    if (noteTarget) {
      session = { ...session, state: Core.setNote(session.state, noteTarget, els.noteInput.value) };
      save();
      toast("Note saved");
    }
    closeNoteForm();
    hideNoteBar();
  });
  els.noteInput.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      closeNoteForm();
    }
    e.stopPropagation();
  });

  // ---------- export ----------

  function download() {
    if (!deck || !session) return;
    const data = Core.buildExport(deck, session.state, session.session_id);
    const blob = new Blob([JSON.stringify(data, null, 2) + "\n"], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = Core.exportFilename(deck.deck_id, new Date());
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  els.download.addEventListener("click", download);
  els.endDownload.addEventListener("click", download);
  els.endUndo.addEventListener("click", undo);
  els.endNext.addEventListener("click", () => openDeck(deckIndex + 1));
  els.undo.addEventListener("click", undo);
  els.expand.addEventListener("click", () => setExpanded(!expanded));
  document.querySelectorAll(".action-btn").forEach((btn) => btn.addEventListener("click", () => decide(btn.dataset.label)));

  // ---------- keyboard ----------

  document.addEventListener("keydown", (e) => {
    if (!session || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.target instanceof HTMLInputElement) return;
    const onCard = !els.cardScreen.hidden;
    const keys = { ArrowRight: "true", ArrowLeft: "false", ArrowDown: "mixed", ArrowUp: "unsure" };
    if (onCard && keys[e.key]) {
      e.preventDefault();
      decide(keys[e.key]);
    } else if (onCard && e.key === " ") {
      e.preventDefault();
      setExpanded(!expanded);
    } else if (e.key === "z" || e.key === "Z") {
      e.preventDefault();
      undo();
    } else if ((e.key === "n" || e.key === "N") && noteTarget) {
      e.preventDefault();
      openNoteForm();
    }
  });

  // ---------- pointer swipe ----------

  let startX = 0;
  let startY = 0;
  let dx = 0;
  let dy = 0;
  let pressing = false;
  let moved = false;

  els.card.addEventListener("pointerdown", (e) => {
    if (animating || e.button !== 0) return;
    // Scrolling the source panel or pressing a button is not a swipe.
    if (e.target.closest(".source, button")) return;
    pressing = true;
    moved = false;
    startX = e.clientX;
    startY = e.clientY;
    dx = 0;
    dy = 0;
  });

  document.addEventListener("pointermove", (e) => {
    if (!pressing) return;
    dx = e.clientX - startX;
    dy = e.clientY - startY;
    if (!moved) {
      if (Math.hypot(dx, dy) < DRAG_START_THRESHOLD) return;
      moved = true;
      els.card.classList.add("dragging");
      try {
        els.card.setPointerCapture(e.pointerId);
      } catch (_) {}
    }
    e.preventDefault();
    els.card.style.transform = `translate(${dx}px, ${dy}px) rotate(${dx * 0.04}deg)`;
    const dir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "right" : "left") : dy > 0 ? "down" : "up";
    const dist = Math.max(Math.abs(dx), Math.abs(dy));
    if (dist > 20) showIndicator(INDICATOR[dir], Math.min(1, dist / SWIPE_THRESHOLD));
    else hideIndicators();
  });

  function endPress() {
    if (!pressing) return;
    pressing = false;
    els.card.classList.remove("dragging");
    if (!moved) {
      // A tap toggles the full source, unless it was a text selection.
      const sel = globalThis.getSelection && globalThis.getSelection();
      if (!sel || sel.isCollapsed) setExpanded(!expanded);
      return;
    }
    const absX = Math.abs(dx);
    const absY = Math.abs(dy);
    if (absX > absY && absX > SWIPE_THRESHOLD) decide(dx > 0 ? "true" : "false");
    else if (absY > absX && absY > SWIPE_THRESHOLD) decide(dy > 0 ? "mixed" : "unsure");
    else snapBack();
  }

  document.addEventListener("pointerup", endPress);
  document.addEventListener("pointercancel", () => {
    if (pressing) {
      pressing = false;
      snapBack();
    }
  });
})();
