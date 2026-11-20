// logic.js — 業務規則（純函式）。不碰 DOM、不碰 Firebase，可以在 Node 單獨測試。
// 規則編號見 docs/spec.md B1（T1～T22、R1～R6）與 B6。

export const TOOL = 'concern-board';
export const SCHEMA_VERSION = 1;
export const MAX_GROUPS = 8;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 去掉容易混淆的 I、O、0、1

// ---------- 小工具 ----------
const entries = (obj) => Object.entries(obj || {});
const groupKeys = (item) => Object.keys((item && item.groups) || {}).map(Number).filter((n) => n > 0).sort((a, b) => a - b);
const isActive = (item) => item && item.status === 'active';

/** 組別顯示文字：{1:true,3:true} → 「第 1、3 組」 */
export function groupLabel(groups) {
  const keys = groupKeys({ groups });
  return keys.length ? `第 ${keys.join('、')} 組` : '';
}

// ---------- T18：題目文字 ----------
/** 去除前後空白後檢查必填與長度上限。 */
export function normalizeItemText(text, maxLength = 150) {
  const value = String(text ?? '').trim();
  if (!value) return { ok: false, value, error: '題目必填' };
  if ([...value].length > maxLength) return { ok: false, value, error: `題目上限 ${maxLength} 字` };
  return { ok: true, value, error: null };
}

// ---------- T19：PIN ----------
export function isValidPin(pin) {
  return /^\d{6}$/.test(String(pin ?? ''));
}

// ---------- 場次代碼 ----------
/** 產生 6 碼場次代碼；random 預設用 Math.random，測試時可以注入。 */
export function generateCode(random = Math.random) {
  let s = '';
  for (let i = 0; i < 6; i++) s += CODE_CHARS[Math.floor(random() * CODE_CHARS.length)];
  return s;
}
export function isValidCode(code) {
  return new RegExp(`^[${CODE_CHARS}]{6}$`).test(String(code ?? ''));
}

// ---------- T3：投票者姓名 ----------
export function normalizeName(name) {
  return String(name ?? '').trim();
}
/** 同組同名（不分大小寫、去除前後空白）且不是自己時，回傳 true。 */
export function isDuplicateName(participants, name, group, selfUid) {
  const n = normalizeName(name).toLowerCase();
  return entries(participants).some(([uid, p]) =>
    uid !== selfUid && Number(p.group) === Number(group) && normalizeName(p.name).toLowerCase() === n);
}
/** 同組又同名的清單：[{ group, name, uids: [...] }] */
export function dupNameWarnings(participants) {
  const map = new Map();
  for (const [uid, p] of entries(participants)) {
    const key = `${Number(p.group)}|${normalizeName(p.name).toLowerCase()}`;
    if (!map.has(key)) map.set(key, { group: Number(p.group), name: normalizeName(p.name), uids: [] });
    map.get(key).uids.push(uid);
  }
  return [...map.values()].filter((w) => w.uids.length > 1)
    .sort((a, b) => a.group - b.group || a.name.localeCompare(b.name, 'zh-Hant'));
}

// ---------- T2、T8：誰能編輯哪一題 ----------
/**
 * 小幫手能不能編輯（新增、修改、刪除）這一題。
 * 收集階段只能編輯本組（新題目也必須屬於本組）；合併階段可以編輯所有組；其他階段（含投票）一律不行。
 */
export function canHelperEdit(phaseType, helperGroup, item) {
  if (phaseType === 'merge') return true;
  if (phaseType !== 'collect') return false;
  if (!item) return true; // 新增本組的題目
  return Boolean(item.groups && item.groups[String(helperGroup)]);
}

