// 최소 Node.js 서버 (로컬 개발용)
// - public/ 아래 정적 파일(index.html 등)을 서빙한다.
// - POST /api/parse-tasks 에서 lib/parseTasks.js의 공통 로직으로 OpenAI 업무 추출을 수행한다.
//   (프롬프트/스키마/호출/정제 로직은 lib/parseTasks.js와 Vercel의 api/parse-tasks.js가 함께 쓴다.)
// - OPENAI_API_KEY는 이 서버 프로세스 안에서만 사용되며, 어떤 응답에도 그대로 포함되지 않는다.
// - .env 로더는 이 파일에만 있다. lib/parseTasks.js는 .env를 직접 읽지 않고,
//   이 파일이 먼저 채워둔 process.env를 그대로 사용한다.
//
// 외부 npm 패키지 없이(내장 http/fs/path + Node 18+ 전역 fetch) 동작한다.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { handleParseTasksPayload, ParseTasksError, MAX_BODY_BYTES } = require('./lib/parseTasks');
const authApi = require('./lib/authApi');
const { handleAdminRoute } = require('./lib/adminApi');
const { applyResultNode } = require('./lib/httpAdapter');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');

/* ------------------------------------------------------------
   .env 로더 (dotenv 없이 최소 구현)
------------------------------------------------------------ */
function loadEnvFile(){
  const envPath = path.join(ROOT, '.env');
  if(!fs.existsSync(envPath)) return;
  const content = fs.readFileSync(envPath, 'utf-8');
  content.split('\n').forEach(line=>{
    const trimmed = line.trim();
    if(!trimmed || trimmed.startsWith('#')) return;
    const eq = trimmed.indexOf('=');
    if(eq === -1) return;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))){
      val = val.slice(1, -1);
    }
    if(!(key in process.env)) process.env[key] = val;
  });
}
loadEnvFile();

const PORT = process.env.PORT || 3000;

/* ------------------------------------------------------------
   HTTP 서버
------------------------------------------------------------ */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

