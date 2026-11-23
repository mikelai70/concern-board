// 權限測試（docs/spec.md B8）：在 Firebase emulator 上逐項驗證 database.rules.json。
// 執行：npm run test:rules（會自動啟動、關閉 emulator；需要 Java）
import { test, before, after, beforeEach } from 'node:test';
import { readFileSync } from 'node:fs';
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing';

const OWNER = 'BkEeFSDkL9YW98rv5qxFTgG06Lu1';
const rules = readFileSync(new URL('../database.rules.json', import.meta.url), 'utf8');
const config = JSON.parse(readFileSync(new URL('../config/templates/prmc-workshop.json', import.meta.url), 'utf8'));
const HELPER_PIN = '111111';
const HOST_PIN = '222222';

let env;

before(async () => {
  env = await initializeTestEnvironment({ projectId: 'demo-concern-board', database: { rules } });
});
after(async () => { await env.cleanup(); });

/** 種子資料：場次 LIVE01（進行中）、PRIV01（私人）、DEMO01（展示），都在收集階段。 */
async function seed({ phase = { index: 0, type: 'collect' }, visibility = 'live', withSecrets = true } = {}) {
  await env.clearDatabase();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.database();
    const session = (vis) => ({
      meta: { title: 't', visibility: vis, templateId: 'prmc-workshop', schemaVersion: 1, config, phase, groupCount: 5 },
      items: {
        a1: { text: '第一組的題目', cat: 'impact', groups: { 1: true }, rewritten: false, status: 'active' },
        b2: { text: '第二組的題目', cat: 'impact', groups: { 2: true }, rewritten: false, status: 'active' },
        c1: { text: '成本題', cat: 'cost', groups: { 1: true }, rewritten: false, status: 'active' },
        m1: { text: '已合併', cat: 'impact', groups: { 1: true }, rewritten: false, status: 'merged', mergedInto: 'a1' },
      },
    });
    await db.ref('sessions/LIVE01').set(session(visibility));
    await db.ref('sessions/PRIV01').set(session('private'));
    await db.ref('sessions/DEMO01').set(session('demo'));
    if (withSecrets) {
      for (const c of ['LIVE01', 'PRIV01', 'DEMO01']) await db.ref(`secrets/${c}`).set({ helperPin: HELPER_PIN, hostPin: HOST_PIN });
    }
    // 已經用正確 PIN 加入的小幫手（第 1 組）與主持人
    for (const c of ['LIVE01', 'DEMO01']) {
      await db.ref(`access/${c}/helpers/helper1`).set({ pin: HELPER_PIN, group: 1 });
      await db.ref(`access/${c}/hosts/host1`).set({ pin: HOST_PIN });
    }
  });
}
const as = (uid) => env.authenticatedContext(uid).database();
const anon = () => env.unauthenticatedContext().database();

beforeEach(async () => { await seed(); });

// ---------- 讀取 ----------
test('私人場次：非擁有者讀取失敗、擁有者可以讀', async () => {
  await assertFails(as('someone').ref('sessions/PRIV01').get());
  await assertSucceeds(as(OWNER).ref('sessions/PRIV01').get());
});
test('進行中、展示場次：登入（匿名）的人可以讀；未登入不行', async () => {
  await assertSucceeds(as('someone').ref('sessions/LIVE01').get());
  await assertSucceeds(as('someone').ref('sessions/DEMO01').get());
  await assertFails(anon().ref('sessions/LIVE01').get());
});
test('場次清單：只有擁有者能列出所有場次', async () => {
  await assertFails(as('someone').ref('sessions').get());
  await assertSucceeds(as(OWNER).ref('sessions').get());
});
test('讀取 secrets：一律失敗（包括擁有者）', async () => {
  await assertFails(as('someone').ref('secrets/LIVE01').get());
  await assertFails(as(OWNER).ref('secrets/LIVE01').get());
  await assertFails(as('helper1').ref('secrets/LIVE01').get());
});
test('access：只有本人和擁有者能讀', async () => {
  await assertSucceeds(as('helper1').ref('access/LIVE01/helpers/helper1').get());
  await assertSucceeds(as(OWNER).ref('access/LIVE01/helpers/helper1').get());
  await assertFails(as('someone').ref('access/LIVE01/helpers/helper1').get());
  await assertFails(as('someone').ref('access/LIVE01/hosts/host1').get());
});