// ---------- T10：組數 ----------
/** 已使用的最大組號（題目、參與者、選票都算）；沒有時是 0。 */
export function maxUsedGroup(session) {
  let max = 0;
  for (const [, item] of entries(session && session.items)) for (const g of groupKeys(item)) max = Math.max(max, g);
  for (const [, p] of entries(session && session.participants)) max = Math.max(max, Number(p.group) || 0);
  for (const [, byUid] of entries(session && session.votes)) for (const [, v] of entries(byUid)) max = Math.max(max, Number(v.group) || 0);
  return max;
}
/** 組數是否可以設定：1～max（最多 8），且不小於已使用的最大組號。 */
export function validateGroupCount(count, config, session) {
  const n = Number(count);
  const max = Math.min(MAX_GROUPS, Number(config && config.groups && config.groups.max) || MAX_GROUPS);
  if (!Number.isInteger(n) || n < 1 || n > max) return { ok: false, error: `組數必須是 1～${max}` };
  const used = maxUsedGroup(session);
  if (n < used) return { ok: false, error: `已經用到第 ${used} 組，組數不能小於 ${used}` };
  return { ok: true, error: null };
}

// ---------- R1 ----------
export function maxVotes(config, items, cat) {
  const n = entries(items).filter(([, it]) => isActive(it) && it.cat === cat).length;
  return Math.min(Number(config.vote.maxPerVoter), n);
}

// ---------- R3 ----------
/** competition ranking：同票同名次，下一名跳號。回傳和輸入同順序的名次。 */
export function rankCompetition(counts) {
  return counts.map((c) => 1 + counts.filter((x) => x > c).length);
}

// ---------- R2～R4 ----------
/**
 * 計票。只計算該類 active 的項目；指向非 active（或別類）項目的票忽略。
 * votes：{ uid: { v1, v2, v3, ... } }（該類的選票）
 * 回傳依票數由高到低、同票依文字排序。
 */
export function tally(items, votes, cat, voteCfg = {}) {
  const topN = voteCfg.priorityTopN ?? 3;
  const minVotes = voteCfg.priorityMinVotes ?? 1;
  const list = entries(items).filter(([, it]) => isActive(it) && it.cat === cat)
    .map(([id, it]) => ({ id, text: it.text, groups: it.groups || {}, votes: 0 }));
  const byId = new Map(list.map((r) => [r.id, r]));
  for (const [, ballot] of entries(votes)) {
    const picked = new Set();
    for (const k of ['v1', 'v2', 'v3']) {
      const id = ballot && ballot[k];
      if (!id || picked.has(id)) continue; // 一題最多一票
      picked.add(id);
      const row = byId.get(id);
      if (row) row.votes += 1;
    }
  }
  list.sort((a, b) => b.votes - a.votes || String(a.text).localeCompare(String(b.text), 'zh-Hant'));
  const total = list.reduce((s, r) => s + r.votes, 0);
  const ranks = rankCompetition(list.map((r) => r.votes));
  return list.map((r, i) => ({
    ...r,
    pct: total === 0 ? null : Math.round((r.votes / total) * 100),
    rank: ranks[i],
    priority: ranks[i] <= topN && r.votes >= minVotes,
  }));
}

// ---------- R6：合併、拆回 ----------
/**
 * 合併 2 題以上的 active 項目成為一個新項目。
 * 回傳 { id, item, updates }：updates 是要寫入 items/ 的變更（新項目＋來源改為 merged）。
 * opts：{ newId, uid, now }（id 與時間由呼叫端提供，保持純函式）。
 */
