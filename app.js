// app.js — 畫面、Firebase 讀寫、即時存檔、匯出入。業務規則一律呼叫 logic.js。
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import {
  getAuth, onAuthStateChanged, signInAnonymously, GoogleAuthProvider, signInWithPopup, signInWithCredential, signOut, connectAuthEmulator,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';
import {
  getDatabase, ref, onValue, get, set, update, push, serverTimestamp, connectDatabaseEmulator,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js';
import * as L from './logic.js';
import qrcode from './vendor/qrcode.js'; // qrcode-generator 2.0.4，MIT（T21、T26）
const SHEETJS_URL = 'https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs'; // B2：固定 0.20.3

// ---------- Firebase 設定（Web API key 本來就公開，不是密鑰） ----------
export const FIREBASE_CONFIG = {
  apiKey: 'AIzaSyAE0B9DeyIRA4FhZxc_SoHXb_f_EjtVcr0',
  authDomain: 'concern-board.firebaseapp.com',
  databaseURL: 'https://concern-board-default-rtdb.asia-southeast1.firebasedatabase.app',
  projectId: 'concern-board',
  storageBucket: 'concern-board.firebasestorage.app',
  messagingSenderId: '959094466354',
  appId: '1:959094466354:web:3f9c1acd6ebb775c45192b',
};
// 擁有者 UID（T22：權限以 database.rules.json 為準，這裡只用來決定畫面）
const OWNER_UID = 'BkEeFSDkL9YW98rv5qxFTgG06Lu1';
const TEMPLATES = [{ id: 'prmc-workshop', file: 'config/templates/prmc-workshop.json', rehearsal: 'config/templates/prmc-workshop.rehearsal.json' }];

// 在本機（localhost）預覽時預設連到 emulator，不碰正式資料；網址加 ?prod 才連正式 Firebase。
const params = new URLSearchParams(location.search);
const USE_EMULATOR = ['localhost', '127.0.0.1'].includes(location.hostname) && !params.has('prod');
const fbApp = initializeApp(USE_EMULATOR
  ? { ...FIREBASE_CONFIG, projectId: 'demo-concern-board', databaseURL: 'http://127.0.0.1:9000/?ns=demo-concern-board-default-rtdb' }
  : FIREBASE_CONFIG);
const auth = getAuth(fbApp);
const db = getDatabase(fbApp);
if (USE_EMULATOR) {
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  connectDatabaseEmulator(db, '127.0.0.1', 9000);
}

// ---------- 小工具 ----------
const $app = document.getElementById('app');
/** 建立 DOM（文字一律用 textContent，避免使用者輸入的內容被當成 HTML） */
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}
function mount(...nodes) { $app.replaceChildren(...nodes.filter((n) => n !== null && n !== undefined && n !== false)); }
function msg(kind, text) { return h('div', { class: `msg ${kind}` }, text); }
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* 空間不足或無痕模式 */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};
const roleKey = (code) => `cb:role:${code}`;       // { role, group, name }（不含 PIN）
const snapKey = (code) => `cb:snap:${code}`;       // 場次快照（重新整理時先顯示）
const pendingKey = (code) => `cb:pending:${code}`; // 還沒同步的草稿
function isPermissionDenied(e) { return /permission/i.test(String(e && (e.code || e.message))); }
function catOf(config, key) { return config.categories.find((c) => c.key === key); }
function catChip(cat) {
  return cat ? h('span', { class: 'chip', style: { background: cat.color, color: cat.textColor } }, cat.label) : h('span', { class: 'chip' }, '未分類');
}
function phaseLabel(meta) {
  const p = meta && meta.phase;
  const def = p && meta.config.phases[p.index];
  return def ? def.label : '';
}
function download(filename, text, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = h('a', { href: url, download: filename });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
/** B7：匯出 XLSX（四張工作表的內容由 logic.js 產生；SheetJS 只在按下時才載入） */
async function exportXlsx(code, data) {
  const XLSX = await import(SHEETJS_URL);
  const now = Date.now();
  const wb = XLSX.utils.book_new();
  for (const { name, rows } of L.buildXlsxSheets({ code, ...data }, now)) {
    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws['!cols'] = rows[0].map((_, i) => ({ wch: Math.min(60, Math.max(8, ...rows.map((r) => [...String(r[i] ?? '')].length * 2))) }));
    XLSX.utils.book_append_sheet(wb, ws, name);
  }
  XLSX.writeFile(wb, L.exportFileName(data.meta && data.meta.title, code, now, 'xlsx'));
}
function exportButtons(code, getData) {
  const err = h('span', { class: 'sub' });
  return h('div', { class: 'row' },
    h('button', { onclick: () => exportSession(code, getData()) }, '匯出 JSON'),
    h('button', { onclick: () => { err.textContent = ''; exportXlsx(code, getData()).catch((e) => { err.textContent = `XLSX 匯出失敗：${e.message}`; }); } }, '匯出 XLSX'),
    err);
}
function exportSession(code, data) {
  const json = L.toExportJson({ code, ...data });
  download(L.exportFileName(data.meta && data.meta.title, code, Date.now(), 'json'), JSON.stringify(json, null, 2));
}

// 連線燈號
let connected = false;
const connListeners = new Set();
onValue(ref(db, '.info/connected'), (s) => { connected = Boolean(s.val()); connListeners.forEach((f) => f(connected)); });
function connDot() {
  const el = h('span', { class: 'dot' });
  const paint = (on) => { el.className = `dot ${on ? 'on' : 'off'}`; el.textContent = on ? '已同步' : '離線（恢復後自動同步）'; };
  paint(connected); connListeners.add(paint);
  return el;
}

// ---------- 路由 ----------
let cleanup = [];
function addCleanup(f) { cleanup.push(f); }
function runCleanup() { cleanup.forEach((f) => { try { f(); } catch { /* ignore */ } }); cleanup = []; connListeners.clear(); }

let authReady = false;
onAuthStateChanged(auth, (user) => {
  if (!user && !location.hash.startsWith('#/admin')) { signInAnonymously(auth).catch((e) => mount(msg('err', `無法登入：${e.message}`))); return; }
  authReady = true;
  route();
});
window.addEventListener('hashchange', () => { if (authReady) route(); });

function route() {
  runCleanup();
  document.body.classList.remove('screen');
  $app.classList.remove('wide');
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  if (parts[0] === 'admin') return viewAdmin();
  if (!auth.currentUser) { mount(h('p', { class: 'sub' }, '登入中…')); signInAnonymously(auth).catch((e) => mount(msg('err', `無法登入：${e.message}`))); return; }
  if (parts[0] === 's' && parts[1]) {
    const code = parts[1].toUpperCase();
    const view = parts[2] || '';
    if (view === 'screen') return viewScreen(code);
    if (view === 'helper') return viewHelper(code);
    if (view === 'host') return viewHost(code);
    if (view === 'print') return viewPrint(code);
    if (view === 'vote') return viewParticipant(code);
    return viewJoin(code);
  }
  return viewHome();
}

// ---------- 場次資料訂閱 ----------
/** 訂閱 sessions/{code}；先用本機快照顯示，收到資料後更新快照。 */
function watchSession(code, onData, onError) {
  const snap = store.get(snapKey(code));
  if (snap && snap.meta) onData(snap, true);
  const unsub = onValue(ref(db, `sessions/${code}`), (s) => {
    const data = s.val();
    if (!data || !data.meta) { onError('notfound'); return; }
    store.set(snapKey(code), data);
    onData(data, false);
  }, (e) => onError(isPermissionDenied(e) ? 'denied' : e.message));
  addCleanup(unsub);
}
function sessionError(code, kind) {
  store.del(snapKey(code));
  mount(h('h1', {}, '無法開啟場次'),
    msg('err', kind === 'notfound' || kind === 'denied' ? `找不到場次「${code}」，或場次目前沒有開放。` : `發生錯誤：${kind}`),
    h('p', {}, h('a', { href: '#/' }, '回到首頁')));
}

// ---------- 首頁 ----------
function viewHome() {
  const input = h('input', { type: 'text', placeholder: '例如 K7M2QX', maxlength: 6, autocapitalize: 'characters', autocomplete: 'off' });
  const err = h('div');
  const go = () => {
    const code = input.value.trim().toUpperCase();
    if (!L.isValidCode(code)) { err.replaceChildren(msg('err', '場次代碼是 6 碼英文字母和數字')); return; }
    location.hash = `#/s/${code}`;
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  mount(
    h('h1', {}, '關注點共編投票'),
    h('div', { class: 'card' },
      h('label', { class: 'field' }, h('span', {}, '場次代碼'), input),
      err,
      h('button', { class: 'primary big', onclick: go }, '進入場次')),
    h('p', { class: 'sub' }, h('a', { href: '#/admin' }, '擁有者管理')),
    USE_EMULATOR ? msg('warn', '本機預覽模式：資料存在本機的模擬資料庫（emulator），不會影響正式資料。') : null,
  );
  input.focus();
}

// ---------- 加入場次 ----------
async function viewJoin(code) {
  mount(h('p', { class: 'sub' }, '讀取場次…'));
  let meta;
  try {
    const s = await get(ref(db, `sessions/${code}/meta`));
    meta = s.val();
  } catch (e) { return sessionError(code, isPermissionDenied(e) ? 'denied' : e.message); }
  if (!meta) return sessionError(code, 'notfound');
  const uid = auth.currentUser.uid;
  const saved = store.get(roleKey(code));
  const groups = Array.from({ length: meta.groupCount }, (_, i) => i + 1);
  const groupSelect = () => h('select', {}, h('option', { value: '' }, '請選擇'), groups.map((g) => h('option', { value: g }, `第 ${g} 組`)));
  const out = h('div');

  const header = [h('h1', {}, meta.title), h('p', { class: 'sub' }, `場次代碼 ${code}｜${phaseLabel(meta)}`)];
  if (meta.visibility === 'demo') {
    return mount(...header, msg('info', '這是展示用的場次，只能觀看，不能輸入或投票。'),
      h('a', { href: `#/s/${code}/screen` }, h('button', { class: 'primary big' }, '觀看投影畫面')));
  }
  if (meta.visibility !== 'live') {
    return mount(...header, msg('warn', '這個場次目前沒有開放（擁有者模式）。'),
      h('a', { href: `#/s/${code}/screen` }, h('button', { class: 'big' }, '觀看投影畫面')));
  }

  const resume = saved && saved.role
    ? h('div', { class: 'card' },
      h('p', {}, `你之前在這個場次是${saved.role === 'helper' ? `第 ${saved.group} 組小幫手` : saved.role === 'host' ? '主持人' : `參與者「${saved.name}（第 ${saved.group} 組）」`}。`),
      h('a', { href: `#/s/${code}/${saved.role === 'participant' ? 'vote' : saved.role}` }, h('button', { class: 'primary big' }, '繼續')))
    : null;

  // 參與者
  const pName = h('input', { type: 'text', maxlength: 30, placeholder: '你的名字' });
  const pGroup = groupSelect();
  const pBtn = h('button', { class: 'primary big' }, '加入');
  pBtn.onclick = async () => {
    const name = L.normalizeName(pName.value);
    const group = Number(pGroup.value);
    if (!name || !group) { out.replaceChildren(msg('err', '姓名和組別都必填')); return; }
    pBtn.disabled = true;
    try {
      const ps = (await get(ref(db, `sessions/${code}/participants`))).val();
      if (L.isDuplicateName(ps, name, group, uid)) {
        out.replaceChildren(msg('warn', `第 ${group} 組已經有人叫「${name}」，請在名字後面加一個註記，例如「${name}-RD」。`));
        return;
      }
      await set(ref(db, `sessions/${code}/participants/${uid}`), { name, group, joinedAt: serverTimestamp() });
      store.set(roleKey(code), { role: 'participant', name, group });
      location.hash = `#/s/${code}/vote`;
    } catch (e) { out.replaceChildren(msg('err', `加入失敗：${e.message}`)); } finally { pBtn.disabled = false; }
  };

  // 小幫手、主持人
  const pinInput = () => h('input', { type: 'password', inputmode: 'numeric', maxlength: 6, autocomplete: 'off', placeholder: '6 位數字' });
  const hPin = pinInput(); const hGroup = groupSelect();
  const hBtn = h('button', { class: 'big' }, '以小幫手身分進入');
  hBtn.onclick = async () => {
    const pin = hPin.value.trim(); const group = Number(hGroup.value);
    if (!L.isValidPin(pin)) { out.replaceChildren(msg('err', 'PIN 是 6 位數字')); return; }
    if (!group) { out.replaceChildren(msg('err', '請選擇組別')); return; }
    hBtn.disabled = true;
    try {
      await set(ref(db, `access/${code}/helpers/${uid}`), { pin, group });
      hPin.value = '';
      store.set(roleKey(code), { role: 'helper', group });
      location.hash = `#/s/${code}/helper`;
    } catch (e) { out.replaceChildren(msg('err', isPermissionDenied(e) ? '小幫手 PIN 不正確' : `進入失敗：${e.message}`)); } finally { hBtn.disabled = false; }
  };
  const oPin = pinInput();
  const oBtn = h('button', { class: 'big' }, '以主持人身分進入');
  oBtn.onclick = async () => {
    const pin = oPin.value.trim();
    if (!L.isValidPin(pin)) { out.replaceChildren(msg('err', 'PIN 是 6 位數字')); return; }
    oBtn.disabled = true;
    try {
      await set(ref(db, `access/${code}/hosts/${uid}`), { pin });
      oPin.value = '';
      store.set(roleKey(code), { role: 'host' });
      location.hash = `#/s/${code}/host`;
    } catch (e) { out.replaceChildren(msg('err', isPermissionDenied(e) ? '主持人 PIN 不正確' : `進入失敗：${e.message}`)); } finally { oBtn.disabled = false; }
  };

  mount(...header, resume, out,
    h('div', { class: 'card' }, h('h2', {}, '參與者'),
      h('label', { class: 'field' }, h('span', {}, '姓名'), pName),
      h('label', { class: 'field' }, h('span', {}, '組別'), pGroup), pBtn),
    h('details', { class: 'card' }, h('summary', {}, '小幫手'),
      h('label', { class: 'field' }, h('span', {}, '小幫手 PIN'), hPin),
      h('label', { class: 'field' }, h('span', {}, '組別'), hGroup), hBtn),
    h('details', { class: 'card' }, h('summary', {}, '主持人'),
      h('label', { class: 'field' }, h('span', {}, '主持人 PIN'), oPin), oBtn));
}

// ---------- 小幫手 ----------
/** 只在順序不同時才移動元素（移動正在輸入的元素會讓它失去焦點） */
function placeInOrder(container, els) {
  els.forEach((el, i) => { if (container.children[i] !== el) container.insertBefore(el, container.children[i] || null); });
  while (container.children.length > els.length) container.lastChild.remove();
}

async function viewHelper(code) {
  const uid = auth.currentUser.uid;
  const role = store.get(roleKey(code));
  mount(h('p', { class: 'sub' }, '讀取中…'));
  // 確認 access 還在（換過 PIN 或換了瀏覽器就要重新輸入）
  let access = null;
  try { access = (await get(ref(db, `access/${code}/helpers/${uid}`))).val(); } catch { /* 離線時沿用本機紀錄 */ access = role && role.role === 'helper' ? { group: role.group } : null; }
  if (!access) { location.hash = `#/s/${code}`; return; }
  const group = Number(access.group);
  const itemsRef = () => ref(db, `sessions/${code}/items`);

  const pending = store.get(pendingKey(code)) || {}; // { id: { text, cat, rewritten, isNew } }
  const savePending = () => store.set(pendingKey(code), pending);
  const rows = new Map(); // id → row
  const timers = new Map();
  const selected = new Set(); // 合併階段勾選的題目
  const sections = new Map(); // key → { wrap, list, head }
  let session = null;

  const title = h('h1'); const sub = h('p', { class: 'sub' }); const banner = h('div'); const dialog = h('div');
  const listHead = h('h2', { class: 'grow' });
  const mineBox = h('div');
  const emptyEl = h('p', { class: 'sub' }, '還沒有題目，按「新增一題」開始。');
  const othersBox = h('div', { class: 'readonly' });
  const othersWrap = h('details', { class: 'card' }, h('summary', {}, '其他組的題目（唯讀）'), othersBox);
  const addBtn = h('button', { class: 'primary' }, '＋ 新增一題');
  const mergeInfo = h('span', { class: 'grow' });
  const clearBtn = h('button', { onclick: () => { selected.clear(); render(); } }, '取消勾選');
  const mergeBtn = h('button', { class: 'primary', onclick: () => openMergeDialog() }, '合併');
  const mergeBar = h('div', { class: 'mergebar row' }, mergeInfo, clearBtn, mergeBtn);
  mount(h('div', { class: 'topbar' }, h('div', {}, title, sub), connDot()), banner, dialog,
    h('div', { class: 'row' }, listHead, addBtn), mineBox, othersWrap, mergeBar);

  const cfg = () => session.meta.config;
  const maxLen = () => (cfg().itemFields && cfg().itemFields.maxLength) || 150;
  const denied = (e) => (isPermissionDenied(e) ? '沒有權限：可能階段已切換或 PIN 已更換' : e.message);

  // ---- 即時存檔（T15） ----
  function writeItem(id) {
    const d = pending[id];
    if (!d || !session) return;
    const row = rows.get(id);
    const t = L.normalizeItemText(d.text, maxLen());
    if (!t.ok) { row && row.state('err', d.isNew ? `尚未儲存：${t.error}` : `${t.error}（未儲存）`); return; }
    if (!d.cat) { row && row.state('err', '尚未儲存：請選分類'); return; }
    const exists = session.items && session.items[id];
    const stamp = { updatedAt: serverTimestamp(), updatedBy: uid };
    const snapshot = JSON.stringify(d);
    const p = exists
      ? update(ref(db, `sessions/${code}/items/${id}`), { text: t.value, cat: d.cat, rewritten: Boolean(d.rewritten), ...stamp })
      : set(ref(db, `sessions/${code}/items/${id}`), {
        text: t.value, cat: d.cat, groups: { [group]: true }, rewritten: Boolean(d.rewritten), status: 'active',
        createdBy: uid, createdGroup: group, createdAt: serverTimestamp(), ...stamp,
      });
    row && row.state('', connected ? '儲存中…' : '離線，恢復後自動送出');
    p.then(() => {
      if (JSON.stringify(pending[id]) === snapshot) { delete pending[id]; savePending(); }
      rows.get(id) && rows.get(id).state('ok', '已儲存');
    }).catch((e) => {
      rows.get(id) && rows.get(id).state('err', `儲存失敗：${denied(e)}`);
      if (isPermissionDenied(e)) { delete pending[id]; savePending(); }
    });
  }
  function schedule(id) {
    clearTimeout(timers.get(id));
    timers.set(id, setTimeout(() => writeItem(id), 500)); // T15：停止輸入 0.5 秒自動寫入
  }
  addCleanup(() => timers.forEach((t) => clearTimeout(t)));

  // ---- 合併、拆回、複製到另一類、刪除：讀最新資料 → logic.js 算變更 → 一次寫入 ----
  async function apply(compute) {
    let fresh;
    try { fresh = (await get(itemsRef())).val() || {}; } catch { fresh = (session && session.items) || {}; }
    let updates;
    try { updates = compute(fresh); } catch (e) { alert(`無法完成：${e.message}（可能有人剛改動了這些題目）`); return false; }
    const u = L.toPathUpdates(fresh, updates);
    for (const [id, v] of Object.entries(updates)) {
      if (v === null) { delete pending[id]; continue; }
      if (fresh[id]) { u[`${id}/updatedAt`] = serverTimestamp(); u[`${id}/updatedBy`] = uid; }
      else u[id] = { ...u[id], createdAt: serverTimestamp(), updatedAt: serverTimestamp(), updatedBy: uid };
    }
    savePending();
    try { await update(itemsRef(), u); return true; } catch (e) { alert(`寫入失敗：${denied(e)}`); return false; }
  }
  async function doSplit(id) {
    const newId = push(itemsRef()).key;
    const ok = await apply((fresh) => {
      const r = L.splitItem(fresh, id, cfg().categories, { newId, uid, group });
      return { [r.id]: r.item };
    });
    if (ok) setTimeout(() => { const r = rows.get(newId); if (r) { r.focus(); r.state('', '已複製到另一類：請把兩題各自改寫成只講一個面向'); } }, 300);
  }
  async function doUnmerge(id) {
    const n = Object.keys(session.items[id].sources || {}).length;
    if (!confirm(`拆回成原本的 ${n} 題？`)) return;
    await apply((fresh) => L.unmerge(fresh, id));
  }
  function doDelete(id) {
    const item = session.items && session.items[id];
    if (!item) { delete pending[id]; savePending(); render(); return; }
    if (!item.sources) {
      if (confirm(`確定刪除這一題？\n\n${item.text}`)) apply((fresh) => L.deleteItem(fresh, id));
      return;
    }
    // T20：合併後的題目，預設拆回
    const rUn = h('input', { type: 'radio', name: 'delmode', value: 'unmerge', checked: true });
    const rAll = h('input', { type: 'radio', name: 'delmode', value: 'cascade' });
    const box = h('div', { class: 'card dialog' }, h('h2', {}, '刪除合併後的題目'),
      h('p', {}, item.text),
      h('label', { class: 'field' }, rUn, ' 拆回：刪除這一題，原本的幾題恢復顯示（建議）'),
      h('label', { class: 'field' }, rAll, ' 連同原題一起刪除：這一題和合併前的所有題目都刪除'),
      h('div', { class: 'row' },
        h('button', { class: 'danger', onclick: async () => { const mode = rAll.checked ? 'cascade' : 'unmerge'; if (await apply((fresh) => L.deleteItem(fresh, id, mode))) dialog.replaceChildren(); } }, '確定'),
        h('button', { onclick: () => dialog.replaceChildren() }, '取消')));
    dialog.replaceChildren(box); box.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  function openMergeDialog() {
    const ids = [...selected];
    const check = L.canMerge(session.items, ids);
    if (!check.ok) { alert(check.error); return; }
    const items = session.items;
    const ta = h('textarea', { maxlength: maxLen() });
    ta.value = items[ids[0]].text;
    const counter = h('span', { class: 'sub' });
    const paint = () => { counter.textContent = `${[...ta.value].length}/${maxLen()}`; };
    ta.addEventListener('input', paint); paint();
    const err = h('div');
    const newId = push(itemsRef()).key;
    const box = h('div', { class: 'card dialog' }, h('h2', {}, `合併 ${ids.length} 題`),
      h('p', { class: 'sub' }, '選用其中一題的文字，或在下面直接改寫。組別會自動合併。'),
      ids.map((id) => h('div', { class: 'item', style: { borderLeftColor: (catOf(cfg(), items[id].cat) || {}).color } },
        items[id].text,
        h('div', { class: 'meta' }, h('span', { class: 'sub' }, L.groupLabel(items[id].groups)),
          h('button', { class: 'state', onclick: () => { ta.value = items[id].text; paint(); } }, '用這題的文字')))),
      h('label', { class: 'field' }, h('span', {}, '合併後的題目'), ta), counter, err,
      h('div', { class: 'row' },
        h('button', { class: 'primary', onclick: async () => {
          const t = L.normalizeItemText(ta.value, maxLen());
          if (!t.ok) { err.replaceChildren(msg('err', t.error)); return; }
          if (await apply((fresh) => L.mergeItems(fresh, ids, t.value, { newId, uid, group, maxLength: maxLen() }).updates)) {
            selected.clear(); dialog.replaceChildren(); render();
          }
        } }, '確定合併'),
        h('button', { onclick: () => dialog.replaceChildren() }, '取消')));
    dialog.replaceChildren(box); box.scrollIntoView({ behavior: 'smooth', block: 'center' }); ta.focus();
  }

  // ---- 一題的編輯列 ----
  const pick = (it) => (it ? { text: it.text, cat: it.cat, rewritten: Boolean(it.rewritten) } : { text: '', cat: '', rewritten: false });
  function makeRow(id) {
    const ta = h('textarea', { maxlength: maxLen(), placeholder: `輸入${(cfg().labels && cfg().labels.item) || '題目'}（必填，上限 ${maxLen()} 字）` });
    const counter = h('span', { class: 'sub' });
    const stateEl = h('span', { class: 'state' });
    const sel = h('input', { type: 'checkbox', title: '勾選後可以合併' });
    const selLabel = h('label', { class: 'pick' }, sel, ' 選取');
    const radios = cfg().categories.map((c) => {
      const r = h('input', { type: 'radio', name: `cat-${id}`, value: c.key });
      return { c, r, label: h('label', { style: { borderColor: c.color } }, r, c.label) };
    });
    const rw = h('input', { type: 'checkbox' });
    const groupsEl = h('span', { class: 'sub' });
    const sourcesEl = h('div', { class: 'sub sources' });
    const splitBtn = h('button', { title: '內容同時談到兩類時：複製一份到另一類，再把兩題各自改寫成只講一個面向（T24）', onclick: () => doSplit(id) }, '複製到另一類（並改寫描述）');
    const unmergeBtn = h('button', { onclick: () => doUnmerge(id) }, '拆回');
    const delBtn = h('button', { class: 'danger', onclick: () => doDelete(id) }, '刪除');
    const el = h('div', { class: 'item' }, h('div', { class: 'row' }, selLabel, h('span', { class: 'grow' })), ta,
      h('div', { class: 'meta' },
        h('span', { class: 'catpick row' }, radios.map((x) => x.label)),
        cfg().itemFields && cfg().itemFields.rewritten ? h('label', {}, rw, ' 已改寫') : null,
        groupsEl, counter, stateEl),
      sourcesEl,
      h('div', { class: 'row actions' }, splitBtn, unmergeBtn, delBtn));
    const local = () => pending[id] || (pending[id] = { ...pick(session.items && session.items[id]) });
    const changed = () => { savePending(); counter.textContent = `${[...ta.value].length}/${maxLen()}`; schedule(id); paintCat(); };
    ta.addEventListener('input', () => { local().text = ta.value; changed(); });
    radios.forEach(({ c, r }) => r.addEventListener('change', () => { local().cat = c.key; changed(); }));
    rw.addEventListener('change', () => { local().rewritten = rw.checked; changed(); });
    sel.addEventListener('change', () => { if (sel.checked) selected.add(id); else selected.delete(id); paintMergeBar(); });
    function paintCat() {
      const cur = (pending[id] && pending[id].cat) || (session.items && session.items[id] && session.items[id].cat);
      const c = cur && catOf(cfg(), cur);
      el.style.borderLeftColor = c ? c.color : 'var(--line)';
    }
    return {
      el,
      state(kind, text) { stateEl.className = `state ${kind}`; stateEl.textContent = text; },
      update(item, acts) {
        const v = pending[id] || pick(item);
        if (document.activeElement !== ta && ta.value !== (v.text || '')) ta.value = v.text || '';
        radios.forEach(({ c, r }) => { r.checked = v.cat === c.key; r.disabled = !acts.edit; });
        rw.checked = Boolean(v.rewritten); rw.disabled = !acts.edit;
        ta.readOnly = !acts.edit;
        selLabel.hidden = !acts.select; sel.checked = selected.has(id);
        splitBtn.hidden = !acts.split; unmergeBtn.hidden = !acts.unmerge; delBtn.hidden = !acts.delete;
        groupsEl.textContent = item ? L.groupLabel(item.groups) : L.groupLabel({ [group]: true });
        const srcs = item && item.sources ? Object.keys(item.sources) : [];
        sourcesEl.textContent = srcs.length ? `合併自：${srcs.map((s) => { const x = session.items[s]; return x ? `「${x.text}」（${L.groupLabel(x.groups)}）` : '（已刪除）'; }).join('、')}` : '';
        counter.textContent = `${[...ta.value].length}/${maxLen()}`;
        paintCat();
      },
      focus() { ta.focus(); },
    };
  }

  addBtn.addEventListener('click', () => {
    const id = push(itemsRef()).key;
    pending[id] = { text: '', cat: '', rewritten: false, isNew: true };
    savePending();
    render();
    const r = rows.get(id); if (r) { r.focus(); r.state('', '輸入後自動儲存'); }
  });

  function sectionFor(key, label, c) {
    if (!sections.has(key)) {
      const head = h('h3', { class: 'section-h' });
      const list = h('div');
      sections.set(key, { wrap: h('div', { class: 'section' }, head, list), list, head });
    }
    const s = sections.get(key);
    s.head.hidden = !label;
    s.head.textContent = label || '';
    if (c) Object.assign(s.head.style, { background: c.color, color: c.textColor });
    return s;
  }

  function paintMergeBar() {
    const type = session && session.meta.phase && session.meta.phase.type;
    mergeBar.hidden = !(type === 'merge' && session.meta.visibility === 'live');
    const n = selected.size;
    const check = L.canMerge(session ? session.items : {}, [...selected]);
    mergeInfo.textContent = n === 0 ? '勾選同一分類的 2 題以上，再按「合併」。'
      : n === 1 ? '已選 1 題，再選 1 題以上。' : check.ok ? `已選 ${n} 題` : `已選 ${n} 題：${check.error}`;
    mergeInfo.className = `grow ${n >= 2 && !check.ok ? 'warntext' : ''}`;
    mergeBtn.disabled = !check.ok;
    clearBtn.hidden = n === 0;
  }

  function render() {
    if (!session) return;
    const { meta } = session;
    const items = session.items || {};
    const type = meta.phase && meta.phase.type;
    const live = meta.visibility === 'live';
    title.textContent = meta.title;
    sub.textContent = `第 ${group} 組小幫手｜${phaseLabel(meta)}`;
    banner.replaceChildren(...[
      type === 'merge' ? msg('info', '合併階段：可以修改、合併、拆回、複製到另一類所有組的題目。分類寫錯時先改分類，同一分類的題目才能合併。') : null,
      type !== 'collect' && type !== 'merge' ? msg('info', '目前階段不能編輯題目。') : null,
      !live ? msg('warn', '場次目前不是「進行中」，無法寫入。') : null].filter(Boolean));
    addBtn.hidden = !(live && type === 'collect');
    listHead.textContent = type === 'merge' ? '全部題目（依分類）' : `第 ${group} 組的題目`;

    // 已經不是 active 的題目：取消勾選、丟掉沒送出的草稿
    for (const id of [...selected]) if (type !== 'merge' || !items[id] || items[id].status !== 'active') selected.delete(id);
    let dropped = false;
    for (const id of Object.keys(pending)) if (items[id] && items[id].status !== 'active') { delete pending[id]; dropped = true; }
    if (dropped) savePending();

    const ids = Object.keys(items).filter((id) => items[id].status === 'active'
      && (type === 'merge' || (items[id].groups && items[id].groups[String(group)])));
    for (const id of Object.keys(pending)) if (!items[id] && pending[id].isNew && !ids.includes(id)) ids.push(id);
    ids.sort((a, b) => ((items[a] && items[a].createdAt) || Infinity) - ((items[b] && items[b].createdAt) || Infinity) || a.localeCompare(b));
    for (const [id, r] of rows) if (!ids.includes(id)) { r.el.remove(); rows.delete(id); }

    const cats = meta.config.categories;
    const defs = type === 'merge' ? cats.map((c) => ({ key: c.key, label: c.label, c })) : [{ key: 'mine' }];
    const buckets = new Map(defs.map((d) => [d.key, []]));
    for (const id of ids) {
      const acts = live ? L.helperActions(type, group, items[id] || null) : { edit: false, split: false, select: false, unmerge: false, delete: false };
      let r = rows.get(id);
      if (!r) { r = makeRow(id); rows.set(id, r); }
      r.update(items[id], acts);
      const cat = (pending[id] && pending[id].cat) || (items[id] && items[id].cat);
      const key = type === 'merge' ? (buckets.has(cat) ? cat : cats[0].key) : 'mine';
      buckets.get(key).push(r.el);
    }
    const wraps = defs.map((d) => {
      const s = sectionFor(d.key, d.label ? `${d.label}（${buckets.get(d.key).length}）` : '', d.c);
      placeInOrder(s.list, buckets.get(d.key));
      return s.wrap;
    });
    placeInOrder(mineBox, ids.length ? wraps : [emptyEl]);

    // 其他組（唯讀，只在收集階段顯示）
    othersWrap.hidden = type === 'merge';
    const others = L.itemsByGroup(items, meta.groupCount).filter((g) => g.group !== group);
    othersBox.replaceChildren(...others.map((g) => h('div', {}, h('h2', {}, `第 ${g.group} 組`),
      g.items.length ? g.items.map((it) => h('div', { class: 'item', style: { borderLeftColor: (catOf(meta.config, it.cat) || {}).color } },
        it.text, h('div', { class: 'meta' }, catChip(catOf(meta.config, it.cat)), it.rewritten ? h('span', { class: 'sub' }, '已改寫') : null)))
        : h('p', { class: 'sub' }, '（無）'))));
    paintMergeBar();
  }

  let resent = false;
  watchSession(code, (data, fromCache) => {
    session = data;
    render();
    // 重新整理後，把上次沒送出的草稿再送一次
    if (!fromCache && !resent) { resent = true; Object.keys(pending).forEach((id) => schedule(id)); }
  }, (kind) => sessionError(code, kind));
}

// ---------- 主持人 ----------
async function viewHost(code) {
  const uid = auth.currentUser.uid;
  let access = null;
  try { access = (await get(ref(db, `access/${code}/hosts/${uid}`))).val(); } catch { access = store.get(roleKey(code)); }
  if (!access) { location.hash = `#/s/${code}`; return; }
  const body = h('div'); const note = h('div'); const dialog = h('div');
  mount(h('div', { class: 'topbar' }, h('div', {}, h('h1', {}, '主持人'), h('p', { class: 'sub' }, `場次代碼 ${code}`)), connDot()), note, dialog, body);
  let last = null;

  async function go(phase, label) {
    if (!confirm(`切換到「${label}」？\n所有人的畫面會跟著改變。`)) return;
    try { await set(ref(db, `sessions/${code}/meta/phase`), phase); note.replaceChildren(); }
    catch (e) { note.replaceChildren(msg('err', isPermissionDenied(e) ? '沒有權限切換階段：PIN 可能已更換，或場次不是「進行中」。請重新進入。' : `切換失敗：${e.message}`)); }
  }

  // ---- T30：結果階段調整選票 ----
  async function applyAdjust(cat, action, opts) {
    const s = last;
    const votes = (s.votes || {})[cat] || {};
    const plan = L.planBallotAdjust(s.meta.config, s.items || {}, votes, s.meta.phase && s.meta.phase.type, cat, action, { ...opts, by: uid });
    if (!plan.ok) return plan.error;
    const before = votes[opts.voterId];
    const logId = push(ref(db, `sessions/${code}/voteLog`)).key;
    const u = {
      [`votes/${cat}/${opts.voterId}`]: plan.ballot ? { ...plan.ballot, ts: before ? before.ts : serverTimestamp(), editedAt: serverTimestamp() } : null,
      [`voteLog/${logId}`]: { ...plan.log, at: serverTimestamp() },
    };
    try { await update(ref(db, `sessions/${code}`), u); return null; }
    catch (e) { return isPermissionDenied(e) ? '沒有權限：只有在結果階段、而且 PIN 沒有更換時才能調整。' : e.message; }
  }
  function openEditor(cat, voterId) {
    const s = last;
    const cfg = s.meta.config;
    const c = catOf(cfg, cat);
    const items = s.items || {};
    const before = voterId ? ((s.votes || {})[cat] || {})[voterId] : null;
    const list = L.itemsByCategory(items, cfg.categories).find((g) => g.cat === cat).items;
    const max = L.maxVotes(cfg, items, cat);
    const chosen = new Set(L.ballotIds(before));
    const err = h('div');
    const nameIn = h('input', { type: 'text', maxlength: 30, placeholder: '姓名' });
    const groupIn = h('select', {}, h('option', { value: '' }, '請選擇'),
      Array.from({ length: s.meta.groupCount }, (_, i) => h('option', { value: i + 1 }, `第 ${i + 1} 組`)));
    const boxes = list.map((it) => {
      const cb = h('input', { type: 'checkbox', checked: chosen.has(it.id) });
      cb.addEventListener('change', () => {
        if (cb.checked && chosen.size >= max) { cb.checked = false; err.replaceChildren(msg('warn', `最多選 ${max} 題`)); return; }
        if (cb.checked) chosen.add(it.id); else chosen.delete(it.id);
        err.replaceChildren();
      });
      return h('label', { class: 'field pickrow' }, cb, ' ', it.text);
    });
    const save = h('button', { class: 'primary' }, voterId ? '儲存修改' : '代為投票');
    save.onclick = async () => {
      save.disabled = true;
      const ids = list.map((it) => it.id).filter((id) => chosen.has(id));
      const e = voterId
        ? await applyAdjust(cat, 'edit', { voterId, ids })
        : await applyAdjust(cat, 'add', { voterId: `host-${push(ref(db, `sessions/${code}/votes`)).key}`, ids, name: nameIn.value, group: groupIn.value });
      save.disabled = false;
      if (e) { err.replaceChildren(msg('err', e)); return; }
      dialog.replaceChildren();
      note.replaceChildren(msg('ok', voterId ? `已修改「${before.name}」的選票，並留下紀錄。` : '已代為投票，並留下紀錄。'));
    };
    const box = h('div', { class: 'card dialog' },
      h('div', { class: 'row' }, catChip(c), h('h2', { class: 'grow' }, voterId ? `修改「${before.name}（第 ${before.group} 組）」的選票` : '代為投票')),
      voterId ? null : h('div', { class: 'row' }, h('label', { class: 'field grow' }, h('span', {}, '姓名'), nameIn), h('label', { class: 'field' }, h('span', {}, '組別'), groupIn)),
      h('p', { class: 'sub' }, `勾選 1～${max} 題。這次調整會標示「${voterId ? '主持人修改' : '主持人代投'}」，並記錄在 XLSX 的「選票調整紀錄」。`),
      boxes, err,
      h('div', { class: 'row' }, save, h('button', { onclick: () => dialog.replaceChildren() }, '取消')));
    dialog.replaceChildren(box);
    box.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  async function removeBallot(cat, voterId) {
    const b = ((last.votes || {})[cat] || {})[voterId];
    if (!b || !confirm(`刪除「${b.name}（第 ${b.group} 組）」在這一類的選票？\n刪除會留下紀錄，投影畫面的結果會立即更新。`)) return;
    const e = await applyAdjust(cat, 'delete', { voterId });
    note.replaceChildren(e ? msg('err', e) : msg('ok', `已刪除「${b.name}」的選票，並留下紀錄。`));
  }
  function ballotPanel(s) {
    const cfg = s.meta.config;
    const items = s.items || {};
    const textOf = (id) => (items[id] ? items[id].text : '（已刪除）');
    return h('div', { class: 'card' }, h('h2', {}, '調整選票'),
      h('p', { class: 'sub' }, '有人投錯、同一人投了兩次、或有人沒投到時使用（T30）。每次調整都會留紀錄。投錯的人也可以退回投票階段讓本人改票。'),
      cfg.categories.map((c) => {
        const ballots = Object.entries((s.votes || {})[c.key] || {})
          .sort(([, a], [, b]) => (Number(a.group) - Number(b.group)) || String(a.name).localeCompare(String(b.name), 'zh-Hant'));
        const dup = new Set(L.dupNameWarnings(Object.fromEntries(ballots)).flatMap((w) => w.uids));
        return h('div', { class: 'section' },
          h('div', { class: 'row' }, catChip(c), h('strong', { class: 'grow' }, `${ballots.length} 張選票`),
            h('button', { onclick: () => openEditor(c.key, null) }, '＋ 代為投票')),
          ballots.length ? h('table', {},
            h('thead', {}, h('tr', {}, h('th', {}, '姓名'), h('th', { class: 'num' }, '組別'), h('th', {}, '所投題目'), h('th', {}, '備註'), h('th', {}, ''))),
            h('tbody', {}, ballots.map(([vid, b]) => h('tr', { class: dup.has(vid) ? 'dup' : '' },
              h('td', {}, b.name), h('td', { class: 'num' }, b.group),
              h('td', {}, L.ballotIds(b).map(textOf).join('、')),
              h('td', {}, [L.ballotNote(vid, b), dup.has(vid) ? '⚠ 同組同名' : ''].filter(Boolean).join('　')),
              h('td', {}, h('div', { class: 'row' },
                h('button', { onclick: () => openEditor(c.key, vid) }, '修改'),
                h('button', { class: 'danger', onclick: () => removeBallot(c.key, vid) }, '刪除')))))))
            : h('p', { class: 'sub' }, '（沒有選票）'));
      }));
  }

  watchSession(code, (s) => {
    last = s;
    const { meta } = s;
    const items = s.items || {};
    const cfg = meta.config;
    const cats = cfg.categories;
    const idx = meta.phase.index;
    const prev = L.nextPhase(cfg, items, idx, -1);
    const next = L.nextPhase(cfg, items, idx, 1);
    const labelOf = (p) => cfg.phases[p.index].label;
    const byGroup = L.itemsByGroup(items, meta.groupCount);
    const warn = L.dupNameWarnings(s.participants);
    const hasActive = (cat) => Object.values(items).some((it) => it.status === 'active' && it.cat === cat);
    const isResults = meta.phase.type === 'results';
    if (!isResults) dialog.replaceChildren();
    body.replaceChildren(...[
      h('div', { class: 'card' },
        h('h2', {}, meta.title),
        h('ol', { class: 'phases' }, cfg.phases.map((p, i) => h('li', { class: i === idx ? 'cur' : '' },
          p.label,
          p.type === 'vote' && !hasActive(p.category) ? h('span', { class: 'sub' }, '（這一類沒有題目，會跳過）') : null,
          i === idx ? h('strong', {}, '　← 目前') : null))),
        h('div', { class: 'row' },
          h('button', { disabled: !prev, onclick: () => go(prev, labelOf(prev)) }, prev ? `◀ 回到「${labelOf(prev)}」` : '◀ 已是第一個階段'),
          h('button', { class: 'primary', disabled: !next, onclick: () => go(next, labelOf(next)) }, next ? `前往「${labelOf(next)}」 ▶` : '已是最後一個階段')),
        h('p', { class: 'sub' }, '切到投票階段就開始投票，切到下一個階段就結束（T29）。'),
        h('div', { class: 'row' },
          h('button', { onclick: () => window.open(`#/s/${code}/screen`, `screen-${code}`) }, '開啟投影畫面'),
          h('button', { onclick: () => window.open(`#/s/${code}/print`, `print-${code}`) }, '列印題目清單'))),
      warn.length ? msg('warn', `同組同名（可能是同一人重複加入）：${warn.map((w) => `第 ${w.group} 組「${w.name}」×${w.uids.length}`).join('、')}`) : null,
      h('div', { class: 'card' }, h('h2', {}, '投票人數'),
        h('table', {},
          h('thead', {}, h('tr', {}, cats.map((c) => h('th', { class: 'num' }, c.label)))),
          h('tbody', {}, h('tr', {}, cats.map((c) => h('td', { class: 'num' }, L.voterCount((s.votes || {})[c.key])))))),
        h('p', { class: 'sub' }, isResults ? '結果已在投影畫面公布。' : '投票期間只顯示人數，票數到結果階段才在投影畫面公布。')),
      isResults ? ballotPanel(s) : null,
      h('div', { class: 'card' }, h('h2', {}, '匯出'), exportButtons(code, () => s)),
      h('div', { class: 'card' }, h('h2', {}, '各組題數'),
        h('table', {},
          h('thead', {}, h('tr', {}, h('th', {}, '組別'), cats.map((c) => h('th', { class: 'num' }, c.label)), h('th', { class: 'num' }, '合計'))),
          h('tbody', {}, byGroup.map((g) => h('tr', {}, h('td', {}, `第 ${g.group} 組`),
            cats.map((c) => h('td', { class: 'num' }, g.items.filter((it) => it.cat === c.key).length)),
            h('td', { class: 'num' }, g.items.length))))),
        h('p', { class: 'sub' }, '合併後的題目會算在每一個來源組。')),
      h('div', { class: 'card' }, h('h2', {}, '參與者'),
        h('p', {}, `已加入 ${Object.keys(s.participants || {}).length} 人`))].filter(Boolean));
  }, (kind) => sessionError(code, kind));
}

// ---------- 列印題目清單（A9 紙本備案） ----------
function viewPrint(code) {
  const body = h('div', { class: 'print' });
  mount(h('div', { class: 'noprint row' }, h('button', { class: 'primary', onclick: () => window.print() }, '列印'),
    h('span', { class: 'sub' }, '建議用 A4 直式。網路或工具出問題時，各組改用便條紙、投票改用圓點貼。')), body);
  watchSession(code, (s) => {
    const cfg = s.meta.config;
    body.replaceChildren(
      h('h1', {}, s.meta.title), h('p', { class: 'sub' }, `場次代碼 ${code}｜列印時間 ${L.formatTime(Date.now())}`),
      ...L.itemsByCategory(s.items || {}, cfg.categories).map((g) => {
        const c = catOf(cfg, g.cat);
        return h('div', { class: 'print-cat' }, h('h2', {}, `${c.label}（${g.items.length} 題）`),
          h('table', {},
            h('thead', {}, h('tr', {}, h('th', { class: 'num' }, '#'), h('th', {}, '題目'), h('th', {}, '組別'), h('th', {}, '圓點貼'))),
            h('tbody', {}, g.items.map((it, i) => h('tr', {}, h('td', { class: 'num' }, i + 1), h('td', {}, it.text), h('td', {}, L.groupLabel(it.groups)), h('td', { class: 'dots' }, ''))))));
      }));
  }, (kind) => sessionError(code, kind));
}

// ---------- 參與者 ----------
function viewParticipant(code) {
  const role = store.get(roleKey(code));
  if (!role || role.role !== 'participant') { location.hash = `#/s/${code}`; return; }
  const uid = auth.currentUser.uid;
  const body = h('div');
  mount(h('div', { class: 'topbar' }, h('div', {}, h('h1', {}, `${role.name}（第 ${role.group} 組）`)), connDot()), body);
  let picked = null; // 目前勾選（null＝還沒動過，沿用已送出的選票）
  let pickedCat = null;
  let note = null; // 送出結果訊息
  let last = null;

  async function submit(cat, ids) {
    const r = L.validateBallot(last.meta.config, last.items || {}, cat, ids);
    if (!r.ok) { note = msg('err', r.error); paint(); return; }
    try {
      await set(ref(db, `sessions/${code}/votes/${cat}/${uid}`), { name: role.name, group: Number(role.group), ...r.ballot, ts: serverTimestamp() });
      picked = null; note = msg('ok', '已送出！投票期間可以改票，以最後送出的為準。');
    } catch (e) {
      note = msg('err', isPermissionDenied(e) ? '送出失敗：這一段投票已經結束，或還沒開始。' : `送出失敗：${e.message}`);
    }
    paint();
  }

  function paint() {
    if (!last) return;
    const s = last;
    const cfg = s.meta.config;
    const p = s.meta.phase || {};
    if (p.type !== 'vote') {
      picked = null; note = null;
      body.replaceChildren(h('div', { class: 'card' },
        h('h2', {}, s.meta.title),
        h('p', {}, `目前階段：${phaseLabel(s.meta)}`),
        p.type === 'results' ? h('p', { class: 'big-thanks' }, '感謝參與！結果請看投影畫面。') : h('p', {}, '請稍候，投票開始時這個畫面會自動切換。')));
      return;
    }
    const cat = p.category;
    if (pickedCat !== cat) { picked = null; note = null; pickedCat = cat; }
    const c = catOf(cfg, cat);
    const items = s.items || {};
    const list = L.itemsByCategory(items, cfg.categories).find((g) => g.cat === cat).items;
    const mine = s.votes && s.votes[cat] && s.votes[cat][uid];
    const saved = L.ballotIds(mine);
    const sel = picked || saved;
    const max = L.maxVotes(cfg, items, cat);
    const dirty = picked !== null && JSON.stringify(picked) !== JSON.stringify(saved);
    const toggle = (id) => {
      const cur = [...sel];
      const i = cur.indexOf(id);
      if (i >= 0) cur.splice(i, 1); else if (cur.length < max) cur.push(id); else return;
      picked = cur; note = null; paint();
    };
    body.replaceChildren(...[
      h('div', { class: 'card' },
        h('div', { class: 'row' }, catChip(c), h('span', { class: 'sub' }, phaseLabel(s.meta))),
        h('h2', {}, cfg.vote.question || '請選出你最想優先討論的題目'),
        h('p', { class: 'sub' }, `最多選 ${max} 題，不必選滿。已選 ${sel.length} 題。`)),
      h('div', { class: 'vote-list' }, list.map((it) => {
        const on = sel.includes(it.id);
        const full = !on && sel.length >= max;
        return h('button', { class: `vote-item${on ? ' on' : ''}`, disabled: full, style: { borderLeftColor: c.color }, onclick: () => toggle(it.id) },
          h('span', { class: 'box' }, on ? '✓' : ''), h('span', { class: 'grow' }, it.text));
      })),
      note,
      h('div', { class: 'vote-bar' },
        h('span', { class: 'sub grow' }, mine ? (dirty ? '選擇已變更，尚未送出' : '已送出，可以改票') : '還沒送出'),
        h('button', { class: 'primary', disabled: sel.length === 0 || (Boolean(mine) && !dirty), onclick: () => submit(cat, sel) }, mine ? '送出修改' : '送出'))].filter(Boolean));
  }
  watchSession(code, (s) => { last = s; paint(); }, (kind) => sessionError(code, kind));
}

// ---------- 投影畫面 ----------
function qrSvg(text) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ cellSize: 8, margin: 2, scalable: true });
}
/** T6：占比的小數位用淡色（例如 25 .7 %），讓閱讀時著重整數 */
function pctNode(pct) {
  const t = L.pctText(pct);
  const m = /^(\d+)(\.\d)%$/.exec(t);
  return m ? h('span', { class: 'pct' }, m[1], h('span', { class: 'dec' }, m[2]), '%') : h('span', { class: 'pct' }, t);
}
function joinUrl(code) { return `${location.origin}${location.pathname}#/s/${code}`; }

function viewScreen(code) {
  document.body.classList.add('screen');
  let mode = 'auto'; // auto | group | category
  let last = null;
  const title = h('h1', { class: 'scr-title' }); const phase = h('div', { class: 'scr-phase' });
  const btns = { auto: '自動', group: '依組別', category: '依分類' };
  const tools = h('div', { class: 'scr-tools' }, Object.entries(btns).map(([k, v]) =>
    h('button', { 'data-mode': k, onclick: () => { mode = k; paint(); } }, v)));
  const main = h('div'); const foot = h('div', { class: 'scr-foot' });
  mount(h('div', { class: 'scr-head' }, h('div', {}, title, phase), h('div', { class: 'scr-right' }, tools, connDot())), main, foot);
  const qrBox = h('div', { class: 'scr-qr' });
  qrBox.innerHTML = qrSvg(joinUrl(code)); // 只含場次網址，由內嵌套件產生（T26、T27）

  function card(cfg, it, showGroup) {
    const c = catOf(cfg, it.cat);
    return h('div', { class: 'scr-card', style: { borderLeftColor: c ? c.color : '#888' } },
      showGroup ? null : catChip(c), it.text,
      showGroup ? h('span', { class: 'g' }, L.groupLabel(it.groups)) : null);
  }
  function columns(cols) {
    const grid = h('div', { class: 'scr-cols' });
    grid.style.gridTemplateColumns = `repeat(${cols.length}, minmax(0, 1fr))`;
    grid.append(...cols);
    return grid;
  }
  function paint() {
    if (!last) return;
    const { meta } = last;
    const items = last.items || {};
    const votes = last.votes || {};
    const cfg = meta.config;
    const p = meta.phase || {};
    title.textContent = meta.title;
    phase.textContent = phaseLabel(meta);
    tools.hidden = p.type === 'vote' || p.type === 'results';
    const total = Object.values(items).filter((it) => it.status === 'active').length;
    foot.textContent = `場次代碼 ${code}｜共 ${total} 題`;

    if (p.type === 'vote') { // A5：題目＋已投票人數（不顯示票數）＋QR code（T27）
      const c = catOf(cfg, p.category);
      const list = L.itemsByCategory(items, cfg.categories).find((g) => g.cat === p.category).items;
      main.replaceChildren(h('div', { class: 'scr-vote' },
        h('div', {},
          h('h3', { class: 'scr-vote-h', style: { background: c.color, color: c.textColor } }, `${c.label}（${list.length} 題）`),
          h('p', { class: 'scr-question' }, cfg.vote.question || ''),
          h('div', { class: 'scr-vote-items' }, list.map((it) => card(cfg, it, true)))),
        h('div', { class: 'scr-side' },
          h('div', { class: 'scr-count' }, h('span', { class: 'n' }, String(L.voterCount(votes[p.category]))), h('span', {}, '人已投票')),
          qrBox,
          h('div', { class: 'scr-code' }, '掃描加入，或輸入場次代碼'),
          h('div', { class: 'scr-code big' }, code))));
      return;
    }
    if (p.type === 'results') { // R2～R5、T28：兩類各自排名、並排
      main.replaceChildren(columns(cfg.categories.map((c) => {
        const rows = L.tally(items, votes[c.key], c.key, cfg.vote);
        return h('div', { class: 'scr-col' },
          h('h3', { style: { background: c.color, color: c.textColor } }, `${c.label}（${L.voterCount(votes[c.key])} 人投票）`),
          rows.length ? rows.map((r) => h('div', { class: `scr-res${r.priority ? ' pri' : ''}`, style: { borderLeftColor: c.color } },
            h('span', { class: 'rank' }, String(r.rank)),
            h('span', { class: 'txt' }, r.text, h('span', { class: 'g' }, L.groupLabel(r.groups))),
            h('span', { class: 'num' }, pctNode(r.pct), h('small', {}, `（${r.votes} 票）`)),
            r.priority ? h('span', { class: 'pri-tag' }, `★ ${(cfg.labels && cfg.labels.priority) || '優先聚焦'}`) : null))
            : h('div', { class: 'scr-empty' }, '（沒有題目）'));
      })));
      return;
    }
    const eff = mode !== 'auto' ? mode : (p.type === 'merge' ? 'category' : 'group');
    tools.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.mode === mode));
    if (eff === 'group') {
      const groups = L.itemsByGroup(items, meta.groupCount);
      const grid = columns(groups.map((g) => h('div', { class: 'scr-col' }, h('h3', {}, `第 ${g.group} 組`),
        g.items.length ? g.items.map((it) => card(cfg, it, false)) : h('div', { class: 'scr-empty' }, '（尚無題目）'))));
      grid.style.gridTemplateColumns = `repeat(${Math.min(groups.length, 4)}, minmax(0, 1fr))`;
      main.replaceChildren(grid);
    } else {
      main.replaceChildren(columns(L.itemsByCategory(items, cfg.categories).map((g) => {
        const c = catOf(cfg, g.cat);
        return h('div', { class: 'scr-col' }, h('h3', { style: { background: c.color, color: c.textColor } }, `${c.label}（${g.items.length}）`),
          g.items.length ? g.items.map((it) => card(cfg, it, true)) : h('div', { class: 'scr-empty' }, '（尚無題目）'));
      })));
    }
  }
  watchSession(code, (s) => { last = s; paint(); }, (kind) => { document.body.classList.remove('screen'); sessionError(code, kind); });
}

