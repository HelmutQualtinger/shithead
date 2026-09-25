"use strict";

const $ = (id) => document.getElementById(id);

const SUIT_SYMBOL = { S: "♠", H: "♥", D: "♦", C: "♣" };
const RED_SUITS = new Set(["H", "D"]);

let ws = null;
let myPlayerId = null;
let myName = "";
let roomCode = "";
let lastState = null;
let selected = new Set(); // selected card ids from hand/up zone
let wasMyTurn = false;

// ---------- turn sound ----------

const SOUND_MUTED_KEY = "shithead_sound_muted";
let audioCtx = null;
let soundMuted = false;
try {
  soundMuted = localStorage.getItem(SOUND_MUTED_KEY) === "1";
} catch (e) {
  // storage unavailable - default to sound on
}

function unlockAudio() {
  if (!audioCtx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (Ctx) audioCtx = new Ctx();
  } else if (audioCtx.state === "suspended") {
    audioCtx.resume();
  }
}

function playTurnChime() {
  if (soundMuted || !audioCtx) return;
  const now = audioCtx.currentTime;
  // two-note gentle bell: a fifth apart, quick decay
  [523.25, 783.99].forEach((freq, i) => {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    const start = now + i * 0.09;
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(0.16, start + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.5);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(start);
    osc.stop(start + 0.55);
  });
}

function setSoundMuted(muted) {
  soundMuted = muted;
  try {
    localStorage.setItem(SOUND_MUTED_KEY, muted ? "1" : "0");
  } catch (e) {
    // per-viewer convenience only
  }
  $("btn-sound-toggle").classList.toggle("is-muted", muted);
}

// ---------- screen management ----------

function showScreen(name) {
  document.querySelectorAll(".screen").forEach((el) => el.classList.remove("active"));
  $(`screen-${name}`).classList.add("active");
  $("lang-switcher").style.display = name === "game" ? "none" : "flex";
}

function toast(message) {
  const el = $("toast");
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove("show"), 3200);
}

// ---------- i18n ----------

function applyStaticTranslations() {
  document.documentElement.lang = currentLang;
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    const key = el.getAttribute("data-i18n");
    if (key.endsWith("_html")) {
      el.innerHTML = t(key);
    } else {
      el.textContent = t(key);
    }
  });
  document.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
    el.placeholder = t(el.getAttribute("data-i18n-placeholder"));
  });
  document.querySelectorAll("[data-i18n-title]").forEach((el) => {
    el.title = t(el.getAttribute("data-i18n-title"));
  });
  document.querySelectorAll("[data-i18n-aria]").forEach((el) => {
    el.setAttribute("aria-label", t(el.getAttribute("data-i18n-aria")));
  });
  document.querySelectorAll(".lang-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.lang === currentLang);
  });
}

function formatLogEntry(entry) {
  const params = { ...entry };
  delete params.event;
  if (Array.isArray(params.cards)) params.cards = params.cards.join(", ");
  return t(`log.${entry.event}`, params);
}

// ---------- connection ----------

function connect(code, name) {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const target = code || "NEW";
  ws = new WebSocket(`${proto}://${location.host}/ws/${target}`);

  ws.addEventListener("open", () => {
    const storedId = sessionStorage.getItem("shithead_playerId");
    ws.send(JSON.stringify({ type: "join", name, playerId: storedId || undefined }));
  });

  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    handleMessage(msg);
  });

  ws.addEventListener("close", () => {
    if (lastState && lastState.phase !== "finished") {
      toast(t("game.toast_connection_lost"));
    }
  });

  ws.addEventListener("error", () => {
    $("landing-error").textContent = t("landing.error_connect_failed");
  });
}

function send(payload) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}

function handleMessage(msg) {
  if (msg.type === "joined") {
    myPlayerId = msg.playerId;
    roomCode = msg.roomCode;
    sessionStorage.setItem("shithead_playerId", myPlayerId);
    $("lobby-room-code").textContent = roomCode;
    $("game-room-code").textContent = roomCode;
  } else if (msg.type === "state") {
    lastState = msg.state;
    selected.clear();
    renderState(lastState);
  } else if (msg.type === "error") {
    const key = `err.${msg.code}`;
    const known = TRANSLATIONS.en[key] !== undefined;
    toast(known ? t(key, msg.params) : t("err.default"));
  }
}

