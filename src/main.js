// muse-stage：VRM のミューズを表示し、返事のテキストを読み上げて口パクする（出力専用）
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';

const $ = s => document.querySelector(s);
const inTauri = '__TAURI_INTERNALS__' in window;
let invoke = async () => { throw new Error('Tauri の外では使えません'); };
let tauriWindow = null;
if (inTauri) {
  ({ invoke } = await import('@tauri-apps/api/core'));
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  tauriWindow = getCurrentWindow();
}
const errText = e => String(e?.message ?? e); // Rust 側のエラーは文字列で届く
const report = msg => { console.log('[muse-stage]', msg); if (inTauri) invoke('report', { msg }).catch(() => {}); };
const setStatus = t => { $('#status').textContent = t; };
// 声・速さなどの選択を覚えておく（使えないときは覚えないだけで、動きは変わらない）
const prefs = { get(k, d) { try { const v = localStorage.getItem('muse-stage.' + k); return v === null ? d : v; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('muse-stage.' + k, String(v)); } catch (e) {} } };
const rateMul = () => Number($('#rate').value) || 1; // 1 が標準。say には 1 分あたりの語数（標準 175）に直して渡す（Kyoko は効きが小さいので 2 乗で強める）

/* ---------- 3D の舞台 ---------- */
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(2, devicePixelRatio || 1));
renderer.outputColorSpace = THREE.SRGBColorSpace;
$('#stage').appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0d0b14);
// うしろに柔らかい光の輪（プロジェクターで暗く沈まないように）
const glow = new THREE.Mesh(new THREE.CircleGeometry(1.4, 64), new THREE.MeshBasicMaterial({ color: 0x3b2366, transparent: true, opacity: .55 }));
glow.position.set(0, 1.35, -1.2); scene.add(glow);
const camera = new THREE.PerspectiveCamera(26, 1, .05, 50);
scene.add(new THREE.HemisphereLight(0xffffff, 0x443355, 1.1));
const key = new THREE.DirectionalLight(0xffffff, 1.6); key.position.set(1.2, 2.2, 2.4); scene.add(key);
const rim = new THREE.DirectionalLight(0xc77dff, 1.2); rim.position.set(-1.6, 1.8, -1.5); scene.add(rim);

let vrm = null, placeholder = null, headY = 1.4;
function frameCamera() {
  // 上半身を大きく：頭の高さを中心に、胸から上が入るように
  const w = innerWidth, h = innerHeight; renderer.setSize(w, h, false);
  camera.aspect = w / h;
  const dist = w / h < 1 ? 2.6 : 1.9;
  camera.position.set(0, headY - .05, dist); camera.lookAt(0, headY - .18, 0);
  camera.updateProjectionMatrix();
}
addEventListener('resize', frameCamera);

function buildPlaceholder() {
  // VRM が読めないときの代わり：頭と胴と口だけの簡易な人形
  const g = new THREE.Group();
  const skin = new THREE.MeshStandardMaterial({ color: 0xf2d6c4, roughness: .7 });
  const head = new THREE.Mesh(new THREE.SphereGeometry(.13, 32, 24), skin); head.position.y = 1.45; g.add(head);
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(.14, .35, 8, 16), new THREE.MeshStandardMaterial({ color: 0x6b4aa8 })); body.position.y = 1.1; g.add(body);
  const mouth = new THREE.Mesh(new THREE.BoxGeometry(.05, .012, .01), new THREE.MeshBasicMaterial({ color: 0x5a1f2a })); mouth.position.set(0, 1.41, .125); g.add(mouth);
  for (const sx of [-1, 1]) { const e = new THREE.Mesh(new THREE.SphereGeometry(.012, 12, 8), new THREE.MeshBasicMaterial({ color: 0x222222 })); e.position.set(sx * .045, 1.47, .12); g.add(e); }
  g.userData.mouth = mouth; scene.add(g); placeholder = g; headY = 1.45;
}

