/*
 * Lookup Tracker - a dictionary that keeps a log of what you look up.
 *
 * What it does
 *   - Searches JMdict by kana or kanji, including common conjugated forms.
 *   - Lets you mark words as known. A known word's definition and part of
 *     speech stay hidden until you reveal them; you can type a wager first.
 *   - Logs every lookup, wager and grade, and exports the log as a file.
 *
 * Where things are kept (all on this device)
 *   - The dictionary (data/dict.txt): in the browser's Cache storage, so it
 *     is downloaded once and works offline.
 *   - Your log: in IndexedDB, database "lookup-tracker":
 *       lookups  one record per entry you opened, filled in as you go
 *       known    the words currently marked as known
 *       marks    every mark / unmark, with its time
 *       meta     last export time
 *     Every change is written the moment it happens.
 *
 * This page talks to no server except to download its own files. It has no
 * connection to the mining tool.
 */
'use strict';

const DATA_URL = 'data/dict.txt';
const VERSION_URL = 'data/version.json';
const DATA_CACHE = 'lookup-tracker-data-v1';
const EXPORT_REMINDER_DAYS = 7;
const DAY = 86400000;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const hira = s => s.replace(/[ァ-ヶ]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 96));
const isKatakanaWord = s => { let n = 0; for (const ch of s) if (ch === 'ー' || (ch >= 'ァ' && ch <= 'ヴ')) n++; return n / Math.max(1, s.length) > 0.5; };

// ---------------------------------------------------------------------------
// Dictionary: loaded as text, one entry per line, parsed only when shown
// ---------------------------------------------------------------------------
const D = { ready: false, head: null, keys: null, keyEntry: null, ids: null, common: '', lines: null, cache: new Map(), idIndex: null };

async function fetchDictText(onProgress, forceNetwork) {
  let cache = null;
  try { if (window.caches) cache = await caches.open(DATA_CACHE); } catch (e) { cache = null; }
  if (cache && !forceNetwork) {
    const hit = await cache.match(DATA_URL);
    if (hit) return hit.text();
  }
  const resp = await fetch(DATA_URL, forceNetwork ? { cache: 'reload' } : undefined);
  if (!resp.ok) throw new Error('The dictionary file could not be downloaded (' + resp.status + ').');
  let text;
  if (resp.body && onProgress) {
    const reader = resp.body.getReader(), chunks = [];
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value); got += value.length; onProgress(got);
    }
    text = await new Blob(chunks).text();
  } else {
    text = await resp.text();
  }
  if (cache) {
    try { await cache.put(DATA_URL, new Response(text, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } })); } catch (e) { /* storage full or blocked: the app still works online */ }
  }
  return text;
}

function installDict(text) {
  const lines = text.split('\n');
  D.head = JSON.parse(lines[0]);
  D.keys = JSON.parse(lines[1]);
  D.keyEntry = Int32Array.from(JSON.parse(lines[2]));
  D.ids = Int32Array.from(JSON.parse(lines[3]));
  D.common = lines[4];
  D.lines = lines;
  D.cache.clear(); D.idIndex = null;
  D.ready = true;
}

function entryAt(i) {
  let e = D.cache.get(i);
  if (!e) {
    const a = JSON.parse(D.lines[i + 5]);
    e = { i: i, id: a[0], k: a[1], r: a[2], s: a[3], p: a[4] || null, c: a[5] };
    if (D.cache.size > 3000) D.cache.clear();
    D.cache.set(i, e);
  }
  return e;
}
function entryById(id) {
  if (!D.idIndex) { D.idIndex = new Map(); for (let i = 0; i < D.ids.length; i++) D.idIndex.set(D.ids[i], i); }
  const i = D.idIndex.get(id);
  return i === undefined ? null : entryAt(i);
}
const head = e => e.k[0] || e.r[0];
const posCodes = e => { const out = new Set(); e.s.forEach(s => s[0].forEach(p => out.add(D.head.pos[p][0]))); return out; };
const firstGloss = e => e.s[0][1].slice(0, 3).join('; ');

function lowerBound(q) {
  let lo = 0, hi = D.keys.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (D.keys[mid] < q) lo = mid + 1; else hi = mid; }
  return lo;
}
function exactEntries(q) {
  const out = [];
  for (let i = lowerBound(q); i < D.keys.length && D.keys[i] === q; i++) out.push(D.keyEntry[i]);
  return out;
}

