// Brain Dump 텍스트 → 업무 배열 추출의 공통 로직.
// 프롬프트 생성, JSON 스키마 생성, OpenAI 호출, 결과 정제, 요청 검증을 모두 여기에 모아
// 로컬 server.js와 Vercel의 api/parse-tasks.js가 동일한 코드를 공유하게 한다.
//
// 이 모듈은 .env 파일을 직접 읽지 않는다(.env 로더는 server.js에만 남겨둔다).
// OPENAI_API_KEY / OPENAI_MODEL은 호출 시점의 process.env에서 읽는다:
// - 로컬: server.js가 먼저 .env를 읽어 process.env를 채운 뒤 이 모듈을 사용한다.
// - 배포: Vercel 프로젝트에 등록한 환경변수가 이미 process.env에 채워져 있다.

const SCHEDULING_TYPES = ['BLOCK_EVENT', 'POINT_TASK', 'DURATION_TASK', 'FLEXIBLE_TASK'];
const WD_NAMES_KO = ['일', '월', '화', '수', '목', '금', '토'];

const MAX_BODY_BYTES = 300000; // 기존 로컬 서버의 요청 본문 상한을 그대로 유지한다.
const MAX_TEXT_LENGTH = 8000;  // Brain Dump 텍스트 자체의 별도 상한 (과도한 토큰 사용/비용 남용 방지).
const OPENAI_TIMEOUT_MS = 25000; // OpenAI 호출이 무한정 대기하지 않도록 하는 유한 타임아웃. 재시도는 하지 않는다.

/**
 * 클라이언트에는 publicMessage만 보여주고, 로그에는 logDetail(민감정보를 제거한 진단 정보)만
 * 남기기 위한 전용 에러 타입. OpenAI가 보낸 원문 메시지·서버 내부 경로 등은 여기 담지 않는다.
 */
class ParseTasksError extends Error {
  constructor(status, publicMessage, logDetail) {
    super(publicMessage);
    this.name = 'ParseTasksError';
    this.status = status;
    this.publicMessage = publicMessage;
    this.logDetail = logDetail;
  }
}

