require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
const upload = multer({ storage: multer.memoryStorage() });
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const BASSO_KEY = process.env.BASSO_API_KEY || '';
const BASSO_URL = process.env.BASSO_BASE_URL || '';
const IS_MOCK = !BASSO_KEY || BASSO_KEY === 'your-basso-key-here';
console.log('Mock mode:', IS_MOCK);

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
    const TOTAL_PRICE_DOMAINS = ['tommy.com', 'tommyhilfiger.com', 'usa.tommy.com'];
    const domain = links.length > 0 ? (() => { try { return new URL(links[0]).hostname.toLowerCase(); } catch { return ''; } })() : '';
    const isTotalPriceSite = TOTAL_PRICE_DOMAINS.some(d => domain.includes(d));
    const priceRule = isTotalPriceSite
      ? `- price: Website này (${domain}) hiển thị TỔNG GIÁ cho tất cả qty. BẮT BUỘC chia: price = total_shown / quantity. Ví dụ qty=3, hiển thị $245.70 → price = 245.70/3 = 81.90.`
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
- variations: mảng thuộc tính size/color/etc

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

// ===== CHAT TỰ NHIÊN =====
app.post('/api/chat', async (req, res) => {
  try {
    const { message, context } = req.body;
    const response = await anthropic.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 512,
      system: `Bạn là trợ lý tạo đơn hàng AI. Nhiệm vụ của bạn là giúp người dùng tạo đơn hàng từ ảnh giỏ hàng.
Ngữ cảnh hiện tại: ${context || ''}
Trả lời ngắn gọn, thân thiện bằng tiếng Việt. Nếu người dùng hỏi ngoài chủ đề tạo đơn, nhẹ nhàng hướng họ trở lại.`,
      messages: [{ role: 'user', content: message }],
    });
    res.json({ success: true, text: response.content[0].text });
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
  });
}

module.exports = app;
