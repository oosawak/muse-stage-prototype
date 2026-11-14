// muse-stage：VRM のミューズを表示し、返事のテキストを読み上げて口パクする（出力専用）
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';
import { VRMAnimationLoaderPlugin, createVRMAnimationClip } from '@pixiv/three-vrm-animation';
import mqtt from 'mqtt';

const $ = s => document.querySelector(s);
const inTauri = '__TAURI_INTERNALS__' in window;
let invoke = async () => { throw new Error('Tauri の外では使えません'); };
let tauriWindow = null, hookListen = null;
if (inTauri) {
  ({ invoke } = await import('@tauri-apps/api/core'));
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  tauriWindow = getCurrentWindow();
  ({ listen: hookListen } = await import('@tauri-apps/api/event'));
}
const errText = e => String(e?.message ?? e); // Rust 側のエラーは文字列で届く
const report = msg => { console.log('[muse-stage]', msg); if (inTauri) invoke('report', { msg }).catch(() => {}); };
const setStatus = t => { $('#status').textContent = t; };
// 声・速さなどの選択を覚えておく（使えないときは覚えないだけで、動きは変わらない）
const prefs = { get(k, d) { try { const v = localStorage.getItem('muse-stage.' + k); return v === null ? d : v; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('muse-stage.' + k, String(v)); } catch (e) {} } };
const rateMul = () => Number($('#rate').value) || 1; // 1 が標準。say には 1 分あたりの語数（標準 175）に直して渡す（Kyoko は効きが小さいので 2 乗で強める）

/* ---------- 3D の舞台 ---------- */
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setClearColor(0x000000, 0); // 発表モードでは背景を透明にする
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
// キーとリムは台（actor）に追従させる。奥へ行っても光の当たり方が変わらないように、ライトと的をリグに入れて台の x/z へ合わせる
const lightRig = new THREE.Group(); scene.add(lightRig);
const key = new THREE.DirectionalLight(0xffffff, 1.6); key.position.set(1.2, 2.2, 2.4); lightRig.add(key); key.target.position.set(0, .9, 0); lightRig.add(key.target);
const rim = new THREE.DirectionalLight(0xc77dff, 1.2); rim.position.set(-1.6, 1.8, -1.5); lightRig.add(rim); rim.target.position.set(0, 1, 0); lightRig.add(rim.target);

let vrm = null, placeholder = null, headY = 1.4;
const actor = new THREE.Group(); scene.add(actor); // モデルを載せる台。うろうろ・かくれんぼは、この台ごと動かす
let modelH = 1.4, modelW = .5;
function frameCamera() {
  // 上半身を大きく：頭の高さを中心に、胸から上が入るように
  const w = innerWidth, h = innerHeight; renderer.setSize(w, h, false);
  camera.aspect = w / h;
  const dist = (w / h < 1 ? 2.6 : 1.9) * (modelH / 1.4); // 背の高いモデルほどカメラを引く（CC0モデルが近すぎた件）
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
  if (vrm) { actor.remove(vrm.scene); VRMUtils.deepDispose(vrm.scene); }
  if (placeholder) { scene.remove(placeholder); placeholder = null; }
  if (mixer) { mixer.stopAllAction(); mixer = null; }
  for (const k of Object.keys(actions)) delete actions[k];
  curAction = null; curMotion = '';
  vrm = v; actor.add(v.scene);
  actor.position.set(0, 0, 0); actor.rotation.set(0, 0, 0);
  const box = new THREE.Box3().setFromObject(v.scene);
  modelH = Math.max(.3, box.max.y - box.min.y); modelW = Math.max(.2, box.max.x - box.min.x);
  director.state = 'idle'; director.t = 1; director.target = null;
  // 腕を下ろす（T ポーズのままにしない）
  const b = n => v.humanoid.getNormalizedBoneNode(n);
  if (b('leftUpperArm')) b('leftUpperArm').rotation.z = -1.2;
  if (b('rightUpperArm')) b('rightUpperArm').rotation.z = 1.2;
  const head = b('head'); if (head) { v.scene.updateMatrixWorld(true); headY = head.getWorldPosition(new THREE.Vector3()).y; }
  frameCamera();
  setupMotions();
  return v.meta?.name || v.meta?.title || 'VRM';
}