/* ------------------------------------------------------------
   프롬프트 / JSON 스키마 — 기존 server.js와 동일한 내용을 그대로 옮겼다(문구 변경 없음).
------------------------------------------------------------ */
// clientDateStr: 사용자 브라우저의 로컬(현지) "오늘" 날짜(YYYY-MM-DD), 요청을 시작한 시점에
// 프런트엔드가 계산해 함께 보낸다. Vercel 등 서버가 다른 시간대(보통 UTC)에서 실행되면, 서버의
// new Date()로 "오늘"을 계산할 경우 한국 자정~오전 9시 사이에는 실제로는 다음 날인데도 전날로
// 잘못 판단할 수 있다(KST=UTC+9). 그래서 서버 시계 대신 이 값을 우선 사용한다.
// 값이 없거나 형식이 올바르지 않으면(하위 호환 — 예전 클라이언트) 서버 시계로 대체한다.
function buildSystemPrompt(categories, groups, clientDateStr) {
  let todayStr, wd;
  if (typeof clientDateStr === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(clientDateStr)) {
    const [y, m, d] = clientDateStr.split('-').map(Number);
    // 요일은 순수 달력 계산이라 Date.UTC로 구해야 서버 시간대와 무관하게 항상 같은 결과가 나온다.
    wd = WD_NAMES_KO[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
    todayStr = clientDateStr;
  } else {
    const now = new Date();
    todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    wd = WD_NAMES_KO[now.getDay()];
  }

  const catList = categories.map(c => `- id:"${c.id}" name:"${c.name}"`).join('\n') || '(없음)';
  const grpList = groups.map(g => `- id:"${g.id}" categoryId:"${g.categoryId}" name:"${g.name}"`).join('\n') || '(없음)';

  return `당신은 ADHD 사용자를 위한 일정 관리 앱의 "업무 추출 엔진"입니다.
오늘 날짜는 ${todayStr} (${wd}요일)입니다. 사용자가 "내일", "수요일", "다음 주" 등 상대적인 날짜 표현을 쓰면,
오늘 날짜를 기준으로 계산한 실제 YYYY-MM-DD 날짜로 변환하세요. 요일만 언급했다면 오늘 이후 가장 가까운 그 요일을 사용하세요.

사용자가 두서없이 적은 Brain Dump 텍스트를 분석해서, 각 업무를 아래 규칙에 맞는 JSON으로 추출하세요.

[현재 사용자의 Category 목록 — 반드시 이 중에서만 categoryId를 선택하세요]
${catList}

[현재 사용자의 Group 목록 — 반드시 이 중에서만 groupId를 선택하세요 (그룹은 특정 카테고리에 속함)]
${grpList}

[업무 유형(schedulingType) 분류 기준 - "시간이 있냐"가 아니라 "시간 점유가 발생하냐"가 기준]
- BLOCK_EVENT: 실제 시간 구간을 점유하는 일정/약속/수업/회의. 시작 시각(startTime)이 있는 일정.
  종료 시각(endTime)은 사용자가 명시적으로 말한 경우에만 채우세요 — 말하지 않았다면 절대 관습적으로 추정하지 말고 반드시 null로 두세요.
- POINT_TASK: 특정 시각에 해야 하지만 지속 시간은 없는 업무 (예: 약 먹기, 메일 보내기, 출석체크). 다른 일정과 동시에 존재 가능.
- DURATION_TASK: 필요한 소요 시간은 사용자가 명시했지만("2시간", "1시간", "40분" 등), 실제 수행 시간대는 아직 정해지지 않은 업무.
- FLEXIBLE_TASK: 소요 시간도 정해지지 않은 일반 체크리스트성 업무.

[카테고리/그룹 분류 규칙 — 매우 중요]
1. categoryId는 반드시 위 Category 목록에 있는 id 중 하나여야 합니다. 목록에 없는 새 카테고리 이름을 만들어내지 마세요.
   업무가 어느 카테고리에 속하는지 문맥상 확신할 수 없으면, categoryId를 null로 두고 categoryAmbiguous를 true로 설정하세요.
   사용자가 직접 카테고리를 고르거나 새로 만들게 됩니다. 절대 임의로 추측해서 채우지 마세요.
2. groupId는 반드시 위 Group 목록에 있는 id 중 하나여야 하며, 그 group의 categoryId가 이 업무의 categoryId와 일치해야 합니다.
   텍스트가 언급한 프로젝트/그룹이 목록에 있는 어떤 group과 명확히 같은 대상이면 그 id를 쓰세요.
   업무에 프로젝트/그룹 언급이 아예 없다면 groupId는 null, groupAmbiguous는 false로 두세요 (그룹 없이 카테고리 바로 아래 업무).
   프로젝트/그룹이 언급됐지만 목록의 기존 그룹 중 어느 것과도 명확히 일치하지 않는다면(새 그룹일 수 있음),
   groupId는 null, groupAmbiguous는 true로 설정하고, 언급된 이름을 groupNameCandidate에 참고용으로 남기세요(확정하지 마세요).
3. 같은 이름의 업무(예: "자료조사")가 서로 다른 그룹/프로젝트에 속한다면, 절대 하나로 합치지 말고 각각 별도의 항목으로 추출하세요.
   업무를 임의로 병합하거나 요약해서 줄이지 마세요 — 언급된 업무 하나하나가 배열의 한 항목이 되어야 합니다.

[시간/소요시간 규칙]
4. FLEXIBLE_TASK인데 사용자가 소요시간을 말하지 않았다면, aiSuggestedMinutes에 합리적인 "제안" 값(분 단위)만 채우세요.
   이 값은 확정이 아니라 제안입니다. 이 경우 estimatedMinutes는 반드시 null로 두세요. (사용자가 나중에 승인해야 확정됩니다.)
5. estimatedMinutes는 사용자가 텍스트에서 명시적으로 소요시간을 말한 경우에만 채우세요 (예: "2시간"→120, "1시간"→60, "40분"→40).
   명시적으로 말하지 않았다면 반드시 null로 두세요.
6. BLOCK_EVENT의 종료 시각(endTime)은 사용자가 명시적으로 말한 경우에만 채우세요.
   예를 들어 "목요일 15시에 팀회의"처럼 시작 시각만 언급됐다면, "회의는 보통 1시간"처럼 관습적으로 추정하지 말고 endTime을 반드시 null로 두세요.
   사용자가 직접 종료 시각을 검수 화면에서 입력하게 됩니다.
7. sessionName은 사용자가 "카공", "도서관에서 공부", "카페에서 집중", "스터디 시간"처럼
   작업 장소/세션을 명시적으로 언급하면서 그 안에서 발생하는 개별 업무들을 말한 경우에만, 그 세션 이름 그대로 채우세요.
   사용자가 세션을 언급하지 않았다면 절대 임의로 세션 이름을 만들지 말고 null로 두세요.
   예를 들어 "오픽 1시간 하고 보고서 1시간"처럼 세션 언급 없이 여러 업무를 나열했을 뿐이라면, "카공" 같은 세션을 임의로 만들면 안 됩니다.
8. 날짜는 "YYYY-MM-DD", 시간은 24시간제 "HH:MM" 형식만 사용하세요. 알 수 없으면 null로 두세요.
9. 텍스트에 언급된 업무만 추출하세요. 언급되지 않은 업무를 추가로 만들어내지 마세요.
10. 반드시 정의된 JSON 스키마 형식으로만 응답하세요.`;
}

function buildTaskJsonSchema(categories, groups) {
  const categoryIdEnum = [...categories.map(c => c.id), null];
  const groupIdEnum = [...groups.map(g => g.id), null];

  return {
    name: 'task_extraction',
    strict: true,
    schema: {
      type: 'object',
      properties: {
        tasks: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', description: '업무 제목' },
              categoryId: { type: ['string', 'null'], enum: categoryIdEnum, description: '제공된 Category id 중 하나. 확신 없으면 null' },
              categoryAmbiguous: { type: 'boolean' },
              groupId: { type: ['string', 'null'], enum: groupIdEnum, description: '제공된 Group id 중 하나. 없거나 불확실하면 null' },
              groupAmbiguous: { type: 'boolean' },
              groupNameCandidate: { type: ['string', 'null'], description: '그룹이 불확실할 때 참고용으로 남기는, 텍스트에서 언급된 이름' },
              schedulingType: { type: 'string', enum: SCHEDULING_TYPES },
              date: { type: ['string', 'null'], description: 'YYYY-MM-DD' },
              startTime: { type: ['string', 'null'], description: 'HH:MM' },
              endTime: { type: ['string', 'null'], description: 'HH:MM. 사용자가 명시적으로 말한 경우에만 채움 — 추정 금지, 없으면 null' },
              deadline: { type: ['string', 'null'], description: 'YYYY-MM-DD' },
              estimatedMinutes: { type: ['integer', 'null'] },
              aiSuggestedMinutes: { type: ['integer', 'null'] },
              sessionName: { type: ['string', 'null'] }
            },
            required: ['title', 'categoryId', 'categoryAmbiguous', 'groupId', 'groupAmbiguous', 'groupNameCandidate', 'schedulingType', 'date', 'startTime', 'endTime', 'deadline', 'estimatedMinutes', 'aiSuggestedMinutes', 'sessionName'],
            additionalProperties: false
          }
        }
      },
      required: ['tasks'],
      additionalProperties: false
    }
  };
}