// ---------------------------------------------------------------------------
// Conjugated forms -> dictionary forms
// Each rule: [ending found, ending to put back, kind]. Kind says what the
// result must be in the dictionary (v1 ichidan, v5 godan, adj i-adjective,
// vs suru verb, vsn noun that takes suru, vk kuru, na na-adjective, any);
// "x" rules only peel off one layer (食べなかった -> 食べない) on the way.
// Common forms only: rare and classical forms are not covered.
// ---------------------------------------------------------------------------
const RULES = [];
(function buildRules() {
  const R = (a, b, t) => RULES.push([a, b, t]);
  // 行く is irregular (行って, not 行いて); listed first so it comes before 行う.
  [['行って', '行く'], ['行った', '行く'], ['いって', 'いく'], ['いった', 'いく']].forEach(([a, b]) => R(a, b, 'v5'));
  [['なかった', 'ない'], ['なくて', 'ない'], ['なければ', 'ない'], ['なかったら', 'ない'], ['ないで', 'ない'],
   ['ませんでした', 'ます'], ['ません', 'ます'], ['ました', 'ます'], ['ましょう', 'ます'], ['まして', 'ます'],
   ['ている', 'て'], ['ていた', 'て'], ['ていて', 'て'], ['ていない', 'て'], ['ています', 'て'], ['ていました', 'て'], ['てる', 'て'], ['てた', 'て'], ['てて', 'て'],
   ['でいる', 'で'], ['でいた', 'で'], ['でいて', 'で'], ['でいない', 'で'], ['でいます', 'で'], ['でる', 'で'], ['でた', 'で'],
   ['たら', 'た'], ['たり', 'た'], ['だら', 'だ'], ['だり', 'だ'],
   ['たかった', 'たい'], ['たくない', 'たい'], ['たくて', 'たい'],
   ['ちゃう', 'て'], ['ちゃった', 'て'], ['じゃう', 'で'], ['じゃった', 'で'],
   ['てしまう', 'て'], ['てしまった', 'て'], ['でしまう', 'で'], ['でしまった', 'で'],
   ['てください', 'て'], ['でください', 'で'], ['てから', 'て'], ['でから', 'で'], ['ても', 'て'], ['でも', 'で'],
  ].forEach(([a, b]) => R(a, b, 'x'));
  ['かった', 'くない', 'くて', 'く', 'ければ', 'かったら', 'すぎる', 'そう'].forEach(a => R(a, 'い', 'adj'));
  ['ない', 'ます', 'た', 'て', 'たい', 'れば', 'よう', 'られる', 'させる', 'ろ', 'ず', 'ながら', 'なさい', 'すぎる', 'そう', 'やすい', 'にくい'].forEach(a => R(a, 'る', 'v1'));
  const U = 'うくぐすつぬぶむる', A = 'わかがさたなばまら', I = 'いきぎしちにびみり', E = 'えけげせてねべめれ', O = 'おこごそとのぼもろ';
  for (let j = 0; j < 9; j++) {
    ['ない', 'れる', 'せる', 'ず'].forEach(x => R(A[j] + x, U[j], 'v5'));
    ['ます', 'たい', 'ながら', 'なさい', 'すぎる', 'そう', 'やすい', 'にくい'].forEach(x => R(I[j] + x, U[j], 'v5'));
    ['る', 'ば'].forEach(x => R(E[j] + x, U[j], 'v5'));
    R(O[j] + 'う', U[j], 'v5');
  }
  [['って', 'うつる'], ['った', 'うつる'], ['いて', 'く'], ['いた', 'く'], ['いで', 'ぐ'], ['いだ', 'ぐ'], ['して', 'す'], ['した', 'す'], ['んで', 'ぬぶむ'], ['んだ', 'ぬぶむ']]
    .forEach(([a, outs]) => { for (const o of outs) R(a, o, 'v5'); });
  const SURU = ['しない', 'します', 'した', 'して', 'したい', 'しよう', 'すれば', 'される', 'させる', 'できる', 'せず', 'しろ', 'しながら'];
  SURU.forEach(a => R(a, 'する', 'vs'));
  SURU.concat(['する']).forEach(a => R(a, '', 'vsn'));
  [['来ない', '来る'], ['来ます', '来る'], ['来た', '来る'], ['来て', '来る'], ['来られる', '来る'], ['来よう', '来る'], ['来い', '来る'], ['来れば', '来る'], ['来たい', '来る'],
   ['こない', 'くる'], ['きます', 'くる'], ['きた', 'くる'], ['きて', 'くる'], ['こられる', 'くる'], ['こよう', 'くる'], ['こい', 'くる'], ['くれば', 'くる'], ['きたい', 'くる']]
    .forEach(([a, b]) => R(a, b, 'vk'));
  ['な', 'に', 'だ', 'だった', 'じゃない', 'ではない', 'で'].forEach(a => R(a, '', 'na'));
  ['です', 'でした'].forEach(a => R(a, '', 'any'));
})();