async function loadVRM(url) {
  const loader = new GLTFLoader(); loader.register(p => new VRMLoaderPlugin(p));
  const gltf = await loader.loadAsync(url);
  const v = gltf.userData.vrm; if (!v) throw new Error('VRM として読めませんでした');
  VRMUtils.removeUnnecessaryVertices(gltf.scene);
  VRMUtils.rotateVRM0(v);
  if (vrm) { scene.remove(vrm.scene); VRMUtils.deepDispose(vrm.scene); }
  if (placeholder) { scene.remove(placeholder); placeholder = null; }
  vrm = v; scene.add(v.scene);
  // 腕を下ろす（T ポーズのままにしない）
  const b = n => v.humanoid.getNormalizedBoneNode(n);
  if (b('leftUpperArm')) b('leftUpperArm').rotation.z = -1.2;
  if (b('rightUpperArm')) b('rightUpperArm').rotation.z = 1.2;
  const head = b('head'); if (head) { v.scene.updateMatrixWorld(true); headY = head.getWorldPosition(new THREE.Vector3()).y; }
  frameCamera();
  return v.meta?.name || v.meta?.title || 'VRM';
}

/* ---------- 口パク・まばたき・待機の動き ---------- */
let speaking = false, mouth = 0, blinkT = 2;
const clock = new THREE.Clock();
function tick() {
  const dt = Math.min(.05, clock.getDelta()), t = clock.elapsedTime;
  // 口：話している間は、母音らしく開いたり閉じたりする（単純な開閉）
  const target = speaking ? Math.max(0, Math.sin(t * 17) * .55 + Math.sin(t * 7.3) * .35 + .25) : 0;
  mouth += (target - mouth) * Math.min(1, dt * 18);
  blinkT -= dt; let blink = 0;
  if (blinkT < 0) { blink = Math.max(0, 1 - Math.abs(blinkT + .08) / .08); if (blinkT < -.16) blinkT = rand(2.5, 5.5); }
  if (vrm) {
    const em = vrm.expressionManager;
    if (em) { em.setValue('aa', Math.min(1, mouth)); em.setValue('oh', Math.min(1, mouth * .3)); em.setValue('blink', blink); em.setValue('happy', .15); }
    const b = n => vrm.humanoid.getNormalizedBoneNode(n);
    // 呼吸と、話しているときの小さなうなずき
    const sp = b('spine'); if (sp) sp.rotation.x = Math.sin(t * 1.6) * .015;
    const hd = b('head'); if (hd) { hd.rotation.x = speaking ? Math.sin(t * 3.1) * .04 : Math.sin(t * .9) * .015; hd.rotation.y = Math.sin(t * .5) * .05; }
    vrm.update(dt);
  } else if (placeholder) {
    placeholder.userData.mouth.scale.y = 1 + mouth * 6;
    placeholder.rotation.y = Math.sin(t * .5) * .08;
  }
  glow.material.opacity = .45 + (speaking ? .15 * (Math.sin(t * 6) * .5 + .5) : 0);
  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}
function rand(a, b) { return a + Math.random() * (b - a); }

/* ---------- 読み上げ ---------- */
// 自動：まず WebView の speechSynthesis を試し、動かなければ macOS の say に逃がす（一度だめなら以後は say）
let webOk = null; // null=まだ試していない true/false=試した結果
function webVoices() { return (window.speechSynthesis?.getVoices() || []).filter(v => /^ja/i.test(v.lang)); }