/* ------------------------------------------------------------
   OpenAI 호출 — 유한 타임아웃(재시도 없음), 안전한 에러 메시지
------------------------------------------------------------ */
async function extractTasksWithOpenAI(text, categories, groups, clientDateStr) {
  const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
  const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-5-nano';

  if (!OPENAI_API_KEY) {
    // 클라이언트에는 서버 구성 정보를 알리지 않고, 로그에만 원인을 남긴다.
    throw new ParseTasksError(500, 'AI 업무 추출 기능을 지금 사용할 수 없습니다. 잠시 후 다시 시도해주세요.', 'missing_api_key');
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS);

  let res;
  try {
    res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        messages: [
          { role: 'system', content: buildSystemPrompt(categories, groups, clientDateStr) },
          { role: 'user', content: text }
        ],
        response_format: { type: 'json_schema', json_schema: buildTaskJsonSchema(categories, groups) }
      }),
      signal: controller.signal
    });
  } catch (networkErr) {
    if (networkErr && networkErr.name === 'AbortError') {
      throw new ParseTasksError(504, 'AI 응답이 지연되어 요청을 중단했습니다. 잠시 후 다시 시도해주세요.', 'openai_timeout');
    }
    throw new ParseTasksError(502, 'AI 서비스에 연결할 수 없습니다. 잠시 후 다시 시도해주세요.', 'openai_network_error');
  } finally {
    clearTimeout(timeoutId);
  }

  const raw = await res.text();
  let data;
  try { data = JSON.parse(raw); }
  catch (e) { throw new ParseTasksError(502, 'AI 서비스 응답을 해석할 수 없습니다.', 'openai_response_not_json'); }

  if (!res.ok) {
    // OpenAI가 보낸 원문 오류 메시지는 계정/키 관련 정보를 포함할 수 있어
    // 클라이언트 응답과 로그 어디에도 그대로 남기지 않고, 상태 코드만 남긴다.
    throw new ParseTasksError(502, 'AI 서비스 응답을 가져오는 데 실패했습니다. 잠시 후 다시 시도해주세요.', `openai_http_error status=${res.status}`);
  }

  const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (!content) {
    throw new ParseTasksError(502, 'AI 서비스 응답에 내용이 없습니다.', 'openai_empty_content');
  }

  let parsed;
  try { parsed = JSON.parse(content); }
  catch (e) { throw new ParseTasksError(502, '업무 추출 결과를 해석하지 못했습니다.', 'openai_content_not_json'); }

  if (!parsed || !Array.isArray(parsed.tasks)) {
    throw new ParseTasksError(502, '업무 추출 결과 형식이 올바르지 않습니다.', 'openai_invalid_shape');
  }
  return parsed.tasks;
}

