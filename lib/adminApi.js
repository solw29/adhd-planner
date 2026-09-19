// 관리자 가입·로그인과 데이터 관리(조회/테스트 계정/초기화/백업/복원/삭제/이력)의 실제 로직.
// server.js(로컬)와 api/admin/[...route].js(Vercel)가 이 모듈의 handleAdminRoute() 하나만 호출한다.
//
// 보안 요약
// - 관리자 세션은 일반 사용자 세션과 쿠키 이름(adhd_admin_session)과 sessions.kind가 모두 다르다.
//   즉 일반 닉네임 로그인 경로로는 구조적으로 관리자 세션을 얻을 수 없다.
// - 모든 관리자 API는 세션 → users.role='admin' 확인을 서버에서 매번 수행한다(클라이언트 값 불신).
// - 상태 변경 요청은 Origin 동일 출처 검사 + 세션에 묶인 CSRF 토큰(x-csrf-token) 검사를 함께 거친다.
// - 초대 코드/비밀번호/세션 토큰은 응답·로그 어디에도 남기지 않는다.
'use strict';
const crypto = require('crypto');
const { getDb } = require('./db');
const { validateNickname, normalizeNickname } = require('./nickname');
const { hashPassword, verifyPassword, validatePasswordRule, secretEquals } = require('./password');
const {
  ADMIN_SESSION_COOKIE, ADMIN_SESSION_TTL_MS, parseCookies,
  serializeAdminSessionCookie, serializeClearAdminCookie, isHttps, isSameOriginRequest
} = require('./session');
const { checkRateLimit, clientIpOf } = require('./rateLimit');

const BACKUP_KIND = 'adhd-planner-user-data-backup';
const BACKUP_FORMAT_VERSION = 1;
const MAX_BACKUP_USERS = 5000;
const MAX_TEST_USERS_PER_CALL = 10;
const SUPPORTED_DATA_VERSIONS = [2, 3, 4];

const iso = (v) => (v instanceof Date ? v.toISOString() : (v || null));

/* ------------------------------------------------------------
   공통: 저장소 / 권한 / CSRF
------------------------------------------------------------ */
function dbOrUnavailable() {
  const db = getDb();
  if (!db) {
    return { error: { status: 503, body: { error: 'server_storage_not_configured', message: '서버 저장소가 아직 연결되지 않았어요. DATABASE_URL 설정이 필요해요.' } } };
  }
  return { db };
}

async function requireAdmin(req, opts) {
  const { db, error } = dbOrUnavailable();
  if (error) return { error };
  const token = parseCookies(req.headers.cookie)[ADMIN_SESSION_COOKIE];
  if (!token) return { error: { status: 401, body: { error: 'admin_not_logged_in', message: '관리자 로그인이 필요해요.' } } };
  const session = await db.getSession(token, 'admin');
  if (!session) return { error: { status: 401, body: { error: 'admin_session_expired', message: '관리자 접속이 만료됐어요. 다시 로그인해주세요.' }, clearAdminCookie: true } };
  const admin = await db.findUserById(session.userId);
  if (!admin || admin.role !== 'admin') {
    return { error: { status: 403, body: { error: 'forbidden', message: '관리자 권한이 필요해요.' }, clearAdminCookie: true } };
  }
  if (opts && opts.stateChanging) {
    if (!isSameOriginRequest(req)) {
      return { error: { status: 403, body: { error: 'csrf_origin', message: '요청 출처를 확인하지 못했어요.' } } };
    }
    if (!session.csrfToken || !secretEquals(req.headers['x-csrf-token'], session.csrfToken)) {
      return { error: { status: 403, body: { error: 'csrf_token', message: '보안 토큰이 올바르지 않아요. 관리자 페이지를 새로고침한 뒤 다시 시도해주세요.' } } };
    }
  }
  return { db, admin, session };
}

/* ------------------------------------------------------------
   데이터 요약 / 검증
------------------------------------------------------------ */
function summarizeData(data) {
  const base = { empty: true, schemaVersion: null, taskCount: 0, completedCount: 0, timeBlockCount: 0, categoryCount: 0, groupCount: 0, hasDday: false, conditionDays: 0 };
  if (!data || typeof data !== 'object' || Array.isArray(data)) return base;
  const tasks = Array.isArray(data.tasks) ? data.tasks : [];
  return {
    empty: false,
    schemaVersion: typeof data.version === 'number' ? data.version : null,
    taskCount: tasks.length,
    completedCount: tasks.filter(t => t && t.completed).length,
    timeBlockCount: Array.isArray(data.timeBlocks) ? data.timeBlocks.length : 0,
    categoryCount: Array.isArray(data.categories) ? data.categories.length : 0,
    groupCount: Array.isArray(data.groups) ? data.groups.length : 0,
    hasDday: !!(data.ddayDate && data.ddayTitle),
    conditionDays: (data.conditionByDate && typeof data.conditionByDate === 'object') ? Object.keys(data.conditionByDate).length : 0
  };
}

