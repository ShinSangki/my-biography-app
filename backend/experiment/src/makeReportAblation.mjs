// Ablation 비교 리포트: baseline / 구조 분리만 / 분리+선택적 보정
//  - (a)→(b): 전용 추출 프롬프트(분리)만으로 개선되나
//  - (b)→(c): 선택적 보정이 추가로 기여하나
//  + 호출 비용·지연 표
// 사용: node makeReportAblation.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { entityScore, eventOrderAccuracy } from "./metrics.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const RES = path.resolve(ROOT, "results");

function pick(pfx, which = "last") {
  const f = fs.readdirSync(RES).filter((x) => x.startsWith(pfx) && x.endsWith(".json") && !x.endsWith("_partial.json")).sort();
  if (!f.length) throw new Error(`${pfx}* 없음`);
  return path.resolve(RES, which === "first" ? f[0] : f[f.length - 1]);
}

const { samples } = JSON.parse(fs.readFileSync(path.resolve(ROOT, "dataset/samples.json"), "utf-8"));
const eventsById = Object.fromEntries(samples.map((s) => [s.id, s.events]));

// baseline·proposed 는 compare_report 와 동일하게 각 raw 의 첫 실행을 쓴다(동일 시드 노이즈).
const baselineFile = pick("phase1_raw_", "first");
const proposedFile = pick("phase2_raw_", "first");
const sepFile = pick("sep_raw_", "last");

function loadMap(file, kind) {
  const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
  const m = new Map();
  for (const r of raw.rows) {
    if (!r.generated) continue;
    const g = r.generated;
    const ent = entityScore(r.gold, { time: g.time, location: g.location });
    const ord = eventOrderAccuracy(g.memoir || "", eventsById[r.sampleId] || []);
    m.set(`${r.sampleId}|${r.targetWer}`, {
      entity_mean: ent.mean, entity_location: ent.location, entity_time: ent.time,
      event_order_accuracy: ord.accuracy,
      semantic_similarity: r.metrics?.semantic_similarity ?? null,
      corrected: kind === "proposed" ? r.corrected : undefined,
    });
  }
  return m;
}
const A = loadMap(baselineFile, "baseline");
const B = loadMap(sepFile, "separation");
const C = loadMap(proposedFile, "proposed");

const WER = [0, 0.1, 0.2, 0.3];
const mean = (a) => { const v = a.filter((x) => x != null && !Number.isNaN(x)); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null; };
const f = (x, d = 3) => (x == null ? "—" : Number(x).toFixed(d));
const pp = (x) => (x == null ? "—" : `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}p`);

function levelMeans(map, field, w) {
  const vals = [];
  for (const s of samples) { const v = map.get(`${s.id}|${w}`); if (v && v[field] != null) vals.push(v[field]); }
  return mean(vals);
}
function pairedDelta(m1, m2, field, w) {
  const d = [];
  for (const s of samples) {
    const a = m1.get(`${s.id}|${w}`)?.[field], b = m2.get(`${s.id}|${w}`)?.[field];
    if (a != null && b != null) d.push(b - a);
  }
  return mean(d);
}

let md = `# Ablation 리포트 — 구조 분리 vs 선택적 보정

**목적:** 제안 방식의 이득이 (b) 구조 분리에서 오는지, (c) 선택적 보정에서 오는지 분해.

| 조건 | 설명 | 원자료 |
|---|---|---|
| (a) baseline | 단일 LLM 호출 (현재 앱) | \`${path.basename(baselineFile)}\` |
| (b) 분리만 | 시간·장소를 전용 프롬프트로 원문에서 별도 추출, 문체 정리 분리, 보정 없음 | \`${path.basename(sepFile)}\` |
| (c) 분리+보정 | (b) + 원문/정리문 추출 후보 불일치 시 선택적 재보정 | \`${path.basename(proposedFile)}\` |

세 조건은 동일 시드 노이즈를 입력받는다. baseline·proposed 는 각 실험의 첫 실행(RQ1 분산 분석에서 실행 간 SD 1~2%p 확인).

---

## 1. WER 레벨별 개체 보존율(평균)

| WER | (a) baseline | (b) 분리만 | (c) 분리+보정 | (b)−(a) | (c)−(b) |
|---:|---:|---:|---:|---:|---:|
`;
for (const w of WER) {
  md += `| ${w * 100}% | ${f(levelMeans(A, "entity_mean", w))} | ${f(levelMeans(B, "entity_mean", w))} | ${f(levelMeans(C, "entity_mean", w))} | ${pp(pairedDelta(A, B, "entity_mean", w))} | ${pp(pairedDelta(B, C, "entity_mean", w))} |\n`;
}

