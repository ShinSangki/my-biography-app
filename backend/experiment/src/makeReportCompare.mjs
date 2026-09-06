// 테스트 2·3단계 비교 리포트: baseline(phase1) vs 제안 방식(phase2).
//  RQ2 - 동일 오류 조건에서 제안 방식이 baseline 대비 개선되는가
//  RQ3 - 개선폭이 오류율 수준에 따라 어떻게 달라지는가
// 사용: node makeReportCompare.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { entityScore, eventOrderAccuracy } from "./metrics.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const RES = path.resolve(ROOT, "results");

function latest(prefix) {
  const files = fs
    .readdirSync(RES)
    .filter((f) => f.startsWith(prefix) && f.endsWith(".json") && !f.endsWith("_partial.json"));
  if (!files.length) throw new Error(`results/ 에 ${prefix}*.json 이 없습니다. 해당 단계를 먼저 실행하세요.`);
  files.sort();
  return path.resolve(RES, files[files.length - 1]);
}

const { samples } = JSON.parse(fs.readFileSync(path.resolve(ROOT, "dataset/samples.json"), "utf-8"));
const eventsById = Object.fromEntries(samples.map((s) => [s.id, s.events]));

const p1File = latest("phase1_raw_");
const p2File = latest("phase2_raw_");
const p1 = JSON.parse(fs.readFileSync(p1File, "utf-8"));
const p2 = JSON.parse(fs.readFileSync(p2File, "utf-8"));
const werLevels = p1.werLevels;

// 두 단계 모두 metrics.mjs 로 재계산 (의미 유사도는 저장값 유지)
function recompute(rows) {
  const map = new Map();
  for (const r of rows) {
    if (!r.generated) continue;
    const ent = entityScore(r.gold, { time: r.generated.time, location: r.generated.location });
    const ord = eventOrderAccuracy(r.generated.memoir || "", eventsById[r.sampleId] || []);
    map.set(`${r.sampleId}|${r.targetWer}`, {
      sampleId: r.sampleId,
      targetWer: r.targetWer,
      entity_time: ent.time,
      entity_location: ent.location,
      entity_mean: ent.mean,
      event_order_accuracy: ord.accuracy,
      semantic_similarity: r.metrics?.semantic_similarity ?? null,
      corrected: r.corrected ?? null,
    });
  }
  return map;
}
const m1 = recompute(p1.rows);
const m2 = recompute(p2.rows);

const mean = (a) => {
  const v = a.filter((x) => x != null && !Number.isNaN(x));
  return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null;
};
const sd = (a) => {
  const v = a.filter((x) => x != null && !Number.isNaN(x));
  if (v.length < 2) return null;
  const mu = mean(v);
  return Math.sqrt(v.reduce((s, x) => s + (x - mu) ** 2, 0) / (v.length - 1));
};
const f = (x, d = 3) => (x == null ? "—" : Number(x).toFixed(d));
const p = (x) => (x == null ? "—" : `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}p`);

// 짝지어진 케이스만 사용
function pairedByLevel(w, field) {
  const base = [];
  const prop = [];
  for (const s of samples) {
    for (const wer of [w]) {
      const a = m1.get(`${s.id}|${wer}`);
      const b = m2.get(`${s.id}|${wer}`);
      if (!a || !b) continue;
      if (a[field] == null || b[field] == null) continue;
      base.push(a[field]);
      prop.push(b[field]);
    }
  }
  return { base, prop, n: base.length };
}

// 대응표본 t 검정 (근사, 양측)
function pairedT(base, prop) {
  const d = prop.map((x, i) => x - base[i]);
  const n = d.length;
  if (n < 2) return { t: null, df: n - 1, p: null, meanDiff: mean(d) };
  const md = mean(d);
  const s = sd(d);
  if (!s) return { t: null, df: n - 1, p: null, meanDiff: md };
  const t = md / (s / Math.sqrt(n));
  // 정규근사로 대략적인 양측 p (df 큰 경우 근사)
  const z = Math.abs(t);
  const pApprox = 2 * (1 - normalCdf(z));
  return { t, df: n - 1, p: pApprox, meanDiff: md };
}
function normalCdf(x) {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}
function erf(x) {
  const s = x < 0 ? -1 : 1;
  x = Math.abs(x);
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, pp = 0.3275911;
  const t = 1 / (1 + pp * x);
  const y = 1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return s * y;
}