// 복원 대상 데이터의 구조 + 참조 관계를 서버에서 검증한다. 손상된 데이터는 기존 데이터를 전혀
// 건드리지 않고 거절한다.
function validateUserData(data) {
  if (data === null) return { ok: true, empty: true };
  if (typeof data !== 'object' || Array.isArray(data)) return { ok: false, error: '데이터가 객체 형식이 아니에요.' };
  if (!SUPPORTED_DATA_VERSIONS.includes(data.version)) {
    return { ok: false, error: `지원하지 않는 데이터 스키마 버전이에요(version=${data.version === undefined ? '없음' : data.version}).` };
  }
  const arrays = ['tasks', 'categories', 'groups', 'timeBlocks'];
  for (const key of arrays) {
    if (data[key] !== undefined && !Array.isArray(data[key])) return { ok: false, error: `${key} 항목이 배열이 아니에요.` };
  }
  if (!Array.isArray(data.tasks)) return { ok: false, error: 'tasks 항목이 없어요.' };

  const tasks = data.tasks, categories = data.categories || [], groups = data.groups || [], blocks = data.timeBlocks || [];
  const catIds = new Set(categories.map(c => c && c.id).filter(Boolean));
  const taskIds = new Set(tasks.map(t => t && t.id).filter(Boolean));
  if (taskIds.size !== tasks.length) return { ok: false, error: '업무 id가 비어 있거나 중복돼 있어요.' };

  const badTaskCat = tasks.find(t => t && t.categoryId != null && !catIds.has(t.categoryId));
  if (badTaskCat) return { ok: false, error: '존재하지 않는 카테고리를 참조하는 업무가 있어요.' };
  const badGroup = groups.find(g => g && g.categoryId != null && !catIds.has(g.categoryId));
  if (badGroup) return { ok: false, error: '존재하지 않는 카테고리를 참조하는 그룹이 있어요.' };
  const badBlock = blocks.find(b => b && Array.isArray(b.taskIds) && b.taskIds.some(id => !taskIds.has(id)));
  if (badBlock) return { ok: false, error: '존재하지 않는 업무를 참조하는 시간 블록이 있어요.' };

  return { ok: true, empty: false };
}

function validateBackupPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { ok: false, error: '백업 파일 형식이 아니에요.' };
  if (payload.kind !== BACKUP_KIND) return { ok: false, error: '이 앱의 사용자 데이터 백업 파일이 아니에요.' };
  if (!Number.isInteger(payload.formatVersion)) return { ok: false, error: '백업 형식 버전이 없어요.' };
  if (payload.formatVersion > BACKUP_FORMAT_VERSION) {
    return { ok: false, error: `알 수 없는 상위 백업 형식 버전이에요(${payload.formatVersion}). 이 서버는 ${BACKUP_FORMAT_VERSION}까지 지원해요.` };
  }
  if (!Array.isArray(payload.users) || payload.users.length === 0) return { ok: false, error: '백업에 사용자 데이터가 없어요.' };
  if (payload.users.length > MAX_BACKUP_USERS) return { ok: false, error: '백업에 포함된 사용자 수가 너무 많아요.' };

  const entries = [];
  for (const u of payload.users) {
    if (!u || typeof u !== 'object') return { ok: false, error: '백업 사용자 항목 형식이 올바르지 않아요.' };
    if (typeof u.userId !== 'string' || !u.userId) return { ok: false, error: '백업 사용자 항목에 userId가 없어요.' };
    if (typeof u.nickname !== 'string' || !u.nickname) return { ok: false, error: '백업 사용자 항목에 닉네임이 없어요.' };
    const data = u.data === undefined ? null : u.data;
    const v = validateUserData(data);
    if (!v.ok) return { ok: false, error: `'${u.nickname}' 데이터 검증 실패: ${v.error}` };
    entries.push({ userId: u.userId, nickname: u.nickname, data, summary: summarizeData(data) });
  }
  return { ok: true, entries };
}

/* ------------------------------------------------------------
   백업 생성(공통) — 스냅샷 → 저장 → 저장 성공 재확인까지 마쳐야 ok:true
------------------------------------------------------------ */
async function makeBackup(db, { scope, reason, userIds, admin, targetUser }) {
  let users;
  try {
    users = await db.snapshotUsers(userIds === undefined ? null : userIds);
  } catch (e) {
    console.error('[admin] snapshot_failed', e && e.message);
    return { ok: false, reason: 'snapshot_failed' };
  }
  // 일부만 읽힌 결과를 정상 백업으로 저장하지 않는다.
  if (Array.isArray(userIds) && users.length !== userIds.length) return { ok: false, reason: 'incomplete_snapshot' };
  if (!users.length) return { ok: false, reason: 'empty_snapshot' };

  const payload = {
    kind: BACKUP_KIND,
    formatVersion: BACKUP_FORMAT_VERSION,
    app: 'adhd-planner',
    note: '앱 사용자 데이터 백업입니다. 비밀번호 해시·세션·초대 코드 등 인증 정보는 포함하지 않으며, DB 전체 재해 복구 백업이 아닙니다.',
    createdAt: new Date().toISOString(),
    scope, reason,
    users: users.map(u => ({
      userId: u.userId,
      nickname: u.nickname,
      isTest: !!u.isTest,
      createdAt: iso(u.createdAt),
      dataSchemaVersion: (u.data && typeof u.data.version === 'number') ? u.data.version : null,
      revision: u.revision,
      data: u.data
    }))
  };
  const taskCount = payload.users.reduce((s, u) => s + (u.data && Array.isArray(u.data.tasks) ? u.data.tasks.length : 0), 0);

  let rec;
  try {
    rec = await db.createBackupRecord({
      formatVersion: BACKUP_FORMAT_VERSION, scope, reason,
      targetUserId: targetUser ? targetUser.id : null,
      targetNickname: targetUser ? targetUser.nickname : null,
      userCount: payload.users.length, taskCount,
      createdByUserId: admin ? admin.id : null, createdByNickname: admin ? admin.nickname : null,
      payload
    });
  } catch (e) {
    console.error('[admin] backup_write_failed', e && e.message);
    return { ok: false, reason: 'backup_write_failed' };
  }
  // 저장 성공 확인 — 실제로 다시 읽어 사용자 수가 일치할 때만 성공으로 본다.
  const readBack = await db.getBackup(rec.id);
  if (!readBack || !readBack.payload || !Array.isArray(readBack.payload.users) || readBack.payload.users.length !== payload.users.length) {
    return { ok: false, reason: 'backup_verify_failed' };
  }
  return { ok: true, backupId: rec.id, userCount: payload.users.length, taskCount, createdAt: readBack.createdAt };
}

