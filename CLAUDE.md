# CLAUDE.md｜concern-board（關注點共編投票工具）

## 你在做什麼
為 PrMC「3.成案期決策演練工作坊」（2026/12/11）開發一個即時共編與投票的網頁工具，並保留日後重複使用、改成其他活動的彈性。
**唯一的規格來源：`docs/spec.md`**（關注點共編投票工具_規格_v1.0）。動手前先讀 Part B。

## 鐵則
1. **決策紀錄 T1～T22、R1～R6 不得自行重新詮釋。** 發現規格有問題時，停下來向 Mike 說明並提出建議，經同意後先改 `docs/spec.md` 的決策紀錄，再改程式。
2. 業務規則只能寫在 `logic.js`（純函式），畫面只能呼叫它。
3. PIN 不能出現在任何能被讀到的路徑，也不能存進 localStorage。JSON 匯出不包含 `access` 和 `secrets`。
4. 不新增外部網域。只能使用：gstatic（Firebase SDK 10.12.0）、cdn.sheetjs.com（0.20.3）、`*.firebaseio.com`、googleapis。QR code 套件要內嵌。
5. 不需要 build：靜態的 `index.html`、`app.js`、`logic.js`，直接用 GitHub Pages 發布。
6. 介面用繁體中文（台灣用語）。

## 專案結構
```
index.html            # 畫面骨架與樣式；依 #/ 路由切換畫面
app.js                # 畫面邏輯、Firebase 讀寫、即時存檔、匯出入
logic.js              # 純函式：tally、rankCompetition、maxVotes、mergeItems、unmerge、validateConfig、匯出入轉換、nextPhase、dupNameWarnings
vendor/qrcode.js      # 內嵌的 QR code 套件
config/templates/prmc-workshop.json
database.rules.json   # 安全規則；OWNER_UID 由 Mike 提供
firebase.json, .firebaserc
tests/golden.test.js  # G1～G9
tests/rules.test.js   # 權限測試（emulator）
docs/spec.md          # 規格
docs/release-notes.md # 每個版本的 release note
```

## 常用指令
```bash
npm install                                   # 只安裝測試用的 dev 依賴
npx firebase emulators:start --only database,auth
node --test tests/golden.test.js
npx firebase emulators:exec --only database,auth "node --test tests/rules.test.js"
npx firebase deploy --only database           # 部署安全規則（要先經 Mike 同意）
python3 -m http.server 8000                   # 在本機預覽 index.html
```

## 工作流程
- 依 `docs/spec.md` B9 的分版開發，**一次一個版本**，每個版本開一個分支（`v0.1`、`v0.2`…）。
- 每個版本完成後：
  1. 跑 golden test 和權限測試，全部通過；
  2. 依 B8 做實機檢查（多分頁、手機尺寸）；
  3. 在 `docs/release-notes.md` 寫 release note（新增、修改、已知限制、驗證結果）；
  4. 向 Mike 報告，**經同意後**才合併進 main、`git push`、部署安全規則。
- 刪除檔案、強制推送、更動 Firebase 專案設定之前，一律先問 Mike。

## 環境資訊（由 Mike 在設定步驟中提供）
- Firebase config：（貼在 `app.js` 開頭的 `FIREBASE_CONFIG`；Web API key 本來就公開，不是密鑰）
- OWNER_UID：（替換 `database.rules.json` 裡的 `OWNER_UID`）
- GitHub Pages 網址：`https://<帳號>.github.io/concern-board/`
- 公司網路已驗證（2026/11/19）：github.io、gstatic、firebaseio、googleapis、cdn.sheetjs.com 都能連線，即時連線也正常
