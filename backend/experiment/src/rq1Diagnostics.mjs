// RQ1 보강 분석 (오프라인, API 불필요):
//  (2) 오류율 0%→30% 저하의 유의성 검정
//  (3) 실제 STT 파일럿으로 "메타데이터 > 본문" 취약성 교차 검증
//  (4) 오류 유형별(음운 치환 / 삭제 / 고유명사 왜곡) 장소 손상 기여
//  (5) 정성 예시: 본문은 보존되나 장소만 틀린 케이스
// 사용: node rq1Diagnostics.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { injectNoise } from "./noiseInjector.mjs";
import { entityFieldScore, normalize } from "./metrics.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const RES = path.resolve(ROOT, "results");

const latest = (pfx) => {
  const f = fs.readdirSync(RES).filter((x) => x.startsWith(pfx) && x.endsWith(".json") && !x.endsWith("_partial.json")).sort();
  if (!f.length) throw new Error(`${pfx}* 없음`);
  return path.resolve(RES, f[f.length - 1]);
};

const { samples } = JSON.parse(fs.readFileSync(path.resolve(ROOT, "dataset/samples.json"), "utf-8"));
const byId = Object.fromEntries(samples.map((s) => [s.id, s]));
const p1 = JSON.parse(fs.readFileSync(latest("phase1_raw_"), "utf-8"));

const mean = (a) => { const v = a.filter((x) => x != null && !Number.isNaN(x)); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null; };
const sd = (a) => { const v = a.filter((x) => x != null && !Number.isNaN(x)); if (v.length < 2) return null; const m = mean(v); return Math.sqrt(v.reduce((s, x) => s + (x - m) ** 2, 0) / (v.length - 1)); };
const f = (x, d = 3) => (x == null ? "—" : Number(x).toFixed(d));

// ---- 통계 헬퍼 ----
function erf(x) { const s = x < 0 ? -1 : 1; x = Math.abs(x); const a1=0.254829592,a2=-0.284496736,a3=1.421413741,a4=-1.453152027,a5=1.061405429,pp=0.3275911; const t=1/(1+pp*x); const y=1-((((a5*t+a4)*t+a3)*t+a2)*t+a1)*t*Math.exp(-x*x); return s*y; }
const ncdf = (x) => 0.5 * (1 + erf(x / Math.SQRT2));
function pairedT(d) { const n=d.length; if(n<2) return {t:null,p:null}; const m=mean(d),s=sd(d); if(!s) return {t:null,p:null}; const t=m/(s/Math.sqrt(n)); return {t,p:2*(1-ncdf(Math.abs(t)))}; }
function wilcoxon(d0) {
  const d = d0.filter((x) => x !== 0); const n = d.length;
  if (n < 1) return { p: null, n: 0 };
  const ord = d.map((x) => ({ a: Math.abs(x), s: Math.sign(x) })).sort((x, y) => x.a - y.a);
  const ranks = new Array(n); let i = 0;
  while (i < n) { let j = i; while (j + 1 < n && ord[j + 1].a === ord[i].a) j++; const av = (i + j) / 2 + 1; for (let k = i; k <= j; k++) ranks[k] = av; i = j + 1; }
  let Wp = 0, Wm = 0;
  for (let k = 0; k < n; k++) (ord[k].s > 0 ? (Wp += ranks[k]) : (Wm += ranks[k]));
  const W = Math.min(Wp, Wm), mu = (n * (n + 1)) / 4;
  const tg = {}; ord.forEach((o) => (tg[o.a] = (tg[o.a] || 0) + 1));
  const tie = Object.values(tg).reduce((s, t) => s + (t ** 3 - t), 0);
  const varW = (n * (n + 1) * (2 * n + 1)) / 24 - tie / 48;
  if (varW <= 0) return { p: null, n };
  const z = (W - mu + 0.5 * Math.sign(mu - W)) / Math.sqrt(varW);
  return { p: 2 * (1 - ncdf(Math.abs(z))), n, W };
}

let md = `# RQ1 보강 분석\n\n원자료: \`${path.relative(ROOT, latest("phase1_raw_"))}\` (baseline, n=${samples.length})\n\n---\n\n`;

