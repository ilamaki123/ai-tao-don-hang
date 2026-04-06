require('dotenv').config();
if (!globalThis.fetch) {
  const { fetch, FormData, Blob, Headers, Request, Response } = require('undici');
  globalThis.fetch = fetch;
  globalThis.FormData = FormData;
  globalThis.Blob = Blob;
  globalThis.Headers = Headers;
  globalThis.Request = Request;
  globalThis.Response = Response;
}
const express = require('express');
const cors = require('cors');
const Redis = require('ioredis');
const multer = require('multer');
const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');

const app = express();
const upload = multer({ storage: multer.memoryStorage() });
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ===== PRICE RULES =====
const RULES_FILE = path.join(__dirname, 'data', 'price-rules.json');
const HARDCODED_DEFAULTS = ['tommy.com', 'tommyhilfiger.com', 'usa.tommy.com'];
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const GIST_ID = process.env.GIST_ID || '';
const GIST_FILENAME = 'price-rules.json';

let rulesCache = null; // in-memory cache — loaded once on startup, 0ms on every request

async function loadRulesFromGist() {
  if (!GITHUB_TOKEN || !GIST_ID) return null;
  try {
    const res = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
      headers: { 'Authorization': `Bearer ${GITHUB_TOKEN}`, 'Accept': 'application/vnd.github.v3+json' },
    });
    const data = await res.json();
    const content = data.files?.[GIST_FILENAME]?.content;
    if (content) return JSON.parse(content);
  } catch (e) {
    console.error('[price-rules] Gist load error:', e.message);
  }
  return null;
}

async function saveRulesToGist(rules) {
  if (!GITHUB_TOKEN || !GIST_ID) return;
  try {
    await fetch(`https://api.github.com/gists/${GIST_ID}`, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ files: { [GIST_FILENAME]: { content: JSON.stringify(rules, null, 2) } } }),
    });
  } catch (e) {
    console.error('[price-rules] Gist save error:', e.message);
  }
}

function loadRules() {
  // Always return from in-memory cache (0ms) — populated by initRules() on startup
  if (rulesCache) return rulesCache;
  // Fallback if cache not ready yet
  try {
    const f = JSON.parse(fs.readFileSync(RULES_FILE, 'utf8'));
    if (Array.isArray(f.totalPriceDomains)) return f;
  } catch {}
  const fromEnv = process.env.TOTAL_PRICE_DOMAINS;
  if (fromEnv) return { totalPriceDomains: fromEnv.split(',').map(d => d.trim()).filter(Boolean) };
  return { totalPriceDomains: [...HARDCODED_DEFAULTS] };
}

async function saveRules(rules) {
  rulesCache = rules;
  // Save to local file (backup)
  try {
    const dir = path.dirname(RULES_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(RULES_FILE, JSON.stringify(rules, null, 2));
  } catch (e) {
    console.error('[price-rules] File save error:', e.message);
  }
  // Save to Gist async (don't block response)
  saveRulesToGist(rules);
  console.log(`[price-rules] Saved: [${rules.totalPriceDomains.join(', ')}]`);
}

async function initRules() {
  // 1. Try GitHub Gist (cloud, persistent)
  const fromGist = await loadRulesFromGist();
  if (fromGist) {
    rulesCache = fromGist;
    console.log(`[price-rules] Loaded from Gist: [${fromGist.totalPriceDomains.join(', ')}]`);
    return;
  }
  // 2. Try local file
  try {
    const f = JSON.parse(fs.readFileSync(RULES_FILE, 'utf8'));
    if (Array.isArray(f.totalPriceDomains)) {
      rulesCache = f;
      console.log(`[price-rules] Loaded from file: [${rulesCache.totalPriceDomains.join(', ')}]`);
      return;
    }
  } catch {}
  // 3. Env var or hardcoded defaults
  rulesCache = loadRules();
  console.log(`[price-rules] Loaded defaults: [${rulesCache.totalPriceDomains.join(', ')}]`);
}

// ===== HELP CONTENT =====
const HELP_GIST_FILENAME = 'help-content.md';
let helpCache = null;

const DEFAULT_HELP = `📖 **Hướng dẫn sử dụng**

**Bước 1:** Nhập số điện thoại khách hàng
**Bước 2:** Upload ảnh giỏ hàng + link sản phẩm (mỗi link 1 dòng)
**Bước 3:** Kiểm tra và chỉnh sửa giỏ hàng
**Bước 4:** Gõ "tạo đơn" để hoàn tất

**Các lệnh:**
• **xem** — xem giỏ hàng hiện tại
• **tạo đơn** — tạo đơn hàng
• **sửa #N qty/giá/tên/link: giá trị** — sửa sản phẩm
• **sửa #N size/color/fit/...: giá trị** — sửa variation
• **xóa #N** — xóa sản phẩm
• **sale 20%** — giảm giá cả đơn
• **sale #N 30%** — giảm giá riêng sản phẩm
• **bỏ sale #N** — bỏ giảm giá sản phẩm
• **bỏ giảm giá** — bỏ giảm giá cả đơn`;

async function loadHelpFromGist() {
  if (!GITHUB_TOKEN || !GIST_ID) return null;
  try {
    const res = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
      headers: { 'Authorization': `Bearer ${GITHUB_TOKEN}`, 'Accept': 'application/vnd.github.v3+json' },
    });
    const data = await res.json();
    const content = data.files?.[HELP_GIST_FILENAME]?.content;
    if (content) return content;
  } catch (e) {
    console.error('[help] Gist load error:', e.message);
  }
  return null;
}

