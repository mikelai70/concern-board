// Golden test（docs/spec.md B8 的 G1～G9），另加幾個 v0.1 用到的輔助規則。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  tally, rankCompetition, maxVotes, mergeItems, unmerge, validateConfig,
  toExportJson, fromImportJson, nextPhase, dupNameWarnings, normalizeItemText,
  isValidPin, canHelperEdit, validateGroupCount, generateCode, isValidCode, isDuplicateName,
  canMerge, deleteItem, splitItem, helperActions, toPathUpdates, groupLabel,
  validateBallot, ballotIds, voterCount, buildXlsxSheets, percentShares, pctText, planBallotAdjust, ballotNote, rehearsalItems,
} from '../logic.js';

const config = JSON.parse(readFileSync(new URL('../config/templates/prmc-workshop.json', import.meta.url), 'utf8'));

/** 依票數產生題目和選票：counts[i] 是第 i 題的票數，題目文字 T0、T1…（讓排序可預期）。 */
function fixture(counts, cat = 'impact') {
  const items = {};
  counts.forEach((_, i) => { items[`i${i}`] = { text: `T${i}`, cat, groups: { 1: true }, status: 'active' }; });
  const votes = {};
  let voter = 0;
  counts.forEach((n, i) => { for (let k = 0; k < n; k++) votes[`u${voter++}`] = { v1: `i${i}` }; });
  return { items, votes };
}

test('G1：票數 10, 8, 8, 8, 5 → 名次 1, 2, 2, 2, 5；前 4 題優先聚焦', () => {
  const { items, votes } = fixture([10, 8, 8, 8, 5]);
  const r = tally(items, votes, 'impact', config.vote);
  assert.deepEqual(r.map((x) => x.votes), [10, 8, 8, 8, 5]);
  assert.deepEqual(r.map((x) => x.rank), [1, 2, 2, 2, 5]);
  assert.deepEqual(r.map((x) => x.priority), [true, true, true, true, false]);
  assert.deepEqual(rankCompetition([10, 8, 8, 8, 5]), [1, 2, 2, 2, 5]);
});

test('G2：票數 14, 20, 12, 10（總計 56）→ 占比 25.0%, 35.7%, 21.4%, 17.9%（T6）', () => {
  const { items, votes } = fixture([14, 20, 12, 10]);
  const r = tally(items, votes, 'impact', config.vote);
  const pctById = Object.fromEntries(r.map((x) => [x.id, x.pct]));
  assert.deepEqual([pctById.i0, pctById.i1, pctById.i2, pctById.i3], [25, 35.7, 21.4, 17.9]);
});

test('G18：占比一位小數、加總剛好 100.0%（T6）', () => {
  const { items, votes } = fixture([10, 8, 8, 8, 5]);
  assert.deepEqual(tally(items, votes, 'impact', config.vote).map((r) => r.pct), [25.7, 20.5, 20.5, 20.5, 12.8]);
  assert.deepEqual(percentShares([1, 1, 1]), [33.4, 33.3, 33.3]);
  assert.deepEqual(percentShares([0, 0]), [null, null]);
  assert.deepEqual(percentShares([3, 0]), [100, 0]);
  assert.equal(pctText(25), '25.0%');
  assert.equal(pctText(null), '—');
  // 隨機 500 組：加總都剛好 1000 個千分點，且每題和精確值差距小於 0.1%
  let seed = 7; const rnd = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
  for (let k = 0; k < 500; k++) {
    const counts = Array.from({ length: 1 + Math.floor(rnd() * 12) }, () => Math.floor(rnd() * 40));
    const total = counts.reduce((a, b) => a + b, 0);
    const p = percentShares(counts);
    if (total === 0) continue;
    assert.equal(p.reduce((a, b) => a + Math.round(b * 10), 0), 1000, JSON.stringify(counts));
    p.forEach((x, i) => assert.ok(Math.abs(x - (counts[i] * 100) / total) < 0.1 + 1e-9, JSON.stringify(counts)));
  }
});

test('G3：票數 3, 0, 0, 0 → 名次 1, 2, 2, 2；只有第 1 題優先聚焦（T5）', () => {
  const { items, votes } = fixture([3, 0, 0, 0]);
  const r = tally(items, votes, 'impact', config.vote);
  assert.deepEqual(r.map((x) => x.rank), [1, 2, 2, 2]);
  assert.deepEqual(r.map((x) => x.priority), [true, false, false, false]);
});