// 스키마의 enum이 모델에서 완벽히 강제되지 않을 가능성에 대비한 2차 방어선.
// 클라이언트가 보낸 categories/groups 목록에 실제로 없는 id는 전부 "불확실"로 강등한다.
function sanitizeTasks(tasks, categories, groups) {
  const catIds = new Set(categories.map(c => c.id));
  const groupById = new Map(groups.map(g => [g.id, g]));

  return tasks.map(t => {
    const out = Object.assign({}, t);

    if (!out.categoryId || !catIds.has(out.categoryId)) {
      out.categoryId = null;
      out.categoryAmbiguous = true;
    }

    if (out.categoryAmbiguous) {
      out.groupId = null;
    } else if (out.groupId) {
      const g = groupById.get(out.groupId);
      if (!g || g.categoryId !== out.categoryId) {
        out.groupId = null;
        out.groupAmbiguous = true;
      }
    }

    if (!SCHEDULING_TYPES.includes(out.schedulingType)) out.schedulingType = 'FLEXIBLE_TASK';
    return out;
  });
}

/* ------------------------------------------------------------
   요청 검증 — 로컬 server.js와 Vercel api/parse-tasks.js가 동일하게 사용한다.
------------------------------------------------------------ */

/**
 * 문자열 또는 이미 파싱된 값의 UTF-8 바이트 길이를 구한다.
 * 직렬화 자체가 실패하면(순환 참조 등) 안전하게 "매우 큼"으로 취급한다.
 */
function byteLengthOf(value) {
  try {
    return Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value), 'utf-8');
  } catch (e) {
    return Infinity;
  }
}

// clientDate 검증: 순수 달력 계산(Date.UTC)만 쓰므로 서버 시간대와 무관하게 항상 같은 결과를 낸다.
function isValidClientDateStr(v) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const [y, m, d] = v.split('-').map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/**
 * 이미 JSON.parse된 요청 본문 객체를 검증한다.
 * categories는 최소 1개 이상이어야 하지만(앱이 온보딩에서 최소 1개를 강제하므로,
 * 0개는 정상 상태가 아니라 잘못된 요청으로 본다), groups는 빈 배열이어도 유효하다
 * (그룹 없이 시작한 상태가 앱의 정상적인 데이터 상태이기 때문).
 */
