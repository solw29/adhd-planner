-- ADHD 플래너 — 닉네임 사용자 + 관리자/데이터 관리 스키마 (Postgres)
--
-- 이 파일은 참고/수동 실행용이다. 앱 코드(lib/db/pg.js)가 첫 요청 시 아래와 동일한
-- CREATE TABLE / ALTER TABLE ... IF NOT EXISTS 구문을 스스로 실행하므로, DATABASE_URL만
-- 설정하면 자동으로 만들어진다. 운영에서 마이그레이션을 명시적으로 관리하고 싶다면 배포 전에
-- 이 파일을 직접 실행해두는 쪽을 권장한다.
--
-- Vercel Postgres(Neon)/Neon/Supabase 등 표준 Postgres에 그대로 사용할 수 있다.

-- ────────────────────────────── 사용자 ──────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  nickname TEXT NOT NULL,
  -- 영문 대소문자를 구분하지 않는 중복 검사 키(소문자 정규화). 중복 방지는 이 UNIQUE가 최종 보장한다.
  nickname_key TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- 관리자 기능에서 추가된 컬럼들(기존 DB에도 안전하게 덧붙는다)
ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'user';      -- 'user' | 'admin'
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_test BOOLEAN NOT NULL DEFAULT false;  -- 테스트 계정 여부(닉네임 추측이 아닌 명시 필드)
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT;                      -- 관리자만 사용(scrypt)
-- 관리자 계정은 DB 차원에서 최대 1명 — 동시 요청에서도 최초 관리자가 중복 생성되지 않는다.
CREATE UNIQUE INDEX IF NOT EXISTS ux_users_single_admin ON users(role) WHERE role = 'admin';

-- ────────────────────────────── 사용자 데이터 ──────────────────────────────
CREATE TABLE IF NOT EXISTS profiles (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  data JSONB,                                  -- 앱 state 전체(JSON). 신규/초기화 직후에는 NULL.
  revision INTEGER NOT NULL DEFAULT 0,         -- 낙관적 동시성 토큰. 초기화·복원 시에도 증가시켜 오래된 탭의 저장을 막는다.
  imported_guest_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ────────────────────────────── 세션 ──────────────────────────────
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,                 -- 원시 토큰이 아니라 sha256 해시만 저장한다
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);
-- 사용자 세션과 관리자 세션은 kind와 쿠키 이름이 모두 다르다(일반 로그인으로 관리자 세션 발급 불가).
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'user';    -- 'user' | 'admin'
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS csrf_token TEXT;                      -- 상태 변경 요청 검증용
CREATE INDEX IF NOT EXISTS ix_sessions_user ON sessions(user_id);

-- ────────────────────────────── 백업 ──────────────────────────────
-- 앱 "사용자 데이터" 백업이다. 비밀번호 해시·세션·초대 코드 등 인증 정보는 담지 않으며,
-- DB 전체 재해 복구 백업과는 다르다. users(id)로의 FK를 두지 않는다 — 계정을 삭제해도 백업은 남아야 한다.
CREATE TABLE IF NOT EXISTS backups (
  id TEXT PRIMARY KEY,
  format_version INTEGER NOT NULL,
  scope TEXT NOT NULL,                         -- 'user' | 'all' | 'upload'
  reason TEXT NOT NULL,                        -- 'manual' | 'pre_reset' | 'pre_restore' | 'pre_delete' | 'upload'
  target_user_id TEXT,
  target_nickname TEXT,
  user_count INTEGER NOT NULL,
  task_count INTEGER NOT NULL,
  created_by_user_id TEXT,
  created_by_nickname TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  payload JSONB NOT NULL
);

-- ────────────────────────────── 관리자 작업 이력 ──────────────────────────────
CREATE TABLE IF NOT EXISTS admin_audit (
  id TEXT PRIMARY KEY,
  operation_id TEXT,                           -- 재시도 멱등성 키(같은 작업의 중복 실행 방지)
  admin_user_id TEXT,
  admin_nickname TEXT,
  action TEXT NOT NULL,                        -- create_test_user | set_test_flag | reset | restore | delete_user | backup_user | backup_all | admin_register
  target_user_id TEXT,
  target_nickname TEXT,
  success BOOLEAN NOT NULL,
  backup_id TEXT,
  detail TEXT,                                 -- 짧은 설명만. 업무 본문·비밀값은 절대 넣지 않는다.
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- 같은 operation_id로 같은 대상에 성공 기록이 두 번 남지 않게 한다.
CREATE UNIQUE INDEX IF NOT EXISTS ux_audit_operation ON admin_audit(operation_id, target_user_id) WHERE operation_id IS NOT NULL;

-- 만료 세션은 조회 시마다 정리되지만, 주기적으로 한 번씩 청소해도 안전하다.
-- DELETE FROM sessions WHERE expires_at < now();
