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

// 정보량 있는 구간 (STT 완전 붕괴 제외: CER < 0.6)
const informative = ok.filter((x) => x.cer < 0.6);
const collapsed = ok.filter((x) => x.cer >= 0.6);
const infoMid = informative.filter((x) => x.cer >= 0.05); // 실제 오류가 있는 구간
const midBe = mean(infoMid.map((x) => m(x, "baseline").entity_mean));
const midPe = mean(infoMid.map((x) => m(x, "proposed").entity_mean));

md += `
## 5. 관찰

- **실제 STT 는 이봉형(bimodal) 오류 프로파일을 보인다.** 음향이 양호하면(clean/noisy_mild) CER ~2–3% 로 거의 무오류, 심하게 열화되면(extreme) CER 80%+ 로 완전 붕괴 — 그 사이 완만한 구간이 좁다. 합성 노이즈의 매끄러운 WER 스윕(0→10→20→30%)과 다르다.
- **\`extreme\` 조건(${collapsed.length}케이스, CER≥60%)은 STT 가 문장을 통째로 환각한다** ("2,500년에서 2,600년 전의 일", "북한의 몽골비오 연구자"). 두 방식 모두 개체 보존 ≈ 0 — 비교에 무의미하므로 아래 논의에서 제외한다.
- **실제 오류가 존재하는 정보 구간(CER 5–60%, ${infoMid.length}케이스)에서 제안 방식의 이득이 합성 노이즈 실험처럼 재현되지 않았다:** baseline 개체 보존 ${f(midBe)} vs 제안 ${f(midPe)} (${pp((midPe ?? 0) - (midBe ?? 0))}). ${midPe >= midBe ? "" : "오히려 소폭 낮다. "}합성 노이즈(WER 20–30%)에서는 제안 방식이 +1~4%p 우세했던 것과 대비된다.
- **추정 원인:** 규칙 기반 합성 노이즈는 "명백히 깨진" 텍스트(\`견키 파주\`)를 만들어 원문·정리문 추출 후보가 서로 어긋나므로 선택적 보정이 신호를 얻는다. 반면 실제 STT 오류는 "유창하지만 틀린" 치환(\`파주\`→\`파저\`, 그럴듯한 오인식)이라 두 추출 경로가 **같은 틀린 값에 합의**해 버려 보정이 발동하지 않거나 틀린 쪽을 고른다.
- **결론:** 제안 파이프라인은 합성 노이즈라는 통제 환경에서는 개선 경향을 보였으나, 파일럿 규모의 실제 STT 오류에서는 그 이득이 전이되지 않았다. 이는 합성 노이즈와 실제 STT 오류의 **구조적 차이**를 시사하며, 제안 방식의 선택적 보정 트리거(추출 후보 불일치)가 실제 오류 특성에 맞게 재설계되어야 함을 뜻한다.

## 6. 재현

\`\`\`bash
cd backend/experiment/src
EXP_REAL_SAMPLES=12 node runPhaseReal.mjs   # TTS→STT, ~40분
node makeReportReal.mjs
\`\`\`
`;

fs.writeFileSync(path.resolve(RES, "real_stt_report.md"), md);
console.log("생태적 타당도 리포트:", "results/real_stt_report.md");
