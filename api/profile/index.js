// Vercel Node 함수 진입점 — GET/PUT /api/profile (사용자별 서버 저장 불러오기/저장)
const { getProfile, saveProfile } = require('../../lib/authApi');
const { applyResultVercel } = require('../../lib/httpAdapter');

module.exports = async function handler(req, res) {
  if (req.method === 'GET') {
    const result = await getProfile(req);
    applyResultVercel(req, res, result);
    return;
  }
  if (req.method === 'PUT') {
    let body;
    try { body = req.body; } catch (e) { res.status(400).json({ error: 'invalid_json', message: '요청 본문이 올바른 JSON 형식이 아니에요.' }); return; }
    const result = await saveProfile(req, body || {});
    applyResultVercel(req, res, result);
    return;
  }
  res.status(405).json({ error: 'Method Not Allowed' });
};
