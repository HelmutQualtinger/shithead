"""FastAPI + WebSocket server for multiplayer Shithead. Serves the static
frontend and relays game actions to the authoritative Game engine."""
from __future__ import annotations

import json
import random
import string
import uuid
from pathlib import Path

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from game import Game, GameError

FRONTEND_DIR = Path(__file__).resolve().parent.parent / "frontend"

app = FastAPI(title="Shithead")

rooms: dict[str, Game] = {}
# room_code -> {player_id: WebSocket}
connections: dict[str, dict[str, WebSocket]] = {}


def new_room_code() -> str:
    while True:
        code = "".join(random.choices(string.ascii_uppercase, k=4))
        if code not in rooms:
            return code


async def broadcast_state(room_code: str) -> None:
    game = rooms.get(room_code)
    conns = connections.get(room_code, {})
    if not game:
        return
    for pid, ws in list(conns.items()):
        try:
            await ws.send_json({"type": "state", "state": game.public_state(pid)})
        except Exception:
            pass


async def send_error(ws: WebSocket, code: str, params: dict | None = None) -> None:
    try:
        await ws.send_json({"type": "error", "code": code, "params": params or {}})
    except Exception:
        pass


@app.websocket("/ws/{room_code}")
async def ws_endpoint(websocket: WebSocket, room_code: str):
    await websocket.accept()
    room_code = room_code.upper()
    player_id: str | None = None
    try:
        # first message must be a join
        raw = await websocket.receive_text()
        msg = json.loads(raw)
        if msg.get("type") != "join":
            await send_error(websocket, "bad_first_message")
            await websocket.close()
            return

        name = (msg.get("name") or "Player").strip()[:20] or "Player"
        player_id = msg.get("playerId") or str(uuid.uuid4())

        if room_code == "NEW":
            room_code = new_room_code()

        game = rooms.get(room_code)
        if game is None:
            game = Game(room_code)
            rooms[room_code] = game
            connections[room_code] = {}

        try:
            game.add_player(player_id, name)
        except GameError as e:
            await send_error(websocket, e.code, e.params)
            await websocket.close()
            return

        stale_ws = connections[room_code].get(player_id)
        if stale_ws is not None and stale_ws is not websocket:
            # Another live connection already claims this player id - most likely a
            # duplicated browser tab that inherited the same sessionStorage id.
            # Close it instead of silently orphaning it (it would otherwise keep its
            # socket open but never appear in `connections` again, so it would stop
            # receiving broadcasts - looking like it "never gets dealt any cards").
            try:
                await stale_ws.close()
            except Exception:
                pass

        connections[room_code][player_id] = websocket
        await websocket.send_json({
            "type": "joined",
            "playerId": player_id,
            "roomCode": room_code,
        })
        await broadcast_state(room_code)

        while True:
            raw = await websocket.receive_text()
            msg = json.loads(raw)
            mtype = msg.get("type")
            try:
                if mtype == "start":
                    game.start(player_id)
                elif mtype == "play_cards":
                    game.play_cards(player_id, msg.get("cardIds", []))
                elif mtype == "play_down":
                    game.play_down(player_id, msg.get("index"))
                elif mtype == "pick_up":
                    game.pick_up(player_id)
                elif mtype == "ping":
                    continue
                else:
                    await send_error(websocket, "unknown_message_type", {"type": mtype})
                    continue
            except GameError as e:
                await send_error(websocket, e.code, e.params)
                continue
            await broadcast_state(room_code)

    except WebSocketDisconnect:
        pass
    finally:
        if player_id and room_code in connections:
            connections[room_code].pop(player_id, None)
            game = rooms.get(room_code)
            if game:
                game.remove_player(player_id)
                if not connections[room_code]:
                    # keep finished/started games around briefly isn't needed; drop empty rooms
                    rooms.pop(room_code, None)
                    connections.pop(room_code, None)
                else:
                    await broadcast_state(room_code)


app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")
