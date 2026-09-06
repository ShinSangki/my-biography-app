// Gemini STT: backend/src/services/geminiSTTService.ts 의 transcribeAudioFromFile 이식본.
// (파일 업로드 → ACTIVE 대기 → generateContent 전사 → 파일 삭제)
// 실험 하네스를 self-contained 하게 유지하기 위해 프롬프트를 그대로 복제했다.

import { GoogleGenAI, createPartFromUri, createUserContent } from "@google/genai";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const STT_PROMPT = `
너는 한국어 음성 전사 도우미다.
다음 오디오 파일을 듣고 아래 규칙으로 전사해라.

규칙:
1. 들리는 내용을 최대한 정확하게 한국어 문장으로 전사한다.
2. 불필요한 해설은 쓰지 않는다.
3. 추측해서 내용을 만들어내지 않는다.
4. 알아듣기 어려운 부분은 [불명확] 으로 표기한다.
5. 결과는 순수 전사 텍스트만 출력한다.
`.trim();

export function makeSTT(apiKey, model = "gemini-2.5-flash") {
  const ai = new GoogleGenAI({ apiKey });

  async function waitActive(name, maxWaitMs = 40000) {
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
      const f = await ai.files.get({ name });
      const state = String(f.state ?? "");
      if (state === "ACTIVE") return f;
      if (state === "FAILED") throw new Error("Gemini 파일 처리 실패");
      await sleep(2000);
    }
    throw new Error("파일 ACTIVE 대기 시간 초과");
  }

  async function transcribe(wavPath, retries = 6) {
    for (let attempt = 0; attempt <= retries; attempt++) {
      let uploaded;
      try {
        uploaded = await ai.files.upload({ file: wavPath, config: { mimeType: "audio/wav" } });
        if (!uploaded.name) throw new Error("업로드 name 없음");
        const active = await waitActive(uploaded.name);
        if (!active.uri || !active.mimeType) throw new Error("업로드 uri/mimeType 없음");

        const res = await ai.models.generateContent({
          model,
          contents: createUserContent([createPartFromUri(active.uri, active.mimeType), STT_PROMPT]),
          config: { thinkingConfig: { thinkingBudget: 0 } },
        });
        const text = res.text?.trim();
        if (!text) throw new Error("STT 결과 비어 있음");
        return text;
      } catch (err) {
        const msg = String(err?.message || err);
        if (attempt === retries) throw err;
        const hint = /retry in ([\d.]+)s/i.exec(msg);
        const wait = hint
          ? Math.ceil(parseFloat(hint[1]) * 1000) + 2000
          : /429|quota|RESOURCE_EXHAUSTED/i.test(msg)
          ? 60000
          : 4000 * (attempt + 1);
        process.stdout.write(`  (STT 재시도 ${attempt + 1}: ${msg.slice(0, 60)} — ${Math.round(wait / 1000)}s)\n`);
        await sleep(wait);
      } finally {
        try {
          if (uploaded?.name) await ai.files.delete({ name: uploaded.name });
        } catch {
          /* 무시 */
        }
      }
    }
  }

  return { transcribe };
}
