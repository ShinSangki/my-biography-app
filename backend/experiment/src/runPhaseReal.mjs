// ============================================================================
// 생태적 타당도 보완: 합성 노이즈 대신 실제 STT 엔진 오류로 검증.
//
// 각 생애사 클린 텍스트 → Gemini TTS 합성 음성 → 음향 조건별 열화(ffmpeg)
//   → 실제 Gemini STT 전사 → 실측 WER 측정 → baseline / 제안 방식 생성 → 지표
//
// 오류율을 직접 통제하지 않고, 나온 실측 WER 로 사후 분류하여
// 합성 노이즈 실험(phase1/2)의 결론이 실제 STT 오류에도 유지되는지 본다.
//
// 설정(환경변수):
//   EXP_REAL_SAMPLES   앞에서부터 N개 샘플만 (기본 12)
//   EXP_REAL_CONDITIONS 쉼표구분 (기본 clean,noisy_mild,telephone,noisy_harsh)
//   EXP_THROTTLE_MS    호출 간 간격 (기본 1500)
// ============================================================================

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

import { wer } from "./noiseInjector.mjs";
import { entityScore, eventOrderAccuracy, makeEmbedder } from "./metrics.mjs";
import { makeGenerator } from "./llm.mjs";
import { makeBaseline } from "./baseline.mjs";
import { runProposed } from "./proposedPipeline.mjs";
import { makeTTS } from "./tts.mjs";
import { makeSTT } from "./stt.mjs";
import { degrade, CONDITIONS } from "./audio.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
dotenv.config({ path: path.resolve(ROOT, "../.env") });

const API_KEY = process.env.GEMINI_GENERATE_API_KEY;
const GEN_MODEL = process.env.GEMINI_GENERATE_MODEL ?? "gemini-2.5-flash";
if (!API_KEY) throw new Error("GEMINI_GENERATE_API_KEY 없음 (backend/.env)");

const N = Number(process.env.EXP_REAL_SAMPLES ?? 12);
const CONDS = (process.env.EXP_REAL_CONDITIONS ?? "clean,noisy_mild,telephone,noisy_harsh")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
for (const c of CONDS) if (!(c in CONDITIONS)) throw new Error(`알 수 없는 조건: ${c}`);
const THROTTLE_MS = Number(process.env.EXP_THROTTLE_MS ?? 1500);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const gen = makeGenerator(API_KEY, GEN_MODEL, {
  onRetry: (n, m, w) => process.stdout.write(`  (gen 재시도 ${n}: ${String(m).slice(0, 55)} — ${Math.round(w / 1000)}s)\n`),
});
const baseline = makeBaseline(gen);
const embedder = makeEmbedder(API_KEY);
const tts = makeTTS(API_KEY);
const stt = makeSTT(API_KEY, process.env.GEMINI_STT_MODEL ?? "gemini-2.5-flash");

// STT 는 "열여덟 살"을 "18살"로 정규화해 내놓는데, 이는 인식 오류가 아니라 표기 차이다.
// WER/CER 이 이런 표기 차이로 부풀지 않도록, 데이터셋에 등장하는 수사(數詞)를 숫자로 통일한다.
const NUM_WORDS = [
  ["스물다섯", "25"], ["스물한", "21"], ["열여덟", "18"], ["열일곱", "17"], ["열여섯", "16"],
  ["열다섯", "15"], ["열넷", "14"], ["예순", "60"], ["마흔", "40"], ["서른", "30"], ["스물", "20"],
  ["아홉", "9"], ["여덟", "8"], ["일곱", "7"], ["여섯", "6"], ["다섯", "5"],
];
function normNums(s) {
  let t = String(s);
  for (const [w, d] of NUM_WORDS) t = t.split(w).join(d);
  return t;
}