async function saveHelpToGist(content) {
  if (!GITHUB_TOKEN || !GIST_ID) return;
  try {
    await fetch(`https://api.github.com/gists/${GIST_ID}`, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ files: { [HELP_GIST_FILENAME]: { content } } }),
    });
  } catch (e) {
    console.error('[help] Gist save error:', e.message);
  }
}

function getHelp() {
  return helpCache || DEFAULT_HELP;
}

async function saveHelp(content) {
  helpCache = content;
  saveHelpToGist(content);
  console.log('[help] Saved help content');
}

async function initHelp() {
  const fromGist = await loadHelpFromGist();
  if (fromGist) {
    helpCache = fromGist;
    console.log('[help] Loaded from Gist');
    return;
  }
  helpCache = DEFAULT_HELP;
  console.log('[help] Using defaults');
}

const BASSO_KEY = process.env.BASSO_API_KEY || '';
const BASSO_URL = process.env.BASSO_BASE_URL || '';
const IS_MOCK = !BASSO_KEY || BASSO_KEY === 'your-basso-key-here';
console.log('Mock mode:', IS_MOCK);

// token → user info map (in-memory, refreshed on login)
const tokenUserMap = new Map();

// ===== SESSION STORAGE (Redis) =====
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const redis = new Redis(REDIS_URL);
const SIXTY_DAYS_MS = 60 * 24 * 60 * 60 * 1000;
// No TTL — sessions persist until manually deleted. Only messages > 60 days are cleaned.

redis.on('connect', () => console.log('[redis] Connected to', REDIS_URL));
redis.on('error', (err) => console.error('[redis] Error:', err.message));

function resolveUser(req) {
  const token = (req.headers['authorization'] || '').replace('Bearer ', '').trim();
  if (token && tokenUserMap.has(token)) return tokenUserMap.get(token);
  const userId = req.headers['x-user-id'];
  if (userId) return { id: parseInt(userId) || userId, email: '', roles: [] };
  return null;
}

function sessionKey(userId) {
  return `sessions:${userId}`;
}

