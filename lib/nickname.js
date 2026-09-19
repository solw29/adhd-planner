// 닉네임 검증 — 클라이언트(public/index.html에 동일 로직을 그대로 옮겨 둠)와 서버가 항상 같은
// 규칙을 쓴다. 클라이언트 쪽 검증은 UX용(빠른 피드백)이고, 실제 신뢰 경계는 항상 이 파일이다.
'use strict';

// 앞뒤 공백 제거 + Unicode NFC 정규화(자모가 분리된 한글 입력 등을 하나로 합침) 후 검증한다.
const NICK_RE = /^[A-Za-z0-9_가-힣ㄱ-ㅣ]{2,20}$/;

function normalizeNickname(raw) {
  if (typeof raw !== 'string') return '';
  return raw.trim().normalize('NFC');
}

// 영문 대소문자를 구분하지 않는 중복 검사 키. 한글은 대소문자 개념이 없어 toLowerCase()가
// 영향을 주지 않는다.
function nicknameKeyOf(normalized) {
  return normalized.toLowerCase();
}

/**
 * @returns {{ok:true, nickname:string, nicknameKey:string} | {ok:false, error:string}}
 */
function validateNickname(raw) {
  const nickname = normalizeNickname(raw);
  if (!nickname) return { ok: false, error: '닉네임을 입력해주세요.' };
  if (!NICK_RE.test(nickname)) {
    return { ok: false, error: '닉네임은 한글·영문·숫자·밑줄(_)만 사용해 2~20자로 입력해주세요.' };
  }
  return { ok: true, nickname, nicknameKey: nicknameKeyOf(nickname) };
}

module.exports = { NICK_RE, normalizeNickname, nicknameKeyOf, validateNickname };
