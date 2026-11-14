// ==UserScript==
// @name         Muse Stage Hook
// @namespace    muse-stage
// @version      0.1
// @description  Muse のウェブ画面でアシスタントの返事が完了したら、Muse Stage（127.0.0.1:17654）へ送る
// @match        https://muse.ai/*
// @grant        none
// ==/UserScript==
(function () {
  'use strict';
  const ENDPOINT = 'http://127.0.0.1:17654/reply';
  const PREFIX = 'アシスタントメッセージ:';
  const log = (...a) => console.log('[muse-stage-hook]', ...a);

  // 返事の要素を探す。第一候補は aria-label（アプリ版のアクセシビリティ名と同じ文字列の想定）。
  // 実機で合わなければ、ここの探し方を画面に合わせて直す
  function findReplies() {
    let els = [...document.querySelectorAll('[aria-label^="アシスタントメッセージ"]')];
    if (!els.length) {
      els = [...document.querySelectorAll('div, article, section')].filter(el => {
        const t = (el.innerText || '').trimStart();
        return t.startsWith(PREFIX) && ![...el.querySelectorAll('div, article, section')].some(c => (c.innerText || '').trimStart().startsWith(PREFIX));
      });
    }
    return els;
  }
  function textOf(el) {
    const label = el.getAttribute('aria-label') || '';
    if (label.startsWith(PREFIX)) return label.slice(PREFIX.length).trim();
    const t = (el.innerText || '').trim();
    return t.startsWith(PREFIX) ? t.slice(PREFIX.length).trim() : t;
  }

  const sent = new Set();
  const seen = new WeakMap(); // 要素 → {text, since}
  async function send(text) {
    if (!text || sent.has(text)) return;
    sent.add(text);
    try {
      const r = await fetch(ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, role: 'assistant' }) });
      log('送信しました', r.status, text.slice(0, 40));
    } catch (e) { log('送信できません（Muse Stage が起動していない？）', e.message); sent.delete(text); }
  }

  // 監視：返事のテキストが 1.2 秒変わらなければ「完了」とみなして送る
  setInterval(() => {
    for (const el of findReplies()) {
      const text = textOf(el);
      if (!text) continue;
      const prev = seen.get(el);
      const now = Date.now();
      if (!prev || prev.text !== text) { seen.set(el, { text, since: now }); continue; }
      if (now - prev.since >= 1200) send(text);
    }
  }, 700);

  // 手動ボタン：いちばん新しい返事を今すぐ送る（自動検知が合わないときの保険）
  const btn = document.createElement('button');
  btn.textContent = 'Muse Stage へ送る';
  btn.style.cssText = 'position:fixed;left:10px;bottom:10px;z-index:99999;padding:6px 10px;border-radius:8px;background:#6d28d9;color:#fff;border:none;cursor:pointer;font-size:12px;opacity:.85';
  btn.onclick = () => { const els = findReplies(); if (els.length) send(textOf(els[els.length - 1])); else log('返事の要素が見つかりません'); };
  document.body.appendChild(btn);
  log('有効になりました。受け口:', ENDPOINT);
})();