function speakWeb(text) {
  return new Promise((resolve, reject) => {
    const ss = window.speechSynthesis;
    if (!ss || typeof SpeechSynthesisUtterance === 'undefined') return reject(new Error('speechSynthesis がありません'));
    ss.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'ja-JP'; u.rate = rateMul(); const jv = webVoices(); if (jv.length) u.voice = jv.find(v => /kyoko/i.test(v.name)) || jv[0];
    let started = false;
    const timer = setTimeout(() => { if (!started) { ss.cancel(); reject(new Error('1.5 秒たっても読み上げが始まりません')); } }, 1500);
    u.onstart = () => { started = true; clearTimeout(timer); speaking = true; };
    u.onboundary = e => showCaptionProgress(text, e.charIndex);
    u.onend = () => { clearTimeout(timer); speaking = false; started ? resolve('web') : reject(new Error('始まらずに終わりました')); };
    u.onerror = e => { clearTimeout(timer); speaking = false; reject(new Error('speechSynthesis のエラー: ' + (e.error || '?'))); };
    ss.speak(u);
  });
}
async function speakSay(text) {
  if (!inTauri) throw new Error('say は Tauri アプリの中でだけ使えます');
  speaking = true;
  try { const r = await invoke('speak_say', { text, voice: $('#voice').value || 'Kyoko', rate: Math.round(175 * rateMul() ** 2) }); return r === 'stopped' ? 'stopped' : 'say'; }
  finally { speaking = false; }
}
async function speak(text) {
  text = text.trim(); if (!text) return;
  stop(); showCaption(text);
  const mode = $('#engine').value;
  $('#btnSpeak').disabled = true;
  try {
    let used;
    if (mode === 'web' || (mode === 'auto' && webOk !== false)) {
      try { used = await speakWeb(text); webOk = true; }
      catch (e) {
        report(`speechSynthesis: 使えません（${e.message}）`);
        if (mode === 'web') throw e;
        webOk = false; setStatus('speechSynthesis が使えないので、macOS の say で読み上げます');
        used = await speakSay(text);
      }
    } else used = await speakSay(text);
    setStatus(used === 'web' ? '読み上げ：WebView の speechSynthesis' : used === 'say' ? `読み上げ：macOS の say（${$('#voice').value || 'Kyoko'}）` : '止めました');
    report(`読み上げ完了: ${used}`);
    return used;
  } catch (e) { setStatus('読み上げられませんでした：' + errText(e)); report('読み上げ失敗: ' + errText(e)); }
  finally { $('#btnSpeak').disabled = false; speaking = false; setTimeout(hideCaption, 1200); }
}
function stop() {
  speaking = false;
  try { window.speechSynthesis?.cancel(); } catch (e) {}
  if (inTauri) invoke('stop_say').catch(() => {});
}

/* ---------- 字幕 ---------- */
function showCaption(text) {
  if (!$('#chkCaption').checked) return;
  $('#caption').innerHTML = `<span class="done"></span><span class="rest"></span>`;
  showCaptionProgress(text, 0); $('#caption').classList.add('on');
}
function showCaptionProgress(text, i) {
  const c = $('#caption'); if (!c.firstChild) return;
  c.querySelector('.done').textContent = text.slice(0, i); c.querySelector('.rest').textContent = text.slice(i);
}
function hideCaption() { if (!speaking) $('#caption').classList.remove('on'); }

/* ---------- 操作 ---------- */
$('#btnSpeak').onclick = () => speak($('#text').value);
$('#btnStop').onclick = () => { stop(); setStatus('止めました'); hideCaption(); };
async function toggleFull() {
  if (tauriWindow) { const f = await tauriWindow.isFullscreen(); await tauriWindow.setFullscreen(!f); }
  else if (!document.fullscreenElement) document.documentElement.requestFullscreen?.(); else document.exitFullscreen?.();
}
$('#btnFull').onclick = toggleFull;
addEventListener('keydown', e => {
  if (e.target.closest('textarea, input, select')) {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); speak($('#text').value); } // ⌘Enter で読み上げ
    return;
  }
  if (e.key === 'f' || e.key === 'F') toggleFull();
  if (e.key === ' ') { e.preventDefault(); speak($('#text').value); }
  if (e.key === 'Escape') stop();
  if (e.key === 'h' || e.key === 'H') { const off = document.body.classList.toggle('no-panel'); prefs.set('noPanel', off ? 1 : 0); }
  if (e.key === '[' || e.key === ']') { const r = $('#rate'); r.value = Math.min(1.4, Math.max(0.6, rateMul() + (e.key === ']' ? .05 : -.05))).toFixed(2); r.dispatchEvent(new Event('input')); setStatus(`速さ ${Number(r.value).toFixed(2)}`); }
});
// 選んだものを覚える
$('#rate').addEventListener('input', () => { $('#rateVal').textContent = rateMul().toFixed(2); prefs.set('rate', $('#rate').value); });
$('#voice').addEventListener('change', () => prefs.set('voice', $('#voice').value));
$('#engine').addEventListener('change', () => prefs.set('engine', $('#engine').value));
$('#chkCaption').addEventListener('change', () => prefs.set('caption', $('#chkCaption').checked ? 1 : 0));
$('#rate').value = prefs.get('rate', '0.9'); $('#rateVal').textContent = rateMul().toFixed(2);
$('#engine').value = prefs.get('engine', 'auto');
$('#chkCaption').checked = prefs.get('caption', '1') === '1';
if (prefs.get('noPanel', '0') === '1') document.body.classList.add('no-panel');
// マウスを動かしたときだけ、操作パネルを濃く見せる
let awakeT = 0; addEventListener('mousemove', () => { document.body.classList.add('awake'); clearTimeout(awakeT); awakeT = setTimeout(() => document.body.classList.remove('awake'), 2500); });
// VRM ファイルを画面に落とすと入れ替わる
addEventListener('dragover', e => e.preventDefault());
addEventListener('drop', async e => {
  e.preventDefault(); const f = [...e.dataTransfer.files].find(f => /\.vrm$/i.test(f.name)); if (!f) return;
  const url = URL.createObjectURL(f); try { setStatus(`VRM「${await loadVRM(url)}」を読み込みました`); } catch (err) { setStatus('VRM を読めませんでした：' + err.message); } finally { URL.revokeObjectURL(url); }
});

