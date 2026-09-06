// 기준 방식(현재 앱): 단일 LLM 호출로 문체 정리 + 시간·장소 추출 + 제목 생성.
// 원본: backend/src/services/geminiGENERATEService.ts 의 generateMemoirText.
// runPhase1.mjs 는 자체 복제본을 쓰고(초기 커밋 재현성 유지), 이후 하네스는 이 모듈을 공용으로 쓴다.

const PROMPT = (rawText) => `
너는 자서전 초안 작성 도우미다.
아래 구술 텍스트를 분석하여, 주어진 JSON 형식으로 결과를 출력해라.

절대 지켜야 할 규칙:
1. 원문의 길이나 내용을 임의로 늘리거나 부풀리지 마라.
2. '삶의 흔적', '순간입니다' 등 오글거리는 문학적 표현, 비유, 감정 묘사를 절대 지어내어 덧붙이지 마라.
3. '어', '그', '저기' 같은 의미 없는 추임새만 제거하고, 사용자가 말한 사실과 문장 톤을 최대한 건조하고 담백하게 그대로 유지해라(memoir).
4. 내용 중 핵심이 되는 시기나 시간(time)과 장소(location)를 추출하되, 명확하지 않으면 "알 수 없음"으로 적는다.
5. 내용에 어울리는 간결한 제목(title)을 지어준다.
6. 반드시 JSON 형식으로만 출력하고 다른 설명이나 마크다운 백틱 문법(\`\`\`json)은 생략한다.

출력 형식:
{
  "title": "제목",
  "time": "시간",
  "location": "장소",
  "memoir": "자서전 본문"
}

원문:
${rawText}
`.trim();

export function makeBaseline(gen) {
  return {
    async run(rawText) {
      return gen.generateJSON(PROMPT(rawText));
    },
  };
}