export function mergeItems(items, ids, text, opts = {}) {
  const uniq = [...new Set(ids)];
  if (uniq.length < 2) throw new Error('至少要選 2 題才能合併');
  const sources = uniq.map((id) => {
    const it = items[id];
    if (!isActive(it)) throw new Error(`題目 ${id} 不存在或已經被合併`);
    return [id, it];
  });
  const cat = sources[0][1].cat;
  if (sources.some(([, it]) => it.cat !== cat)) throw new Error('不同分類的題目不能合併');
  const t = normalizeItemText(text, opts.maxLength);
  if (!t.ok) throw new Error(t.error);
  const id = opts.newId;
  if (!id) throw new Error('缺少新項目的 id');
  const groups = {};
  for (const [, it] of sources) for (const g of groupKeys(it)) groups[String(g)] = true;
  const now = opts.now ?? null;
  const item = {
    text: t.value,
    cat,
    groups,
    rewritten: sources.some(([, it]) => it.rewritten) || !sources.some(([, it]) => it.text === t.value),
    status: 'active',
    sources: Object.fromEntries(uniq.map((s) => [s, true])),
    createdBy: opts.uid ?? null,
    createdGroup: opts.group ?? null,
    createdAt: now, updatedAt: now, updatedBy: opts.uid ?? null,
  };
  const updates = { [id]: item };
  for (const [sid, it] of sources) updates[sid] = { ...it, status: 'merged', mergedInto: id, updatedAt: now, updatedBy: opts.uid ?? null };
  return { id, item, updates };
}

/** 拆回一層：來源恢復 active、移除 mergedInto；刪除合併後的項目。回傳 updates（被刪的值為 null）。 */
export function unmerge(items, id, opts = {}) {
  const merged = items[id];
  if (!merged || !merged.sources) throw new Error('這一題不是合併產生的');
  const now = opts.now ?? null;
  const updates = { [id]: null };
  for (const sid of Object.keys(merged.sources)) {
    const src = items[sid];
    if (!src) continue;
    const { mergedInto, ...rest } = src;
    updates[sid] = { ...rest, status: 'active', updatedAt: now, updatedBy: opts.uid ?? null };
  }
  return updates;
}

// ---------- B4：設定檔驗證 ----------
export function validateConfig(cfg) {
  const errors = [];
  if (!cfg || typeof cfg !== 'object') return { ok: false, errors: ['設定檔不是物件'] };
  const cats = Array.isArray(cfg.categories) ? cfg.categories : null;
  if (!cats || cats.length === 0) errors.push('categories 至少要有 1 個分類');
  const keys = new Set();
  for (const c of cats || []) {
    if (!c || typeof c.key !== 'string' || !c.key) { errors.push('每個分類都要有 key'); continue; }
    if (keys.has(c.key)) errors.push(`分類 key 重複：${c.key}`);
    keys.add(c.key);
    if (!c.label) errors.push(`分類 ${c.key} 缺少 label`);
  }
  const g = cfg.groups || {};
  const max = Number(g.max);
  const count = Number(g.count);
  if (!Number.isInteger(max) || max < 1 || max > MAX_GROUPS) errors.push(`groups.max 必須是 1～${MAX_GROUPS}`);
  if (!Number.isInteger(count) || count < 1 || (Number.isInteger(max) && count > max)) errors.push('groups.count 必須介於 1～groups.max');
  const phases = Array.isArray(cfg.phases) ? cfg.phases : null;
  if (!phases || phases.length === 0) errors.push('phases 至少要有 1 個階段');
  const types = ['collect', 'merge', 'share', 'vote', 'results'];
  (phases || []).forEach((p, i) => {
    if (!p || !types.includes(p.type)) errors.push(`第 ${i + 1} 個階段的 type 不正確`);
    else if (p.type === 'vote' && !keys.has(p.category)) errors.push(`第 ${i + 1} 個階段的 category 不存在：${p.category}`);
    else if (p.category !== undefined && p.type !== 'vote' && !keys.has(p.category)) errors.push(`第 ${i + 1} 個階段的 category 不存在：${p.category}`);
  });
  const mpv = Number(cfg.vote && cfg.vote.maxPerVoter);
  if (!Number.isInteger(mpv) || mpv < 1 || mpv > 10) errors.push('vote.maxPerVoter 必須是 1～10');
  return { ok: errors.length === 0, errors };
}

// ---------- 階段 ----------
/** 從設定檔的第 index 個階段組成 meta.phase。 */
export function phaseAt(config, index) {
  const p = config.phases[index];
  if (!p) return null;
  const phase = { index, type: p.type };
  if (p.category !== undefined) phase.category = p.category;
  return phase;
}
/**
 * 下一個（dir=1）或上一個（dir=-1）階段。某一類沒有 active 題目時，跳過該類的投票階段。
 * 已經到頭時回傳 null。
 */
