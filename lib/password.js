// 관리자 비밀번호 해시 — Node 코어(OpenSSL)의 scrypt(RFC 7914)를 그대로 쓴다. 직접 만든
// 해시 알고리즘이 아니라 표준 KDF 구현이며, 네이티브 빌드가 필요 없어 Vercel 서버리스에서도
// 그대로 동작한다(bcrypt/argon2 네이티브 모듈은 서버리스 빌드가 까다로워 제외).
//
// 저장 형식: scrypt$N$r$p$saltBase64$hashBase64  — 파라미터를 함께 저장해 두면 나중에 비용을
// 올려도 기존 해시를 그대로 검증할 수 있다.
'use strict';
const crypto = require('crypto');
const { promisify } = require('util');
const scrypt = promisify(crypto.scrypt);

const N = 16384, R = 8, P = 1, KEYLEN = 64;
const MAXMEM = 64 * 1024 * 1024; // 128*N*r = 16MB 사용 → 여유 있게 잡는다

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, KEYLEN, { N, r: R, p: P, maxmem: MAXMEM });
  return ['scrypt', N, R, P, salt.toString('base64'), key.toString('base64')].join('$');
}

async function verifyPassword(password, stored) {
  if (typeof stored !== 'string' || typeof password !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const n = Number(parts[1]), r = Number(parts[2]), p = Number(parts[3]);
  if (!Number.isFinite(n) || !Number.isFinite(r) || !Number.isFinite(p)) return false;
  let salt, expected;
  try {
    salt = Buffer.from(parts[4], 'base64');
    expected = Buffer.from(parts[5], 'base64');
  } catch (e) { return false; }
  if (!expected.length) return false;
  let key;
  try {
    key = await scrypt(password, salt, expected.length, { N: n, r, p, maxmem: MAXMEM });
  } catch (e) { return false; }
  return key.length === expected.length && crypto.timingSafeEqual(key, expected);
}

// 관리자 비밀번호 규칙 — 클라이언트에도 같은 문구로 안내하지만, 최종 판단은 항상 서버다.
function validatePasswordRule(pw) {
  if (typeof pw !== 'string' || !pw) return { ok: false, error: '비밀번호를 입력해주세요.' };
  if (pw.length < 10) return { ok: false, error: '비밀번호는 10자 이상이어야 해요.' };
  if (pw.length > 200) return { ok: false, error: '비밀번호가 너무 길어요(200자 이하).' };
  if (!/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw)) return { ok: false, error: '비밀번호에 영문과 숫자를 모두 포함해주세요.' };
  return { ok: true };
}

// 초대 코드 등 비밀 문자열 비교 — 길이가 달라도 즉시 false를 반환하되, 같은 길이일 때는
// 상수 시간 비교를 사용한다.
function secretEquals(a, b) {
  const ab = Buffer.from(String(a == null ? '' : a), 'utf8');
  const bb = Buffer.from(String(b == null ? '' : b), 'utf8');
  if (ab.length === 0 || bb.length === 0 || ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

module.exports = { hashPassword, verifyPassword, validatePasswordRule, secretEquals };
