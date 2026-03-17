require('dotenv').config();
const key = process.env.BASSO_API_KEY;
console.log('key:', JSON.stringify(key));
console.log('length:', key ? key.length : 0);
console.log('isMock:', !key || key.trim() === 'your-basso-key-here');
