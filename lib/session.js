// 세션 쿠키 — 서버가 발급하는 불투명(opaque) 토큰 + HttpOnly 쿠키. 토큰 자체는 DB에 저장하지
// 않고 sha256 해시만 저장한다(DB가 유출돼도 토큰을 그대로 재사용할 수 없게 하기 위함).
//
// 일반 사용자 세션과 관리자 세션은 쿠키 이름과 sessions.kind가 모두 다르다 — 일반 닉네임
// 로그인 경로로는 구조적으로 관리자 세션을 발급받을 수 없다.
'use strict';
const crypto = require('crypto');

const SESSION_COOKIE = 'adhd_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30일
const ADMIN_SESSION_COOKIE = 'adhd_admin_session';
const ADMIN_SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12시간 — 관리자 세션은 짧게 유지한다

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}
function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function parseCookies(header) {
  const out = {};
  (header || '').split(';').forEach(part => {
    const eq = part.indexOf('=');
    if (eq === -1) return;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k) { try { out[k] = decodeURIComponent(v); } catch (e) { out[k] = v; } }
  });
  return out;
}

// secure: HTTPS 요청에서만 Secure 속성을 붙인다 — 로컬 http 개발 환경에서 Secure를 강제하면
// 브라우저가 쿠키 자체를 저장하지 않아 로그인이 전혀 동작하지 않게 되므로, 실제 프로토콜을 보고
// 판단한다(Vercel은 항상 https이므로 자동으로 Secure가 붙는다).
function serializeCookie(name, token, secure, maxAgeSec) {
  const parts = [`${name}=${token}`, 'Path=/', 'HttpOnly', `Max-Age=${maxAgeSec}`, 'SameSite=Lax'];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}
function serializeSessionCookie(token, secure) {
  return serializeCookie(SESSION_COOKIE, token, secure, Math.floor(SESSION_TTL_MS / 1000));
}
function serializeClearCookie(secure) {
  return serializeCookie(SESSION_COOKIE, '', secure, 0);
}
function serializeAdminSessionCookie(token, secure) {
  return serializeCookie(ADMIN_SESSION_COOKIE, token, secure, Math.floor(ADMIN_SESSION_TTL_MS / 1000));
}
function serializeClearAdminCookie(secure) {
  return serializeCookie(ADMIN_SESSION_COOKIE, '', secure, 0);
}

function isHttps(req) {
  if (req.headers['x-forwarded-proto'] === 'https') return true;
  if (req.socket && req.socket.encrypted) return true;
  return false;
}

// 상태 변경 요청의 CSRF 1차 방어 — 같은 출처에서 온 요청인지 확인한다(SameSite=Lax 쿠키와
// 세션에 묶인 CSRF 토큰 검사와 함께 쓰는 다중 방어의 한 겹).
function isSameOriginRequest(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // 브라우저가 Origin을 보내지 않는 요청(동일 출처 GET 등)은 아래 토큰 검사로 막는다
  try {
    const host = req.headers.host;
    return new URL(origin).host === host;
  } catch (e) { return false; }
}

module.exports = {
  SESSION_COOKIE, SESSION_TTL_MS, ADMIN_SESSION_COOKIE, ADMIN_SESSION_TTL_MS,
  generateToken, hashToken, parseCookies,
  serializeSessionCookie, serializeClearCookie,
  serializeAdminSessionCookie, serializeClearAdminCookie,
  isHttps, isSameOriginRequest
};
