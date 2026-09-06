import { GoogleGenAI } from "@google/genai";
import { env } from "../config/env.js";

// 논문 III장 "제안 파이프라인" 중 ③④단계 구현:
// 시간·장소 추출을 문체 정리(cleanMemoirText)와 분리된 별도 호출로 수행하고,
// 서로 다른 소스(원문 STT / 정리된 문장)에서 각각 추출한 결과를 나중에 대조한다.

const extractAi = new GoogleGenAI({
  apiKey: env.geminiGenerateApiKey,
});

export interface TimeLocation {
  time: string;
  location: string;
}

/**
 * 주어진 텍스트에서 시간·장소만 추출한다. 문체 정리나 요약은 하지 않는다.
 * rawText(STT 원문)와 cleanedMemoir(정리된 문장) 양쪽에 동일하게 사용해서
 * 두 소스가 서로 다른 값을 내놓는지 비교하기 위한 용도.
 */
export async function extractTimeLocation(text: string): Promise<TimeLocation> {
  const prompt = `
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

  const response = await extractAi.models.generateContent({
    model: env.geminiGenerateModel,
    contents: prompt,
    config: {
      responseMimeType: "application/json",
      thinkingConfig: { thinkingBudget: 0 },
    },
  });

  const responseText = response.text?.trim();
  console.log("[EXTRACT] response text:", responseText);

  if (!responseText) {
    throw new Error("시간/장소 추출 결과가 비어 있습니다.");
  }

  try {
    return JSON.parse(responseText) as TimeLocation;
  } catch (error) {
    console.error("[EXTRACT] JSON 파싱 오류:", error);
    throw new Error("시간/장소 추출 결과를 JSON으로 변환하는 데 실패했습니다.");
  }
}

export interface ReconciledTimeLocation extends TimeLocation {
  reason: string;
}

/**
 * 원문(raw)에서 추출한 값과 정리된 문장(clean)에서 추출한 값이 서로 다를 때만 호출되는
 * 선택적 보정 단계. 두 후보와 원문·정리문을 함께 제공해 더 신뢰할 수 있는 값을 재판단한다.
 */
export async function reconcileTimeLocation(
  rawText: string,
  cleanedMemoir: string,
  candidateFromRaw: TimeLocation,
  candidateFromClean: TimeLocation
): Promise<ReconciledTimeLocation> {
  const prompt = `
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

후보 A (원문 기반): time="${candidateFromRaw.time}", location="${candidateFromRaw.location}"
후보 B (정리문 기반): time="${candidateFromClean.time}", location="${candidateFromClean.location}"
`.trim();

  const response = await extractAi.models.generateContent({
    model: env.geminiGenerateModel,
    contents: prompt,
    config: {
      responseMimeType: "application/json",
      thinkingConfig: { thinkingBudget: 0 },
    },
  });

  const responseText = response.text?.trim();
  console.log("[RECONCILE] response text:", responseText);

  if (!responseText) {
    throw new Error("시간/장소 보정 결과가 비어 있습니다.");
  }

  try {
    return JSON.parse(responseText) as ReconciledTimeLocation;
  } catch (error) {
    console.error("[RECONCILE] JSON 파싱 오류:", error);
    throw new Error("시간/장소 보정 결과를 JSON으로 변환하는 데 실패했습니다.");
  }
}
