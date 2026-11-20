// app.js — 畫面、Firebase 讀寫、即時存檔、匯出入。業務規則一律呼叫 logic.js。
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import {
  getAuth, onAuthStateChanged, signInAnonymously, GoogleAuthProvider, signInWithPopup, signInWithCredential, signOut, connectAuthEmulator,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';
import {
  getDatabase, ref, onValue, get, set, update, push, serverTimestamp, connectDatabaseEmulator,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js';
import * as L from './logic.js';

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
const TEMPLATES = [{ id: 'prmc-workshop', file: 'config/templates/prmc-workshop.json' }];

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
async function viewHelper(code) {
  const uid = auth.currentUser.uid;
  const role = store.get(roleKey(code));
  mount(h('p', { class: 'sub' }, '讀取中…'));
  // 確認 access 還在（換過 PIN 或換了瀏覽器就要重新輸入）
  let access = null;
  try { access = (await get(ref(db, `access/${code}/helpers/${uid}`))).val(); } catch { /* 離線時沿用本機紀錄 */ access = role && role.role === 'helper' ? { group: role.group } : null; }
  if (!access) { location.hash = `#/s/${code}`; return; }
  const group = Number(access.group);

  const pending = store.get(pendingKey(code)) || {}; // { id: { text, cat, rewritten, isNew } }
  const savePending = () => store.set(pendingKey(code), pending);
  const rows = new Map(); // id → { el, update(item, meta) }
  const timers = new Map();
  let session = null;

  const title = h('h1'); const sub = h('p', { class: 'sub' }); const banner = h('div');
  const mineBox = h('div'); const othersBox = h('div', { class: 'readonly' });
  const addBtn = h('button', { class: 'primary' }, '＋ 新增一題');
  mount(h('div', { class: 'topbar' }, h('div', {}, title, sub), connDot()), banner,
    h('div', { class: 'row' }, h('h2', { class: 'grow' }, `第 ${group} 組的題目`), addBtn), mineBox,
    h('details', { class: 'card' }, h('summary', {}, '其他組的題目（唯讀）'), othersBox));

  function writeItem(id) {
    const d = pending[id];
    if (!d || !session) return;
    const row = rows.get(id);
    const cfg = session.meta.config;
    const t = L.normalizeItemText(d.text, cfg.itemFields && cfg.itemFields.maxLength);
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
      rows.get(id) && rows.get(id).state('err', isPermissionDenied(e) ? '沒有權限：可能階段已切換或 PIN 已更換' : `儲存失敗：${e.message}`);
      if (isPermissionDenied(e)) { delete pending[id]; savePending(); }
    });
  }
  function schedule(id) {
    clearTimeout(timers.get(id));
    timers.set(id, setTimeout(() => writeItem(id), 500)); // T15：停止輸入 0.5 秒自動寫入
  }
  addCleanup(() => timers.forEach((t) => clearTimeout(t)));

  function makeRow(id, editable) {
    const cfg = session.meta.config;
    const maxLen = (cfg.itemFields && cfg.itemFields.maxLength) || 150;
    const ta = h('textarea', { maxlength: maxLen, placeholder: `輸入${(cfg.labels && cfg.labels.item) || '題目'}（必填，上限 ${maxLen} 字）` });
    const counter = h('span', { class: 'sub' });
    const stateEl = h('span', { class: 'state' });
    const name = `cat-${id}`;
    const radios = cfg.categories.map((c) => {
      const r = h('input', { type: 'radio', name, value: c.key });
      return { c, r, label: h('label', { style: { borderColor: c.color } }, r, c.label) };
    });
    const rw = h('input', { type: 'checkbox' });
    const delBtn = h('button', { class: 'danger' }, '刪除');
    const groupsEl = h('span', { class: 'sub' });
    const el = h('div', { class: 'item' }, ta,
      h('div', { class: 'meta' },
        h('span', { class: 'catpick row' }, radios.map((x) => x.label)),
        cfg.itemFields && cfg.itemFields.rewritten ? h('label', {}, rw, ' 已改寫') : null,
        groupsEl, counter, stateEl, delBtn));
    const local = () => pending[id] || (pending[id] = { ...pick(session.items && session.items[id]) });
    const changed = () => { savePending(); counter.textContent = `${[...ta.value].length}/${maxLen}`; schedule(id); paintCat(); };
    ta.addEventListener('input', () => { local().text = ta.value; changed(); });
    radios.forEach(({ c, r }) => r.addEventListener('change', () => { local().cat = c.key; changed(); }));
    rw.addEventListener('change', () => { local().rewritten = rw.checked; changed(); });
    delBtn.addEventListener('click', async () => {
      const item = session.items && session.items[id];
      if (!item) { delete pending[id]; savePending(); el.remove(); rows.delete(id); return; }
      if (item.sources) { alert('合併後的題目要在合併階段處理（v0.2）。'); return; }
      if (!confirm(`確定刪除這一題？\n\n${item.text}`)) return;
      delete pending[id]; savePending(); clearTimeout(timers.get(id));
      set(ref(db, `sessions/${code}/items/${id}`), null)
        .catch((e) => alert(isPermissionDenied(e) ? '沒有權限刪除這一題' : `刪除失敗：${e.message}`));
    });
    function paintCat() {
      const cur = (pending[id] && pending[id].cat) || (session.items && session.items[id] && session.items[id].cat);
      const c = cur && catOf(cfg, cur);
      el.style.borderLeftColor = c ? c.color : 'var(--line)';
    }
    const row = {
      el,
      state(kind, text) { stateEl.className = `state ${kind}`; stateEl.textContent = text; },
      update(item, canEdit) {
        const d = pending[id];
        const v = d || pick(item);
        if (document.activeElement !== ta && ta.value !== (v.text || '')) ta.value = v.text || '';
        radios.forEach(({ c, r }) => { r.checked = v.cat === c.key; r.disabled = !canEdit; });
        rw.checked = Boolean(v.rewritten); rw.disabled = !canEdit;
        ta.readOnly = !canEdit; delBtn.hidden = !canEdit;
        groupsEl.textContent = item ? L.groupLabel(item.groups) : L.groupLabel({ [group]: true });
        counter.textContent = `${[...ta.value].length}/${maxLen}`;
        paintCat();
      },
      focus() { ta.focus(); },
    };
    row.update(session.items && session.items[id], editable);
    return row;
  }
  const pick = (it) => (it ? { text: it.text, cat: it.cat, rewritten: Boolean(it.rewritten) } : { text: '', cat: '', rewritten: false });

  addBtn.addEventListener('click', () => {
    const id = push(ref(db, `sessions/${code}/items`)).key;
    pending[id] = { text: '', cat: '', rewritten: false, isNew: true };
    savePending();
    render();
    const r = rows.get(id); if (r) { r.focus(); r.state('', '輸入後自動儲存'); }
  });

  function render() {
    if (!session) return;
    const { meta } = session;
    const items = session.items || {};
    const type = meta.phase && meta.phase.type;
    title.textContent = meta.title;
    sub.textContent = `第 ${group} 組小幫手｜${phaseLabel(meta)}`;
    const editableNow = type === 'collect' || type === 'merge';
    banner.replaceChildren(...[
      editableNow ? null : msg('info', '目前階段不能編輯題目。'),
      type === 'merge' ? msg('info', '合併階段可以修改所有組的題目；合併、拆回功能在 v0.2 加入。') : null,
      meta.visibility !== 'live' ? msg('warn', '場次目前不是「進行中」，無法寫入。') : null].filter(Boolean));
    addBtn.hidden = !L.canHelperEdit(type, group, null) || type === 'merge';

    // 我的（收集）或全部（合併）＋本機還沒送出的新題
    const mineIds = Object.keys(items).filter((id) => items[id].status === 'active'
      && (type === 'merge' || (items[id].groups && items[id].groups[String(group)])));
    for (const id of Object.keys(pending)) if (!items[id] && pending[id].isNew && !mineIds.includes(id)) mineIds.push(id);
    mineIds.sort((a, b) => ((items[a] && items[a].createdAt) || Infinity) - ((items[b] && items[b].createdAt) || Infinity) || a.localeCompare(b));
    const keep = new Set(mineIds);
    for (const [id, r] of rows) if (!keep.has(id)) { r.el.remove(); rows.delete(id); }
    for (const id of mineIds) {
      const canEdit = meta.visibility === 'live' && L.canHelperEdit(type, group, items[id] || null);
      let r = rows.get(id);
      if (!r) { r = makeRow(id, canEdit); rows.set(id, r); } else r.update(items[id], canEdit);
      mineBox.append(r.el); // 依序排列
    }
    if (!mineIds.length) mineBox.replaceChildren(h('p', { class: 'sub' }, '還沒有題目，按「新增一題」開始。'));
    else [...mineBox.children].forEach((c) => { if (!c.classList.contains('item')) c.remove(); });

    // 其他組（唯讀）
    const others = L.itemsByGroup(items, meta.groupCount).filter((g) => g.group !== group);
    othersBox.replaceChildren(...others.map((g) => h('div', {}, h('h2', {}, `第 ${g.group} 組`),
      g.items.length ? g.items.map((it) => h('div', { class: 'item', style: { borderLeftColor: (catOf(meta.config, it.cat) || {}).color } },
        it.text, h('div', { class: 'meta' }, catChip(catOf(meta.config, it.cat)), it.rewritten ? h('span', { class: 'sub' }, '已改寫') : null)))
        : h('p', { class: 'sub' }, '（無）'))));
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
  const body = h('div');
  mount(h('div', { class: 'topbar' }, h('div', {}, h('h1', {}, '主持人'), h('p', { class: 'sub' }, `場次代碼 ${code}`)), connDot()), body);
  watchSession(code, (s) => {
    const { meta } = s;
    const items = s.items || {};
    const cats = meta.config.categories;
    const byGroup = L.itemsByGroup(items, meta.groupCount);
    const warn = L.dupNameWarnings(s.participants);
    body.replaceChildren(
      h('div', { class: 'card' },
        h('h2', {}, meta.title),
        h('p', {}, `目前階段：${phaseLabel(meta)}（第 ${meta.phase.index + 1}／${meta.config.phases.length} 階段）`),
        h('div', { class: 'row' },
          h('button', { class: 'primary', onclick: () => window.open(`#/s/${code}/screen`, `screen-${code}`) }, '開啟投影畫面')),
        h('p', { class: 'sub' }, '切換階段、開關投票的功能在 v0.2、v0.3 加入。')),
      h('div', { class: 'card' }, h('h2', {}, '各組題數'),
        h('table', {},
          h('thead', {}, h('tr', {}, h('th', {}, '組別'), cats.map((c) => h('th', { class: 'num' }, c.label)), h('th', { class: 'num' }, '合計'))),
          h('tbody', {}, byGroup.map((g) => h('tr', {}, h('td', {}, `第 ${g.group} 組`),
            cats.map((c) => h('td', { class: 'num' }, g.items.filter((it) => it.cat === c.key).length)),
            h('td', { class: 'num' }, g.items.length)))))),
      h('div', { class: 'card' }, h('h2', {}, '參與者'),
        h('p', {}, `已加入 ${Object.keys(s.participants || {}).length} 人`),
        warn.length ? msg('warn', `同組同名：${warn.map((w) => `第 ${w.group} 組「${w.name}」×${w.uids.length}`).join('、')}`) : null));
  }, (kind) => sessionError(code, kind));
}

// ---------- 參與者 ----------
function viewParticipant(code) {
  const role = store.get(roleKey(code));
  if (!role || role.role !== 'participant') { location.hash = `#/s/${code}`; return; }
  const body = h('div');
  mount(h('div', { class: 'topbar' }, h('div', {}, h('h1', {}, `${role.name}（第 ${role.group} 組）`)), connDot()), body);
  watchSession(code, (s) => {
    const type = s.meta.phase && s.meta.phase.type;
    body.replaceChildren(h('div', { class: 'card' },
      h('h2', {}, s.meta.title),
      h('p', {}, `目前階段：${phaseLabel(s.meta)}`),
      type === 'results' ? h('p', {}, '感謝參與！') : h('p', {}, '請稍候，投票開始時這個畫面會自動切換。'),
      type === 'vote' ? msg('info', '投票功能在 v0.3 加入。') : null));
  }, (kind) => sessionError(code, kind));
}

// ---------- 投影畫面 ----------
function viewScreen(code) {
  document.body.classList.add('screen');
  let mode = 'auto'; // auto | group | category
  let last = null;
  const title = h('h1', { class: 'scr-title' }); const phase = h('div', { class: 'scr-phase' });
  const btns = { auto: '自動', group: '依組別', category: '依分類' };
  const tools = h('div', { class: 'scr-tools' }, Object.entries(btns).map(([k, v]) =>
    h('button', { 'data-mode': k, onclick: () => { mode = k; paint(); } }, v)));
  const cols = h('div', { class: 'scr-cols' }); const foot = h('div', { class: 'scr-foot' });
  mount(h('div', { class: 'scr-head' }, h('div', {}, title, phase), tools), cols, foot);

  function card(cfg, it, showGroup) {
    const c = catOf(cfg, it.cat);
    return h('div', { class: 'scr-card', style: { borderLeftColor: c ? c.color : '#888' } },
      showGroup ? null : catChip(c), it.text,
      showGroup ? h('span', { class: 'g' }, L.groupLabel(it.groups)) : null);
  }
  function paint() {
    if (!last) return;
    const { meta } = last;
    const items = last.items || {};
    const cfg = meta.config;
    const type = meta.phase && meta.phase.type;
    const eff = mode !== 'auto' ? mode : (type === 'merge' ? 'category' : 'group');
    tools.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.mode === mode));
    title.textContent = meta.title;
    phase.textContent = phaseLabel(meta);
    if (eff === 'group') {
      const groups = L.itemsByGroup(items, meta.groupCount);
      cols.style.gridTemplateColumns = `repeat(${Math.min(groups.length, 4)}, minmax(0, 1fr))`;
      cols.replaceChildren(...groups.map((g) => h('div', { class: 'scr-col' }, h('h3', {}, `第 ${g.group} 組`),
        g.items.length ? g.items.map((it) => card(cfg, it, false)) : h('div', { class: 'scr-empty' }, '（尚無題目）'))));
    } else {
      const byCat = L.itemsByCategory(items, cfg.categories);
      cols.style.gridTemplateColumns = `repeat(${byCat.length}, minmax(0, 1fr))`;
      cols.replaceChildren(...byCat.map((g) => {
        const c = catOf(cfg, g.cat);
        return h('div', { class: 'scr-col' }, h('h3', { style: { background: c.color, color: c.textColor } }, `${c.label}（${g.items.length}）`),
          g.items.length ? g.items.map((it) => card(cfg, it, true)) : h('div', { class: 'scr-empty' }, '（尚無題目）'));
      }));
    }
    const total = Object.values(items).filter((it) => it.status === 'active').length;
    foot.textContent = `場次代碼 ${code}｜共 ${total} 題`;
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
      await set(ref(db, `sessions/${code}`), { meta: {
        title: nTitle.value.trim() || config.title, visibility: 'private', templateId: config.templateId || 'custom', schemaVersion: L.SCHEMA_VERSION,
        config, phase: L.phaseAt(config, 0), groupCount: Number(nGroups.value), createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
      } });
      nTitle.value = '';
      out.replaceChildren(msg('ok', `已建立場次 ${code}。下一步：設定小幫手和主持人 PIN。`));
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
            h('button', { onclick: () => exportSession(code, s) }, '匯出 JSON'),
            h('a', { href: `#/s/${code}`, target: '_blank' }, '開啟'),
            h('a', { href: `#/s/${code}/screen`, target: '_blank' }, '投影'))));
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
      h('label', { class: 'field' }, h('span', {}, '組數（1～8）'), nGroups), nBtn),
    h('div', { class: 'card' }, h('h2', {}, '匯入 JSON'), h('p', { class: 'sub' }, '匯入後可見性一律是「私人」；PIN 不會匯出，需要的話重新設定。'), iFile, iBox));

  const unsub = onValue(ref(db, 'sessions'), (s) => { sessions = s.val() || {}; renderList(); },
    (e) => list.replaceChildren(msg('err', `讀取失敗：${e.message}`)));
  addCleanup(unsub);
}
