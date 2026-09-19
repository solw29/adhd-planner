# ADHD Planner

ADHD·강박·귀차니즘 사용자를 위한 AI 일정 관리 웹서비스.

텍스트 입력 → AI 업무 추출 → 사용자 검수·수정 → 업무 확정 → 체크리스트 → 작업 시간 추천 → 10분 플래너 배치 → 완료 표시

- 배포 주소: https://adhd-planner-five.vercel.app/

## 구조

```
public/index.html   프론트엔드(HTML/CSS/Vanilla JS 단일 파일, 반응형)
api/                Vercel 서버리스 함수(업무 추출, 닉네임 로그인, 프로필 저장, 관리자)
lib/                로컬 서버와 api/가 함께 쓰는 공통 로직
lib/db/             DB 어댑터(Postgres: pg.js / 로컬 SQLite: sqlite.js)
server.js           로컬 개발용 Node 서버(정적 파일 + 동일한 API)
schema.sql          Postgres 스키마(앱이 첫 요청 시 자동 생성하며, 수동 실행용 참고 파일)
docs/               운영 문서(관리자 복구 등)
```

## 로컬 실행

Node.js 22 이상이 필요하다(로컬 SQLite에 내장 `node:sqlite` 사용).

```bash
npm install
cp .env.example .env   # 값 채우기
npm start              # http://localhost:3000
```

`DATABASE_URL`을 비워두면 로컬에서는 `.data/app.sqlite`(git 제외)를 자동으로 사용한다.

## 환경변수

실제 값은 `.env`(로컬) 또는 Vercel 프로젝트 환경변수(배포)에만 둔다. 이름과 설명은 [.env.example](.env.example) 참고.

| 이름 | 설명 |
| --- | --- |
| `OPENAI_API_KEY` | AI 업무 추출(`/api/parse-tasks`)용 OpenAI API 키 |
| `OPENAI_MODEL` | 사용할 모델(기본 `gpt-5-nano`) |
| `DATABASE_URL` (또는 `POSTGRES_URL`) | Postgres 접속 문자열. 배포에서 비어 있으면 로그인·저장 API가 503 |
| `ADMIN_INVITE_CODE` | 최초 관리자 1명 가입용 비공개 초대 코드 |
| `SQLITE_PATH` | (선택, 로컬 테스트용) SQLite 파일 경로 |

## 배포

- Vercel 프로젝트 `adhd-planner`에 배포한다.
- `public/`은 정적 파일로, `api/` 아래 파일은 각각 서버리스 함수로 배포된다(별도 빌드 단계 없음).
- 배포 환경에서는 Postgres(`DATABASE_URL`)를 사용하고, 로컬 SQLite는 사용하지 않는다.
