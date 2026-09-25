"""Shithead (Shed) card game engine. Pure game logic, no networking."""
from __future__ import annotations

import random
from dataclasses import dataclass, field
from enum import Enum
from typing import Optional

SUITS = ["S", "H", "D", "C"]
RANKS = ["2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A"]
RANK_VALUE = {r: i for i, r in enumerate(RANKS)}
MIN_PLAYERS = 2
MAX_PLAYERS = 6
HAND_SIZE = 3
DOWN_SIZE = 3
UP_SIZE = 3


class Phase(str, Enum):
    LOBBY = "lobby"
    PLAYING = "playing"
    FINISHED = "finished"


@dataclass(frozen=True)
class Card:
    rank: str
    suit: str

    @property
    def id(self) -> str:
        return f"{self.rank}{self.suit}"

    def to_dict(self):
        return {"rank": self.rank, "suit": self.suit, "id": self.id}


def make_deck() -> list[Card]:
    deck = [Card(r, s) for r in RANKS for s in SUITS]
    random.shuffle(deck)
    return deck


@dataclass
class Player:
    id: str
    name: str
    hand: list[Card] = field(default_factory=list)
    up: list[Card] = field(default_factory=list)
    down: list[Card] = field(default_factory=list)
    connected: bool = True
    finished_rank: Optional[int] = None  # order in which they finished, 1 = first out

    @property
    def is_out(self) -> bool:
        return self.finished_rank is not None

    @property
    def phase(self) -> str:
        if self.hand:
            return "hand"
        if self.up:
            return "up"
        if self.down:
            return "down"
        return "done"


class GameError(Exception):
    """Carries a translation code + params instead of a hardcoded message,
    so the client can localize it."""

    def __init__(self, code: str, **params):
        self.code = code
        self.params = params
        super().__init__(code)


