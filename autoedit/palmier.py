"""JSON-RPC client for Palmier Pro's MCP server (it does not load into a live agent
session, so we talk to it over HTTP and re-expose it through our own server)."""
import itertools
import json
import os
import urllib.error
import urllib.request

from .config import HOME, PALMIER_URL

SESSION_FILE = HOME / ".palmier_session"
_id = itertools.count(100)


def _post(payload, session=None, timeout=600):
    req = urllib.request.Request(PALMIER_URL, data=json.dumps(payload).encode(),
                                 headers={"Content-Type": "application/json",
                                          "Accept": "application/json, text/event-stream"})
    if session:
        req.add_header("MCP-Session-Id", session)
    resp = urllib.request.urlopen(req, timeout=timeout)
    sid = resp.headers.get("MCP-Session-Id")
    body = resp.read().decode()
    msgs = []
    for chunk in body.split("\n\n"):
        data = "\n".join(l[5:].lstrip() for l in chunk.split("\n") if l.startswith("data:")).strip()
        if not data and chunk.strip().startswith("{"):
            data = chunk.strip()
        if data:
            try:
                msgs.append(json.loads(data))
            except json.JSONDecodeError:
                pass
    return sid, msgs


def is_up() -> bool:
    try:
        urllib.request.urlopen(urllib.request.Request(PALMIER_URL, method="GET"), timeout=2)
    except urllib.error.HTTPError as e:
        return e.code in (400, 405, 406)
    except Exception:
        return False
    return True


def _session():
    try:
        return SESSION_FILE.read_text().strip()
    except FileNotFoundError:
        pass
    sid, _ = _post({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
        "protocolVersion": "2025-03-26", "capabilities": {},
        "clientInfo": {"name": "auto-edit", "version": "0.1"}}})
    _post({"jsonrpc": "2.0", "method": "notifications/initialized"}, session=sid)
    SESSION_FILE.write_text(sid or "")
    return sid


def rpc(method, params=None):
    sid = _session()
    payload = {"jsonrpc": "2.0", "id": next(_id), "method": method}
    if params is not None:
        payload["params"] = params
    try:
        _, msgs = _post(payload, session=sid)
    except urllib.error.HTTPError as e:
        if e.code != 404:
            raise
        try:
            os.remove(SESSION_FILE)
        except FileNotFoundError:
            pass
        sid = _session()
        _, msgs = _post(payload, session=sid)
    for m in msgs:
        if "result" in m or "error" in m:
            return m
    return {"error": {"message": "no response", "raw": msgs}}


def tools() -> list[dict]:
    r = rpc("tools/list")
    return r.get("result", {}).get("tools", [])


def call(name: str, arguments: dict | None = None):
    r = rpc("tools/call", {"name": name, "arguments": arguments or {}})
    if "error" in r:
        return {"error": r["error"]}
    res = r["result"]
    texts = [c["text"] for c in res.get("content", []) if c.get("type") == "text"]
    txt = "\n".join(texts)
    try:
        return json.loads(txt)
    except Exception:
        return txt if txt else res
