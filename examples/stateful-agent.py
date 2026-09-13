#!/usr/bin/env python3
"""Offline reference adapter: real SQLite state per dialogue; no LLM or external services.

The supplied prompt is the version under test. 'Allow updates after lookup.' enables
the one known operation. This deterministic fixture demonstrates the prompt workflow,
not an improvement in model quality. No third-party packages are needed.
"""
import hashlib
import json
import re
import sqlite3
import sys
import tempfile
from pathlib import Path


def main():
    with tempfile.TemporaryDirectory(prefix="agent-lab-world-") as directory:
        with sqlite3.connect(Path(directory) / "world.sqlite") as database:
            database.execute("CREATE TABLE records (id TEXT PRIMARY KEY, fields TEXT NOT NULL)")
            turn = 0
            session_id = None
            selected = None
            writable = []
            for line in sys.stdin:
                request = json.loads(line)
                if request.get("type") == "close":
                    return
                if turn == 0:
                    session_id = request["sessionId"]
                    world = request["initialState"]
                    writable = world["writableFields"]
                    database.executemany("INSERT INTO records VALUES (?, ?)", [(key, json.dumps(value)) for key, value in world["records"].items()])
                    database.commit()
                if request["sessionId"] != session_id:
                    raise ValueError("A process owns exactly one session")
                turn += 1
                prompt = request.get("prompt", "Allow updates after lookup.")
                message = request["message"]
                events = []
                ids = [row[0] for row in database.execute("SELECT id FROM records ORDER BY id")]
                mentioned = next((key for key in ids if re.search(r"\b" + re.escape(key) + r"\b", message)), None)
                selected = mentioned or selected
                time = re.search(r"\b(?:[01]\d|2[0-3]):[0-5]\d\b", message)
                reply = "Which record?"
                if selected:
                    fields = json.loads(database.execute("SELECT fields FROM records WHERE id = ?", (selected,)).fetchone()[0])
                    events.append({"tool": "lookup_record", "args": {"recordId": selected}, "result": {"ok": True, "recordId": selected, "record": dict(fields)}})
                    if time and "time" in writable and "Allow updates after lookup." in prompt:
                        fields["time"] = time[0]
                        database.execute("UPDATE records SET fields = ? WHERE id = ?", (json.dumps(fields), selected))
                        database.commit()
                        events.append({"tool": "update_record", "args": {"recordId": selected, "changes": {"time": time[0]}}, "result": {"ok": True, "recordId": selected}})
                        reply = f"Moved {selected} to {time[0]}."
                    else:
                        reply = f"{selected}: {fields.get('time', 'unknown')}."
                records = {key: json.loads(value) for key, value in database.execute("SELECT id, fields FROM records ORDER BY id")}
                response = {"reply": reply, "records": records, "events": events, "eventsComplete": True, "resetConfirmed": True,
                            "version": "sqlite-reference-1", "sessionId": session_id, "turn": turn,
                            "usage": {"calls": 0, "inputTokens": 0, "outputTokens": 0, "costUsd": 0}}
                if "prompt" in request:
                    response["promptHash"] = hashlib.sha256(json.dumps(prompt, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()
                print(json.dumps(response, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
