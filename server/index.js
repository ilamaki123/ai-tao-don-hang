require('dotenv').config();
const express = require('express');
const cors = require('cors');
const mysql = require('mysql2/promise');
const multer = require('multer');
const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');

const app = express();
const upload = multer({ storage: multer.memoryStorage() });
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ===== PRICE RULES + HELP (MySQL) =====
let rulesCache = null;
let helpCache = null;

const DEFAULT_RULES = ['usa.tommy.com','calvinklein.us','6pm.com','adidas.com','ashford.com','belk.com','carters.com','clarks.com','coach.com','colehaan.com','converse.com','crocs.com','dsw.com','ebay.com','jomashop.com','kiehls.com','nike.com','us.puma.com','pumagolf.com','ralphlauren.com','saksfifthavenue.com','shop.samsonite.com','sephora.com','skechers.com','swarovski.com','levi.com','ulta.com','walmart.com','wilson.com','zappos.com','zara.com','victoriassecret.com','lacoste.com'];

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

async function initConfigTables() {
  try {
    const db = await getDb();
    await db.execute(`
      CREATE TABLE IF NOT EXISTS app_config (
        config_key VARCHAR(100) PRIMARY KEY,
        config_value LONGTEXT,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    // Seed defaults if empty
    const [rows] = await db.execute("SELECT config_key FROM app_config WHERE config_key IN ('price_rules','help_content')");
    const keys = rows.map(r => r.config_key);
    if (!keys.includes('price_rules')) {
      await db.execute("INSERT INTO app_config (config_key, config_value) VALUES ('price_rules', ?)", [JSON.stringify(DEFAULT_RULES)]);
    }
    if (!keys.includes('help_content')) {
      await db.execute("INSERT INTO app_config (config_key, config_value) VALUES ('help_content', ?)", [DEFAULT_HELP]);
    }
    console.log('[config] MySQL tables ready');
  } catch (e) {
    console.error('[config] Init error:', e.message);
  }
}

function loadRules() {
  if (rulesCache) return rulesCache;
  return { totalPriceDomains: [...DEFAULT_RULES] };
}

async function initRules() {
  try {
    const db = await getDb();
    const [rows] = await db.execute("SELECT config_value FROM app_config WHERE config_key = 'price_rules'");
    if (rows.length > 0) {
      const domains = JSON.parse(rows[0].config_value);
      rulesCache = { totalPriceDomains: Array.isArray(domains) ? domains : DEFAULT_RULES };
    } else {
      rulesCache = { totalPriceDomains: [...DEFAULT_RULES] };
    }
    console.log(`[price-rules] Loaded: [${rulesCache.totalPriceDomains.join(', ')}]`);
  } catch (e) {
    console.error('[price-rules] Load error:', e.message);
    rulesCache = { totalPriceDomains: [...DEFAULT_RULES] };
  }
}

async function saveRules(rules) {
  rulesCache = rules;
  try {
    const db = await getDb();
    await db.execute("UPDATE app_config SET config_value = ? WHERE config_key = 'price_rules'", [JSON.stringify(rules.totalPriceDomains)]);
    console.log(`[price-rules] Saved: [${rules.totalPriceDomains.join(', ')}]`);
  } catch (e) {
    console.error('[price-rules] Save error:', e.message);
  }
}

function getHelp() {
  return helpCache || DEFAULT_HELP;
}

async function initHelp() {
  try {
    const db = await getDb();
    const [rows] = await db.execute("SELECT config_value FROM app_config WHERE config_key = 'help_content'");
    if (rows.length > 0 && rows[0].config_value) {
      helpCache = rows[0].config_value;
    } else {
      helpCache = DEFAULT_HELP;
    }
    console.log('[help] Loaded from MySQL');
  } catch (e) {
    console.error('[help] Load error:', e.message);
    helpCache = DEFAULT_HELP;
  }
}

async function saveHelp(content) {
  helpCache = content;
  try {
    const db = await getDb();
    await db.execute("UPDATE app_config SET config_value = ? WHERE config_key = 'help_content'", [content]);
    console.log('[help] Saved to MySQL');
  } catch (e) {
    console.error('[help] Save error:', e.message);
  }
}

const BASSO_KEY = process.env.BASSO_API_KEY || '';
const BASSO_URL = process.env.BASSO_BASE_URL || '';
const IS_MOCK = !BASSO_KEY || BASSO_KEY === 'your-basso-key-here';
console.log('Mock mode:', IS_MOCK);

// token → user info map (in-memory, refreshed on login)
const tokenUserMap = new Map();

// ===== SESSION STORAGE (MySQL) =====
const SIXTY_DAYS_MS = 60 * 24 * 60 * 60 * 1000;
let dbPool = null;

async function getDb() {
  if (!dbPool) {
    dbPool = mysql.createPool({
      host: process.env.MYSQL_HOST || 'localhost',
      port: parseInt(process.env.MYSQL_PORT) || 3306,
      user: process.env.MYSQL_USER || 'root',
      password: process.env.MYSQL_PASSWORD || '',
      database: process.env.MYSQL_DATABASE || 'basso_platform',
      waitForConnections: true,
      connectionLimit: 5,
      charset: 'utf8mb4',
    });
    // Auto-create table if not exists
    await dbPool.execute(`
      CREATE TABLE IF NOT EXISTS user_sessions (
        id BIGINT PRIMARY KEY,
        user_id INT NOT NULL,
        title VARCHAR(255) DEFAULT '',
        date VARCHAR(50) DEFAULT '',
        state VARCHAR(50) DEFAULT 'INIT',
        customer_id INT DEFAULT NULL,
        customer_json LONGTEXT DEFAULT NULL,
        items_json LONGTEXT DEFAULT NULL,
        messages_json LONGTEXT DEFAULT NULL,
        sale_pct FLOAT DEFAULT 0,
        editing_order_json LONGTEXT DEFAULT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_user_id (user_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    console.log('[mysql] Connected to', process.env.MYSQL_HOST || 'localhost');
  }
  return dbPool;
}

function resolveUser(req) {
  const token = (req.headers['authorization'] || '').replace('Bearer ', '').trim();
  if (token && tokenUserMap.has(token)) return tokenUserMap.get(token);
  const userId = req.headers['x-user-id'];
  if (userId) return { id: parseInt(userId) || userId, email: '', roles: [] };
  return null;
}

async function loadUserSessions(userId) {
  try {
    const db = await getDb();
    const [rows] = await db.execute('SELECT * FROM user_sessions WHERE user_id = ? ORDER BY updated_at DESC', [userId]);
    return rows.map(row => {
      const session = {
        id: Number(row.id),
        title: row.title || '',
        date: row.date || '',
        state: row.state || 'INIT',
        customer: row.customer_json ? JSON.parse(row.customer_json) : null,
        items: row.items_json ? JSON.parse(row.items_json) : [],
        messages: row.messages_json ? JSON.parse(row.messages_json) : [],
        salePct: row.sale_pct || 0,
        editingOrder: row.editing_order_json ? JSON.parse(row.editing_order_json) : undefined,
        cartImages: [],
      };
      return session;
    });
  } catch (e) {
    console.error('[mysql] loadUserSessions error:', e.message);
    return [];
  }
}

async function saveUserSessions(userId, sessions) {
  try {
    const db = await getDb();
    for (const s of sessions) {
      const customerId = s.customer?.id || null;
      await db.execute(`
        INSERT INTO user_sessions (id, user_id, title, date, state, customer_id, customer_json, items_json, messages_json, sale_pct, editing_order_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          title=VALUES(title), date=VALUES(date), state=VALUES(state),
          customer_id=VALUES(customer_id), customer_json=VALUES(customer_json),
          items_json=VALUES(items_json), messages_json=VALUES(messages_json),
          sale_pct=VALUES(sale_pct), editing_order_json=VALUES(editing_order_json)
      `, [
        s.id,
        userId,
        s.title || '',
        s.date || '',
        s.state || 'INIT',
        customerId,
        s.customer ? JSON.stringify(s.customer) : null,
        JSON.stringify(s.items || []),
        JSON.stringify(s.messages || []),
        s.salePct || 0,
        s.editingOrder ? JSON.stringify(s.editingOrder) : null,
      ]);
    }
    // Delete sessions not in the list (user deleted them)
    if (sessions.length > 0) {
      const ids = sessions.map(s => s.id);
      const placeholders = ids.map(() => '?').join(',');
      await db.execute(`DELETE FROM user_sessions WHERE user_id = ? AND id NOT IN (${placeholders})`, [userId, ...ids]);
    } else {
      await db.execute('DELETE FROM user_sessions WHERE user_id = ?', [userId]);
    }
  } catch (e) {
    console.error('[mysql] saveUserSessions error:', e.message);
  }
}

async function deleteUserSession(userId, sessionId) {
  try {
    const db = await getDb();
    await db.execute('DELETE FROM user_sessions WHERE user_id = ? AND id = ?', [userId, sessionId]);
  } catch (e) {
    console.error('[mysql] deleteUserSession error:', e.message);
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

// Request logger — log mọi API call
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    const status = res.statusCode;
    if (status >= 400 || ms > 10000) {
      console.log(`[${status >= 400 ? 'ERROR' : 'SLOW'}] ${req.method} ${req.originalUrl || req.url} ${status} ${ms}ms`);
    }
  });
  next();
});

// Strip /b/<id> prefix so routes match /api/*, /health, etc.
app.use((req, res, next) => {
  const m = req.url.match(/^\/b\/[^/]+(\/.*)/);
  if (m) {
    console.log('[strip-prefix]', req.url, '->', m[1]);
    req.url = m[1];
    req.originalUrl = m[1];
  }
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

async function handleSaveSessions(req, res) {
  try {
    const user = resolveUser(req);
    if (!user) return res.status(401).json({ success: false, message: 'Unauthorized' });
    const { sessions } = req.body;
    if (!Array.isArray(sessions)) return res.status(400).json({ success: false, message: 'sessions must be array' });
    await saveUserSessions(user.id, sessions);
    console.log('[sessions] SAVE user:', user.id, 'count:', sessions.length);
    res.json({ success: true });
  } catch (err) {
    console.error('[sessions] SAVE error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
}
app.post('/api/sessions', handleSaveSessions);
app.put('/api/sessions', handleSaveSessions);

app.delete('/api/sessions/:id', async (req, res) => {
  try {
    const user = resolveUser(req);
    if (!user) return res.status(401).json({ success: false, message: 'Unauthorized' });
    const sessionId = parseInt(req.params.id);
    await deleteUserSession(user.id, sessionId);
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
      model: 'claude-sonnet-4-20250514',
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
              text: `Trích xuất thông tin sản phẩm từ ảnh và trả về JSON THUẦN (không markdown, không code fence, không giải thích).

Ảnh có thể là:
- Giỏ hàng: lấy TẤT CẢ sản phẩm từ trên xuống dưới.
- Trang chi tiết sản phẩm: chỉ lấy sản phẩm chính đang được chọn (viền xanh/đỏ/đậm). Bỏ qua "gợi ý", "customers also bought".
- Ảnh sản phẩm đơn lẻ (chỉ hình + tên, không giá): tạo 1 sản phẩm với price=0, quantity=1.

Mỗi sản phẩm gồm:
- name: thương hiệu + tên sản phẩm
- quantity: số nguyên, mặc định 1
${priceRule}
- currency: ký hiệu tiền ("$", "€", "£", "₩", "¥", "đ", "VND"), không thấy để ""
- variations: mảng, LUÔN có Size và Color (value="" nếu không thấy). Thêm thuộc tính khác nếu có (Fit, Waist, Length, Width, Type, Style).

Nếu ảnh không chứa sản phẩm nào, trả về {"items":[]}.

Định dạng trả về duy nhất:
{"items":[{"name":"","quantity":1,"price":0,"currency":"","variations":[{"name":"Size","value":""},{"name":"Color","value":""}]}]}`,
            },
          ],
        },
      ],
    });

    const rawText = (response.content || []).map(c => c.text || '').join('\n').trim();
    console.log('[analyze-image] raw response:', rawText.slice(0, 2000));
    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.error('[analyze-image] no JSON in response. Full text:', rawText);
      return res.status(500).json({ success: false, message: 'Không thể trích xuất thông tin từ ảnh', debug: rawText.slice(0, 500) });
    }

    let extracted;
    try {
      extracted = JSON.parse(jsonMatch[0]);
    } catch (parseErr) {
      console.error('[analyze-image] JSON parse failed:', parseErr.message);
      console.error('[analyze-image] JSON candidate:', jsonMatch[0].slice(0, 2000));
      return res.status(500).json({ success: false, message: 'JSON không hợp lệ: ' + parseErr.message, debug: jsonMatch[0].slice(0, 500) });
    }

    const items = (extracted.items || []).map((item, i) => ({
      ...item,
      link: links[i] || '',
    }));
    console.log('[analyze-image] extracted', items.length, 'items');

    res.json({ success: true, data: { items } });

  } catch (err) {
    console.error('[analyze-image] error:', err.message, err.stack);
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
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mimeType, data: imageBase64 } },
          { type: 'text', text: `This is a shopping cart/bag screenshot from an online store. For each product listed, find the bounding box of the product image/thumbnail/photo. This could be any type of product: clothing, shoes, cosmetics, skincare, electronics, food, accessories, etc. Look for the visual product image (jar, bottle, box, clothing item, device, etc.), NOT icons, buttons, badges, or text.
Return JSON only:
{
  "products": [
    {"index": 0, "xPct": 5.0, "yPct": 2.0, "widthPct": 15.0, "heightPct": 20.0}
  ]
}
Coordinates are percentages (0-100) of image dimensions. Order top to bottom. Include ALL product images visible.` }
        ]
      }]
    });
    const text = response.content[0].text.trim();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return res.status(500).json({ success: false, message: 'Cannot parse' });
    res.json({ success: true, data: JSON.parse(jsonMatch[0]) });
  } catch (err) {
    console.error('[extract-product-images] error:', err.message);
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
    console.error('[find-customer] error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ===== PROXY: UPLOAD ẢNH LÊN BASSO =====
app.post('/api/upload-image', upload.single('file'), async (req, res) => {
  if (IS_MOCK) {
    return res.json({ success: true, data: { id: null, path: null }, _mock: true });
  }

  try {
    const blob = new Blob([req.file.buffer], { type: req.file.mimetype });
    const formData = new FormData();
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
    console.error('[create-order] error:', err.message);
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
  } catch (err) { console.error('[api] error:', req.url, err.message); res.status(500).json({ success: false, message: err.message }); }
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
  } catch (err) { console.error('[api] error:', req.url, err.message); res.status(500).json({ success: false, message: err.message }); }
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
  } catch (err) { console.error('[api] error:', req.url, err.message); res.status(500).json({ success: false, message: err.message }); }
});

// ===== DEBUG: catch all unmatched routes =====
app.use((req, res) => {
  console.log('[404]', req.method, req.url, req.originalUrl);
  res.status(404).json({ error: 'Route not found', method: req.method, url: req.url, originalUrl: req.originalUrl });
});

// Global error handler — catch request aborted, JSON parse errors, etc.
app.use((err, req, res, next) => {
  if (err.type === 'request.aborted' || err.code === 'ECONNRESET') return;
  console.error('[error]', req.method, req.url, err.message);
  if (!res.headersSent) res.status(500).json({ success: false, message: err.message });
});

// Prevent process crash on unhandled errors
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err.message);
});
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason?.message || reason);
});

// ===== START =====
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    initConfigTables().then(() => {
      initRules();
      initHelp();
    });
  });
}

module.exports = app;
