#!/usr/bin/env python3
"""Minimal MCP-over-HTTP client for palmier-pro."""
import json, os, sys, urllib.request, urllib.error, itertools

URL = "http://127.0.0.1:19789/mcp"
SESSION_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".palmier_session")
_id = itertools.count(100)

def _post(payload, session=None):
    req = urllib.request.Request(URL, data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json",
                 "Accept": "application/json, text/event-stream"})
    if session:
        req.add_header("MCP-Session-Id", session)
    resp = urllib.request.urlopen(req, timeout=600)
    sid = resp.headers.get("MCP-Session-Id")
    body = resp.read().decode()
    msgs = []
    for chunk in body.split("\n\n"):
        data_lines = [l[5:].lstrip() for l in chunk.split("\n") if l.startswith("data:")]
        data = "\n".join(data_lines).strip()
        if data:
            try:
                msgs.append(json.loads(data))
            except json.JSONDecodeError:
                pass
    return sid, msgs

def ensure_session():
    try:
        return open(SESSION_FILE).read().strip()
    except FileNotFoundError:
        pass
    sid, _ = _post({"jsonrpc":"2.0","id":1,"method":"initialize","params":{
        "protocolVersion":"2025-03-26","capabilities":{},
        "clientInfo":{"name":"claude-code-bridge","version":"1.0"}}})
    _post({"jsonrpc":"2.0","method":"notifications/initialized"}, session=sid)
    open(SESSION_FILE,"w").write(sid)
    return sid

def _recover():
    import os
    try: os.remove(SESSION_FILE)
    except FileNotFoundError: pass
    sid = ensure_session()
    _post({"jsonrpc":"2.0","id":next(_id),"method":"tools/call","params":{"name":"get_timeline","arguments":{}}}, session=sid)
    return sid

def rpc(method, params=None):
    sid = ensure_session()
    payload = {"jsonrpc":"2.0","id":next(_id),"method":method}
    if params is not None:
        payload["params"] = params
    try:
        _, msgs = _post(payload, session=sid)
    except urllib.error.HTTPError as e:
        if e.code != 404: raise
        sid = _recover()
        _, msgs = _post(payload, session=sid)
    for m in msgs:
        if "result" in m or "error" in m:
            return m
    return {"error": {"message": "no response", "raw": msgs}}

def call_tool(name, arguments, image_prefix=None):
    r = rpc("tools/call", {"name": name, "arguments": arguments})
    if "error" in r:
        return {"error": r["error"]}
    res = r["result"]
    out = []
    img_n = 0
    for c in res.get("content", []):
        if c.get("type") == "text":
            out.append(c["text"])
        elif c.get("type") == "image" and image_prefix:
            import base64
            ext = "png" if "png" in c.get("mimeType","png") else "jpg"
            p = f"{image_prefix}_{img_n}.{ext}"
            with open(p, "wb") as f:
                f.write(base64.b64decode(c["data"]))
            img_n += 1
    txt = "\n".join(out)
    try:
        parsed = json.loads(txt)
    except Exception:
        parsed = txt
    if image_prefix and img_n:
        return {"result": parsed, "images_saved": img_n}
    return parsed

if __name__ == "__main__":
    cmd = sys.argv[1]
    if cmd == "list":
        r = rpc("tools/list")
        for t in r["result"]["tools"]:
            print(t["name"], "-", t.get("description","")[:120].replace("\n"," "))
    elif cmd == "call":
        name = sys.argv[2]
        args = json.loads(sys.argv[3]) if len(sys.argv) > 3 else {}
        result = call_tool(name, args)
        print(json.dumps(result, indent=2) if isinstance(result,(dict,list)) else result)
    elif cmd == "reset":
        import os
        os.remove(SESSION_FILE)
        print("session reset")