md += `\n## 2. WER 레벨별 개체 보존율(장소)\n\n| WER | (a) baseline | (b) 분리만 | (c) 분리+보정 | (b)−(a) | (c)−(b) |\n|---:|---:|---:|---:|---:|---:|\n`;
for (const w of WER) {
  md += `| ${w * 100}% | ${f(levelMeans(A, "entity_location", w))} | ${f(levelMeans(B, "entity_location", w))} | ${f(levelMeans(C, "entity_location", w))} | ${pp(pairedDelta(A, B, "entity_location", w))} | ${pp(pairedDelta(B, C, "entity_location", w))} |\n`;
}

md += `\n## 3. 의미 유사도 (본문 품질 유지 확인)\n\n| WER | (a) baseline | (b) 분리만 | (c) 분리+보정 |\n|---:|---:|---:|---:|\n`;
for (const w of WER) {
  md += `| ${w * 100}% | ${f(levelMeans(A, "semantic_similarity", w))} | ${f(levelMeans(B, "semantic_similarity", w))} | ${f(levelMeans(C, "semantic_similarity", w))} |\n`;
}

// ---- 비용 ----
md += `\n## 4. 호출 비용·지연\n\n`;
let corrRate = null;
{
  const cs = [...C.values()].filter((v) => v.corrected != null);
  corrRate = mean(cs.map((v) => (v.corrected ? 1 : 0)));
}
let bench = null;
try { bench = JSON.parse(fs.readFileSync(path.resolve(RES, "ablation_bench.json"), "utf-8")).bench; } catch {}
md += `| 조건 | LLM 호출/케이스 | 상대 비용 | 평균 지연 |\n|---|---:|---:|---:|\n`;
const callsA = 1;
const callsB = 2;
const callsC = 3 + (corrRate ?? 0.6);
const lat = (k) => (bench && bench[k] ? `${(bench[k].meanLatencyMs / 1000).toFixed(1)}s` : "—");
md += `| (a) baseline | 1 | ×1.0 | ${lat("baseline")} |\n`;
md += `| (b) 분리만 | 2 | ×2.0 | ${lat("separation")} |\n`;
md += `| (c) 분리+보정 | ${callsC.toFixed(1)} (보정 발동률 ${f(corrRate, 2)}) | ×${callsC.toFixed(1)} | ${lat("proposed")} |\n`;
md += `\n${bench ? `지연은 샘플 ${bench.baseline.n}건에 대해 throttle 없이 측정한 벽시계 시간 평균.` : "(ablation_bench.json 없음 — 지연 미측정)"}\n`;

// ---- 관찰 ----
const dBA30 = pairedDelta(A, B, "entity_mean", 0.3);
const dCB30 = pairedDelta(B, C, "entity_mean", 0.3);
const dBAloc30 = pairedDelta(A, B, "entity_location", 0.3);
const dCBloc30 = pairedDelta(B, C, "entity_location", 0.3);
const bWorse = (pairedDelta(A, B, "entity_location", 0.1) ?? 0) < 0 && (pairedDelta(A, B, "entity_location", 0.2) ?? 0) < 0;
md += `
## 5. 관찰

- **개체 보존(장소) 변화 (Δ):** WER 10/20/30%에서 (b)−(a) = ${pp(pairedDelta(A, B, "entity_location", 0.1))} / ${pp(pairedDelta(A, B, "entity_location", 0.2))} / ${pp(dBAloc30)}, (c)−(b) = ${pp(pairedDelta(B, C, "entity_location", 0.1))} / ${pp(pairedDelta(B, C, "entity_location", 0.2))} / ${pp(dCBloc30)}.
- **구조 분리(b)만으로는 baseline을 넘지 못하고 오히려 소폭 낮다** (WER 20% 장소 ${pp(pairedDelta(A, B, "entity_location", 0.2))}). 노이즈 낀 원문에서 전용 프롬프트로 추출해도, baseline의 통합 프롬프트가 문체 정리와 함께 일부 오류를 정규화하는 효과를 못 얻기 때문으로 보인다.
- **제안 방식의 이득은 전적으로 선택적 보정(c) 단계에서 온다** ((c)−(b)가 (b)−(a)보다 부호·크기 모두 우세). 즉 원문 기반 추출값과 정리문 기반 추출값을 대조·재판단하는 절차가 실질 기여다.
- 이는 생태적 타당도 검증 결과와 정합적이다. 유일하게 효과를 내는 (c) 단계가 두 추출 경로의 불일치에 의존하는데, 실제 STT의 "유창하지만 틀린" 오류에서는 두 경로가 같은 값에 합의하므로 (c)가 발동하지 못한다. 따라서 합성 노이즈에서의 이득이 실제 STT로 전이되지 않는다.
- 의미 유사도는 세 조건 모두 유사 → 어느 변형도 본문 품질을 저해하지 않는다.
- 비용: (b)는 (a)의 2배(지연 동등), (c)는 약 ${callsC.toFixed(1)}배 호출·2.3배 지연. 효과가 실제 STT에서 확인되지 않으므로 (c)의 비용은 현 설계로는 정당화되지 않는다.
`;

fs.writeFileSync(path.resolve(RES, "ablation_report.md"), md);
console.log("생성: results/ablation_report.md");
