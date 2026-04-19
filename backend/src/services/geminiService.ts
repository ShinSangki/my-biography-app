import {
  GoogleGenAI,
  createPartFromUri,
  createUserContent,
} from "@google/genai";
import fs from "node:fs";
import { env } from "../config/env.js";
import { convertWebmToWav } from "../utils/audioUtils.js";

const ai = new GoogleGenAI({
  apiKey: env.geminiApiKey,
});

async function waitForFileActive(fileName: string, maxWaitMs = 30000) {
  const start = Date.now();

  while (Date.now() - start < maxWaitMs) {
    const file = await ai.files.get({ name: fileName });
    const state = String(file.state ?? "");

    console.log("[Gemini file state]", state);

    if (state === "ACTIVE") {
      return file;
    }

    if (state === "FAILED") {
      throw new Error("Gemini 파일 처리에 실패했습니다.");
    }

    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  throw new Error("Gemini 파일이 ACTIVE 상태가 되기 전에 시간 초과되었습니다.");
}

export async function transcribeAudioFromFile(filePath: string): Promise<string> {
  const wavPath = await convertWebmToWav(filePath);

  console.log("[STT] original file:", filePath);
  console.log("[STT] converted wav:", wavPath);

  const uploadedFile = await ai.files.upload({
    file: wavPath,
    config: {
      mimeType: "audio/wav",
    },
  });

  try {
    if (!uploadedFile.name) {
      throw new Error("업로드된 파일 name 정보가 없습니다.");
    }

    const activeFile = await waitForFileActive(uploadedFile.name);

    if (!activeFile.uri || !activeFile.mimeType) {
      throw new Error("업로드된 파일의 uri 또는 mimeType 정보를 받지 못했습니다.");
    }

    const prompt = `
너는 한국어 음성 전사 도우미다.
다음 오디오 파일을 듣고 아래 규칙으로 전사해라.

규칙:
1. 들리는 내용을 최대한 정확하게 한국어 문장으로 전사한다.
2. 불필요한 해설은 쓰지 않는다.
3. 추측해서 내용을 만들어내지 않는다.
4. 알아듣기 어려운 부분은 [불명확] 으로 표기한다.
5. 결과는 순수 전사 텍스트만 출력한다.
`.trim();

    const response = await ai.models.generateContent({
      model: env.geminiSttModel,
      contents: createUserContent([
        createPartFromUri(activeFile.uri, activeFile.mimeType),
        prompt,
      ]),
      config: {
        thinkingConfig: {
          thinkingBudget: 0,
        },
      },
    });

    const text = response.text?.trim();

    console.log("[STT] response text:", text);

    if (!text) {
      throw new Error("STT 결과가 비어 있습니다.");
    }

    return text;
  } finally {
    try {
      if (uploadedFile.name) {
        await ai.files.delete({ name: uploadedFile.name });
      }
    } catch {
      // 무시
    }

    try {
      if (fs.existsSync(wavPath)) {
        fs.unlinkSync(wavPath);
      }
    } catch {
      // 무시
    }
  }
}

export async function generateMemoirText(rawText: string): Promise<string> {
  const prompt = `
너는 자서전 초안 작성 도우미다.
아래 구술 텍스트를 자서전 문체의 자연스러운 1인칭 서술문으로 정리해라.

규칙:
1. 원문 의미를 유지한다.
2. 사실을 새로 지어내지 않는다.
3. 지나치게 문학적으로 과장하지 않는다.
4. 문장을 매끄럽게 다듬되 핵심 내용은 보존한다.
5. 결과는 한국어 본문만 출력한다.
6. 제목, 설명, 머리말 없이 본문만 출력한다.

원문:
${rawText}
`.trim();

  const response = await ai.models.generateContent({
    model: env.geminiGenerateModel,
    contents: prompt,
    config: {
      thinkingConfig: {
        thinkingBudget: 0,
      },
    },
  });

  const memoir = response.text?.trim();

  console.log("[GENERATE] response text:", memoir);

  if (!memoir) {
    throw new Error("자서전 생성 결과가 비어 있습니다.");
  }

  return memoir;
}