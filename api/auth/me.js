// Vercel Node 함수 진입점 — GET /api/auth/me (새로고침·재방문 시 접속 상태 복원용)
const { me } = require('../../lib/authApi');
const { applyResultVercel } = require('../../lib/httpAdapter');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') { res.status(405).json({ error: 'Method Not Allowed' }); return; }
  const result = await me(req);
  applyResultVercel(req, res, result);
};