export function nextPhase(config, items, index, dir = 1) {
  const hasActive = (cat) => entries(items).some(([, it]) => isActive(it) && it.cat === cat);
  for (let i = index + dir; i >= 0 && i < config.phases.length; i += dir) {
    const p = config.phases[i];
    if (p.type === 'vote' && !hasActive(p.category)) continue;
    return phaseAt(config, i);
  }
  return null;
}

// ---------- B7：JSON 匯出、匯入 ----------
/** session：{ code, meta, items, votes, participants }。只輸出這五項，不含 access、secrets。 */
export function toExportJson(session, exportedAt = Date.now()) {
  return {
    tool: TOOL,
    schemaVersion: SCHEMA_VERSION,
    exportedAt,
    session: {
      code: session.code,
      meta: session.meta || {},
      items: session.items || {},
      votes: session.votes || {},
      participants: session.participants || {},
    },
  };
}

/** 舊版資料轉成目前版本（v1 還不需要轉換）。 */
export function migrate(json) {
  return json;
}

/**
 * 解析並驗證匯入的 JSON（字串或物件）。
 * 回傳 { ok, errors, session }；session.meta.visibility 一律設成 private。
 */
export function fromImportJson(input) {
  let json = input;
  if (typeof input === 'string') {
    try { json = JSON.parse(input); } catch { return { ok: false, errors: ['檔案不是有效的 JSON'], session: null }; }
  }
  const errors = [];
  if (!json || json.tool !== TOOL) errors.push('這不是關注點共編投票工具匯出的檔案');
  const ver = Number(json && json.schemaVersion);
  if (!Number.isInteger(ver) || ver < 1) errors.push('缺少 schemaVersion');
  else if (ver > SCHEMA_VERSION) errors.push(`檔案版本（${ver}）比程式新（${SCHEMA_VERSION}），請先更新程式`);
  if (errors.length) return { ok: false, errors, session: null };
  json = migrate(json);
  const s = json.session;
  if (!s || !s.meta) return { ok: false, errors: ['缺少 session 或 meta'], session: null };
  const cfgCheck = validateConfig(s.meta.config);
  if (!cfgCheck.ok) return { ok: false, errors: cfgCheck.errors.map((e) => `設定檔：${e}`), session: null };
  const session = {
    code: s.code,
    meta: { ...s.meta, visibility: 'private' },
    items: s.items || {},
    votes: s.votes || {},
    participants: s.participants || {},
  };
  return { ok: true, errors: [], session };
}

/** 匯出檔名：{title}_{code}_{yyyymmdd}.{ext} */
export function exportFileName(title, code, date, ext) {
  const d = new Date(date);
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const safe = String(title || 'session').replace(/[\\/:*?"<>|]/g, '_');
  return `${safe}_${code}_${ymd}.${ext}`;
}

// ---------- 畫面分組（投影） ----------
/** 依組別分組 active 項目：[{ group, items: [{id,...}] }]，跨組的合併題目會出現在每個來源組。 */
export function itemsByGroup(items, groupCount) {
  const out = [];
  for (let g = 1; g <= groupCount; g++) {
    out.push({ group: g, items: entries(items).filter(([, it]) => isActive(it) && it.groups && it.groups[String(g)])
      .map(([id, it]) => ({ id, ...it })).sort(byCreated) });
  }
  return out;
}
/** 依分類分組 active 項目：[{ cat, items }]，順序同設定檔。 */
export function itemsByCategory(items, categories) {
  return categories.map((c) => ({
    cat: c.key,
    items: entries(items).filter(([, it]) => isActive(it) && it.cat === c.key)
      .map(([id, it]) => ({ id, ...it })).sort(byCreated),
  }));
}
function byCreated(a, b) {
  return (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0) || String(a.id).localeCompare(String(b.id));
}