const BACKUP_FAIL_MESSAGE = {
  snapshot_failed: '백업용 데이터를 읽지 못했어요.',
  incomplete_snapshot: '대상 일부를 읽지 못해 백업을 만들지 않았어요.',
  empty_snapshot: '백업할 대상이 없어요.',
  backup_write_failed: '백업을 저장하지 못했어요.',
  backup_verify_failed: '백업 저장을 확인하지 못했어요.'
};

/* ------------------------------------------------------------
   1) 관리자 가입 / 로그인 / 로그아웃 / 상태
------------------------------------------------------------ */
async function adminStatus(req) {
  const db = getDb();
  if (!db) return { status: 200, body: { storageConfigured: false, adminExists: false, isAdmin: false } };
  const exists = await db.adminExists();
  const token = parseCookies(req.headers.cookie)[ADMIN_SESSION_COOKIE];
  if (!token) return { status: 200, body: { storageConfigured: true, adminExists: exists, isAdmin: false, signupAvailable: !exists } };
  const session = await db.getSession(token, 'admin');
  if (!session) return { status: 200, body: { storageConfigured: true, adminExists: exists, isAdmin: false, signupAvailable: !exists }, clearAdminCookie: true };
  const admin = await db.findUserById(session.userId);
  if (!admin || admin.role !== 'admin') {
    return { status: 200, body: { storageConfigured: true, adminExists: exists, isAdmin: false, signupAvailable: !exists }, clearAdminCookie: true };
  }
  return {
    status: 200,
    body: { storageConfigured: true, adminExists: true, isAdmin: true, signupAvailable: false, nickname: admin.nickname, csrfToken: session.csrfToken }
  };
}

async function adminRegister(req, body) {
  const { db, error } = dbOrUnavailable();
  if (error) return error;
  const ip = clientIpOf(req);
  // 초대 코드 무차별 대입을 막는 별도의 엄격한 제한
  if (!checkRateLimit('admin_register:' + ip, 5, 10 * 60 * 1000)) {
    return { status: 429, body: { error: 'rate_limited', message: '요청이 너무 잦아요. 잠시 후 다시 시도해주세요.' } };
  }
  if (!isSameOriginRequest(req)) return { status: 403, body: { error: 'csrf_origin', message: '요청 출처를 확인하지 못했어요.' } };

  const inviteCode = process.env.ADMIN_INVITE_CODE || '';
  if (!inviteCode) {
    // 코드 자체는 절대 응답/로그에 남기지 않고, 미설정 사실만 알린다.
    return { status: 503, body: { error: 'invite_code_not_configured', message: '서버에 관리자 초대 코드가 설정돼 있지 않아요(ADMIN_INVITE_CODE).' } };
  }
  if (await db.adminExists()) {
    return { status: 403, body: { error: 'admin_already_exists', message: '이미 관리자 계정이 있어 이 가입 경로는 닫혀 있어요.' } };
  }
  if (!secretEquals(body && body.inviteCode, inviteCode)) {
    return { status: 403, body: { error: 'invalid_invite_code', message: '초대 코드가 올바르지 않아요.' } };
  }
  const v = validateNickname(body && body.nickname);
  if (!v.ok) return { status: 400, body: { error: 'invalid_nickname', message: v.error } };
  const pw = body && body.password;
  const pwRule = validatePasswordRule(pw);
  if (!pwRule.ok) return { status: 400, body: { error: 'invalid_password', message: pwRule.error } };
  if (pw !== (body && body.passwordConfirm)) {
    return { status: 400, body: { error: 'password_mismatch', message: '비밀번호 확인이 일치하지 않아요.' } };
  }

  const passwordHash = await hashPassword(pw);
  const result = await db.createFirstAdmin({ nickname: v.nickname, nicknameKey: v.nicknameKey, passwordHash });
  if (!result.ok) {
    if (result.reason === 'admin_exists') {
      return { status: 403, body: { error: 'admin_already_exists', message: '이미 관리자 계정이 있어 이 가입 경로는 닫혀 있어요.' } };
    }
    // 기존 일반 닉네임을 입력해도 그 계정을 관리자 계정으로 승격하지 않는다.
    return { status: 409, body: { error: 'nickname_taken', message: '이미 사용 중인 닉네임이에요. 다른 닉네임을 사용해주세요.' } };
  }
  const { token, csrfToken } = await db.createSession(result.user.id, ADMIN_SESSION_TTL_MS, { kind: 'admin' });
  await db.insertAudit({ adminUserId: result.user.id, adminNickname: result.user.nickname, action: 'admin_register', success: true, detail: '최초 관리자 생성' });
  return {
    status: 200,
    body: { ok: true, nickname: result.user.nickname, csrfToken },
    setAdminCookie: serializeAdminSessionCookie(token, isHttps(req))
  };
}

