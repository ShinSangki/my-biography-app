// Ablation: 구조 분리만(⑤ 없음)을 baseline / 제안(분리+보정)과 비교.
// baseline 은 phase1_raw, 제안은 phase2_raw 를 재사용(동일 시드 노이즈).
// 여기서는 "분리만" 조건을 새로 실행하고, 3 파이프라인의 호출 비용·지연도 측정한다.
//
// 사용: node runAblation.mjs [--resume]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

import { injectNoise } from "./noiseInjector.mjs";
import { entityScore, eventOrderAccuracy, makeEmbedder } from "./metrics.mjs";
import { makeGenerator } from "./llm.mjs";
import { makeBaseline } from "./baseline.mjs";
import { runSeparationOnly, runProposed } from "./proposedPipeline.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
dotenv.config({ path: path.resolve(ROOT, "../.env") });

const API_KEY = process.env.GEMINI_GENERATE_API_KEY;
const GEN_MODEL = process.env.GEMINI_GENERATE_MODEL ?? "gemini-2.5-flash";
if (!API_KEY) throw new Error("GEMINI_GENERATE_API_KEY 없음");

const WER_LEVELS = [0, 0.1, 0.2, 0.3];
const THROTTLE_MS = Number(process.env.EXP_THROTTLE_MS ?? 1200);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const gen = makeGenerator(API_KEY, GEN_MODEL, {
  onRetry: (n, m, w) => process.stdout.write(`  (재시도 ${n}: ${String(m).slice(0, 55)} — ${Math.round(w / 1000)}s)\n`),
});
const baseline = makeBaseline(gen);
const embedder = makeEmbedder(API_KEY);

const hashSeed = (str) => { let h = 2166136261; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
const mean = (a) => { const v = a.filter((x) => x != null && !Number.isNaN(x)); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null; };
const fmt = (x, d = 3) => (x == null ? "—" : Number(x).toFixed(d));

async function metricsFor(sample, out) {
  const ent = entityScore(sample.gold, { time: out.time, location: out.location });
  const ord = eventOrderAccuracy(out.memoir || "", sample.events);
  let sim = null;
  try { sim = await embedder.similarity(sample.text, out.memoir || ""); } catch {}
  return { entity_time: ent.time, entity_location: ent.location, entity_mean: ent.mean, event_order_accuracy: ord.accuracy, semantic_similarity: sim };
}

async function main() {
  const { samples } = JSON.parse(fs.readFileSync(path.resolve(ROOT, "dataset/samples.json"), "utf-8"));
  const outDir = path.resolve(ROOT, "results");
  fs.mkdirSync(outDir, { recursive: true });

  const partialFile = path.resolve(outDir, "sep_raw_partial.json");
  const resume = process.argv.includes("--resume");
  let rows = [];
  const done = new Set();
  if (resume && fs.existsSync(partialFile)) {
    try { rows = JSON.parse(fs.readFileSync(partialFile, "utf-8")).rows || []; for (const r of rows) if (r.generated) done.add(`${r.sampleId}|${r.targetWer}`); console.log(`[resume] ${done.size} skip`); } catch { rows = []; }
  }
  const save = () => fs.writeFileSync(partialFile, JSON.stringify({ model: GEN_MODEL, werLevels: WER_LEVELS, rows }, null, 2));

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const total = samples.length * WER_LEVELS.length;
  let n = 0;
  console.log(`\n=== Ablation: 구조 분리만 (n=${samples.length} × WER ${WER_LEVELS.length}) ===\n`);

  for (const s of samples) {
    const properNouns = [...String(s.gold.location).split(/\s+/), ...String(s.gold.time).replace(/[년월일]/g, " ").split(/\s+/)].filter((x) => x && x.length >= 2);
    for (const w of WER_LEVELS) {
      n++;
      if (done.has(`${s.id}|${w}`)) continue;
      const noisy = injectNoise(s.text, w, hashSeed(`${s.id}|${w}`), properNouns);
      process.stdout.write(`[${n}/${total}] ${s.id} WER=${w * 100}% ... `);
      let out = null, err = null;
      try { out = await runSeparationOnly(noisy.text, gen); } catch (e) { err = String(e?.message || e); process.stdout.write(`실패\n`); }
      let m = null;
      if (out) { m = await metricsFor(s, out); process.stdout.write(`개체 ${fmt(m.entity_mean, 2)} | 의미 ${fmt(m.semantic_similarity, 3)}\n`); }
      rows.push({ sampleId: s.id, targetWer: w, actualWer: noisy.actualWer, gold: s.gold, generated: out ? { time: out.time, location: out.location, memoir: out.memoir, title: out.title } : null, error: err, metrics: m });
      save();
      await sleep(THROTTLE_MS);
    }
  }

  fs.writeFileSync(path.resolve(outDir, `sep_raw_${stamp}.json`), JSON.stringify({ model: GEN_MODEL, werLevels: WER_LEVELS, rows }, null, 2));

  // ---- 지연·호출 측정 (throttle 없이) ----
  console.log(`\n=== 파이프라인 지연·호출 측정 (throttle 없음) ===`);
  const benchSamples = samples.slice(0, 3);
  const timings = { baseline: [], separation: [], proposed: [] };
  const calls = { baseline: [], separation: [], proposed: [] };
  for (const s of benchSamples) {
    const noisy = injectNoise(s.text, 0.2, hashSeed(`${s.id}|0.2`), []);
    for (const [name, fn, nCalls] of [
      ["baseline", () => baseline.run(noisy.text), () => 1],
      ["separation", () => runSeparationOnly(noisy.text, gen), () => 2],
      ["proposed", () => runProposed(noisy.text, gen), (r) => (r.corrected ? 4 : 3)],
    ]) {
      try {
        const t0 = Date.now();
        const r = await fn();
        timings[name].push(Date.now() - t0);
        calls[name].push(nCalls(r));
      } catch (e) {
        process.stdout.write(`  ${name} 측정 실패: ${String(e.message).slice(0, 50)}\n`);
      }
      await sleep(800);
    }
  }
  const bench = {};
  for (const k of ["baseline", "separation", "proposed"]) {
    bench[k] = { n: timings[k].length, meanLatencyMs: Math.round(mean(timings[k]) || 0), meanCalls: mean(calls[k]) };
  }
  fs.writeFileSync(path.resolve(outDir, "ablation_bench.json"), JSON.stringify({ model: GEN_MODEL, generatedAt: stamp, bench }, null, 2));
  console.log(JSON.stringify(bench, null, 2));
  console.log(`\n비교 리포트: node makeReportAblation.mjs`);
}

main().catch((e) => { console.error(e); process.exit(1); });
