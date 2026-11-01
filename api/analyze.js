const crypto = require('crypto');

const PROMPT = `你是台灣國中數學老師。圖片或檔案中可能有雜訊（頁首頁尾、其他題目、手寫筆跡、廣告、浮水印），請只找出「一大題」完整題目（含題幹、圖形說明、選項或小題），忽略雜訊。若有圖形，請用文字說明圖形的重要資訊。
然後以國中（7～9 年級）範圍內的方法，像老師在黑板上解題，拆成 3 到 6 個步驟，嚴禁使用高中以上的方法（如微積分、三角函數公式、向量、矩陣等）。
只輸出 JSON，格式：
{"problem":"完整題目，數學式用 $...$",
 "topic":"單元名稱，如 一元二次方程式",
 "steps":[{"title":"步驟標題，如 步驟1：找出已知條件",
   "board":["黑板上要寫的每一行，數學式用 LaTeX 並以 $...$ 包起來，適度換行，每行不要太長"],
   "speech":"老師口語講解，100~220字"}],
 "meta":{"board":["本題學科重點與後設認知，2~4行，例如：這題的關鍵概念、常見錯誤、如何判斷用這個方法"],
   "speech":"用口語補充這題的學科重點與解題思維、提醒學生下次遇到類似題要怎麼想"}}
規則：
1. board 要像板書：簡潔、有計算過程，不要把 speech 的話直接寫上去。
2. speech 是「講解」不是唸板書：要有老師的語氣，例如「我們先來看看題目在問什麼」「注意喔，這裡很多同學會粗心」，解釋為什麼這樣做。
3. speech 裡不要出現 LaTeX 或符號，數學式要改用中文口語念出來，例如 x 的平方加 3x 減 4 等於 0、二分之一、根號 3。
4. 全部使用繁體中文（台灣用語）。最後一步要得出答案並檢驗。
5. 若這一大題含 (1)(2) 等小題，把它們視為同一題：problem 要完整列出所有小題；steps 依小題順序安排（例如先講共同方法，再分別示範 (1)、(2)），title 標明小題，總步驟仍不超過 6 步，最後一步要寫出所有小題答案。
6. JSON 字串中的 LaTeX 反斜線必須寫成雙反斜線，例如 "$\\\\frac{1}{2}$"。`;

// 模型清單：依序嘗試。可用環境變數 GEMINI_MODELS（逗號分隔）覆蓋
const MODELS = (process.env.GEMINI_MODELS || 'gemini-3.6-flash,gemini-3.5-flash,gemini-3.1-flash-lite')
  .split(',').map(s => s.trim()).filter(Boolean);

const ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
const hits = new Map(); // 簡易流量限制（每個伺服器實例各自計算，屬於盡力而為）

function limited(ip) {
  const now = Date.now(), W = 3600e3, MAX = +process.env.RATE_LIMIT_PER_HOUR || 30;
  const a = (hits.get(ip) || []).filter(t => now - t < W);
  if (a.length >= MAX) { hits.set(ip, a); return true; }
  a.push(now); hits.set(ip, a);
  if (hits.size > 5000) hits.clear();
  return false;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// 修復模型沒有把 LaTeX 反斜線跳脫好造成的壞字元
const fixStr = s => s.replace(/\f/g, '\\f').replace(/\t/g, '\\t').replace(/\x08/g, '\\b')
  .replace(/\r/g, '\\r').replace(/\n(?=eq|ot\b)/g, '\\n');
const fixAll = o => typeof o === 'string' ? fixStr(o)
  : Array.isArray(o) ? o.map(fixAll)
  : (o && typeof o === 'object') ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k, fixAll(v)]))
  : o;

function parseModelText(t) {
  try { return JSON.parse(t); } catch (e) {
    return JSON.parse(t.replace(/\\(?!["\\\/bfnrtu])/g, '\\\\'));
  }
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const KEY = process.env.GEMINI_API_KEY;
  const CODE = process.env.ACCESS_CODE || '';

  if (req.method === 'GET') return res.status(200).json({ needCode: !!CODE });
  if (req.method !== 'POST') return res.status(405).json({ error: '不支援的請求方式。' });
  if (!KEY) return res.status(500).json({ error: '伺服器尚未設定 GEMINI_API_KEY。' });

  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  if (limited(ip)) return res.status(429).json({ error: '今天使用太頻繁了，請稍後再試。' });

  const { mime, b64, code } = req.body || {};
  if (CODE) {
    const a = Buffer.from(String(code || '')), b = Buffer.from(CODE);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b))
      return res.status(401).json({ error: '存取碼不正確。' });
  }
  if (!ALLOWED_MIME.includes(mime) || typeof b64 !== 'string' || !b64)
    return res.status(400).json({ error: '檔案格式不支援，請上傳圖片或 PDF。' });
  if (b64.length > 4e6)
    return res.status(413).json({ error: '檔案太大，請縮小圖片或截圖題目範圍。' });

  const body = {
    contents: [{ parts: [{ text: PROMPT }, { inline_data: { mime_type: mime, data: b64 } }] }],
    generationConfig: { responseMimeType: 'application/json', temperature: 0.4, maxOutputTokens: 16384 }
  };

  let j = null, lastErr = '';
  outer: for (const m of MODELS) {
    for (let a = 1; a <= 2; a++) {
      try {
        const r = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(m)}:generateContent`,
          { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': KEY }, body: JSON.stringify(body) });
        const x = await r.json().catch(() => ({}));
        if (r.ok) { j = x; break outer; }
        lastErr = (x.error && x.error.message) || ('API 錯誤 ' + r.status);
        console.error('Gemini', m, r.status, lastErr);
        if (r.status === 404) break;                       // 模型不存在 → 換下一個
        if (![429, 500, 503, 504].includes(r.status))      // 其他錯誤（如 Key 錯誤）不重試
          return res.status(502).json({ error: 'AI 服務回報錯誤：' + lastErr });
      } catch (e) { lastErr = '連線失敗'; console.error('fetch failed', e.message); }
      if (a < 2) await sleep(2000);
    }
  }
  if (!j) return res.status(503).json({ error: 'AI 伺服器目前忙碌，請稍等一兩分鐘再試。（' + lastErr + '）' });

  const cand = j.candidates && j.candidates[0];
  const text = ((cand && cand.content && cand.content.parts) || []).filter(p => !p.thought)
    .map(p => p.text || '').join('').replace(/^\s*```(?:json)?|```\s*$/g, '').trim();
  if (!text) return res.status(502).json({ error: '模型沒有回傳內容（' + ((j.promptFeedback && j.promptFeedback.blockReason) || (cand && cand.finishReason) || '未知原因') + '），請換一張更清楚的圖片。' });

  let d;
  try { d = fixAll(parseModelText(text)); }
  catch (e) { return res.status(502).json({ error: '模型回傳的格式無法解析，請再按一次。' }); }
  if (!d || !Array.isArray(d.steps) || !d.steps.length)
    return res.status(422).json({ error: '沒有找到題目，請換一張更清楚、只含一題的圖片。' });
  return res.status(200).json(d);
};