// ---------- 展示場次 ----------
test('展示場次：任何寫入都失敗', async () => {
  const h = as('helper1');
  await assertFails(h.ref('sessions/DEMO01/items/a1/text').set('改'));
  await assertFails(h.ref('sessions/DEMO01/items/new1').set({ text: '新', cat: 'impact', groups: { 1: true }, status: 'active' }));
  await assertFails(as('host1').ref('sessions/DEMO01/meta/phase').set({ index: 1, type: 'merge' }));
  await assertFails(as('p1').ref('sessions/DEMO01/participants/p1').set({ name: 'A', group: 1 }));
  await assertFails(as('someone').ref('sessions/DEMO01/meta/visibility').set('live'));
});

// ---------- PIN ----------
test('PIN 錯誤時：寫入 access 失敗；正確時成功', async () => {
  await assertFails(as('u9').ref('access/LIVE01/helpers/u9').set({ pin: '999999', group: 2 }));
  await assertSucceeds(as('u9').ref('access/LIVE01/helpers/u9').set({ pin: HELPER_PIN, group: 2 }));
  await assertFails(as('u9').ref('access/LIVE01/hosts/u9').set({ pin: HELPER_PIN }));
  await assertSucceeds(as('u9').ref('access/LIVE01/hosts/u9').set({ pin: HOST_PIN }));
});
test('不能替別人寫 access', async () => {
  await assertFails(as('u9').ref('access/LIVE01/helpers/other').set({ pin: HELPER_PIN, group: 2 }));
});
test('還沒設定 PIN 的場次：沒有 PIN 也不能取得小幫手、主持人權限', async () => {
  await seed({ withSecrets: false });
  await assertFails(as('u9').ref('access/LIVE01/helpers/u9').set({ group: 1 }));
  await assertFails(as('u9').ref('access/LIVE01/hosts/u9').set({ group: 1 }));
  await assertFails(as('u9').ref('sessions/LIVE01/items/x').set({ text: '新', cat: 'impact', groups: { 1: true }, status: 'active' }));
  await assertFails(as('u9').ref('sessions/LIVE01/meta/phase').set({ index: 1, type: 'merge' }));
});

// ---------- 小幫手 ----------
test('小幫手在收集階段：可以新增、修改、刪除本組的題目', async () => {
  const h = as('helper1');
  await assertSucceeds(h.ref('sessions/LIVE01/items/a1/text').set('改寫後'));
  await assertSucceeds(h.ref('sessions/LIVE01/items/n1').set({ text: '新題', cat: 'cost', groups: { 1: true }, rewritten: false, status: 'active' }));
  await assertSucceeds(h.ref('sessions/LIVE01/items/n1').remove());
});
test('小幫手在收集階段：改別組的項目失敗、新增別組的項目失敗、把本組的題目改成別組失敗', async () => {
  const h = as('helper1');
  await assertFails(h.ref('sessions/LIVE01/items/b2/text').set('改別組'));
  await assertFails(h.ref('sessions/LIVE01/items/b2').remove());
  await assertFails(h.ref('sessions/LIVE01/items/n2').set({ text: '新', cat: 'impact', groups: { 2: true }, status: 'active' }));
  await assertFails(h.ref('sessions/LIVE01/items/a1/groups').set({ 2: true }));
});
test('小幫手在合併階段：可以編輯所有組', async () => {
  await seed({ phase: { index: 1, type: 'merge' } });
  await assertSucceeds(as('helper1').ref('sessions/LIVE01/items/b2/text').set('合併階段改別組'));
});
// 合併：一次寫入新項目＋來源改為 merged（和 app.js 相同的多路徑寫入）
const mergeWrite = (db, code, ids, newId, groups) => db.ref(`sessions/${code}/items`).update({
  [newId]: { text: '合併後', cat: 'impact', groups, rewritten: true, status: 'active', sources: Object.fromEntries(ids.map((i) => [i, true])) },
  ...Object.fromEntries(ids.map((i) => [`${i}/status`, 'merged'])),
  ...Object.fromEntries(ids.map((i) => [`${i}/mergedInto`, newId])),
});

