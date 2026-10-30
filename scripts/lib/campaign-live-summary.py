#!/usr/bin/env python3
"""Read bounded snapshots of existing campaign evidence; never contact a browser.

Incomplete final gzip blocks/NDJSON lines are expected while the match runs.
This is progress information, not the independent acceptance audit.
"""
import collections
import json
import pathlib
import sys
import time
import zlib

root = pathlib.Path(sys.argv[1])
deadline = time.monotonic() + 25
RAW_LIMIT = 512 * 1024 * 1024


def rows(name):
    path = root / name
    if not path.exists():
        return
    remaining = path.stat().st_size  # Do not chase an actively growing stream.
    decoder = zlib.decompressobj(31)
    pending = b""
    raw_bytes = 0
    with path.open("rb") as stream:
        while remaining:
            if time.monotonic() > deadline:
                raise TimeoutError("Bounded live evidence read exceeded 25 seconds")
            block = stream.read(min(65536, remaining))
            if not block:
                break
            remaining -= len(block)
            decoded = decoder.decompress(block)
            raw_bytes += len(decoded)
            if raw_bytes > RAW_LIMIT:
                raise ValueError("Evidence stream exceeds declared read bound")
            pending += decoded
            lines = pending.split(b"\n")
            pending = lines.pop()
            for line in lines:
                if line:
                    yield json.loads(line)
    # Do not flush: an unfinished writer has no complete gzip trailer yet.


result = {"liveSummaryIsNotAcceptance": True, "sampledAt": time.time()}
try:
    result["progress"] = json.loads((root / "progress.json").read_text())
except (FileNotFoundError, json.JSONDecodeError):
    result["progress"] = "absent or between writes"

tails = []
for client in (1, 2):
    recent = collections.deque(maxlen=256)
    deaths = collections.Counter()
    last_health = {}
    count = 0
    for row in rows(f"client-{client}-frames.ndjson.gz"):
        count += 1
        recent.append(row)
        for player in row.get("players", []):
            slot, health = player["slot"], player.get("life")
            if health is not None:
                if last_health.get(slot, 0) > 0 and health <= 0:
                    deaths[slot] += 1
                last_health[slot] = health
    tails.append({row["tick"]: row for row in recent})
    last = recent[-1] if recent else {}
    result[f"client{client}"] = {"records": count, "deaths": dict(deaths),
        **{key: last.get(key) for key in ("tick", "wave", "digest", "players", "inventories", "counters")}}

common = tails[0].keys() & tails[1].keys()
if common:
    tick = max(common)
    a, b = tails[0][tick], tails[1][tick]
    fields = ("digest", "players", "inventories", "rng", "wave", "quota", "counters")
    result["latestCommonSavedFrame"] = {"tick": tick,
        "matchingFields": [key for key in fields if a.get(key) == b.get(key)],
        "differentFields": [key for key in fields if a.get(key) != b.get(key)]}

events = collections.deque(maxlen=12)
kinds = collections.Counter()
for row in rows("pilot.ndjson.gz"):
    kind = row.get("kind", "ordinary-decision")
    kinds[kind] += 1
    if "weapon" in kind or "player-down" in kind or "player-respawned" in kind:
        events.append(row)
result["pilotEventCounts"] = dict(kinds)
result["lastWeaponOrLifeEvents"] = list(events)
print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