function deinflect(q) {
  const found = [], seen = new Set([q + '|']);
  let frontier = [q];
  for (let depth = 0; depth < 4 && frontier.length; depth++) {
    const next = [];
    for (const t of frontier) {
      for (const [a, b, kind] of RULES) {
        if (!t.endsWith(a)) continue;
        const nt = t.slice(0, t.length - a.length) + b, key = nt + '|' + kind;
        if (!nt || nt === t) continue;
        if (seen.has(key)) continue;
        seen.add(key);
        if (kind !== 'x') found.push([nt, kind]);
        next.push(nt);
      }
    }
    frontier = next;
  }
  return found;
}
function fitsKind(e, kind) {
  if (kind === 'any') return true;
  const pos = posCodes(e);
  const some = f => { for (const p of pos) if (f(p)) return true; return false; };
  if (kind === 'v1') return some(p => p === 'v1' || p === 'v1-s');
  if (kind === 'v5') return some(p => p.startsWith('v5'));
  if (kind === 'adj') return some(p => p === 'adj-i' || p === 'adj-ix');
  if (kind === 'vs') return some(p => p.startsWith('vs'));
  if (kind === 'vsn') return some(p => p === 'vs');
  if (kind === 'vk') return pos.has('vk');
  if (kind === 'na') return pos.has('adj-na');
  return false;
}

function search(raw) {
  const q = hira(raw.trim());
  if (!q || !D.ready) return [];
  const out = [], seen = new Set();
  const push = (i, via) => { if (!seen.has(i)) { seen.add(i); out.push({ e: entryAt(i), via: via }); } };
  const byCommon = (a, b) => (D.common[b] === '1') - (D.common[a] === '1');
  exactEntries(q).sort(byCommon).forEach(i => push(i, null));
  for (const [term, kind] of deinflect(q)) {
    exactEntries(term).sort(byCommon).forEach(i => { if (!seen.has(i) && fitsKind(entryAt(i), kind)) push(i, term); });
  }
  const pre = [];
  for (let i = lowerBound(q), n = 0; i < D.keys.length && n < 4000 && D.keys[i].startsWith(q); i++, n++) {
    if (D.keys[i] !== q) pre.push(i);
  }
  pre.sort((a, b) => (D.common[D.keyEntry[b]] === '1') - (D.common[D.keyEntry[a]] === '1') || D.keys[a].length - D.keys[b].length || a - b);
  for (const k of pre) { if (out.length >= 40) break; push(D.keyEntry[k], null); }
  return out.slice(0, 40);
}

// ---------------------------------------------------------------------------
// Pitch accent drawing
// Port of draw_pitch.py from the "Japanese Pitch Accent" Anki add-on
// (AnkiWeb 148002038). MIT License, Copyright (c) 2019 Tarek Saier.
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to
// permit persons to whom the Software is furnished to do so, subject to
// the following conditions: The above copyright notice and this
// permission notice shall be included in all copies or substantial
// portions of the Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT
// WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO
// THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
// NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE
// LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
// OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
// WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
// ---------------------------------------------------------------------------
const PITCH_COMBINERS = new Set(['ゃ', 'ゅ', 'ょ', 'ぁ', 'ぃ', 'ぅ', 'ぇ', 'ぉ', 'ャ', 'ュ', 'ョ', 'ァ', 'ィ', 'ゥ', 'ェ', 'ォ']);
function pitchMorae(kana) {
  const chars = Array.from(kana), out = [];
  let i = 0;
  while (i < chars.length) {
    if (i + 1 < chars.length && PITCH_COMBINERS.has(chars[i + 1])) { out.push(chars[i] + chars[i + 1]); i += 2; }
    else { out.push(chars[i]); i += 1; }
  }
  return out;
}
function pitchSvg(kana, patt) {
  const mora = pitchMorae(kana), p = Array.from(patt);
  const positions = Math.max(mora.length, p.length), step = 35, margin = 16;
  const w = Math.max(0, (positions - 1) * step + margin * 2);
  const circle = (x, y, o) => `<circle r="5" cx="${x}" cy="${y}" style="opacity:1;fill:#000;" />` +
    (o ? `<circle r="3.25" cx="${x}" cy="${y}" style="opacity:1;fill:#fff;" />` : '');
  const text = (x, m) => {
    const c = Array.from(m);
    return c.length === 1
      ? `<text x="${x}" y="67.5" style="font-size:20px;font-family:sans-serif;fill:#000;">${m}</text>`
      : `<text x="${x - 5}" y="67.5" style="font-size:20px;font-family:sans-serif;fill:#000;">${c[0]}</text>` +
        `<text x="${x + 12}" y="67.5" style="font-size:14px;font-family:sans-serif;fill:#000;">${c[1]}</text>`;
  };
  const path = (x, y, typ) => `<path d="m ${x},${y} ${typ === 's' ? `${step},0` : typ === 'u' ? `${step},-25` : `${step},25`}" style="fill:none;stroke:#000;stroke-width:1.5;" />`;
  let chars = '', circles = '', paths = '', prev = null;
  mora.forEach((m, pos) => { chars += text(margin + pos * step - 11, m); });
  p.forEach((a, pos) => {
    const x = margin + pos * step;
    const y = ['H', 'h', '1', '2'].includes(a) ? 5 : ['L', 'l', '0'].includes(a) ? 30 : 17;
    circles += circle(x, y, pos >= mora.length);
    if (pos > 0) paths += path(prev[0], prev[1], prev[1] === y ? 's' : prev[1] < y ? 'd' : 'u');
    prev = [x, y];
  });
  return `<svg class="pitch" width="${w}px" height="75px" viewBox="0 0 ${w} 75">` + chars + paths + circles + '</svg>';
}
// The mora after which the pitch drops; 0 = no drop.
function accentNumber(patt) {
  const a = Array.from(patt.toUpperCase());
  for (let i = 0; i < a.length - 1; i++) if (a[i] === 'H' && a[i + 1] === 'L') return i + 1;
  return 0;
}
function pitchHtml(e) {
  if (!e.p) return '<p class="hint">No pitch accent found for this word.</p>';
  const kata = isKatakanaWord(head(e)), done = new Set();
  let h = '';
  for (const r of e.r) {
    const key = hira(r);
    if (done.has(key) || !e.p[key]) continue;
    done.add(key);
    const kana = kata ? r : key;
    for (const patt of e.p[key]) {
      h += '<div><div class="pitch-tile">' + pitchSvg(kana, patt) + '</div><span class="pitch-n">accent ' + accentNumber(patt) + '</span></div>';
    }
  }
  return h ? '<div class="pitches">' + h + '</div>' : '<p class="hint">No pitch accent found for this word.</p>';
}

