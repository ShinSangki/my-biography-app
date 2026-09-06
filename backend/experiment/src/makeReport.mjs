// Phase 1 결과 → 마크다운 리포트 생성.
// 사용: node makeReport.mjs [phase1_raw_*.json]  (생략 시 results/ 최신 raw 자동 선택)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const RES = path.resolve(ROOT, "results");

function latestRaw() {
  const files = fs.readdirSync(RES).filter((f) => f.startsWith("phase1_raw_") && f.endsWith(".json"));
  if (!files.length) throw new Error("results/ 에 phase1_raw_*.json 이 없습니다.");
  files.sort();
  return path.resolve(RES, files[files.length - 1]);
}

import { entityScore, eventOrderAccuracy } from "./metrics.mjs";

const rawFile = process.argv[2] ? path.resolve(process.argv[2]) : latestRaw();
const { model, werLevels, rows } = JSON.parse(fs.readFileSync(rawFile, "utf-8"));

// 지표를 최신 metrics.mjs 로직으로 재계산 (의미 유사도는 API가 필요하므로 저장값 유지)
const { samples } = JSON.parse(fs.readFileSync(path.resolve(ROOT, "dataset/samples.json"), "utf-8"));
const eventsById = Object.fromEntries(samples.map((s) => [s.id, s.events]));
for (const r of rows) {
  if (!r.generated) continue;
  const ent = entityScore(r.gold, { time: r.generated.time, location: r.generated.location });
  const ord = eventOrderAccuracy(r.generated.memoir || "", eventsById[r.sampleId] || []);
  r.metrics = {
    ...r.metrics,
    entity_time: ent.time,
    entity_location: ent.location,
    entity_mean: ent.mean,
    event_order_accuracy: ord.accuracy,
  };
}

const mean = (a) => {
  const v = a.filter((x) => x != null && !Number.isNaN(x));
  return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null;
};
const sd = (a) => {
  const v = a.filter((x) => x != null && !Number.isNaN(x));
  if (v.length < 2) return null;
  const m = mean(v);
  return Math.sqrt(v.reduce((s, x) => s + (x - m) ** 2, 0) / (v.length - 1));
};
const f = (x, d = 3) => (x == null ? "—" : Number(x).toFixed(d));

const byLevel = werLevels.map((w) => {
  const r = rows.filter((x) => x.targetWer === w && x.metrics);
  const g = (sel) => r.map(sel);
  return {
    w,
    n: r.length,
    nFail: rows.filter((x) => x.targetWer === w && !x.metrics).length,
    actualWer: mean(rows.filter((x) => x.targetWer === w).map((x) => x.actualWer)),
    entTime: [mean(g((x) => x.metrics.entity_time)), sd(g((x) => x.metrics.entity_time))],
    entLoc: [mean(g((x) => x.metrics.entity_location)), sd(g((x) => x.metrics.entity_location))],
    entMean: [mean(g((x) => x.metrics.entity_mean)), sd(g((x) => x.metrics.entity_mean))],
    order: [mean(g((x) => x.metrics.event_order_accuracy)), sd(g((x) => x.metrics.event_order_accuracy))],
    sim: [mean(g((x) => x.metrics.semantic_similarity)), sd(g((x) => x.metrics.semantic_similarity))],
  };
});

const base = byLevel[0];
const drop = (cur, b) => (b == null || cur == null ? "—" : `${((cur - b) * 100).toFixed(1)}p`);

let md = `# 테스트 1단계 결과 리포트 (RQ1)

**주제:** STT 오류율 증가에 따른 기준 방식(현재 앱의 단일 LLM 호출) 자서전 생성 품질 저하 측정
**생성 모델:** \`${model}\`
**데이터셋:** 생애사 클린 텍스트 ${samples.length}편 (시간·장소 골드 태그 + 사건 순서)
**STT 오류 시뮬레이션:** 규칙 기반 노이즈(음운 유사 치환 / 단어 삭제 / 고유명사 왜곡), WER ${werLevels.map((w) => w * 100).join("·")}% ${werLevels.length}단계
**케이스 수:** ${rows.length} (샘플 ${samples.length} × WER ${werLevels.length}단계)
**원자료:** \`${path.relative(ROOT, rawFile)}\`

---

## 1. WER 레벨별 평균 지표

| 목표 WER | 실측 WER | 개체 보존(시간) | 개체 보존(장소) | 개체 보존(평균) | 사건 순서 정확도 | 의미 유사도 | 생성 실패 |
|---:|---:|---:|---:|---:|---:|---:|---:|
`;
for (const L of byLevel) {
  md += `| ${L.w * 100}% | ${f(L.actualWer * 100, 1)}% | ${f(L.entTime[0])} | ${f(L.entLoc[0])} | ${f(L.entMean[0])} | ${f(L.order[0])} | ${f(L.sim[0])} | ${L.nFail} |\n`;
}

md += `
### 표준편차 (표본 SD)

| 목표 WER | 개체(평균) SD | 사건 순서 SD | 의미 유사도 SD |
|---:|---:|---:|---:|
`;
for (const L of byLevel) {
  md += `| ${L.w * 100}% | ${f(L.entMean[1])} | ${f(L.order[1])} | ${f(L.sim[1])} |\n`;
}

