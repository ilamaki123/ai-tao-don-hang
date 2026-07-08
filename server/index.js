require('dotenv').config();
const express = require('express');
const cors = require('cors');
const mysql = require('mysql2/promise');
const multer = require('multer');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const fs = require('fs');
const path = require('path');

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 6 * 1024 * 1024 }, // 6MB — well under Nginx ~15-20MB cap
});
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const VISION_MODEL = 'gemini-2.5-flash';
const TEXT_MODEL = 'gemini-2.5-flash';

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
    try {
      await db.execute(`
        CREATE TABLE IF NOT EXISTS app_config (
          config_key VARCHAR(100) PRIMARY KEY,
          config_value LONGTEXT,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
      `);
      console.log('[mysql] table app_config ready');
    } catch (e) {
      console.error('[mysql] CREATE TABLE app_config FAILED:', { message: e.message, code: e.code, errno: e.errno, sqlState: e.sqlState, sqlMessage: e.sqlMessage });
      return;
    }
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
    console.error('[config] Init error:', { message: e.message, code: e.code, errno: e.errno, sqlState: e.sqlState });
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

function extractDomain(url) {
  try {
    const u = new URL(url);
    return u.hostname.toLowerCase().replace(/^www\./, '');
  } catch { return ''; }
}

// ===== SESSION STORAGE (MySQL) =====
const SIXTY_DAYS_MS = 60 * 24 * 60 * 60 * 1000;
let dbPool = null;

