require('dotenv').config();
const express = require('express');
const cors = require('cors');
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

const BASSO_KEY = process.env.BASSO_API_KEY || '';
const BASSO_URL = process.env.BASSO_BASE_URL || '';
const IS_MOCK = !BASSO_KEY || BASSO_KEY === 'your-basso-key-here';
console.log('Mock mode:', IS_MOCK);

// token → roles map (in-memory, reset on server restart but refreshed on next login)
const tokenRolesMap = new Map();

app.use(cors());
app.use(express.json());

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
  const auth = (req.headers['authorization'] || '').replace('Bearer ', '').trim();
  if (!auth) return res.json({ success: false, roles: [] });
  const roles = tokenRolesMap.get(auth) || [];
  res.json({ success: true, roles });
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

// ===== BASSO LOGIN =====
app.post('/api/basso-login', async (req, res) => {
  const { email, pass } = req.body;

  if (IS_MOCK) {
    const mockAccounts = [
      { email: 'admin', pass: '123456', name: 'Admin' },
      { email: 'vinh',  pass: '123456', name: 'Vinh Pham' },
    ];
    const found = mockAccounts.find(a => a.email === email && a.pass === pass);
    if (!found) {
      return res.json({ success: false, message: 'Sai email hoặc mật khẩu', data: [], errors: [] });
    }
    return res.json({
      success: true, message: 'Đăng nhập thành công',
      data: {
        user: { id: 1, email: found.email, name: found.name, roles: ['manager'] },
        access_token: 'mock_token_' + Date.now(),
        token_type: 'Bearer',
        expires_at: Math.floor(Date.now() / 1000) + 86400,
      },
      _mock: true,
    });
  }

  try {
    const body = new URLSearchParams({ email, pass }).toString();
    const response = await fetch(`${BASSO_URL}/partner/login`, {
      method: 'POST',
      headers: { 'X-Partner-Api-Key': BASSO_KEY, 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const data = await response.json();
    console.log('[basso-login] user object:', JSON.stringify(data?.data?.user));
    // Lưu token → roles để client có thể fetch sau
    if (data?.data?.access_token && data?.data?.user?.roles) {
      tokenRolesMap.set(data.data.access_token, data.data.user.roles);
    }
    res.json(data);
  } catch (err) {
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
    const formData = new FormData();
    const blob = new Blob([req.file.buffer], { type: req.file.mimetype });
    formData.append('file', blob, req.file.originalname);

    const response = await fetch(`${BASSO_URL}/partner/uploadImage`, {
      method: 'POST',
      headers: bassoHeaders(req),
      body: formData,
    });
    const data = await response.json();
    console.log('[upload-image] Basso response:', JSON.stringify(data));
    res.json(data);
  } catch (err) {
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

// ===== START =====
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    initRules(); // Load price rules into memory (async, non-blocking)
  });
}

module.exports = app;
