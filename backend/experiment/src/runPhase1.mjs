// ============================================================================
// 논문 "테스트 1단계" (RQ1): STT 오류율이 증가함에 따라 현재 구현과 같은
// 단일 호출(baseline) 자서전 생성 품질이 어떻게 저하되는가.
//
// 흐름: 데이터셋(16편) × WER {0, 10, 20, 30%}
//   → 규칙 기반 노이즈 주입 → baseline 단일 호출 생성 → 지표 3종 측정
//
// baseline 프롬프트는 backend/src/services/geminiGENERATEService.ts 의
// generateMemoirText 와 동일하게 맞춰 현재 앱의 동작을 그대로 재현한다.
// ============================================================================

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GoogleGenAI } from "@google/genai";
import dotenv from "dotenv";

import { injectNoise } from "./noiseInjector.mjs";
import { entityScore, eventOrderAccuracy, makeEmbedder } from "./metrics.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
dotenv.config({ path: path.resolve(ROOT, "../.env") });

const API_KEY = process.env.GEMINI_GENERATE_API_KEY;
const GEN_MODEL = process.env.GEMINI_GENERATE_MODEL ?? "gemini-2.5-flash";
if (!API_KEY) throw new Error("GEMINI_GENERATE_API_KEY 가 없습니다 (backend/.env 확인).");

const WER_LEVELS = [0, 0.1, 0.2, 0.3];
// 무료 티어 generate 제한이 분당 20건이므로 호출 간격을 넉넉히 둔다(케이스당 generate 1 + embed 1).
const THROTTLE_MS = Number(process.env.EXP_THROTTLE_MS ?? 3500);

// 429 응답의 "retry in 12.3s" 힌트를 파싱해 그만큼(+버퍼) 대기
function retryDelayFromError(msg, fallback) {
  const m = String(msg).match(/retry in ([\d.]+)s/i);
  if (m) return Math.ceil(parseFloat(m[1]) * 1000) + 2000;
  return fallback;
}

const ai = new GoogleGenAI({ apiKey: API_KEY });
const embedder = makeEmbedder(API_KEY);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- baseline: 현재 앱과 동일한 단일 호출 ----------
async function generateBaseline(rawText, retries = 8) {
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

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await ai.models.generateContent({
        model: GEN_MODEL,
        contents: prompt,
        config: { responseMimeType: "application/json", thinkingConfig: { thinkingBudget: 0 } },
      });
      const t = response.text?.trim();
      if (!t) throw new Error("빈 응답");
      return JSON.parse(t);
    } catch (err) {
      const msg = String(err?.message || err);
      if (attempt === retries) throw err;
      const isQuota = /429|quota|rate|RESOURCE_EXHAUSTED/i.test(msg);
      const wait = isQuota ? retryDelayFromError(msg, 60000) : 4000 * (attempt + 1);
      process.stdout.write(`  (재시도 ${attempt + 1}: ${msg.slice(0, 70)} — ${Math.round(wait / 1000)}s 대기)\n`);
      await sleep(wait);
    }
  }
}