test('小幫手在收集階段：合併含別組的題目失敗（整筆被拒，原題不變）', async () => {
  await assertFails(mergeWrite(as('helper1'), 'LIVE01', ['a1', 'b2'], 'mx', { 1: true, 2: true }));
  let status;
  await env.withSecurityRulesDisabled(async (ctx) => { status = (await ctx.database().ref('sessions/LIVE01/items/a1/status').get()).val(); });
  if (status !== 'active') throw new Error(`原題被改動了：${status}`);
});
test('小幫手在合併階段：跨組合併、拆回、複製到另一類都成功', async () => {
  await seed({ phase: { index: 1, type: 'merge' } });
  const h = as('helper1');
  await assertSucceeds(mergeWrite(h, 'LIVE01', ['a1', 'b2'], 'mx', { 1: true, 2: true }));
  await assertSucceeds(h.ref('sessions/LIVE01/items').update({
    mx: null, 'a1/status': 'active', 'a1/mergedInto': null, 'b2/status': 'active', 'b2/mergedInto': null,
  }));
  await assertSucceeds(h.ref('sessions/LIVE01/items/sp1').set({ text: '第二組的題目', cat: 'cost', groups: { 2: true }, rewritten: true, status: 'active' }));
});
test('小幫手在收集階段：複製本組題目到另一類成功，別組題目失敗（T24）', async () => {
  const h = as('helper1');
  await assertSucceeds(h.ref('sessions/LIVE01/items/sp1').set({ text: '第一組的題目', cat: 'cost', groups: { 1: true }, rewritten: true, status: 'active' }));
  await assertFails(h.ref('sessions/LIVE01/items/sp2').set({ text: '第二組的題目', cat: 'cost', groups: { 2: true }, rewritten: true, status: 'active' }));
});
test('分享階段：小幫手不能合併', async () => {
  await seed({ phase: { index: 2, type: 'share' } });
  await assertFails(mergeWrite(as('helper1'), 'LIVE01', ['a1', 'b2'], 'mx', { 1: true, 2: true }));
});

test('投票、分享、結果階段：小幫手不能編輯（T8）', async () => {
  for (const phase of [{ index: 2, type: 'share' }, { index: 3, type: 'vote', category: 'impact' }, { index: 5, type: 'results' }]) {
    await seed({ phase });
    await assertFails(as('helper1').ref('sessions/LIVE01/items/a1/text').set('改'));
  }
});
test('題目文字：空字串、超過 150 字都失敗', async () => {
  const h = as('helper1');
  await assertFails(h.ref('sessions/LIVE01/items/a1/text').set(''));
  await assertFails(h.ref('sessions/LIVE01/items/a1/text').set('字'.repeat(151)));
  await assertSucceeds(h.ref('sessions/LIVE01/items/a1/text').set('字'.repeat(150)));
});
test('沒有輸入 PIN 的人（參與者）不能寫題目', async () => {
  await assertFails(as('p1').ref('sessions/LIVE01/items/a1/text').set('改'));
});
test('PIN 更換後，舊 PIN 加入的小幫手失去寫入權限', async () => {
  await env.withSecurityRulesDisabled((ctx) => ctx.database().ref('secrets/LIVE01/helperPin').set('333333'));
  await assertFails(as('helper1').ref('sessions/LIVE01/items/a1/text').set('改'));
});

// ---------- 主持人 ----------
test('主持人可以切換階段；小幫手和參與者不行；主持人不能改 meta 其他欄位', async () => {
  await assertSucceeds(as('host1').ref('sessions/LIVE01/meta/phase').set({ index: 1, type: 'merge' }));
  await assertFails(as('helper1').ref('sessions/LIVE01/meta/phase').set({ index: 2, type: 'share' }));
  await assertFails(as('p1').ref('sessions/LIVE01/meta/phase').set({ index: 2, type: 'share' }));
  await assertFails(as('host1').ref('sessions/LIVE01/meta/visibility').set('demo'));
});

// ---------- 參與者 ----------
test('參與者：可以寫自己的 participants，不能寫別人的；私人場次不行', async () => {
  await assertSucceeds(as('p1').ref('sessions/LIVE01/participants/p1').set({ name: 'Mike', group: 2 }));
  await assertFails(as('p1').ref('sessions/LIVE01/participants/p2').set({ name: 'X', group: 2 }));
  await assertFails(as('p1').ref('sessions/PRIV01/participants/p1').set({ name: 'Mike', group: 2 }));
});

// ---------- 投票 ----------
const ballot = (extra) => ({ name: 'Mike', group: 2, ts: { '.sv': 'timestamp' }, ...extra });

