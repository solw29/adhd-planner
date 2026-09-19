// 가입·로그인 요청에 대한 기본적인 요청 제한(요구사항 4) — 고정 윈도우 방식의 최소 구현이다.
// 주의(한계, 완료 보고에도 명시): 이 저장소는 프로세스 메모리 안에만 있다. 로컬 서버(node
// server.js)에서는 계속 유지되지만, Vercel 서버리스는 인스턴스가 여러 개로 늘어나거나 콜드
// 스타트가 나면 이 카운터가 공유되지 않고 초기화될 수 있다 — 분산 환경에서 엄격한 제한이
// 필요하다면 Redis 등 공유 저장소 기반 레이트리밋으로 교체해야 한다.
'use strict';

const buckets = new Map(); // key -> { count, resetAt }

function checkRateLimit(key, limit, windowMs) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || b.resetAt <= now) {
    b = { count: 0, resetAt: now + windowMs };
    buckets.set(key, b);
  }
  b.count += 1;
  // 버킷이 과도하게 쌓이지 않도록 가끔 정리한다(요청이 뜸한 프로세스에서 메모리가 계속
  // 늘어나지 않게 하는 최소한의 하우스키핑).
  if (buckets.size > 5000) {
    for (const [k, v] of buckets) { if (v.resetAt <= now) buckets.delete(k); }
  }
  return b.count <= limit;
}

function clientIpOf(req) {
  const xf = req.headers['x-forwarded-for'];
  if (typeof xf === 'string' && xf.trim()) return xf.split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

module.exports = { checkRateLimit, clientIpOf };