// ---------- top-level render ----------

function renderState(state) {
  if (state.phase === "lobby") {
    showScreen("lobby");
    renderLobby(state);
  } else if (state.phase === "playing") {
    showScreen("game");
    renderGame(state);
  } else if (state.phase === "finished") {
    showScreen("game");
    renderGame(state);
    renderGameOver(state);
    showScreen("over");
  }
}

function renderLobby(state) {
  const list = $("lobby-players");
  list.innerHTML = "";
  state.players.forEach((p, i) => {
    const li = document.createElement("li");
    const isHost = p.id === state.hostId;
    const goneSuffix = p.connected ? "" : ` ${t("lobby.gone")}`;
    li.innerHTML = `<span class="seat-num">${i + 1}</span><span>${escapeHtml(p.name)}${goneSuffix}</span>${isHost ? `<span class="seat-host">${t("lobby.host")}</span>` : ""}`;
    list.appendChild(li);
  });

  const amHost = state.hostId === myPlayerId;
  const startBtn = $("btn-start");
  startBtn.style.display = amHost ? "inline-flex" : "none";
  startBtn.disabled = state.players.length < 2;
  $("lobby-hint").style.display = amHost ? "none" : "block";
  const hostName = state.players.find((p) => p.id === state.hostId)?.name || t("lobby.the_host");
  $("lobby-hint").textContent =
    state.players.length < 2 ? t("lobby.waiting_players") : t("lobby.waiting_host", { name: hostName });
}

function renderGameOver(state) {
  const list = $("finish-list");
  list.innerHTML = "";
  state.winnerOrder.forEach((name, i) => {
    const li = document.createElement("li");
    const isLast = i === state.winnerOrder.length - 1;
    const medal = t(`over.medal_${i + 1}`) || String(i + 1);
    const suffix = isLast ? t("over.shithead_suffix") : "";
    li.innerHTML = `<span class="medal">${medal}</span><span>${escapeHtml(name)}${suffix}</span>`;
    list.appendChild(li);
  });
}

// ---------- game screen ----------

function renderGame(state) {
  const me = state.players.find((p) => p.id === myPlayerId);
  const isMyTurn = state.currentPlayerId === myPlayerId;
  if (isMyTurn && !wasMyTurn) playTurnChime();
  wasMyTurn = isMyTurn;

  // turn banner
  const banner = $("turn-banner");
  if (isMyTurn) {
    banner.textContent = t("game.your_move");
    banner.classList.add("is-me");
  } else {
    const current = state.players.find((p) => p.id === state.currentPlayerId);
    banner.textContent = current ? t("game.waiting_on", { name: current.name }) : "—";
    banner.classList.remove("is-me");
  }

  // opponents
  const oppRow = $("opponents-row");
  oppRow.innerHTML = "";
  state.players
    .filter((p) => p.id !== myPlayerId)
    .forEach((p) => {
      oppRow.appendChild(buildOpponentEl(p, state));
    });

  // center stage
  $("deck-count").textContent = state.deckCount;
  renderPile(state);
  const req = $("rank-req");
  if (state.effectiveTopRank === "7") {
    req.innerHTML = t("game.rank_on_seven").replace(/7/, "<strong>7</strong>");
  } else if (state.effectiveTopRank) {
    req.innerHTML = t("game.rank_beat", { rank: `<strong>${rankLabel(state.effectiveTopRank)}</strong>` });
  } else if (state.pileCount) {
    req.textContent = t("game.rank_open");
  } else {
    req.textContent = t("game.rank_empty");
  }
  const dirEl = $("direction-indicator");
  const activeCount = state.players.filter((p) => !p.isOut).length;
  dirEl.style.display = activeCount > 2 ? "inline" : "none";
  dirEl.textContent = state.direction === 1 ? t("game.dir_clockwise") : t("game.dir_counter");

  // log
  const logList = $("log-list");
  logList.innerHTML = "";
  (state.log || []).slice().reverse().forEach((entry) => {
    const li = document.createElement("li");
    li.textContent = formatLogEntry(entry);
    logList.appendChild(li);
  });

  renderMyArea(me, state, isMyTurn);
}