class Game:
    """Authoritative state for one Shithead room. Not thread-safe; caller serializes access."""

    def __init__(self, room_code: str):
        self.room_code = room_code
        self.phase = Phase.LOBBY
        self.players: dict[str, Player] = {}  # id -> Player, insertion order = seating
        self.order: list[str] = []
        self.deck: list[Card] = []
        self.pile: list[Card] = []
        self.turn_index: int = 0
        self.direction: int = 1
        self.winner_order: list[str] = []  # ids in the order they finished (1st out ... last = shithead)
        self.log: list[dict] = []  # structured events; client localizes and formats them
        self.host_id: Optional[str] = None

    # ---------- lobby ----------

    def add_player(self, pid: str, name: str) -> None:
        if self.phase != Phase.LOBBY:
            raise GameError("game_already_started")
        if pid in self.players:
            self.players[pid].connected = True
            return
        if len(self.players) >= MAX_PLAYERS:
            raise GameError("room_full")
        self.players[pid] = Player(id=pid, name=name)
        self.order.append(pid)
        if self.host_id is None:
            self.host_id = pid

    def remove_player(self, pid: str) -> None:
        if self.phase == Phase.LOBBY and pid in self.players:
            del self.players[pid]
            self.order.remove(pid)
            if self.host_id == pid:
                self.host_id = self.order[0] if self.order else None
        elif pid in self.players:
            self.players[pid].connected = False

    def start(self, starter_id: str) -> None:
        if self.phase != Phase.LOBBY:
            raise GameError("game_already_started")
        if starter_id != self.host_id:
            raise GameError("host_only_start")
        if len(self.players) < MIN_PLAYERS:
            raise GameError("need_min_players", min=MIN_PLAYERS)
        self.deck = make_deck()
        for pid in self.order:
            p = self.players[pid]
            p.down = [self.deck.pop() for _ in range(DOWN_SIZE)]
            p.up = [self.deck.pop() for _ in range(UP_SIZE)]
            p.hand = [self.deck.pop() for _ in range(HAND_SIZE)]
        self.pile = []
        self.phase = Phase.PLAYING
        self.direction = 1
        self.turn_index = self._starting_player_index()
        self._log("game_started", count=len(self.players))

    def _starting_player_index(self) -> int:
        # whoever was dealt the 4 of hearts leads
        for i, pid in enumerate(self.order):
            p = self.players[pid]
            if any(c.rank == "4" and c.suit == "H" for c in p.hand + p.up + p.down):
                return i
        # 4H wasn't dealt to anyone (still in the draw deck) - lowest hand card leads instead
        best_idx, best_val = 0, 999
        for i, pid in enumerate(self.order):
            for c in self.players[pid].hand:
                v = RANK_VALUE[c.rank]
                if v < best_val:
                    best_val, best_idx = v, i
        return best_idx

    # ---------- helpers ----------

    def _log(self, event: str, **params) -> None:
        self.log.append({"event": event, **params})
        self.log = self.log[-50:]

    @property
    def current_player_id(self) -> Optional[str]:
        active = [pid for pid in self.order if not self.players[pid].is_out]
        if not active:
            return None
        return self.order[self.turn_index]

    def _active_order(self) -> list[str]:
        return [pid for pid in self.order if not self.players[pid].is_out]

    def _advance_turn(self) -> None:
        active = self._active_order()
        if len(active) <= 1:
            return
        n = len(self.order)
        i = self.turn_index
        for _ in range(n):
            i = (i + self.direction) % n
            if not self.players[self.order[i]].is_out:
                self.turn_index = i
                return

    def _advance_or_repeat(self, player: Player, rank: str, burned: bool) -> None:
        """Move play on to the next player, honouring burns and the 8's direction swap."""
        if player.is_out:
            self._advance_turn()
            return
        if burned:
            return  # 10 or a bomb: same player goes again
        if rank == "8":
            if len(self._active_order()) <= 2:
                return  # heads-up: reversing direction is a no-op, so just go again
            self.direction *= -1
        self._advance_turn()

    def effective_top_rank(self) -> Optional[str]:
        """Walk down the pile skipping transparent 3s; None means anything is legal."""
        for card in reversed(self.pile):
            if card.rank == "3":
                continue
            return card.rank
        return None

    def _is_legal(self, rank: str) -> bool:
        if rank == "2":
            return True  # always playable, resets the pile
        top = self.effective_top_rank()
        if top == "7":
            return RANK_VALUE[rank] <= RANK_VALUE["7"]
        if rank == "10":
            return True  # always playable, except against an active 7
        if top is None:
            return True
        return RANK_VALUE[rank] >= RANK_VALUE[top]

    def _four_of_a_kind_on_top(self) -> bool:
        if len(self.pile) < 4:
            return False
        last4 = self.pile[-4:]
        return len({c.rank for c in last4}) == 1

    def _refill_hand(self, player: Player) -> None:
        while len(player.hand) < HAND_SIZE and self.deck:
            player.hand.append(self.deck.pop())

    def legal_hand_ranks(self, pid: str) -> list[str]:
        """Ranks in the player's *current* active zone that are legal to play right now."""
        player = self.players[pid]
        zone = getattr(player, player.phase) if player.phase in ("hand", "up") else []
        ranks = {c.rank for c in zone}
        return sorted(r for r in ranks if self._is_legal(r))

    def can_play_anything(self, pid: str) -> bool:
        player = self.players[pid]
        if player.phase == "down":
            return True  # blind play always "attempted"
        if player.phase == "done":
            return False
        return len(self.legal_hand_ranks(pid)) > 0

    # ---------- actions ----------

    def play_cards(self, pid: str, card_ids: list[str]) -> dict:
        if self.phase != Phase.PLAYING:
            raise GameError("not_in_progress")
        if self.current_player_id != pid:
            raise GameError("not_your_turn")
        player = self.players[pid]
        if player.phase == "done":
            raise GameError("no_cards_left")
        if player.phase == "down":
            raise GameError("use_play_down")
        zone_name = player.phase
        zone: list[Card] = getattr(player, zone_name)
        chosen = [c for c in zone if c.id in card_ids]
        if len(chosen) != len(card_ids) or not chosen:
            raise GameError("invalid_selection")
        ranks = {c.rank for c in chosen}
        if len(ranks) != 1:
            raise GameError("same_rank_required")
        rank = chosen[0].rank
        if not self._is_legal(rank):
            top = self.effective_top_rank()
            raise GameError("cannot_beat", rank=rank, top=top)
        for c in chosen:
            zone.remove(c)
        self.pile.extend(chosen)
        self._log("played", player=player.name, cards=[c.id for c in chosen])

        if zone_name == "hand":
            self._refill_hand(player)

        result = {"burned": False, "finished": False}
        burn = rank == "10" or self._four_of_a_kind_on_top()
        if burn:
            self.pile = []
            result["burned"] = True
            self._log("burned", player=player.name)

        if not player.hand and not player.up and not player.down:
            self._finish_player(player)
            result["finished"] = True

        self._advance_or_repeat(player, rank, burn)
        self._check_game_over()
        return result

    def play_down(self, pid: str, index: int) -> dict:
        if self.phase != Phase.PLAYING:
            raise GameError("not_in_progress")
        if self.current_player_id != pid:
            raise GameError("not_your_turn")
        player = self.players[pid]
        if player.phase != "down":
            raise GameError("still_have_hand_or_up")
        if not isinstance(index, int) or not (0 <= index < len(player.down)):
            raise GameError("invalid_down_card")
        card = player.down.pop(index)
        legal = self._is_legal(card.rank)
        self._log("flipped", player=player.name, card=card.id)
        result = {"revealed": card.to_dict(), "success": legal, "burned": False, "finished": False}

        if legal:
            self.pile.append(card)
            burn = card.rank == "10" or self._four_of_a_kind_on_top()
            if burn:
                self.pile = []
                result["burned"] = True
                self._log("burned", player=player.name)
            if not player.hand and not player.up and not player.down:
                self._finish_player(player)
                result["finished"] = True
            self._advance_or_repeat(player, card.rank, burn)
        else:
            self.pile.append(card)
            player.hand.extend(self.pile)
            self._log("flip_failed_pickup", player=player.name, count=len(self.pile))
            self.pile = []
            self._advance_turn()

        self._check_game_over()
        return result

    def pick_up(self, pid: str) -> None:
        if self.phase != Phase.PLAYING:
            raise GameError("not_in_progress")
        if self.current_player_id != pid:
            raise GameError("not_your_turn")
        player = self.players[pid]
        if player.phase == "down":
            raise GameError("use_play_down_pickup")
        if self.can_play_anything(pid):
            raise GameError("has_legal_move")
        if not self.pile:
            raise GameError("pile_empty")
        player.hand.extend(self.pile)
        self._log("picked_up", player=player.name, count=len(self.pile))
        self.pile = []
        self._advance_turn()

    def _finish_player(self, player: Player) -> None:
        rank = len(self.winner_order) + 1
        player.finished_rank = rank
        self.winner_order.append(player.id)
        self._log("player_out", player=player.name, place=rank)

    def _check_game_over(self) -> None:
        active = self._active_order()
        if len(active) <= 1 and self.phase == Phase.PLAYING:
            if active:
                loser = self.players[active[0]]
                loser.finished_rank = len(self.winner_order) + 1
                self.winner_order.append(loser.id)
                self._log("shithead", player=loser.name)
            self.phase = Phase.FINISHED

    # ---------- serialization ----------

    def public_state(self, viewer_id: str) -> dict:
        players = []
        for pid in self.order:
            p = self.players[pid]
            is_viewer = pid == viewer_id
            players.append({
                "id": p.id,
                "name": p.name,
                "connected": p.connected,
                "handCount": len(p.hand),
                "hand": [c.to_dict() for c in p.hand] if is_viewer else None,
                "up": [c.to_dict() for c in p.up],
                "downCount": len(p.down),
                "isOut": p.is_out,
                "finishedRank": p.finished_rank,
                "phase": p.phase,
            })
        me = self.players.get(viewer_id)
        is_my_turn = False
        can_pick_up = False
        if me is not None and self.current_player_id == viewer_id and not me.is_out:
            is_my_turn = True
            can_pick_up = (
                me.phase != "down"
                and bool(self.pile)
                and not self.can_play_anything(viewer_id)
            )
        return {
            "roomCode": self.room_code,
            "phase": self.phase.value,
            "hostId": self.host_id,
            "players": players,
            "deckCount": len(self.deck),
            "pile": [c.to_dict() for c in self.pile[-20:]],
            "pileCount": len(self.pile),
            "currentPlayerId": self.current_player_id,
            "direction": self.direction,
            "effectiveTopRank": self.effective_top_rank(),
            "legalRanks": self.legal_hand_ranks(viewer_id) if is_my_turn else [],
            "canPickUp": can_pick_up,
            "winnerOrder": [self.players[w].name for w in self.winner_order],
            "log": self.log[-15:],
        }