/* ---------- モーション（VRMA）と、うろうろする演出 ---------- */
// モーション素材は CC0（Quaternius／KayKit を open-vrma が VRMA 化したもの）。出典は MOTIONS.md
const MOTION_FILES = { idle: 'Idle_Loop', talk: 'Idle_Talking_Loop', walk: 'Walk_Loop', jog: 'Jog_Fwd_Loop', yes: 'Yes', no: 'Idle_No_Loop', dance: 'Dance_Loop', crouch: 'Crouch_Idle_Loop', jump: 'Jump_Loop', roll: 'Roll', punch: 'Punch_Jab', sword: 'Sword_Attack', spell: 'Spell_Simple_Shoot', hit: 'Hit_Chest', death: 'Death01' };
const ONESHOT = new Set(['yes', 'no', 'jump', 'punch', 'sword', 'spell', 'hit', 'death']); // 1回だけ再生する動き
let mixer = null; const actions = {}; let curAction = null, curMotion = '';
async function setupMotions() {
  if (!vrm) return;
  mixer = new THREE.AnimationMixer(vrm.scene);
  const loader = new GLTFLoader(); loader.register(p => new VRMAnimationLoaderPlugin(p));
  for (const [name, file] of Object.entries(MOTION_FILES)) {
    try {
      const g = await loader.loadAsync('motions/' + file + '.vrma');
      const anim = g.userData.vrmAnimations?.[0]; if (!anim) continue;
      const a = mixer.clipAction(createVRMAnimationClip(anim, vrm));
      a.setLoop(ONESHOT.has(name) ? THREE.LoopOnce : THREE.LoopRepeat);
      if (ONESHOT.has(name)) a.clampWhenFinished = true;
      actions[name] = a;
    } catch (e) { report('モーションを読めませんでした: ' + file); }
  }
  playMotion(speaking ? 'talk' : 'idle', 0);
}
function playMotion(name, fade = .3) {
  const a = actions[name]; if (!a || curAction === a) return;
  a.enabled = true; a.setEffectiveWeight(1); a.fadeIn(fade); a.play();
  if (curAction) curAction.fadeOut(fade);
  curAction = a; curMotion = name;
}
function stopMotion() { if (curAction) { curAction.fadeOut(.3); curAction = null; curMotion = ''; } }