// Pitch notation for the suggestion list (Justin's chosen style, Nov 18): the
// kana themselves, a line over high morae and under low ones, a vertical line
// where the pitch changes, and a short tick after the last mora when the drop
// falls on the following particle (odaka), so 橋 (LH, drop) and 端 (LH, flat)
// look different. A pattern is H/L per mora plus one letter for the particle.
// Returns null when the pattern doesn't fit the kana (then plain text is shown).
function pitchNotation(kana, patt) {
  const mora = pitchMorae(kana), p = Array.from(patt.toUpperCase()), n = mora.length;
  if (!n || p.length < n) return null;
  let h = '';
  for (let i = 0; i < n; i++) {
    const hi = p[i] === 'H';
    let cls = 'mo ' + (hi ? 'hi' : 'lo');
    if (i < n - 1 && (p[i + 1] === 'H') !== hi) cls += ' ch';
    if (i === n - 1 && hi && p[n] === 'L') cls += ' od';
    h += '<span class="' + cls + '">' + esc(mora[i]) + '</span>';
  }
  return '<span class="pn" title="accent ' + accentNumber(patt) + '">' + h + '</span>';
}
const MAX_ROW_ACCENTS = 3;
// The word and reading part of a suggestion row, with the reading drawn in
// pitch notation (every accent, up to three, side by side).
function rowWordHtml(e) {
  const kanaOnly = !e.k.length, r = e.r[0];
  const drawn = (e.p && e.p[hira(r)] || []).slice(0, MAX_ROW_ACCENTS).map(patt => pitchNotation(r, patt)).filter(Boolean);
  if (kanaOnly) {
    // The word is its own reading: the first accent is drawn on the word, any others beside it.
    const rest = drawn.slice(1).join('');
    return '<span class="w">' + (drawn[0] || esc(r)) + '</span>' + (rest ? '<span class="r pns">' + rest + '</span>' : '') +
      (e.r[1] ? '<span class="r">' + esc(e.r[1]) + '</span>' : '');
  }
  return '<span class="w">' + esc(head(e)) + '</span>' + (drawn.length ? '<span class="r pns">' + drawn.join('') + '</span>' : '<span class="r">' + esc(r) + '</span>');
}

