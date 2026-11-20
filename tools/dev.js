// 本機預覽：啟動 Firebase emulator（資料庫＋登入）、放入示範資料、開啟網頁伺服器。
// 用法：npm run dev   （按 Ctrl+C 結束；資料只存在記憶體，結束後就消失）
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { startServer } from './serve.js';

const PROJECT = 'demo-concern-board';
const NS = `${PROJECT}-default-rtdb`;
const OWNER = 'BkEeFSDkL9YW98rv5qxFTgG06Lu1';
const config = JSON.parse(readFileSync(new URL('../config/templates/prmc-workshop.json', import.meta.url), 'utf8'));

const emu = spawn('npx', ['firebase', 'emulators:start', '--only', 'database,auth', '--project', PROJECT], { stdio: ['ignore', 'pipe', 'inherit'], shell: true });
emu.stdout.on('data', (d) => { const s = String(d); if (/error|錯誤/i.test(s)) process.stdout.write(s); });
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
console.log('擁有者管理：http://localhost:8000/#/admin（在跳出的視窗選「擁有者（測試）」）');
console.log('按 Ctrl+C 結束。');
