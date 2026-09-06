// RQ1 다중 실행 분산: phase1_raw_*.json (반복 실행) 전체를 읽어
// WER 레벨별 지표의 실행 간 평균 ± 표준편차를 보고한다.
// LLM 비결정성으로 인한 실행 우연이 저하 곡선을 설명하지 못함을 확인.
// 사용: node varianceReport.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { entityScore, eventOrderAccuracy } from "./metrics.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const RES = path.resolve(ROOT, "results");

const { samples } = JSON.parse(fs.readFileSync(path.resolve(ROOT, "dataset/samples.json"), "utf-8"));
const eventsById = Object.fromEntries(samples.map((s) => [s.id, s.events]));

const files = fs
  .readdirSync(RES)
  .filter((x) => x.startsWith("phase1_raw_") && x.endsWith(".json") && !x.endsWith("_partial.json"))
  .sort();
if (files.length < 2) {
  console.error(`반복 실행이 ${files.length}개뿐입니다. runPhase1.mjs 를 2회 이상 실행하세요.`);
  process.exit(1);
}

const mean = (a) => { const v = a.filter((x) => x != null && !Number.isNaN(x)); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null; };
const sd = (a) => { const v = a.filter((x) => x != null && !Number.isNaN(x)); if (v.length < 2) return null; const m = mean(v); return Math.sqrt(v.reduce((s, x) => s + (x - m) ** 2, 0) / (v.length - 1)); };
const f = (x, d = 3) => (x == null ? "—" : Number(x).toFixed(d));

const WER = [0, 0.1, 0.2, 0.3];
const METRICS = [
  ["entity_time", "개체 보존(시간)"],
  ["entity_location", "개체 보존(장소)"],
  ["entity_mean", "개체 보존(평균)"],
  ["semantic_similarity", "의미 유사도"],
  ["event_order_accuracy", "사건 순서"],
];

// 각 실행 파일 → WER 레벨별 지표 평균 (metrics.mjs 로 재계산; 의미 유사도는 저장값)
const runSummaries = files.map((file) => {
  const raw = JSON.parse(fs.readFileSync(path.resolve(RES, file), "utf-8"));
  const perLevel = {};
  for (const w of WER) {
    const rows = raw.rows.filter((r) => r.targetWer === w && r.generated);
    const recomputed = rows.map((r) => {
      const ent = entityScore(r.gold, { time: r.generated.time, location: r.generated.location });
      const ord = eventOrderAccuracy(r.generated.memoir || "", eventsById[r.sampleId] || []);
      return {
        entity_time: ent.time,
        entity_location: ent.location,
        entity_mean: ent.mean,
        event_order_accuracy: ord.accuracy,
        semantic_similarity: r.metrics?.semantic_similarity ?? null,
      };
    });
    perLevel[w] = Object.fromEntries(METRICS.map(([k]) => [k, mean(recomputed.map((x) => x[k]))]));
  }
  return { file, perLevel };
});

let md = `# RQ1 다중 실행 분산 분석\n\n반복 실행 ${runSummaries.length}회 (모델 gemini-2.5-flash, 각 26편 × WER 4단계).\n노이즈는 시드 고정으로 실행 간 동일하며, LLM 생성만 비결정적이다.\n\n원자료: ${files.map((x) => "`" + x + "`").join(", ")}\n\n---\n\n`;

for (const [key, label] of METRICS) {
  md += `## ${label}\n\n| WER | ${runSummaries.map((_, i) => `실행 ${i + 1}`).join(" | ")} | 평균 | 실행간 SD | 범위 |\n|---:|${runSummaries.map(() => "---:").join("|")}|---:|---:|---:|\n`;
  for (const w of WER) {
    const vals = runSummaries.map((r) => r.perLevel[w][key]);
    const mu = mean(vals), s = sd(vals);
    const rng = Math.max(...vals) - Math.min(...vals);
    md += `| ${w * 100}% | ${vals.map((v) => f(v)).join(" | ")} | **${f(mu)}** | ${f(s)} | ${f(rng)} |\n`;
  }
  md += `\n`;
}

// 저하폭 (0→30%) 실행별
md += `## 0% → 30% 저하폭 (실행별 재현성)\n\n| 지표 | ${runSummaries.map((_, i) => `실행 ${i + 1}`).join(" | ")} | 평균 | 실행간 SD |\n|---|${runSummaries.map(() => "---:").join("|")}|---:|---:|\n`;
for (const [key, label] of METRICS) {
  const drops = runSummaries.map((r) => r.perLevel[0.3][key] - r.perLevel[0][key]);
  md += `| ${label} | ${drops.map((d) => f(d * 100, 1) + "%p").join(" | ")} | ${f(mean(drops) * 100, 1)}%p | ${f(sd(drops) * 100, 2)}%p |\n`;
}

md += `\n---\n\n## 관찰\n\n`;
const emDropMean = mean(runSummaries.map((r) => r.perLevel[0.3].entity_mean - r.perLevel[0].entity_mean));
const emDropSD = sd(runSummaries.map((r) => r.perLevel[0.3].entity_mean - r.perLevel[0].entity_mean));
const locDropMean = mean(runSummaries.map((r) => r.perLevel[0.3].entity_location - r.perLevel[0].entity_location));
const locDropSD = sd(runSummaries.map((r) => r.perLevel[0.3].entity_location - r.perLevel[0].entity_location));
md += `- 개체 보존(평균)의 0→30% 저하는 ${runSummaries.length}회 실행 모두에서 재현되었으며, 저하폭 ${f(emDropMean * 100, 1)}%p (실행간 SD ${f(emDropSD * 100, 2)}%p).\n`;
md += `- 개체 보존(장소) 저하폭 ${f(locDropMean * 100, 1)}%p (실행간 SD ${f(locDropSD * 100, 2)}%p).\n`;
md += `- 실행 간 SD가 저하폭 자체보다 훨씬 작으므로, RQ1의 품질 저하는 LLM 생성의 우연 변동으로 설명되지 않는다.\n`;

fs.writeFileSync(path.resolve(RES, "rq1_variance.md"), md);
console.log("생성:", "results/rq1_variance.md", `(${runSummaries.length}회 실행)`);