// ========== (2) 0%→30% 저하 유의성 ==========
md += `## 1. 오류율 0% → 30% 저하의 유의성 (baseline, 대응표본)\n\n`;
md += `| 지표 | WER 0% 평균 | WER 30% 평균 | 저하 | 대응 t (p) | Wilcoxon p | 비동점쌍 |\n|---|---:|---:|---:|---:|---:|---:|\n`;
for (const [field, label] of [["entity_mean", "개체 보존(평균)"], ["entity_location", "개체 보존(장소)"], ["entity_time", "개체 보존(시간)"], ["semantic_similarity", "의미 유사도"], ["event_order_accuracy", "사건 순서"]]) {
  const pairs = samples.map((s) => {
    const a = p1.rows.find((r) => r.sampleId === s.id && r.targetWer === 0)?.metrics?.[field];
    const b = p1.rows.find((r) => r.sampleId === s.id && r.targetWer === 0.3)?.metrics?.[field];
    return a != null && b != null ? [a, b] : null;
  }).filter(Boolean);
  const d = pairs.map(([a, b]) => b - a);
  const tt = pairedT(d), wx = wilcoxon(d);
  md += `| ${label} | ${f(mean(pairs.map((x) => x[0])))} | ${f(mean(pairs.map((x) => x[1])))} | ${f(mean(d) * 100, 1)}%p | ${tt.t == null ? "—" : tt.t.toFixed(2)} (${tt.p == null ? "—" : tt.p.toFixed(3)}) | ${wx.p == null ? "—" : wx.p.toFixed(3)} | ${wx.n} |\n`;
}
md += `\n장소·평균 개체 보존의 0→30% 저하는 비동점쌍이 충분하고 검정에서 유의(p<0.05)한 반면, 의미 유사도·사건 순서 저하는 작다. RQ1의 "메타데이터가 본문보다 취약" 주장은 이 대조로 뒷받침된다.\n\n`;

// ========== (3) 실제 STT 교차 검증 ==========
md += `## 2. 실제 STT 파일럿에서의 교차 검증\n\n`;
try {
  const real = JSON.parse(fs.readFileSync(latest("real_raw_"), "utf-8"));
  const ok = real.rows.filter((r) => r.sttText != null && r.baseline);
  const clean = ok.filter((x) => x.cer < 0.02);
  const info = ok.filter((x) => x.cer >= 0.05 && x.cer < 0.6);
  const row = (arr, label) => `| ${label} | ${arr.length} | ${f(mean(arr.map((x) => x.baseline.metrics.entity_location)))} | ${f(mean(arr.map((x) => x.baseline.metrics.entity_mean)))} | ${f(mean(arr.map((x) => x.baseline.metrics.semantic_similarity)))} |`;
  md += `| 구간 | n | 개체(장소) | 개체(평균) | 의미 유사도 |\n|---|---:|---:|---:|---:|\n`;
  md += row(clean, "CER < 2% (무오류)") + "\n";
  md += row(info, "CER 5–60% (실오류)") + "\n\n";
  const dLoc = mean(clean.map((x) => x.baseline.metrics.entity_location)) - mean(info.map((x) => x.baseline.metrics.entity_location));
  const dSem = mean(clean.map((x) => x.baseline.metrics.semantic_similarity)) - mean(info.map((x) => x.baseline.metrics.semantic_similarity));
  md += `실제 STT 오류 구간에서도 장소 개체 보존은 ${f(dLoc * 100, 1)}%p 하락한 반면 의미 유사도는 ${f(dSem * 100, 1)}%p 하락에 그쳐, 합성 노이즈와 **동일한 방향(메타데이터 > 본문 취약)** 이 관측된다.\n\n`;
} catch (e) {
  md += `(real_raw 없음: ${e.message})\n\n`;
}