test('G4：該類只有 2 題，maxPerVoter=3 → maxVotes＝2', () => {
  const { items } = fixture([0, 0]);
  assert.equal(maxVotes(config, items, 'impact'), 2);
  assert.equal(maxVotes(config, fixture([0, 0, 0, 0]).items, 'impact'), 3);
});

test('G5：總票數 0 → 占比全部 null，沒有優先聚焦', () => {
  const { items } = fixture([0, 0, 0]);
  const r = tally(items, {}, 'impact', config.vote);
  assert.ok(r.every((x) => x.pct === null));
  assert.ok(r.every((x) => x.priority === false));
});

test('G6：合併 A（第 1 組）、B（第 3 組）再拆回', () => {
  const items = {
    A: { text: '甲', cat: 'impact', groups: { 1: true }, rewritten: false, status: 'active' },
    B: { text: '乙', cat: 'impact', groups: { 3: true }, rewritten: false, status: 'active' },
  };
  const { id, item, updates } = mergeItems(items, ['A', 'B'], '甲', { newId: 'M' });
  assert.equal(id, 'M');
  assert.deepEqual(Object.keys(item.groups).sort(), ['1', '3']);
  assert.equal(updates.A.status, 'merged');
  assert.equal(updates.A.mergedInto, 'M');
  const after = { ...items, ...updates };
  const back = unmerge(after, 'M');
  assert.equal(back.M, null);
  const restored = { ...after, ...back };
  delete restored.M;
  for (const k of ['A', 'B']) {
    assert.equal(restored[k].status, 'active');
    assert.ok(!('mergedInto' in restored[k]));
    assert.deepEqual(restored[k].groups, items[k].groups);
  }
});

test('G7：指向已經 merged 的項目的選票會被忽略', () => {
  const items = {
    A: { text: '甲', cat: 'impact', groups: { 1: true }, status: 'merged', mergedInto: 'M' },
    M: { text: '甲乙', cat: 'impact', groups: { 1: true, 3: true }, status: 'active' },
  };
  const r = tally(items, { u1: { v1: 'A' }, u2: { v1: 'M' } }, 'impact', config.vote);
  assert.equal(r.length, 1);
  assert.equal(r[0].votes, 1);
});

test('G8：設定檔有重複的分類 key → validateConfig 回傳錯誤', () => {
  assert.equal(validateConfig(config).ok, true);
  const bad = structuredClone(config);
  bad.categories.push({ key: 'impact', label: '重複' });
  const r = validateConfig(bad);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('impact')));
});

test('G9：JSON 匯出後再匯入 → 內容相同，visibility＝private', () => {
  const session = {
    code: 'ABC234',
    meta: { title: '測試', visibility: 'live', templateId: 'prmc-workshop', schemaVersion: 1, config,
      phase: { index: 0, type: 'collect' }, groupCount: 5, createdAt: 1, updatedAt: 2 },
    items: { A: { text: '甲', cat: 'impact', groups: { 1: true }, rewritten: true, status: 'active', createdBy: 'u', createdGroup: 1 } },
    votes: { impact: { u1: { name: '小明', group: 2, v1: 'A', ts: 3 } } },
    participants: { u1: { name: '小明', group: 2, joinedAt: 3 } },
    access: { helpers: { x: { pin: '123456' } } },
    secrets: { helperPin: '123456' },
  };
  const exported = toExportJson(session, 1700000000000);
  const text = JSON.stringify(exported);
  assert.ok(!text.includes('123456'), '匯出不能包含 PIN');
  assert.ok(!('access' in exported.session) && !('secrets' in exported.session));
  const r = fromImportJson(text);
  assert.equal(r.ok, true, r.errors.join('；'));
  assert.equal(r.session.meta.visibility, 'private');
  const { access, secrets, ...plain } = session;
  assert.deepEqual(r.session, { ...plain, voteLog: {}, meta: { ...plain.meta, visibility: 'private' } });
});

test('G10：不同分類不能合併（T23）', () => {
  const items = {
    A: { text: '甲', cat: 'impact', groups: { 1: true }, status: 'active' },
    B: { text: '乙', cat: 'cost', groups: { 2: true }, status: 'active' },
  };
  assert.equal(canMerge(items, ['A', 'B']).ok, false);
  assert.throws(() => mergeItems(items, ['A', 'B'], '甲', { newId: 'M' }), /不同分類/);
  items.B.cat = 'impact'; // 分類寫錯，先改分類
  assert.equal(canMerge(items, ['A', 'B']).ok, true);
  assert.equal(canMerge(items, ['A']).ok, false);
});

