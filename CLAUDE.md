# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A browser-based, multiplayer implementation of the card game Shithead (aka Shed): Python/FastAPI backend over WebSockets, vanilla HTML/CSS/JS frontend, no build step, no database, no test suite. Game state lives entirely in memory in the backend process.

## Commands

Run the dev server:
```bash
cd backend
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn server:app --host 0.0.0.0 --port 8000
```
Then open `http://localhost:8000`. Leave the room code blank to open a new table; other players join with the 4-letter code.

Run via Docker instead:
```bash
docker compose up --build
```
(equivalently `docker build -t shithead . && docker run --rm -p 8000:8000 shithead`). The `Dockerfile` is a multi-stage Alpine build: a `builder` stage with `gcc`/`musl-dev`/`python3-dev`/`libffi-dev` installs deps to `/install`, and the final stage is bare `python:3.12-alpine` copying only `/install`, running as a non-root `appuser`.

There is no lint or test tooling configured in this repo (no pytest, no eslint, no Makefile) — verify changes by running the server and exercising the game through the browser, or by driving `Game` directly in a `python3` REPL (see "Backend architecture" below for the entry points).

## Backend architecture

- **`backend/game.py`** — the entire game engine, pure logic with no networking. `Game` is the authoritative state for one room (players, deck, pile, turn order/direction, phase). `Player` tracks `hand`/`up`/`down` card lists; `Player.phase` (`hand` → `up` → `down` → `done`) is derived from which lists are non-empty and drives what a player is allowed to play. `Card` is a frozen dataclass; `id` is `f"{rank}{suit}"` and doubles as the wire identifier for cards.
- **`backend/server.py`** — FastAPI app with a single `@app.websocket("/ws/{room_code}")` endpoint that relays client actions into the matching `Game` instance and broadcasts `game.public_state(viewer_id)` to every connection in that room after each action. `rooms: dict[str, Game]` and `connections: dict[str, dict[player_id, WebSocket]]` are process-global and in-memory; a room is dropped once its last connection closes. The WebSocket route is registered *before* `app.mount("/", StaticFiles(...))`, which serves `frontend/` — that ordering matters, since the catch-all static mount would otherwise shadow it.
- **Rules implemented** (see `README.md` for the player-facing version): 2–6 players, ranks `2` (lowest) to `A` (highest), whoever holds the 4 of hearts leads (falls back to lowest hand card if 4♥ is still in the draw deck). Specials: `2` always playable, resets the pile; `3` is transparent (`effective_top_rank()` skips over it); `7` flips the comparison to "equal or lower" until broken; `8` reverses turn order (`Game.direction`, ±1) — a no-op made into "go again" when only 2 players remain; `10` and four-of-a-kind-on-top burn the pile and repeat the turn. `Game._advance_or_repeat()` is the single place that decides whether the same player goes again vs. turn passes on.
- **Localization is server-driven, not just a frontend concern.** `GameError` carries a `code: str` plus `**params` instead of a hardcoded English message; `Game._log()` appends structured `{"event": ..., **params}` dicts (not strings) to `self.log`. `server.py` forwards `{"type": "error", "code", "params"}` on `GameError`. This exists so both error toasts and the live game log can be localized per-client — see "i18n" below. When adding a new failure mode or log line, add a new `code`/`event` name and params rather than an inline message.

## Frontend architecture

Plain scripts, loaded in order in `index.html`: `i18n.js` then `app.js`. No bundler, no framework.

- **`frontend/i18n.js`** — `TRANSLATIONS` dict keyed by `en`/`de`/`it`/`fr`, each a flat `"namespace.key": "string"` map (`landing.*`, `lobby.*`, `game.*`, `over.*`, `modal.*`, `err.*`, `log.*`). Keys ending in `_html` are meant to be set via `innerHTML` (they contain `<strong>`/`<li>` markup); everything else is plain text. `t(key, params)` does `{param}` substitution and falls back to English then to the raw key if a translation is missing. **All four language blocks must stay in sync** — every key added to `en` needs the same key added to `de`/`it`/`fr`, or that locale silently falls back to English for it.
- **`frontend/app.js`** — owns the WebSocket client (`connect()`/`send()`/`handleMessage()`), all DOM rendering, and UI state. Static UI text is wired via `data-i18n` / `data-i18n-placeholder` / `data-i18n-title` / `data-i18n-aria` attributes in `index.html`, applied by `applyStaticTranslations()`; dynamic text (turn banner, rank requirement, log lines, error toasts) is built with `t()` at render time. The whole game screen is re-rendered from scratch on every `state` broadcast (`renderState()` → `renderLobby()`/`renderGame()`/`renderGameOver()`) rather than patched incrementally — there's no virtual-DOM diffing, so rendering functions just rebuild `innerHTML`/children each time.
  - Card piles (own face-down/face-up, and opponents' mini versions) are built by overlaying a `card--back` element with the matching face-up `Card` on top at the same position (`.pile-stack`), by index — this assumes `up.length <= downCount`, which the game engine guarantees (face-up cards are always emptied before face-down cards are touched).
  - `myPlayerId` is a UUID persisted in `sessionStorage` (`shithead_playerId`) so a reload rejoins the same seat; it is intentionally per-tab (not `localStorage`) so multiple tabs in the same browser can be distinct players for local testing.
  - Turn-change audio (`playTurnChime()`) is synthesized with the Web Audio API — no audio asset files. It only plays on a `false → true` transition of "is it my turn", tracked via the module-level `wasMyTurn`, and only after `unlockAudio()` has run off a first `pointerdown` (autoplay-policy workaround).
  - Language (`localStorage: shithead_lang`) and sound-mute (`localStorage: shithead_sound_muted`) preferences are per-browser and shared across tabs/rooms.
- **`frontend/style.css`** — single stylesheet, CSS custom properties in `:root` for the felt/brass palette. No preprocessor.