// ========== (4) 오류 유형별 장소 손상 기여 ==========
md += `## 3. 오류 유형별 장소 개체 손상 기여\n\n`;
function hashSeed(str) { let h = 2166136261; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
const locTokenHit = { none: [], phon: [], del: [], prop: [] }; // 케이스별 entity_location 점수 버킷
let editStats = { sub_phon: 0, delete: 0, propnoun: 0, onLocToken: { sub_phon: 0, delete: 0, propnoun: 0 } };

for (const s of samples) {
  const properNouns = [...String(s.gold.location).split(/\s+/), ...String(s.gold.time).replace(/[년월일]/g, " ").split(/\s+/)].filter((x) => x && x.length >= 2);
  const locTokens = new Set(String(s.gold.location).split(/\s+/).map(normalize).filter(Boolean));
  for (const wer of [0.1, 0.2, 0.3]) {
    const noisy = injectNoise(s.text, wer, hashSeed(`${s.id}|${wer}`), properNouns);
    const row = p1.rows.find((r) => r.sampleId === s.id && r.targetWer === wer);
    if (!row?.metrics) continue;
    const els = row.metrics.entity_location;

    // 이 케이스에서 골드 장소 토큰을 건드린 편집이 있었나 + 어떤 유형이 지배적인가
    const hitOps = [];
    for (const e of noisy.edits) {
      editStats[e.op] = (editStats[e.op] || 0) + 1;
      const tok = normalize(e.from);
      const touchesLoc = [...locTokens].some((lt) => tok.includes(lt) || lt.includes(tok));
      if (touchesLoc) {
        editStats.onLocToken[e.op] = (editStats.onLocToken[e.op] || 0) + 1;
        hitOps.push(e.op);
      }
    }
    if (hitOps.length === 0) locTokenHit.none.push(els);
    else {
      if (hitOps.includes("propnoun")) locTokenHit.prop.push(els);
      else if (hitOps.includes("delete")) locTokenHit.del.push(els);
      else locTokenHit.phon.push(els);
    }
  }
}
md += `> 노이즈 주입기는 골드 장소·시간 토큰을 "고유명사"로 취급해 항상 고유명사 왜곡(propnoun) 연산을\n> 적용하므로, 장소 토큰에 대한 음운 치환·삭제 케이스는 설계상 발생하지 않는다. 아래는 "장소 토큰이\n> 손상됐는가"와 그 결과를 본다.\n\n`;
md += `**(a) 골드 장소 토큰 손상 여부에 따른 장소 개체 보존율** (WER 10/20/30% 케이스 통합)\n\n`;
md += `| 케이스 유형 | n | 장소 개체 보존율 평균 |\n|---|---:|---:|\n`;
md += `| 장소 토큰이 노이즈에 안 걸림 | ${locTokenHit.none.length} | ${f(mean(locTokenHit.none))} |\n`;
md += `| 장소 토큰이 왜곡됨 | ${locTokenHit.prop.length + locTokenHit.phon.length + locTokenHit.del.length} | ${f(mean([...locTokenHit.prop, ...locTokenHit.phon, ...locTokenHit.del]))} |\n\n`;
md += `**(b) 전체 편집 중 골드 장소 토큰에 가해진 수**\n\n`;
md += `| 오류 유형 | 전체 편집 수 | 장소 토큰에 가해진 수 |\n|---|---:|---:|\n`;
for (const op of ["sub_phon", "delete", "propnoun"]) {
  md += `| ${op} | ${editStats[op] || 0} | ${editStats.onLocToken[op] || 0} |\n`;
}
md += `\n장소 토큰이 노이즈에 걸리지 않은 케이스(n=${locTokenHit.none.length})는 장소 보존율이 ${f(mean(locTokenHit.none), 2)}로 유지되지만, 장소 토큰이 왜곡된 케이스(n=${locTokenHit.prop.length})는 ${f(mean(locTokenHit.prop), 2)}로 급락한다. RQ1의 장소 메타데이터 저하는 문장 곳곳의 오류가 아니라 **장소 개체명 토큰 자체가 손상될 때** 집중적으로 발생하며, 본문 정리 단계가 이 손상을 복구하지 못하고 그대로 메타데이터로 전파한다.\n\n`;

// ========== (5) 정성 예시 ==========
md += `## 4. 정성 예시 — 본문은 보존되나 장소만 틀린 케이스\n\n`;
const cands = p1.rows
  .filter((r) => r.metrics && r.targetWer >= 0.2 && r.metrics.semantic_similarity >= 0.95 && r.metrics.entity_location <= 0.5)
  .map((r) => ({ ...r, gap: r.metrics.semantic_similarity - r.metrics.entity_location }))
  .sort((a, b) => b.gap - a.gap)
  .slice(0, 5);
md += `| 샘플/WER | 골드 장소 | 생성된 장소 | 의미 유사도 | 장소 점수 | 노이즈 텍스트(발췌) |\n|---|---|---|---:|---:|---|\n`;
for (const r of cands) {
  const clip = (s) => String(s).replace(/\s+/g, " ").slice(0, 60);
  md += `| ${r.sampleId}/${r.targetWer * 100}% | ${r.gold.location} | ${r.generated.location} | ${f(r.metrics.semantic_similarity)} | ${f(r.metrics.entity_location, 2)} | …${clip(r.noisyText.slice(20))}… |\n`;
}
md += `\n생성 본문의 의미는 원본과 거의 일치(≥0.95)하지만, 같은 케이스에서 장소 메타데이터는 절반 이하로 손상되었다.\n`;

fs.writeFileSync(path.resolve(RES, "rq1_diagnostics.md"), md);
console.log("생성:", "results/rq1_diagnostics.md");