const METRICS = [
  ["entity_mean", "개체 보존(평균)"],
  ["entity_time", "개체 보존(시간)"],
  ["entity_location", "개체 보존(장소)"],
  ["event_order_accuracy", "사건 순서 정확도"],
  ["semantic_similarity", "의미 유사도"],
];

let md = `# 테스트 2·3단계 비교 리포트 (RQ2 / RQ3)

**비교:** baseline(단일 호출, 현재 앱) vs 제안 방식(시간·장소 분리 추출 + 불일치 구간 선택적 보정)
**모델:** \`${p1.model}\` / \`${p2.model}\`
**데이터셋·노이즈:** 1단계와 동일 (생애사 ${samples.length}편, WER ${werLevels.map((w) => w * 100).join("·")}%, 시드 고정 → 두 방식이 완전히 같은 입력을 받음)
**원자료:** \`${path.relative(ROOT, p1File)}\` · \`${path.relative(ROOT, p2File)}\`

---

## 1. RQ2 — 방식별 평균 (WER 레벨별)

`;

for (const [field, label] of METRICS) {
  md += `### ${label}\n\n`;
  md += `| WER | baseline | 제안 | Δ(제안-baseline) | 대응 t | p(근사) | n |\n|---:|---:|---:|---:|---:|---:|---:|\n`;
  for (const w of werLevels) {
    const { base, prop, n } = pairedByLevel(w, field);
    const tt = pairedT(base, prop);
    md += `| ${w * 100}% | ${f(mean(base))} | ${f(mean(prop))} | ${p(tt.meanDiff)} | ${tt.t == null ? "—" : tt.t.toFixed(2)} | ${tt.p == null ? "—" : tt.p.toFixed(3)} | ${n} |\n`;
  }
  md += `\n`;
}

md += `## 2. RQ3 — 오류율 수준별 개선폭 (Δ = 제안 − baseline, %p)

| 지표 | WER 0% | WER 10% | WER 20% | WER 30% |
|---|---:|---:|---:|---:|
`;
for (const [field, label] of METRICS) {
  const cells = werLevels.map((w) => {
    const { base, prop } = pairedByLevel(w, field);
    return p(mean(prop.map((x, i) => x - base[i])));
  });
  md += `| ${label} | ${cells.join(" | ")} |\n`;
}

// 보정 발동률
md += `\n## 3. 선택적 보정 발동률 (제안 방식)

| WER | 보정 발동 케이스 / 전체 | 비율 |
|---:|---:|---:|
`;
for (const w of werLevels) {
  const r = [...m2.values()].filter((x) => x.targetWer === w && x.corrected != null);
  const fired = r.filter((x) => x.corrected).length;
  md += `| ${w * 100}% | ${fired} / ${r.length} | ${r.length ? (fired / r.length).toFixed(2) : "—"} |\n`;
}

// 관찰
const dLo = (() => {
  const { base, prop } = pairedByLevel(werLevels[0], "entity_mean");
  return mean(prop.map((x, i) => x - base[i]));
})();
const dHi = (() => {
  const { base, prop } = pairedByLevel(werLevels[werLevels.length - 1], "entity_mean");
  return mean(prop.map((x, i) => x - base[i]));
})();

md += `
## 4. 관찰

- 개체 보존(평균) 개선폭: WER ${werLevels[0] * 100}%에서 ${p(dLo)}, WER ${werLevels[werLevels.length - 1] * 100}%에서 ${p(dHi)}.
- ${dHi != null && dLo != null && dHi > dLo ? "오류율이 높을수록 제안 방식의 이득이 커지는 경향(RQ3 가설과 일치)." : "오류율 수준에 따른 이득 차이는 뚜렷하지 않음 — 표본 확대 필요."}
- p(근사)는 정규근사 기반 대응표본 t의 대략치다. 표본 ${samples.length}편 규모에서는 참고용이며, 논문 보고 시 정확한 t 분포 또는 부트스트랩/윌콕슨 부호순위 검정으로 재계산 권장.
- 사람 평가(자연스러움/전체 품질)는 \`human_eval_template.csv\`(baseline)와 phase2 생성문을 함께 평가자 2인에게 배정해 Cohen's kappa로 일치도 확인.

## 5. 재현

\`\`\`bash
cd backend/experiment/src
node runPhase1.mjs      # baseline
node runPhase2.mjs      # 제안 방식
node makeReportCompare.mjs
\`\`\`
`;

fs.writeFileSync(path.resolve(RES, "compare_report.md"), md);
console.log("비교 리포트 생성:", "results/compare_report.md");
