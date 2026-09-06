// Gemini generateContent 래퍼: JSON 응답 + 429 재시도("retry in Xs" 힌트 파싱).
// runPhase2 / proposedPipeline 공용.

import { GoogleGenAI } from "@google/genai";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function retryDelayFromError(msg, fallback) {
  const m = String(msg).match(/retry in ([\d.]+)s/i);
  if (m) return Math.ceil(parseFloat(m[1]) * 1000) + 2000;
  return fallback;
}

export function makeGenerator(apiKey, model = "gemini-2.5-flash", { onRetry } = {}) {
  const ai = new GoogleGenAI({ apiKey });

  async function generateJSON(prompt, retries = 8) {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await ai.models.generateContent({
          model,
          contents: prompt,
          config: { responseMimeType: "application/json", thinkingConfig: { thinkingBudget: 0 } },
        });
        const t = res.text?.trim();
        if (!t) throw new Error("빈 응답");
        return JSON.parse(t);
      } catch (err) {
        const msg = String(err?.message || err);
        if (attempt === retries) throw err;
        const isQuota = /429|quota|rate|RESOURCE_EXHAUSTED/i.test(msg);
        const wait = isQuota ? retryDelayFromError(msg, 60000) : 4000 * (attempt + 1);
        onRetry?.(attempt + 1, msg, wait);
        await sleep(wait);
      }
    }
  }

  return { model, generateJSON };
}
