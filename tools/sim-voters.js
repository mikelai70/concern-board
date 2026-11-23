// 模擬 30 位參與者在兩段投票中投票（含改票），檢查結果是否和 golden test G1、G2 一致（B8、B9 v0.3 驗收）。
// 需要先執行 npm run dev。用法：node tools/sim-voters.js
// 會建立場次 SIM030（進行中），跑完停在「結果」階段，可以打開 http://localhost:8000/#/s/SIM030/screen 看結果畫面。
import { readFileSync } from 'node:fs';
import { initializeApp, deleteApp } from 'firebase/app';
import { getAuth, signInAnonymously, connectAuthEmulator } from 'firebase/auth';
import { getDatabase, ref, set, serverTimestamp, connectDatabaseEmulator, goOffline } from 'firebase/database';
import { tally, validateBallot } from '../logic.js';

const CODE = 'SIM030';
const NS = 'demo-concern-board-default-rtdb';
const N = 30;
const config = JSON.parse(readFileSync(new URL('../config/templates/prmc-workshop.json', import.meta.url), 'utf8'));
const admin = { Authorization: 'Bearer owner', 'Content-Type': 'application/json' };
const put = (path, body) => fetch(`http://127.0.0.1:9000/${path}.json?ns=${NS}`, { method: 'PUT', headers: admin, body: JSON.stringify(body) });
const get = (path) => fetch(`http://127.0.0.1:9000/${path}.json?ns=${NS}`, { headers: admin }).then((r) => r.json());

// G1：實質影響 5 題，票數 10, 8, 8, 8, 5；G2：成本 4 題，票數 14, 20, 12, 10
const plan = { impact: [10, 8, 8, 8, 5], cost: [14, 20, 12, 10] };
const now = Date.now();
const items = {};
for (const [cat, counts] of Object.entries(plan)) {
  counts.forEach((_, i) => {
    items[`${cat}${i}`] = { text: `${cat === 'impact' ? '影響' : '成本'}題 ${i + 1}`, cat, groups: { [(i % 5) + 1]: true }, rewritten: false, status: 'active', createdAt: now + i };
  });
}
/** 把每題的票數依序分給 30 人（輪流），每人同一類最多 2 題、不重複 */
function ballots(cat) {
  const out = Array.from({ length: N }, () => []);
  let p = 0;
  plan[cat].forEach((n, i) => { for (let k = 0; k < n; k++) { out[p % N].push(`${cat}${i}`); p++; } });
  return out;
}

await put(`sessions/${CODE}`, { meta: { title: '模擬 30 人投票', visibility: 'live', templateId: 'prmc-workshop', schemaVersion: 1, config,
  phase: { index: 3, type: 'vote', category: 'impact' }, groupCount: 5, createdAt: now, updatedAt: now }, items });

const voters = [];
for (let i = 0; i < N; i++) {
  const app = initializeApp({ apiKey: 'demo', projectId: 'demo-concern-board', databaseURL: `http://127.0.0.1:9000/?ns=${NS}` }, `v${i}`);
  const auth = getAuth(app); connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  const db = getDatabase(app); connectDatabaseEmulator(db, '127.0.0.1', 9000);
  const { user } = await signInAnonymously(auth);
  const name = `參與者${String(i + 1).padStart(2, '0')}`; const group = (i % 5) + 1;
  await set(ref(db, `sessions/${CODE}/participants/${user.uid}`), { name, group, joinedAt: serverTimestamp() });
  voters.push({ app, db, uid: user.uid, name, group });
}

async function round(cat) {
  const plans = ballots(cat);
  // 先投一張「錯的」再改票（T4：以最後送出的為準）
  await Promise.all(voters.map(async (v, i) => {
    const first = validateBallot(config, items, cat, [`${cat}${(i + 1) % plan[cat].length}`]);
    await set(ref(v.db, `sessions/${CODE}/votes/${cat}/${v.uid}`), { name: v.name, group: v.group, ...first.ballot, ts: serverTimestamp() });
    const r = validateBallot(config, items, cat, plans[i]);
    if (!r.ok) throw new Error(`第 ${i + 1} 人的選票不合法：${r.error}`);
    await set(ref(v.db, `sessions/${CODE}/votes/${cat}/${v.uid}`), { name: v.name, group: v.group, ...r.ballot, ts: serverTimestamp() });
  }));
}

await round('impact');
await put(`sessions/${CODE}/meta/phase`, { index: 4, type: 'vote', category: 'cost' });
await round('cost');
await put(`sessions/${CODE}/meta/phase`, { index: 5, type: 'results' });
for (const v of voters) { goOffline(v.db); await deleteApp(v.app); }

const votes = await get(`sessions/${CODE}/votes`);
const g1 = tally(items, votes.impact, 'impact', config.vote);
const g2 = tally(items, votes.cost, 'cost', config.vote);
const expect = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? '✔' : '✖'} ${label}：${JSON.stringify(got)}${ok ? '' : `（應為 ${JSON.stringify(want)}）`}`);
  return ok;
};
const byId = (rows, key) => Object.fromEntries(rows.map((r) => [r.id, r[key]]));
const results = [
  expect('投票人數（實質影響、成本）', [Object.keys(votes.impact).length, Object.keys(votes.cost).length], [30, 30]),
  expect('G1 票數', g1.map((r) => r.votes), [10, 8, 8, 8, 5]),
  expect('G1 名次', g1.map((r) => r.rank), [1, 2, 2, 2, 5]),
  expect('G1 優先聚焦', g1.map((r) => r.priority), [true, true, true, true, false]),
  expect('G2 占比（題 1～4）', ['cost0', 'cost1', 'cost2', 'cost3'].map((id) => byId(g2, 'pct')[id]), [25, 36, 21, 18]),
];
console.log(results.every(Boolean) ? '\n模擬 30 人投票：結果全部正確。投影畫面：http://localhost:8000/#/s/SIM030/screen' : '\n有結果不正確');
process.exit(results.every(Boolean) ? 0 : 1);