test('投票：非投票階段寫入失敗', async () => {
  await assertFails(as('p1').ref('sessions/LIVE01/votes/impact/p1').set(ballot({ v1: 'a1' })));
});
test('投票：投票階段可以投、可以改票；只能投自己的', async () => {
  await seed({ phase: { index: 3, type: 'vote', category: 'impact' } });
  const p = as('p1');
  await assertSucceeds(p.ref('sessions/LIVE01/votes/impact/p1').set(ballot({ v1: 'a1', v2: 'b2' })));
  await assertSucceeds(p.ref('sessions/LIVE01/votes/impact/p1').set(ballot({ v1: 'b2' })));
  await assertFails(p.ref('sessions/LIVE01/votes/impact/p2').set(ballot({ v1: 'a1' })));
});
test('投票：第 4 票（v4）失敗', async () => {
  await seed({ phase: { index: 3, type: 'vote', category: 'impact' } });
  await assertFails(as('p1').ref('sessions/LIVE01/votes/impact/p1').set(ballot({ v1: 'a1', v2: 'b2', v4: 'a1' })));
});
test('投票：同一題投兩次失敗', async () => {
  await seed({ phase: { index: 3, type: 'vote', category: 'impact' } });
  await assertFails(as('p1').ref('sessions/LIVE01/votes/impact/p1').set(ballot({ v1: 'a1', v2: 'a1' })));
});
test('投票：投給別的分類的題目失敗、投給已合併的題目失敗', async () => {
  await seed({ phase: { index: 3, type: 'vote', category: 'impact' } });
  await assertFails(as('p1').ref('sessions/LIVE01/votes/impact/p1').set(ballot({ v1: 'c1' })));
  await assertFails(as('p1').ref('sessions/LIVE01/votes/impact/p1').set(ballot({ v1: 'm1' })));
});
test('投票：寫到不是目前階段的分類失敗', async () => {
  await seed({ phase: { index: 3, type: 'vote', category: 'impact' } });
  await assertFails(as('p1').ref('sessions/LIVE01/votes/cost/p1').set(ballot({ v1: 'c1' })));
});
test('投票：時間不是伺服器時間失敗', async () => {
  await seed({ phase: { index: 3, type: 'vote', category: 'impact' } });
  await assertFails(as('p1').ref('sessions/LIVE01/votes/impact/p1').set({ name: 'Mike', group: 2, ts: 123, v1: 'a1' }));
});

// ---------- T30：主持人在結果階段調整選票 ----------
const RESULTS = { index: 5, type: 'results' };
async function seedVotes(phase) {
  await seed({ phase });
  await env.withSecurityRulesDisabled((ctx) => ctx.database().ref('sessions/LIVE01/votes/impact').set({
    p1: { name: 'Mike', group: 2, v1: 'a1', ts: 1700000000000 },
    p2: { name: 'Mike', group: 2, v1: 'b2', ts: 1700000000001 },
  }));
}
const logEntry = (by, extra) => ({ action: 'edit', cat: 'impact', voterId: 'p1', by, at: { '.sv': 'timestamp' }, ...extra });
const now = { '.sv': 'timestamp' };

