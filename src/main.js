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
scene.add(new THREE.HemisphereLight(0xffffff, 0x443355, 1.25));
// 舞台全体にかかる前からの柔らかい光（追従しない。奥へ行っても顔が暗くならないように、2026-11-15 本人の「後ろまでライトを当てていい」で追加）
const fill = new THREE.DirectionalLight(0xfff6e8, 0.55); fill.position.set(0.6, 1.8, 6); scene.add(fill); fill.target.position.set(0, .9, -.4); scene.add(fill.target);
// キーとリムは台（actor）に追従させる。奥へ行っても光の当たり方が変わらないように、ライトと的をリグに入れて台の x/z へ合わせる
const lightRig = new THREE.Group(); scene.add(lightRig);
const key = new THREE.DirectionalLight(0xffffff, 1.6); key.position.set(1.6, 2.8, 3.2); lightRig.add(key); key.target.position.set(0, .95, -.2); lightRig.add(key.target);
const rim = new THREE.DirectionalLight(0xc77dff, 1.3); rim.position.set(-2.2, 2.4, -2.6); lightRig.add(rim); rim.target.position.set(0, 1, -.2); lightRig.add(rim.target);

let vrm = null, placeholder = null, headY = 1.4;
const actor = new THREE.Group(); scene.add(actor); // モデルを載せる台。うろうろ・かくれんぼは、この台ごと動かす
let modelH = 1.4, modelW = .5;
function frameCamera() {
  // 全身がほぼ入る距離感（近すぎるという本人の指摘で、上半身寄りから引いた構図へ。2026-11-15）
  const w = innerWidth, h = innerHeight; renderer.setSize(w, h, false);
  camera.aspect = w / h;
  const dist = (w / h < 1 ? 3.2 : 2.5) * modelH * (typeof slides !== 'undefined' && slides.urls.length ? 1.55 : 1); // 背の高いモデルほど引く。スライド表示中はさらに引いて小さく（資料の邪魔をしない）
  camera.position.set(0, headY - modelH * .24, dist); camera.lookAt(0, headY - modelH * .32, 0);
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
  return { halfH, halfW: halfH * camera.aspect, dist, camY: camera.position.y, centerY: headY - modelH * .32 };
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
  if (director.afterStory) { director.afterStory = false; t = Math.max(t, rand(7, 12)); } // 物語の後は、長めに休んでから次へ
  director.state = 'idle'; director.t = t;
}
function setMove(x, z, clip) {
  if (typeof slides !== 'undefined' && slides.urls.length) { const v = viewHalf(); x = clamp(x, v.halfW * .18, v.halfW * .82); z = clamp(z, -.75, .1); } // スライド表示中は右側の範囲だけを動く
  director.state = 'move'; director.moveT = 0;
  director.target = { x, z, clip, speed: clip === 'jog' ? 1.25 : .5 };
}
function startGesture(name) { director.state = 'gesture'; director.gesture = name; playMotion(name, .15); }
function goPeekSide(side) {
  if (typeof slides !== 'undefined' && slides.urls.length) { toIdle(rand(3, 6)); return; } // スライド表示中は隠れに行かない
  const z = clamp(actor.position.z, -.8, .4), h = halfAt(z);
  director.pendingPeek = 'side';
  setMove(side * (h.halfW + modelW * .5 - .13), z, 'walk');
}
function goPeekBottom() {
  if (typeof slides !== 'undefined' && slides.urls.length) { toIdle(rand(3, 6)); return; } // スライド表示中は隠れに行かない
  const h = halfAt(actor.position.z);
  director.hideY = (h.centerY - h.halfH) - modelH * .78;
  director.state = 'peekBottom'; director.t = rand(2.5, 4.5);
}
function goRoll() {
  if (typeof slides !== 'undefined' && slides.urls.length) { setMove(actor.position.x + rand(-.3, .3), actor.position.z, 'walk'); return; } // スライド表示中は転がらない
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
  director.afterStory = true;
  runStep(director.seq.shift());
}
function chooseNext() {
  const v = viewHalf(), cx = actor.position.x, cz = actor.position.z, r = Math.random();
  if (r < .17) { // ちょこちょこ：近くの点へ歩く
    setMove(clamp(cx + rand(-1, 1) * .85, -v.halfW * .8, v.halfW * .8), clamp(cz + rand(-1, 1) * .5, -1.1, .5), 'walk');
  } else if (r < .25) { // 奥へ走る／手前へ戻る
    setMove(rand(-.6, .6), cz > -.5 ? -1.25 : rand(.1, .5), 'jog');
  } else if (r < .35) { // 端に隠れて顔だけ出す
    goPeekSide(Math.random() < .5 ? -1 : 1);
  } else if (r < .43) { // 下に隠れて顔だけ出す
    goPeekBottom();
  } else if (r < .49) { // ぴょんぴょん跳ねる（2回）
    director.state = 'jump'; director.jumps = 2; playMotion('jump', .1);
  } else if (r < .505) { // ころころ転がって移動する（回転が多く目が回るので、めったに出さない）
    goRoll();
  } else if (r < .62) { // 踊る（長く回らないよう短めに）
    director.state = 'dance'; director.t = rand(4, 6);
  } else if (r < .65) { // たまに首を振る（いやいや）
    startGesture('no');
  } else if (r < .84) { // 休憩：立ったまま静かにしている（動く時間と休む時間のメリハリ。座る動きは本人が不要と言ったので使わない）
    toIdle(rand(8, 15));
  } else toIdle(rand(3, 5));
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
    if (typeof slides !== 'undefined' && slides.urls.length && !director.dodged) { // スライド表示中は、右側の定位置へ寄って喋る（よけている間はその場）
      const hx = viewHalf().halfW * .58;
      actor.position.x += (hx - actor.position.x) * Math.min(1, dt * 2);
      actor.position.z += (-.12 - actor.position.z) * Math.min(1, dt * 2);
    }
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
        else if (director.dodged) { // よけている間は、その場所で待つ（端にいなければ端へ歩く）
          if (director.dodgeTarget && Math.hypot(actor.position.x - director.dodgeTarget.x, actor.position.z - director.dodgeTarget.z) > .1) dodgeMove(director.dodgeTarget.x, director.dodgeTarget.z);
          else director.t = rand(2, 4);
        }
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
      director.moveT = (director.moveT || 0) + dt;
      // 到着判定：近づいたら着いたことにする。6秒かかりすぎたら諦める。
      // （目標の周りを回り続けてしまう暴走の防止。2026-11-15「時間を置くと回りだす」の原因）
      if (d < .08 || director.moveT > 6) {
        if (d < .3) { actor.position.x = tg.x; actor.position.z = tg.z; }
        director.moveT = 0;
        if (director.pendingPeek === 'side') { director.pendingPeek = null; director.state = 'peekSide'; director.t = rand(2.5, 4.5); }
        else toIdle(rand(2, 5));
        break;
      }
      actor.rotation.y = turnToward(actor.rotation.y, Math.atan2(dx, dz), dt * 4.5);
      const step = Math.min(d, tg.speed * dt);
      actor.position.x += (dx / d) * step; // 体の向きではなく目標へ直接進む（周回しない）
      actor.position.z += (dz / d) * step;
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

/* 会話の内容による動作の切り替え（舞台側の自動判定。送り手の印は使わない）
   読み上げの頭で文を見て、はっきりした場面だけポーズを決める。文の途中では切り替えない。
   回転の多い動きは使わない（目が回るので控えめにする本人の指示に合わせる）。 */
let speechPose = null; // { kind: 'wave'|'bow'|'tilt'|'bounce'|'nod', at: 開始時刻 }
function classifySpeech(text) {
  const s = String(text || '').trim(); if (!s) return null;
  if (/ありがとう|ありがたい|感謝|thank/i.test(s)) return 'bow'; // お礼 → おじぎ
  if (/こんにちは|こんばんは|おはよう|はじめまして|お久しぶり|hello|\bhi\b|good (morning|afternoon|evening)/i.test(s)) return 'wave'; // 挨拶 → 手を振る
  if (/[？?]/.test(s) || /ですか|ますか|でしょうか/.test(s) || /^(do|does|did|is|are|was|were|can|could|would|will|what|where|when|why|how|who|which)\b/i.test(s)) return 'tilt'; // 質問 → 首をかしげる
  if (/[！!]/.test(s) || /やった|嬉しい|うれしい|楽しい|すごい|素晴らしい|最高|わーい|やっほー|great|wonderful|awesome|amazing|excellent|fantastic/i.test(s)) return 'bounce'; // 嬉しい・元気 → 軽く弾む
  if (/^(はい|うん|そう|そうです|そうですね|なるほど|分かりました|わかりました|了解|その通り|おっしゃる通り|yes|yeah|sure|right|exactly|indeed)/i.test(s)) return 'nod'; // 相づち・同意 → うなずく
  return null; // それ以外は通常のおしゃべりの動きのまま
}
function armSpeechPose(text) {
  const kind = classifySpeech(text);
  speechPose = kind ? { kind, at: clock.elapsedTime } : null;
  if (vrm && !kind) vrm.scene.position.y = 0;
}
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
    if (speechPose) { // 会話の内容で決めたポーズ（骨への上乗せ。モーション再生中でも効く）
      const e = t - speechPose.at, b = n => vrm.humanoid.getNormalizedBoneNode(n);
      const env = (dur, inT = .25, outT = .3) => e >= dur ? 0 : Math.min(1, e / inT) * (e > dur - outT ? Math.max(0, (dur - e) / outT) : 1);
      if (speechPose.kind === 'wave') { // 左手を上げて振る（腕を下ろした角度 -1.2 が起点）
        const k = env(1.6), ua = b('leftUpperArm'), la = b('leftLowerArm');
        if (ua) ua.rotation.z = -1.2 + k * 2.0;
        if (la && k > 0) la.rotation.z = Math.sin(e * 9) * .35 * k;
        if (e >= 1.6) speechPose = null;
      } else if (speechPose.kind === 'bow') { // おじぎ
        const k = Math.sin(Math.min(1, e / 1.15) * Math.PI), sp = b('spine'), hd = b('head');
        if (sp) sp.rotation.x += k * .34;
        if (hd) hd.rotation.x += k * .14;
        if (e >= 1.15) speechPose = null;
      } else if (speechPose.kind === 'tilt') { // 首をかしげる（話している間。長くても6秒まで）
        const k = Math.min(1, e / .3), hd = b('head');
        if (hd && speaking) { hd.rotation.z = .15 * k; hd.rotation.y += .05 * k; }
        if (!speaking || e > 6) speechPose = null;
      } else if (speechPose.kind === 'bounce') { // 軽く弾む（台ではなくモデル側だけを上下させる）
        if (e < 1.15) vrm.scene.position.y = Math.abs(Math.sin(e * 9)) * .05 * (1 - e / 1.15);
        else { vrm.scene.position.y = 0; speechPose = null; }
      } else if (speechPose.kind === 'nod') { // うなずく（2回）
        const hd = b('head');
        if (hd && e < 1.15) hd.rotation.x = Math.abs(Math.sin(e * 5.5)) * .16 + Math.sin(t * 3.1) * .02;
        if (e >= 1.15) speechPose = null;
      }
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

function speakWeb(text, who = 'muse') {
  return new Promise((resolve, reject) => {
    const ss = window.speechSynthesis;
    if (!ss || typeof SpeechSynthesisUtterance === 'undefined') return reject(new Error('speechSynthesis がありません'));
    ss.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'ja-JP'; u.rate = rateMul(); const jv = webVoices();
    if (jv.length) {
      // 声分け：本人の文は男性の声（あれば）を選び、無ければピッチを下げて区別する
      u.voice = who === 'user' ? (jv.find(v => /otoya|ichiro|男性|male/i.test(v.name)) || jv[0]) : (jv.find(v => /kyoko/i.test(v.name)) || jv[0]);
    }
    if (who === 'user' && !/otoya|ichiro|男性|male/i.test(u.voice?.name || '')) u.pitch = 0.7;
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
// 声分け版：本人の文は VOICEVOX の男性話者「玄野武宏（ノーマル）」で読む。ずんだもんと同じ /speakers から名前で引く
let vvMaleId = null;
async function maleSpeakerId() {
  if (vvMaleId !== null) return vvMaleId;
  try {
    const speakers = await (await fetch(VV_BASE + '/speakers')).json();
    const m = speakers.find(s => (s.name || '').includes('玄野武宏'));
    const st = m?.styles?.find(s => s.name === 'ノーマル') || m?.styles?.[0];
    if (st) { vvMaleId = st.id; return vvMaleId; }
  } catch (e) { /* 引けなければ null（呼び出し側はずんだもんで代替する） */ }
  vvMaleId = null; return null;
}
async function speakVoicevox(text, who = 'muse') {
  let speaker;
  try {
    speaker = who === 'user' ? ((await maleSpeakerId()) ?? (await zundamonSpeakerId())) : await zundamonSpeakerId();
  }
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
async function speakSay(text, who = 'muse') {
  if (!inTauri) throw new Error('say は Tauri アプリの中でだけ使えます');
  speaking = true;
  // 声分け：本人の文は、選択肢に男性の声（Otoya）があればそちらで読む
  let voice = $('#voice').value || 'Kyoko';
  if (who === 'user') { const male = [...$('#voice').options].find(o => /otoya/i.test(o.value)); if (male) voice = male.value; }
  try { const r = await invoke('speak_say', { text, voice, rate: Math.round(175 * rateMul() ** 2) }); return r === 'stopped' ? 'stopped' : 'say'; }
  finally { speaking = false; }
}
/* ---------- 声分け：印つきの文を話者ごとの断片に分ける ---------- */
// 配達文の形式（声分け版）：行単独の「@user」が本人の文、「@muse」がミューズの文の始まり。
// 印が無い文は全部ミューズの文（従来の配達と互換）。声分けオフのときも全部ミューズ扱い。
function parseSegments(text) {
  if (!$('#chkSplit')?.checked) return [{ who: 'muse', text: text.trim() }];
  const segs = []; let cur = { who: 'muse', text: '' };
  const flush = () => { const t = cur.text.trim(); if (t) segs.push({ who: cur.who, text: t }); };
  for (const line of text.split('\n')) {
    const m = line.trim();
    if (m === '@user' || m === '@muse') { flush(); cur = { who: m === '@user' ? 'user' : 'muse', text: '' }; }
    else cur.text += (cur.text ? '\n' : '') + line;
  }
  flush();
  return segs.length ? segs : [{ who: 'muse', text: text.trim() }];
}
let speakRun = 0; // 停止したら続きの断片を喋らないための世代番号
async function speakOne(text, who) {
  const mode = $('#engine').value;
  if (mode === 'voicevox') return await speakVoicevox(text, who);
  if (mode === 'web' || (mode === 'auto' && webOk !== false)) {
    try { const used = await speakWeb(text, who); webOk = true; return used; }
    catch (e) {
      report(`speechSynthesis: 使えません（${e.message}）`);
      if (mode === 'web') throw e;
      webOk = false; setStatus('speechSynthesis が使えないので、macOS の say で読み上げます');
      return await speakSay(text, who);
    }
  }
  return await speakSay(text, who);
}
async function speak(text) {
  text = text.trim(); if (!text) return;
  stop();
  const run = ++speakRun;
  const segs = parseSegments(text);
  $('#btnSpeak').disabled = true;
  try {
    let used = '';
    for (const seg of segs) {
      if (run !== speakRun) { used = 'stopped'; break; }
      showCaption(seg.text, segs.length > 1 ? (seg.who === 'user' ? '本人' : 'ミューズ') : '');
      armSpeechPose(seg.text); // 文ごとに、内容でポーズを決める（質問の文は首かしげ、など）
      used = await speakOne(seg.text, seg.who);
      if (used === 'stopped') break;
    }
    if (used && used !== 'stopped') {
      const splitNote = segs.some(s => s.who === 'user') ? '（声分け）' : '';
      setStatus((used === 'voicevox' ? '読み上げ：VOICEVOX（ずんだもん／玄野武宏）' : used === 'web' ? '読み上げ：WebView の speechSynthesis' : `読み上げ：macOS の say（${$('#voice').value || 'Kyoko'}）`) + splitNote);
    } else if (used === 'stopped') setStatus('止めました');
    report(`読み上げ完了: ${used}`);
    return used;
  } catch (e) { setStatus('読み上げられませんでした：' + errText(e)); report('読み上げ失敗: ' + errText(e)); }
  finally { $('#btnSpeak').disabled = false; speaking = false; setTimeout(hideCaption, 1200); }
}
function stop() {
  speakRun++;
  speaking = false; speechPose = null; if (vrm) vrm.scene.position.y = 0;
  stopVoicevox();
  try { window.speechSynthesis?.cancel(); } catch (e) {}
  if (inTauri) invoke('stop_say').catch(() => {});
}

/* ---------- 字幕 ---------- */
function showCaption(text, label = '') {
  if (!$('#chkCaption').checked) return;
  $('#caption').innerHTML = (label ? `<span class="who"></span>` : '') + `<span class="done"></span><span class="rest"></span>`;
  if (label) $('#caption').querySelector('.who').textContent = label + '：';
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
  frameCamera(); // スライドの有無でキャラクターの大きさを切り替える
}

/* ---------- スライド表示：舞台の後ろにスライドを敷き、キャラクターがその手前で動く ---------- */
const slides = { urls: [], names: [], kinds: [], games: [], i: 0, links: {} }; // kinds: 'image' | 'video' | 'games'。links: 同梱スライドの manifest が持つ「ページ番号→リンク領域」の対応
function showSlide(i) {
  if (!slides.urls.length) return;
  slides.i = Math.min(slides.urls.length - 1, Math.max(0, i));
  const img = $('#slideImg'), vid = $('#slideVideo'), game = $('#slideGame'), frame = $('#slideFrame');
  const kind = slides.kinds[slides.i];
  if (kind === 'video') {
    img.style.display = 'none'; game.style.display = 'none'; frame.style.display = 'none';
    if (vid.getAttribute('src') !== slides.urls[slides.i]) vid.src = slides.urls[slides.i];
    vid.style.display = 'block';
    vid.play?.().catch(() => { /* 自動再生が止められたら、操作に任せる */ });
  } else if (kind === 'games') {
    vid.pause?.(); vid.style.display = 'none'; img.style.display = 'none'; frame.style.display = 'none';
    game.style.display = 'flex';
    buildGameTabs(slides.games[slides.i] || []);
  } else if (kind === 'iframe') {
    vid.pause?.(); vid.style.display = 'none'; img.style.display = 'none'; game.style.display = 'none';
    if (frame.getAttribute('src') !== slides.urls[slides.i]) frame.src = slides.urls[slides.i];
    frame.style.display = 'block';
  } else {
    vid.pause?.(); vid.style.display = 'none'; game.style.display = 'none'; frame.style.display = 'none';
    img.src = slides.urls[slides.i];
    img.style.display = 'block';
  }
  $('#slideCount').textContent = (slides.i + 1) + ' / ' + slides.urls.length;
  updateStageBackground();
  renderSlideLinks();
}
/* ゲームスライド：タブで実物を切り替える（トップページのデモ切り替えと同じ発想） */
function buildGameTabs(games) {
  const bar = $('#gameTabs'), frame = $('#gameFrame');
  bar.innerHTML = '';
  games.forEach((g, gi) => {
    const b = document.createElement('button');
    b.type = 'button'; b.textContent = g.label || ('ゲーム' + (gi + 1));
    if (frame.dataset.src === g.src) b.classList.add('on');
    b.addEventListener('click', () => {
      frame.src = g.src; frame.dataset.src = g.src;
      [...bar.children].forEach(x => x.classList.remove('on')); b.classList.add('on');
    });
    bar.appendChild(b);
  });
  if (games.length && !games.some(g => g.src === frame.dataset.src)) {
    frame.src = games[0].src; frame.dataset.src = games[0].src;
    bar.children[0]?.classList.add('on');
  }
}
// 動画スライド：本体をクリックで再生／一時停止（下端のコントロール部分は標準の操作に任せる）
$('#slideVideo').addEventListener('click', e => {
  const v = e.currentTarget, r = v.getBoundingClientRect();
  if (e.clientY > r.bottom - 48) return;
  if (v.paused) v.play?.().catch(() => {}); else v.pause();
});
/* スライド上のリンク：画像の表示位置（object-fit: contain）に合わせて、透明なリンク領域を重ねる */
function renderSlideLinks() {
  const box = $('#slideLinks');
  box.innerHTML = '';
  const list = slides.links[String(slides.i + 1)] || [];
  for (const r of list) {
    const a = document.createElement('a');
    a.href = r.url; a.target = '_blank'; a.rel = 'noopener';
    a.title = (r.label || r.url) + '（新しいタブで開きます）';
    a.dataset.rect = JSON.stringify(r);
    box.appendChild(a);
  }
  layoutSlideLinks();
}
function layoutSlideLinks() {
  const img = $('#slideImg');
  const iw = img.naturalWidth, ih = img.naturalHeight;
  if (!iw || !ih || slides.kinds[slides.i] === 'video') return; // リンク領域は画像スライドだけ
  const scale = Math.min(innerWidth / iw, innerHeight / ih);
  const w = iw * scale, h = ih * scale, ox = (innerWidth - w) / 2, oy = (innerHeight - h) / 2;
  for (const a of $('#slideLinks').children) {
    const r = JSON.parse(a.dataset.rect);
    a.style.left = (ox + r.x * w) + 'px'; a.style.top = (oy + r.y * h) + 'px';
    a.style.width = (r.w * w) + 'px'; a.style.height = (r.h * h) + 'px';
  }
}
$('#slideImg').addEventListener('load', layoutSlideLinks);
addEventListener('resize', layoutSlideLinks);
function clearSlides() {
  slides.urls.forEach(u => URL.revokeObjectURL(u));
  slides.urls = []; slides.names = []; slides.kinds = []; slides.games = []; slides.i = 0; slides.links = {};
  $('#slideImg').removeAttribute('src'); $('#slideImg').style.display = 'none';
  const vid = $('#slideVideo'); vid.pause?.(); vid.removeAttribute('src'); vid.load?.(); vid.style.display = 'none';
  const game = $('#slideGame'); game.style.display = 'none';
  const gframe = $('#gameFrame'); gframe.removeAttribute('src'); gframe.dataset.src = ''; $('#gameTabs').innerHTML = '';
  const sframe = $('#slideFrame'); sframe.removeAttribute('src'); sframe.style.display = 'none';
  $('#slideCount').textContent = '';
  $('#slideLinks').innerHTML = '';
  updateStageBackground();
}
async function pdfToImageUrls(file) {
  // PDFは全ページを画像化して、1ページ＝1スライドにする（PDFを1枚の絵としては読めないため）
  const pdfjs = await import('pdfjs-dist');
  const workerUrl = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  const pdf = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
  const urls = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const viewport = page.getViewport({ scale: 2 });
    const canvas = document.createElement('canvas');
    canvas.width = viewport.width; canvas.height = viewport.height;
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
    urls.push(URL.createObjectURL(blob));
  }
  return urls;
}
$('#slideFiles').addEventListener('change', async e => {
  const files = [...e.target.files].sort((a, b) => a.name.localeCompare(b.name, 'ja', { numeric: true }));
  if (!files.length) return;
  clearSlides();
  setStatus('スライドを読み込んでいます…');
  try {
    for (const f of files) {
      if (/\.pdf$/i.test(f.name) || f.type === 'application/pdf') {
        const urls = await pdfToImageUrls(f);
        slides.urls.push(...urls);
        urls.forEach((_, i) => { slides.names.push(f.name + ' p' + (i + 1)); slides.kinds.push('image'); });
      } else if (f.type.startsWith('video/') || /\.(mp4|webm|mov|m4v)$/i.test(f.name)) {
        slides.urls.push(URL.createObjectURL(f));
        slides.names.push(f.name);
        slides.kinds.push('video'); // 動画は1枚の動画スライドになる
      } else {
        slides.urls.push(URL.createObjectURL(f));
        slides.names.push(f.name);
        slides.kinds.push('image');
      }
    }
  } catch (err) { setStatus('スライドを読み込めませんでした：' + errText(err)); }
  if (!slides.urls.length) return;
  applySlides('スライドを ' + slides.urls.length + ' 枚読み込みました（→キーか、舞台をクリックで進みます）');
});
function applySlides(note) {
  showSlide(0);
  // 初期位置は右側（資料の邪魔にならないように）
  actor.position.x = viewHalf().halfW * .55; actor.position.z = -.1;
  director.state = 'idle'; director.t = 2;
  setStatus(note);
}
/* ---------- Web版：同梱スライドの自動読み込み（開いてすぐデモを始められるように） ---------- */
async function loadBundledSlides() {
  if (inTauri) return; // アプリ版は自分の資料を選ぶ形のまま
  try {
    const res = await fetch('slides/manifest.json', { cache: 'no-cache' });
    if (!res.ok) return;
    const m = await res.json();
    // slides の要素は、画像なら文字列（URL）、動画なら { src, type: 'video' }、ゲーム集なら { type: 'games', games: [{label, src}] }
    const entries = Array.isArray(m?.slides) ? m.slides.filter(s => typeof s === 'string' || (s && (typeof s.src === 'string' || s.type === 'games'))) : [];
    if (!entries.length || slides.urls.length) return;
    slides.urls = entries.map(s => typeof s === 'string' ? s : (s.src || ''));
    slides.kinds = entries.map(s => (typeof s === 'object' && s.type === 'video') ? 'video' : (typeof s === 'object' && s.type === 'games') ? 'games' : (typeof s === 'object' && s.type === 'iframe') ? 'iframe' : 'image');
    slides.games = entries.map(s => (typeof s === 'object' && s.type === 'games' && Array.isArray(s.games)) ? s.games.filter(g => g && typeof g.src === 'string') : null);
    slides.names = entries.map((s, i) => (m.title || '同梱スライド') + ' ' + (i + 1));
    if (m.links && typeof m.links === 'object') slides.links = m.links; // ページ番号→リンク領域（任意）
    applySlides('デモ用スライドを ' + list.length + ' 枚読み込みました（→キーか、舞台をクリックで進みます）');
  } catch (e) { /* 同梱が無ければ何もしない */ }
}
loadBundledSlides();
/* 埋め込んだページ（HTMLスライド）の中にフォーカスがあると、舞台側のキーは届かない。
   ページ側が ←→ を postMessage で知らせてくれたら、舞台のスライド送りに使う（↑↓はページ内の移動に残す） */
window.addEventListener('message', (e) => {
  if (!slides.urls.length) return;
  if (e.data?.museStageNav === 'next') showSlide(slides.i + 1);
  else if (e.data?.museStageNav === 'prev') showSlide(slides.i - 1);
});
$('#btnSlidePrev').addEventListener('click', () => showSlide(slides.i - 1));
$('#btnSlideNext').addEventListener('click', () => showSlide(slides.i + 1));
$('#btnSlideClear').addEventListener('click', clearSlides);
/* ---------- キャラクターをクリック：脇へよける／戻る（発表中にスライドの文字へ被る対策） ---------- */
const raycaster = new THREE.Raycaster();
function hitsActor(e) {
  const r = renderer.domElement.getBoundingClientRect();
  if (!r.width || !r.height) return false;
  raycaster.setFromCamera({ x: ((e.clientX - r.left) / r.width) * 2 - 1, y: -((e.clientY - r.top) / r.height) * 2 + 1 }, camera);
  return raycaster.intersectObject(actor, true).length > 0;
}
function dodgeMove(x, z) { director.state = 'move'; director.moveT = 0; director.target = { x, z, clip: 'walk', speed: .8 }; }
function toggleDodge() {
  if (director.dodged) {
    director.dodged = false;
    const back = director.dodgeBack || { x: 0, z: 0 };
    director.dodgeTarget = null;
    dodgeMove(back.x, back.z);
    setStatus('キャラクターが戻ります');
  } else {
    const z = clamp(actor.position.z, -.6, .4);
    const edge = (actor.position.x >= 0 ? 1 : -1) * halfAt(z) * .92; // いまいる側の端へ
    director.dodged = true; director.seq = [];
    director.dodgeBack = { x: actor.position.x, z: actor.position.z };
    director.dodgeTarget = { x: edge, z };
    dodgeMove(edge, z);
    setStatus('キャラクターを脇へよけました（もう一度クリックで戻ります）');
  }
}
let hoverAt = 0;
renderer.domElement.addEventListener('pointermove', e => {
  const now = performance.now(); if (now - hoverAt < 150) return; hoverAt = now;
  renderer.domElement.style.cursor = hitsActor(e) ? 'pointer' : '';
});
$('#stage').addEventListener('click', e => {
  if (hitsActor(e)) { toggleDodge(); return; } // キャラクターをクリックしたらよける（スライドは進めない）
  if (slides.urls.length) showSlide(slides.i + 1);
});

// 選んだものを覚える
$('#rate').addEventListener('input', () => { $('#rateVal').textContent = rateMul().toFixed(2); prefs.set('rate', $('#rate').value); });
$('#voice').addEventListener('change', () => prefs.set('voice', $('#voice').value));
$('#engine').addEventListener('change', () => prefs.set('engine', $('#engine').value));
$('#chkCaption').addEventListener('change', () => prefs.set('caption', $('#chkCaption').checked ? 1 : 0));
$('#chkAuto').addEventListener('change', () => prefs.set('auto', $('#chkAuto').checked ? 1 : 0));
$('#chkAutoGrab').addEventListener('change', () => prefs.set('autoGrab', $('#chkAutoGrab').checked ? 1 : 0));
$('#chkSplit').addEventListener('change', () => prefs.set('split', $('#chkSplit').checked ? 1 : 0));
$('#chkSplit').checked = prefs.get('split', '0') === '1'; // 統合版の既定はオフ（オンにすると設定が残る）
$('#rate').value = prefs.get('rate', '0.9'); $('#rateVal').textContent = rateMul().toFixed(2);
$('#engine').value = prefs.get('engine', inTauri ? 'voicevox' : 'web'); // アプリ版の既定は VOICEVOX、Web版はブラウザの読み上げ（https からはローカルの VOICEVOX に繋がらない）
$('#chkCaption').checked = prefs.get('caption', '1') === '1';
$('#chkAuto').checked = prefs.get('auto', '1') === '1'; // 直送モードの基本は「新しい投稿は喋る」。外したらクリックで喋る
$('#motionMode').value = director.mode;
$('#motionMode').addEventListener('change', () => { director.mode = $('#motionMode').value; prefs.set('motion', director.mode); });
$('#chkAutoGrab').checked = prefs.get('autoGrab', '0') === '1';
if (prefs.get('noPanel', '0') === '1') document.body.classList.add('no-panel');
// 操作パネルの折りたたみ（下に畳んで、細いバーだけ残す）
function setPanelFolded(fold) {
  $('#panel').classList.toggle('folded', fold);
  $('#btnPanelFold').textContent = fold ? 'パネルを開く ▴' : 'パネルをたたむ ▾';
  prefs.set('panelFold', fold ? 1 : 0);
}
$('#btnPanelFold').addEventListener('click', () => setPanelFolded(!$('#panel').classList.contains('folded')));
if (prefs.get('panelFold', '0') === '1') setPanelFolded(true);
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