async function adminLogin(req, body) {
  const { db, error } = dbOrUnavailable();
  if (error) return error;
  const ip = clientIpOf(req);
  if (!checkRateLimit('admin_login:' + ip, 10, 10 * 60 * 1000)) {
    return { status: 429, body: { error: 'rate_limited', message: '로그인 시도가 너무 잦아요. 잠시 후 다시 시도해주세요.' } };
  }
  if (!isSameOriginRequest(req)) return { status: 403, body: { error: 'csrf_origin', message: '요청 출처를 확인하지 못했어요.' } };

  const v = validateNickname(body && body.nickname);
  const password = (body && body.password) || '';
  // 닉네임 형식 오류/미존재/비밀번호 불일치를 모두 같은 응답으로 돌려준다(계정 존재 여부 노출 방지).
  const fail = { status: 401, body: { error: 'invalid_credentials', message: '닉네임 또는 비밀번호가 올바르지 않아요.' } };
  if (!v.ok || !password) return fail;
  const user = await db.findUserByNicknameKey(v.nicknameKey);
  if (!user || user.role !== 'admin' || !user.passwordHash) return fail;
  const okPw = await verifyPassword(password, user.passwordHash);
  if (!okPw) return fail;

  const { token, csrfToken } = await db.createSession(user.id, ADMIN_SESSION_TTL_MS, { kind: 'admin' });
  return {
    status: 200,
    body: { ok: true, nickname: user.nickname, csrfToken },
    setAdminCookie: serializeAdminSessionCookie(token, isHttps(req))
  };
}

async function adminLogout(req) {
  const db = getDb();
  const token = parseCookies(req.headers.cookie)[ADMIN_SESSION_COOKIE];
  if (db && token) { try { await db.deleteSession(token); } catch (e) { /* 쿠키는 어차피 지운다 */ } }
  return { status: 200, body: { ok: true }, setAdminCookie: serializeClearAdminCookie(isHttps(req)) };
}

/* ------------------------------------------------------------
   2) 사용자 목록 / 상세
------------------------------------------------------------ */
async function adminUsers(req, query) {
  const { db, admin, error } = await requireAdmin(req);
  if (error) return error;
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const pageSize = Math.min(100, Math.max(5, parseInt(query.pageSize, 10) || 20));
  const filter = ['all', 'test', 'normal'].includes(query.filter) ? query.filter : 'all';
  const search = typeof query.q === 'string' ? normalizeNickname(query.q).slice(0, 40) : '';
  const [stats, list] = await Promise.all([
    db.getStats(),
    db.listUsers({ search, filter, offset: (page - 1) * pageSize, limit: pageSize })
  ]);
  return {
    status: 200,
    body: {
      stats,
      users: list.rows.map(u => Object.assign({}, u, { createdAt: iso(u.createdAt), lastSavedAt: iso(u.lastSavedAt), isSelf: u.id === admin.id })),
      total: list.total, page, pageSize, filter, q: search
    }
  };
}

async function adminUserDetail(req, query) {
  const { db, error } = await requireAdmin(req);
  if (error) return error;
  const user = await db.findUserById(String(query.userId || ''));
  if (!user) return { status: 404, body: { error: 'not_found', message: '사용자를 찾을 수 없어요.' } };
  const profile = await db.getProfile(user.id);
  return {
    status: 200,
    body: {
      user: { id: user.id, nickname: user.nickname, role: user.role, isTest: user.isTest, createdAt: iso(user.createdAt) },
      profile: {
        revision: profile ? profile.revision : 0,
        lastSavedAt: profile && profile.revision > 0 ? iso(profile.updatedAt) : null,
        importedGuestAt: profile ? iso(profile.importedGuestAt) : null,
        summary: summarizeData(profile ? profile.data : null)
      }
    }
  };
}