// ---------- 집계 ----------
function mean(arr) {
  const v = arr.filter((x) => x != null && !Number.isNaN(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

async function main() {
  const dsPath = path.resolve(ROOT, "dataset/samples.json");
  const { samples } = JSON.parse(fs.readFileSync(dsPath, "utf-8"));
  const outDir = path.resolve(ROOT, "results");
  fs.mkdirSync(outDir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const partialFile = path.resolve(outDir, "phase1_raw_partial.json");
  const resume = process.argv.includes("--resume");

  // 체크포인트: 케이스마다 partial 파일에 덮어써서, 할당량 초과·중단에도 진행분을 보존한다.
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

  console.log(`\n=== Phase 1: baseline 저하 곡선 측정 ===`);
  console.log(`샘플 ${samples.length}편 × WER ${WER_LEVELS.map((w) => w * 100 + "%").join("/")} = ${samples.length * WER_LEVELS.length} 케이스\n`);

  let done = 0;
  const totalCases = samples.length * WER_LEVELS.length;

  for (const s of samples) {
    const properNouns = [
      ...String(s.gold.location).split(/\s+/),
      ...String(s.gold.time).replace(/[년월일]/g, " ").split(/\s+/),
    ].filter((x) => x && x.length >= 2);

    for (let li = 0; li < WER_LEVELS.length; li++) {
      const targetWer = WER_LEVELS[li];
      done++;
      if (doneKeys.has(`${s.id}|${targetWer}`)) continue;

      const seed = hashSeed(`${s.id}|${targetWer}`);
      const noisy = injectNoise(s.text, targetWer, seed, properNouns);

      process.stdout.write(`[${done}/${totalCases}] ${s.id} WER=${targetWer * 100}% (실측 ${(noisy.actualWer * 100).toFixed(1)}%) ... `);

      let gen, err = null;
      try {
        gen = await generateBaseline(noisy.text);
      } catch (e) {
        err = String(e?.message || e);
        process.stdout.write(`실패: ${err.slice(0, 80)}\n`);
      }

      let ent = null, order = null, sim = null;
      if (gen) {
        ent = entityScore(s.gold, { time: gen.time, location: gen.location });
        order = eventOrderAccuracy(gen.memoir || "", s.events);
        try {
          sim = await embedder.similarity(s.text, gen.memoir || "");
        } catch (e) {
          process.stdout.write(`(임베딩 실패) `);
        }
        process.stdout.write(
          `개체 ${ent.mean.toFixed(2)} | 순서 ${order.accuracy != null ? order.accuracy.toFixed(2) : "-"} | 의미 ${sim != null ? sim.toFixed(3) : "-"}\n`
        );
      }

      rows.push({
        sampleId: s.id,
        targetWer,
        actualWer: noisy.actualWer,
        noisyText: noisy.text,
        editCount: noisy.edits.length,
        gold: s.gold,
        generated: gen ? { title: gen.title, time: gen.time, location: gen.location, memoir: gen.memoir } : null,
        error: err,
        metrics: gen
          ? {
              entity_time: ent.time,
              entity_location: ent.location,
              entity_mean: ent.mean,
              event_order_accuracy: order.accuracy,
              event_comparable_pairs: order.comparablePairs,
              events_found: order.eventsFound,
              events_total: order.eventsTotal,
              semantic_similarity: sim,
            }
          : null,
      });

      savePartial();
      await sleep(THROTTLE_MS);
    }
  }

  // ---------- 집계: WER 레벨별 평균 ----------
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
    };
  });

  const rawFile = path.resolve(outDir, `phase1_raw_${stamp}.json`);
  const sumFile = path.resolve(outDir, `phase1_summary_${stamp}.json`);
  fs.writeFileSync(rawFile, JSON.stringify({ model: GEN_MODEL, werLevels: WER_LEVELS, rows }, null, 2));
  fs.writeFileSync(sumFile, JSON.stringify({ model: GEN_MODEL, generatedAt: stamp, summary }, null, 2));
  // 최신본 고정 이름으로도 복사
  fs.writeFileSync(path.resolve(outDir, "phase1_summary_latest.json"), JSON.stringify({ model: GEN_MODEL, generatedAt: stamp, summary }, null, 2));

  console.log("\n=== WER 레벨별 평균 (baseline) ===");
  console.log("WER%\t실측%\t개체(시간)\t개체(장소)\t개체(평균)\t사건순서\t의미유사도");
  for (const s of summary) {
    console.log(
      `${s.targetWer * 100}\t${fmt(s.meanActualWer * 100, 1)}\t${fmt(s.entity_time)}\t\t${fmt(s.entity_location)}\t\t${fmt(s.entity_mean)}\t\t${fmt(s.event_order_accuracy)}\t${fmt(s.semantic_similarity, 3)}`
    );
  }
  console.log(`\n원자료: ${path.relative(ROOT, rawFile)}`);
  console.log(`요약:   ${path.relative(ROOT, sumFile)}`);
}

function fmt(x, d = 2) {
  return x == null ? "-" : Number(x).toFixed(d);
}

function hashSeed(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
