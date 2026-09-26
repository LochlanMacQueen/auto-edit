#!/usr/bin/env python3
"""Call an auto-edit tool over the stateless MCP endpoint: mcp_call.py <tool> '<json args>'"""
import json, sys, urllib.request
tool = sys.argv[1]; args = json.loads(sys.argv[2]) if len(sys.argv) > 2 else {}
body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": tool, "arguments": args}}).encode()
req = urllib.request.Request("http://127.0.0.1:4747/mcp", data=body, headers={"content-type": "application/json", "accept": "application/json, text/event-stream"})
r = json.loads(urllib.request.urlopen(req, timeout=3600).read().decode())
if "error" in r: print("RPC ERROR", json.dumps(r["error"])[:800]); sys.exit(1)
res = r["result"]
if res.get("isError"): print("TOOL ERROR:", res["content"][0].get("text", "")[:1500]); sys.exit(1)
for c in res.get("content", []):
    if c.get("type") == "text": print(c["text"][:6000])
    elif c.get("type") == "image": print(f"<image {c.get('mimeType')} {len(c.get('data',''))//1024} KB>")
