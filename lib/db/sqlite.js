// 로컬 개발용 영속 저장소 — Node 22+ 내장 node:sqlite(DatabaseSync)를 그대로 쓴다. 실제 파일에
// 기록되는 진짜 SQL 데이터베이스이며(메모리나 JSON 파일이 아니다), 프로세스를 재시작해도
// .data/app.sqlite 파일에 그대로 남아 있다.
//
// 주의: 이 백엔드는 로컬 개발 전용이다. Vercel 서버리스 함수에는 영속적인 로컬 디스크가 없어서
// 이 백엔드를 프로덕션에 쓰면 "재시작하면 사라지는 가짜 영속 저장"이 되어 버린다 — lib/db/index.js는
// Vercel 환경에서 DATABASE_URL이 없으면 이 백엔드로 조용히 대체하지 않고 명시적으로 오류를 낸다.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

function create(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const db = new DatabaseSync(filePath);
  db.exec('PRAGMA foreign_keys = ON;');

  const nowIso = () => new Date().toISOString();

  function hasColumn(table, column) {
    return db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === column);
  }
  function addColumnIfMissing(table, column, ddl) {
    if (!hasColumn(table, column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
  function tx(fn) {
    db.exec('BEGIN IMMEDIATE');
    try { const out = fn(); db.exec('COMMIT'); return out; }
    catch (e) { try { db.exec('ROLLBACK'); } catch (e2) { /* noop */ } throw e; }
  }

  function ensureSchema() {
    db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        nickname TEXT NOT NULL,
        nickname_key TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS profiles (
        user_id TEXT PRIMARY KEY REFERENCES users(id),
        data TEXT,
        revision INTEGER NOT NULL DEFAULT 0,
        imported_guest_at TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id),
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
    `);
    // 관리자 기능(신규)에 필요한 컬럼 — 기존 DB에도 안전하게 덧붙인다.
    addColumnIfMissing('users', 'role', "role TEXT NOT NULL DEFAULT 'user'");
    addColumnIfMissing('users', 'is_test', 'is_test INTEGER NOT NULL DEFAULT 0');
    addColumnIfMissing('users', 'password_hash', 'password_hash TEXT');
    addColumnIfMissing('sessions', 'kind', "kind TEXT NOT NULL DEFAULT 'user'");
    addColumnIfMissing('sessions', 'csrf_token', 'csrf_token TEXT');
    // 관리자 계정은 DB 차원에서 최대 1개만 존재할 수 있다(동시 요청 중복 생성 방지의 최종 보장).
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ux_users_single_admin ON users(role) WHERE role='admin';`);
    db.exec(`
      CREATE TABLE IF NOT EXISTS backups (
        id TEXT PRIMARY KEY,
        format_version INTEGER NOT NULL,
        scope TEXT NOT NULL,
        reason TEXT NOT NULL,
        target_user_id TEXT,
        target_nickname TEXT,
        user_count INTEGER NOT NULL,
        task_count INTEGER NOT NULL,
        created_by_user_id TEXT,
        created_by_nickname TEXT,
        created_at TEXT NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS admin_audit (
        id TEXT PRIMARY KEY,
        operation_id TEXT,
        admin_user_id TEXT,
        admin_nickname TEXT,
        action TEXT NOT NULL,
        target_user_id TEXT,
        target_nickname TEXT,
        success INTEGER NOT NULL,
        backup_id TEXT,
        detail TEXT,
        created_at TEXT NOT NULL
      );
    `);
    // 같은 operationId로 같은 대상에 두 번 성공 기록이 남지 않게 한다(재시도 시 중복 작업 방지).
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ux_audit_operation ON admin_audit(operation_id, target_user_id) WHERE operation_id IS NOT NULL;`);
    db.exec(`CREATE INDEX IF NOT EXISTS ix_sessions_user ON sessions(user_id);`);
  }
  ensureSchema();

  const USER_COLS = 'id, nickname, nickname_key, role, is_test, password_hash, created_at';
  function mapUser(row) {
    if (!row) return null;
    return {
      id: row.id, nickname: row.nickname, nicknameKey: row.nickname_key,
      role: row.role || 'user', isTest: !!row.is_test,
      passwordHash: row.password_hash || null, createdAt: row.created_at
    };
  }
  // 프로필 JSON에서 업무 수를 SQL로 바로 센다(전체 payload를 읽어오지 않기 위함).
  const TASK_COUNT_SQL = `COALESCE(json_array_length(json_extract(p.data,'$.tasks')), 0)`;

  /* ---------------- 사용자 / 세션 ---------------- */
  async function createUser({ nickname, nicknameKey, role, isTest, passwordHash }) {
    const id = crypto.randomUUID();
    const now = nowIso();
    try {
      tx(() => {
        db.prepare('INSERT INTO users (id, nickname, nickname_key, role, is_test, password_hash, created_at) VALUES (?,?,?,?,?,?,?)')
          .run(id, nickname, nicknameKey, role || 'user', isTest ? 1 : 0, passwordHash || null, now);
        db.prepare('INSERT INTO profiles (user_id, data, revision, updated_at) VALUES (?, NULL, 0, ?)').run(id, now);
      });
    } catch (e) {
      if (String(e.message || '').includes('UNIQUE constraint failed')) {
        const err = new Error('NICKNAME_TAKEN'); err.code = 'NICKNAME_TAKEN'; throw err;
      }
      throw e;
    }
    return { id, nickname, role: role || 'user', isTest: !!isTest, createdAt: now };
  }

  // 최초 관리자 생성 — "관리자가 아직 없을 때만" 삽입되는 단일 문장 + 부분 유니크 인덱스로
  // 동시 요청에서도 절대 두 명이 만들어지지 않는다.
  async function createFirstAdmin({ nickname, nicknameKey, passwordHash }) {
    const id = crypto.randomUUID();
    const now = nowIso();
    try {
      return tx(() => {
        if (db.prepare('SELECT 1 AS x FROM users WHERE nickname_key = ?').get(nicknameKey)) {
          return { ok: false, reason: 'nickname_taken' };
        }
        const res = db.prepare(`
          INSERT INTO users (id, nickname, nickname_key, role, is_test, password_hash, created_at)
          SELECT ?, ?, ?, 'admin', 0, ?, ?
          WHERE NOT EXISTS (SELECT 1 FROM users WHERE role='admin')
        `).run(id, nickname, nicknameKey, passwordHash, now);
        if (!res.changes) return { ok: false, reason: 'admin_exists' };
        db.prepare('INSERT INTO profiles (user_id, data, revision, updated_at) VALUES (?, NULL, 0, ?)').run(id, now);
        return { ok: true, user: { id, nickname, role: 'admin', isTest: false, createdAt: now } };
      });
    } catch (e) {
      const msg = String(e.message || '');
      if (msg.includes('ux_users_single_admin')) return { ok: false, reason: 'admin_exists' };
      if (msg.includes('UNIQUE constraint failed')) return { ok: false, reason: 'nickname_taken' };
      throw e;
    }
  }

  async function adminExists() {
    return !!db.prepare("SELECT 1 AS x FROM users WHERE role='admin'").get();
  }
  async function findUserByNicknameKey(nicknameKey) {
    return mapUser(db.prepare(`SELECT ${USER_COLS} FROM users WHERE nickname_key = ?`).get(nicknameKey));
  }
  async function findUserById(userId) {
    return mapUser(db.prepare(`SELECT ${USER_COLS} FROM users WHERE id = ?`).get(userId));
  }

  async function getProfile(userId) {
    const row = db.prepare('SELECT data, revision, imported_guest_at, updated_at FROM profiles WHERE user_id = ?').get(userId);
    if (!row) return null;
    return {
      data: row.data ? JSON.parse(row.data) : null,
      revision: row.revision,
      importedGuestAt: row.imported_guest_at || null,
      updatedAt: row.updated_at
    };
  }

  async function saveProfile(userId, data, expectedRevision) {
    const row = db.prepare(
      'UPDATE profiles SET data = ?, revision = revision + 1, updated_at = ? WHERE user_id = ? AND revision = ? RETURNING revision'
    ).get(JSON.stringify(data), nowIso(), userId, expectedRevision);
    if (!row) {
      const cur = db.prepare('SELECT revision FROM profiles WHERE user_id = ?').get(userId);
      return { ok: false, reason: cur ? 'conflict' : 'not_found', currentRevision: cur ? cur.revision : null };
    }
    return { ok: true, revision: row.revision };
  }

  async function importGuestProfile(userId, data) {
    const now = nowIso();
    const row = db.prepare(
      'UPDATE profiles SET data = ?, revision = 1, imported_guest_at = ?, updated_at = ? WHERE user_id = ? AND revision = 0 RETURNING revision'
    ).get(JSON.stringify(data), now, now, userId);
    if (!row) return { ok: false, reason: 'already_has_data' };
    return { ok: true, revision: row.revision };
  }

  async function createSession(userId, ttlMs, opts) {
    opts = opts || {};
    const token = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const csrfToken = crypto.randomBytes(24).toString('hex');
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlMs);
    db.prepare('INSERT INTO sessions (token_hash, user_id, kind, csrf_token, created_at, expires_at) VALUES (?,?,?,?,?,?)')
      .run(tokenHash, userId, opts.kind || 'user', csrfToken, now.toISOString(), expiresAt.toISOString());
    return { token, csrfToken, expiresAt: expiresAt.toISOString() };
  }

  async function getSession(token, kind) {
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const row = db.prepare('SELECT user_id, kind, csrf_token, expires_at FROM sessions WHERE token_hash = ?').get(tokenHash);
    if (!row) return null;
    if (new Date(row.expires_at).getTime() <= Date.now()) {
      db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
      return null;
    }
    if (kind && (row.kind || 'user') !== kind) return null; // 사용자 세션으로 관리자 API를 쓸 수 없다(반대도 마찬가지)
    return { userId: row.user_id, kind: row.kind || 'user', csrfToken: row.csrf_token || null, expiresAt: row.expires_at };
  }

  async function deleteSession(token) {
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
  }

  /* ---------------- 관리자: 조회 ---------------- */
  async function getStats() {
    const r = db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM users WHERE role='user' AND is_test=0) AS normal_users,
        (SELECT COUNT(*) FROM users WHERE is_test=1) AS test_users,
        (SELECT COUNT(*) FROM users WHERE role='admin') AS admin_users,
        (SELECT COALESCE(SUM(${TASK_COUNT_SQL}), 0) FROM profiles p) AS total_tasks
    `).get();
    return {
      normalUsers: r.normal_users, testUsers: r.test_users,
      adminUsers: r.admin_users, totalTasks: r.total_tasks
    };
  }

  async function listUsers({ search, filter, offset, limit }) {
    const where = [];
    const args = [];
    if (search) { where.push('u.nickname_key LIKE ?'); args.push('%' + search.toLowerCase() + '%'); }
    if (filter === 'test') where.push('u.is_test = 1');
    else if (filter === 'normal') where.push("u.is_test = 0 AND u.role = 'user'");
    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const total = db.prepare(`SELECT COUNT(*) AS c FROM users u ${whereSql}`).get(...args).c;
    const rows = db.prepare(`
      SELECT u.id, u.nickname, u.role, u.is_test, u.created_at,
             ${TASK_COUNT_SQL} AS task_count, p.updated_at AS last_saved_at, p.revision AS revision
      FROM users u LEFT JOIN profiles p ON p.user_id = u.id
      ${whereSql}
      ORDER BY u.created_at DESC
      LIMIT ? OFFSET ?
    `).all(...args, limit, offset);
    return {
      total,
      rows: rows.map(r => ({
        id: r.id, nickname: r.nickname, role: r.role || 'user', isTest: !!r.is_test,
        createdAt: r.created_at, taskCount: r.task_count || 0,
        lastSavedAt: r.revision > 0 ? r.last_saved_at : null, revision: r.revision || 0
      }))
    };
  }

  async function setUserTestFlag(userId, isTest) {
    const row = db.prepare("UPDATE users SET is_test = ? WHERE id = ? AND role='user' RETURNING id").get(isTest ? 1 : 0, userId);
    return !!row;
  }

  // 백업용 일관 스냅샷 — 하나의 트랜잭션 안에서 users/profiles를 함께 읽는다.
  async function snapshotUsers(userIds) {
    return tx(() => {
      let rows;
      if (Array.isArray(userIds)) {
        if (!userIds.length) return [];
        const marks = userIds.map(() => '?').join(',');
        rows = db.prepare(`SELECT u.id, u.nickname, u.is_test, u.created_at, p.data, p.revision
                           FROM users u LEFT JOIN profiles p ON p.user_id=u.id WHERE u.id IN (${marks})`).all(...userIds);
      } else {
        rows = db.prepare(`SELECT u.id, u.nickname, u.is_test, u.created_at, p.data, p.revision
                           FROM users u LEFT JOIN profiles p ON p.user_id=u.id WHERE u.role='user'`).all();
      }
      return rows.map(r => ({
        userId: r.id, nickname: r.nickname, isTest: !!r.is_test, createdAt: r.created_at,
        revision: r.revision || 0, data: r.data ? JSON.parse(r.data) : null
      }));
    });
  }

  /* ---------------- 관리자: 백업 / 이력 ---------------- */
  async function createBackupRecord(rec) {
    const id = crypto.randomUUID();
    db.prepare(`INSERT INTO backups (id, format_version, scope, reason, target_user_id, target_nickname,
      user_count, task_count, created_by_user_id, created_by_nickname, created_at, payload)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id, rec.formatVersion, rec.scope, rec.reason, rec.targetUserId || null, rec.targetNickname || null,
      rec.userCount, rec.taskCount, rec.createdByUserId || null, rec.createdByNickname || null,
      nowIso(), JSON.stringify(rec.payload)
    );
    return { id };
  }
  async function listBackups(limit) {
    return db.prepare(`SELECT id, format_version, scope, reason, target_user_id, target_nickname,
      user_count, task_count, created_by_nickname, created_at FROM backups ORDER BY created_at DESC LIMIT ?`).all(limit)
      .map(r => ({
        id: r.id, formatVersion: r.format_version, scope: r.scope, reason: r.reason,
        targetUserId: r.target_user_id, targetNickname: r.target_nickname,
        userCount: r.user_count, taskCount: r.task_count,
        createdByNickname: r.created_by_nickname, createdAt: r.created_at
      }));
  }
  async function getBackup(id) {
    const r = db.prepare('SELECT * FROM backups WHERE id = ?').get(id);
    if (!r) return null;
    return {
      id: r.id, formatVersion: r.format_version, scope: r.scope, reason: r.reason,
      targetUserId: r.target_user_id, targetNickname: r.target_nickname,
      userCount: r.user_count, taskCount: r.task_count, createdAt: r.created_at,
      payload: JSON.parse(r.payload)
    };
  }
  function insertAuditRow(a) {
    db.prepare(`INSERT INTO admin_audit (id, operation_id, admin_user_id, admin_nickname, action,
      target_user_id, target_nickname, success, backup_id, detail, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
      crypto.randomUUID(), a.operationId || null, a.adminUserId || null, a.adminNickname || null, a.action,
      a.targetUserId || null, a.targetNickname || null, a.success ? 1 : 0, a.backupId || null,
      a.detail || null, nowIso()
    );
  }
  async function insertAudit(a) { insertAuditRow(a); }
  async function listAudit(limit) {
    return db.prepare(`SELECT admin_nickname, action, target_user_id, target_nickname, success, backup_id, detail, created_at
      FROM admin_audit ORDER BY created_at DESC LIMIT ?`).all(limit)
      .map(r => ({
        adminNickname: r.admin_nickname, action: r.action, targetUserId: r.target_user_id,
        targetNickname: r.target_nickname, success: !!r.success, backupId: r.backup_id,
        detail: r.detail, createdAt: r.created_at
      }));
  }
  async function operationAlreadySucceeded(operationId, targetUserId) {
    if (!operationId) return false;
    return !!db.prepare('SELECT 1 AS x FROM admin_audit WHERE operation_id = ? AND target_user_id = ? AND success = 1')
      .get(operationId, targetUserId);
  }

  /* ---------------- 관리자: 변경 작업(데이터 변경 + 이력 기록을 한 트랜잭션으로) ---------------- */
  // 데이터 초기화: 업무/시간표/설정 등 프로필 데이터만 비우고 userId·닉네임·가입일·테스트 여부는
  // 그대로 둔다. revision을 올리고 세션을 지워 오래된 탭의 저장 요청이 예전 데이터를 되돌리지 못하게 한다.
  async function resetUserDataTx({ userId, audit }) {
    return tx(() => {
      const row = db.prepare('UPDATE profiles SET data = NULL, revision = revision + 1, imported_guest_at = NULL, updated_at = ? WHERE user_id = ? RETURNING revision')
        .get(nowIso(), userId);
      if (!row) return { ok: false, reason: 'profile_not_found' };
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
      insertAuditRow(Object.assign({ success: true }, audit));
      return { ok: true, revision: row.revision };
    });
  }
  async function restoreUserDataTx({ userId, data, audit }) {
    return tx(() => {
      const row = db.prepare('UPDATE profiles SET data = ?, revision = revision + 1, updated_at = ? WHERE user_id = ? RETURNING revision')
        .get(JSON.stringify(data), nowIso(), userId);
      if (!row) return { ok: false, reason: 'profile_not_found' };
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
      insertAuditRow(Object.assign({ success: true }, audit));
      return { ok: true, revision: row.revision };
    });
  }
  // 계정 삭제 — 계정/프로필/세션만 지운다. 백업(backups)과 이력(admin_audit)은 의도적으로 남긴다.
  async function deleteUserTx({ userId, audit }) {
    return tx(() => {
      const u = db.prepare("SELECT id FROM users WHERE id = ? AND role='user'").get(userId);
      if (!u) return { ok: false, reason: 'not_found' };
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
      db.prepare('DELETE FROM profiles WHERE user_id = ?').run(userId);
      db.prepare('DELETE FROM users WHERE id = ?').run(userId);
      insertAuditRow(Object.assign({ success: true }, audit));
      return { ok: true };
    });
  }

  return {
    kind: 'sqlite',
    createUser, createFirstAdmin, adminExists, findUserByNicknameKey, findUserById,
    getProfile, saveProfile, importGuestProfile,
    createSession, getSession, deleteSession,
    getStats, listUsers, setUserTestFlag, snapshotUsers,
    createBackupRecord, listBackups, getBackup,
    insertAudit, listAudit, operationAlreadySucceeded,
    resetUserDataTx, restoreUserDataTx, deleteUserTx
  };
}

module.exports = { create };