// 문자 오류율 (한국어: 수사 통일 + 공백/문장부호 제거 후 편집거리 / 참조 길이)
function cer(ref, hyp) {
  const clean = (s) => normNums(String(s)).replace(/[\s.,!?~"'()[\]{}·…\-–—:;]/g, "");
  const a = [...clean(ref)];
  const b = [...clean(hyp)];
  const m = a.length, n = b.length;
  if (!m) return 0;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...new Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[m][n] / m;
}

const mean = (arr) => {
  const v = arr.filter((x) => x != null && !Number.isNaN(x));
  return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null;
};
const f = (x, d = 3) => (x == null ? "—" : Number(x).toFixed(d));

async function metricsFor(sample, out) {
  const ent = entityScore(sample.gold, { time: out.time, location: out.location });
  const ord = eventOrderAccuracy(out.memoir || "", sample.events);
  let sim = null;
  try {
    sim = await embedder.similarity(sample.text, out.memoir || "");
  } catch {
    /* skip */
  }
  return {
    entity_time: ent.time,
    entity_location: ent.location,
    entity_mean: ent.mean,
    event_order_accuracy: ord.accuracy,
    semantic_similarity: sim,
  };
}

async function main() {
  const { samples } = JSON.parse(fs.readFileSync(path.resolve(ROOT, "dataset/samples.json"), "utf-8"));
  const subset = samples.slice(0, N);
  const outDir = path.resolve(ROOT, "results");
  const audioDir = path.resolve(ROOT, "audio");
  fs.mkdirSync(outDir, { recursive: true });
  fs.mkdirSync(audioDir, { recursive: true });

  const partialFile = path.resolve(outDir, "real_raw_partial.json");
  const resume = process.argv.includes("--resume");
  let rows = [];
  const doneKeys = new Set();
  if (resume && fs.existsSync(partialFile)) {
    try {
      rows = JSON.parse(fs.readFileSync(partialFile, "utf-8")).rows || [];
      for (const r of rows) if (r.sttText != null) doneKeys.add(`${r.sampleId}|${r.condition}`);
      console.log(`[resume] 기존 ${doneKeys.size}개 케이스 건너뜀`);
    } catch {
      rows = [];
    }
  }
  const savePartial = () =>
    fs.writeFileSync(partialFile, JSON.stringify({ model: GEN_MODEL, conditions: CONDS, rows }, null, 2));

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const total = subset.length * CONDS.length;
  let done = 0;

  console.log(`\n=== 생태적 타당도: 실제 TTS→STT 파이프라인 ===`);
  console.log(`샘플 ${subset.length}편 × 음향조건 [${CONDS.join(", ")}] = ${total} 케이스\n`);

  for (let si = 0; si < subset.length; si++) {
    const s = subset[si];
    const baseWav = path.join(audioDir, `${s.id}.wav`);
    try {
      await tts.synthesize(s.text, baseWav, { voiceIndex: si });
    } catch (e) {
      console.log(`[${s.id}] TTS 실패, 스킵: ${String(e.message).slice(0, 80)}`);
      done += CONDS.length;
      continue;
    }
    await sleep(THROTTLE_MS);

    for (const cond of CONDS) {
      done++;
      if (doneKeys.has(`${s.id}|${cond}`)) continue;

      const condWav = path.join(audioDir, `${s.id}__${cond}.wav`);
      try {
        degrade(baseWav, condWav, cond);
      } catch (e) {
        process.stdout.write(`[${done}/${total}] ${s.id}/${cond} ffmpeg 실패: ${String(e.message).slice(0, 60)}\n`);
        continue;
      }

      process.stdout.write(`[${done}/${total}] ${s.id}/${cond} STT... `);
      let sttText, err = null;
      try {
        sttText = await stt.transcribe(condWav);
      } catch (e) {
        err = String(e?.message || e);
        process.stdout.write(`STT 실패: ${err.slice(0, 60)}\n`);
      }

      let werVal = null, cerVal = null, baseRow = null, propRow = null;
      if (sttText != null) {
        werVal = wer(normNums(s.text), normNums(sttText));
        cerVal = cer(s.text, sttText);
        process.stdout.write(`WER ${(werVal * 100).toFixed(1)}% CER ${(cerVal * 100).toFixed(1)}% | `);
        await sleep(THROTTLE_MS);

        try {
          const b = await baseline.run(sttText);
          baseRow = { time: b.time, location: b.location, memoir: b.memoir, title: b.title, metrics: await metricsFor(s, b) };
          await sleep(THROTTLE_MS);
        } catch (e) {
          process.stdout.write(`baseline 실패 `);
        }
        try {
          const pr = await runProposed(sttText, gen);
          propRow = {
            time: pr.time, location: pr.location, memoir: pr.memoir, title: pr.title,
            corrected: pr.corrected, correctionReason: pr.reason,
            metrics: await metricsFor(s, pr),
          };
        } catch (e) {
          process.stdout.write(`proposed 실패 `);
        }
        if (baseRow && propRow) {
          process.stdout.write(
            `base 개체 ${baseRow.metrics.entity_mean.toFixed(2)} → prop ${propRow.metrics.entity_mean.toFixed(2)} (보정 ${propRow.corrected ? "O" : "X"})\n`
          );
        } else process.stdout.write("\n");
      }

      rows.push({
        sampleId: s.id,
        condition: cond,
        gold: s.gold,
        cleanText: s.text,
        sttText: sttText ?? null,
        wer: werVal,
        cer: cerVal,
        baseline: baseRow,
        proposed: propRow,
        error: err,
      });
      savePartial();
      await sleep(THROTTLE_MS);
    }
  }

  // ---------- 집계 ----------
  const okRows = rows.filter((r) => r.sttText != null && r.baseline && r.proposed);

  const byCond = CONDS.map((c) => {
    const r = okRows.filter((x) => x.condition === c);
    return {
      condition: c,
      n: r.length,
      wer: mean(r.map((x) => x.wer)),
      cer: mean(r.map((x) => x.cer)),
      base_entity_mean: mean(r.map((x) => x.baseline.metrics.entity_mean)),
      prop_entity_mean: mean(r.map((x) => x.proposed.metrics.entity_mean)),
      base_entity_loc: mean(r.map((x) => x.baseline.metrics.entity_location)),
      prop_entity_loc: mean(r.map((x) => x.proposed.metrics.entity_location)),
      base_sim: mean(r.map((x) => x.baseline.metrics.semantic_similarity)),
      prop_sim: mean(r.map((x) => x.proposed.metrics.semantic_similarity)),
      correction_rate: mean(r.map((x) => (x.proposed.corrected ? 1 : 0))),
    };
  });

  // 실측 CER 구간별 (합성 실험과 비교용; WER 은 한국어 띄어쓰기/수사 정규화로 부풀려짐)
  const bins = [
    [0, 0.02, "0–2%"],
    [0.02, 0.06, "2–6%"],
    [0.06, 0.15, "6–15%"],
    [0.15, 1.01, "15%+"],
  ];
  const byBin = bins.map(([lo, hi, label]) => {
    const r = okRows.filter((x) => x.cer >= lo && x.cer < hi);
    return {
      bin: label,
      n: r.length,
      base_entity_mean: mean(r.map((x) => x.baseline.metrics.entity_mean)),
      prop_entity_mean: mean(r.map((x) => x.proposed.metrics.entity_mean)),
    };
  });

  const result = { model: GEN_MODEL, generatedAt: stamp, conditions: CONDS, byCond, byBin, rows };
  const rawFile = path.resolve(outDir, `real_raw_${stamp}.json`);
  fs.writeFileSync(rawFile, JSON.stringify(result, null, 2));
  fs.writeFileSync(path.resolve(outDir, "real_summary_latest.json"), JSON.stringify({ model: GEN_MODEL, generatedAt: stamp, byCond, byBin }, null, 2));

  console.log("\n=== 음향 조건별 (실제 STT) ===");
  console.log("조건\t\tn\t실측WER\t실측CER\tbase개체\tprop개체\tbase장소\tprop장소\t보정률");
  for (const c of byCond) {
    console.log(
      `${c.condition.padEnd(12)}\t${c.n}\t${f(c.wer * 100, 1)}\t${f(c.cer * 100, 1)}\t${f(c.base_entity_mean)}\t${f(c.prop_entity_mean)}\t${f(c.base_entity_loc)}\t${f(c.prop_entity_loc)}\t${f(c.correction_rate, 2)}`
    );
  }
  console.log("\n=== 실측 WER 구간별 개체 보존 ===");
  for (const b of byBin) console.log(`${b.bin.padEnd(8)} n=${b.n}\tbase ${f(b.base_entity_mean)}\tprop ${f(b.prop_entity_mean)}`);

  console.log(`\n원자료: ${path.relative(ROOT, rawFile)}`);
  console.log(`리포트: node makeReportReal.mjs`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
