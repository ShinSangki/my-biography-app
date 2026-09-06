// 논문 IV.2 "사람 평가" 준비: baseline(phase1) vs 제안(phase2) 생성문을 같은 케이스끼리
// 쌍으로 묶고, 각 쌍의 좌/우(A/B)를 무작위로 섞어 평가자가 방식을 모르게 한다(블라인드).
//
// 출력:
//   results/human_eval_blind.csv   평가자용 (case_id, wer, A본문, B본문, 빈 점수칸 4개)
//   results/human_eval_key.csv     정답키 (case_id → A/B 각각 어느 방식인지)
//
// 평가자는 각 본문에 자연스러움(1–5), 전체 품질(1–5)을 매긴다. 평가자 2인.
// 사용: node makeHumanEval.mjs [--seed 42]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const RES = path.resolve(ROOT, "results");

function latest(prefix) {
  const files = fs
    .readdirSync(RES)
    .filter((f) => f.startsWith(prefix) && f.endsWith(".json") && !f.endsWith("_partial.json"));
  if (!files.length) throw new Error(`results/${prefix}*.json 없음 — 해당 단계를 먼저 실행하세요.`);
  files.sort();
  return path.resolve(RES, files[files.length - 1]);
}

const seedArg = process.argv.indexOf("--seed");
let seed = (seedArg >= 0 ? Number(process.argv[seedArg + 1]) : 42) >>> 0;
function rand() {
  // mulberry32
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

const p1 = JSON.parse(fs.readFileSync(latest("phase1_raw_"), "utf-8"));
const p2 = JSON.parse(fs.readFileSync(latest("phase2_raw_"), "utf-8"));

const key = (r) => `${r.sampleId}|${r.targetWer}`;
const m2 = new Map(p2.rows.map((r) => [key(r), r]));

const pairs = [];
for (const b of p1.rows) {
  const pr = m2.get(key(b));
  if (!b.generated || !pr?.generated) continue;
  pairs.push({
    caseId: `${b.sampleId}_W${b.targetWer * 100}`,
    sampleId: b.sampleId,
    wer: b.targetWer,
    baseline: b.generated.memoir,
    proposed: pr.generated.memoir,
  });
}
// 케이스 순서도 섞는다
for (let i = pairs.length - 1; i > 0; i--) {
  const j = Math.floor(rand() * (i + 1));
  [pairs[i], pairs[j]] = [pairs[j], pairs[i]];
}

const csvEsc = (s) => `"${String(s ?? "").replace(/"/g, '""')}"`;

let blind = "case_id,target_wer,text_A,text_B,rater,A_naturalness,A_quality,B_naturalness,B_quality\n";
let answer = "case_id,target_wer,A_method,B_method\n";

for (const p of pairs) {
  const proposedIsA = rand() < 0.5;
  const A = proposedIsA ? p.proposed : p.baseline;
  const B = proposedIsA ? p.baseline : p.proposed;
  // 평가자 2인 → 행 2개(rater 1,2). 점수칸은 비워 둔다.
  for (const rater of [1, 2]) {
    blind += [p.caseId, p.wer, csvEsc(A), csvEsc(B), rater, "", "", "", ""].join(",") + "\n";
  }
  answer +=
    [p.caseId, p.wer, proposedIsA ? "proposed" : "baseline", proposedIsA ? "baseline" : "proposed"].join(",") + "\n";
}

fs.writeFileSync(path.resolve(RES, "human_eval_blind.csv"), "﻿" + blind);
fs.writeFileSync(path.resolve(RES, "human_eval_key.csv"), "﻿" + answer);
console.log(`블라인드 평가지: results/human_eval_blind.csv  (${pairs.length}쌍 × 평가자 2인 = ${pairs.length * 2}행)`);
console.log(`정답키:          results/human_eval_key.csv   (평가 완료 전까지 평가자에게 공개 금지)`);
console.log(`\n평가 방법: 각 행의 text_A, text_B 를 읽고 자연스러움(1–5)·전체 품질(1–5)을 A/B 각각 기입.`);
console.log(`완료 후:  node scoreHumanEval.mjs`);
