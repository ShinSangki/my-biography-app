import { GoogleGenAI } from "@google/genai";
import { env } from "../config/env.js";

// 논문 III장 제안 파이프라인 ③단계: 문체 정리는 시간·장소 추출과 분리된 별도 호출로 수행한다.
// 기존 geminiGENERATEService.ts(generateMemoirText, 기준 방식/baseline)는 그대로 유지하고
// 건드리지 않는다 — 실험에서 baseline과 proposed를 동시에 비교해야 하기 때문.

const generateAi = new GoogleGenAI({
  apiKey: env.geminiGenerateApiKey,
});

export interface CleanedMemoir {
  title: string;
  memoir: string;
}

/**
 * STT 원문을 문체만 정리한다. 시간/장소 추출은 하지 않는다(별도 서비스인
 * contextExtractionService.extractTimeLocation 에서 독립적으로 수행).
 */
export async function cleanMemoirText(rawText: string): Promise<CleanedMemoir> {
  const prompt = `
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

  const response = await generateAi.models.generateContent({
    model: env.geminiGenerateModel,
    contents: prompt,
    config: {
      responseMimeType: "application/json",
      thinkingConfig: { thinkingBudget: 0 },
    },
  });

  const responseText = response.text?.trim();
  console.log("[GENERATE-CLEAN] response text:", responseText);

  if (!responseText) {
    throw new Error("자서전 정리 결과가 비어 있습니다.");
  }

  try {
    return JSON.parse(responseText) as CleanedMemoir;
  } catch (error) {
    console.error("[GENERATE-CLEAN] JSON 파싱 오류:", error);
    throw new Error("자서전 정리 결과를 JSON으로 변환하는 데 실패했습니다.");
  }
}