test('G11：複製到另一類（T24）', () => {
  const items = { A: { text: '甲乙都有', cat: 'impact', groups: { 2: true }, rewritten: false, status: 'active' } };
  const { id, item } = splitItem(items, 'A', config.categories, { newId: 'S' });
  assert.equal(id, 'S');
  assert.deepEqual(item.groups, { 2: true });
  assert.equal(item.cat, 'cost');
  assert.equal(item.rewritten, true);
  assert.equal(item.text, '甲乙都有');
  assert.ok(!('sources' in item));
  assert.equal(splitItem({ B: { ...items.A, cat: 'cost' } }, 'B', config.categories, { newId: 'T' }).item.cat, 'impact');
  assert.throws(() => splitItem({ C: { ...items.A, status: 'merged' } }, 'C', config.categories, { newId: 'U' }));
  assert.throws(() => splitItem({ M: { ...items.A, sources: { a: true, b: true } } }, 'M', config.categories, { newId: 'V' }), /先拆回/, '合併後的題目要先拆回');
});

test('G12：刪除合併後的項目：cascade 連同來源、unmerge 拆回一層（T20）', () => {
  const base = (t, g) => ({ text: t, cat: 'impact', groups: { [g]: true }, rewritten: false, status: 'active' });
  let items = { A: base('A', 1), B: base('B', 2), C: base('C', 3) };
  items = { ...items, ...mergeItems(items, ['A', 'B'], 'AB', { newId: 'M' }).updates };
  items = { ...items, ...mergeItems(items, ['M', 'C'], 'ABC', { newId: 'N' }).updates };
  const cascade = deleteItem(items, 'N', 'cascade');
  assert.deepEqual(Object.keys(cascade).sort(), ['A', 'B', 'C', 'M', 'N']);
  assert.ok(Object.values(cascade).every((v) => v === null));
  const un = deleteItem(items, 'N', 'unmerge');
  assert.equal(un.N, null);
  assert.equal(un.M.status, 'active');
  assert.equal(un.C.status, 'active');
  assert.ok(!('A' in un), '拆回只拆一層');
  assert.deepEqual(deleteItem(items, 'C', 'cascade'), { C: null }, '一般題目直接刪除');
});

test('G13：合併後的已改寫（T25）', () => {
  const items = {
    A: { text: '甲', cat: 'impact', groups: { 1: true }, rewritten: false, status: 'active' },
    B: { text: '乙', cat: 'impact', groups: { 3: true }, rewritten: false, status: 'active' },
  };
  assert.equal(mergeItems(items, ['A', 'B'], '甲', { newId: 'M' }).item.rewritten, false);
  assert.equal(mergeItems(items, ['A', 'B'], '甲和乙', { newId: 'M' }).item.rewritten, true);
  const rw = { ...items, B: { ...items.B, rewritten: true } };
  assert.equal(mergeItems(rw, ['A', 'B'], '甲', { newId: 'M' }).item.rewritten, true);
});

test('小幫手可以做的動作：合併、拆回只在合併階段；複製到另一類依 T24', () => {
  const mine = { groups: { 2: true }, status: 'active' };
  const other = { groups: { 3: true }, status: 'active' };
  const merged = { groups: { 2: true, 3: true }, status: 'active', sources: { a: true, b: true } };
  assert.deepEqual(helperActions('collect', 2, mine), { edit: true, split: true, select: false, unmerge: false, delete: true });
  assert.equal(helperActions('collect', 2, other).split, false);
  assert.equal(helperActions('collect', 2, merged).delete, false);
  assert.deepEqual(helperActions('merge', 2, other), { edit: true, split: true, select: true, unmerge: false, delete: true });
  assert.equal(helperActions('merge', 2, merged).unmerge, true);
  assert.equal(helperActions('merge', 2, merged).split, false, '合併後的題目不提供複製到另一類');
  assert.equal(helperActions('collect', 2, merged).split, false);
  assert.equal(helperActions('share', 2, mine).split, false);
});

test('組別：Firebase 存成陣列時也正確（[null,true,null,true] ＝ 第 1、3 組）', () => {
  assert.equal(groupLabel([null, true, null, true]), '第 1、3 組');
  const items = {
    A: { text: '甲', cat: 'impact', groups: [null, true], status: 'active' },
    B: { text: '乙', cat: 'impact', groups: [null, null, null, true], status: 'active' },
  };
  assert.deepEqual(mergeItems(items, ['A', 'B'], '甲', { newId: 'M' }).item.groups, { 1: true, 3: true });
  assert.equal(validateGroupCount(2, config, { items }).ok, false);
});

