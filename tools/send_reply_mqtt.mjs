// 舞台用チャット（MQTT用）の返事を、公開MQTT中継へ送る道具。
// 使い方（返事の文を標準入力で渡す）:
//   printf '%s' "返事の文" | node tools/send_reply_mqtt.mjs
// - 合言葉（トピック名の鍵）は ~/workspace/stage-relay-topic.txt から読む（リポには入れない）
// - 連番は ~/workspace/stage-relay-seq.txt で自動管理（前回+1）
// - retain 付きで送る（舞台ページは接続直後の1件を基準として読み飛ばす）
// - この VM からは egress プロキシ経由でないと外へ出られないため、HTTPS_PROXY を使う
import { connect } from 'mqtt';
import { HttpsProxyAgent } from 'https-proxy-agent';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = os.homedir();
const key = fs.readFileSync(path.join(home, 'workspace/stage-relay-topic.txt'), 'utf8').trim();
const seqFile = path.join(home, 'workspace/stage-relay-seq.txt');
let seq = 0;
try { seq = parseInt(fs.readFileSync(seqFile, 'utf8').trim(), 10) || 0; } catch (e) { /* 初回 */ }
seq += 1;

const text = fs.readFileSync(0, 'utf8').trim();
if (!text) { console.error('empty text'); process.exit(1); }

const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
const opts = { connectTimeout: 20000 };
if (proxy) opts.wsOptions = { agent: new HttpsProxyAgent(proxy) };

const client = connect('wss://broker.emqx.io:8084/mqtt', opts);
const timer = setTimeout(() => { console.error('timeout'); process.exit(1); }, 40000);
client.on('connect', () => {
  client.publish('muse-stage/' + key + '/reply', JSON.stringify({ seq, text }), { qos: 1, retain: true }, err => {
    clearTimeout(timer);
    if (err) { console.error('publish error: ' + err.message); process.exit(1); }
    fs.writeFileSync(seqFile, String(seq));
    console.log('sent seq=' + seq);
    client.end();
    process.exit(0);
  });
});
client.on('error', e => { clearTimeout(timer); console.error('error: ' + e.message); process.exit(1); });