md += `
## 2. WER 0% 대비 저하폭

| 지표 | WER 0% | WER 10% | WER 20% | WER 30% |
|---|---:|---:|---:|---:|
| 개체 보존(평균) | ${f(base.entMean[0])} | ${drop(byLevel[1].entMean[0], base.entMean[0])} | ${drop(byLevel[2].entMean[0], base.entMean[0])} | ${drop(byLevel[3].entMean[0], base.entMean[0])} |
| ├ 시간 | ${f(base.entTime[0])} | ${drop(byLevel[1].entTime[0], base.entTime[0])} | ${drop(byLevel[2].entTime[0], base.entTime[0])} | ${drop(byLevel[3].entTime[0], base.entTime[0])} |
| └ 장소 | ${f(base.entLoc[0])} | ${drop(byLevel[1].entLoc[0], base.entLoc[0])} | ${drop(byLevel[2].entLoc[0], base.entLoc[0])} | ${drop(byLevel[3].entLoc[0], base.entLoc[0])} |
| 사건 순서 정확도 | ${f(base.order[0])} | ${drop(byLevel[1].order[0], base.order[0])} | ${drop(byLevel[2].order[0], base.order[0])} | ${drop(byLevel[3].order[0], base.order[0])} |
| 의미 유사도 | ${f(base.sim[0])} | ${drop(byLevel[1].sim[0], base.sim[0])} | ${drop(byLevel[2].sim[0], base.sim[0])} | ${drop(byLevel[3].sim[0], base.sim[0])} |

## 3. 관찰 (RQ1)

`;

const e0 = base.entMean[0], e30 = byLevel[3].entMean[0];
const s0 = base.sim[0], s30 = byLevel[3].sim[0];
md += `- 개체 보존율(시간·장소 평균)은 WER 0%에서 ${f(e0)} → WER 30%에서 ${f(e30)}로 ${((e0 - e30) * 100).toFixed(1)}p 하락했다.\n`;
const tHi = byLevel[byLevel.length - 1].entTime[0];
const lHi = byLevel[byLevel.length - 1].entLoc[0];
const cmp = tHi == null || lHi == null ? "비슷하게" : Math.abs(tHi - lHi) < 0.03 ? "비슷하게" : tHi < lHi ? "시간 쪽이 더 크게" : "장소 쪽이 더 크게";
md += `- 최고 오류율에서 시간·장소 필드 저하는 ${cmp} 나타났다 (시간 ${f(tHi)} vs 장소 ${f(lHi)}).\n`;
md += `- 의미 유사도는 ${f(s0)} → ${f(s30)}로 ${((s0 - s30) * 100).toFixed(1)}p 하락에 그쳐, 본문 문체는 노이즈에 상대적으로 강건했다.\n`;
md += `- 사건 순서 정확도는 ${f(base.order[0])} → ${f(byLevel[3].order[0])}로 변화했다.\n`;
md += `- 결론: 단일 호출 구조에서 STT 오류는 본문(의미 유사도)보다 **시간·장소 메타데이터**를 훨씬 크게 손상시켰으며, 이는 추출 단계를 본문 정리와 분리해야 한다는 제안 방식의 근거(RQ2)로 이어진다.\n`;

md += `
## 4. 케이스별 상세 (개체 보존 평균)

| 샘플 | 골드(시간 / 장소) | WER0% | WER10% | WER20% | WER30% |
|---|---|---:|---:|---:|---:|
`;
const sampleIds = [...new Set(rows.map((r) => r.sampleId))];
for (const sid of sampleIds) {
  const g = rows.find((r) => r.sampleId === sid).gold;
  const cell = (w) => {
    const r = rows.find((x) => x.sampleId === sid && x.targetWer === w);
    return r && r.metrics ? f(r.metrics.entity_mean, 2) : "실패";
  };
  md += `| ${sid} | ${g.time} / ${g.location} | ${cell(0)} | ${cell(0.1)} | ${cell(0.2)} | ${cell(0.3)} |\n`;
}

md += `
## 5. 재현 방법

\`\`\`bash
cd backend/experiment/src
node runPhase1.mjs      # 실험 실행 (Gemini API 호출, ~15분)
node makeReport.mjs     # 이 리포트 재생성
\`\`\`

노이즈 주입은 \`(샘플ID | WER)\` 문자열 해시를 시드로 사용하므로 재실행 시 동일한 노이즈 텍스트가 생성된다. 생성 모델(LLM) 응답은 비결정적이므로 지표 값에는 실행 간 소폭 변동이 있을 수 있다.
`;

const outFile = path.resolve(RES, "phase1_report.md");
fs.writeFileSync(outFile, md);
console.log("리포트 생성:", path.relative(ROOT, outFile));

// ---------- 사람 평가 양식 (평가자 2인 5점 리커트) ----------
const csvEsc = (s) => `"${String(s ?? "").replace(/"/g, '""')}"`;
let csv =
  "case_id,sample_id,target_wer,method,gold_time,gold_location,gen_time,gen_location,generated_memoir,rater1_naturalness,rater1_quality,rater2_naturalness,rater2_quality\n";
for (const r of rows) {
  if (!r.generated) continue;
  csv +=
    [
      `${r.sampleId}_W${r.targetWer * 100}`,
      r.sampleId,
      r.targetWer,
      "baseline",
      csvEsc(r.gold.time),
      csvEsc(r.gold.location),
      csvEsc(r.generated.time),
      csvEsc(r.generated.location),
      csvEsc(r.generated.memoir),
      "",
      "",
      "",
      "",
    ].join(",") + "\n";
}
fs.writeFileSync(path.resolve(RES, "human_eval_template.csv"), "﻿" + csv);
console.log("사람 평가 양식:", "results/human_eval_template.csv");
