import { GoogleGenAI } from "@google/genai";
import { env } from "../config/env.js";

const generateAi = new GoogleGenAI({
  apiKey: env.geminiGenerateApiKey,
});

export interface GeneratedMemoir {
  title: string;
  time: string;
  location: string;
  memoir: string;
}

export async function generateMemoirText(rawText: string): Promise<GeneratedMemoir> {
  const prompt = `
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

  const response = await generateAi.models.generateContent({
    model: env.geminiGenerateModel,
    contents: prompt,
    config: {
      responseMimeType: "application/json",
      thinkingConfig: {
        thinkingBudget: 0,
      },
    },
  });

  const responseText = response.text?.trim();

  console.log("[GENERATE] response text:", responseText);

  if (!responseText) {
    throw new Error("자서전 생성 결과가 비어 있습니다.");
  }

  try {
    const parsed = JSON.parse(responseText) as GeneratedMemoir;
    return parsed;
  } catch (error) {
    console.error("JSON 파싱 오류:", error);
    throw new Error("자서전 생성 결과를 JSON으로 변환하는 데 실패했습니다.");
  }
}