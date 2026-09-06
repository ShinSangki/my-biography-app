// 논문 IV.2 "평가 지표" 구현.
//  (1) 개체 보존율  : 원본 대비 시간·장소 개체명 일치율
//  (2) 의미 유사도  : 원본-생성문 임베딩 코사인 유사도 (BERTScore 대용, gemini-embedding-001)
//  (3) 사건 순서 정확도 : 사건 순서쌍(pairwise ordering) 일치율

import { GoogleGenAI } from "@google/genai";

// ---------- 공통 정규화 ----------
export function normalize(s) {
  return String(s ?? "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[.,!?~"'()[\]{}·…\-–—:;]/g, "");
}

const UNKNOWN_TOKENS = ["알수없음", "미상", "불명", "없음", "none", "unknown", "n/a"];
function isUnknown(s) {
  const n = normalize(s);
  return n === "" || UNKNOWN_TOKENS.includes(n);
}

// ---------- (1) 개체 보존율 ----------
// 하나의 예측값(추출기가 쉼표로 여러 값을 나열하기도 함)과 골드 1개를 비교.
function scoreOne(goldValue, predValue) {
  const g = normalize(goldValue);
  const p = normalize(predValue);
  if (isUnknown(predValue)) return 0.0;
  if (g === p) return 1.0;
  if (p.includes(g)) return 1.0; // 골드를 온전히 포함(부가 정보만 추가) → 보존됨
  if (g.includes(p)) return 0.5; // 골드의 일부만 담음(정보 누락)
  const gy = (String(goldValue).match(/\d{4}/) || [])[0];
  const py = (String(predValue).match(/\d{4}/) || [])[0];
  if (gy && py && gy === py) return 0.5; // 연도만 일치
  return 0.0;
}

// 필드별 점수: 완전일치=1.0, 부분=0.5, 그 외/불명=0.0.
// STT 강건성만 분리 측정하기 위해, 추출기가 "A, B, C"처럼 여러 값을 나열하면
// 구성요소 중 최고 점수를 취한다(정답 개체가 출력에 남아있는지가 관심사).
export function entityFieldScore(goldValue, predValue) {
  if (isUnknown(goldValue)) return isUnknown(predValue) ? 1.0 : 0.0;
  if (isUnknown(predValue)) return 0.0;
  const parts = String(predValue).split(/[,/·|~→\n]+|(?:\s+및\s+)/).map((x) => x.trim()).filter(Boolean);
  const cands = parts.length ? parts : [predValue];
  return Math.max(...cands.map((c) => scoreOne(goldValue, c)));
}

export function entityScore(gold, pred) {
  const time = entityFieldScore(gold.time, pred.time);
  const location = entityFieldScore(gold.location, pred.location);
  return { time, location, mean: (time + location) / 2 };
}

// ---------- (3) 사건 순서 정확도 ----------
// events: [[keyword,...], ...] 순서대로. 생성문에서 각 사건의 첫 등장 위치를 찾고,
// 모든 사건쌍(i<j)에 대해 pos(i) < pos(j) 이면 concordant.
export function eventOrderAccuracy(genText, events) {
  const text = normalize(genText);
  const positions = events.map((kwset) => {
    let best = Infinity;
    for (const kw of kwset) {
      const idx = text.indexOf(normalize(kw));
      if (idx >= 0) best = Math.min(best, idx);
    }
    return best;
  });

  const found = positions.filter((p) => p !== Infinity).length;
  let concordant = 0;
  let total = 0;
  for (let i = 0; i < positions.length; i++) {
    for (let j = i + 1; j < positions.length; j++) {
      if (positions[i] === Infinity || positions[j] === Infinity) continue;
      total++;
      if (positions[i] < positions[j]) concordant++;
    }
  }
  return {
    accuracy: total === 0 ? null : concordant / total,
    comparablePairs: total,
    totalPairs: (events.length * (events.length - 1)) / 2,
    eventsFound: found,
    eventsTotal: events.length,
  };
}

// ---------- (2) 의미 유사도 (임베딩 코사인) ----------
function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

export function makeEmbedder(apiKey, model = "gemini-embedding-001") {
  const ai = new GoogleGenAI({ apiKey });
  const cache = new Map();
  async function embed(text, retries = 8) {
    if (cache.has(text)) return cache.get(text);
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const r = await ai.models.embedContent({ model, contents: text });
        const v = r.embeddings?.[0]?.values || [];
        if (!v.length) throw new Error("empty embedding");
        cache.set(text, v);
        return v;
      } catch (err) {
        const msg = String(err?.message || err);
        if (attempt === retries) throw err;
        const hint = msg.match(/retry in ([\d.]+)s/i);
        const wait = hint
          ? Math.ceil(parseFloat(hint[1]) * 1000) + 2000
          : /429|quota|rate|RESOURCE_EXHAUSTED/i.test(msg)
          ? 60000
          : 3000 * (attempt + 1);
        await new Promise((res) => setTimeout(res, wait));
      }
    }
  }
  return {
    async similarity(a, b) {
      const [ea, eb] = [await embed(a), await embed(b)];
      return cosine(ea, eb);
    },
  };
}
