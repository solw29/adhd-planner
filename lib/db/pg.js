// 프로덕션(Vercel) 영속 저장소 — 표준 Postgres. Vercel Storage의 Postgres(Neon 기반)뿐 아니라
// Neon/Supabase 등 DATABASE_URL 하나로 접속하는 어떤 Postgres에도 그대로 동작한다.
// 스키마는 schema.sql과 동일한 내용을 CREATE TABLE/ALTER TABLE IF NOT EXISTS로 여기서도 한 번 더
// 보장하므로, 첫 요청에서 자동 생성된다(운영에서는 schema.sql로 미리 만들어두는 쪽을 권장).
//
// lib/db/sqlite.js와 완전히 동일한 메서드 집합을 제공한다 — 상위 로직(lib/authApi.js,
// lib/adminApi.js)은 어느 백엔드인지 전혀 알지 못한 채 같은 코드로 동작한다.
'use strict';
const crypto = require('crypto');
const { Pool } = require('pg');

function create(connectionString) {
  const pool = new Pool({
    connectionString,
    ssl: /localhost|127\.0\.0\.1/.test(connectionString) ? false : { rejectUnauthorized: false }
  });

  let schemaReadyPromise = null;
  function ensureSchema() {
    if (!schemaReadyPromise) {
      schemaReadyPromise = pool.query(`
        CREATE TABLE IF NOT EXISTS users (
          id TEXT PRIMARY KEY,
          nickname TEXT NOT NULL,
          nickname_key TEXT NOT NULL UNIQUE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'user';
        ALTER TABLE users ADD COLUMN IF NOT EXISTS is_test BOOLEAN NOT NULL DEFAULT false;
        ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT;
        CREATE UNIQUE INDEX IF NOT EXISTS ux_users_single_admin ON users(role) WHERE role = 'admin';

        CREATE TABLE IF NOT EXISTS profiles (
          user_id TEXT PRIMARY KEY REFERENCES users(id),
          data JSONB,
          revision INTEGER NOT NULL DEFAULT 0,
          imported_guest_at TIMESTAMPTZ,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE TABLE IF NOT EXISTS sessions (
          token_hash TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id),
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          expires_at TIMESTAMPTZ NOT NULL
        );
        ALTER TABLE sessions ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'user';
        ALTER TABLE sessions ADD COLUMN IF NOT EXISTS csrf_token TEXT;
        CREATE INDEX IF NOT EXISTS ix_sessions_user ON sessions(user_id);

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
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          payload JSONB NOT NULL
        );
        CREATE TABLE IF NOT EXISTS admin_audit (
          id TEXT PRIMARY KEY,
          operation_id TEXT,
          admin_user_id TEXT,
          admin_nickname TEXT,
          action TEXT NOT NULL,
          target_user_id TEXT,
          target_nickname TEXT,
          success BOOLEAN NOT NULL,
          backup_id TEXT,
          detail TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE UNIQUE INDEX IF NOT EXISTS ux_audit_operation ON admin_audit(operation_id, target_user_id) WHERE operation_id IS NOT NULL;
      `);
    }
    return schemaReadyPromise;
  }

  // 프로필 JSON에서 업무 수를 SQL로 센다. tasks가 배열이 아닐 때 jsonb_array_length가 오류를
  // 내지 않도록 타입을 먼저 확인한다.
  const TASK_COUNT_SQL = `CASE WHEN jsonb_typeof(p.data->'tasks')='array' THEN jsonb_array_length(p.data->'tasks') ELSE 0 END`;

  function mapUser(r) {
    if (!r) return null;
    return {
      id: r.id, nickname: r.nickname, nicknameKey: r.nickname_key,
      role: r.role || 'user', isTest: !!r.is_test,
      passwordHash: r.password_hash || null, createdAt: r.created_at
    };
  }

  async function withTx(fn, opts) {
    await ensureSchema();
    const client = await pool.connect();
    try {
      await client.query((opts && opts.begin) || 'BEGIN');
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (e2) { /* noop */ }
      throw e;
    } finally { client.release(); }
  }

  /* ---------------- 사용자 / 세션 ---------------- */
  async function createUser({ nickname, nicknameKey, role, isTest, passwordHash }) {
    const id = crypto.randomUUID();
    try {
      return await withTx(async (client) => {
        const r = await client.query(
          `INSERT INTO users (id, nickname, nickname_key, role, is_test, password_hash)
           VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, nickname, role, is_test, created_at`,
          [id, nickname, nicknameKey, role || 'user', !!isTest, passwordHash || null]
        );
        await client.query('INSERT INTO profiles (user_id, data, revision) VALUES ($1, NULL, 0)', [id]);
        const u = r.rows[0];
        return { id: u.id, nickname: u.nickname, role: u.role, isTest: !!u.is_test, createdAt: u.created_at };
      });
    } catch (e) {
      if (e && e.code === '23505') { const err = new Error('NICKNAME_TAKEN'); err.code = 'NICKNAME_TAKEN'; throw err; }
      throw e;
    }
  }

  async function createFirstAdmin({ nickname, nicknameKey, passwordHash }) {
    const id = crypto.randomUUID();
    try {
      return await withTx(async (client) => {
        const dup = await client.query('SELECT 1 FROM users WHERE nickname_key=$1', [nicknameKey]);
        if (dup.rows[0]) return { ok: false, reason: 'nickname_taken' };
        const r = await client.query(`
          INSERT INTO users (id, nickname, nickname_key, role, is_test, password_hash)
          SELECT $1,$2,$3,'admin',false,$4
          WHERE NOT EXISTS (SELECT 1 FROM users WHERE role='admin')
          RETURNING id, nickname, created_at`,
          [id, nickname, nicknameKey, passwordHash]);
        if (!r.rows[0]) return { ok: false, reason: 'admin_exists' };
        await client.query('INSERT INTO profiles (user_id, data, revision) VALUES ($1, NULL, 0)', [id]);
        return { ok: true, user: { id, nickname, role: 'admin', isTest: false, createdAt: r.rows[0].created_at } };
      });
    } catch (e) {
      if (e && e.code === '23505') {
        return { ok: false, reason: String(e.constraint || '').includes('admin') ? 'admin_exists' : 'nickname_taken' };
      }
      throw e;
    }
  }

  async function adminExists() {
    await ensureSchema();
    const r = await pool.query("SELECT 1 FROM users WHERE role='admin' LIMIT 1");
    return !!r.rows[0];
  }
  async function findUserByNicknameKey(nicknameKey) {
    await ensureSchema();
    const r = await pool.query('SELECT id, nickname, nickname_key, role, is_test, password_hash, created_at FROM users WHERE nickname_key=$1', [nicknameKey]);
    return mapUser(r.rows[0]);
  }
  async function findUserById(userId) {
    await ensureSchema();
    const r = await pool.query('SELECT id, nickname, nickname_key, role, is_test, password_hash, created_at FROM users WHERE id=$1', [userId]);
    return mapUser(r.rows[0]);
  }

  async function getProfile(userId) {
    await ensureSchema();
    const r = await pool.query('SELECT data, revision, imported_guest_at, updated_at FROM profiles WHERE user_id=$1', [userId]);
    if (!r.rows[0]) return null;
    const row = r.rows[0];
    return { data: row.data || null, revision: row.revision, importedGuestAt: row.imported_guest_at, updatedAt: row.updated_at };
  }

  async function saveProfile(userId, data, expectedRevision) {
    await ensureSchema();
    const r = await pool.query(
      'UPDATE profiles SET data=$1, revision=revision+1, updated_at=now() WHERE user_id=$2 AND revision=$3 RETURNING revision',
      [JSON.stringify(data), userId, expectedRevision]
    );
    if (r.rows[0]) return { ok: true, revision: r.rows[0].revision };
    const cur = await pool.query('SELECT revision FROM profiles WHERE user_id=$1', [userId]);
    return { ok: false, reason: cur.rows[0] ? 'conflict' : 'not_found', currentRevision: cur.rows[0] ? cur.rows[0].revision : null };
  }

  async function importGuestProfile(userId, data) {
    await ensureSchema();
    const r = await pool.query(
      'UPDATE profiles SET data=$1, revision=1, imported_guest_at=now(), updated_at=now() WHERE user_id=$2 AND revision=0 RETURNING revision',
      [JSON.stringify(data), userId]
    );
    if (r.rows[0]) return { ok: true, revision: r.rows[0].revision };
    return { ok: false, reason: 'already_has_data' };
  }

  async function createSession(userId, ttlMs, opts) {
    await ensureSchema();
    opts = opts || {};
    const token = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const csrfToken = crypto.randomBytes(24).toString('hex');
    const expiresAt = new Date(Date.now() + ttlMs);
    await pool.query('INSERT INTO sessions (token_hash, user_id, kind, csrf_token, expires_at) VALUES ($1,$2,$3,$4,$5)',
      [tokenHash, userId, opts.kind || 'user', csrfToken, expiresAt.toISOString()]);
    return { token, csrfToken, expiresAt: expiresAt.toISOString() };
  }

  async function getSession(token, kind) {
    await ensureSchema();
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const r = await pool.query('SELECT user_id, kind, csrf_token, expires_at FROM sessions WHERE token_hash=$1', [tokenHash]);
    const row = r.rows[0];
    if (!row) return null;
    if (new Date(row.expires_at).getTime() <= Date.now()) {
      await pool.query('DELETE FROM sessions WHERE token_hash=$1', [tokenHash]);
      return null;
    }
    if (kind && (row.kind || 'user') !== kind) return null;
    return { userId: row.user_id, kind: row.kind || 'user', csrfToken: row.csrf_token || null, expiresAt: row.expires_at };
  }

  async function deleteSession(token) {
    await ensureSchema();
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    await pool.query('DELETE FROM sessions WHERE token_hash=$1', [tokenHash]);
  }

  /* ---------------- 관리자: 조회 ---------------- */
  async function getStats() {
    await ensureSchema();
    const r = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM users WHERE role='user' AND is_test=false) AS normal_users,
        (SELECT COUNT(*) FROM users WHERE is_test=true) AS test_users,
        (SELECT COUNT(*) FROM users WHERE role='admin') AS admin_users,
        (SELECT COALESCE(SUM(${TASK_COUNT_SQL}),0) FROM profiles p) AS total_tasks`);
    const row = r.rows[0];
    return {
      normalUsers: Number(row.normal_users), testUsers: Number(row.test_users),
      adminUsers: Number(row.admin_users), totalTasks: Number(row.total_tasks)
    };
  }

  async function listUsers({ search, filter, offset, limit }) {
    await ensureSchema();
    const where = [];
    const args = [];
    if (search) { args.push('%' + search.toLowerCase() + '%'); where.push(`u.nickname_key LIKE $${args.length}`); }
    if (filter === 'test') where.push('u.is_test = true');
    else if (filter === 'normal') where.push("u.is_test = false AND u.role='user'");
    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const totalRes = await pool.query(`SELECT COUNT(*) AS c FROM users u ${whereSql}`, args);
    args.push(limit); const limitIdx = args.length;
    args.push(offset); const offsetIdx = args.length;
    const rows = await pool.query(`
      SELECT u.id, u.nickname, u.role, u.is_test, u.created_at,
             ${TASK_COUNT_SQL} AS task_count, p.updated_at AS last_saved_at, p.revision AS revision
      FROM users u LEFT JOIN profiles p ON p.user_id=u.id
      ${whereSql} ORDER BY u.created_at DESC LIMIT $${limitIdx} OFFSET $${offsetIdx}`, args);
    return {
      total: Number(totalRes.rows[0].c),
      rows: rows.rows.map(r => ({
        id: r.id, nickname: r.nickname, role: r.role || 'user', isTest: !!r.is_test,
        createdAt: r.created_at, taskCount: Number(r.task_count || 0),
        lastSavedAt: (r.revision > 0) ? r.last_saved_at : null, revision: Number(r.revision || 0)
      }))
    };
  }

  async function setUserTestFlag(userId, isTest) {
    await ensureSchema();
    const r = await pool.query("UPDATE users SET is_test=$1 WHERE id=$2 AND role='user' RETURNING id", [!!isTest, userId]);
    return !!r.rows[0];
  }

  // 백업용 일관 스냅샷 — REPEATABLE READ 읽기 전용 트랜잭션에서 users/profiles를 함께 읽는다.
  async function snapshotUsers(userIds) {
    return withTx(async (client) => {
      let r;
      if (Array.isArray(userIds)) {
        if (!userIds.length) return [];
        r = await client.query(`SELECT u.id, u.nickname, u.is_test, u.created_at, p.data, p.revision
          FROM users u LEFT JOIN profiles p ON p.user_id=u.id WHERE u.id = ANY($1)`, [userIds]);
      } else {
        r = await client.query(`SELECT u.id, u.nickname, u.is_test, u.created_at, p.data, p.revision
          FROM users u LEFT JOIN profiles p ON p.user_id=u.id WHERE u.role='user'`);
      }
      return r.rows.map(row => ({
        userId: row.id, nickname: row.nickname, isTest: !!row.is_test, createdAt: row.created_at,
        revision: Number(row.revision || 0), data: row.data || null
      }));
    }, { begin: 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' });
  }

  /* ---------------- 관리자: 백업 / 이력 ---------------- */
  async function createBackupRecord(rec) {
    await ensureSchema();
    const id = crypto.randomUUID();
    await pool.query(`INSERT INTO backups (id, format_version, scope, reason, target_user_id, target_nickname,
      user_count, task_count, created_by_user_id, created_by_nickname, payload)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [id, rec.formatVersion, rec.scope, rec.reason, rec.targetUserId || null, rec.targetNickname || null,
        rec.userCount, rec.taskCount, rec.createdByUserId || null, rec.createdByNickname || null,
        JSON.stringify(rec.payload)]);
    return { id };
  }
  async function listBackups(limit) {
    await ensureSchema();
    const r = await pool.query(`SELECT id, format_version, scope, reason, target_user_id, target_nickname,
      user_count, task_count, created_by_nickname, created_at FROM backups ORDER BY created_at DESC LIMIT $1`, [limit]);
    return r.rows.map(x => ({
      id: x.id, formatVersion: x.format_version, scope: x.scope, reason: x.reason,
      targetUserId: x.target_user_id, targetNickname: x.target_nickname,
      userCount: x.user_count, taskCount: x.task_count,
      createdByNickname: x.created_by_nickname, createdAt: x.created_at
    }));
  }
  async function getBackup(id) {
    await ensureSchema();
    const r = await pool.query('SELECT * FROM backups WHERE id=$1', [id]);
    const x = r.rows[0];
    if (!x) return null;
    return {
      id: x.id, formatVersion: x.format_version, scope: x.scope, reason: x.reason,
      targetUserId: x.target_user_id, targetNickname: x.target_nickname,
      userCount: x.user_count, taskCount: x.task_count, createdAt: x.created_at, payload: x.payload
    };
  }
  async function insertAuditWith(client, a) {
    await client.query(`INSERT INTO admin_audit (id, operation_id, admin_user_id, admin_nickname, action,
      target_user_id, target_nickname, success, backup_id, detail)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [crypto.randomUUID(), a.operationId || null, a.adminUserId || null, a.adminNickname || null, a.action,
        a.targetUserId || null, a.targetNickname || null, !!a.success, a.backupId || null, a.detail || null]);
  }
  async function insertAudit(a) {
    await ensureSchema();
    await insertAuditWith(pool, a);
  }
  async function listAudit(limit) {
    await ensureSchema();
    const r = await pool.query(`SELECT admin_nickname, action, target_user_id, target_nickname, success, backup_id, detail, created_at
      FROM admin_audit ORDER BY created_at DESC LIMIT $1`, [limit]);
    return r.rows.map(x => ({
      adminNickname: x.admin_nickname, action: x.action, targetUserId: x.target_user_id,
      targetNickname: x.target_nickname, success: !!x.success, backupId: x.backup_id,
      detail: x.detail, createdAt: x.created_at
    }));
  }
  async function operationAlreadySucceeded(operationId, targetUserId) {
    if (!operationId) return false;
    await ensureSchema();
    const r = await pool.query('SELECT 1 FROM admin_audit WHERE operation_id=$1 AND target_user_id=$2 AND success=true', [operationId, targetUserId]);
    return !!r.rows[0];
  }

  /* ---------------- 관리자: 변경 작업(데이터 변경 + 이력 기록을 한 트랜잭션으로) ---------------- */
  async function resetUserDataTx({ userId, audit }) {
    return withTx(async (client) => {
      const r = await client.query('UPDATE profiles SET data=NULL, revision=revision+1, imported_guest_at=NULL, updated_at=now() WHERE user_id=$1 RETURNING revision', [userId]);
      if (!r.rows[0]) return { ok: false, reason: 'profile_not_found' };
      await client.query('DELETE FROM sessions WHERE user_id=$1', [userId]);
      await insertAuditWith(client, Object.assign({ success: true }, audit));
      return { ok: true, revision: r.rows[0].revision };
    });
  }
  async function restoreUserDataTx({ userId, data, audit }) {
    return withTx(async (client) => {
      const r = await client.query('UPDATE profiles SET data=$1, revision=revision+1, updated_at=now() WHERE user_id=$2 RETURNING revision', [JSON.stringify(data), userId]);
      if (!r.rows[0]) return { ok: false, reason: 'profile_not_found' };
      await client.query('DELETE FROM sessions WHERE user_id=$1', [userId]);
      await insertAuditWith(client, Object.assign({ success: true }, audit));
      return { ok: true, revision: r.rows[0].revision };
    });
  }
  async function deleteUserTx({ userId, audit }) {
    return withTx(async (client) => {
      const u = await client.query("SELECT id FROM users WHERE id=$1 AND role='user'", [userId]);
      if (!u.rows[0]) return { ok: false, reason: 'not_found' };
      await client.query('DELETE FROM sessions WHERE user_id=$1', [userId]);
      await client.query('DELETE FROM profiles WHERE user_id=$1', [userId]);
      await client.query('DELETE FROM users WHERE id=$1', [userId]);
      await insertAuditWith(client, Object.assign({ success: true }, audit));
      return { ok: true };
    });
  }

  return {
    kind: 'pg',
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
