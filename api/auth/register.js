// Vercel Node 함수 진입점 — POST /api/auth/register
const { register } = require('../../lib/authApi');
const { applyResultVercel } = require('../../lib/httpAdapter');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method Not Allowed' }); return; }
  let body;
  try { body = req.body; } catch (e) { res.status(400).json({ error: 'invalid_json', message: '요청 본문이 올바른 JSON 형식이 아니에요.' }); return; }
  const result = await register(req, body || {});
  applyResultVercel(req, res, result);
};
