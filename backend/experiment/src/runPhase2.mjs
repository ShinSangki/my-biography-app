// ============================================================================
// 논문 "테스트 2단계" (RQ2): 시간·장소 추출을 본문 정리와 분리하고 불일치 구간만
// 선택적으로 보정하는 제안 방식이, 1단계와 동일한 오류 조건에서 baseline 대비
// 생성 품질을 유의하게 개선하는가.
//
// 1단계와 완전히 동일한 데이터셋·노이즈(시드 고정)를 사용하며, baseline 대신
// proposedPipeline.runProposed 를 호출한다. 결과는 makeReportCompare.mjs 로
// 1단계(phase1_raw)와 짝지어 비교한다.
// ============================================================================

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

import { injectNoise } from "./noiseInjector.mjs";
import { entityScore, eventOrderAccuracy, makeEmbedder } from "./metrics.mjs";
import { makeGenerator } from "./llm.mjs";
import { runProposed } from "./proposedPipeline.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
dotenv.config({ path: path.resolve(ROOT, "../.env") });

const API_KEY = process.env.GEMINI_GENERATE_API_KEY;
const GEN_MODEL = process.env.GEMINI_GENERATE_MODEL ?? "gemini-2.5-flash";
if (!API_KEY) throw new Error("GEMINI_GENERATE_API_KEY 가 없습니다 (backend/.env 확인).");

const WER_LEVELS = [0, 0.1, 0.2, 0.3];
const THROTTLE_MS = Number(process.env.EXP_THROTTLE_MS ?? 1500);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const gen = makeGenerator(API_KEY, GEN_MODEL, {
  onRetry: (n, msg, wait) =>
    process.stdout.write(`  (재시도 ${n}: ${String(msg).slice(0, 60)} — ${Math.round(wait / 1000)}s)\n`),
});
const embedder = makeEmbedder(API_KEY);