/* ------------------------------------------------------------
   3) 테스트 계정
------------------------------------------------------------ */
function buildSampleState(clientDate) {
  const today = (typeof clientDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(clientDate))
    ? clientDate : new Date().toISOString().slice(0, 10);
  const mk = (n) => `sample-${n}-${crypto.randomBytes(3).toString('hex')}`;
  const catSchool = 'cat-school', catLife = 'cat-life';
  return {
    version: 4, currentScreen: 'today', onboardingDone: true,
    categories: [
      { id: catSchool, name: '학교', color: '#64B5F6', order: 1 },
      { id: catLife, name: '개인', color: '#F48FB1', order: 3 }
    ],
    groups: [], timeBlocks: [], draftTasks: [], recQueue: [], recIndex: 0, recSuggestIdx: 0, draftBlocks: [],
    tasks: [
      { id: mk('t1'), categoryId: catSchool, groupId: null, title: '샘플 과제 정리', schedulingType: 'FLEXIBLE_TASK', plannerDate: today, date: null, startTime: null, endDate: null, endTime: null, deadline: null, estimatedMinutes: null, repeat: null, completed: false, sessionName: null },
      { id: mk('t2'), categoryId: catSchool, groupId: null, title: '샘플 수업', schedulingType: 'BLOCK_EVENT', plannerDate: today, date: today, startTime: '10:00', endDate: today, endTime: '11:30', deadline: null, estimatedMinutes: null, repeat: null, completed: true, completedSeq: 1, sessionName: null },
      { id: mk('t3'), categoryId: catLife, groupId: null, title: '샘플 운동', schedulingType: 'DURATION_TASK', plannerDate: today, date: null, startTime: null, endDate: null, endTime: null, deadline: null, estimatedMinutes: 30, repeat: null, completed: false, sessionName: null }
    ],
    calendarMonth: today.slice(0, 7), brainDumpText: '', checklistDate: today, recDate: null,
    ddayTitle: null, ddayDate: null, conditionByDate: {}
  };
}

async function adminCreateTestUsers(req, body) {
  const { db, admin, error } = await requireAdmin(req, { stateChanging: true });
  if (error) return error;

  const explicitNickname = body && body.nickname ? String(body.nickname) : '';
  let count = parseInt((body && body.count), 10);
  if (!Number.isFinite(count)) count = 1;
  if (explicitNickname) count = 1;
  if (count < 1 || count > MAX_TEST_USERS_PER_CALL) {
    return { status: 400, body: { error: 'invalid_count', message: `한 번에 1~${MAX_TEST_USERS_PER_CALL}개까지만 만들 수 있어요.` } };
  }
  const withSample = !!(body && body.withSample);
  const clientDate = body && body.clientDate;

  const created = [], failed = [];
  for (let i = 0; i < count; i++) {
    let nickname = explicitNickname;
    if (!nickname) {
      nickname = 'test_' + crypto.randomBytes(3).toString('hex'); // test_xxxxxx (11자)
    }
    const v = validateNickname(nickname);
    if (!v.ok) { failed.push({ nickname, reason: v.error }); continue; }
    try {
      // 테스트 여부는 닉네임 문자열 추측이 아니라 users.is_test 컬럼으로 명시 저장한다.
      const user = await db.createUser({ nickname: v.nickname, nicknameKey: v.nicknameKey, role: 'user', isTest: true });
      if (withSample) {
        const sample = buildSampleState(clientDate);
        await db.saveProfile(user.id, sample, 0);
      }
      await db.insertAudit({
        adminUserId: admin.id, adminNickname: admin.nickname, action: 'create_test_user',
        targetUserId: user.id, targetNickname: user.nickname, success: true,
        detail: withSample ? '샘플 데이터 포함' : '빈 계정'
      });
      created.push({ id: user.id, nickname: user.nickname });
    } catch (e) {
      const reason = (e && e.code === 'NICKNAME_TAKEN') ? '이미 사용 중인 닉네임이에요.' : '생성에 실패했어요.';
      failed.push({ nickname: v.nickname, reason });
      if (e && e.code !== 'NICKNAME_TAKEN') console.error('[admin] create_test_user_failed', e && e.message);
    }
  }
  return { status: created.length || !failed.length ? 200 : 409, body: { ok: created.length > 0, created, failed } };
}

async function adminSetTestFlag(req, body) {
  const { db, admin, error } = await requireAdmin(req, { stateChanging: true });
  if (error) return error;
  const userId = String((body && body.userId) || '');
  const isTest = !!(body && body.isTest);
  const target = await db.findUserById(userId);
  if (!target) return { status: 404, body: { error: 'not_found', message: '사용자를 찾을 수 없어요.' } };
  if (target.role === 'admin') return { status: 400, body: { error: 'admin_target', message: '관리자 계정에는 테스트 표시를 바꿀 수 없어요.' } };
  const ok = await db.setUserTestFlag(userId, isTest);
  if (!ok) return { status: 400, body: { error: 'update_failed', message: '변경하지 못했어요.' } };
  await db.insertAudit({
    adminUserId: admin.id, adminNickname: admin.nickname, action: 'set_test_flag',
    targetUserId: target.id, targetNickname: target.nickname, success: true,
    detail: isTest ? '테스트 계정으로 표시' : '테스트 표시 해제'
  });
  return { status: 200, body: { ok: true, isTest } };
}

