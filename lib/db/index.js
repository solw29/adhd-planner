// DB 백엔드 선택 — 실제 연결 문자열(DATABASE_URL/POSTGRES_URL 등)이 있으면 항상 Postgres를
// 쓰고, 없을 때만(그리고 Vercel이 아닐 때만) 로컬 개발용 SQLite로 대체한다.
//
// 중요: Vercel(서버리스)에는 영속 로컬 디스크가 없다. 여기서 SQLite로 조용히 대체해버리면
// 매 배포·인스턴스 재시작마다 데이터가 사라지는데도 겉보기엔 "저장 성공"처럼 보이는 상태가
// 된다 — 요구사항이 명시적으로 금지한 "가짜 저장 성공"이다. 그래서 Vercel 환경에서 연결 문자열이
// 없으면 DB를 아예 만들지 않고 null을 반환하며, 호출부(lib/authApi.js)는 이를 보고 모든 인증·
// 저장 API에서 503과 함께 "서버 저장소가 아직 연결되지 않았어요"를 명확히 응답한다.
'use strict';
const path = require('path');

let cached = null;
let cachedKey = null;

function connectionStringFromEnv() {
  return process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.POSTGRES_PRISMA_URL || null;
}

// 러닝 환경이 Vercel인지(로컬 `vercel dev`도 포함) 판단한다 — Vercel이 함수에 항상 심어주는 값이다.
function isVercelRuntime() {
  return !!process.env.VERCEL;
}

function getDb() {
  const url = connectionStringFromEnv();
  const key = url ? 'pg:' + url : (isVercelRuntime() ? 'vercel-no-db' : 'sqlite:' + (process.env.SQLITE_PATH || 'default'));

  if (cached && cachedKey === key) return cached;

  if (url) {
    cached = require('./pg').create(url);
  } else if (isVercelRuntime()) {
    cached = null; // 명시적으로 "연결 안 됨" — 절대 SQLite로 대체하지 않는다.
  } else {
    // SQLITE_PATH를 주면 격리된 DB 파일로 띄울 수 있다(테스트용). 지정하지 않으면 기본 경로를 쓴다.
    const filePath = process.env.SQLITE_PATH
      ? path.resolve(process.env.SQLITE_PATH)
      : path.join(__dirname, '..', '..', '.data', 'app.sqlite');
    cached = require('./sqlite').create(filePath);
  }
  cachedKey = key;
  return cached;
}

module.exports = { getDb };
