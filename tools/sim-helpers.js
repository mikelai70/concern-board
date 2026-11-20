// 模擬 5 位小幫手（各自登入、各一組）同時輸入、反覆修改題目，最後檢查資料是否正確。
// 需要先執行 npm run dev（emulator 與示範場次 TEST26）。用法：node tools/sim-helpers.js
import { initializeApp, deleteApp } from 'firebase/app';
import { getAuth, signInAnonymously, connectAuthEmulator } from 'firebase/auth';
import { getDatabase, ref, set, update, push, serverTimestamp, connectDatabaseEmulator, goOffline } from 'firebase/database';

const CODE = process.argv[2] || 'TEST26';
const PIN = process.argv[3] || '111111';
const NS = 'demo-concern-board-default-rtdb';
const N = 5, PER = 3, EDITS = 5;

async function helper(g) {
  const app = initializeApp({ apiKey: 'demo', projectId: 'demo-concern-board', databaseURL: `http://127.0.0.1:9000/?ns=${NS}` }, `h${g}`);
  const auth = getAuth(app); connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  const db = getDatabase(app); connectDatabaseEmulator(db, '127.0.0.1', 9000);
  const { user } = await signInAnonymously(auth);
  await set(ref(db, `access/${CODE}/helpers/${user.uid}`), { pin: PIN, group: g });
  const ids = [];
  for (let i = 0; i < PER; i++) {
    const id = push(ref(db, `sessions/${CODE}/items`)).key; ids.push(id);
    await set(ref(db, `sessions/${CODE}/items/${id}`), { text: `第${g}組-題${i}-v0`, cat: i % 2 ? 'cost' : 'impact', groups: { [g]: true }, rewritten: false, status: 'active', createdBy: user.uid, createdGroup: g, createdAt: serverTimestamp(), updatedAt: serverTimestamp(), updatedBy: user.uid });
  }
  // 連續修改（模擬打字後自動存檔），不等待前一次完成
  const writes = [];
  for (let e = 1; e <= EDITS; e++) for (const [i, id] of ids.entries()) writes.push(update(ref(db, `sessions/${CODE}/items/${id}`), { text: `第${g}組-題${i}-v${e}`, updatedAt: serverTimestamp() }));
  await Promise.all(writes);
  goOffline(db); await deleteApp(app);
  return ids;
}

const all = (await Promise.all(Array.from({ length: N }, (_, i) => helper(i + 1)))).flat();
const data = await (await fetch(`http://127.0.0.1:9000/sessions/${CODE}/items.json?ns=${NS}`, { headers: { Authorization: 'Bearer owner' } })).json();
let ok = 0; const bad = [];
for (const id of all) {
  const it = data[id];
  const m = it && /^第(\d)組-題(\d)-v(\d)$/.exec(it.text);
  if (m && m[3] === String(EDITS) && it.groups[m[1]] && it.status === 'active') ok++; else bad.push([id, it]);
}
console.log(`5 位小幫手同時輸入：${ok}/${all.length} 題正確（每題都是最後一次修改的內容、組別正確）`);
if (bad.length) { console.log('有問題的題目：', bad); process.exit(1); }
process.exit(0);