test('toPathUpdates：只寫有變的欄位', () => {
  const items = { A: { text: '甲', status: 'active', groups: { 1: true } } };
  const updates = mergeItems({ ...items, B: { text: '乙', status: 'active', groups: { 2: true } } }, ['A', 'B'], '甲', { newId: 'M' }).updates;
  const u = toPathUpdates({ ...items, B: { text: '乙', status: 'active', groups: { 2: true } } }, updates);
  assert.equal(u['A/status'], 'merged');
  assert.equal(u['A/mergedInto'], 'M');
  assert.ok(!('A/text' in u));
  assert.equal(u.M.text, '甲');
  const un = toPathUpdates({ A: { text: '甲', status: 'merged', mergedInto: 'M' }, M: { sources: { A: true } } }, { A: { text: '甲', status: 'active' }, M: null });
  assert.deepEqual(un, { 'A/status': 'active', 'A/mergedInto': null, M: null });
});

test('G14：選票檢查（R1）', () => {
  const items = {
    A: { text: '甲', cat: 'impact', groups: { 1: true }, status: 'active' },
    B: { text: '乙', cat: 'impact', groups: { 2: true }, status: 'active' },
    C: { text: '丙', cat: 'cost', groups: { 1: true }, status: 'active' },
    M: { text: '舊', cat: 'impact', groups: { 1: true }, status: 'merged', mergedInto: 'A' },
  };
  assert.equal(validateBallot(config, items, 'impact', ['A', 'B', 'C']).ok, false, '只有 2 題時不能選 3 題');
  assert.equal(validateBallot(config, items, 'impact', []).ok, false, '至少 1 題');
  assert.equal(validateBallot(config, items, 'impact', ['A', 'A']).ok, false, '不能重複');
  assert.equal(validateBallot(config, items, 'impact', ['C']).ok, false, '別類');
  assert.equal(validateBallot(config, items, 'impact', ['M']).ok, false, '已合併');
  assert.deepEqual(validateBallot(config, items, 'impact', ['B']).ballot, { v1: 'B' });
  assert.deepEqual(validateBallot(config, items, 'impact', ['B', 'A']).ballot, { v1: 'B', v2: 'A' });
  assert.deepEqual(ballotIds({ v1: 'B', v2: 'A', name: 'x' }), ['B', 'A']);
  assert.equal(voterCount({ u1: {}, u2: {} }), 2);
  assert.equal(voterCount(undefined), 0);
});

test('G15：XLSX 四張工作表', () => {
  const items = {
    A: { text: '甲', cat: 'impact', groups: { 1: true }, rewritten: false, status: 'merged', mergedInto: 'M' },
    B: { text: '乙', cat: 'impact', groups: { 3: true }, rewritten: false, status: 'merged', mergedInto: 'M' },
    M: { text: '甲乙', cat: 'impact', groups: { 1: true, 3: true }, rewritten: true, status: 'active', sources: { A: true, B: true } },
    C: { text: '丙', cat: 'impact', groups: { 2: true }, rewritten: false, status: 'active' },
    D: { text: '丁', cat: 'cost', groups: { 2: true }, rewritten: false, status: 'active' },
  };
  const votes = { impact: { u1: { name: '小明', group: 2, v1: 'M', v2: 'C', ts: 1765436823000 }, u2: { name: '小華', group: 1, v1: 'M', ts: 1765436824000 } } };
  const sheets = buildXlsxSheets({ code: 'ABC234', meta: { title: '測試', templateId: 'prmc-workshop', config, phase: { index: 5, type: 'results' } }, items, votes, participants: {} }, 1765436900000);
  assert.deepEqual(sheets.map((s) => s.name), ['建議關注點', '合併紀錄', '投票明細', '場次資訊', '選票調整紀錄']);
  const [summary, merges, detail, info] = sheets.map((s) => s.rows);
  assert.deepEqual(summary[0], ['分類', '題目', '組別', '已改寫', '票數', '占比', '名次', '優先聚焦']);
  assert.deepEqual(summary[1], ['實質影響', '甲乙', '第 1、3 組', '是', 2, '66.7%', 1, '是']);
  assert.deepEqual(summary[2], ['實質影響', '丙', '第 2 組', '否', 1, '33.3%', 2, '是']);
  assert.deepEqual(summary[3], ['成本', '丁', '第 2 組', '否', 0, '—', 1, ''], '總票數 0：占比「—」、不是優先聚焦');
  assert.equal(merges.length, 3, '標題＋每個來源一列');
  assert.deepEqual(merges[1], ['甲乙', '甲', '第 1 組']);
  assert.deepEqual(detail[0], ['分類', '姓名', '組別', '所投題目 1', '所投題目 2', '所投題目 3', '時間', '備註']);
  assert.deepEqual(detail[1].slice(0, 6), ['實質影響', '小華', 1, '甲乙', '', ''], '依組別排序');
  assert.match(detail[1][6], /^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}$/);
  assert.deepEqual(info.find((r) => r[0] === '階段'), ['階段', '優先聚焦結果']);
  assert.deepEqual(info.find((r) => r[0] === '投票人數：實質影響'), ['投票人數：實質影響', 2]);
  assert.deepEqual(info.find((r) => r[0] === '投票人數（不重複）'), ['投票人數（不重複）', 2]);
});