// ---------- 擁有者 ----------
function viewAdmin() {
  const user = auth.currentUser;
  if (!user || user.isAnonymous) {
    const err = h('div');
    return mount(h('h1', {}, '擁有者管理'),
      h('div', { class: 'card' }, h('p', {}, '請用擁有者的 Google 帳號登入。'), err,
        h('button', { class: 'primary big', onclick: () => (USE_EMULATOR
          // 本機 emulator：直接登入 tools/dev.js 建立的測試擁有者（不需要跳出視窗）
          ? signInWithCredential(auth, GoogleAuthProvider.credential(JSON.stringify({ sub: 'owner-google-id', email: 'owner@example.com', email_verified: true })))
          : signInWithPopup(auth, new GoogleAuthProvider())).then(route).catch((e) => err.replaceChildren(msg('err', `登入失敗：${e.message}`))) }, '用 Google 登入')),
      h('p', {}, h('a', { href: '#/' }, '回到首頁')));
  }
  const logout = h('button', { onclick: () => signOut(auth).then(route) }, '登出');
  if (user.uid !== OWNER_UID) {
    return mount(h('h1', {}, '擁有者管理'), msg('err', `這個帳號（${user.email || user.uid}）不是擁有者。`), logout);
  }
  $app.classList.add('wide');
  const list = h('div'); const out = h('div');
  let sessions = {};

  // 新場次
  const nTitle = h('input', { type: 'text', placeholder: '場次標題' });
  const nSource = h('select', {});
  const nGroups = h('input', { type: 'number', min: 1, max: 8, value: 5 });
  const nBtn = h('button', { class: 'primary' }, '建立場次');
  const nRehearsal = h('input', { type: 'checkbox' });
  function fillSources() {
    const cur = nSource.value;
    nSource.replaceChildren(...TEMPLATES.map((t) => h('option', { value: `tpl:${t.id}` }, `模板：${t.id}`)),
      ...Object.entries(sessions).map(([c, s]) => h('option', { value: `ses:${c}` }, `沿用 ${c}「${s.meta && s.meta.title}」的設定`)));
    if (cur) nSource.value = cur;
  }
  async function loadConfig(source) {
    if (source.startsWith('tpl:')) {
      const t = TEMPLATES.find((x) => `tpl:${x.id}` === source);
      const res = await fetch(t.file, { cache: 'no-store' });
      return res.json();
    }
    return structuredClone(sessions[source.slice(4)].meta.config);
  }
  nSource.addEventListener('change', async () => { const c = await loadConfig(nSource.value); nGroups.value = c.groups.count; if (!nTitle.value) nTitle.placeholder = c.title; });
  nBtn.onclick = async () => {
    nBtn.disabled = true;
    try {
      const config = await loadConfig(nSource.value);
      const v = L.validateConfig(config);
      if (!v.ok) throw new Error(v.errors.join('；'));
      const g = L.validateGroupCount(nGroups.value, config, {});
      if (!g.ok) throw new Error(g.error);
      let code;
      do { code = L.generateCode(); } while (sessions[code]);
      config.groups = { ...config.groups, count: Number(nGroups.value) };
      // 彩排示範題目（假資料）
      let items = null;
      const tpl = TEMPLATES.find((t) => t.id === config.templateId);
      if (nRehearsal.checked) {
        if (!tpl || !tpl.rehearsal) throw new Error('這個模板沒有彩排示範題目');
        const list = (await (await fetch(tpl.rehearsal, { cache: 'no-store' })).json()).items;
        items = L.rehearsalItems(list, config, Number(nGroups.value), Date.now());
      }
      await set(ref(db, `sessions/${code}`), { meta: {
        title: nTitle.value.trim() || (nRehearsal.checked ? `彩排：${config.title}` : config.title), visibility: 'private', templateId: config.templateId || 'custom', schemaVersion: L.SCHEMA_VERSION,
        config, phase: L.phaseAt(config, 0), groupCount: Number(nGroups.value), createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
      }, ...(items ? { items } : {}) });
      nTitle.value = ''; nRehearsal.checked = false;
      out.replaceChildren(msg('ok', `已建立場次 ${code}${items ? `（含 ${Object.keys(items).length} 題彩排示範題目）` : ''}。下一步：設定小幫手和主持人 PIN。`));
    } catch (e) { out.replaceChildren(msg('err', `建立失敗：${e.message}`)); } finally { nBtn.disabled = false; }
  };

  // 匯入
  const iFile = h('input', { type: 'file', accept: '.json,application/json' });
  const iBox = h('div');
  iFile.addEventListener('change', async () => {
    iBox.replaceChildren();
    const f = iFile.files[0]; if (!f) return;
    const r = L.fromImportJson(await f.text());
    if (!r.ok) { iBox.replaceChildren(msg('err', `無法匯入：${r.errors.join('；')}`)); return; }
    const orig = r.session.code;
    const keepOk = L.isValidCode(orig);
    const choice = h('select', {},
      keepOk ? h('option', { value: 'keep' }, `沿用原代碼 ${orig}${sessions[orig] ? '（會覆蓋現有場次，先自動匯出備份）' : ''}`) : null,
      h('option', { value: 'new' }, '產生新代碼'));
    const go = h('button', { class: 'primary' }, '匯入');
    go.onclick = async () => {
      let code = choice.value === 'keep' ? orig : null;
      if (!code) do { code = L.generateCode(); } while (sessions[code]);
      if (sessions[code]) {
        if (!confirm(`場次 ${code} 已存在，會先下載它的 JSON 備份，再用匯入的內容覆蓋。確定嗎？`)) return;
        exportSession(code, sessions[code]);
      }
      go.disabled = true;
      try {
        const { code: _c, ...data } = r.session;
        await set(ref(db, `sessions/${code}`), { ...data, meta: { ...data.meta, updatedAt: serverTimestamp() } });
        iBox.replaceChildren(msg('ok', `已匯入為場次 ${code}（可見性：私人）。需要的話請重新設定 PIN。`));
        iFile.value = '';
      } catch (e) { iBox.replaceChildren(msg('err', `匯入失敗：${e.message}`)); go.disabled = false; }
    };
    iBox.replaceChildren(h('p', {}, `檔案內容：「${r.session.meta.title}」，${Object.keys(r.session.items).length} 題。`),
      h('div', { class: 'row' }, choice, go));
  });

  function pinDialog(code) {
    const a = h('input', { type: 'password', inputmode: 'numeric', maxlength: 6, autocomplete: 'new-password', placeholder: '不變更請留白' });
    const b = h('input', { type: 'password', inputmode: 'numeric', maxlength: 6, autocomplete: 'new-password', placeholder: '不變更請留白' });
    const e = h('div');
    const save = h('button', { class: 'primary' }, '儲存 PIN');
    const box = h('div', { class: 'card' }, h('h2', {}, `設定 ${code} 的 PIN`),
      h('label', { class: 'field' }, h('span', {}, '小幫手 PIN（6 位數字）'), a),
      h('label', { class: 'field' }, h('span', {}, '主持人 PIN（6 位數字）'), b), e,
      h('div', { class: 'row' }, save, h('button', { onclick: () => box.remove() }, '取消')),
      h('p', { class: 'sub' }, 'PIN 存好後任何人（包括你）都讀不到；忘記時重新設定即可。換 PIN 後，用舊 PIN 進入的人會失去權限。'));
    save.onclick = async () => {
      const upd = {};
      for (const [k, input] of [['helperPin', a], ['hostPin', b]]) {
        const v = input.value.trim();
        if (!v) continue;
        if (!L.isValidPin(v)) { e.replaceChildren(msg('err', 'PIN 必須是 6 位數字')); return; }
        upd[k] = v;
      }
      if (!Object.keys(upd).length) { e.replaceChildren(msg('err', '請至少輸入一個 PIN')); return; }
      try {
        await update(ref(db, `secrets/${code}`), upd);
        a.value = ''; b.value = '';
        box.remove();
        out.replaceChildren(msg('ok', `已更新 ${code} 的 PIN（${Object.keys(upd).map((k) => (k === 'helperPin' ? '小幫手' : '主持人')).join('、')}）。`));
      } catch (err) { e.replaceChildren(msg('err', `儲存失敗：${err.message}`)); }
    };
    out.replaceChildren(box);
    a.focus();
  }

  // A7：刪除前先自動匯出 JSON，再確認一次
  async function deleteSession(code) {
    const s = sessions[code];
    if (!s) return;
    exportSession(code, s);
    if (!confirm(`已下載場次 ${code}「${s.meta && s.meta.title}」的 JSON 備份。\n\n確定要刪除這個場次嗎？刪除後無法復原，只能用備份檔「匯入 JSON」還原（PIN 要重新設定）。`)) {
      out.replaceChildren(msg('info', `沒有刪除 ${code}（備份檔仍已下載）。`));
      return;
    }
    try {
      await update(ref(db), { [`sessions/${code}`]: null, [`access/${code}`]: null, [`secrets/${code}`]: null });
      out.replaceChildren(msg('ok', `已刪除場次 ${code}。備份檔在你的「下載」資料夾。`));
    } catch (e) { out.replaceChildren(msg('err', `刪除失敗：${e.message}`)); }
  }

  function renderList() {
    const codes = Object.keys(sessions).sort((x, y) => ((sessions[y].meta || {}).createdAt || 0) - ((sessions[x].meta || {}).createdAt || 0));
    fillSources();
    if (!codes.length) { list.replaceChildren(h('p', { class: 'sub' }, '還沒有場次。')); return; }
    list.replaceChildren(h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, '代碼'), h('th', {}, '標題'), h('th', {}, '可見性'), h('th', {}, '組數'),
        h('th', {}, '階段'), h('th', { class: 'num' }, '題數'), h('th', { class: 'num' }, '參與者'), h('th', {}, '操作'))),
      h('tbody', {}, codes.map((code) => {
        const s = sessions[code]; const m = s.meta || {};
        const vis = h('select', {}, [['private', '🔒 私人'], ['live', '🟢 進行中'], ['demo', '👁 展示']].map(([v, t]) => h('option', { value: v }, t)));
        vis.value = m.visibility;
        vis.onchange = () => update(ref(db, `sessions/${code}/meta`), { visibility: vis.value, updatedAt: serverTimestamp() })
          .then(() => out.replaceChildren(msg('ok', `${code} 的可見性已改為「${vis.selectedOptions[0].textContent}」。${vis.value === 'live' ? '請確認已設定 PIN。' : ''}`)))
          .catch((e) => out.replaceChildren(msg('err', `變更失敗：${e.message}`)));
        const gc = h('input', { type: 'number', min: 1, max: 8, value: m.groupCount, style: { width: '64px' } });
        gc.onchange = () => {
          const v = L.validateGroupCount(gc.value, m.config, s);
          if (!v.ok) { out.replaceChildren(msg('err', `${code}：${v.error}`)); gc.value = m.groupCount; return; }
          update(ref(db, `sessions/${code}/meta`), { groupCount: Number(gc.value), updatedAt: serverTimestamp() })
            .catch((e) => out.replaceChildren(msg('err', `變更失敗：${e.message}`)));
        };
        const active = Object.values(s.items || {}).filter((it) => it.status === 'active').length;
        return h('tr', {},
          h('td', {}, h('code', {}, code)), h('td', {}, m.title), h('td', {}, vis), h('td', {}, gc),
          h('td', {}, phaseLabel(m)), h('td', { class: 'num' }, active), h('td', { class: 'num' }, Object.keys(s.participants || {}).length),
          h('td', {}, h('div', { class: 'row' },
            h('button', { onclick: () => pinDialog(code) }, '設定 PIN'),
            exportButtons(code, () => s),
            h('a', { href: `#/s/${code}`, target: '_blank' }, '開啟'),
            h('a', { href: `#/s/${code}/screen`, target: '_blank' }, '投影'),
            h('a', { href: `#/s/${code}/print`, target: '_blank' }, '列印'),
            h('button', { class: 'danger', onclick: () => deleteSession(code) }, '刪除'))));
      }))));
  }

  mount(
    h('div', { class: 'topbar' }, h('div', {}, h('h1', {}, '擁有者管理'), h('p', { class: 'sub' }, user.email || '')), h('div', { class: 'row' }, connDot(), logout)),
    USE_EMULATOR ? msg('warn', '本機預覽模式（emulator）：這裡的資料不是正式資料。') : null,
    out,
    h('div', { class: 'card' }, h('h2', {}, '場次'), list),
    h('div', { class: 'card' }, h('h2', {}, '新場次'),
      h('label', { class: 'field' }, h('span', {}, '標題'), nTitle),
      h('label', { class: 'field' }, h('span', {}, '設定來源'), nSource),
      h('label', { class: 'field' }, h('span', {}, '組數（1～8）'), nGroups),
      h('label', { class: 'field' }, nRehearsal, ' 加入彩排示範題目（每組 2 題，假資料，方便彩排）'), nBtn),
    h('div', { class: 'card' }, h('h2', {}, '匯入 JSON'), h('p', { class: 'sub' }, '匯入後可見性一律是「私人」；PIN 不會匯出，需要的話重新設定。'), iFile, iBox));

  const unsub = onValue(ref(db, 'sessions'), (s) => { sessions = s.val() || {}; renderList(); },
    (e) => list.replaceChildren(msg('err', `讀取失敗：${e.message}`)));
  addCleanup(unsub);
}
