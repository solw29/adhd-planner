// Vercel Node 함수 진입점 — /api/admin/<route> 전체를 하나의 catch-all 함수가 받는다.
// 실제 로직은 lib/adminApi.js가 전부 담당하며, 로컬 server.js도 같은 함수를 호출한다.
const { handleAdminRoute } = require('../../lib/adminApi');
const { applyResultVercel } = require('../../lib/httpAdapter');

module.exports = async function handler(req, res) {
  // Vercel의 동적 경로 파라미터(req.query.route)는 문자열 또는 배열로 들어온다.
  const raw = req.query && req.query.route;
  const route = Array.isArray(raw) ? raw.join('/') : String(raw || '');
  if (!route) { res.status(404).json({ error: 'not_found', message: '알 수 없는 관리자 경로예요.' }); return; }

  if (req.method !== 'GET' && req.method !== 'POST') {
    res.status(405).json({ error: 'Method Not Allowed' });
    return;
  }

  let body = {};
  if (req.method === 'POST') {
    try { body = req.body || {}; }
    catch (e) { res.status(400).json({ error: 'invalid_json', message: '요청 본문이 올바른 JSON 형식이 아니에요.' }); return; }
  }

  const result = await handleAdminRoute(req.method, route, req, body, req.query || {});
  applyResultVercel(req, res, result);
};
