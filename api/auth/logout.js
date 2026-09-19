// Vercel Node 함수 진입점 — POST /api/auth/logout
const { logout } = require('../../lib/authApi');
const { applyResultVercel } = require('../../lib/httpAdapter');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method Not Allowed' }); return; }
  const result = await logout(req);
  applyResultVercel(req, res, result);
};