/* ------------------------------------------------------------
   4) 데이터 초기화(단건 / 테스트 계정 일괄)
------------------------------------------------------------ */
async function adminReset(req, body) {
  const { db, admin, error } = await requireAdmin(req, { stateChanging: true });
  if (error) return error;

  const userIds = Array.isArray(body && body.userIds) ? body.userIds.map(String).filter(Boolean) : [];
  const operationId = (body && typeof body.operationId === 'string') ? body.operationId.slice(0, 64) : null;
  if (!userIds.length) return { status: 400, body: { error: 'no_targets', message: '초기화할 대상을 선택해주세요.' } };
  if (userIds.length > 50) return { status: 400, body: { error: 'too_many', message: '한 번에 50개까지만 처리할 수 있어요.' } };

  const targets = [];
  for (const id of userIds) {
    const u = await db.findUserById(id);
    if (!u) return { status: 404, body: { error: 'not_found', message: '대상 중 존재하지 않는 사용자가 있어요.' } };
    // 관리자 계정은 초기화 대상에서 제외한다(자기 자신 포함).
    if (u.role === 'admin') return { status: 400, body: { error: 'admin_target', message: '관리자 계정은 초기화할 수 없어요.' } };
    targets.push(u);
  }
  // 일괄 초기화는 "명시적으로 선택한 테스트 계정"에만 허용하고, 일반 계정이 섞이면 전체를 막는다.
  if (targets.length > 1) {
    const nonTest = targets.filter(t => !t.isTest);
    if (nonTest.length) {
      return {
        status: 400,
        body: { error: 'non_test_in_bulk', message: `일괄 초기화는 테스트 계정만 가능해요. 테스트 계정이 아닌 대상: ${nonTest.map(t => t.nickname).join(', ')}` }
      };
    }
  }

  const results = [];
  for (const target of targets) {
    // 같은 operationId로 이미 성공한 대상은 다시 처리하지 않는다(재시도 시 중복 작업 방지).
    if (operationId && await db.operationAlreadySucceeded(operationId, target.id)) {
      results.push({ userId: target.id, nickname: target.nickname, status: 'skipped', message: '이미 처리된 대상이에요.' });
      continue;
    }
    const backup = await makeBackup(db, { scope: 'user', reason: 'pre_reset', userIds: [target.id], admin, targetUser: target });
    if (!backup.ok) {
      // 백업이 실패하면 초기화를 실행하지 않는다.
      await db.insertAudit({
        adminUserId: admin.id, adminNickname: admin.nickname, action: 'reset',
        targetUserId: target.id, targetNickname: target.nickname, success: false,
        detail: '백업 실패로 초기화 중단: ' + backup.reason
      });
      results.push({ userId: target.id, nickname: target.nickname, status: 'failed', message: BACKUP_FAIL_MESSAGE[backup.reason] || '백업에 실패했어요.' });
      continue;
    }
    const res = await db.resetUserDataTx({
      userId: target.id,
      audit: {
        operationId, adminUserId: admin.id, adminNickname: admin.nickname, action: 'reset',
        targetUserId: target.id, targetNickname: target.nickname, backupId: backup.backupId,
        detail: '데이터 초기화(세션 무효화 포함)'
      }
    });
    if (!res.ok) {
      results.push({ userId: target.id, nickname: target.nickname, status: 'failed', message: '초기화에 실패했어요.', backupId: backup.backupId });
      continue;
    }
    results.push({ userId: target.id, nickname: target.nickname, status: 'ok', backupId: backup.backupId, revision: res.revision });
  }
  return { status: 200, body: { ok: results.every(r => r.status !== 'failed'), results } };
}

/* ------------------------------------------------------------
   5) 백업
------------------------------------------------------------ */
async function adminBackup(req, body) {
  const { db, admin, error } = await requireAdmin(req, { stateChanging: true });
  if (error) return error;
  const scope = (body && body.scope) === 'all' ? 'all' : 'user';

  let targetUser = null, userIds;
  if (scope === 'user') {
    targetUser = await db.findUserById(String((body && body.userId) || ''));
    if (!targetUser) return { status: 404, body: { error: 'not_found', message: '사용자를 찾을 수 없어요.' } };
    userIds = [targetUser.id];
  } else {
    userIds = undefined; // 전체(일반+테스트) 사용자
  }

  const backup = await makeBackup(db, { scope, reason: 'manual', userIds, admin, targetUser });
  if (!backup.ok) {
    await db.insertAudit({
      adminUserId: admin.id, adminNickname: admin.nickname, action: scope === 'all' ? 'backup_all' : 'backup_user',
      targetUserId: targetUser ? targetUser.id : null, targetNickname: targetUser ? targetUser.nickname : null,
      success: false, detail: '백업 실패: ' + backup.reason
    });
    return { status: 500, body: { error: backup.reason, message: BACKUP_FAIL_MESSAGE[backup.reason] || '백업에 실패했어요.' } };
  }
  await db.insertAudit({
    adminUserId: admin.id, adminNickname: admin.nickname, action: scope === 'all' ? 'backup_all' : 'backup_user',
    targetUserId: targetUser ? targetUser.id : null, targetNickname: targetUser ? targetUser.nickname : null,
    success: true, backupId: backup.backupId, detail: `사용자 ${backup.userCount}명 / 업무 ${backup.taskCount}개`
  });
  return { status: 200, body: { ok: true, backupId: backup.backupId, userCount: backup.userCount, taskCount: backup.taskCount } };
}

async function adminBackups(req) {
  const { db, error } = await requireAdmin(req);
  if (error) return error;
  const list = await db.listBackups(100);
  return { status: 200, body: { backups: list.map(b => Object.assign({}, b, { createdAt: iso(b.createdAt) })) } };
}

