// 本機預覽：啟動 Firebase emulator（資料庫＋登入）、放入示範資料、開啟網頁伺服器。
// 用法：npm run dev   （按 Ctrl+C 結束；資料只存在記憶體，結束後就消失）
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { startServer } from './serve.js';

const PROJECT = 'demo-concern-board';
const NS = `${PROJECT}-default-rtdb`;
const OWNER = 'BkEeFSDkL9YW98rv5qxFTgG06Lu1';
const config = JSON.parse(readFileSync(new URL('../config/templates/prmc-workshop.json', import.meta.url), 'utf8'));

// 先確認需要的連接埠都沒有被占用（最常見的原因：另一個視窗已經在執行 npm run dev）
import { createServer } from 'node:net';
const portFree = (port) => new Promise((ok) => {
  const s = createServer().once('error', () => ok(false)).once('listening', () => s.close(() => ok(true))).listen(port, '127.0.0.1');
});
const busy = [];
for (const [port, what] of [[8000, '網頁'], [9000, '模擬資料庫'], [9099, '模擬登入']]) if (!(await portFree(port))) busy.push(`${port}（${what}）`);
if (busy.length) {
  console.log(`\n無法啟動：連接埠 ${busy.join('、')} 已經被占用。`);
  console.log('通常是另一個視窗已經在執行 npm run dev——如果是，直接打開 http://localhost:8000/ 就可以用了。');
  console.log('如果要重新啟動，請先到那個視窗按 Ctrl+C 結束，再執行一次 npm run dev。\n');
  process.exit(1);
}

const emu = spawn(`npx firebase emulators:start --only database,auth --project ${PROJECT}`, { stdio: ['ignore', 'pipe', 'inherit'], shell: true });
emu.stdout.on('data', (d) => { const s = String(d); if (/error|錯誤/i.test(s)) process.stdout.write(s); });
emu.on('exit', (code) => { if (code) { console.log(`\nemulator 意外結束（代碼 ${code}），請把上面的訊息貼給 Claude。`); process.exit(1); } });
const stop = () => { try { emu.kill(); } catch { /* ignore */ } process.exit(0); };
process.on('SIGINT', stop); process.on('SIGTERM', stop);

async function waitFor(url) {
  for (let i = 0; i < 120; i++) {
    try { await fetch(url); return; } catch { await new Promise((r) => setTimeout(r, 1000)); }
  }
  throw new Error(`等不到 ${url}`);
}
const admin = { Authorization: 'Bearer owner', 'Content-Type': 'application/json' };
const put = (path, body) => fetch(`http://127.0.0.1:9000/${path}.json?ns=${NS}`, { method: 'PUT', headers: admin, body: JSON.stringify(body) });

console.log('啟動 emulator 中（第一次可能要 30 秒）…');
await waitFor(`http://127.0.0.1:9000/.json?ns=${NS}`);
await waitFor('http://127.0.0.1:9099/');

// 擁有者的測試帳號（UID 和正式擁有者相同，只存在 emulator）
await fetch(`http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/projects/${PROJECT}/accounts:batchCreate`, {
  method: 'POST', headers: admin,
  body: JSON.stringify({ users: [{ localId: OWNER, email: 'owner@example.com', displayName: '擁有者（測試）', emailVerified: true,
    providerUserInfo: [{ providerId: 'google.com', rawId: 'owner-google-id', email: 'owner@example.com', displayName: '擁有者（測試）' }] }] }),
});

// 示範場次 TEST26：進行中、收集階段；小幫手 PIN 111111、主持人 PIN 222222
const now = Date.now();
await put('sessions/TEST26', {
  meta: { title: '示範場次（本機）', visibility: 'live', templateId: 'prmc-workshop', schemaVersion: 1, config,
    phase: { index: 0, type: 'collect' }, groupCount: 5, createdAt: now, updatedAt: now },
  items: {
    demo1: { text: '客戶真的會為這個功能付費嗎？', cat: 'impact', groups: { 1: true }, rewritten: false, status: 'active', createdBy: 'seed', createdGroup: 1, createdAt: now, updatedAt: now, updatedBy: 'seed' },
    demo2: { text: '需要額外的測試設備，預算從哪裡來？', cat: 'cost', groups: { 2: true }, rewritten: true, status: 'active', createdBy: 'seed', createdGroup: 2, createdAt: now + 1, updatedAt: now, updatedBy: 'seed' },
  },
});
await put('secrets/TEST26', { helperPin: '111111', hostPin: '222222' });

await startServer(8000);
console.log('示範場次代碼：TEST26（小幫手 PIN 111111、主持人 PIN 222222）');
console.log('擁有者管理：http://localhost:8000/#/admin（按「用 Google 登入」會直接登入測試擁有者）');
console.log('按 Ctrl+C 結束。');