test('G16：主持人調整選票（T30）', () => {
  const items = {
    A: { text: '甲', cat: 'impact', groups: { 1: true }, status: 'active' },
    B: { text: '乙', cat: 'impact', groups: { 2: true }, status: 'active' },
    M: { text: '舊', cat: 'impact', groups: { 1: true }, status: 'merged', mergedInto: 'A' },
  };
  const votes = { p1: { name: 'Mike', group: 2, v1: 'A', ts: 1 } };
  // 只在結果階段
  assert.equal(planBallotAdjust(config, items, votes, 'vote', 'impact', 'delete', { voterId: 'p1' }).ok, false);
  // 修改：保留姓名組別、套用 R1
  const e = planBallotAdjust(config, items, votes, 'results', 'impact', 'edit', { voterId: 'p1', ids: ['B'], by: 'h' });
  assert.equal(e.ok, true);
  assert.deepEqual(e.ballot, { name: 'Mike', group: 2, v1: 'B', hostEdited: true });
  assert.deepEqual(e.log, { action: 'edit', cat: 'impact', voterId: 'p1', by: 'h', name: 'Mike', group: 2, before: { v1: 'A' }, after: { v1: 'B' } });
  assert.equal(planBallotAdjust(config, items, votes, 'results', 'impact', 'edit', { voterId: 'p1', ids: ['M'] }).ok, false, '不能改成已合併的題目');
  assert.equal(planBallotAdjust(config, items, votes, 'results', 'impact', 'edit', { voterId: 'p1', ids: [] }).ok, false, '至少 1 題');
  assert.equal(planBallotAdjust(config, items, votes, 'results', 'impact', 'edit', { voterId: 'nobody', ids: ['A'] }).ok, false);
  // 刪除
  const d = planBallotAdjust(config, items, votes, 'results', 'impact', 'delete', { voterId: 'p1', by: 'h' });
  assert.equal(d.ballot, null);
  assert.deepEqual(d.log.before, { v1: 'A' });
  // 代投
  const a = planBallotAdjust(config, items, votes, 'results', 'impact', 'add', { voterId: 'host-1', ids: ['A', 'B'], name: ' 小華 ', group: '3', by: 'h' });
  assert.deepEqual(a.ballot, { name: '小華', group: 3, v1: 'A', v2: 'B', hostEdited: true });
  assert.equal(planBallotAdjust(config, items, votes, 'results', 'impact', 'add', { voterId: 'p9', ids: ['A'], name: 'x', group: 1 }).ok, false, '代投代號要 host- 開頭');
  assert.equal(planBallotAdjust(config, items, votes, 'results', 'impact', 'add', { voterId: 'host-2', ids: ['A'], name: '', group: 1 }).ok, false, '姓名必填');
  // 備註
  assert.equal(ballotNote('p1', e.ballot), '主持人修改');
  assert.equal(ballotNote('host-1', a.ballot), '主持人代投');
  assert.equal(ballotNote('p1', votes.p1), '');
});

