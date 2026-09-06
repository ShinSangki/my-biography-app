// 사람 평가 채점: human_eval_blind.csv(작성 완료) + human_eval_key.csv 를 읽어
//  - 방식별(baseline/proposed) 자연스러움·전체 품질 평균
//  - 평가자 간 일치도: 가중 Cohen's kappa (5점 순서형, quadratic weights)
//  - WER 레벨별 방식 차이
// 사용: node scoreHumanEval.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RES = path.resolve(__dirname, "..", "results");

function readCsv(file) {
  let text = fs.readFileSync(file, "utf-8").replace(/^﻿/, "");
  const rows = [];
  const lines = text.split(/\r?\n/).filter((l) => l.length);
  const header = parseLine(lines[0]);
  for (let i = 1; i < lines.length; i++) {
    const cells = parseLine(lines[i]);
    const obj = {};
    header.forEach((h, j) => (obj[h] = cells[j]));
    rows.push(obj);
  }
  return rows;
}
function parseLine(line) {
  const out = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ",") { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

const blindPath = path.resolve(RES, "human_eval_blind.csv");
const keyPath = path.resolve(RES, "human_eval_key.csv");
if (!fs.existsSync(blindPath) || !fs.existsSync(keyPath)) {
  console.error("human_eval_blind.csv / human_eval_key.csv 가 없습니다. 먼저 node makeHumanEval.mjs 실행 후 평가지를 채우세요.");
  process.exit(1);
}

const blind = readCsv(blindPath);
const keyRows = readCsv(keyPath);
const keyMap = new Map(keyRows.map((r) => [r.case_id, r]));

const num = (x) => {
  const n = Number(x);
  return Number.isFinite(n) && n >= 1 && n <= 5 ? n : null;
};

// method -> {naturalness:[], quality:[]}, byWer, 평가자별 점수(kappa용)
const scores = { baseline: { nat: [], qual: [] }, proposed: { nat: [], qual: [] } };
const byWer = {}; // wer -> { baseline:{nat,qual}, proposed:{nat,qual} }
const raterPairs = { nat: [[], []], qual: [[], []] }; // [rater1values, rater2values] aligned by (case, slot)

const perCaseRater = {}; // caseId -> rater -> {A_nat,A_qual,B_nat,B_qual}
let filled = 0;
let total = 0;

for (const row of blind) {
  total++;
  const k = keyMap.get(row.case_id);
  if (!k) continue;
  const rater = row.rater;
  const vals = {
    A_nat: num(row.A_naturalness), A_qual: num(row.A_quality),
    B_nat: num(row.B_naturalness), B_qual: num(row.B_quality),
  };
  if (vals.A_nat == null && vals.B_nat == null && vals.A_qual == null && vals.B_qual == null) continue;
  filled++;

  perCaseRater[row.case_id] = perCaseRater[row.case_id] || {};
  perCaseRater[row.case_id][rater] = { ...vals, A_method: k.A_method, B_method: k.B_method, wer: Number(k.target_wer) };

  for (const slot of ["A", "B"]) {
    const method = k[`${slot}_method`];
    const nat = vals[`${slot}_nat`];
    const qual = vals[`${slot}_qual`];
    if (nat != null) scores[method].nat.push(nat);
    if (qual != null) scores[method].qual.push(qual);
    const w = Number(k.target_wer);
    byWer[w] = byWer[w] || { baseline: { nat: [], qual: [] }, proposed: { nat: [], qual: [] } };
    if (nat != null) byWer[w][method].nat.push(nat);
    if (qual != null) byWer[w][method].qual.push(qual);
  }
}

// kappa: 같은 케이스를 두 평가자가 매긴 slot 점수쌍을 모은다
for (const caseId of Object.keys(perCaseRater)) {
  const rr = perCaseRater[caseId];
  if (!rr["1"] || !rr["2"]) continue;
  for (const slot of ["A", "B"]) {
    for (const [dim, arrIdx] of [["nat", "nat"], ["qual", "qual"]]) {
      const v1 = rr["1"][`${slot}_${dim}`];
      const v2 = rr["2"][`${slot}_${dim}`];
      if (v1 != null && v2 != null) {
        raterPairs[arrIdx][0].push(v1);
        raterPairs[arrIdx][1].push(v2);
      }
    }
  }
}

const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const sd = (a) => {
  if (a.length < 2) return null;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
};
const f = (x, d = 2) => (x == null ? "—" : Number(x).toFixed(d));

// 가중 Cohen's kappa (quadratic), 카테고리 1..5
function weightedKappa(r1, r2) {
  const cats = [1, 2, 3, 4, 5];
  const n = r1.length;
  if (n < 2) return null;
  const O = cats.map(() => cats.map(() => 0));
  const idx = (v) => v - 1;
  for (let i = 0; i < n; i++) O[idx(r1[i])][idx(r2[i])]++;
  const row = cats.map((_, i) => O[i].reduce((s, x) => s + x, 0));
  const col = cats.map((_, j) => cats.reduce((s, _c, i) => s + O[i][j], 0));
  const W = cats.map((_, i) => cats.map((_, j) => ((i - j) ** 2) / (cats.length - 1) ** 2));
  let numr = 0, den = 0;
  for (let i = 0; i < cats.length; i++)
    for (let j = 0; j < cats.length; j++) {
      const e = (row[i] * col[j]) / n;
      numr += W[i][j] * O[i][j];
      den += W[i][j] * e;
    }
  return den === 0 ? null : 1 - numr / den;
}

let md = `# 사람 평가 채점 결과

**응답:** ${filled} / ${total} 행 작성됨\n\n`;

if (filled === 0) {
  md += "평가지가 아직 비어 있습니다. `results/human_eval_blind.csv` 의 점수칸을 채운 뒤 다시 실행하세요.\n";
  fs.writeFileSync(path.resolve(RES, "human_eval_result.md"), md);
  console.log(md);
  process.exit(0);
}

md += `## 1. 방식별 평균 (평가자 2인 통합, 1–5)

| 지표 | baseline | 제안 | Δ(제안-baseline) |
|---|---:|---:|---:|
| 자연스러움 | ${f(mean(scores.baseline.nat))} (SD ${f(sd(scores.baseline.nat))}) | ${f(mean(scores.proposed.nat))} (SD ${f(sd(scores.proposed.nat))}) | ${f(mean(scores.proposed.nat) - mean(scores.baseline.nat))} |
| 전체 품질 | ${f(mean(scores.baseline.qual))} (SD ${f(sd(scores.baseline.qual))}) | ${f(mean(scores.proposed.qual))} (SD ${f(sd(scores.proposed.qual))}) | ${f(mean(scores.proposed.qual) - mean(scores.baseline.qual))} |

n(자연스러움) baseline ${scores.baseline.nat.length} / 제안 ${scores.proposed.nat.length}

## 2. WER 레벨별 전체 품질

| WER | baseline | 제안 |
|---:|---:|---:|
`;
for (const w of Object.keys(byWer).map(Number).sort((a, b) => a - b)) {
  md += `| ${w * 100}% | ${f(mean(byWer[w].baseline.qual))} | ${f(mean(byWer[w].proposed.qual))} |\n`;
}

md += `
## 3. 평가자 간 일치도 (가중 Cohen's kappa, quadratic)

| 지표 | κ_w | 쌍 수 |
|---|---:|---:|
| 자연스러움 | ${f(weightedKappa(raterPairs.nat[0], raterPairs.nat[1]))} | ${raterPairs.nat[0].length} |
| 전체 품질 | ${f(weightedKappa(raterPairs.qual[0], raterPairs.qual[1]))} | ${raterPairs.qual[0].length} |

해석 기준(관례): <0 불일치, 0–0.2 slight, 0.2–0.4 fair, 0.4–0.6 moderate, 0.6–0.8 substantial, >0.8 almost perfect.
`;

fs.writeFileSync(path.resolve(RES, "human_eval_result.md"), md);
console.log(md);
console.log("→ results/human_eval_result.md 저장");
