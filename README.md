# 數學語音家教（公開部署版）

API Key 只存在伺服器環境變數，瀏覽器看不到。

## 檔案
- `index.html`：前端網頁
- `api/analyze.js`：後端（呼叫 Gemini，Key 從環境變數讀取, teach4needs a/c）
- `vercel.json`：函式最長執行 60 秒

## 部署到 Vercel
1. 把整個資料夾上傳到 GitHub 新儲存庫（`.env` 不要上傳，已在 .gitignore）。
2. Vercel → Add New Project → 匯入該儲存庫，Framework 選 Other，直接 Deploy。
3. 專案 Settings → Environment Variables 新增：
   - `GEMINI_API_KEY`：你的 Gemini Key（必填，勾選 Production / Preview）
   - `ACCESS_CODE`：全班共用的存取碼（建議設定；留空則任何人都能使用）
   - `GEMINI_MODELS`：（選填）模型順序，逗號分隔
   - `RATE_LIMIT_PER_HOUR`：（選填）每個 IP 每小時上限，預設 30
4. 新增或修改環境變數後，必須到 Deployments 按 Redeploy 才會生效。

## 費用與安全
- 在 Google AI Studio / Cloud Console 為這把 Key 設定用量上限與預算提醒。
- 這把 Key 專供本網站使用，不要同時用在其他地方，外洩時可直接停用重發。
- 若 Key 曾貼在聊天或公開程式碼中，請視為外洩並重新產生。