function buildOpponentEl(p, state) {
  const div = document.createElement("div");
  div.className = "opp";
  if (p.id === state.currentPlayerId) div.classList.add("is-turn");
  if (p.isOut) div.classList.add("is-out");

  const initial = (p.name[0] || "?").toUpperCase();
  const badge = p.isOut
    ? `<span class="opp__badge">${t("game.badge_out", { n: p.finishedRank })}</span>`
    : p.connected
    ? ""
    : `<span class="opp__badge">${t("game.badge_offline")}</span>`;

  div.innerHTML = `
    <div class="opp__head">
      <div class="opp__avatar">${initial}</div>
      <div class="opp__name">${escapeHtml(p.name)}</div>
      ${badge}
    </div>
    <div class="opp__zones">
      <div class="opp__stack">
        <div class="card mini card--back"></div>
        <span class="opp__count">${p.handCount}</span>
      </div>
      <div class="opp__piles"></div>
    </div>
  `;
  const pilesWrap = div.querySelector(".opp__piles");
  buildPileStacks(pilesWrap, p.downCount, p.up, { mini: true });
  return div;
}

// Builds the classic "face-up sitting on face-down" pile row: one stack per
// position, back card underneath, the matching up-card layered on top.
function buildPileStacks(container, downCount, upCards, opts) {
  const count = Math.max(downCount, upCards.length);
  for (let i = 0; i < count; i++) {
    const pile = document.createElement("div");
    pile.className = opts.mini ? "pile-stack mini" : "pile-stack";
    if (i < downCount) pile.appendChild(buildBackEl({ mini: opts.mini }));
    if (i < upCards.length) {
      const c = upCards[i];
      const isSelected = selected.has(c.id);
      const el = buildCardEl(c, {
        mini: opts.mini,
        selectable: opts.selectable,
        selected: isSelected,
        legal: opts.selectable && opts.legal && opts.legal.has(c.rank),
        illegal: opts.selectable && opts.legal && opts.legal.size > 0 && !opts.legal.has(c.rank) && !isSelected,
      });
      if (opts.selectable) el.addEventListener("click", () => toggleSelect(c));
      pile.appendChild(el);
    }
    container.appendChild(pile);
  }
}

function renderPile(state) {
  const wrap = $("pile-cards");
  wrap.innerHTML = "";
  const shown = state.pile.slice(-3);
  shown.forEach((c, i) => {
    const el = buildCardEl(c, {});
    el.classList.add("card--pile-stacked");
    const offset = i - (shown.length - 1);
    el.style.transform = `translate(${offset * 3}px, ${offset * -2}px) rotate(${offset * 6}deg)`;
    el.style.zIndex = String(i);
    wrap.appendChild(el);
  });
  $("pile-label").textContent = state.pileCount ? `${t("game.pile")} · ${state.pileCount}` : t("game.pile");
}

function renderMyArea(me, state, isMyTurn) {
  const pilesWrap = $("my-piles");
  const handWrap = $("my-hand");
  pilesWrap.innerHTML = "";
  handWrap.innerHTML = "";

  if (!me) return;

  const legal = new Set(state.legalRanks || []);
  const myPhase = me.phase;
  const downActive = isMyTurn && myPhase === "down";
  const upActive = isMyTurn && myPhase === "up";
  const handActive = isMyTurn && myPhase === "hand";

  const count = Math.max(me.downCount, me.up.length);
  for (let i = 0; i < count; i++) {
    const pile = document.createElement("div");
    pile.className = "pile-stack";
    if (i < me.downCount) {
      const back = buildBackEl({ selectable: downActive });
      if (downActive) back.addEventListener("click", () => send({ type: "play_down", index: i }));
      pile.appendChild(back);
    }
    if (i < me.up.length) {
      const c = me.up[i];
      const isSelected = selected.has(c.id);
      const el = buildCardEl(c, {
        selectable: upActive,
        selected: isSelected,
        legal: upActive && legal.has(c.rank),
        illegal: upActive && legal.size > 0 && !legal.has(c.rank) && !isSelected,
      });
      if (upActive) el.addEventListener("click", () => toggleSelect(c));
      pile.appendChild(el);
    }
    pilesWrap.appendChild(pile);
  }

  (me.hand || []).forEach((c) => {
    const isSelected = selected.has(c.id);
    const el = buildCardEl(c, {
      selectable: handActive,
      selected: isSelected,
      legal: handActive && legal.has(c.rank),
      illegal: handActive && legal.size > 0 && !legal.has(c.rank) && !isSelected,
    });
    if (handActive) el.addEventListener("click", () => toggleSelect(c));
    handWrap.appendChild(el);
  });

  const playBtn = $("btn-play");
  playBtn.disabled = selected.size === 0;
  playBtn.onclick = () => {
    if (selected.size === 0) return;
    send({ type: "play_cards", cardIds: Array.from(selected) });
    selected.clear();
  };

  const pickupBtn = $("btn-pickup");
  pickupBtn.disabled = !state.canPickUp;
  pickupBtn.onclick = () => send({ type: "pick_up" });
}