async function adminBackupDownload(req, query) {
  const { db, error } = await requireAdmin(req);
  if (error) return error;
  const backup = await db.getBackup(String(query.backupId || ''));
  if (!backup) return { status: 404, body: { error: 'not_found', message: '백업을 찾을 수 없어요.' } };
  return {
    status: 200,
    body: backup.payload,
    headers: { 'Content-Disposition': `attachment; filename="adhd-planner-backup-${backup.id}.json"` }
  };
}

/* ------------------------------------------------------------
   6) 복원 — 미리보기(검증만) → 적용
------------------------------------------------------------ */
async function adminRestorePreview(req, body) {
  const { db, admin, error } = await requireAdmin(req, { stateChanging: true });
  if (error) return error;

  let payload = null, backupId = null, sourceLabel = '';
  if (body && typeof body.backupId === 'string' && body.backupId) {
    const rec = await db.getBackup(body.backupId);
    if (!rec) return { status: 404, body: { error: 'not_found', message: '백업을 찾을 수 없어요.' } };
    payload = rec.payload; backupId = rec.id; sourceLabel = '서버 백업';
  } else if (body && body.payload) {
    const v = validateBackupPayload(body.payload);
    if (!v.ok) return { status: 400, body: { error: 'invalid_backup', message: v.error } };
    // 업로드한 파일은 즉시 복원하지 않고, 검증에 통과한 경우에만 서버 백업으로 보관한 뒤
    // 미리보기를 돌려준다. 실제 적용은 별도의 restore 요청에서만 일어난다.
    const rec = await db.createBackupRecord({
      formatVersion: BACKUP_FORMAT_VERSION, scope: 'upload', reason: 'upload',
      targetUserId: null, targetNickname: null,
      userCount: v.entries.length,
      taskCount: v.entries.reduce((s, e) => s + e.summary.taskCount, 0),
      createdByUserId: admin.id, createdByNickname: admin.nickname,
      payload: body.payload
    });
    payload = body.payload; backupId = rec.id; sourceLabel = '업로드 파일';
  } else {
    return { status: 400, body: { error: 'invalid_payload', message: '복원할 백업을 지정해주세요.' } };
  }

  const v = validateBackupPayload(payload);
  if (!v.ok) return { status: 400, body: { error: 'invalid_backup', message: v.error } };
  return {
    status: 200,
    body: {
      ok: true, backupId, sourceLabel,
      backup: { createdAt: payload.createdAt, scope: payload.scope, reason: payload.reason, formatVersion: payload.formatVersion },
      entries: v.entries.map(e => ({ userId: e.userId, nickname: e.nickname, summary: e.summary }))
    }
  };
}

async function adminRestore(req, body) {
  const { db, admin, error } = await requireAdmin(req, { stateChanging: true });
  if (error) return error;

  const backupId = String((body && body.backupId) || '');
  const sourceUserId = String((body && body.sourceUserId) || '');
  const targetUserId = String((body && body.targetUserId) || '');
  if (!backupId || !sourceUserId || !targetUserId) {
    return { status: 400, body: { error: 'invalid_payload', message: '백업·원본·대상 정보를 모두 지정해주세요.' } };
  }
  const rec = await db.getBackup(backupId);
  if (!rec) return { status: 404, body: { error: 'not_found', message: '백업을 찾을 수 없어요.' } };
  const v = validateBackupPayload(rec.payload);
  if (!v.ok) return { status: 400, body: { error: 'invalid_backup', message: v.error } };
  const entry = v.entries.find(e => e.userId === sourceUserId);
  if (!entry) return { status: 404, body: { error: 'source_not_in_backup', message: '백업 안에서 선택한 원본 데이터를 찾을 수 없어요.' } };

  const target = await db.findUserById(targetUserId);
  if (!target) return { status: 404, body: { error: 'not_found', message: '복원 대상 사용자를 찾을 수 없어요.' } };
  if (target.role === 'admin') return { status: 400, body: { error: 'admin_target', message: '관리자 계정에는 복원할 수 없어요.' } };
  // 닉네임이 같다고 자동으로 매칭하지 않는다. 다른 계정의 백업을 적용할 때는 명시적 확인이 필요하다.
  if (entry.userId !== target.id && !(body && body.confirmCrossAccount === true)) {
    return {
      status: 409,
      body: {
        error: 'cross_account_requires_confirm',
        message: `백업의 원본(${entry.nickname})과 복원 대상(${target.nickname})이 서로 다른 계정이에요. 그래도 적용하려면 교차 복원을 확인해주세요.`
      }
    };
  }
  if (entry.data === null) {
    return { status: 400, body: { error: 'empty_source', message: '선택한 원본 데이터가 비어 있어 복원할 내용이 없어요.' } };
  }

  // 복원 직전 현재 데이터를 별도 백업하고, 성공한 경우에만 진행한다.
  const pre = await makeBackup(db, { scope: 'user', reason: 'pre_restore', userIds: [target.id], admin, targetUser: target });
  if (!pre.ok) {
    await db.insertAudit({
      adminUserId: admin.id, adminNickname: admin.nickname, action: 'restore',
      targetUserId: target.id, targetNickname: target.nickname, success: false,
      detail: '사전 백업 실패로 복원 중단: ' + pre.reason
    });
    return { status: 500, body: { error: pre.reason, message: BACKUP_FAIL_MESSAGE[pre.reason] || '복원 전 백업에 실패했어요.' } };
  }

  const res = await db.restoreUserDataTx({
    userId: target.id, data: entry.data,
    audit: {
      adminUserId: admin.id, adminNickname: admin.nickname, action: 'restore',
      targetUserId: target.id, targetNickname: target.nickname, backupId,
      detail: `원본 ${entry.nickname} / 업무 ${entry.summary.taskCount}개 · 복원 전 백업 ${pre.backupId}`
    }
  });
  if (!res.ok) return { status: 500, body: { error: 'restore_failed', message: '복원에 실패했어요. 기존 데이터는 그대로예요.', preRestoreBackupId: pre.backupId } };
  return { status: 200, body: { ok: true, revision: res.revision, preRestoreBackupId: pre.backupId } };
}

