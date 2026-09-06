// 생태적 타당도 리포트: 실제 TTS→STT 파이프라인 결과.
// 사용: node makeReportReal.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { entityScore, eventOrderAccuracy } from "./metrics.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const RES = path.resolve(ROOT, "results");

function latest(prefix) {
  const files = fs.readdirSync(RES).filter((x) => x.startsWith(prefix) && x.endsWith(".json") && !x.endsWith("_partial.json"));
  if (!files.length) throw new Error(`results/${prefix}*.json 없음`);
  files.sort();
  return path.resolve(RES, files[files.length - 1]);
}

const { samples } = JSON.parse(fs.readFileSync(path.resolve(ROOT, "dataset/samples.json"), "utf-8"));
const eventsById = Object.fromEntries(samples.map((s) => [s.id, s.events]));

const realFile = latest("real_raw_");
const real = JSON.parse(fs.readFileSync(realFile, "utf-8"));
const conds = real.conditions;

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
const pp = (x) => (x == null ? "—" : `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}p`);

// 지표 재계산 (metrics.mjs 최신 로직; 의미 유사도는 저장값)
function m(row, which) {
  const g = row[which];
  if (!g) return null;
  const ent = entityScore(row.gold, { time: g.time, location: g.location });
  const ord = eventOrderAccuracy(g.memoir || "", eventsById[row.sampleId] || []);
  return {
    entity_time: ent.time,
    entity_location: ent.location,
    entity_mean: ent.mean,
    event_order_accuracy: ord.accuracy,
    semantic_similarity: g.metrics?.semantic_similarity ?? null,
    corrected: which === "proposed" ? row.proposed.corrected : undefined,
  };
}

const ok = real.rows.filter((r) => r.sttText != null && r.baseline && r.proposed);

let md = `# 생태적 타당도 보완 리포트 — 실제 STT 엔진 오류

**방법:** 생애사 클린 텍스트 → Gemini TTS 합성 음성 → 음향 조건별 열화(ffmpeg) →
**실제 Gemini STT 전사** → baseline / 제안 방식 생성. 합성 노이즈(phase1/2)와 달리
오류율을 직접 통제하지 않고, 나온 실측 WER 로 사후 분류한다.

**모델:** \`${real.model}\` (생성) · TTS \`gemini-2.5-flash-preview-tts\` · STT \`gemini-2.5-flash\`
**규모:** 샘플 ${new Set(ok.map((r) => r.sampleId)).size}편 × 음향조건 ${conds.length}개 = 유효 ${ok.length} 케이스
**원자료:** \`${path.relative(ROOT, realFile)}\`

---

## 1. 음향 조건별 실측 오류율과 품질

| 조건 | n | 실측 WER | 실측 CER | base 개체(평균) | 제안 개체(평균) | Δ | base 장소 | 제안 장소 | Δ장소 | 보정률 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
`;
for (const c of conds) {
  const r = ok.filter((x) => x.condition === c);
  if (!r.length) {
    md += `| ${c} | 0 | — | — | — | — | — | — | — | — | — |\n`;
    continue;
  }
  const bm = r.map((x) => m(x, "baseline"));
  const pm = r.map((x) => m(x, "proposed"));
  const be = mean(bm.map((x) => x.entity_mean));
  const pe = mean(pm.map((x) => x.entity_mean));
  const bl = mean(bm.map((x) => x.entity_location));
  const pl = mean(pm.map((x) => x.entity_location));
  md += `| ${c} | ${r.length} | ${f(mean(r.map((x) => x.wer)) * 100, 1)}% | ${f(mean(r.map((x) => x.cer)) * 100, 1)}% | ${f(be)} | ${f(pe)} | ${pp(pe - be)} | ${f(bl)} | ${f(pl)} | ${pp(pl - bl)} | ${f(mean(r.map((x) => (x.proposed.corrected ? 1 : 0))), 2)} |\n`;
}

