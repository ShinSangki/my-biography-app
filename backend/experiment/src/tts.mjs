// Gemini TTS: 생애사 클린 텍스트를 합성 음성(wav)으로 만든다.
// 실제 STT 엔진 오류로 생태적 타당도를 보완하기 위한 입력 생성 단계.
// 출력: 24kHz mono wav (Gemini TTS 는 L16 PCM 을 주므로 ffmpeg 로 wav 헤더만 붙인다).

import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { GoogleGenAI } from "@google/genai";

const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
// 화자 다양성: 샘플마다 목소리를 바꿔 단일 화자 편향을 줄인다.
const VOICES = ["Kore", "Puck", "Charon", "Fenrir", "Aoede", "Leda"];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function makeTTS(apiKey, model = "gemini-2.5-flash-preview-tts") {
  const ai = new GoogleGenAI({ apiKey });

  async function synthesize(text, outWavPath, { voiceIndex = 0, retries = 6 } = {}) {
    if (fs.existsSync(outWavPath) && fs.statSync(outWavPath).size > 1000) return outWavPath;
    const voice = VOICES[voiceIndex % VOICES.length];

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const r = await ai.models.generateContent({
          model,
          contents: `다음 문장을 자연스러운 한국어로 또박또박 읽어줘: ${text}`,
          config: {
            responseModalities: ["AUDIO"],
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
          },
        });
        const inline = r.candidates?.[0]?.content?.parts?.find((p) => p.inlineData)?.inlineData;
        if (!inline?.data) throw new Error("TTS 응답에 오디오가 없음");

        const pcm = Buffer.from(inline.data, "base64");
        const rate = Number(/rate=(\d+)/.exec(inline.mimeType || "")?.[1] || 24000);
        const tmpPcm = outWavPath + ".pcm";
        fs.writeFileSync(tmpPcm, pcm);
        execFileSync(FFMPEG, ["-y", "-f", "s16le", "-ar", String(rate), "-ac", "1", "-i", tmpPcm, outWavPath], {
          stdio: "ignore",
        });
        fs.unlinkSync(tmpPcm);
        return outWavPath;
      } catch (err) {
        const msg = String(err?.message || err);
        if (attempt === retries) throw err;
        const hint = /retry in ([\d.]+)s/i.exec(msg);
        const wait = hint ? Math.ceil(parseFloat(hint[1]) * 1000) + 2000 : /429|quota|RESOURCE_EXHAUSTED/i.test(msg) ? 60000 : 4000 * (attempt + 1);
        process.stdout.write(`  (TTS 재시도 ${attempt + 1}: ${msg.slice(0, 60)} — ${Math.round(wait / 1000)}s)\n`);
        await sleep(wait);
      }
    }
  }

  return { synthesize, voiceCount: VOICES.length };
}