function hashSeed(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
const mean = (a) => {
  const v = a.filter((x) => x != null && !Number.isNaN(x));
  return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null;
};
const fmt = (x, d = 2) => (x == null ? "-" : Number(x).toFixed(d));

async function main() {
  const { samples } = JSON.parse(fs.readFileSync(path.resolve(ROOT, "dataset/samples.json"), "utf-8"));
  const outDir = path.resolve(ROOT, "results");
  fs.mkdirSync(outDir, { recursive: true });

  const partialFile = path.resolve(outDir, "phase2_raw_partial.json");
  const resume = process.argv.includes("--resume");
  let rows = [];
  const doneKeys = new Set();
  if (resume && fs.existsSync(partialFile)) {
    try {
      rows = JSON.parse(fs.readFileSync(partialFile, "utf-8")).rows || [];
      for (const r of rows) if (r.generated) doneKeys.add(`${r.sampleId}|${r.targetWer}`);
      console.log(`[resume] 기존 ${doneKeys.size}개 케이스 건너뜀`);
    } catch {
      rows = [];
    }
  }
  const savePartial = () =>
    fs.writeFileSync(partialFile, JSON.stringify({ model: GEN_MODEL, werLevels: WER_LEVELS, rows }, null, 2));

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const totalCases = samples.length * WER_LEVELS.length;
  let done = 0;

  console.log(`\n=== Phase 2: 제안 방식(분리 추출 + 선택적 보정) ===`);
  console.log(`샘플 ${samples.length}편 × WER ${WER_LEVELS.map((w) => w * 100 + "%").join("/")} = ${totalCases} 케이스\n`);

  for (const s of samples) {
    const properNouns = [
      ...String(s.gold.location).split(/\s+/),
      ...String(s.gold.time).replace(/[년월일]/g, " ").split(/\s+/),
    ].filter((x) => x && x.length >= 2);

    for (const targetWer of WER_LEVELS) {
      done++;
      if (doneKeys.has(`${s.id}|${targetWer}`)) continue;

      const noisy = injectNoise(s.text, targetWer, hashSeed(`${s.id}|${targetWer}`), properNouns);
      process.stdout.write(`[${done}/${totalCases}] ${s.id} WER=${targetWer * 100}% (실측 ${(noisy.actualWer * 100).toFixed(1)}%) ... `);

      let out, err = null;
      try {
        out = await runProposed(noisy.text, gen);
      } catch (e) {
        err = String(e?.message || e);
        process.stdout.write(`실패: ${err.slice(0, 70)}\n`);
      }

      let ent = null, order = null, sim = null;
      if (out) {
        ent = entityScore(s.gold, { time: out.time, location: out.location });
        order = eventOrderAccuracy(out.memoir || "", s.events);
        try {
          sim = await embedder.similarity(s.text, out.memoir || "");
        } catch {
          process.stdout.write("(임베딩 실패) ");
        }
        process.stdout.write(
          `개체 ${ent.mean.toFixed(2)} | 순서 ${order.accuracy != null ? order.accuracy.toFixed(2) : "-"} | 의미 ${sim != null ? sim.toFixed(3) : "-"} | 보정 ${out.corrected ? "O" : "X"}\n`
        );
      }

      rows.push({
        sampleId: s.id,
        targetWer,
        actualWer: noisy.actualWer,
        noisyText: noisy.text,
        gold: s.gold,
        generated: out
          ? { title: out.title, time: out.time, location: out.location, memoir: out.memoir }
          : null,
        corrected: out ? out.corrected : null,
        correctionReason: out ? out.reason : null,
        candidates: out ? out.candidates : null,
        error: err,
        metrics: out
          ? {
              entity_time: ent.time,
              entity_location: ent.location,
              entity_mean: ent.mean,
              event_order_accuracy: order.accuracy,
              semantic_similarity: sim,
            }
          : null,
      });

      savePartial();
      await sleep(THROTTLE_MS);
    }
  }

  const summary = WER_LEVELS.map((w) => {
    const r = rows.filter((x) => x.targetWer === w && x.metrics);
    return {
      targetWer: w,
      n: r.length,
      meanActualWer: mean(rows.filter((x) => x.targetWer === w).map((x) => x.actualWer)),
      entity_time: mean(r.map((x) => x.metrics.entity_time)),
      entity_location: mean(r.map((x) => x.metrics.entity_location)),
      entity_mean: mean(r.map((x) => x.metrics.entity_mean)),
      event_order_accuracy: mean(r.map((x) => x.metrics.event_order_accuracy)),
      semantic_similarity: mean(r.map((x) => x.metrics.semantic_similarity)),
      correction_rate: mean(rows.filter((x) => x.targetWer === w && x.corrected != null).map((x) => (x.corrected ? 1 : 0))),
    };
  });

  const rawFile = path.resolve(outDir, `phase2_raw_${stamp}.json`);
  fs.writeFileSync(rawFile, JSON.stringify({ model: GEN_MODEL, werLevels: WER_LEVELS, rows }, null, 2));
  fs.writeFileSync(
    path.resolve(outDir, "phase2_summary_latest.json"),
    JSON.stringify({ model: GEN_MODEL, generatedAt: stamp, summary }, null, 2)
  );
  fs.writeFileSync(path.resolve(outDir, `phase2_summary_${stamp}.json`), JSON.stringify({ model: GEN_MODEL, generatedAt: stamp, summary }, null, 2));

  console.log("\n=== WER 레벨별 평균 (제안 방식) ===");
  console.log("WER%\t실측%\t개체(시간)\t개체(장소)\t개체(평균)\t사건순서\t의미유사도\t보정발동률");
  for (const s of summary) {
    console.log(
      `${s.targetWer * 100}\t${fmt(s.meanActualWer * 100, 1)}\t${fmt(s.entity_time)}\t\t${fmt(s.entity_location)}\t\t${fmt(s.entity_mean)}\t\t${fmt(s.event_order_accuracy)}\t${fmt(s.semantic_similarity, 3)}\t\t${fmt(s.correction_rate)}`
    );
  }
  console.log(`\n원자료: ${path.relative(ROOT, rawFile)}`);
  console.log(`\n비교 리포트: node makeReportCompare.mjs`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
