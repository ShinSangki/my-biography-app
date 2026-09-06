// 논문 III장 "제안 파이프라인"을 실험용으로 이식한 것.
// 원본: backend/src/services/{geminiGenerateCleanService,contextExtractionService,selectiveCorrectionService}.ts
// (POST /generate-v2 가 호출하는 코드). 실험 하네스를 self-contained 하게 유지하기 위해
// 프롬프트를 그대로 복제했다. 원본 서비스 프롬프트를 고치면 여기도 맞춰 고쳐야 한다.

// ③ 문체 정리 (시간·장소 추출 안 함)
const CLEAN_PROMPT = (rawText) => `
너는 자서전 초안 작성 도우미다.
아래 구술 텍스트를 다듬어, 주어진 JSON 형식으로 결과를 출력해라.
시간이나 장소를 추출하는 작업은 절대 하지 마라 (다른 절차에서 별도로 처리한다).

절대 지켜야 할 규칙:
1. 원문의 길이나 내용을 임의로 늘리거나 부풀리지 마라.
2. '삶의 흔적', '순간입니다' 등 오글거리는 문학적 표현, 비유, 감정 묘사를 절대 지어내어 덧붙이지 마라.
3. '어', '그', '저기' 같은 의미 없는 추임새만 제거하고, 사용자가 말한 사실과 문장 톤을 최대한 건조하고 담백하게 그대로 유지해라(memoir).
4. 내용에 어울리는 간결한 제목(title)을 지어준다.
5. 반드시 JSON 형식으로만 출력하고 다른 설명이나 마크다운 백틱 문법(\`\`\`json)은 생략한다.

출력 형식:
{
  "title": "제목",
  "memoir": "자서전 본문"
}

원문:
${rawText}
`.trim();

// ③ 시간·장소만 추출
const EXTRACT_PROMPT = (text) => `
너는 텍스트에서 시간과 장소 정보만 뽑아내는 추출기다.
다른 설명, 요약, 문체 수정은 절대 하지 마라.

규칙:
1. 텍스트 내용 중 핵심이 되는 시기(time)와 장소(location)를 추출한다.
2. 명확하지 않으면 "알 수 없음"으로 적는다.
3. 절대로 텍스트에 없는 내용을 추측해서 만들어내지 마라.
4. 반드시 JSON 형식으로만 출력하고 다른 설명이나 마크다운 백틱(\`\`\`json)은 생략한다.

출력 형식:
{
  "time": "시간",
  "location": "장소"
}

텍스트:
${text}
`.trim();

// ⑤ 불일치 구간 선택적 보정
const RECONCILE_PROMPT = (rawText, cleanedMemoir, a, b) => `
너는 두 개의 서로 다른 시간/장소 추출 결과 중 더 신뢰할 수 있는 값을 판단하는 검증기다.

상황 설명:
- "원문"은 음성인식(STT)으로 변환된 텍스트라서 오류(오인식, 단어 누락, 발음 왜곡)가 섞여 있을 수 있다.
- "정리문"은 원문을 바탕으로 문체를 다듬은 결과다. 정리 과정에서 원문의 모호함이 보정될 수도 있고, 반대로 잘못 다듬어졌을 수도 있다.
- 후보 A는 원문에서, 후보 B는 정리문에서 각각 독립적으로 추출한 시간/장소다. 두 값이 서로 다르다.

너의 임무: 원문과 정리문의 전체 맥락을 함께 참고하여, 어느 후보가 더 신뢰할 수 있는지, 혹은 둘 다 아닌 제3의 값이 맞는지 판단해라.
불확실하면 "알 수 없음"으로 적어라. 절대로 근거 없이 새 정보를 만들어내지 마라.

반드시 JSON 형식으로만 출력하고 다른 설명이나 마크다운 백틱은 생략한다.
출력 형식:
{
  "time": "최종 판단한 시간",
  "location": "최종 판단한 장소",
  "reason": "간단한 판단 근거 (한 문장)"
}

원문:
${rawText}

정리문:
${cleanedMemoir}

후보 A (원문 기반): time="${a.time}", location="${a.location}"
후보 B (정리문 기반): time="${b.time}", location="${b.location}"
`.trim();

function normalize(v) {
  return String(v ?? "").trim().replace(/\s+/g, "").toLowerCase();
}
function isMismatch(a, b) {
  return normalize(a.time) !== normalize(b.time) || normalize(a.location) !== normalize(b.location);
}

/**
 * Ablation 조건: 구조 분리만 (③), 선택적 보정(⑤) 없음.
 * 시간·장소를 전용 프롬프트로 원문에서 별도 추출하고, 문체 정리는 분리 수행.
 * 두 추출 후보 비교·재보정을 하지 않으므로 정리문 재추출(2번째 후보)도 생략 → 호출 2회.
 */
export async function runSeparationOnly(rawText, gen) {
  const [cand, cleaned] = await Promise.all([
    gen.generateJSON(EXTRACT_PROMPT(rawText)),
    gen.generateJSON(CLEAN_PROMPT(rawText)),
  ]);
  return {
    title: cleaned.title,
    memoir: cleaned.memoir,
    time: cand.time,
    location: cand.location,
    corrected: false,
    reason: null,
    candidates: { fromRaw: cand, fromClean: null },
  };
}

/**
 * @param {string} rawText  STT(노이즈 주입) 텍스트
 * @param {{generateJSON: (p:string)=>Promise<any>}} gen
 * @returns {{title,memoir,time,location,corrected,reason,candidates}}
 */
export async function runProposed(rawText, gen) {
  // ③ 원문 기반 추출 + 문체 정리 병렬
  const [candidateFromRaw, cleaned] = await Promise.all([
    gen.generateJSON(EXTRACT_PROMPT(rawText)),
    gen.generateJSON(CLEAN_PROMPT(rawText)),
  ]);

  // 정리문에서 재추출 (두 번째 후보)
  const candidateFromClean = await gen.generateJSON(EXTRACT_PROMPT(cleaned.memoir));

  // ④ 불일치 탐지
  if (!isMismatch(candidateFromRaw, candidateFromClean)) {
    return {
      title: cleaned.title,
      memoir: cleaned.memoir,
      time: candidateFromRaw.time,
      location: candidateFromRaw.location,
      corrected: false,
      reason: null,
      candidates: { fromRaw: candidateFromRaw, fromClean: candidateFromClean },
    };
  }

  // ⑤ 불일치 시에만 선택적 보정
  const reconciled = await gen.generateJSON(
    RECONCILE_PROMPT(rawText, cleaned.memoir, candidateFromRaw, candidateFromClean)
  );

  return {
    title: cleaned.title,
    memoir: cleaned.memoir,
    time: reconciled.time,
    location: reconciled.location,
    corrected: true,
    reason: reconciled.reason ?? null,
    candidates: { fromRaw: candidateFromRaw, fromClean: candidateFromClean },
  };
}