test('G16：XLSX 的備註欄與選票調整紀錄', () => {
  const items = { A: { text: '甲', cat: 'impact', groups: { 1: true }, status: 'active' }, B: { text: '乙', cat: 'impact', groups: { 2: true }, status: 'active' } };
  const votes = { impact: { p1: { name: 'Mike', group: 2, v1: 'B', ts: 1, hostEdited: true }, 'host-1': { name: '小華', group: 3, v1: 'A', ts: 2, hostEdited: true } } };
  const voteLog = { l1: { action: 'edit', cat: 'impact', voterId: 'p1', name: 'Mike', group: 2, before: { v1: 'A' }, after: { v1: 'B' }, by: 'h', at: 1765436823000 } };
  const sheets = buildXlsxSheets({ code: 'X', meta: { title: 't', config, phase: { index: 5, type: 'results' } }, items, votes, voteLog }, 1765436900000);
  const detail = sheets.find((s) => s.name === '投票明細').rows;
  assert.deepEqual(detail.slice(1).map((r) => [r[1], r[7]]), [['Mike', '主持人修改'], ['小華', '主持人代投']]);
  const log = sheets.find((s) => s.name === '選票調整紀錄').rows;
  assert.deepEqual(log[1].slice(1), ['修改', '實質影響', 'Mike', 2, '甲', '乙']);
});

test('G17：彩排示範題目', () => {
  const list = JSON.parse(readFileSync(new URL('../config/templates/prmc-workshop.rehearsal.json', import.meta.url), 'utf8')).items;
  const five = rehearsalItems(list, config, 5, 1000);
  assert.equal(Object.keys(five).length, 10);
  assert.ok(Object.values(five).every((it) => it.status === 'active' && normalizeItemText(it.text).ok));
  assert.equal(Object.values(five).filter((it) => it.cat === 'impact').length, 5);
  assert.equal(Object.keys(rehearsalItems(list, config, 3, 1000)).length, 6, '組數 3 時略過第 4、5 組');
});

test('匯入：版本比程式新、或不是本工具的檔案 → 拒絕', () => {
  assert.equal(fromImportJson({ tool: 'concern-board', schemaVersion: 99, session: {} }).ok, false);
  assert.equal(fromImportJson({ tool: 'other', schemaVersion: 1 }).ok, false);
  assert.equal(fromImportJson('not json').ok, false);
});

test('nextPhase：某類沒有 active 題目時跳過該類投票', () => {
  const items = { A: { text: '甲', cat: 'cost', status: 'active', groups: { 1: true } } };
  assert.deepEqual(nextPhase(config, items, 2, 1), { index: 4, type: 'vote', category: 'cost' });
  assert.deepEqual(nextPhase(config, items, 5, -1), { index: 4, type: 'vote', category: 'cost' });
  assert.equal(nextPhase(config, items, 5, 1), null);
});

test('T3：同組同名警示', () => {
  const p = { a: { name: 'Mike', group: 2 }, b: { name: ' mike ', group: 2 }, c: { name: 'Mike', group: 3 } };
  assert.deepEqual(dupNameWarnings(p), [{ group: 2, name: 'Mike', uids: ['a', 'b'] }]);
  assert.equal(isDuplicateName(p, 'MIKE', 3, 'x'), true);
  assert.equal(isDuplicateName(p, 'Mike', 3, 'c'), false);
});

test('T18、T19：題目文字與 PIN', () => {
  assert.deepEqual(normalizeItemText('  你好 '), { ok: true, value: '你好', error: null });
  assert.equal(normalizeItemText('   ').ok, false);
  assert.equal(normalizeItemText('字'.repeat(150)).ok, true);
  assert.equal(normalizeItemText('字'.repeat(151)).ok, false);
  assert.equal(isValidPin('012345'), true);
  assert.equal(isValidPin('12345'), false);
  assert.equal(isValidPin('12345a'), false);
});

test('T2、T8：小幫手的編輯權限', () => {
  const mine = { groups: { 2: true } };
  const other = { groups: { 3: true } };
  assert.equal(canHelperEdit('collect', 2, mine), true);
  assert.equal(canHelperEdit('collect', 2, other), false);
  assert.equal(canHelperEdit('collect', 2, null), true);
  assert.equal(canHelperEdit('merge', 2, other), true);
  assert.equal(canHelperEdit('vote', 2, mine), false);
  assert.equal(canHelperEdit('share', 2, mine), false);
});

test('T10：組數不能小於已使用的最大組號，最多 8', () => {
  const session = { items: { A: { groups: { 6: true } } } };
  assert.equal(validateGroupCount(5, config, session).ok, false);
  assert.equal(validateGroupCount(6, config, session).ok, true);
  assert.equal(validateGroupCount(9, config, {}).ok, false);
  assert.equal(validateGroupCount(0, config, {}).ok, false);
});

test('場次代碼是 6 碼、不含容易混淆的字元', () => {
  for (let i = 0; i < 50; i++) assert.ok(isValidCode(generateCode()));
  assert.equal(isValidCode('ABC10O'), false);
});
