// 닉네임 기반 인증 + 사용자별 서버 저장의 실제 비즈니스 로직. server.js(로컬)와 api/*.js
// (Vercel)가 이 모듈의 순수 함수만 호출한다 — 두 실행 환경 모두 요청 파싱만 다르고 로직은
// 완전히 같다.
//
// 각 함수는 { status, body, setCookie? } 형태의 결과를 돌려준다. setCookie가 있으면 호출부가
// Set-Cookie 헤더로 그대로 얹는다.
'use strict';
const { getDb } = require('./db');
const { validateNickname } = require('./nickname');
const { generateToken, hashToken, SESSION_TTL_MS, serializeSessionCookie, serializeClearCookie, parseCookies, SESSION_COOKIE } = require('./session');
const { checkRateLimit, clientIpOf } = require('./rateLimit');

const MAX_PROFILE_BYTES = 4 * 1024 * 1024; // 플래너 데이터 하나치고는 넉넉한 상한(오남용 방지용)

function dbOrUnavailable() {
  const db = getDb();
  if (!db) {
    return { error: { status: 503, body: { error: 'server_storage_not_configured', message: '서버 저장소가 아직 연결되지 않았어요. 관리자에게 DATABASE_URL 설정을 요청해주세요.' } } };
  }
  return { db };
}

function getSessionToken(req) {
  const cookies = parseCookies(req.headers.cookie);
  return cookies[SESSION_COOKIE] || null;
}

async function requireSession(req) {
  const { db, error } = dbOrUnavailable();
  if (error) return { error };
  const token = getSessionToken(req);
  if (!token) return { error: { status: 401, body: { error: 'not_logged_in', message: '로그인이 필요해요.' } } };
  const session = await db.getSession(token, 'user');
  if (!session) return { error: { status: 401, body: { error: 'session_expired', message: '접속이 만료됐어요. 다시 로그인해주세요.' }, clearCookie: true } };
  const user = await db.findUserById(session.userId);
  if (!user) return { error: { status: 401, body: { error: 'session_expired', message: '접속이 만료됐어요. 다시 로그인해주세요.' }, clearCookie: true } };
  return { db, user, token };
}

/* ------------------------------------------------------------
   회원가입
------------------------------------------------------------ */
async function register(req, body) {
  const { db, error } = dbOrUnavailable();
  if (error) return error;

  const ip = clientIpOf(req);
  if (!checkRateLimit('register:' + ip, 8, 60 * 1000)) {
    return { status: 429, body: { error: 'rate_limited', message: '요청이 너무 잦아요. 잠시 후 다시 시도해주세요.' } };
  }

  const v = validateNickname(body && body.nickname);
  if (!v.ok) return { status: 400, body: { error: 'invalid_nickname', message: v.error } };

  let user;
  try {
    user = await db.createUser({ nickname: v.nickname, nicknameKey: v.nicknameKey });
  } catch (e) {
    if (e && e.code === 'NICKNAME_TAKEN') {
      return { status: 409, body: { error: 'nickname_taken', message: '이미 사용 중인 닉네임이에요. 로그인을 이용해주세요.' } };
    }
    console.error('[auth/register] unexpected_error', e);
    return { status: 500, body: { error: 'internal_error', message: '가입 중 오류가 발생했어요. 잠시 후 다시 시도해주세요.' } };
  }

  const { token } = await db.createSession(user.id, SESSION_TTL_MS, { kind: 'user' });
  return {
    status: 200,
    body: { ok: true, user: { id: user.id, nickname: user.nickname } },
    setCookie: serializeSessionCookie(token, isHttpsReq(req))
  };
}

/* ------------------------------------------------------------
   로그인
------------------------------------------------------------ */
async function login(req, body) {
  const { db, error } = dbOrUnavailable();
  if (error) return error;

  const ip = clientIpOf(req);
  if (!checkRateLimit('login:' + ip, 20, 60 * 1000)) {
    return { status: 429, body: { error: 'rate_limited', message: '요청이 너무 잦아요. 잠시 후 다시 시도해주세요.' } };
  }

  const v = validateNickname(body && body.nickname);
  if (!v.ok) return { status: 400, body: { error: 'invalid_nickname', message: v.error } };

  const user = await db.findUserByNicknameKey(v.nicknameKey);
  if (!user) {
    // 오타를 신규 가입으로 자동 처리하지 않는다 — 미등록임을 분명히 알리고, 클라이언트가
    // "회원가입으로 이동" 버튼을 보여주게 한다.
    return { status: 404, body: { error: 'nickname_not_found', message: '등록되지 않은 닉네임이에요.' } };
  }
  // 관리자 계정은 비밀번호 없는 닉네임 로그인으로 절대 접속할 수 없다. 세션 종류(kind)와 쿠키가
  // 애초에 분리돼 있어 이 경로로는 관리자 세션 자체가 만들어지지 않지만, 여기서 한 번 더 막는다.
  if (user.role === 'admin') {
    return { status: 403, body: { error: 'admin_account', message: '이 닉네임은 일반 로그인으로 접속할 수 없어요.' } };
  }

  const { token } = await db.createSession(user.id, SESSION_TTL_MS, { kind: 'user' });
  return {
    status: 200,
    body: { ok: true, user: { id: user.id, nickname: user.nickname } },
    setCookie: serializeSessionCookie(token, isHttpsReq(req))
  };
}