function sendJson(res, statusCode, obj){
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function handleParseTasks(req, res){
  let body = '';
  let tooLarge = false;
  req.on('data', chunk=>{
    body += chunk;
    // 원시 소켓 스트림에서 실제로 수신한 바이트 수를 직접 세는 방식이라, Content-Length 헤더가
    // 없거나 거짓이어도(위조·chunked 전송 등) 안전하게 300,000바이트를 넘는 순간 즉시 끊는다.
    if(body.length > MAX_BODY_BYTES){
      tooLarge = true;
      req.destroy();
    }
  });
  req.on('end', async ()=>{
    if(tooLarge) return; // 커넥션이 이미 끊어짐 — 응답하지 않는다.

    let payload;
    try{
      payload = body ? JSON.parse(body) : {};
    }catch(e){
      sendJson(res, 400, { error: '요청 본문이 올바른 JSON 형식이 아닙니다.' });
      return;
    }

    try{
      const result = await handleParseTasksPayload(payload);
      sendJson(res, 200, result);
    }catch(err){
      if(err instanceof ParseTasksError){
        console.error('[parse-tasks]', err.logDetail || `status=${err.status}`);
        sendJson(res, err.status, { error: err.publicMessage });
      } else {
        console.error('[parse-tasks] unexpected_error', err && err.name);
        sendJson(res, 500, { error: '업무 추출 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요.' });
      }
    }
  });
  req.on('error', ()=>{ /* 클라이언트가 연결을 끊은 경우 등 - 무시 */ });
}

// 인증/프로필 API용 최소 JSON 본문 리더 — handleParseTasks와 같은 방식으로 원시 소켓 바이트
// 수를 직접 세어 과도하게 큰 요청을 즉시 끊는다(요청 위조로 Content-Length를 속여도 안전).
const MAX_AUTH_BODY_BYTES = 5 * 1024 * 1024;
function readJsonBody(req){
  return new Promise((resolve, reject)=>{
    let body = '';
    let tooLarge = false;
    req.on('data', chunk=>{
      body += chunk;
      if(body.length > MAX_AUTH_BODY_BYTES){ tooLarge = true; req.destroy(); }
    });
    req.on('end', ()=>{
      if(tooLarge) return reject(new Error('too_large'));
      if(!body){ resolve({}); return; }
      try{ resolve(JSON.parse(body)); }catch(e){ reject(e); }
    });
    req.on('error', reject);
  });
}
// server.js(로컬 개발)에서 인증/프로필 API를 처리한다 — Vercel의 api/auth/*.js, api/profile/*.js와
// 완전히 같은 lib/authApi.js 로직을 그대로 호출한다. needsBody인 라우트만 JSON 본문을 읽는다.
async function handleAuthRoute(req, res, fn, needsBody){
  let body = null;
  if(needsBody){
    try{ body = await readJsonBody(req); }
    catch(e){ res.writeHead(400, {'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify({error:'invalid_json', message:'요청 본문이 올바른 JSON 형식이 아니에요.'})); return; }
  }
  const result = needsBody ? await fn(req, body) : await fn(req);
  applyResultNode(req, res, result);
}
// { 'METHOD PATH': [handlerFn, needsBody] } — lib/authApi.js의 함수를 그대로 매핑한다.
const AUTH_ROUTE_TABLE = {
  'POST /api/auth/register': [authApi.register, true],
  'POST /api/auth/login': [authApi.login, true],
  'POST /api/auth/logout': [authApi.logout, false],
  'GET /api/auth/me': [authApi.me, false],
  'GET /api/profile': [authApi.getProfile, false],
  'PUT /api/profile': [authApi.saveProfile, true],
  'POST /api/profile/import': [authApi.importGuestData, true]
};

function serveStatic(req, res){
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if(urlPath === '/') urlPath = '/index.html';

  const fullPath = path.normalize(path.join(PUBLIC_DIR, urlPath));
  if(!fullPath.startsWith(PUBLIC_DIR)){
    res.writeHead(403); res.end('Forbidden'); return;
  }
  // .env 등 민감 파일은 public/ 밖에 있어 이 경로로는 원천적으로 닿지 않지만, 이중 안전장치로 남겨둔다.
  if(path.basename(fullPath) === '.env'){
    res.writeHead(404); res.end('Not Found'); return;
  }

  fs.readFile(fullPath, (err, data)=>{
    if(err){
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }
    const ext = path.extname(fullPath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer((req, res)=>{
  const urlPath = req.url.split('?')[0];

  // /api/parse-tasks 경로는 메서드에 상관없이 여기서 먼저 판단한다 — POST가 아니면 정적 파일
  // 탐색으로 흘러들어가 404가 되지 않고(그러면 없는 파일처럼 보임), Vercel의 api/parse-tasks.js와
  // 동일하게 명시적으로 405를 반환한다.
  if(urlPath === '/api/parse-tasks'){
    if(req.method === 'POST'){
      handleParseTasks(req, res);
      return;
    }
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8', 'Allow': 'POST' });
    res.end('Method Not Allowed');
    return;
  }

  // 관리자 API(로컬 개발) — Vercel의 api/admin/[...route].js와 완전히 같은 lib/adminApi.js를 쓴다.
  if(urlPath.startsWith('/api/admin/')){
    const route = urlPath.slice('/api/admin/'.length);
    const query = Object.fromEntries(new URL(req.url, 'http://localhost').searchParams);
    (async ()=>{
      if(req.method !== 'GET' && req.method !== 'POST'){
        sendJson(res, 405, { error: 'Method Not Allowed' });
        return;
      }
      let body = {};
      if(req.method === 'POST'){
        try{ body = await readJsonBody(req); }
        catch(e){ sendJson(res, 400, { error:'invalid_json', message:'요청 본문이 올바른 JSON 형식이 아니에요.' }); return; }
      }
      const result = await handleAdminRoute(req.method, route, req, body, query);
      applyResultNode(req, res, result);
    })().catch(err=>{
      console.error('[admin-route] unexpected_error', route, err && err.message);
      if(!res.headersSent) sendJson(res, 500, { error:'internal_error', message:'요청 처리 중 오류가 발생했어요.' });
    });
    return;
  }

  // 닉네임 인증 + 사용자별 서버 저장 API(로컬 개발) — Vercel의 api/auth/*.js, api/profile/*.js와
  // 완전히 같은 lib/authApi.js 로직을 그대로 쓴다.
  if(urlPath.startsWith('/api/auth/') || urlPath === '/api/profile' || urlPath === '/api/profile/import'){
    const routeKey = req.method + ' ' + urlPath;
    const route = AUTH_ROUTE_TABLE[routeKey];
    if(route){
      handleAuthRoute(req, res, route[0], route[1]).catch(err=>{
        console.error('[auth-route] unexpected_error', routeKey, err && err.message);
        if(!res.headersSent) sendJson(res, 500, { error: 'internal_error', message: '요청 처리 중 오류가 발생했어요.' });
      });
      return;
    }
    res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'Method Not Allowed' }));
    return;
  }

  if(req.method === 'GET' || req.method === 'HEAD'){
    serveStatic(req, res);
    return;
  }
  res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Method Not Allowed');
});

// node server.js로 "직접 실행"했을 때만 리슨한다(require.main === module).
// 로컬 개발(`npm start`, `node server.js`)은 지금과 완전히 동일하게 동작한다.
// 이렇게 가드해 두면, 이 파일이 어떤 이유로든 실행되지 않고 단순히 require()만 되는 상황에서
// 의도치 않게 서버가 뜨는 부작용을 막을 수 있다.
if(require.main === module){
  server.listen(PORT, ()=>{
    console.log(`✅ 서버 실행 중: http://localhost:${PORT}`);
    console.log(`   모델: ${process.env.OPENAI_MODEL || 'gpt-5-nano'}`);
    if(!process.env.OPENAI_API_KEY){
      console.warn('⚠️  OPENAI_API_KEY가 설정되어 있지 않습니다. .env 파일을 만들고 키를 넣어주세요.');
    }
  });
}

module.exports = server;