/* ------------------------------------------------------------
   7) 계정 삭제
------------------------------------------------------------ */
async function adminDeleteUser(req, body) {
  const { db, admin, error } = await requireAdmin(req, { stateChanging: true });
  if (error) return error;
  const userId = String((body && body.userId) || '');
  const confirmNickname = normalizeNickname((body && body.confirmNickname) || '');
  const target = await db.findUserById(userId);
  if (!target) return { status: 404, body: { error: 'not_found', message: '사용자를 찾을 수 없어요.' } };
  if (target.role === 'admin') return { status: 400, body: { error: 'admin_target', message: '관리자 계정은 삭제할 수 없어요.' } };
  if (confirmNickname !== normalizeNickname(target.nickname)) {
    return { status: 400, body: { error: 'confirm_mismatch', message: '확인용으로 입력한 닉네임이 일치하지 않아요.' } };
  }

  const backup = await makeBackup(db, { scope: 'user', reason: 'pre_delete', userIds: [target.id], admin, targetUser: target });
  if (!backup.ok) {
    await db.insertAudit({
      adminUserId: admin.id, adminNickname: admin.nickname, action: 'delete_user',
      targetUserId: target.id, targetNickname: target.nickname, success: false,
      detail: '백업 실패로 삭제 중단: ' + backup.reason
    });
    return { status: 500, body: { error: backup.reason, message: BACKUP_FAIL_MESSAGE[backup.reason] || '삭제 전 백업에 실패했어요.' } };
  }
  const res = await db.deleteUserTx({
    userId: target.id,
    audit: {
      adminUserId: admin.id, adminNickname: admin.nickname, action: 'delete_user',
      targetUserId: target.id, targetNickname: target.nickname, backupId: backup.backupId,
      detail: '계정·프로필·세션 삭제(백업은 보존)'
    }
  });
  if (!res.ok) return { status: 500, body: { error: 'delete_failed', message: '삭제에 실패했어요.', backupId: backup.backupId } };
  return { status: 200, body: { ok: true, backupId: backup.backupId } };
}

/* ------------------------------------------------------------
   8) 작업 이력
------------------------------------------------------------ */
async function adminAudit(req) {
  const { db, error } = await requireAdmin(req);
  if (error) return error;
  const rows = await db.listAudit(100);
  return { status: 200, body: { audit: rows.map(r => Object.assign({}, r, { createdAt: iso(r.createdAt) })) } };
}

/* ------------------------------------------------------------
   라우팅
------------------------------------------------------------ */
const ROUTES = {
  'GET status': (req) => adminStatus(req),
  'POST register': (req, body) => adminRegister(req, body),
  'POST login': (req, body) => adminLogin(req, body),
  'POST logout': (req) => adminLogout(req),
  'GET users': (req, body, query) => adminUsers(req, query),
  'GET user': (req, body, query) => adminUserDetail(req, query),
  'POST test-users': (req, body) => adminCreateTestUsers(req, body),
  'POST test-flag': (req, body) => adminSetTestFlag(req, body),
  'POST reset': (req, body) => adminReset(req, body),
  'POST backup': (req, body) => adminBackup(req, body),
  'GET backups': (req) => adminBackups(req),
  'GET backup-download': (req, body, query) => adminBackupDownload(req, query),
  'POST restore-preview': (req, body) => adminRestorePreview(req, body),
  'POST restore': (req, body) => adminRestore(req, body),
  'POST delete-user': (req, body) => adminDeleteUser(req, body),
  'GET audit': (req) => adminAudit(req)
};

function routeNeedsBody(method) { return method === 'POST'; }

async function handleAdminRoute(method, route, req, body, query) {
  const handler = ROUTES[`${method} ${route}`];
  if (!handler) return { status: 404, body: { error: 'not_found', message: '알 수 없는 관리자 경로예요.' } };
  try {
    return await handler(req, body || {}, query || {});
  } catch (e) {
    // 예외의 이름만 남기고 상세/스택은 남기지 않는다(민감정보 유출 방지).
    console.error('[admin] unexpected_error', route, e && e.name, e && e.message);
    return { status: 500, body: { error: 'internal_error', message: '요청 처리 중 오류가 발생했어요.' } };
  }
}

module.exports = { handleAdminRoute, routeNeedsBody, BACKUP_KIND, BACKUP_FORMAT_VERSION, validateBackupPayload, summarizeData };