function validateParsedPayload(payload) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, status: 400, error: '요청 본문 형식이 올바르지 않습니다.' };
  }

  const text = typeof payload.text === 'string' ? payload.text.trim() : '';
  if (!text) {
    return { ok: false, status: 400, error: '분석할 텍스트가 비어있습니다.' };
  }
  if (text.length > MAX_TEXT_LENGTH) {
    return { ok: false, status: 400, error: `입력 텍스트가 너무 깁니다 (최대 ${MAX_TEXT_LENGTH}자).` };
  }

  if (!Array.isArray(payload.categories)) {
    return { ok: false, status: 400, error: 'categories 형식이 올바르지 않습니다.' };
  }
  const categories = payload.categories
    .filter(c => c && typeof c.id === 'string' && c.id.trim() && typeof c.name === 'string' && c.name.trim())
    .map(c => ({ id: c.id, name: c.name }));
  if (categories.length === 0) {
    return { ok: false, status: 400, error: '카테고리가 하나도 없습니다. 먼저 카테고리를 만들어주세요.' };
  }

  const groupsRaw = payload.groups === undefined ? [] : payload.groups;
  if (!Array.isArray(groupsRaw)) {
    return { ok: false, status: 400, error: 'groups 형식이 올바르지 않습니다.' };
  }
  // 그룹이 하나도 없는 것은 앱에서 유효한 정상 상태이므로, 여기서는 길이 0을 오류로 보지 않는다.
  const groups = groupsRaw
    .filter(g => g && typeof g.id === 'string' && g.id.trim() && typeof g.categoryId === 'string' && g.categoryId.trim() && typeof g.name === 'string' && g.name.trim())
    .map(g => ({ id: g.id, categoryId: g.categoryId, name: g.name }));

  // clientDate는 선택 필드다(하위 호환) — 없거나 형식이 잘못되면 그냥 무시하고 서버 시계로
  // 대체하게 둔다(요청 자체를 거부하지 않는다). 값이 있으면 "오늘/내일" 해석에 사용된다.
  const clientDate = isValidClientDateStr(payload.clientDate) ? payload.clientDate : null;

  return { ok: true, text, categories, groups, clientDate };
}

/**
 * 이미 파싱된 요청 본문(payload) 하나로 "크기 검사 → 필드 검증 → OpenAI 호출 → 결과 정제"까지
 * 한 번에 처리하는 진입점. 로컬 server.js와 Vercel api/parse-tasks.js가 동일하게 호출한다.
 * 실패 시 ParseTasksError를 던진다(status/publicMessage/logDetail 포함) — 검증 실패 단계에서는
 * OpenAI를 호출하지 않는다.
 */
async function handleParseTasksPayload(payload) {
  // 본문 크기: 원본 전송 바이트 수와 "파싱 이후 이 값을 다시 직렬화했을 때의 바이트 수"는
  // 공백/이스케이프 차이로 완전히 같지는 않지만(예: JSON 공백 제거, 유니코드 이스케이프 등),
  // 파싱된 값 기준으로 재검사하는 것은 이미 신뢰 경계를 넘어온 값에 대한 애플리케이션 레벨의
  // 2차 방어선이다. 원본 바이트 자체를 정확히 제한하려면 스트림을 직접 읽는 server.js처럼
  // 수신 단계에서 끊어야 한다(아래 server.js 설명 참고).
  if (byteLengthOf(payload) > MAX_BODY_BYTES) {
    throw new ParseTasksError(413, '요청 본문이 너무 큽니다.', 'payload_too_large');
  }

  const validation = validateParsedPayload(payload);
  if (!validation.ok) {
    throw new ParseTasksError(validation.status, validation.error, 'validation_failed');
  }

  const rawTasks = await extractTasksWithOpenAI(validation.text, validation.categories, validation.groups, validation.clientDate);
  const tasks = sanitizeTasks(rawTasks, validation.categories, validation.groups);
  return { tasks };
}

module.exports = {
  ParseTasksError,
  MAX_BODY_BYTES,
  MAX_TEXT_LENGTH,
  byteLengthOf,
  isValidClientDateStr,
  validateParsedPayload,
  handleParseTasksPayload,
  extractTasksWithOpenAI,
  sanitizeTasks,
  buildSystemPrompt,
  buildTaskJsonSchema
};
