# Shithead

A browser-based, multiplayer implementation of the card game Shithead (aka Shed).
Python backend (FastAPI + WebSockets), vanilla HTML/CSS/JS frontend, no build step.

## Rules implemented

- 2–6 players, 52-card deck, 3 cards face-down, 3 face-up on top, hand of 3.
  Ranks run `2` (lowest) to `A` (highest).
- Whoever was dealt the 4 of hearts leads the first trick (if nobody was —
  it's still in the draw deck in a small game — the lowest hand card leads
  instead).
- Play equal-or-higher rank than the top of the pile; multiple cards of the
  same rank can be played together. No legal move → pick up the whole pile.
- Special cards:
  - `2` — always playable on anything; resets the pile so the next player can
    follow with any card.
  - `3` — transparent; the next player plays against whatever's underneath it.
  - `7` — flips the requirement: the next card played must be a 7 or lower,
    until broken by a `2` or a burn.
  - `8` — reverses turn order (3+ players); heads-up, the same player just
    goes again.
  - `10` — always playable (except against an active 7); burns the pile and
    the player goes again.
  - Four of a kind on top of the pile also burns it, and the player goes again.
- Once your hand and the deck are empty, play from your face-up cards, then
  your face-down cards (blind — you find out if it was legal when you flip it).
- First to shed all their cards is safe; the last player left holding cards is
  the Shithead.

## Run it

```bash
cd backend
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn server:app --host 0.0.0.0 --port 8000
```

Then open `http://localhost:8000` in a browser. One player leaves the room
code blank to open a new table; everyone else enters that 4-letter code.

### Or with Docker

```bash
docker compose up --build
```

(equivalently: `docker build -t shithead . && docker run --rm -p 8000:8000 shithead`)

Then open `http://localhost:8000`.

## Playing over the internet

The server needs to be reachable by everyone at the table:

- **Quick/temporary**: run the command above, then tunnel port 8000 with
  something like `ssh -R` or a tunneling service, and share the resulting URL.
- **Proper hosting**: build the Docker image and run it on any host that
  supports long-lived containers with WebSocket support (Fly.io, Render, a
  VPS, etc.), or deploy `backend/` (which also serves `frontend/`) directly —
  `uvicorn server:app --host 0.0.0.0 --port $PORT` is the whole entrypoint.
  No database, no build step.

Game state lives in memory per process, so a single instance is enough; it
resets if the process restarts.

## Project layout

```text
backend/
  game.py        game engine (pure logic, no networking)
  server.py      FastAPI app: WebSocket protocol + static file serving
  requirements.txt
frontend/
  index.html
  style.css
  app.js         WebSocket client + rendering
Dockerfile
docker-compose.yml
```
