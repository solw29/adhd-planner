// lib/authApi.js·lib/adminApi.js가 돌려주는 { status, body, setCookie?, clearCookie?, setAdminCookie?,
// clearAdminCookie?, headers? } 결과를 실제 HTTP 응답에 그대로 반영한다. Vercel(res.status().json())과
// 로컬 server.js(res.writeHead/end)의 응답 API가 달라 어댑터만 둘로 나누고, 로직은 완전히 공유한다.
'use strict';
const { serializeClearCookie, serializeClearAdminCookie, isHttps } = require('./session');

// 결과에 담긴 쿠키 지시들을 실제 Set-Cookie 값 배열로 바꾼다(사용자 쿠키와 관리자 쿠키는 서로 다른
// 쿠키라 동시에 설정될 수도 있다).
function cookiesFor(req, result) {
  const cookies = [];
  if (result.setCookie) cookies.push(result.setCookie);
  else if (result.clearCookie) cookies.push(serializeClearCookie(isHttps(req)));
  if (result.setAdminCookie) cookies.push(result.setAdminCookie);
  else if (result.clearAdminCookie) cookies.push(serializeClearAdminCookie(isHttps(req)));
  return cookies;
}

function applyResultVercel(req, res, result) {
  const cookies = cookiesFor(req, result);
  if (cookies.length) res.setHeader('Set-Cookie', cookies.length === 1 ? cookies[0] : cookies);
  if (result.headers) Object.keys(result.headers).forEach(k => res.setHeader(k, result.headers[k]));
  res.status(result.status).json(result.body);
}

function applyResultNode(req, res, result) {
  const headers = Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, result.headers || {});
  const cookies = cookiesFor(req, result);
  if (cookies.length) headers['Set-Cookie'] = cookies.length === 1 ? cookies[0] : cookies;
  res.writeHead(result.status, headers);
  res.end(JSON.stringify(result.body));
}

module.exports = { applyResultVercel, applyResultNode };
