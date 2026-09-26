// auto-edit: stdio -> HTTP shim for Claude Desktop. Forwards each JSON-RPC line to the
// local server (stateless streamable HTTP, JSON responses) and writes the reply back.
const URL_BASE = process.env.AUTOEDIT_URL || 'http://127.0.0.1:4747/mcp';
const log = (...a) => console.error('[auto-edit]', ...a);
const out = (m) => process.stdout.write(JSON.stringify(m) + '\n');
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (line) handle(line);
  }
});
async function handle(line) {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      const r = await fetch(URL_BASE, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: line });
      if (r.status === 202 || r.status === 204) return;               // notification accepted
      const text = await r.text();
      if (!text) return;
      const ct = r.headers.get('content-type') || '';
      if (ct.includes('text/event-stream')) {
        for (const block of text.split('\n\n')) {
          const data = block.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join('\n');
          if (data) out(JSON.parse(data));
        }
      } else {
        out(JSON.parse(text));
      }
      return;
    } catch (e) {
      if (attempt === 0) log('server not reachable at', URL_BASE, '- retrying (is auto-edit running? open http://127.0.0.1:4747)');
      await new Promise(res => setTimeout(res, 1500));
    }
  }
  if (msg.id !== undefined) out({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'auto-edit server is not running on 127.0.0.1:4747' } });
}