/* ------------------------------------------------------------
   로그아웃
------------------------------------------------------------ */
async function logout(req) {
  const db = getDb();
  const token = getSessionToken(req);
  if (db && token) { try { await db.deleteSession(token); } catch (e) { /* 세션 삭제 실패해도 쿠키는 지운다 */ } }
  return { status: 200, body: { ok: true }, setCookie: serializeClearCookie(isHttpsReq(req)) };
}

/* ------------------------------------------------------------
   현재 접속 상태 확인(새로고침·재방문 복원용)
------------------------------------------------------------ */
async function me(req) {
  const db = getDb();
  if (!db) return { status: 200, body: { loggedIn: false, storageConfigured: false } };
  const token = getSessionToken(req);
  if (!token) return { status: 200, body: { loggedIn: false, storageConfigured: true } };
  const session = await db.getSession(token, 'user');
  if (!session) return { status: 200, body: { loggedIn: false, storageConfigured: true }, setCookie: serializeClearCookie(isHttpsReq(req)) };
  const user = await db.findUserById(session.userId);
  if (!user) return { status: 200, body: { loggedIn: false, storageConfigured: true }, setCookie: serializeClearCookie(isHttpsReq(req)) };
  return { status: 200, body: { loggedIn: true, storageConfigured: true, user: { id: user.id, nickname: user.nickname } } };
}

/* ------------------------------------------------------------
   프로필 불러오기 / 저장 / 비로그인 데이터 가져오기
------------------------------------------------------------ */
async function getProfile(req) {
  const { db, user, error } = await requireSession(req);
  if (error) return error;
  const profile = await db.getProfile(user.id);
  if (!profile) return { status: 404, body: { error: 'profile_not_found', message: '프로필을 찾을 수 없어요.' } };
  return { status: 200, body: { data: profile.data, revision: profile.revision, importedGuestAt: profile.importedGuestAt } };
}

async function saveProfile(req, body) {
  const { db, user, error } = await requireSession(req);
  if (error) return error;

  if (!body || typeof body !== 'object' || typeof body.data !== 'object' || body.data === null || Array.isArray(body.data)) {
    return { status: 400, body: { error: 'invalid_payload', message: '저장할 데이터 형식이 올바르지 않아요.' } };
  }
  if (!Number.isInteger(body.expectedRevision) || body.expectedRevision < 0) {
    return { status: 400, body: { error: 'invalid_payload', message: 'revision 값이 올바르지 않아요.' } };
  }
  const size = Buffer.byteLength(JSON.stringify(body.data), 'utf-8');
  if (size > MAX_PROFILE_BYTES) {
    return { status: 413, body: { error: 'payload_too_large', message: '저장할 데이터가 너무 커요.' } };
  }

  const result = await db.saveProfile(user.id, body.data, body.expectedRevision);
  if (!result.ok) {
    if (result.reason === 'conflict') {
      // 조용히 덮어쓰지 않는다 — 클라이언트가 최신 데이터를 다시 불러와 사용자에게 확인시키고
      // 재시도하게 한다(요구사항 5).
      return { status: 409, body: { error: 'conflict', message: '다른 기기·탭에서 먼저 저장됐어요. 최신 데이터를 확인한 뒤 다시 시도해주세요.', currentRevision: result.currentRevision } };
    }
    return { status: 404, body: { error: 'profile_not_found', message: '프로필을 찾을 수 없어요.' } };
  }
  return { status: 200, body: { ok: true, revision: result.revision } };
}

// 비로그인(게스트) 로컬 데이터를 서버 프로필로 가져온다 — 서버에 이미 무언가 저장된 적 있으면
// (revision>0) 자동 병합·자동 교체하지 않고 거절한다. DB의 원자적 조건부 갱신으로 중복 클릭·
// 재시도·새로고침에도 두 번 반영되지 않는다.
async function importGuestData(req, body) {
  const { db, user, error } = await requireSession(req);
  if (error) return error;

  if (!body || typeof body !== 'object' || typeof body.data !== 'object' || body.data === null || Array.isArray(body.data)) {
    return { status: 400, body: { error: 'invalid_payload', message: '가져올 데이터 형식이 올바르지 않아요.' } };
  }
  const size = Buffer.byteLength(JSON.stringify(body.data), 'utf-8');
  if (size > MAX_PROFILE_BYTES) {
    return { status: 413, body: { error: 'payload_too_large', message: '가져올 데이터가 너무 커요.' } };
  }

  const result = await db.importGuestProfile(user.id, body.data);
  if (!result.ok) {
    return { status: 409, body: { error: 'already_has_data', message: '이미 서버에 저장된 기록이 있어서 자동으로 가져올 수 없어요.' } };
  }
  return { status: 200, body: { ok: true, revision: result.revision } };
}

function isHttpsReq(req) {
  return req.headers['x-forwarded-proto'] === 'https' || !!(req.socket && req.socket.encrypted);
}

module.exports = { register, login, logout, me, getProfile, saveProfile, importGuestData };