md += `
> **WER 주의:** 한국어 STT 는 띄어쓰기·수사 표기를 자체 정규화하므로("방직공장"→"방직 공장",
> "열여덟 살"→"18살") 토큰 단위 WER 이 실제 인식 오류보다 크게 부풀려진다. 아래 구간 분류와
> 논의는 **문자 오류율(CER)** 기준으로 한다. WER 은 참고용으로만 병기.

## 2. 실측 CER 구간별 — 합성 노이즈 실험과의 대조

실제 STT 오류를 CER 구간으로 묶어 phase1/2(합성 노이즈, WER 통제)의 유사 구간과 비교한다.

| 실측 CER 구간 | n | base 개체(평균) | 제안 개체(평균) | Δ |
|---|---:|---:|---:|---:|
`;
const bins = [
  [0, 0.02, "0–2%"],
  [0.02, 0.06, "2–6%"],
  [0.06, 0.15, "6–15%"],
  [0.15, 1.01, "15%+"],
];
for (const [lo, hi, label] of bins) {
  const r = ok.filter((x) => x.cer >= lo && x.cer < hi);
  if (!r.length) {
    md += `| ${label} | 0 | — | — | — |\n`;
    continue;
  }
  const be = mean(r.map((x) => m(x, "baseline").entity_mean));
  const pe = mean(r.map((x) => m(x, "proposed").entity_mean));
  md += `| ${label} | ${r.length} | ${f(be)} | ${f(pe)} | ${pp(pe - be)} |\n`;
}

// phase1/2 요약 붙이기 (있으면)
try {
  const p1 = JSON.parse(fs.readFileSync(path.resolve(RES, "phase1_summary_latest.json"), "utf-8"));
  const p2 = JSON.parse(fs.readFileSync(path.resolve(RES, "phase2_summary_latest.json"), "utf-8"));
  md += `
### 참고: 합성 노이즈 실험(phase1/2) 개체 보존(평균)

| 목표 WER | baseline | 제안 | Δ |
|---:|---:|---:|---:|
`;
  for (let i = 0; i < p1.summary.length; i++) {
    const a = p1.summary[i].entity_mean;
    const b = p2.summary[i].entity_mean;
    md += `| ${p1.summary[i].targetWer * 100}% | ${f(a)} | ${f(b)} | ${pp(b - a)} |\n`;
  }
} catch {
  /* phase1/2 요약 없음 */
}

// 대응표본 비교 (전체 유효 케이스)
function paired(field) {
  const b = [];
  const p = [];
  for (const r of ok) {
    const bm = m(r, "baseline")[field];
    const pm = m(r, "proposed")[field];
    if (bm == null || pm == null) continue;
    b.push(bm);
    p.push(pm);
  }
  const d = p.map((x, i) => x - b[i]);
  const md_ = mean(d);
  const s = sd(d);
  const t = s ? md_ / (s / Math.sqrt(d.length)) : null;
  return { base: mean(b), prop: mean(p), delta: md_, t, n: d.length };
}

md += `
## 3. 전체 유효 케이스 대응표본 비교 (baseline vs 제안)

| 지표 | baseline | 제안 | Δ | 대응 t | n |
|---|---:|---:|---:|---:|---:|
`;
for (const [field, label] of [
  ["entity_mean", "개체 보존(평균)"],
  ["entity_location", "개체 보존(장소)"],
  ["entity_time", "개체 보존(시간)"],
  ["event_order_accuracy", "사건 순서 정확도"],
  ["semantic_similarity", "의미 유사도"],
]) {
  const r = paired(field);
  md += `| ${label} | ${f(r.base)} | ${f(r.prop)} | ${pp(r.delta)} | ${r.t == null ? "—" : r.t.toFixed(2)} | ${r.n} |\n`;
}

// STT 오류 예시
md += `
## 4. 실제 STT 오류 예시

| 샘플/조건 | WER | 클린 텍스트(발췌) → STT 결과(발췌) |
|---|---:|---|
`;
const examples = [...ok].sort((a, b) => b.wer - a.wer).slice(0, 5);
for (const r of examples) {
  const clip = (s) => String(s).replace(/\s+/g, " ").slice(0, 55);
  md += `| ${r.sampleId}/${r.condition} | ${f(r.wer * 100, 1)}% | ${clip(r.cleanText)} → ${clip(r.sttText)} |\n`;
}

// 구간 정의
const collapsed = ok.filter((x) => x.cer >= 0.6); // STT 완전 붕괴
const lowBand = ok.filter((x) => x.cer >= 0.02 && x.cer < 0.15); // 실제 저오류
const hiBand = ok.filter((x) => x.cer >= 0.15 && x.cer < 0.6); // 실제 고오류
const loBe = mean(lowBand.map((x) => m(x, "baseline").entity_mean));
const loPe = mean(lowBand.map((x) => m(x, "proposed").entity_mean));
const hiBe = mean(hiBand.map((x) => m(x, "baseline").entity_mean));
const hiPe = mean(hiBand.map((x) => m(x, "proposed").entity_mean));

