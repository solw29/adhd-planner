// Vercel Node.js 함수 진입점 — POST /api/parse-tasks
//
// 로컬 server.js와 동일한 lib/parseTasks.js를 사용해서 요청 검증 → OpenAI 호출 → 결과 정제
// 로직을 그대로 공유한다. 이 파일은 Vercel의 request.body 헬퍼(지연 파싱 getter)를 사용하고,
// 원시 요청 스트림을 별도로 다시 읽지 않는다 — request.body에 접근하는 순간 스트림이 소비되므로,
// 그 뒤에 req.on('data')로 다시 읽으려 하면 데이터 이벤트가 오지 않아 응답이 멈출 수 있다.
// (참고: https://vercel.com/docs/functions/runtimes/node-js — "Request body" 섹션)
//
// .env는 이 파일에서 읽지 않는다. Vercel 프로젝트에 등록한 환경변수가 이미 process.env에 있다.

const { handleParseTasksPayload, ParseTasksError, MAX_BODY_BYTES } = require('../lib/parseTasks');

module.exports = async function handler(req, res) {
  // 이 경로로 오는 모든 HTTP 메서드가 이 함수 하나로 들어오므로, 메서드를 직접 검사해야 한다.
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method Not Allowed' });
    return;
  }

  // Content-Length 헤더는 클라이언트가 보낸 값을 그대로 신뢰하는 것이라 위조되거나 누락될 수 있다.
  // 그래서 이것만으로 "안전하다"고 판단하지 않고, 명백히 큰 경우를 빠르게 걸러내는 용도로만 쓴다.
  // 실제 판단은 아래에서 파싱된 본문 크기를 다시 측정해서 내린다(handleParseTasksPayload 내부).
  const declaredLength = Number(req.headers['content-length']);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    res.status(413).json({ error: '요청 본문이 너무 큽니다.' });
    return;
  }

  let payload;
  try {
    // request.body는 getter라서 여기서 처음 접근할 때 파싱된다. Content-Type이
    // application/json이 아니면 undefined, JSON이 깨져 있으면 이 줄에서 예외가 던져진다.
    payload = req.body;
  } catch (e) {
    res.status(400).json({ error: '요청 본문이 올바른 JSON 형식이 아닙니다.' });
    return;
  }
  if (payload === undefined || payload === null) {
    res.status(400).json({ error: '요청 본문이 비어있습니다.' });
    return;
  }

  try {
    const result = await handleParseTasksPayload(payload);
    res.status(200).json(result);
  } catch (err) {
    if (err instanceof ParseTasksError) {
      console.error('[api/parse-tasks]', err.logDetail || `status=${err.status}`);
      res.status(err.status).json({ error: err.publicMessage });
    } else {
      // 예상 못한 예외의 이름만 남기고, 메시지/스택은 남기지 않는다(민감정보 포함 가능성 배제).
      console.error('[api/parse-tasks] unexpected_error', err && err.name);
      res.status(500).json({ error: '업무 추출 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요.' });
    }
  }
};
