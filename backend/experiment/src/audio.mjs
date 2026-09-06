// 합성 음성에 현실적인 열화를 가해 실제 STT 오류를 유도한다.
// 오류율을 직접 통제하는 대신(합성 노이즈 방식) 음향 조건을 단계화하고,
// 그 결과 나온 실측 WER 로 사후 분류한다.

import fs from "node:fs";
import { execFileSync } from "node:child_process";

const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";

// 조건별 ffmpeg 오디오 필터. amix 가중치로 잡음 세기를 조절한다.
// Gemini STT 가 경미한 열화에는 강건하므로, 유의미한 실측 WER 분포를 얻으려면
// 상당히 공격적으로 열화시켜야 한다.
export const CONDITIONS = {
  clean: null,
  // 실내 소음 + 저가 마이크 (전화 대역)
  noisy_mild: {
    filter:
      "[0:a]highpass=f=300,lowpass=f=3400,volume=1.0[s];[1:a]volume=0.35[n];[s][n]amix=inputs=2:duration=first:dropout_transition=0",
    noise: "anoisesrc=d=180:c=pink:a=1",
  },
  // 강한 배경 소음 + 빠른/뭉개진 발화 (고령자 구술 + 현장 소음)
  noisy_harsh: {
    filter:
      "[0:a]highpass=f=350,lowpass=f=3000,atempo=1.15,volume=1.0[s];[1:a]volume=0.8[n];[s][n]amix=inputs=2:duration=first:dropout_transition=0,acompressor=threshold=-16dB:ratio=4",
    noise: "anoisesrc=d=180:c=pink:a=1",
  },
  // 극단: 저비트 왜곡 + 심한 소음 + 대역 축소 (열악한 원거리 녹음)
  extreme: {
    filter:
      "[0:a]highpass=f=400,lowpass=f=2800,atempo=1.2,acrusher=bits=6:mode=log,volume=1.0[s];[1:a]volume=1.4[n];[s][n]amix=inputs=2:duration=first:dropout_transition=0",
    noise: "anoisesrc=d=180:c=brown:a=1",
  },
};

export function degrade(inWav, outWav, condition) {
  const spec = CONDITIONS[condition];
  if (spec === undefined) throw new Error(`알 수 없는 조건: ${condition}`);

  if (spec === null) {
    fs.copyFileSync(inWav, outWav);
    return outWav;
  }

  execFileSync(
    FFMPEG,
    [
      "-y",
      "-i", inWav,
      "-f", "lavfi", "-i", spec.noise,
      "-filter_complex", spec.filter,
      "-ar", "16000", "-ac", "1",
      outWav,
    ],
    { stdio: "ignore" }
  );
  return outWav;
}