/* ---------- 第2段：Muse.app の返事をアクセシビリティで取り込む（実験） ---------- */
// Muse アプリの会話メッセージは「アシスタントメッセージ: 本文」の形で取れる（2026-11-14 実機で確認）。
// 同じ階層では並び順＝新しさの順なので、接頭辞つきの最後のものを最新の返事とし、接頭辞を外して返す。
// 接頭辞つきが無いときは、従来どおり長めの文の最後のものを返す
function pickLatestReply(texts) {
  const mine = assistantReplies(texts);
  if (mine.length) return mine[mine.length - 1];
  const long = texts.filter(t => t.trim().length >= 6);
  return (long[long.length - 1] || texts[texts.length - 1] || '').trim();
}
// 接頭辞つきのアシスタント返事だけを、接頭辞を外して古い順に取り出す（重複は1つにまとめる）
function assistantReplies(texts) {
  const out = [];
  for (const t of texts) {
    const s = t.trim();
    if (s.startsWith('アシスタントメッセージ:')) {
      const body = s.replace(/^アシスタントメッセージ:\s*/, '');
      if (body && !out.includes(body)) out.push(body);
    }
  }
  return out;
}
// 取り込んだ返事を右側の一覧に出す。自動で選んだ「最新」が実際とずれていても、ここで選び直せる。
// 項目を選ぶと、その返事を欄に入れて読み上げる
function renderReplies(replies) {
  const list = $('#replyList');
  list.innerHTML = '';
  $('#repliesCount').textContent = replies.length ? `${replies.length} 件` : '';
  $('#replies').classList.toggle('show', replies.length > 0);
  [...replies].reverse().forEach((body, i) => {
    const b = document.createElement('button');
    b.className = 'reply-item';
    b.textContent = body.replace(/\s+/g, ' ').slice(0, 70);
    b.title = body.slice(0, 300);
    b.onclick = () => {
      list.querySelectorAll('.reply-item').forEach(el => el.classList.remove('playing'));
      b.classList.add('playing');
      $('#text').value = body;
      speak(body);
    };
    list.appendChild(b);
  });
}
async function grabMuse(manual = false) {
  if (!inTauri) throw new Error('アプリの中でだけ使えます');
  // 手動の取り込みは十数秒かかるので、クルクルと「取り込み中」を出してボタンを止める（自動の見回りでは出さない）
  if (manual) { $('#spinner').classList.add('on'); $('#btnGrab').disabled = true; setStatus('Muse.app から取り込み中…'); }
  try {
    const texts = await invoke('read_muse', { app: 'Muse' });
    report(`Muse.app から ${texts.length} 個の文字を読めました`);
    const replies = assistantReplies(texts);
    renderReplies(replies);
    return { texts, replies, latest: pickLatestReply(texts) };
  } finally {
    if (manual) { $('#spinner').classList.remove('on'); $('#btnGrab').disabled = false; }
  }
}
$('#btnGrab').onclick = async () => {
  try { const { texts, replies, latest } = await grabMuse(true); $('#text').value = latest; setStatus(`Muse.app から取り込みました（返事 ${replies.length} 件・画面の文字 ${texts.length} 個。右の一覧からも選べます）`); }
  catch (e) { setStatus('取り込めませんでした：' + errText(e) + '（システム設定 → プライバシーとセキュリティ → アクセシビリティ で Muse Stage を許可）'); report('取り込み失敗: ' + errText(e)); }
};
// 自動：2 秒ごとに見て、新しい返事が出たら読み上げる（読み上げ中は待つ）
let lastAuto = null, autoBusy = false;
setInterval(async () => {
  if (!$('#chkAuto').checked || autoBusy || speaking) return;
  autoBusy = true;
  try {
    const { latest } = await grabMuse();
    if (lastAuto === null) lastAuto = latest; // 付けた時点の返事は読まない
    else if (latest && latest !== lastAuto) { lastAuto = latest; $('#text').value = latest; await speak(latest); }
  } catch (e) { $('#chkAuto').checked = false; setStatus('自動で読めないので止めました：' + errText(e)); }
  finally { autoBusy = false; }
}, 2000);

