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

// ===== HEALTH CHECK =====
app.get('/health', (req, res) => {
  res.json({ status: 'ok', mock: IS_MOCK });
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
- price: giá hiện tại (số thực, không có ký hiệu tiền tệ)
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
      { headers: { 'X-Partner-Api-Key': BASSO_KEY } }
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
      headers: { 'X-Partner-Api-Key': BASSO_KEY },
      body: formData,
    });
    const data = await response.json();
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
    const response = await fetch(`${BASSO_URL}/partner/createOrder`, {
      method: 'POST',
      headers: {
        'X-Partner-Api-Key': BASSO_KEY,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    });
    const data = await response.json();
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
