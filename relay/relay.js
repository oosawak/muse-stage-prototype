// muse-stage 中継：舞台用チャットのミューズが返事を POST すると、
// WebSocket で繋いでいる Web版の舞台へ即座に届ける（GitHub 経由よりずっと速い）。
// - POST /reply  {seq, text} + ヘッダー x-stage-secret（合言葉）
// - GET  /latest 最新の返事を返す（繋ぎ直しの取りこぼし防止）
// - WS   /ws     ここへ新しい返事が流れてくる。接続時にも最新を1回送る

export class Relay {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.clients = new Set();
    this.latest = null;
  }

  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/ws') {
      if (req.headers.get('Upgrade') !== 'websocket') return new Response('websocket required', { status: 426 });
      const pair = new WebSocketPair();
      const client = pair[0], server = pair[1];
      server.accept();
      this.clients.add(server);
      const bye = () => this.clients.delete(server);
      server.addEventListener('close', bye);
      server.addEventListener('error', bye);
      if (this.latest) { try { server.send(JSON.stringify(this.latest)); } catch (e) { /* noop */ } }
      return new Response(null, { status: 101, webSocket: client });
    }
    if (url.pathname === '/reply' && req.method === 'POST') {
      if (!this.env.STAGE_SECRET || req.headers.get('x-stage-secret') !== this.env.STAGE_SECRET) {
        return new Response('forbidden', { status: 403 });
      }
      let data;
      try { data = await req.json(); } catch (e) { return new Response('bad json', { status: 400 }); }
      this.latest = { seq: data.seq ?? null, text: String(data.text || '') };
      const msg = JSON.stringify(this.latest);
      for (const ws of [...this.clients]) {
        try { ws.send(msg); } catch (e) { this.clients.delete(ws); }
      }
      return new Response('ok');
    }
    if (url.pathname === '/latest') {
      return Response.json(this.latest || { seq: null, text: '' }, { headers: { 'Access-Control-Allow-Origin': '*' } });
    }
    return new Response('not found', { status: 404 });
  }
}

export default {
  async fetch(req, env) {
    const stub = env.RELAY.get(env.RELAY.idFromName('stage'));
    return stub.fetch(req);
  },
};