/* ---------- 起動 ---------- */
(async function boot() {
  frameCamera(); requestAnimationFrame(tick);
  try { const name = await loadVRM('models/VRM1_Constraint_Twist_Sample.vrm'); report(`VRM 読み込み: ${name}`); }
  catch (e) { buildPlaceholder(); frameCamera(); report('VRM を読めないので簡易な人形で表示: ' + e.message); }
  $('#loading').classList.add('hide');
  // 声の一覧（say 用）
  let voices = [];
  if (inTauri) { try { voices = await invoke('ja_voices'); } catch (e) {} }
  if (!voices.length) voices = ['Kyoko'];
  const savedVoice = prefs.get('voice', 'Kyoko'), pick = voices.includes(savedVoice) ? savedVoice : 'Kyoko';
  $('#voice').innerHTML = voices.map(v => `<option${v === pick ? ' selected' : ''}>${v}</option>`).join('');
  // speechSynthesis の声は、少し遅れて届くことがある
  await new Promise(r => setTimeout(r, 600));
  const ss = !!window.speechSynthesis;
  report(`speechSynthesis: ${ss ? 'あり' : 'なし'}・日本語の声 ${webVoices().length} 件（全体 ${window.speechSynthesis?.getVoices().length ?? 0} 件）・say の日本語の声 ${voices.join(',')}`);
  setStatus(`準備できました（${inTauri ? 'アプリ' : 'ブラウザ'}）。スペースキーか「読み上げ」で話します`);
  // 自己確認：MUSE_SELFTEST=1 で起動したら、既定の文を自動で読み上げて結果を記録する
  if (inTauri && await invoke('selftest').catch(() => false)) {
    report('自己確認：自動モードで読み上げます');
    const used = await speak($('#text').value);
    report(`自己確認の結果：${used || '失敗'}（webOk=${webOk}）`);
    $('#engine').value = 'web'; const w = await speak('ウェブビューの読み上げを確かめます'); report(`自己確認 web 固定：${w || '失敗'}`);
    $('#engine').value = 'say'; const s = await speak('セイの読み上げを確かめます'); report(`自己確認 say 固定：${s || '失敗'}`);
    $('#engine').value = 'auto';
    if (tauriWindow) { await tauriWindow.setFullscreen(true); await new Promise(r => setTimeout(r, 1500)); report(`自己確認 全画面：${await tauriWindow.isFullscreen()}・画面 ${innerWidth}x${innerHeight}`); await tauriWindow.setFullscreen(false); }
    try { const { texts, latest } = await grabMuse(); report(`自己確認 Muse 取り込み：${texts.length} 個・最新「${latest.slice(0, 40)}」`); }
    catch (e) { report('自己確認 Muse 取り込み：失敗 ' + errText(e)); }
    report('自己確認おわり');
  }
})();