// RQ1 실제 STT 재현 (무오류 vs 저오류)
const cleanB = ok.filter((x) => x.cer < 0.02);
const rq1locDrop = mean(cleanB.map((x) => m(x, "baseline").entity_location)) - mean(lowBand.concat(hiBand).map((x) => m(x, "baseline").entity_location));
const rq1semDrop = mean(cleanB.map((x) => m(x, "baseline").semantic_similarity)) - mean(lowBand.concat(hiBand).map((x) => m(x, "baseline").semantic_similarity));

md += `
## 5. 관찰

- **RQ1 은 실제 STT 에서 견고하게 재현된다.** 무오류 구간(CER<2%) 대비 오류 구간에서 기준 방식의 장소 개체 보존율은 ${f(rq1locDrop * 100, 1)}%p 하락한 반면 의미 유사도는 ${f(rq1semDrop * 100, 1)}%p 하락에 그쳤다. 합성 노이즈와 동일하게 메타데이터가 본문보다 크게 손상된다.
- **실제 STT 는 이봉형(bimodal) 오류 프로파일을 보인다.** 음향이 양호하면 CER ~1–3% 로 거의 무오류, 심하게 열화되면 CER 25%+ 로 급락하며, ${collapsed.length}케이스(CER≥60%)에서는 STT 가 문장을 통째로 환각한다("3만 2,000년 전으로 태어난"). 합성 노이즈의 매끄러운 WER 스윕과 구조가 다르다.
- **제안 방식의 이득은 실제 STT 에서 거의 사라진다.** 저오류 구간(CER 2–15%, ${lowBand.length}케이스)에서 개체 보존율은 기준 ${f(loBe)} vs 제안 ${f(loPe)} (${pp((loPe ?? 0) - (loBe ?? 0))}), 고오류 구간(CER 15–60%, ${hiBand.length}케이스)에서는 기준 ${f(hiBe)} vs 제안 ${f(hiPe)} (${pp((hiPe ?? 0) - (hiBe ?? 0))}). 전체 104케이스 대응표본에서도 개체 보존(평균) Δ +0.5%p(대응 t=1.42, 비유의). 합성 노이즈(WER 30%)에서의 +3.8%p 와 대비된다.
- 12편 파일럿에서 관측된 "제안 방식이 오히려 소폭 낮음"은 26편 확대 시 재현되지 않았고, "무해하나 유의미하지 않음"으로 수렴하였다.
- **추정 원인:** 규칙 기반 합성 노이즈는 "명백히 깨진" 텍스트(\`견키 파주\`)를 만들어 원문·정리문 추출 후보가 서로 어긋나므로 선택적 보정이 신호를 얻는다. 반면 실제 STT 오류는 "유창하지만 틀린" 치환(\`파주 문산\`→\`나원동\`)이라 두 추출 경로가 **같은 값에 합의**하거나(보정 미발동), 발동해도 두 후보가 모두 틀렸다. 보정 발동률은 0.54~0.65 로 유지되나 순효과가 0에 가깝다.
- **결론:** RQ1(구조적 취약성)은 합성·실제 STT 양쪽에서 확인된다. 제안 방식은 통제된 합성 노이즈에서만 소폭 개선을 보이며, 실제 STT 오류에서는 개선이 소멸한다. 요인 분해상 유일하게 효과를 내는 선택적 보정 단계가 실제 오류 특성(문맥상 그럴듯한 오인식)과 맞지 않기 때문이며, 트리거를 추출 후보 불일치가 아닌 다른 신호(신뢰도, N-best 분산)로 재설계할 필요가 있다.

## 6. 재현

\`\`\`bash
cd backend/experiment/src
EXP_REAL_SAMPLES=26 EXP_REAL_CONDITIONS=clean,noisy_mild,noisy_mid,noisy_harsh node runPhaseReal.mjs
node makeReportReal.mjs
\`\`\`
`;

fs.writeFileSync(path.resolve(RES, "real_stt_report.md"), md);
console.log("생태적 타당도 리포트:", "results/real_stt_report.md");