// ---------------------------------------------------------------------------
// The log (IndexedDB). Every write goes to disk at once; L mirrors it in
// memory so the screens can be drawn without waiting.
// ---------------------------------------------------------------------------
const L = { db: null, lookups: [], known: new Map(), marks: [], meta: {}, ok: true };

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('lookup-tracker', 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore('lookups', { keyPath: 'n', autoIncrement: true });
      db.createObjectStore('known', { keyPath: 'id' });
      db.createObjectStore('marks', { keyPath: 'n', autoIncrement: true });
      db.createObjectStore('meta', { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function tx(store, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = L.db.transaction(store, mode), s = t.objectStore(store);
    let result;
    const r = fn(s);
    if (r) r.onsuccess = () => { result = r.result; };
    t.oncomplete = () => resolve(result);
    t.onerror = t.onabort = () => reject(t.error);
  });
}
const getAll = store => tx(store, 'readonly', s => s.getAll());

async function loadLog() {
  L.db = await openDb();
  L.lookups = await getAll('lookups');
  L.marks = await getAll('marks');
  L.known = new Map((await getAll('known')).map(k => [k.id, k]));
  L.meta = {};
  (await getAll('meta')).forEach(m => { L.meta[m.key] = m.value; });
}
async function saveLookup(rec) {
  if (rec.n === undefined) rec.n = await tx('lookups', 'readwrite', s => s.add(rec));
  else await tx('lookups', 'readwrite', s => s.put(rec));
}
async function setMeta(key, value) { L.meta[key] = value; await tx('meta', 'readwrite', s => s.put({ key: key, value: value })); }
function writeFailed(e) {
  L.ok = false;
  S.error = 'Saving to this device failed (' + (e && e.message ? e.message : e) + '). Export your log now from the Counts tab.';
  render();
}

// Outcomes of a lookup. A word that is not marked known is just "lookup".
const OUTCOME = {
  'lookup': ['looked up', 'plain'],
  'not-revealed': ['known, not revealed', 'known'],
  'lapse-no-wager': ['lapse: no wager', 'lapse'],
  'ungraded': ['revealed, not graded', 'plain'],
  'check-correct': ['check: correct', 'check'],
  'check-slip': ['check: label slip', 'slip'],
  'lapse-wrong': ['lapse: wrong', 'lapse'],
};

// ---------------------------------------------------------------------------
// Screens
// ---------------------------------------------------------------------------
const S = { tab: 'search', q: '', entry: null, rec: null, revealed: false, justMarked: false, historyShown: 200, error: '', notice: '', update: null, protectedStorage: null };

function sensesHtml(e) {
  return e.s.map(s => '<div class="sense"><div class="pos">' +
    s[0].map(p => '<span>' + esc(D.head.pos[p][1]) + '</span>').join('') +
    s[2].map(m => '<span class="m">' + esc(D.head.misc[m][1]) + '</span>').join('') +
    '</div><div>' + esc(s[1].join('; ')) + '</div></div>').join('');
}
function creditHtml() {
  return '<p class="credit">Words: <a href="https://www.edrdg.org/wiki/index.php/JMdict-EDICT_Dictionary_Project" target="_blank" rel="noopener">JMdict</a> (EDRDG). ' +
    'Pitch accents: <a href="https://www.wadoku.de" target="_blank" rel="noopener">www.wadoku.de</a>. ' +
    '<a href="sources.html">Sources and licences</a></p>';
}
function exportDue() {
  if (!L.lookups.length && !L.known.size) return null;
  const last = L.meta.lastExportAt, first = L.lookups.length ? L.lookups[0].t : Date.now();
  const since = last || first, days = Math.floor((Date.now() - since) / DAY);
  if (days < EXPORT_REMINDER_DAYS) return null;
  return last ? 'Your last export was ' + days + ' days ago.' : 'Your log has never been exported.';
}

// The search screen is the search box plus a pane under it. The box is made
// once and never redrawn while it is on screen: replacing it while typing broke
// the Japanese keyboard (so suggestions waited for 確定) and stopped a held
// backspace after one character. Everything that changes is in the pane.
function searchShell() {
  return '<input id="q" type="search" placeholder="Search in kana or kanji" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" lang="ja">' +
    '<div id="pane"></div>';
}
function viewSearch() {
  let h = '';
  if (S.error) h += '<div class="banner warn"><span>' + esc(S.error) + '</span></div>';
  if (!S.entry || S.q) {
    const res = search(S.q);
    if (S.q && res.length) {
      h += '<div class="list">' + res.map(({ e, via }) => {
        const k = L.known.has(e.id);
        return '<button class="row" type="button" data-open="' + e.id + '"><span>' + rowWordHtml(e) +
          (k ? ' <span class="pill known">known</span>' : '') + '</span><span class="g">' + (k ? 'Definition hidden' : esc(firstGloss(e))) + (via ? ' · from ' + esc(S.q) : '') + '</span></button>';
      }).join('') + '</div>';
    } else if (S.q) {
      h += '<p class="empty">No match. Try the dictionary form, or fewer characters.</p>';
    } else {
      const due = exportDue();
      if (due) h += '<div class="banner warn"><span>' + esc(due) + '</span><button class="btn" type="button" data-tab="counts">Export</button></div>';
      if (S.update) h += '<div class="banner"><span>A newer dictionary is available.</span><button class="btn" type="button" id="update-dict">Update</button></div>';
      h += '<p class="hint">Type a word as you heard it. Conjugated forms such as 食べた or 高かった find their dictionary form.</p>';
    }
    return h + creditHtml();
  }
  const e = entryById(S.entry);
  if (!e) return h + '<p class="empty">This entry is not in the current dictionary.</p>' + creditHtml();
  const k = L.known.has(e.id), rec = S.rec;
  h += '<div class="card"><div class="top"><div><h1>' + esc(head(e)) + '</h1><div class="reading">' + esc(e.r.join('、')) +
    (e.k.length > 1 ? ' · also ' + esc(e.k.slice(1).join('、')) : '') + '</div></div><button class="close" type="button" id="close" aria-label="Close entry">&times;</button></div>';
  h += pitchHtml(e);
  if (!k || S.justMarked) {
    h += sensesHtml(e);
    if (!k) h += '<button class="btn primary" type="button" id="mark">Mark as known</button>';
    else h += '<div class="pill known" style="align-self:flex-start">Marked as known</div>';
  } else if (!S.revealed) {
    h += '<div class="hiddenbox">You marked this word as known, so its definition and part of speech are hidden.</div>';
    h += '<label class="hint" for="wager">What do you think it means? Leave it empty if you have no idea.</label><textarea id="wager" placeholder="Your wager" autocapitalize="off"></textarea>';
    h += '<button class="btn primary" type="button" id="reveal">Reveal definition</button><p class="hint">Revealing with no wager counts as a lapse. A wager cannot be changed after the reveal.</p>';
  } else {
    h += rec.wager ? '<div><h2>Your wager</h2><div class="wagerlock">' + esc(rec.wager) + '</div></div>'
                   : '<div class="pill lapse" style="align-self:flex-start">Lapse: revealed without a wager</div>';
    h += sensesHtml(e);
    if (rec.wager && rec.outcome === 'ungraded') {
      h += '<h2>How did the wager do?</h2><div class="btns"><button class="btn" type="button" data-grade="check-correct">Correct</button><button class="btn" type="button" data-grade="check-slip">Label slip</button><button class="btn" type="button" data-grade="lapse-wrong">Wrong</button></div>' +
        '<p class="hint">Label slip: right meaning, but the wrong part of speech, transitivity or nuance. It counts as a check, not a lapse.</p>';
    } else if (rec.wager) {
      const o = OUTCOME[rec.outcome];
      h += '<div class="pill ' + o[1] + '" style="align-self:flex-start">Logged: ' + esc(o[0]) + '</div>';
    }
  }
  if (k) h += '<button class="link" type="button" id="unmark">Unmark as known</button>';
  return h + '</div>' + creditHtml();
}

const fmtTime = t => new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
function viewHistory() {
  if (!L.lookups.length) return '<p class="empty">No lookups yet. Every entry you open is listed here, newest first.</p>';
  const rows = L.lookups.slice(-S.historyShown).reverse();
  let h = '<div class="list">' + rows.map(r => {
    const o = OUTCOME[r.outcome] || [r.outcome, 'plain'];
    return '<button class="row" type="button" data-open="' + r.id + '" data-via="history"><span><span class="w">' + esc(r.word) + '</span> <span class="pill ' + o[1] + '">' + esc(o[0]) + '</span></span>' +
      '<span class="g">' + esc(fmtTime(r.t)) + (r.wager ? ' · wager: ' + esc(r.wager) : '') + '</span></button>';
  }).join('') + '</div>';
  if (L.lookups.length > S.historyShown) h += '<button class="btn" type="button" id="more-history">Show older lookups</button>';
  return h;
}

function viewCounts() {
  const n = p => L.lookups.filter(r => r.outcome.startsWith(p)).length;
  const last = L.meta.lastExportAt;
  const v = D.head ? D.head.version : null;
  let h = '<div class="tiles"><div class="tile"><b>' + L.known.size + '</b><span>Known words</span></div><div class="tile"><b>' + L.lookups.length + '</b><span>Lookups</span></div>' +
    '<div class="tile"><b>' + n('check') + '</b><span>Checks</span></div><div class="tile"><b>' + n('lapse') + '</b><span>Lapses</span></div></div>';
  if (S.notice) h += '<div class="banner"><span>' + esc(S.notice) + '</span></div>';
  if (S.error) h += '<div class="banner warn"><span>' + esc(S.error) + '</span></div>';
  h += '<div class="card"><h2>Your log</h2>' +
    '<div class="kv"><span>Last export</span><span>' + (last ? esc(fmtTime(last)) : 'never') + '</span></div>' +
    '<div class="kv"><span>Storage on this device</span><span>' + (S.protectedStorage === true ? 'protected' : S.protectedStorage === false ? 'not protected' : 'unknown') + '</span></div>' +
    '<div class="btns"><button class="btn primary" type="button" id="export">Export log</button><button class="btn" type="button" id="import">Import log</button></div>' +
    '<p class="hint">Export saves a file with every lookup, wager and known word. Keep a copy off the phone. Import adds a file\'s contents to what is here; nothing is removed.</p></div>';
  h += '<div class="card"><h2>Dictionary</h2>' +
    (v ? '<div class="kv"><span>JMdict</span><span>' + esc(v.jmdict + ' (' + v.jmdictDate + ')') + '</span></div><div class="kv"><span>Entries</span><span>' + v.entries.toLocaleString() + '</span></div>' : '') +
    (S.update ? '<button class="btn" type="button" id="update-dict">Update the dictionary</button>' : '') +
    '<p class="hint"><a href="sources.html">Sources and licences</a></p></div>';
  return h;
}

function render() {
  ['search', 'history', 'counts'].forEach(t => $('tab-' + t).setAttribute('aria-current', S.tab === t));
  if (!D.ready) return;
  const main = $('main');
  if (S.tab !== 'search') { main.innerHTML = S.tab === 'history' ? viewHistory() : viewCounts(); return; }
  let q = $('q');
  if (!q || !main.contains(q)) { main.innerHTML = searchShell(); q = $('q'); }
  // Only a change made by the page (opening or closing an entry, a tab) is
  // written into the box; while typing, the box is the source of S.q.
  if (q.value !== S.q && !composing) q.value = S.q;
  $('pane').innerHTML = viewSearch();
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------
async function openEntry(id, via) {
  const e = entryById(id);
  S.tab = 'search'; S.entry = id; S.revealed = false; S.justMarked = false;
  const typed = S.q; S.q = '';
  if (!e) { S.rec = null; render(); return; }
  const known = L.known.has(id);
  const rec = { t: Date.now(), id: id, word: head(e), reading: e.r[0], q: via === 'history' ? '' : typed, via: via || 'search', known: known, outcome: known ? 'not-revealed' : 'lookup' };
  S.rec = rec; L.lookups.push(rec);
  render();
  $('main').scrollTop = 0;
  try { await saveLookup(rec); } catch (err) { writeFailed(err); }
}
async function reveal() {
  const rec = S.rec, e = entryById(S.entry);
  rec.wager = ($('wager') ? $('wager').value : '').trim();
  rec.revealedAt = Date.now();
  rec.shown = e.s.map(s => s[1].join('; ')).join(' | ');
  rec.outcome = rec.wager ? 'ungraded' : 'lapse-no-wager';
  S.revealed = true; render();
  try { await saveLookup(rec); } catch (err) { writeFailed(err); }
}
async function grade(g) {
  const rec = S.rec; rec.outcome = g; rec.gradedAt = Date.now(); render();
  try { await saveLookup(rec); } catch (err) { writeFailed(err); }
}
async function setKnown(on) {
  const e = entryById(S.entry), t = Date.now();
  const mark = { t: t, id: e.id, word: head(e), action: on ? 'mark' : 'unmark' };
  L.marks.push(mark);
  if (on) { L.known.set(e.id, { id: e.id, word: head(e), reading: e.r[0], markedAt: t }); S.justMarked = true; }
  else { L.known.delete(e.id); S.justMarked = false; S.revealed = false; }
  render();
  try {
    mark.n = await tx('marks', 'readwrite', s => s.add(mark));
    if (on) await tx('known', 'readwrite', s => s.put(L.known.get(e.id)));
    else await tx('known', 'readwrite', s => s.delete(e.id));
  } catch (err) { writeFailed(err); }
}
function closeEntry() { S.entry = null; S.q = ''; S.rec = null; S.revealed = false; S.justMarked = false; render(); if ($('q')) $('q').focus(); }

function exportData() {
  return { app: 'lookup-tracker', format: 1, exportedAt: new Date().toISOString(), dictionary: D.head ? D.head.version : null,
    known: Array.from(L.known.values()), marks: L.marks, lookups: L.lookups };
}
async function doExport() {
  const name = 'lookup-tracker-' + new Date().toISOString().slice(0, 10) + '.json';
  const text = JSON.stringify(exportData(), null, 1);
  let sent = false;
  try {
    const file = new File([text], name, { type: 'application/json' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: name }); sent = true; }
  } catch (e) {
    if (e && e.name === 'AbortError') { S.notice = 'Export cancelled.'; render(); return; }
  }
  if (!sent) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  }
  S.notice = 'Exported ' + L.lookups.length + ' lookups and ' + L.known.size + ' known words as ' + name + '.';
  try { await setMeta('lastExportAt', Date.now()); } catch (e) { writeFailed(e); }
  render();
}
async function doImport(file) {
  let data;
  try { data = JSON.parse(await file.text()); } catch (e) { S.error = 'That file could not be read as an export.'; render(); return; }
  if (!data || data.app !== 'lookup-tracker' || !Array.isArray(data.lookups)) { S.error = 'That file is not a Lookup Tracker export.'; render(); return; }
  const have = new Set(L.lookups.map(r => r.t + '|' + r.id)), haveM = new Set(L.marks.map(m => m.t + '|' + m.id + '|' + m.action));
  let addedL = 0, addedK = 0;
  try {
    for (const r of data.lookups) {
      if (have.has(r.t + '|' + r.id)) continue;
      const rec = Object.assign({}, r); delete rec.n;
      rec.n = await tx('lookups', 'readwrite', s => s.add(rec));
      L.lookups.push(rec); addedL++;
    }
    for (const m of (data.marks || [])) {
      if (haveM.has(m.t + '|' + m.id + '|' + m.action)) continue;
      const rec = Object.assign({}, m); delete rec.n;
      rec.n = await tx('marks', 'readwrite', s => s.add(rec));
      L.marks.push(rec);
    }
    for (const k of (data.known || [])) {
      const cur = L.known.get(k.id);
      if (cur && cur.markedAt <= k.markedAt) continue;
      if (!cur) addedK++;
      L.known.set(k.id, k);
      await tx('known', 'readwrite', s => s.put(k));
    }
    L.lookups.sort((a, b) => a.t - b.t);
    S.error = ''; S.notice = 'Imported ' + addedL + ' lookups and ' + addedK + ' known words that were not here.';
  } catch (e) { writeFailed(e); return; }
  render();
}