test('T30：主持人在結果階段可以修改、刪除、代投選票，並寫入紀錄', async () => {
  await seedVotes(RESULTS);
  const h = as('host1');
  await assertSucceeds(h.ref('sessions/LIVE01').update({
    'votes/impact/p1': { name: 'Mike', group: 2, v1: 'b2', ts: 1700000000000, hostEdited: true, editedAt: now },
    'voteLog/l1': logEntry('host1', { before: { v1: 'a1' }, after: { v1: 'b2' } }),
  }));
  await assertSucceeds(h.ref('sessions/LIVE01').update({
    'votes/impact/p2': null,
    'voteLog/l2': logEntry('host1', { action: 'delete', voterId: 'p2', before: { v1: 'b2' } }),
  }));
  await assertSucceeds(h.ref('sessions/LIVE01').update({
    'votes/impact/host-x1': { name: '代投者', group: 3, v1: 'a1', ts: now, hostEdited: true, editedAt: now },
    'voteLog/l3': logEntry('host1', { action: 'add', voterId: 'host-x1', after: { v1: 'a1' } }),
  }));
});
test('T30：調整後的選票仍要符合規則（不能投已合併或別類的題目、不能超過 3 題）', async () => {
  await seedVotes(RESULTS);
  const h = as('host1');
  await assertFails(h.ref('sessions/LIVE01/votes/impact/p1').set({ name: 'Mike', group: 2, v1: 'm1', ts: 1700000000000, hostEdited: true, editedAt: now }));
  await assertFails(h.ref('sessions/LIVE01/votes/impact/p1').set({ name: 'Mike', group: 2, v1: 'c1', ts: 1700000000000, hostEdited: true, editedAt: now }));
  await assertFails(h.ref('sessions/LIVE01/votes/impact/p1').set({ name: 'Mike', group: 2, v1: 'a1', v2: 'b2', v4: 'a1', ts: 1700000000000, hostEdited: true, editedAt: now }));
});
test('T30：投票階段主持人不能調整；小幫手、參與者在結果階段也不能', async () => {
  await seedVotes({ index: 3, type: 'vote', category: 'impact' });
  await assertFails(as('host1').ref('sessions/LIVE01/votes/impact/p1').remove());
  await seedVotes(RESULTS);
  await assertFails(as('helper1').ref('sessions/LIVE01/votes/impact/p1').remove());
  await assertFails(as('p1').ref('sessions/LIVE01/votes/impact/p1').set({ name: 'Mike', group: 2, v1: 'b2', ts: now }));
  await assertFails(as('p1').ref('sessions/LIVE01/voteLog/x').set(logEntry('p1')));
});
test('T30：紀錄不能修改、不能刪除，也不能冒名', async () => {
  await seedVotes(RESULTS);
  const h = as('host1');
  await assertSucceeds(h.ref('sessions/LIVE01/voteLog/l1').set(logEntry('host1')));
  await assertFails(h.ref('sessions/LIVE01/voteLog/l1').set(logEntry('host1', { action: 'delete' })));
  await assertFails(h.ref('sessions/LIVE01/voteLog/l1').remove());
  await assertFails(h.ref('sessions/LIVE01/voteLog/l2').set(logEntry('someone-else')));
});
test('T30：參與者投票時不能自己標示「主持人修改」', async () => {
  await seedVotes({ index: 3, type: 'vote', category: 'impact' });
  await assertFails(as('p9').ref('sessions/LIVE01/votes/impact/p9').set({ name: 'X', group: 1, v1: 'a1', ts: now, hostEdited: true }));
  await assertSucceeds(as('p9').ref('sessions/LIVE01/votes/impact/p9').set({ name: 'X', group: 1, v1: 'a1', ts: now }));
});

// ---------- 擁有者 ----------
test('擁有者：可以建立、匯入（含舊選票）、刪除整個場次，設定 PIN 與可見性', async () => {
  const o = as(OWNER);
  await assertSucceeds(o.ref('sessions/NEW001').set({
    meta: { title: '匯入', visibility: 'private', templateId: 'prmc-workshop', schemaVersion: 1, config, phase: { index: 5, type: 'results' }, groupCount: 5 },
    items: { a1: { text: '題', cat: 'impact', groups: { 1: true }, status: 'merged', mergedInto: 'x' } },
    votes: { impact: { p1: { name: 'Mike', group: 2, v1: 'a1', ts: 1700000000000 } } },
    participants: { p1: { name: 'Mike', group: 2, joinedAt: 1700000000000 } },
  }));
  await assertSucceeds(o.ref('secrets/NEW001').set({ helperPin: '123456', hostPin: '654321' }));
  await assertSucceeds(o.ref('sessions/NEW001/meta/visibility').set('live'));
  await assertFails(o.ref('sessions/NEW001/meta/visibility').set('public'));
  await assertSucceeds(o.ref('sessions/NEW001').remove());
  await assertSucceeds(o.ref('access/LIVE01').remove());
  await assertSucceeds(o.ref('secrets/LIVE01').remove());
});
test('非擁有者：不能建立場次、不能寫 secrets、不能改可見性', async () => {
  await assertFails(as('someone').ref('sessions/NEW002/meta').set({ title: 'x', visibility: 'live' }));
  await assertFails(as('someone').ref('secrets/LIVE01').set({ helperPin: '000000', hostPin: '000000' }));
  await assertFails(as('helper1').ref('sessions/LIVE01/meta/visibility').set('demo'));
  await assertFails(as('host1').ref('sessions/LIVE01').remove());
});
