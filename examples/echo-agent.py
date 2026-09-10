#!/usr/bin/env python3
"""Reference command adapter for Agent Lab: run a local Python agent without any HTTP.

Agent Lab starts this script once per dialogue and speaks JSON lines:
  stdin  -> {"type": "respond", "sessionId": ..., "scenarioId": ..., "initialState": {...}, "messages": [...], "message": "..."}
  stdout <- "plain reply"  or  {"reply": "...", "events": [{"tool": ..., "args": ..., "result": ...}], "records": {...}}
  stdin  -> {"type": "close", "sessionId": ...}   (then stdin ends)

Replace `handle` with a call into your RAG agent. Keep one reply per request and flush stdout.
"""
import json
import re
import sys


def handle(request):
    message = request["message"]
    records = json.loads(json.dumps(request["initialState"]["records"]))
    match = re.search(r"\b(?:[01]\d|2[0-3]):[0-5]\d\b", message)
    if records and match:
        record_id = next(iter(records))
        before = dict(records[record_id])
        records[record_id]["time"] = match.group(0)
        return {
            "reply": f"Moved {record_id} to {match.group(0)}.",
            "events": [
                {"tool": "lookup_record", "args": {"recordId": record_id}, "result": {"ok": True, "recordId": record_id, "record": before}},
                {"tool": "update_record", "args": {"recordId": record_id, "changes": {"time": match.group(0)}}, "result": {"ok": True, "recordId": record_id, "record": records[record_id]}},
            ],
            "records": records,
        }
    return {"reply": f"You said: {message}", "events": [], "records": records}


for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    request = json.loads(line)
    if request.get("type") == "close":
        break
    sys.stdout.write(json.dumps(handle(request), ensure_ascii=False) + "\n")
    sys.stdout.flush()