async function getDb() {
  if (!dbPool) {
    const cfg = {
      host: process.env.MYSQL_HOST || 'localhost',
      port: parseInt(process.env.MYSQL_PORT) || 3306,
      user: process.env.MYSQL_USER || 'root',
      database: process.env.MYSQL_DATABASE || 'basso_platform',
    };
    console.log('[mysql] connecting to', `${cfg.user}@${cfg.host}:${cfg.port}/${cfg.database}`);
    dbPool = mysql.createPool({
      ...cfg,
      password: process.env.MYSQL_PASSWORD || '',
      waitForConnections: true,
      connectionLimit: 5,
      charset: 'utf8mb4',
      // Prevent stale connections after long idle (default MySQL wait_timeout = 8h)
      enableKeepAlive: true,
      keepAliveInitialDelay: 0,
      idleTimeout: 60000, // 1 min — pool drops idle conn, reopens fresh on next query
    });
    try {
      const [r] = await dbPool.execute('SELECT VERSION() AS v, DATABASE() AS db, CURRENT_USER() AS u');
      console.log('[mysql] connected OK — version:', r[0].v, '| database:', r[0].db, '| as:', r[0].u);
    } catch (e) {
      console.error('[mysql] connection test FAILED:', { message: e.message, code: e.code, errno: e.errno, sqlState: e.sqlState });
      throw e;
    }
    try {
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
      console.log('[mysql] table user_sessions ready');
    } catch (e) {
      console.error('[mysql] CREATE TABLE user_sessions FAILED:', { message: e.message, code: e.code, errno: e.errno, sqlState: e.sqlState, sqlMessage: e.sqlMessage });
    }
    try {
      await dbPool.execute(`
        CREATE TABLE IF NOT EXISTS daily_order_stats (
          user_id INT NOT NULL,
          stat_date DATE NOT NULL,
          order_count INT DEFAULT 0,
          PRIMARY KEY (user_id, stat_date)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
      `);
      console.log('[mysql] table daily_order_stats ready');
    } catch (e) {
      console.error('[mysql] CREATE TABLE daily_order_stats FAILED:', { message: e.message, code: e.code, errno: e.errno, sqlState: e.sqlState, sqlMessage: e.sqlMessage });
    }
    try {
      await dbPool.execute(`
        CREATE TABLE IF NOT EXISTS order_log (
          id BIGINT AUTO_INCREMENT PRIMARY KEY,
          user_id INT NOT NULL,
          user_email VARCHAR(255) DEFAULT '',
          user_name VARCHAR(255) DEFAULT '',
          order_code VARCHAR(50) DEFAULT '',
          total_amount DECIMAL(14,2) DEFAULT 0,
          currency VARCHAR(10) DEFAULT '$',
          domains_json TEXT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          INDEX idx_user_date (user_id, created_at),
          INDEX idx_created_at (created_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
      `);
      console.log('[mysql] table order_log ready');
      // Migration for existing databases — add column if missing
      try {
        await dbPool.execute('ALTER TABLE order_log ADD COLUMN domains_json TEXT NULL');
        console.log('[mysql] order_log.domains_json column added');
      } catch (e) {
        if (e.code !== 'ER_DUP_FIELDNAME') {
          console.error('[mysql] ALTER order_log domains_json FAILED:', e.message);
        }
      }
      // cancelled_at: NULL = đơn còn hiệu lực; có giá trị = đã hủy (qua Mon hoặc reconcile
      // với Basso). Dashboard loại các dòng cancelled_at IS NOT NULL khỏi thống kê.
      try {
        await dbPool.execute('ALTER TABLE order_log ADD COLUMN cancelled_at TIMESTAMP NULL DEFAULT NULL');
        console.log('[mysql] order_log.cancelled_at column added');
      } catch (e) {
        if (e.code !== 'ER_DUP_FIELDNAME') {
          console.error('[mysql] ALTER order_log cancelled_at FAILED:', e.message);
        }
      }
      // cancelled_amount / cancelled_domains_json: giá trị phần SP bị hủy trên đơn CÒN
      // hiệu lực (cancel một phần). Dashboard trừ phần này khỏi tổng giá trị + doanh thu
      // theo web, nhưng KHÔNG trừ số đơn (đơn vẫn tồn tại). Đơn hủy toàn bộ dùng cancelled_at.
      for (const [col, ddl] of [
        ['cancelled_amount', 'ADD COLUMN cancelled_amount DECIMAL(14,2) NOT NULL DEFAULT 0'],
        ['cancelled_domains_json', 'ADD COLUMN cancelled_domains_json TEXT NULL'],
      ]) {
        try {
          await dbPool.execute(`ALTER TABLE order_log ${ddl}`);
          console.log(`[mysql] order_log.${col} column added`);
        } catch (e) {
          if (e.code !== 'ER_DUP_FIELDNAME') console.error(`[mysql] ALTER order_log ${col} FAILED:`, e.message);
        }
      }
    } catch (e) {
      console.error('[mysql] CREATE TABLE order_log FAILED:', { message: e.message, code: e.code });
    }
    try {
      await dbPool.execute(`
        CREATE TABLE IF NOT EXISTS partner_tokens (
          token VARCHAR(255) PRIMARY KEY,
          user_id INT NOT NULL,
          email VARCHAR(255) DEFAULT '',
          name VARCHAR(255) DEFAULT '',
          roles_json TEXT,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
      `);
      console.log('[mysql] table partner_tokens ready');
    } catch (e) {
      console.error('[mysql] CREATE TABLE partner_tokens FAILED:', { message: e.message, code: e.code });
    }
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

// Async resolveUser that falls back to DB if cache miss — use for endpoints that need roles
async function resolveUserFull(req) {
  const cached = resolveUser(req);
  if (cached && cached.roles && cached.roles.length > 0) return cached;
  const token = (req.headers['authorization'] || '').replace('Bearer ', '').trim();
  try {
    const db = await getDb();
    // 1) Lookup by exact token first
    if (token) {
      const [rows] = await db.execute('SELECT user_id, email, name, roles_json FROM partner_tokens WHERE token = ?', [token]);
      if (rows.length > 0) {
        const r = rows[0];
        let roles = [];
        try { roles = JSON.parse(r.roles_json || '[]'); } catch {}
        if (roles.length > 0) {
          const userInfo = { id: r.user_id, email: r.email || '', name: r.name || '', roles };
          tokenUserMap.set(token, userInfo);
          return userInfo;
        }
      }
    }
    // 2) Token unknown or its row has empty roles → fall back to user_id lookup
    const userId = cached?.id || req.headers['x-user-id'];
    if (userId) {
      const [rows] = await db.execute(
        `SELECT user_id, email, name, roles_json FROM partner_tokens
         WHERE user_id = ? AND roles_json IS NOT NULL AND roles_json != '[]'
         ORDER BY created_at DESC LIMIT 1`,
        [userId]
      );
      if (rows.length > 0) {
        const r = rows[0];
        let roles = [];
        try { roles = JSON.parse(r.roles_json || '[]'); } catch {}
        const userInfo = { id: r.user_id, email: r.email || '', name: r.name || '', roles };
        if (token) tokenUserMap.set(token, userInfo);
        return userInfo;
      }
    }
  } catch (e) { console.error('[resolveUserFull] DB error:', e.message); }
  return cached;
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

// Khi Basso trả 401/403 (token hết hạn) — chuyển thành response chuẩn để FE auto-logout.
// Trả true nếu đã handle (caller phải return ngay), false nếu status ok.
function handleBassoAuthError(response, res) {
  if (response.status === 401 || response.status === 403) {
    res.status(401).json({
      success: false,
      error: 'session_expired',
      message: 'Phiên đăng nhập đã hết hạn, vui lòng đăng nhập lại.',
    });
    return true;
  }
  return false;
}

// ===== HEALTH CHECK =====
app.get('/health', (req, res) => {
  res.json({ status: 'ok', mock: IS_MOCK });
});

// ===== GET ROLES BY TOKEN =====
app.get('/api/get-roles', async (req, res) => {
  const user = await resolveUserFull(req);
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
      const composedName = u.name || u.full_name
        || [u.first_name, u.last_name].filter(Boolean).join(' ').trim()
        || u.email || u.username;
      const userInfo = { id: u.id, email: u.email || u.username, name: composedName, roles: u.roles || [] };
      tokenUserMap.set(data.data.access_token, userInfo);
      // Persist to DB so cache survives restart
      try {
        const db = await getDb();
        await db.execute(
          `INSERT INTO partner_tokens (token, user_id, email, name, roles_json) VALUES (?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE user_id=VALUES(user_id), email=VALUES(email), name=VALUES(name), roles_json=VALUES(roles_json)`,
          [data.data.access_token, userInfo.id, userInfo.email, userInfo.name, JSON.stringify(userInfo.roles)]
        );
      } catch (e) { console.error('[partner_tokens] save error:', e.message); }
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
      ? `- price: QUAN TRỌNG - Website ${domain} HIỂN THỊ TỔNG GIÁ (tổng tiền cho toàn bộ quantity), KHÔNG phải đơn giá.
  Quy tắc nghiêm ngặt, KHÔNG được override bởi visual cue:
  1. Nếu có giá bị gạch ngang (strikethrough, ~~$X~~) → đó là TỔNG GỐC trước khi web tự giảm. BỎ QUA hoàn toàn, không dùng để suy luận đơn giá.
  2. Lấy số tiền KHÔNG bị gạch → đó là TỔNG sau khi web đã giảm.
  3. price = (số tiền không gạch) / quantity. KHÔNG được trả số tiền không gạch trực tiếp làm price.
  Ví dụ chính xác: ảnh hiển thị "~~$129.00~~ $64.50" với qty=2 → price = 64.50 / 2 = 32.25. KHÔNG phải 64.50.
  Ví dụ khác: hiển thị "$48" với qty=3 → price = 48 / 3 = 16. KHÔNG phải 48.
  Đừng để label "50% Off" hoặc "Sale" làm bạn nhầm số gạch ngang là đơn giá gốc — trên website này, cả gạch ngang và số hiển thị đều là TỔNG.`
      : `- price: LUÔN LUÔN là ĐƠN GIÁ (giá cho 1 sản phẩm). Nếu ảnh hiển thị tổng giá (ví dụ qty=5, hiển thị $165) thì chia ngược: price = 165/5 = 33. Nếu ảnh hiển thị đơn giá (ví dụ $33/item hoặc $33 each) thì giữ nguyên. Kiểm tra: quantity × price phải bằng tổng giá hiển thị trong ảnh.`;

    const promptText = `Trích xuất thông tin sản phẩm từ ảnh và trả về JSON THUẦN (không markdown, không code fence, không giải thích).

Ảnh có thể là:
- Giỏ hàng: lấy TẤT CẢ sản phẩm từ trên xuống dưới.
- Trang chi tiết sản phẩm: chỉ lấy sản phẩm chính đang được chọn (viền xanh/đỏ/đậm). Bỏ qua "gợi ý", "customers also bought".
- Ảnh sản phẩm đơn lẻ (chỉ hình + tên, không giá): tạo 1 sản phẩm với price=0, quantity=1.

Mỗi sản phẩm gồm:
- name: thương hiệu + tên sản phẩm
- quantity: số nguyên, mặc định 1. CHÚ Ý: "X Count", "Pack of N", "N-Pack", "Set of N", "Bundle of N" trong size selector / size label là QUY CÁCH ĐÓNG GÓI của 1 sản phẩm (vd. 1 chai chứa 100 viên thuốc, 1 hộp gồm 3 bịch) — KHÔNG được hiểu là quantity. Quantity là số sản phẩm user thêm vào giỏ, mặc định 1 trừ khi thấy rõ ô "Qty: N" / "Quantity: N" hoặc ảnh giỏ hàng có số lượng cụ thể.
${priceRule}
- currency: ký hiệu tiền ("$", "€", "£", "₩", "¥", "đ", "VND"), không thấy để ""
- variations: mảng các thuộc tính NGƯỜI MUA ĐÃ CHỌN (size selector, color swatch, hoặc dòng "Size: M", "Color: Black"). LUÔN có Size và Color trong mảng (value="" nếu không thấy lựa chọn cụ thể). KHÔNG được tự bịa thuộc tính từ tên/mô tả/đặc điểm sản phẩm (ví dụ KHÔNG suy "Surface: Carbon" từ tên paddle, KHÔNG đoán "Color: Blue" từ màu trong ảnh sản phẩm). Chỉ lấy khi có giá trị rõ ràng được hiển thị như một lựa chọn variant.
- Đặc biệt cho Size giày dép: NẾU có dòng "Size: <giá trị>" hoặc tab giới tính (Women's / Men's / Kids / Unisex / W / M) đang được chọn → BẮT BUỘC include cả prefix giới tính trong value (vd "Women's 7", "Men's 9", "W8", "Kids 10"). KHÔNG chỉ lấy số nếu có context giới tính.

Nếu ảnh không chứa sản phẩm nào, trả về {"items":[]}.

Định dạng trả về duy nhất:
{"items":[{"name":"","quantity":1,"price":0,"currency":"","variations":[{"name":"Size","value":""},{"name":"Color","value":""}]}]}`;

    const model = genAI.getGenerativeModel({
      model: VISION_MODEL,
      generationConfig: {
        maxOutputTokens: 4096,
        temperature: 0,
        thinkingConfig: { thinkingBudget: 0 },
        responseMimeType: 'application/json',
      },
    });
    const response = await model.generateContent([
      { inlineData: { mimeType, data: imageBase64 } },
      promptText,
    ]);
    const rawText = (response.response.text() || '').trim();
    console.log('[analyze-image] raw response:', rawText.slice(0, 2000));

    // Strip optional ```json fences
    const cleaned = rawText.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();

    let extracted;
    try {
      extracted = JSON.parse(cleaned);
    } catch (parseErr) {
      // Fallback: try to extract a balanced array OR object substring
      const arrMatch = cleaned.match(/\[[\s\S]*\]/);
      const objMatch = cleaned.match(/\{[\s\S]*\}/);
      const candidate = arrMatch ? arrMatch[0] : (objMatch ? objMatch[0] : '');
      if (!candidate) {
        console.error('[analyze-image] no JSON in response. Full text:', rawText);
        return res.status(500).json({ success: false, message: 'Không thể trích xuất thông tin từ ảnh', debug: rawText.slice(0, 500) });
      }
      try {
        extracted = JSON.parse(candidate);
      } catch (parseErr2) {
        console.error('[analyze-image] JSON parse failed:', parseErr2.message);
        console.error('[analyze-image] JSON candidate:', candidate.slice(0, 2000));
        return res.status(500).json({ success: false, message: 'JSON không hợp lệ: ' + parseErr2.message, debug: candidate.slice(0, 500) });
      }
    }

    // Accept both `{"items":[...]}` and bare array `[{...},{...}]` shapes
    if (Array.isArray(extracted)) extracted = { items: extracted };

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
    const promptText = `Detect THE MAIN product photo(s) in this image.

If the image is a CART screenshot (multiple rows, each with a product
photo + name + price + qty), return ONE bbox per row covering each
row's photo area.

If the image is a PRODUCT DETAIL PAGE (one big hero photo on one side
+ a sidebar with text/price/colour swatches/size selector), return
ONLY ONE bbox for the LARGE HERO PHOTO. EXCLUDE the small colour
swatch thumbnails in the sidebar entirely — they are not the product
to capture, they are alternate-color options.
For PDP, the bbox MUST cover the FULL hero photo tile, INCLUDING the
natural whitespace/background padding around the product silhouette
— NOT a tight crop of the product outline. Ecommerce hero photos
nearly always have generous padding around the subject (e.g. a sneaker
with white space above and below it on a white tile); include that
padding in the bbox so the resulting thumbnail looks like a normal
product card, not a zoomed-in cutout.

If the image is a CLEAN SINGLE PRODUCT PHOTO (one product on plain
background, no UI), return ONE bbox covering the whole image:
[0, 0, 1000, 1000].

EXCLUDE in every pattern: page nav, store logos, checkout buttons,
payment icons, rating stars, trust badges, qty +/- buttons, delete
buttons, "save for later" links, product NAME or PRICE text, alternate
colour swatch thumbnails.

Output ONLY this JSON array (no markdown, no code fences, no commentary):
[
  {"index": 0, "box_2d": [ymin, xmin, ymax, xmax]}
]

Coordinates: NORMALIZED 0-1000 of the full uploaded image
(y top=0 bottom=1000, x left=0 right=1000, ymin<ymax, xmin<xmax).

If no thumbnails are visible, output [].`;

    const model = genAI.getGenerativeModel({
      model: VISION_MODEL,
      generationConfig: {
        maxOutputTokens: 2048,
        temperature: 0,
        thinkingConfig: { thinkingBudget: 0 },
        responseMimeType: 'application/json',
      },
    });
    const response = await model.generateContent([
      { inlineData: { mimeType, data: imageBase64 } },
      promptText,
    ]);
    const rawText = (response.response.text() || '').trim();
    console.log('[extract-product-images] raw:', rawText.slice(0, 2000));

    // Strip optional ```json fences, then look for a JSON array (or object fallback)
    const cleaned = rawText.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
    const arrMatch = cleaned.match(/\[[\s\S]*\]/);
    const objMatch = cleaned.match(/\{[\s\S]*\}/);
    const jsonCandidate = arrMatch ? arrMatch[0] : (objMatch ? objMatch[0] : '');
    if (!jsonCandidate) {
      console.error('[extract-product-images] no JSON in response');
      return res.status(500).json({ success: false, message: 'Cannot parse', debug: rawText.slice(0, 500) });
    }

    let parsed;
    try {
      parsed = JSON.parse(jsonCandidate);
    } catch (parseErr) {
      console.error('[extract-product-images] parse error:', parseErr.message, 'candidate:', jsonCandidate.slice(0, 500));
      return res.status(500).json({ success: false, message: 'JSON invalid', debug: jsonCandidate.slice(0, 500) });
    }

    // Accept either bare array [...] or { products: [...] } shape.
    const rawProducts = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.products) ? parsed.products : []);

    // ===== Post-process bboxes =====
    // Gemini's prior is to tight-crop around object pixels even when told to
    // include native whitespace. Override with deterministic geometry that
    // matches what cart-card thumbnails actually need (the photo tile, not
    // the object silhouette).
    if (rawProducts.length === 1) {
      // 1 bbox → Pattern 1b (small bbox, pad), Pattern 2 (tall hero), or Pattern 3 (clean photo).
      // Decide by coverage:
      //   width ≥ 70% → Pattern 3 → full image
      //   width < 70% AND height ≥ 50% → Pattern 2 → keep x, extend y full (detail-page hero tightly cropped)
      //   width < 70% AND height < 50% → Pattern 1b → pad 10% (cart-row single item, model photo, etc.)
      const b = Array.isArray(rawProducts[0].box_2d) ? rawProducts[0].box_2d : null;
      if (b && b.length === 4) {
        const widthPct = (b[3] - b[1]) / 10;
        const heightPct = (b[2] - b[0]) / 10;
        if (widthPct >= 70) {
          rawProducts[0].box_2d = [0, 0, 1000, 1000];
          console.log('[extract-product-images] post-process: Pattern 3 → full image');
        } else if (heightPct >= 50) {
          rawProducts[0].box_2d = [0, b[1], 1000, b[3]];
          console.log('[extract-product-images] post-process: Pattern 2 → vertical full, x kept', b[1], '-', b[3]);
        } else {
          // Cart-row single item, lifestyle/model photo cropped tightly — keep
          // bbox aspect ratio (don't stretch to full height, would force
          // object-fit:cover to take the wrong center). Just pad 10%.
          const padY = (b[2] - b[0]) * 0.10;
          const padX = (b[3] - b[1]) * 0.10;
          rawProducts[0].box_2d = [
            Math.max(0, b[0] - padY),
            Math.max(0, b[1] - padX),
            Math.min(1000, b[2] + padY),
            Math.min(1000, b[3] + padX),
          ];
          console.log('[extract-product-images] post-process: Pattern 1b → small bbox (h<50%), pad 10%');
        }
      }
    } else if (rawProducts.length > 1) {
      // Multiple bboxes → Pattern 1 (cart). Two transforms:
      //   - Wide/flat object (w > h * 1.3) → force square by extending y,
      //     to recover the natural top/bottom whitespace (sandals viewed
      //     side-on, watches, pens).
      //   - Tall/square object → add 10% padding on every side so the
      //     subject isn't glued to the thumbnail edges. Gives shirts /
      //     bottles breathing room and visually centers them in the
      //     thumbnail tile.
      // 10% is small enough that text-bleed risk on tight cart layouts
      // stays minor (a few pixels), but noticeably rounds out the
      // composition.
      let widened = 0, padded = 0;
      for (const p of rawProducts) {
        const b = Array.isArray(p.box_2d) ? p.box_2d : null;
        if (!b || b.length !== 4) continue;
        const w = b[3] - b[1];
        const h = b[2] - b[0];
        if (w > h * 1.3) {
          // Wide/flat object → square via vertical extension.
          const cy = (b[0] + b[2]) / 2;
          const half = w / 2;
          p.box_2d = [
            Math.max(0, Math.round(cy - half)),
            b[1],
            Math.min(1000, Math.round(cy + half)),
            b[3],
          ];
          widened++;
        } else {
          // Tall/square → 10% padding (client-side colored-cell expansion
          // takes over when the product sits on a grey/colored background).
          const padY = Math.round(h * 0.1);
          const padX = Math.round(w * 0.1);
          p.box_2d = [
            Math.max(0, b[0] - padY),
            Math.max(0, b[1] - padX),
            Math.min(1000, b[2] + padY),
            Math.min(1000, b[3] + padX),
          ];
          padded++;
        }
      }
      console.log('[extract-product-images] post-process: Pattern 1 →', widened, 'widened,', padded, 'padded of', rawProducts.length);
    }

    const normalized = rawProducts.map((p, i) => {
      // Gemini native bbox: [ymin, xmin, ymax, xmax] in 0-1000 normalized coords.
      const box = Array.isArray(p.box_2d) ? p.box_2d : (Array.isArray(p.box) ? p.box : null);
      if (!box || box.length !== 4) return null;
      const [ymin, xmin, ymax, xmax] = box.map(Number);
      if ([ymin, xmin, ymax, xmax].some(v => !Number.isFinite(v))) return null;
      // Convert 0-1000 → 0-100 percentage of full image
      const xPct = Math.max(0, Math.min(100, xmin / 10));
      const yPct = Math.max(0, Math.min(100, ymin / 10));
      const widthPct = Math.max(0, Math.min(100 - xPct, (xmax - xmin) / 10));
      const heightPct = Math.max(0, Math.min(100 - yPct, (ymax - ymin) / 10));
      return {
        index: p.index ?? i,
        xPct,
        yPct,
        widthPct,
        heightPct,
      };
    }).filter(Boolean);

    console.log('[extract-product-images] products:', JSON.stringify(normalized));
    res.json({ success: true, data: { products: normalized } });
  } catch (err) {
    console.error('[extract-product-images] error:', err.message, err.stack);
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
    if (handleBassoAuthError(response, res)) return;
    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error('[find-customer] error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ===== TỶ GIÁ: getCountries / getCountryRates / getWebsiteOrders =====
app.get('/api/get-countries', async (req, res) => {
  if (IS_MOCK) {
    return res.json({ success: true, _mock: true, data: { countries: [
      { id: 1, code: 'US', name: 'Mỹ', currency_id: 1, currency_name: 'Đô la Mỹ', currency_symbol: '$', customer_rate: 25500, buy_rate: 25000, shipping_fee: 50000, rate_detail_by: 'brand' },
      { id: 4, code: 'GB', name: 'Anh', currency_id: 4, currency_name: 'Bảng Anh', currency_symbol: '£', customer_rate: 32000, buy_rate: 31500, shipping_fee: 50000, rate_detail_by: 'customer_group' },
    ] } });
  }
  try {
    const response = await fetch(`${BASSO_URL}/partner/getCountries?include_currencies=1`, { headers: bassoHeaders(req) });
    if (handleBassoAuthError(response, res)) return;
    res.json(await response.json());
  } catch (err) {
    console.error('[get-countries] error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/api/get-country-rates', async (req, res) => {
  const cid = req.query.country_id;
  if (!cid) return res.status(400).json({ success: false, message: 'Thiếu country_id' });
  if (IS_MOCK) {
    return res.json({ success: true, _mock: true, data: {
      country: { id: Number(cid) || 1, customer_rate: 25500, buy_rate: 25000, shipping_fee: 50000 },
      rate_detail_by: Number(cid) === 1 ? 'brand' : 'customer_group',
      rates: Number(cid) === 1
        ? [{ brand: 'shipus', brand_name: 'ShipUS', rate: 25500, shipping_fee: 50000 }, { brand: 'basso', brand_name: 'Basso', rate: 25600, shipping_fee: 50000 }]
        : [{ customer_group_id: 2, customer_group_name: 'CTV', rate: 32000, shipping_fee: 50000 }],
    } });
  }
  try {
    const response = await fetch(`${BASSO_URL}/partner/getCountryRates?country_id=${encodeURIComponent(cid)}`, { headers: bassoHeaders(req) });
    if (handleBassoAuthError(response, res)) return;
    res.json(await response.json());
  } catch (err) {
    console.error('[get-country-rates] error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// Tỉ giá theo từng (website × nhóm KH) cho Mỹ — currency_rate_website_orders
app.get('/api/get-website-orders', async (req, res) => {
  const inc = req.query.include_rates != null ? req.query.include_rates : 1;
  if (IS_MOCK) {
    return res.json({ success: true, _mock: true, data: {
      website_orders: [
        { id: 1, name: 'Tommy US', domain: 'https://usa.tommy.com', note: '', rates: [
          { customer_group_id: 2, customer_group_name: 'CTV', rate: 25400 },
          { customer_group_id: 3, customer_group_name: 'Sỉ nhỏ', rate: 25200 },
          { customer_group_id: 4, customer_group_name: 'Sỉ vừa', rate: 25000 },
          { customer_group_id: 5, customer_group_name: 'Sỉ to', rate: 24800 },
        ] },
      ],
      customer_groups: [
        { id: 2, name: 'CTV' }, { id: 3, name: 'Sỉ nhỏ' }, { id: 4, name: 'Sỉ vừa' }, { id: 5, name: 'Sỉ to' },
      ],
    } });
  }
  try {
    const response = await fetch(`${BASSO_URL}/partner/getWebsiteOrders?include_rates=${encodeURIComponent(inc)}`, { headers: bassoHeaders(req) });
    if (handleBassoAuthError(response, res)) return;
    res.json(await response.json());
  } catch (err) {
    console.error('[get-website-orders] error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// Danh sách phụ thu theo brand — getOrderTerms (order_terms + steps + categories)
app.get('/api/get-order-terms', async (req, res) => {
  const brand = req.query.brand || 'shipus';
  const activeOnly = req.query.active_only != null ? req.query.active_only : 1;
  if (IS_MOCK) {
    return res.json({ success: true, _mock: true, data: { brand, order_terms: [
      { id: 8, name: 'Phụ thu mẫu', active: 1, min_fee: 0, index: 1, steps: [ { id: 101, step: 0, type: 'amount', amount: 5 }, { id: 102, step: 50, type: 'percent', amount: 10 } ], categories: [] },
    ] } });
  }
  try {
    const response = await fetch(`${BASSO_URL}/partner/getOrderTerms?brand=${encodeURIComponent(brand)}&active_only=${encodeURIComponent(activeOnly)}`, { headers: bassoHeaders(req) });
    if (handleBassoAuthError(response, res)) return;
    res.json(await response.json());
  } catch (err) {
    console.error('[get-order-terms] error:', err.message);
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
    if (handleBassoAuthError(response, res)) return;
    const data = await response.json();
    console.log('[upload-image] Basso response:', JSON.stringify(data));
    res.json(data);
  } catch (err) {
    console.error('[upload-image] error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ===== PROXY: UPLOAD ẢNH LÊN BASSO TỪ URL =====
// Dùng khi cần lấy lại image_id từ một ảnh đã có URL (vd. item còn
// image_path nhưng mất image_id sau reload — thumb base64 đã bị strip).
// Basso uploadImage hỗ trợ field `url` (form-urlencoded).
app.post('/api/upload-image-url', express.json(), async (req, res) => {
  if (IS_MOCK) {
    return res.json({ success: true, data: { id: null, path: null }, _mock: true });
  }
  const url = req.body?.url;
  if (!url) return res.status(400).json({ success: false, message: 'Thiếu url' });
  try {
    const response = await fetch(`${BASSO_URL}/partner/uploadImage`, {
      method: 'POST',
      headers: { ...bassoHeaders(req), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ url }).toString(),
    });
    if (handleBassoAuthError(response, res)) return;
    const data = await response.json();
    console.log('[upload-image-url] Basso response:', JSON.stringify(data));
    res.json(data);
  } catch (err) {
    console.error('[upload-image-url] error:', err.message);
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
    // Chẩn đoán ảnh: đếm item thiếu image_id (đơn sẽ không có ảnh trên Basso).
    try {
      const _items = JSON.parse(req.body.items || '[]');
      const _missing = _items.filter(i => !i.image_id);
      if (_missing.length) {
        console.warn(`[create-order] ⚠️ ${_missing.length}/${_items.length} item THIẾU image_id:`,
          _missing.map(i => ({ name: (i.name || '').slice(0, 40), has_path: !!i.image_path })));
      }
    } catch (e) { /* ignore parse */ }
    const response = await fetch(`${BASSO_URL}/partner/createOrder`, {
      method: 'POST',
      headers: { ...bassoHeaders(req), 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (handleBassoAuthError(response, res)) return;
    const data = await response.json();
    console.log('[create-order] Basso response:', JSON.stringify(data));
    // Log vào order_log nếu thành công
    if (data?.success && data?.data?.orderCode) {
      try {
        const user = await resolveUserFull(req);
        let totalAmount = 0;
        let currency = '$';
        const domainMap = {};
        try {
          const items = JSON.parse(req.body.items || '[]');
          for (const it of items) {
            const p = parseFloat(it.price ?? 0) || 0;
            const q = parseInt(it.quantity) || 1;
            const itemTotal = p * q;
            totalAmount += itemTotal;
            if (it.currency) currency = it.currency;
            const domain = extractDomain(it.link || '');
            if (domain) domainMap[domain] = (domainMap[domain] || 0) + itemTotal;
          }
          totalAmount += Number(req.body.web_shipping_fee) || 0;
        } catch {}
        const domainsArr = Object.entries(domainMap)
          .map(([domain, amount]) => ({ domain, amount: Math.round(amount * 100) / 100 }))
          .sort((a, b) => b.amount - a.amount);
        const domainsJson = domainsArr.length ? JSON.stringify(domainsArr) : null;
        const db = await getDb();
        await db.execute(
          'INSERT INTO order_log (user_id, user_email, user_name, order_code, total_amount, currency, domains_json) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [user?.id || 0, user?.email || '', user?.name || '', data.data.orderCode, totalAmount, currency, domainsJson]
        );
      } catch (logErr) {
        console.error('[order_log] insert error:', logErr.message);
      }
    }
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
    if (handleBassoAuthError(response, res)) return;
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
    if (handleBassoAuthError(response, res)) return;
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
    if (handleBassoAuthError(response, res)) return;
    const data = await response.json();
    console.log('[cancel-order] Basso response:', JSON.stringify(data).substring(0, 500));
    // Nhóm A: hủy qua Mon → đánh dấu order_log để dashboard trừ ngay (0 call thêm).
    if (data?.success) {
      try {
        const db = await getDb();
        const [r] = await db.execute(
          'UPDATE order_log SET cancelled_at = NOW() WHERE order_code = ? AND cancelled_at IS NULL',
          [order_code]
        );
        if (r.affectedRows) console.log(`[cancel-order] order_log marked cancelled: ${order_code}`);
      } catch (e) { console.error('[cancel-order] mark order_log error:', e.message); }
    }
    res.json(data);
  } catch (err) { console.error('[api] error:', req.url, err.message); res.status(500).json({ success: false, message: err.message }); }
});

// ===== PROXY: LẤY ĐƠN THEO TRẠNG THÁI SẢN PHẨM =====
app.get('/api/orders-by-item-status', async (req, res) => {
  const { customer_id, item_status, page, page_size } = req.query;
  if (!customer_id) return res.status(400).json({ success: false, message: 'Thiếu customer_id' });
  if (!item_status) return res.status(400).json({ success: false, message: 'Thiếu item_status' });
  if (IS_MOCK) {
    return res.json({ success: true, data: { customer_id, item_status, total_orders: 0, orders: [] }, _mock: true });
  }
  try {
    const params = new URLSearchParams({ customer_id, item_status });
    if (page) params.set('page', page);
    if (page_size) params.set('page_size', page_size);
    const url = `${BASSO_URL}/partner/getCustomerOrdersByItemStatus?${params.toString()}`;
    console.log('[orders-by-item-status] calling:', url);
    const response = await fetch(url, { headers: bassoHeaders(req) });
    if (handleBassoAuthError(response, res)) return;
    const rawText = await response.text();
    console.log('[orders-by-item-status] status:', response.status, 'raw:', rawText.substring(0, 3000));
    let data;
    try { data = JSON.parse(rawText); } catch {
      return res.status(502).json({ success: false, message: 'Basso trả về không phải JSON', raw: rawText.substring(0, 200) });
    }
    res.json(data);
  } catch (err) { console.error('[api] error:', req.url, err.message); res.status(500).json({ success: false, message: err.message }); }
});

// ===== PROXY: ĐƠN CÓ SP CANCEL (scope theo user của token) =====
// Basso tự lọc theo approve_user_id = user_id của Bearer token (trừ admin/accounting_manager).
app.get('/api/cancel-notifications', async (req, res) => {
  if (IS_MOCK) {
    return res.json({ success: true, data: { orders: [], total_orders: 0 }, _mock: true });
  }
  try {
    const params = new URLSearchParams();
    // API mới yêu cầu item_status bắt buộc → default not_available cho panel cancel.
    params.set('item_status', req.query.item_status || 'not_available');
    ['page', 'page_size', 'order_status', 'from', 'to', 'website', 'key'].forEach(k => {
      if (req.query[k]) params.set(k, req.query[k]);
    });
    const url = `${BASSO_URL}/partner/getOrdersWithCancelledItems?${params.toString()}`;
    const response = await fetch(url, { headers: bassoHeaders(req) });
    if (handleBassoAuthError(response, res)) return;
    const rawText = await response.text();
    let data;
    try { data = JSON.parse(rawText); } catch {
      // Basso trả HTML (endpoint lỗi/chưa sẵn) → silent skip thay vì 500
      return res.json({ success: false, message: 'Endpoint chưa khả dụng', data: { orders: [], total_orders: 0 } });
    }
    res.json(data);
  } catch (err) {
    console.error('[cancel-notifications] error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ===== ENCOURAGEMENT MESSAGE AFTER ORDER SUCCESS =====
// 20 câu khích lệ Gen-Z xéo sắc — rotate theo order_count trong ngày để
// user không thấy 2 câu giống nhau liên tiếp. Không gọi AI nữa.
// {name} sẽ được replace bằng tên nhân viên trước khi trả về.
const ENCOURAGEMENT_MESSAGES = [
  '{name} ơi đơn nữa á? Đồng nghiệp ngồi khóc thầm rồi đó 😏',
  'Tốc độ của {name} thế này khách rén, đối thủ khóc, Mon thì gato 🥲',
  'Slay quá đáng, {name} ai cho phép đỉnh vậy 💅',
  'Mon đếm đơn của {name} xong tự ti thật sự 🥹',
  'Đỉnh nóc kịch trần, {name} làm đối thủ tháng này coi như xong 🔥',
  'Hôm nay vibe gì mà {name} cày dữ vậy, crush cũ block à 💀',
  '{name} đếm tiền hoa hồng tới khuya, đừng quên Mon nha 💸',
  'Tay {name} nhanh hơn não khách, đơn ra phát một 💪',
  '{name} cứ thế này, sếp khỏi cần tuyển thêm ai 😎',
  'Mon hết câu khen {name} mà tay vẫn cay 🥲',
  'Khách hài lòng, sếp hài lòng, Mon thì rén {name} ơi 😅',
  'Một đơn = một bậc lương, {name} flex đi đợi gì 💸',
  'Sếp nhìn dashboard thấy {name} chắc cười tủm tỉm 😏',
  'Iconic real, basso may có {name} để gáy ✨',
  '{name} ơi đơn này mà không khoe story thì phí xừ 📸',
  '{name} cày như bot mà còn xinh, Mon ngại 😩',
  'Mon vote {name} MVP tháng, no cap 👑',
  'Đỉnh thật sự, đối thủ thấy {name} là hết hồn 😱',
  '{name} real ki không trượt phát nào, slay 🔥',
  'U là trời, {name} level này Mon học mãi không hết 🙌',
];

app.post('/api/encouragement', async (req, res) => {
  try {
    const user = resolveUser(req);
    if (!user) return res.status(401).json({ success: false, message: 'Unauthorized' });

    const db = await getDb();
    // Use Asia/Ho_Chi_Minh date (YYYY-MM-DD)
    const vnDate = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' });
    await db.execute(
      'INSERT INTO daily_order_stats (user_id, stat_date, order_count) VALUES (?, ?, 1) ON DUPLICATE KEY UPDATE order_count = order_count + 1',
      [user.id, vnDate]
    );
    const [rows] = await db.execute(
      'SELECT order_count FROM daily_order_stats WHERE user_id = ? AND stat_date = ?',
      [user.id, vnDate]
    );
    const count = rows[0]?.order_count || 1;

    // Strip @domain nếu name lỡ là email; fallback 'bạn'
    const rawName = (req.body?.name || '').trim();
    const userName = rawName.includes('@') ? rawName.split('@')[0] : (rawName || 'bạn');
    const template = ENCOURAGEMENT_MESSAGES[(count - 1) % ENCOURAGEMENT_MESSAGES.length];
    const text = template.replace(/\{name\}/g, userName);
    console.log(`[encouragement] user=${user.id} count=${count} msg="${text}"`);
    res.json({ success: true, data: { message: text, count } });
  } catch (err) {
    console.error('[encouragement] error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ===== HEALTH CHECK =====
// Lightweight liveness + DB readiness probe for uptime monitors and PM2 watchdog.
// 200 = process alive AND DB query works. 500 = something wrong.
app.get('/api/health', async (req, res) => {
  try {
    const db = await getDb();
    const [r] = await db.execute('SELECT 1 AS ok');
    res.json({
      success: true,
      ok: r[0].ok === 1,
      uptime_sec: Math.round(process.uptime()),
      memory_mb: Math.round(process.memoryUsage().rss / 1024 / 1024),
    });
  } catch (err) {
    console.error('[health] DB check failed:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ===== DEBUG: who am I =====
app.get('/api/me', async (req, res) => {
  const fromCache = resolveUser(req);
  const fromDb = await resolveUserFull(req);
  res.json({ success: true, fromCache, fromDb, isAdmin: !!(fromDb?.roles || []).some(r => /admin/i.test(r)) });
});

// ===== DASHBOARD =====
app.get('/api/dashboard-stats', async (req, res) => {
  try {
    const user = await resolveUserFull(req);
    if (!user) return res.status(401).json({ success: false, message: 'Unauthorized' });
    const isAdmin = (user.roles || []).some(r => /admin/i.test(r));
    const reqUserId = req.query.user_id;
    const targetUserId = (reqUserId && parseInt(reqUserId)) || null;
    console.log('[dashboard-stats] caller=', user.id, 'isAdmin=', isAdmin, 'reqUserId=', reqUserId, 'targetUserId=', targetUserId, 'from=', req.query.from, 'to=', req.query.to);
    const from = req.query.from;
    const to = req.query.to;
    const db = await getDb();
    const where = ['cancelled_at IS NULL'];
    const params = [];
    if (targetUserId) { where.push('user_id = ?'); params.push(targetUserId); }
    if (from) { where.push('DATE(created_at) >= ?'); params.push(from); }
    if (to) { where.push('DATE(created_at) <= ?'); params.push(to); }
    const whereSql = where.join(' AND ');
    // Giá trị = tổng đơn trừ phần SP đã hủy (cancel một phần). Số đơn (COUNT) giữ nguyên
    // vì đơn vẫn tồn tại. GREATEST(...,0) tránh âm khi giá lệch nhẹ so với lúc tạo.
    const [totalRows] = await db.execute(
      `SELECT currency, COUNT(*) AS cnt, SUM(GREATEST(total_amount - cancelled_amount, 0)) AS total FROM order_log WHERE ${whereSql} GROUP BY currency`,
      params
    );
    const [byDayRows] = await db.execute(
      `SELECT DATE(created_at) AS day, currency, COUNT(*) AS cnt, SUM(GREATEST(total_amount - cancelled_amount, 0)) AS total
       FROM order_log WHERE ${whereSql}
       GROUP BY DATE(created_at), currency
       ORDER BY day ASC`,
      params
    );
    const totalOrders = totalRows.reduce((s, r) => s + Number(r.cnt), 0);
    const byCurrency = {};
    for (const r of totalRows) byCurrency[r.currency] = { count: Number(r.cnt), total: Number(r.total) };
    res.json({
      success: true,
      data: {
        targetUserId,
        isAdmin,
        totalOrders,
        byCurrency,
        byDay: byDayRows.map(r => ({ day: r.day, currency: r.currency, count: Number(r.cnt), total: Number(r.total) })),
      },
    });
  } catch (err) {
    console.error('[dashboard-stats] error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ===== ORDERS GROUPED BY USER (for dashboard horizontal bar chart) =====
app.get('/api/dashboard-orders-by-user', async (req, res) => {
  try {
    const user = await resolveUserFull(req);
    if (!user) return res.status(401).json({ success: false, message: 'Unauthorized' });
    const from = req.query.from;
    const to = req.query.to;
    const where = ['ol.cancelled_at IS NULL'];
    const params = [];
    if (from) { where.push('DATE(ol.created_at) >= ?'); params.push(from); }
    if (to) { where.push('DATE(ol.created_at) <= ?'); params.push(to); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const db = await getDb();
    const [rows] = await db.execute(
      `SELECT
         agg.user_id,
         COALESCE(
           CASE WHEN pt.name      <> '' AND pt.name      NOT LIKE '%@%' THEN pt.name END,
           CASE WHEN agg.user_name <> '' AND agg.user_name NOT LIKE '%@%' THEN agg.user_name END,
           NULLIF(pt.name, ''),
           NULLIF(agg.user_name, ''),
           ''
         ) AS user_name,
         COALESCE(NULLIF(agg.user_email, ''), pt.email, '') AS user_email,
         agg.order_count
       FROM (
         SELECT ol.user_id,
                MAX(ol.user_email) AS user_email,
                MAX(ol.user_name)  AS user_name,
                COUNT(*) AS order_count
         FROM order_log ol
         ${whereSql}
         GROUP BY ol.user_id
       ) agg
       LEFT JOIN (
         SELECT user_id,
                MAX(email) AS email,
                COALESCE(
                  MAX(CASE WHEN name <> '' AND name NOT LIKE '%@%' THEN name END),
                  MAX(name)
                ) AS name
         FROM partner_tokens
         GROUP BY user_id
       ) pt ON pt.user_id = agg.user_id
       ORDER BY agg.order_count DESC`,
      params
    );
    res.json({
      success: true,
      data: {
        users: rows.map(r => ({
          user_id: Number(r.user_id),
          user_name: r.user_name,
          user_email: r.user_email,
          order_count: Number(r.order_count),
        })),
      },
    });
  } catch (err) {
    console.error('[dashboard-orders-by-user] error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ===== TOP 10 DOMAINS BY USD REVENUE =====
app.get('/api/dashboard-top-domains', async (req, res) => {
  try {
    const user = await resolveUserFull(req);
    if (!user) return res.status(401).json({ success: false, message: 'Unauthorized' });
    const reqUserId = req.query.user_id;
    const targetUserId = (reqUserId && parseInt(reqUserId)) || null;
    const from = req.query.from;
    const to = req.query.to;
    const where = ["cancelled_at IS NULL", "currency = '$'", "domains_json IS NOT NULL"];
    const params = [];
    if (targetUserId) { where.push('user_id = ?'); params.push(targetUserId); }
    if (from) { where.push('DATE(created_at) >= ?'); params.push(from); }
    if (to) { where.push('DATE(created_at) <= ?'); params.push(to); }
    const db = await getDb();
    const [rows] = await db.execute(
      `SELECT domains_json, cancelled_domains_json FROM order_log WHERE ${where.join(' AND ')}`,
      params
    );
    const totals = {};
    const addJson = (json, sign) => {
      let arr;
      try { arr = JSON.parse(json || '[]'); } catch { return; }
      if (!Array.isArray(arr)) return;
      for (const e of arr) {
        if (!e?.domain) continue;
        totals[e.domain] = (totals[e.domain] || 0) + sign * (Number(e.amount) || 0);
      }
    };
    for (const r of rows) {
      addJson(r.domains_json, 1);
      addJson(r.cancelled_domains_json, -1); // trừ doanh thu phần SP đã hủy theo từng web
    }
    const top = Object.entries(totals)
      .map(([domain, amount]) => ({ domain, amount: Math.max(0, Math.round(amount * 100) / 100) }))
      .filter(d => d.amount > 0)
      .sort((a, b) => b.amount - a.amount)
      .slice(0, 10);
    res.json({ success: true, data: { domains: top } });
  } catch (err) {
    console.error('[dashboard-top-domains] error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/api/dashboard-users', async (req, res) => {
  try {
    const user = await resolveUserFull(req);
    if (!user) return res.status(401).json({ success: false, message: 'Unauthorized' });
    const isAdmin = (user.roles || []).some(r => /admin/i.test(r));
    console.log('[dashboard-users] user:', { id: user.id, email: user.email, roles: user.roles, isAdmin });
    const db = await getDb();
    const [rows] = await db.execute(
      `SELECT
         ol.user_id,
         COALESCE(NULLIF(ol.user_email, ''), pt.email, '') AS user_email,
         COALESCE(
           CASE WHEN pt.name        <> '' AND pt.name        NOT LIKE '%@%' THEN pt.name END,
           CASE WHEN ol.user_name   <> '' AND ol.user_name   NOT LIKE '%@%' THEN ol.user_name END,
           NULLIF(pt.name, ''),
           NULLIF(ol.user_name, ''),
           ''
         ) AS user_name,
         ol.order_count
       FROM (
         SELECT user_id,
                MAX(user_email) AS user_email,
                MAX(user_name)  AS user_name,
                COUNT(*) AS order_count
         FROM order_log
         GROUP BY user_id
       ) ol
       LEFT JOIN (
         SELECT user_id,
                MAX(email) AS email,
                COALESCE(
                  MAX(CASE WHEN name <> '' AND name NOT LIKE '%@%' THEN name END),
                  MAX(name)
                ) AS name
         FROM partner_tokens
         GROUP BY user_id
       ) pt ON pt.user_id = ol.user_id
       ORDER BY ol.order_count DESC`
    );
    res.json({
      success: true,
      isAdmin,
      users: rows.map(r => ({
        user_id: Number(r.user_id),
        user_email: r.user_email,
        user_name: r.user_name,
        order_count: Number(r.order_count),
      })),
    });
  } catch (err) {
    console.error('[dashboard-users] error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
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

// On unhandled errors: log full info and EXIT so PM2 restarts cleanly.
// Continuing after uncaughtException keeps a corrupted-state process running,
// which is what causes "bot ngủ" — process alive but DB pool / state broken.
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException] fatal — exiting for PM2 restart:', err);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection] fatal — exiting for PM2 restart:', reason);
  process.exit(1);
});

// ============================================================
// RECONCILE ĐƠN HỦY (Nhóm B) — đối soát order_log với Basso 4×/ngày (giờ VN).
// Nguồn: getOrdersWithCancelledItems (bulk, phân trang). Đơn hủy TOÀN BỘ có
// status=cancelled + mọi item chuyển not_available (Partner API §9) nên xuất hiện
// ở item_status=not_available. Cần token role admin/accounting_manager để thấy đơn
// của MỌI nhân viên (role khác chỉ thấy đơn của chính mình).
// ============================================================
let _svcToken = null, _svcTokenExp = 0;

async function getReconcileToken() {
  const now = Math.floor(Date.now() / 1000);
  // 1) Service account trong .env (tự chủ, không phụ thuộc ai đăng nhập)
  const email = process.env.RECONCILE_EMAIL, pass = process.env.RECONCILE_PASS;
  if (email && pass) {
    if (_svcToken && _svcTokenExp - now > 120) return _svcToken;
    try {
      const body = new URLSearchParams({ email, pass }).toString();
      const r = await fetch(`${BASSO_URL}/partner/login`, {
        method: 'POST',
        headers: { 'X-Partner-Api-Key': BASSO_KEY, 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      });
      const d = await r.json().catch(() => null);
      if (d?.data?.access_token) {
        const roles = d.data.user?.roles || [];
        if (!roles.some(x => /admin|accounting_manager/i.test(x))) {
          console.warn('[reconcile] ⚠️ RECONCILE_EMAIL không phải admin/accounting_manager → chỉ thấy đơn của chính tài khoản đó');
        }
        _svcToken = d.data.access_token;
        _svcTokenExp = Number(d.data.expires_at) || (now + 3600);
        return _svcToken;
      }
      console.error('[reconcile] service login thất bại:', d?.message || 'no token');
    } catch (e) { console.error('[reconcile] service login error:', e.message); }
  }
  // 2) Fallback: token admin gần nhất trong partner_tokens (admin đã đăng nhập dashboard)
  try {
    const db = await getDb();
    const [rows] = await db.execute(
      `SELECT token FROM partner_tokens
       WHERE roles_json LIKE '%admin%' OR roles_json LIKE '%accounting_manager%'
       ORDER BY created_at DESC LIMIT 1`
    );
    if (rows.length) return rows[0].token;
  } catch (e) { console.error('[reconcile] token fallback error:', e.message); }
  return null;
}

// Merge giá trị hủy theo domain, MONOTONIC (giữ max cũ/mới): khi 1 SP đã hủy bị xóa
// khỏi đơn, lần chạy sau không thấy nó nữa → nếu lấy giá trị mới sẽ cộng ngược doanh thu.
// Giữ max đảm bảo giá trị đã trừ không quay lại. Trả {arr, total}.
function mergeCancelledDomains(existingJson, newMap) {
  const merged = {};
  try {
    const arr = JSON.parse(existingJson || '[]');
    if (Array.isArray(arr)) for (const e of arr) if (e && e.domain != null) merged[e.domain] = Number(e.amount) || 0;
  } catch {}
  for (const [d, amt] of Object.entries(newMap)) merged[d] = Math.max(merged[d] || 0, amt);
  const arr = Object.entries(merged)
    .map(([domain, amount]) => ({ domain, amount: Math.round(amount * 100) / 100 }))
    .filter(e => e.amount > 0);
  const total = Math.round(arr.reduce((s, e) => s + e.amount, 0) * 100) / 100;
  return { arr, total };
}

async function reconcileCancelledOrders() {
  if (IS_MOCK) return { skipped: 'mock' };
  const token = await getReconcileToken();
  if (!token) { console.warn('[reconcile] bỏ qua: chưa có RECONCILE_EMAIL/PASS và chưa có token admin nào'); return { skipped: 'no-token' }; }

  const pad = n => String(n).padStart(2, '0');
  // Cửa sổ cuộn 400 ngày (phủ preset "Năm nay" + range tùy chọn vắt qua năm).
  // Đơn có item cancel là tập nhỏ → chỉ vài trang 100/đơn, rất nhẹ.
  const fromD = new Date(Date.now() - 400 * 24 * 3600 * 1000 + 7 * 3600 * 1000);
  const from = `${pad(fromD.getUTCDate())}-${pad(fromD.getUTCMonth() + 1)}-${fromD.getUTCFullYear()}`;
  const vn = new Date(Date.now() + 7 * 3600 * 1000);
  const to = `${pad(vn.getUTCDate())}-${pad(vn.getUTCMonth() + 1)}-${vn.getUTCFullYear()}`;

  const cancelledCodes = new Set();     // đơn hủy TOÀN BỘ (order_status=cancelled)
  const partialByOrder = new Map();     // đơn CÒN hiệu lực, hủy 1 phần: code -> { domain: amount }
  const statusCounts = {};              // chẩn đoán: đếm order_status Basso trả về
  let ordersSeen = 0;
  let page = 1, totalPages = 1, guard = 0, apiCalls = 0;
  do {
    const params = new URLSearchParams({
      item_status: 'not_available', order_status: 'all',
      from, to, page: String(page), page_size: '100',
    });
    let d;
    try {
      const r = await fetch(`${BASSO_URL}/partner/getOrdersWithCancelledItems?${params.toString()}`, {
        headers: { 'X-Partner-Api-Key': BASSO_KEY, 'Authorization': `Bearer ${token}` },
      });
      apiCalls++;
      if (r.status === 401 || r.status === 403) { _svcToken = null; console.warn('[reconcile] token hết hạn giữa chừng, dừng'); break; }
      d = await r.json().catch(() => null);
    } catch (e) { console.error('[reconcile] fetch page error:', e.message); break; }
    if (!d?.success || !d?.data) break;
    for (const o of (d.data.orders || [])) {
      const code = o.order_code;
      ordersSeen++;
      const st = o.order_status || '?';
      statusCounts[st] = (statusCounts[st] || 0) + 1;
      if (!code) continue;
      if (st === 'cancelled') { cancelledCodes.add(code); continue; }
      // Đơn còn hiệu lực: cộng giá trị các dòng not_available theo domain (để trừ cả top web).
      const m = partialByOrder.get(code) || {};
      for (const it of (o.items || [])) {
        const amt = (Number(it.price) || 0) * (Number(it.quantity) || 1);
        if (amt <= 0) continue;
        const domain = extractDomain(it.link) || (it.website || '').toLowerCase().replace(/^www\./, '');
        m[domain] = (m[domain] || 0) + amt;
      }
      if (Object.keys(m).length) partialByOrder.set(code, m);
    }
    const total = Number(d.data.total_orders) || 0;
    const ps = Number(d.data.page_size) || 100;
    totalPages = Math.max(1, Math.ceil(total / ps));
    page++;
  } while (page <= totalPages && ++guard < 200);

  const db = await getDb();

  // 1) Hủy toàn bộ → cancelled_at (loại khỏi CẢ số đơn lẫn giá trị).
  let marked = 0;
  if (cancelledCodes.size) {
    const codes = [...cancelledCodes];
    for (let i = 0; i < codes.length; i += 200) {
      const chunk = codes.slice(i, i + 200);
      try {
        const [res] = await db.execute(
          `UPDATE order_log SET cancelled_at = NOW() WHERE cancelled_at IS NULL AND order_code IN (${chunk.map(() => '?').join(',')})`,
          chunk
        );
        marked += res.affectedRows || 0;
      } catch (e) { console.error('[reconcile] update cancelled_at error:', e.message); }
    }
  }

  // 2) Hủy một phần (không nằm trong nhóm hủy toàn bộ) → cập nhật cancelled_amount +
  //    cancelled_domains_json. Chỉ đụng đơn do Mon tạo (có trong order_log, cancelled_at NULL).
  let partialUpdated = 0;
  const partialCodes = [...partialByOrder.keys()].filter(c => !cancelledCodes.has(c));
  if (partialCodes.length) {
    const existing = new Map();
    for (let i = 0; i < partialCodes.length; i += 200) {
      const chunk = partialCodes.slice(i, i + 200);
      try {
        const [rows] = await db.execute(
          `SELECT order_code, cancelled_domains_json FROM order_log WHERE cancelled_at IS NULL AND order_code IN (${chunk.map(() => '?').join(',')})`,
          chunk
        );
        for (const r of rows) if (!existing.has(r.order_code)) existing.set(r.order_code, r.cancelled_domains_json);
      } catch (e) { console.error('[reconcile] select partial error:', e.message); }
    }
    for (const code of partialCodes) {
      if (!existing.has(code)) continue; // không phải đơn do Mon tạo → bỏ qua
      const { arr, total } = mergeCancelledDomains(existing.get(code), partialByOrder.get(code));
      try {
        const [res] = await db.execute(
          `UPDATE order_log SET cancelled_amount = ?, cancelled_domains_json = ? WHERE order_code = ? AND cancelled_at IS NULL`,
          [total, arr.length ? JSON.stringify(arr) : null, code]
        );
        if (res.affectedRows) partialUpdated++;
      } catch (e) { console.error('[reconcile] update partial error:', e.message); }
    }
  }

  console.log(`[reconcile] ${apiCalls} call · window=${from}..${to} · orders thấy=${ordersSeen} statuses=${JSON.stringify(statusCounts)} · hủy toàn bộ=${cancelledCodes.size} đánh dấu order_log=${marked} · hủy một phần cập nhật=${partialUpdated}`);
  return { apiCalls, window: `${from}..${to}`, ordersSeen, statusCounts, cancelled: cancelledCodes.size, marked, partialUpdated };
}

// Lịch 10h/14h/18h/22h giờ VN (UTC+7) — tự tính, không cần thư viện cron.
function msUntilNextReconcile() {
  const HOURS = [10, 14, 18, 22];
  const now = Date.now();
  const vn = new Date(now + 7 * 3600 * 1000); // getUTC* đọc thành giờ VN
  const Y = vn.getUTCFullYear(), M = vn.getUTCMonth(), D = vn.getUTCDate();
  for (const h of HOURS) {
    const epoch = Date.UTC(Y, M, D, h, 0, 0) - 7 * 3600 * 1000; // giờ tường VN → epoch UTC
    if (epoch > now + 1000) return epoch - now;
  }
  return (Date.UTC(Y, M, D + 1, HOURS[0], 0, 0) - 7 * 3600 * 1000) - now;
}

function scheduleReconcile() {
  const delay = msUntilNextReconcile();
  console.log(`[reconcile] lần chạy kế tiếp sau ~${Math.round(delay / 60000)} phút`);
  setTimeout(async () => {
    try { await reconcileCancelledOrders(); } catch (e) { console.error('[reconcile] run error:', e.message); }
    scheduleReconcile();
  }, delay);
}

// Trigger thủ công (admin) — test ngay sau deploy, khỏi đợi tới giờ.
app.get('/api/reconcile-run', async (req, res) => {
  const user = await resolveUserFull(req);
  const isAdmin = user && (user.roles || []).some(r => /admin|accounting_manager/i.test(r));
  if (!isAdmin) return res.status(403).json({ success: false, message: 'Chỉ admin' });
  try {
    res.json({ success: true, data: await reconcileCancelledOrders() });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
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
    scheduleReconcile();
    // Chạy 1 lần ngay sau khi khởi động (chờ 20s cho DB/bảng sẵn sàng) để đối soát
    // ngay sau mỗi lần reload bot, khỏi phải đợi tới mốc 10/14/18/22h. Rất nhẹ.
    setTimeout(() => {
      reconcileCancelledOrders().catch(e => console.error('[reconcile] bootstrap error:', e.message));
    }, 20000);
  });
}

module.exports = app;
