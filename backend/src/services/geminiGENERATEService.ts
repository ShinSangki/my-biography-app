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

규칙:
1. 원문의 의미와 사실을 엄격하게 유지하며 자연스러운 1인칭 서술문으로 다듬어라(memoir).
2. 원문에 없는 감정, 생각, 사실, 과도한 문학적 표현(비약)을 절대 임의로 지어내거나 덧붙이지 마라.
3. 불필요한 구어체나 더듬거림만 정리하고, 본래 말한 내용만 그대로 전달해라.
4. 내용 중 핵심이 되는 시간(time)과 장소(location)를 추출한다. 명확하지 않으면 "알 수 없음"으로 적는다.
5. 전체 내용을 아우르는 적절한 제목(title)을 지어준다.
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