// 演出の状態遷移：idle →（歩く・走る・隠れる・踊る）→ idle を繰り返す
const director = { mode: 'wander', state: 'idle', t: 2, target: null, pendingPeek: null, hideY: 0, yesPlease: false, gesture: '', jumps: 0, quiet: 0, seq: [], rollCool: 0 };
try { director.mode = prefs.get('motion', 'wander'); } catch (e) {}
function viewHalf() {
  const dist = camera.position.z;
  const halfH = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * dist;
  return { halfH, halfW: halfH * camera.aspect, dist, camY: camera.position.y, centerY: headY - .18 };
}
function halfAt(z) { // 奥行き z の位置で見える範囲（カメラからの距離で縮む）
  const v = viewHalf(); const s = (v.dist - z) / v.dist;
  return { halfW: v.halfW * s, halfH: v.halfH * s, centerY: v.camY + (v.centerY - v.camY) * s };
}
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
function turnToward(cur, target, maxStep) {
  let diff = (target - cur) % (Math.PI * 2);
  if (diff > Math.PI) diff -= Math.PI * 2; if (diff < -Math.PI) diff += Math.PI * 2;
  return cur + clamp(diff, -maxStep, maxStep);
}
const faceCamera = dt => { actor.rotation.y = turnToward(actor.rotation.y, 0, dt * 3.5); };
function toIdle(t) {
  director.target = null; director.pendingPeek = null;
  if (director.seq.length) { runStep(director.seq.shift()); return; } // 物語の続きがあれば、そちらへ
  director.state = 'idle'; director.t = t;
}
function setMove(x, z, clip) {
  director.state = 'move';
  director.target = { x, z, clip, speed: clip === 'jog' ? 1.25 : .5 };
}
function startGesture(name) { director.state = 'gesture'; director.gesture = name; playMotion(name, .15); }
function goPeekSide(side) {
  const z = clamp(actor.position.z, -.8, .4), h = halfAt(z);
  director.pendingPeek = 'side';
  setMove(side * (h.halfW + modelW * .5 - .13), z, 'walk');
}
function goPeekBottom() {
  const h = halfAt(actor.position.z);
  director.hideY = (h.centerY - h.halfH) - modelH * .78;
  director.state = 'peekBottom'; director.t = rand(2.5, 4.5);
}
function goRoll() {
  // ころころは回転が多く、見ていて目が回るので連発しない（間隔をあける）
  if (director.rollCool > 0) { const v0 = viewHalf(); setMove(clamp(actor.position.x + rand(-1, 1) * .7, -v0.halfW * .7, v0.halfW * .7), actor.position.z, 'walk'); return; }
  director.rollCool = 40;
  const v = viewHalf(), cx = actor.position.x;
  const dur = actions.roll?.getClip().duration || 1;
  const nx = clamp(cx + rand(-1, 1) * .9, -v.halfW * .7, v.halfW * .7);
  director.state = 'move';
  director.target = { x: nx, z: actor.position.z, clip: 'roll', speed: Math.abs(nx - cx) / dur || .6 };
}
/* 物語：静かな時間が続いたら、小さな一続きの演技をする */
function runStep(s) {
  const v = viewHalf();
  switch (s.k) {
    case 'move': setMove(s.x, s.z, s.clip || 'walk'); break;
    case 'peekSide': goPeekSide(s.side || (Math.random() < .5 ? -1 : 1)); break;
    case 'peekBottom': goPeekBottom(); break;
    case 'roll': goRoll(); break;
    case 'dance': director.state = 'dance'; director.t = s.t || 6; break;
    case 'jump': director.state = 'jump'; director.jumps = 2; playMotion('jump', .1); break;
    case 'gesture': startGesture(s.name || 'yes'); break;
    default: director.state = 'idle'; director.t = s.t || 1; // ひと休み
  }
}
function startStory() {
  const stories = [
    // かくれんぼ：下に隠れる → 端から顔 → 反対の端から顔 → 跳ねて出てくる
    [{ k: 'peekBottom' }, { k: 'rest', t: .5 }, { k: 'peekSide', side: -1 }, { k: 'peekSide', side: 1 }, { k: 'jump' }, { k: 'gesture', name: 'yes' }],
    // 探検：奥へ走る → 端から様子見 → 手前に戻って踊る
    [{ k: 'move', x: rand(-.5, .5), z: -1.25, clip: 'jog' }, { k: 'peekSide' }, { k: 'move', x: 0, z: .3, clip: 'walk' }, { k: 'dance', t: 6 }],
    // おどりの練習：踊る → 跳ねる → もっと踊る（踊りは短めに）
    [{ k: 'dance', t: 5 }, { k: 'jump' }, { k: 'dance', t: 5 }, { k: 'gesture', name: 'yes' }],
    // ころころ散歩：転がって移動は1回だけ → 踊る → 歩いて戻る → うなずく
    [{ k: 'roll' }, { k: 'dance', t: 5 }, { k: 'move', x: 0, z: .3, clip: 'walk' }, { k: 'gesture', name: 'yes' }],
  ];
  director.seq = stories[Math.floor(Math.random() * stories.length)].slice();
  runStep(director.seq.shift());
}
function chooseNext() {
  const v = viewHalf(), cx = actor.position.x, cz = actor.position.z, r = Math.random();
  if (r < .20) { // ちょこちょこ：近くの点へ歩く
    setMove(clamp(cx + rand(-1, 1) * .85, -v.halfW * .8, v.halfW * .8), clamp(cz + rand(-1, 1) * .5, -1.1, .5), 'walk');
  } else if (r < .31) { // 奥へ走る／手前へ戻る
    setMove(rand(-.6, .6), cz > -.5 ? -1.25 : rand(.1, .5), 'jog');
  } else if (r < .43) { // 端に隠れて顔だけ出す
    goPeekSide(Math.random() < .5 ? -1 : 1);
  } else if (r < .53) { // 下に隠れて顔だけ出す
    goPeekBottom();
  } else if (r < .60) { // ぴょんぴょん跳ねる（2回）
    director.state = 'jump'; director.jumps = 2; playMotion('jump', .1);
  } else if (r < .615) { // ころころ転がって移動する（回転が多く目が回るので、めったに出さない）
    goRoll();
  } else if (r < .765) { // 踊る（長く回らないよう短めに）
    director.state = 'dance'; director.t = rand(4, 6.5);
  } else if (r < .795) { // たまに首を振る（いやいや）
    startGesture('no');
  } else toIdle(rand(3, 6));
}
function directorUpdate(dt) {
  if (!vrm || !mixer || !actions.idle) return;
  if (director.mode === 'off') { stopMotion(); return; }
  if (director.mode === 'stay') { playMotion(speaking ? 'talk' : 'idle'); faceCamera(dt); return; }
  // 話している間は、おまかせ演出（歩く・踊る・隠れる等）を止めて、その場で正面を向いて喋る（2026-11-14 本人要望）
  if (speaking) {
    if (director.state !== 'idle') { director.state = 'idle'; director.t = 2; }
    director.seq = []; director.pendingPeek = null; director.target = null; director.quiet = 0;
    actor.position.y += (0 - actor.position.y) * Math.min(1, dt * 4); // 下に隠れている途中なら、立ち位置に戻る
    playMotion('talk'); faceCamera(dt);
    return;
  }
  director.t -= dt;
  if (director.rollCool > 0) director.rollCool -= dt;
  switch (director.state) {
    case 'idle':
      if (speaking) director.quiet = 0; else director.quiet += dt; // 静かな時間をはかる
      if (director.yesPlease && actions.yes) { director.yesPlease = false; startGesture('yes'); break; }
      playMotion(speaking ? 'talk' : 'idle'); faceCamera(dt);
      if (director.t <= 0) {
        if (speaking) director.t = 1.5;
        else if (director.quiet > 18 && !director.seq.length) startStory(); // しばらく話がなければ、物語を始める
        else chooseNext();
      }
      break;
    case 'gesture': // うなずく・首を振る（1回だけの動きが終わるまで待つ）
      faceCamera(dt);
      if (!actions[director.gesture]?.isRunning()) toIdle(rand(1.2, 2.5));
      break;
    case 'jump':
      faceCamera(dt);
      if (!actions.jump?.isRunning()) {
        director.jumps--;
        if (director.jumps > 0) { const a = actions.jump; a.reset(); a.setEffectiveWeight(1); a.play(); }
        else toIdle(rand(1.5, 3));
      }
      break;
    case 'dance':
      playMotion('dance'); faceCamera(dt);
      if (director.t <= 0) toIdle(rand(2, 4));
      break;
    case 'move': {
      const tg = director.target; if (!tg) { toIdle(1); break; }
      playMotion(tg.clip);
      const dx = tg.x - actor.position.x, dz = tg.z - actor.position.z, d = Math.hypot(dx, dz);
      if (d < .06) {
        if (director.pendingPeek === 'side') { director.pendingPeek = null; director.state = 'peekSide'; director.t = rand(2.5, 4.5); }
        else toIdle(rand(2, 5));
        break;
      }
      actor.rotation.y = turnToward(actor.rotation.y, Math.atan2(dx, dz), dt * 4.5);
      const step = Math.min(d, tg.speed * dt);
      actor.position.x += Math.sin(actor.rotation.y) * step;
      actor.position.z += Math.cos(actor.rotation.y) * step;
      break;
    }
    case 'peekSide':
      playMotion('idle'); faceCamera(dt);
      if (director.t <= 0) { const v = viewHalf(); setMove(actor.position.x > 0 ? v.halfW * .35 : -v.halfW * .35, actor.position.z, 'walk'); }
      break;
    case 'peekBottom':
      playMotion('crouch'); faceCamera(dt);
      actor.position.y += (director.hideY - actor.position.y) * Math.min(1, dt * 3);
      if (director.t <= 0) director.state = 'riseBottom';
      break;
    case 'riseBottom':
      playMotion('idle');
      actor.position.y += (0 - actor.position.y) * Math.min(1, dt * 3);
      if (Math.abs(actor.position.y) < .01) { actor.position.y = 0; toIdle(rand(2, 4)); }
      break;
    default: toIdle(2);
  }
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
    directorUpdate(dt);
    if (mixer) mixer.update(dt);
    if (!curAction) { // モーション再生中は骨をそちらに任せ、止まっている間だけ呼吸とうなずきを付ける
      const b = n => vrm.humanoid.getNormalizedBoneNode(n);
      const sp = b('spine'); if (sp) sp.rotation.x = Math.sin(t * 1.6) * .015;
      const hd = b('head'); if (hd) { hd.rotation.x = speaking ? Math.sin(t * 3.1) * .04 : Math.sin(t * .9) * .015; hd.rotation.y = Math.sin(t * .5) * .05; }
    }
    vrm.update(dt);
  } else if (placeholder) {
    placeholder.userData.mouth.scale.y = 1 + mouth * 6;
    placeholder.rotation.y = Math.sin(t * .5) * .08;
  }
  glow.material.opacity = .45 + (speaking ? .15 * (Math.sin(t * 6) * .5 + .5) : 0);
  lightRig.position.set(actor.position.x, 0, actor.position.z);
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
/* ---------- VOICEVOX（ずんだもん）で読み上げ ---------- */
// VOICEVOX は同じマシンで動く音声合成エンジン（http://127.0.0.1:50021）に文章を渡すと WAV が返る。
// ずんだもんの「ノーマル」のスタイル ID は通常 3。起動していれば /speakers から正確に引き直す
const VV_BASE = 'http://127.0.0.1:50021';
let vvSpeakerId = null, vvAudio = null, vvUrl = null;
async function zundamonSpeakerId() {
  if (vvSpeakerId !== null) return vvSpeakerId;
  try {
    const speakers = await (await fetch(VV_BASE + '/speakers')).json();
    const z = speakers.find(s => (s.name || '').includes('ずんだもん'));
    const st = z?.styles?.find(s => s.name === 'ノーマル') || z?.styles?.[0];
    if (st) { vvSpeakerId = st.id; return vvSpeakerId; }
  } catch (e) { /* 引けなければ既定の 3 を使う */ }
  vvSpeakerId = 3; return vvSpeakerId;
}
async function speakVoicevox(text) {
  let speaker;
  try { speaker = await zundamonSpeakerId(); }
  catch (e) { throw new Error('VOICEVOX に接続できません'); }
  let query;
  try {
    const r = await fetch(`${VV_BASE}/audio_query?speaker=${speaker}&` + new URLSearchParams({ text }), { method: 'POST' });
    if (!r.ok) throw new Error('audio_query ' + r.status);
    query = await r.json();
  } catch (e) { throw new Error('VOICEVOX が起動していないようです（アプリを起動してから試してください）'); }
  query.speedScale = rateMul(); // 速さのつまみを VOICEVOX の速度に渡す
  const r2 = await fetch(`${VV_BASE}/synthesis?speaker=${speaker}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(query) });
  if (!r2.ok) throw new Error('VOICEVOX の合成に失敗しました（' + r2.status + '）');
  const wav = await r2.blob();
  stopVoicevox();
  vvUrl = URL.createObjectURL(wav);
  return new Promise((resolve, reject) => {
    const a = new Audio(vvUrl); vvAudio = a; speaking = true;
    a.onended = () => { speaking = false; if (vvAudio === a) vvAudio = null; resolve('voicevox'); };
    a.onerror = () => { speaking = false; reject(new Error('音声を再生できませんでした')); };
    a.play().catch(err => { speaking = false; reject(err); });
  });
}
function stopVoicevox() {
  if (vvAudio) { try { vvAudio.pause(); } catch (e) {} vvAudio = null; }
  if (vvUrl) { URL.revokeObjectURL(vvUrl); vvUrl = null; }
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
    if (mode === 'voicevox') used = await speakVoicevox(text);
    else if (mode === 'web' || (mode === 'auto' && webOk !== false)) {
      try { used = await speakWeb(text); webOk = true; }
      catch (e) {
        report(`speechSynthesis: 使えません（${e.message}）`);
        if (mode === 'web') throw e;
        webOk = false; setStatus('speechSynthesis が使えないので、macOS の say で読み上げます');
        used = await speakSay(text);
      }
    } else used = await speakSay(text);
    setStatus(used === 'voicevox' ? '読み上げ：VOICEVOX（ずんだもん）' : used === 'web' ? '読み上げ：WebView の speechSynthesis' : used === 'say' ? `読み上げ：macOS の say（${$('#voice').value || 'Kyoko'}）` : '止めました');
    report(`読み上げ完了: ${used}`);
    return used;
  } catch (e) { setStatus('読み上げられませんでした：' + errText(e)); report('読み上げ失敗: ' + errText(e)); }
  finally { $('#btnSpeak').disabled = false; speaking = false; setTimeout(hideCaption, 1200); }
}
function stop() {
  speaking = false;
  stopVoicevox();
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
  if (e.key === 'ArrowRight' || e.key === 'PageDown') { if (slides.urls.length) { e.preventDefault(); showSlide(slides.i + 1); } }
  if (e.key === 'ArrowLeft' || e.key === 'PageUp') { if (slides.urls.length) { e.preventDefault(); showSlide(slides.i - 1); } }
  if (e.key === '[' || e.key === ']') { const r = $('#rate'); r.value = Math.min(1.4, Math.max(0.6, rateMul() + (e.key === ']' ? .05 : -.05))).toFixed(2); r.dispatchEvent(new Event('input')); setStatus(`速さ ${Number(r.value).toFixed(2)}`); }
});
/* ---------- 舞台の背景：スライド表示中だけ透かす（透過ウィンドウは 2026-11-14 に本人が取りやめ） ---------- */
function updateStageBackground() {
  const clear = slides.urls.length > 0;
  scene.background = clear ? null : new THREE.Color(0x0d0b14);
  glow.visible = !clear;
}

/* ---------- スライド表示：舞台の後ろにスライドを敷き、キャラクターがその手前で動く ---------- */
const slides = { urls: [], names: [], i: 0 };
function showSlide(i) {
  if (!slides.urls.length) return;
  slides.i = Math.min(slides.urls.length - 1, Math.max(0, i));
  $('#slideImg').src = slides.urls[slides.i];
  $('#slideImg').style.display = 'block';
  $('#slideCount').textContent = (slides.i + 1) + ' / ' + slides.urls.length;
  updateStageBackground();
}
function clearSlides() {
  slides.urls.forEach(u => URL.revokeObjectURL(u));
  slides.urls = []; slides.names = []; slides.i = 0;
  $('#slideImg').removeAttribute('src'); $('#slideImg').style.display = 'none';
  $('#slideCount').textContent = '';
  updateStageBackground();
}
$('#slideFiles').addEventListener('change', e => {
  const files = [...e.target.files].sort((a, b) => a.name.localeCompare(b.name, 'ja', { numeric: true }));
  if (!files.length) return;
  clearSlides();
  slides.urls = files.map(f => URL.createObjectURL(f));
  slides.names = files.map(f => f.name);
  showSlide(0);
  setStatus('スライドを ' + files.length + ' 枚読み込みました（→キーか、舞台をクリックで進みます）');
});
$('#btnSlidePrev').addEventListener('click', () => showSlide(slides.i - 1));
$('#btnSlideNext').addEventListener('click', () => showSlide(slides.i + 1));
$('#btnSlideClear').addEventListener('click', clearSlides);
$('#stage').addEventListener('click', () => { if (slides.urls.length) showSlide(slides.i + 1); });

// 選んだものを覚える
$('#rate').addEventListener('input', () => { $('#rateVal').textContent = rateMul().toFixed(2); prefs.set('rate', $('#rate').value); });
$('#voice').addEventListener('change', () => prefs.set('voice', $('#voice').value));
$('#engine').addEventListener('change', () => prefs.set('engine', $('#engine').value));
$('#chkCaption').addEventListener('change', () => prefs.set('caption', $('#chkCaption').checked ? 1 : 0));
$('#chkAuto').addEventListener('change', () => prefs.set('auto', $('#chkAuto').checked ? 1 : 0));
$('#chkAutoGrab').addEventListener('change', () => prefs.set('autoGrab', $('#chkAutoGrab').checked ? 1 : 0));
$('#rate').value = prefs.get('rate', '0.9'); $('#rateVal').textContent = rateMul().toFixed(2);
$('#engine').value = prefs.get('engine', inTauri ? 'voicevox' : 'web'); // アプリ版の既定は VOICEVOX、Web版はブラウザの読み上げ（https からはローカルの VOICEVOX に繋がらない）
$('#chkCaption').checked = prefs.get('caption', '1') === '1';
$('#chkAuto').checked = prefs.get('auto', '1') === '1'; // 直送モードの基本は「新しい投稿は喋る」。外したらクリックで喋る
$('#motionMode').value = director.mode;
$('#motionMode').addEventListener('change', () => { director.mode = $('#motionMode').value; prefs.set('motion', director.mode); });
$('#chkAutoGrab').checked = prefs.get('autoGrab', '0') === '1';
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
// Muse アプリの会話メッセージには、接頭辞つきで全文が入る姿と、段落ごとにバラバラな姿がある（2026-11-14 実機で確認）。
// 取り込み結果（{role, text} の古い順）から、アシスタントの返事だけを古い順に取り出す。
// メッセージの組み立ては Rust 側（バラバラな断片の結合もそちらでやる）
function assistantReplies(msgs) {
  const out = [];
  for (const m of msgs) {
    if (m.role === 'assistant' && m.text && !out.includes(m.text)) out.push(m.text);
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
/* ---------- 外から届いた返事（ウェブフック／ミューズ直送）の共通の受け方 ---------- */
let stageReplies = [];
function acceptReply(text, source) {
  text = (text || '').trim();
  if (!text) return;
  if (stageReplies[stageReplies.length - 1] !== text) { stageReplies = [...stageReplies, text]; renderReplies(stageReplies); }
  $('#text').value = text;
  setStatus(source + 'で返事が届きました');
  report(source + 'で返事を受信しました');
  director.yesPlease = true; // 返事が来たら、まず小さくうなずく
  if ($('#chkAuto').checked && !speaking) speak(text); // 「自動で読む」が入っていれば、そのまま読み上げる
}
if (hookListen) hookListen('hooked-reply', e => acceptReply(e.payload?.text, 'ウェブフック'));

/* ---------- Web直送（MQTT中継）：公開ブローカー経由で即時に受け取る ---------- */
// 舞台用チャット（MQTT用）のミューズが、合言葉の宛先へ返事を publish すると、ここへ数百msで届く。
// 合言葉（トピック名）が実質の鍵。retain 付きで届く最新1件は、接続直後の基準決めで読み飛ばす。
let mqttClient = null, relaySeq = -1, relayBase = false;
function relayStop() { if (mqttClient) { try { mqttClient.end(true); } catch (e) { /* noop */ } mqttClient = null; } }
function relayStart() {
  relayStop(); relayBase = false; relaySeq = -1;
  const key = ($('#relayTopic').value || '').trim();
  if (!key) { setStatus('中継の合言葉が未入力です'); return; }
  const topic = 'muse-stage/' + key + '/reply';
  mqttClient = mqtt.connect('wss://broker.emqx.io:8084/mqtt', { reconnectPeriod: 3000, connectTimeout: 15000 });
  mqttClient.on('connect', () => { mqttClient.subscribe(topic, err => { if (!err) setStatus('中継に接続しました'); }); });
  mqttClient.on('message', (t, payload) => {
    try {
      const d = JSON.parse(payload.toString());
      const seq = typeof d.seq === 'number' ? d.seq : null;
      if (!relayBase) { relayBase = true; relaySeq = seq ?? relaySeq; return; } // 最初の1件（retain）は基準だけ
      if (seq !== null && seq === relaySeq) return;
      if (seq !== null) relaySeq = seq;
      acceptReply(String(d.text || ''), 'Web直送');
    } catch (e) { /* 壊れたメッセージは捨てる */ }
  });
  mqttClient.on('error', () => { /* 再接続はライブラリが続ける */ });
}
$('#chkRelay').addEventListener('change', () => { prefs.set('relay', $('#chkRelay').checked ? 1 : 0); if ($('#chkRelay').checked) relayStart(); else { relayStop(); setStatus('中継を切りました'); } });
$('#relayTopic').addEventListener('change', () => { prefs.set('relayTopic', $('#relayTopic').value.trim()); if ($('#chkRelay').checked) relayStart(); });
$('#relayTopic').value = prefs.get('relayTopic', '');
$('#chkRelay').checked = prefs.get('relay', '0') === '1';
if ($('#chkRelay').checked) relayStart();

/* ---------- ミューズ直送：配達ファイルの見張り ---------- */
let lastInboxSeq = -1;
if (inTauri) setInterval(async () => {
  try {
    const r = await invoke('read_inbox');
    if (!r) return;
    if (lastInboxSeq < 0) { lastInboxSeq = r[0]; return; } // 初回は基準だけ決めて、古い文は読まない
    if (r[0] !== lastInboxSeq) { lastInboxSeq = r[0]; acceptReply(r[1], 'ミューズ直送'); }
  } catch { /* ファイルが無い間は静かに待つ */ }
}, 700);

async function grabMuse(manual = false) {
  if (!inTauri) throw new Error('アプリの中でだけ使えます');
  // 手動の取り込みは十数秒かかるので、クルクルと「取り込み中」を出してボタンを止める（自動の見回りでは出さない）
  if (manual) { $('#spinner').classList.add('on'); $('#btnGrab').disabled = true; setStatus('Muse.app から取り込み中…'); }
  try {
    const msgs = await invoke('read_muse', { app: 'Muse' });
    report(`Muse.app から会話 ${msgs.length} 件を読めました`);
    const replies = assistantReplies(msgs);
    stageReplies = replies;
    renderReplies(replies);
    return { msgs, replies, latest: replies[replies.length - 1] || '' };
  } finally {
    if (manual) { $('#spinner').classList.remove('on'); $('#btnGrab').disabled = false; }
  }
}
$('#btnGrab').onclick = async () => {
  try { const { msgs, replies, latest } = await grabMuse(true); $('#text').value = latest; setStatus(`Muse.app から取り込みました（返事 ${replies.length} 件・会話 ${msgs.length} 件。右の一覧からも選べます）`); }
  catch (e) { setStatus('取り込めませんでした：' + errText(e) + '（システム設定 → プライバシーとセキュリティ → アクセシビリティ で Muse Stage を許可）'); report('取り込み失敗: ' + errText(e)); }
};
// 自動取り込み（アクセシビリティ版）：2 秒ごとに Muse.app を見て、新しい返事が出たら読み上げる。
// 直送・フックの自動読み上げ（chkAuto）とは別のスイッチ。直送だけ使うときは、こちらは切ったままでよい
let lastAuto = null, autoBusy = false;
setInterval(async () => {
  if (!$('#chkAutoGrab').checked || autoBusy || speaking) return;
  autoBusy = true;
  try {
    const { latest } = await grabMuse();
    if (lastAuto === null) lastAuto = latest; // 付けた時点の返事は読まない
    else if (latest && latest !== lastAuto) { lastAuto = latest; $('#text').value = latest; await speak(latest); }
  } catch (e) { $('#chkAutoGrab').checked = false; prefs.set('autoGrab', 0); setStatus('自動取り込みを止めました：' + errText(e)); }
  finally { autoBusy = false; }
}, 2000);

/* ---------- 起動 ---------- */
(async function boot() {
  frameCamera(); requestAnimationFrame(tick);
  // モデルの候補：アプリ版はないずんだもん公式モデル（各自で置く）、Web版は再配布できる CC0 モデル。?model= で差し替えもできる
  const qsModel = new URLSearchParams(location.search).get('model');
  const cands = [];
  if (qsModel) cands.push({ url: qsModel, credit: '' });
  if (inTauri) cands.push({ url: 'models/zundamon.vrm' });
  else cands.push({ url: 'models/cc0.vrm', credit: 'キャラクター: Quaternius Base（CC0）<br>モーション: Quaternius／KayKit（CC0）を open-vrma が変換' });
  cands.push({ url: 'models/VRM1_Constraint_Twist_Sample.vrm', credit: '', note: '試作用サンプルで表示しています' });
  let loaded = false;
  for (const c of cands) {
    try {
      const name = await loadVRM(c.url);
      report(`VRM 読み込み: ${name}`);
      if (c.credit !== undefined) $('#credit').innerHTML = c.credit || `キャラクター: ${name}`;
      if (c.note) setStatus(c.note);
      loaded = true; break;
    } catch (e) { /* 次の候補へ */ }
  }
  if (!loaded) { buildPlaceholder(); frameCamera(); report('VRM を読めないので簡易な人形で表示'); }
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