async function loadUserSessions(userId) {
  try {
    const raw = await redis.get(sessionKey(userId));
    if (!raw) return [];
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch (e) {
    console.error('[redis] loadUserSessions error:', e.message);
    return [];
  }
}

async function saveUserSessions(userId, sessions) {
  try {
    await redis.set(sessionKey(userId), JSON.stringify(sessions));
  } catch (e) {
    console.error('[redis] saveUserSessions error:', e.message);
  }
}

function cleanExpiredMessages(sessions) {
  const now = Date.now();
  let changed = false;
  for (const s of sessions) {
    if (!s.messages) continue;
    const before = s.messages.length;
    s.messages = s.messages.filter(m => !m.timestamp || (now - m.timestamp) < SIXTY_DAYS_MS);
    if (s.messages.length !== before) changed = true;
  }
  return changed;
}

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Strip /b/<id> prefix so routes match /api/*, /health, etc.
app.use((req, res, next) => {
  const m = req.path.match(/^\/b\/[^/]+(\/.*)/);
  if (m) req.url = m[1];
  next();
});

// Serve static files (PWA: manifest, sw.js, icons) from project root
app.use(express.static(path.join(__dirname, '..')));

// Helper: build Basso headers với auth token từ client
function bassoHeaders(req) {
  const auth = req.headers['authorization'] || '';
  return {
    'X-Partner-Api-Key': BASSO_KEY,
    ...(auth ? { 'Authorization': auth } : {}),
  };
}

// ===== HEALTH CHECK =====
app.get('/health', (req, res) => {
  res.json({ status: 'ok', mock: IS_MOCK });
});

// ===== GET ROLES BY TOKEN =====
app.get('/api/get-roles', (req, res) => {
  const user = resolveUser(req);
  if (!user) return res.json({ success: false, roles: [] });
  res.json({ success: true, roles: user.roles || [] });
});

// ===== PRICE RULES =====
app.get('/api/price-rules', (req, res) => {
  res.json({ success: true, data: loadRules() });
});

app.post('/api/price-rules', async (req, res) => {
  const auth = req.headers['authorization'] || '';
  if (!auth) return res.status(401).json({ success: false, message: 'Unauthorized' });

  const { action, domain } = req.body;
  const d = (domain || '').toLowerCase().trim();
  if (!d) return res.status(400).json({ success: false, message: 'Thiếu domain' });
  if (action !== 'add' && action !== 'remove') {
    return res.status(400).json({ success: false, message: 'action phải là add hoặc remove' });
  }

  const rules = loadRules();
  if (action === 'add') {
    if (!rules.totalPriceDomains.includes(d)) rules.totalPriceDomains.push(d);
  } else {
    rules.totalPriceDomains = rules.totalPriceDomains.filter(x => x !== d);
  }
  await saveRules(rules);
  res.json({ success: true, data: rules });
});

// ===== HELP CONTENT =====
app.get('/api/help', (req, res) => {
  res.json({ success: true, data: getHelp() });
});

app.post('/api/help', async (req, res) => {
  const auth = req.headers['authorization'] || '';
  if (!auth) return res.status(401).json({ success: false, message: 'Unauthorized' });
  const { content } = req.body;
  if (!content || !content.trim()) return res.status(400).json({ success: false, message: 'Thiếu nội dung help' });
  await saveHelp(content.trim());
  res.json({ success: true, data: getHelp() });
});

// ===== SESSIONS =====
app.get('/api/sessions', async (req, res) => {
  try {
    const user = resolveUser(req);
    if (!user) return res.status(401).json({ success: false, message: 'Unauthorized' });
    const sessions = await loadUserSessions(user.id);
    const changed = cleanExpiredMessages(sessions);
    if (changed) await saveUserSessions(user.id, sessions);
    console.log('[sessions] GET user:', user.id, 'count:', sessions.length);
    res.json({ success: true, data: sessions });
  } catch (err) {
    console.error('[sessions] GET error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/sessions', async (req, res) => {
  try {
    const user = resolveUser(req);
    if (!user) return res.status(401).json({ success: false, message: 'Unauthorized' });
    const { sessions } = req.body;
    if (!Array.isArray(sessions)) return res.status(400).json({ success: false, message: 'sessions must be array' });
    await saveUserSessions(user.id, sessions);
    console.log('[sessions] POST user:', user.id, 'count:', sessions.length);
    res.json({ success: true });
  } catch (err) {
    console.error('[sessions] POST error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

app.delete('/api/sessions/:id', async (req, res) => {
  try {
    const user = resolveUser(req);
    if (!user) return res.status(401).json({ success: false, message: 'Unauthorized' });
    const sessionId = parseInt(req.params.id);
    const sessions = await loadUserSessions(user.id);
    const filtered = sessions.filter(s => s.id !== sessionId);
    await saveUserSessions(user.id, filtered);
    console.log('[sessions] DELETE user:', user.id, 'sessionId:', sessionId);
    res.json({ success: true });
  } catch (err) {
    console.error('[sessions] DELETE error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ===== BASSO LOGIN =====
app.post('/api/basso-login', async (req, res) => {
  const { email, pass } = req.body;

  if (IS_MOCK) {
    const mockAccounts = [
      { id: 1, email: 'admin', pass: '123456', name: 'Admin' },
      { id: 2, email: 'vinh',  pass: '123456', name: 'Vinh Pham' },
    ];
    const found = mockAccounts.find(a => a.email === email && a.pass === pass);
    if (!found) {
      return res.json({ success: false, message: 'Sai email hoặc mật khẩu', data: [], errors: [] });
    }
    const mockToken = 'mock_token_' + Date.now();
    tokenUserMap.set(mockToken, { id: found.id, email: found.email, roles: ['manager'] });
    return res.json({
      success: true, message: 'Đăng nhập thành công',
      data: {
        user: { id: found.id, email: found.email, name: found.name, roles: ['manager'] },
        access_token: mockToken,
        token_type: 'Bearer',
        expires_at: Math.floor(Date.now() / 1000) + 86400,
      },
      _mock: true,
    });
  }

  try {
    const body = new URLSearchParams({ email, pass }).toString();
    console.log('[basso-login] calling:', `${BASSO_URL}/partner/login`);
    const response = await fetch(`${BASSO_URL}/partner/login`, {
      method: 'POST',
      headers: { 'X-Partner-Api-Key': BASSO_KEY, 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    console.log('[basso-login] status:', response.status);
    const rawText = await response.text();
    console.log('[basso-login] raw response:', rawText.substring(0, 500));
    let data;
    try {
      data = JSON.parse(rawText);
    } catch {
      return res.status(502).json({ success: false, message: 'Basso API trả về không phải JSON', raw: rawText.substring(0, 200) });
    }
    console.log('[basso-login] user object:', JSON.stringify(data?.data?.user));
    // Lưu token → user info
    if (data?.data?.access_token && data?.data?.user) {
      const u = data.data.user;
      tokenUserMap.set(data.data.access_token, { id: u.id, email: u.email || u.username, roles: u.roles || [] });
    }
    res.json(data);
  } catch (err) {
    console.error('[basso-login] error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ===== ANALYZE IMAGE =====
app.post('/api/analyze-image', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'Thiếu file ảnh' });
    }

    const imageBase64 = req.file.buffer.toString('base64');
    const mimeType = req.file.mimetype;

    // Parse links từ request (mỗi link 1 dòng)
    const linksRaw = req.body.links || '';
    const links = linksRaw.split('\n').map(l => l.trim()).filter(l => l.startsWith('http'));

    // Domain-specific pricing rules
    const rules = loadRules();
    const domain = links.length > 0 ? (() => { try { return new URL(links[0]).hostname.toLowerCase(); } catch { return ''; } })() : '';
    const isTotalPriceSite = rules.totalPriceDomains.some(d => domain.includes(d));
    console.log(`[analyze-image] domain="${domain}" isTotalPriceSite=${isTotalPriceSite} rules=[${rules.totalPriceDomains.join(', ')}]`);
    const priceRule = isTotalPriceSite
      ? `- price: QUAN TRỌNG - Website ${domain} hiển thị TỔNG GIÁ (tổng tiền cho toàn bộ quantity). Bắt buộc phải chia: price = số_tiền_hiển_thị / quantity để ra ĐƠN GIÁ. KHÔNG được dùng số tiền hiển thị trực tiếp làm price.`
      : `- price: LUÔN LUÔN là ĐƠN GIÁ (giá cho 1 sản phẩm). Nếu ảnh hiển thị tổng giá (ví dụ qty=5, hiển thị $165) thì chia ngược: price = 165/5 = 33. Nếu ảnh hiển thị đơn giá (ví dụ $33/item hoặc $33 each) thì giữ nguyên. Kiểm tra: quantity × price phải bằng tổng giá hiển thị trong ảnh.`;

    const response = await anthropic.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 2048,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: mimeType, data: imageBase64 },
            },
            {
              type: 'text',
              text: `Phân tích ảnh giỏ hàng này. Liệt kê TẤT CẢ sản phẩm theo thứ tự từ trên xuống dưới.

Với mỗi sản phẩm trích xuất:
- name: tên thương hiệu + tên sản phẩm
- quantity: số lượng (số nguyên)
${priceRule}
- currency: ký hiệu tiền tệ nhìn thấy trong ảnh (ví dụ: "$", "€", "£", "₩", "¥", "đ", "VND") — nếu không thấy để trống ""
- variations: mảng TẤT CẢ thuộc tính sản phẩm hiển thị (Size, Fit, Color, Waist, Length, Width, Type, Style, v.v.). Mỗi thuộc tính là 1 object {name, value}. Ví dụ "S Tall | Black" → [{name:"Size",value:"S"},{name:"Fit",value:"Tall"},{name:"Color",value:"Black"}]. Ví dụ "29W X 30L" → [{name:"Waist",value:"29W"},{name:"Length",value:"30L"}]. Width thường xuất hiện cùng Size dạng "8 Medium" hoặc chữ đơn N(Narrow)/B(Medium-women)/W(Wide)/M(Medium) → [{name:"Size",value:"8"},{name:"Width",value:"Medium"}].

Trả về JSON (chỉ JSON, không giải thích):
{
  "items": [
    {
      "name": "Tên thương hiệu - Tên sản phẩm",
      "quantity": 1,
      "price": 0,
      "currency": "$",
      "variations": [
        {"name": "Size", "value": "..."},
        {"name": "Color", "value": "..."}
      ]
    }
  ]
}`,
            },
          ],
        },
      ],
    });

    const text = response.content[0].text.trim();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return res.status(500).json({ success: false, message: 'Không thể trích xuất thông tin từ ảnh' });
    }

    const extracted = JSON.parse(jsonMatch[0]);

    // Map links theo thứ tự sản phẩm
    const items = (extracted.items || []).map((item, i) => ({
      ...item,
      link: links[i] || '',
    }));

    res.json({ success: true, data: { items } });

  } catch (err) {
    console.error('analyze-image error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ===== EXTRACT PRODUCT IMAGE COORDS =====
app.post('/api/extract-product-images', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, message: 'Thiếu file ảnh' });
    const imageBase64 = req.file.buffer.toString('base64');
    const mimeType = req.file.mimetype;
    const response = await anthropic.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mimeType, data: imageBase64 } },
          { type: 'text', text: `This is a shopping cart screenshot. For each product row, find the bounding box of ONLY the product photo (clothing/item thumbnail image, NOT text, price, buttons).
Return JSON only:
{
  "products": [
    {"index": 0, "xPct": 5.0, "yPct": 2.0, "widthPct": 15.0, "heightPct": 20.0}
  ]
}
Coordinates are percentages (0-100) of image dimensions. Order top to bottom.` }
        ]
      }]
    });
    const text = response.content[0].text.trim();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return res.status(500).json({ success: false, message: 'Cannot parse' });
    res.json({ success: true, data: JSON.parse(jsonMatch[0]) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ===== PROXY: TÌM KHÁCH HÀNG =====
app.get('/api/find-customer', async (req, res) => {
  const { phone } = req.query;

  if (IS_MOCK) {
    return res.json({
      success: true,
      data: {
        found: true,
        customer: {
          id: 1,
          name: 'Khách hàng Test',
          phone: phone,
          email: 'test@example.com',
          address: '123 Nguyễn Huệ',
          city_id: 1,
          district_id: 1,
          city: 'TP. Hồ Chí Minh',
          district: 'Quận 1',
        },
      },
      _mock: true,
    });
  }

  try {
    const response = await fetch(
      `${BASSO_URL}/partner/findCustomerByPhone?phone=${phone}`,
      { headers: bassoHeaders(req) }
    );
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ===== PROXY: UPLOAD ẢNH LÊN BASSO =====
app.post('/api/upload-image', upload.single('file'), async (req, res) => {
  if (IS_MOCK) {
    return res.json({ success: true, data: { id: null, path: null }, _mock: true });
  }

  try {
    // Use undici File (or Blob with name) for Node 16 compatibility
    const { File: UFile } = require('undici');
    const file = new UFile([req.file.buffer], req.file.originalname, { type: req.file.mimetype });
    const formData = new FormData();
    formData.append('file', file);

    const response = await fetch(`${BASSO_URL}/partner/uploadImage`, {
      method: 'POST',
      headers: bassoHeaders(req),
      body: formData,
    });
    const data = await response.json();
    console.log('[upload-image] Basso response:', JSON.stringify(data));
    res.json(data);
  } catch (err) {
    console.error('[upload-image] error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});


// ===== PROXY: TẠO ĐƠN HÀNG =====
app.post('/api/create-order', async (req, res) => {
  if (IS_MOCK) {
    return res.json({
      success: true,
      data: { orderId: 999999, orderCode: 'MOCK-' + Date.now() },
      _mock: true,
    });
  }

  try {
    const body = new URLSearchParams(req.body).toString();
    console.log('[create-order] items JSON:', req.body.items);
    console.log('[create-order] website:', req.body.website);
    const response = await fetch(`${BASSO_URL}/partner/createOrder`, {
      method: 'POST',
      headers: { ...bassoHeaders(req), 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const data = await response.json();
    console.log('[create-order] Basso response:', JSON.stringify(data));
    res.json(data);
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ===== PROXY: CHI TIẾT ĐƠN HÀNG =====
app.get('/api/get-order', async (req, res) => {
  const { order_code } = req.query;
  if (!order_code) return res.status(400).json({ success: false, message: 'Thiếu order_code' });
  if (IS_MOCK) {
    return res.json({ success: true, data: { order: { id: 999, code: order_code, status: 'pending' }, items: [
      { id: 101, name: 'Mock Product 1', link: 'https://example.com', quantity: 1, price: 10, term_id: 5, variations: [] },
      { id: 102, name: 'Mock Product 2', link: 'https://example.com', quantity: 2, price: 20, term_id: 5, variations: [] },
    ]}, _mock: true });
  }
  try {
    const response = await fetch(`${BASSO_URL}/partner/getOrderByCode?order_code=${encodeURIComponent(order_code)}`, { headers: bassoHeaders(req) });
    const data = await response.json();
    console.log('[get-order] Basso response:', JSON.stringify(data).substring(0, 500));
    res.json(data);
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ===== PROXY: CẬP NHẬT ĐƠN HÀNG =====
app.post('/api/update-order', async (req, res) => {
  if (IS_MOCK) { return res.json({ success: true, message: 'Mock: đã cập nhật', data: { order: { code: req.body.order_code } }, _mock: true }); }
  try {
    console.log('[update-order] Request body:', JSON.stringify(req.body).substring(0, 1000));
    const response = await fetch(`${BASSO_URL}/partner/updateOrder`, {
      method: 'POST', headers: { ...bassoHeaders(req), 'Content-Type': 'application/json' }, body: JSON.stringify(req.body),
    });
    const data = await response.json();
    console.log('[update-order] Basso response:', JSON.stringify(data).substring(0, 500));
    res.json(data);
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ===== PROXY: HỦY ĐƠN HÀNG =====
app.post('/api/cancel-order', async (req, res) => {
  const { order_code } = req.body;
  if (!order_code) return res.status(400).json({ success: false, message: 'Thiếu order_code' });
  if (IS_MOCK) { return res.json({ success: true, message: 'Mock: đã hủy', data: { order_status: 'cancelled' }, _mock: true }); }
  try {
    const response = await fetch(`${BASSO_URL}/partner/cancelOrder`, {
      method: 'POST', headers: { ...bassoHeaders(req), 'Content-Type': 'application/json' }, body: JSON.stringify({ order_code }),
    });
    const data = await response.json();
    console.log('[cancel-order] Basso response:', JSON.stringify(data).substring(0, 500));
    res.json(data);
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ===== START =====
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    initRules();
    initHelp();
  });
}

module.exports = app;