async function checkForUpdate() {
  try {
    const r = await fetch(VERSION_URL, { cache: 'no-store' });
    if (!r.ok) return;
    const v = await r.json();
    if (D.head && v.built && v.built !== D.head.version.built) { S.update = v; render(); }
  } catch (e) { /* offline: nothing to check */ }
}
async function updateDict() {
  $('main').innerHTML = '<p class="status" id="boot">Downloading the newer dictionary…</p>';
  try {
    const text = await fetchDictText(got => { const b = $('boot'); if (b) b.textContent = 'Downloading the newer dictionary… ' + (got / 1e6).toFixed(0) + ' MB'; }, true);
    installDict(text); S.update = null; S.notice = 'Dictionary updated.';
  } catch (e) { S.error = 'The update failed: ' + e.message; }
  render();
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
// Suggestions follow every change in the box, including kana not yet
// confirmed with 確定 (the box itself is never replaced; see searchShell).
let composing = false;
const onTyped = e => { if (e.target.id === 'q' && S.q !== e.target.value) { S.q = e.target.value; render(); } };
$('main').addEventListener('compositionstart', () => { composing = true; });
$('main').addEventListener('compositionend', e => { composing = false; onTyped(e); });
$('main').addEventListener('input', onTyped);
$('main').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.dataset.open) { openEntry(Number(b.dataset.open), b.dataset.via); return; }
  if (b.dataset.tab) { S.tab = b.dataset.tab; render(); return; }
  if (b.dataset.grade) { grade(b.dataset.grade); return; }
  if (b.id === 'close') closeEntry();
  else if (b.id === 'mark') setKnown(true);
  else if (b.id === 'unmark') setKnown(false);
  else if (b.id === 'reveal') reveal();
  else if (b.id === 'export') doExport();
  else if (b.id === 'import') $('import-file').click();
  else if (b.id === 'update-dict') updateDict();
  else if (b.id === 'more-history') { S.historyShown += 200; render(); }
});
$('import-file').addEventListener('change', e => { const f = e.target.files[0]; e.target.value = ''; if (f) doImport(f); });
['search', 'history', 'counts'].forEach(t => $('tab-' + t).addEventListener('click', () => {
  S.tab = t; S.notice = '';
  if (t === 'search') { S.entry = null; S.q = ''; S.rec = null; }
  render();
  if (t === 'search' && $('q')) $('q').focus();
}));

async function start() {
  const boot = msg => { const b = $('boot'); if (b) b.textContent = msg; };
  try {
    await loadLog();
  } catch (e) {
    $('main').innerHTML = '<div class="banner warn"><span>This browser would not open the app\'s storage, so nothing could be saved. Private browsing blocks it. (' + esc(e && e.message ? e.message : String(e)) + ')</span></div>';
    return;
  }
  try {
    if (navigator.storage && navigator.storage.persist) S.protectedStorage = await navigator.storage.persist();
  } catch (e) { S.protectedStorage = null; }
  try {
    boot('Loading the dictionary…');
    const text = await fetchDictText(got => boot('Downloading the dictionary (one time only)… ' + (got / 1e6).toFixed(0) + ' MB'));
    installDict(text);
  } catch (e) {
    $('main').innerHTML = '<div class="banner warn"><span>' + esc(e.message || String(e)) + ' Connect to the internet and open the app again.</span></div>';
    return;
  }
  render();
  checkForUpdate();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch(() => { /* offline start still works from the caches already made */ });
}
start();