function toggleSelect(card) {
  if (selected.has(card.id)) {
    selected.delete(card.id);
  } else {
    if (selected.size > 0) {
      const firstId = selected.values().next().value;
      const firstRank = firstId.replace(/[SHDC]$/, "");
      if (firstRank !== card.rank) selected.clear();
    }
    selected.add(card.id);
  }
  renderState(lastState);
}

// ---------- card DOM builders ----------

function buildCardEl(card, opts) {
  const div = document.createElement("div");
  const isRed = RED_SUITS.has(card.suit);
  div.className = `card ${isRed ? "suit-red" : "suit-black"}`;
  if (opts.mini) div.classList.add("mini");
  if (opts.selectable) div.classList.add("card--selectable");
  if (opts.selected) div.classList.add("card--selected");
  if (opts.legal) div.classList.add("card--legal");
  if (opts.illegal) div.classList.add("card--illegal");
  const symbol = SUIT_SYMBOL[card.suit] || "?";
  div.innerHTML = `
    <span class="card__corner">${card.rank}${symbol}</span>
    <span class="card__pip">${symbol}</span>
    <span class="card__corner card__corner--bottom">${card.rank}${symbol}</span>
  `;
  return div;
}

function buildBackEl(opts) {
  const div = document.createElement("div");
  div.className = "card card--back";
  if (opts.mini) div.classList.add("mini");
  if (opts.selectable) div.classList.add("card--selectable");
  return div;
}

function rankLabel(rank) {
  return rank;
}

function escapeHtml(str) {
  const d = document.createElement("div");
  d.textContent = str;
  return d.innerHTML;
}

// ---------- form wiring ----------

$("join-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const name = $("input-name").value.trim();
  const code = $("input-room").value.trim().toUpperCase();
  if (!name) return;
  myName = name;
  roomCode = code;
  $("landing-error").textContent = "";
  $("btn-join").disabled = true;
  connect(code, name);
});

$("btn-start").addEventListener("click", () => send({ type: "start" }));

$("btn-again").addEventListener("click", () => {
  sessionStorage.removeItem("shithead_playerId");
  location.reload();
});

$("input-room").addEventListener("input", (e) => {
  e.target.value = e.target.value.toUpperCase();
});

// ---------- how-to-play modal ----------

function openHowToPlay() {
  $("how-to-play-overlay").classList.add("show");
}
function closeHowToPlay() {
  $("how-to-play-overlay").classList.remove("show");
}

$("btn-how-to-play").addEventListener("click", openHowToPlay);
$("btn-how-to-play-game").addEventListener("click", openHowToPlay);
$("modal-close").addEventListener("click", closeHowToPlay);
$("how-to-play-overlay").addEventListener("click", (e) => {
  if (e.target.id === "how-to-play-overlay") closeHowToPlay();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeHowToPlay();
});

// ---------- language switcher ----------

document.querySelectorAll(".lang-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    setLang(btn.dataset.lang);
    applyStaticTranslations();
    if (lastState) renderState(lastState);
  });
});

applyStaticTranslations();

// ---------- sound toggle ----------

setSoundMuted(soundMuted);
$("btn-sound-toggle").addEventListener("click", () => setSoundMuted(!soundMuted));
document.body.addEventListener("pointerdown", unlockAudio, { once: true });
