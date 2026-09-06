// 논문 IV.1 "STT 오류 시뮬레이션" 구현.
// 실제 STT 엔진 대신 클린 텍스트에 규칙 기반 노이즈를 주입한다.
// 노이즈 유형: (1) 음운 유사 치환  (2) 단어 삭제  (3) 고유명사 왜곡
// 오류율은 단어 오류율(WER) 기준 0/10/20/30% 4단계로 통제한다.

// ---------- 시드 기반 난수 (재현성) ----------
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- 한글 자모 분해/조합 ----------
const HANGUL_BASE = 0xac00;
const CHO_COUNT = 19;
const JUNG_COUNT = 21;
const JONG_COUNT = 28;

function decompose(ch) {
  const code = ch.charCodeAt(0) - HANGUL_BASE;
  if (code < 0 || code >= CHO_COUNT * JUNG_COUNT * JONG_COUNT) return null;
  const cho = Math.floor(code / (JUNG_COUNT * JONG_COUNT));
  const jung = Math.floor((code % (JUNG_COUNT * JONG_COUNT)) / JONG_COUNT);
  const jong = code % JONG_COUNT;
  return { cho, jung, jong };
}

function compose(cho, jung, jong) {
  return String.fromCharCode(HANGUL_BASE + (cho * JUNG_COUNT + jung) * JONG_COUNT + jong);
}

// 음운적으로 혼동되기 쉬운 짝 (STT 오인식 패턴 모사)
const CHO_CONFUSION = [
  [0, 15], // ㄱ ↔ ㅋ
  [3, 16], // ㄷ ↔ ㅌ
  [7, 17], // ㅂ ↔ ㅍ
  [12, 14], // ㅈ ↔ ㅊ
  [9, 10], // ㅅ ↔ ㅆ
  [2, 4], // ㄴ ↔ ㄷ (조음위치 근접)
];
const JUNG_CONFUSION = [
  [1, 5], // ㅐ ↔ ㅔ
  [3, 7], // ㅒ ↔ ㅖ
  [11, 10], // ㅚ ↔ ㅙ
  [11, 15], // ㅚ ↔ ㅞ
  [8, 13], // ㅗ ↔ ㅜ
  [0, 4], // ㅏ ↔ ㅓ
  [18, 20], // ㅡ ↔ ㅣ
];
const JONG_CONFUSION = [
  [1, 0], // ㄱ 받침 탈락
  [4, 21], // ㄴ ↔ ㅇ
  [8, 4], // ㄹ ↔ ㄴ
  [17, 0], // ㅂ 받침 탈락
  [21, 0], // ㅇ 받침 탈락
  [7, 19], // ㄷ ↔ ㅅ
];

function pickPair(pairs, value, rnd) {
  const cands = [];
  for (const [a, b] of pairs) {
    if (a === value) cands.push(b);
    if (b === value) cands.push(a);
  }
  if (cands.length === 0) return null;
  return cands[Math.floor(rnd() * cands.length)];
}

// 한 음절에 음운 유사 치환 1회 적용
function perturbSyllable(ch, rnd) {
  const d = decompose(ch);
  if (!d) return ch;
  const roll = rnd();
  if (roll < 0.34) {
    const nc = pickPair(CHO_CONFUSION, d.cho, rnd);
    if (nc != null) return compose(nc, d.jung, d.jong);
  }
  if (roll < 0.7) {
    const nj = pickPair(JUNG_CONFUSION, d.jung, rnd);
    if (nj != null) return compose(d.cho, nj, d.jong);
  }
  const ng = pickPair(JONG_CONFUSION, d.jong, rnd);
  if (ng != null) return compose(d.cho, d.jung, ng);
  // fallback: 종성 탈락
  if (d.jong !== 0) return compose(d.cho, d.jung, 0);
  return ch;
}

function isHangulSyllable(ch) {
  const c = ch.charCodeAt(0) - HANGUL_BASE;
  return c >= 0 && c < CHO_COUNT * JUNG_COUNT * JONG_COUNT;
}

// 토큰에 음운 유사 치환 (count회) 적용. 반드시 원본과 달라지도록 시도.
function substitutePhonetic(token, count, rnd) {
  const chars = [...token];
  const idxs = chars.map((c, i) => (isHangulSyllable(c) ? i : -1)).filter((i) => i >= 0);
  if (idxs.length === 0) return token;
  let changed = token;
  for (let n = 0; n < count; n++) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const arr = [...changed];
      const pos = idxs[Math.floor(rnd() * idxs.length)];
      const np = perturbSyllable(arr[pos], rnd);
      arr[pos] = np;
      const next = arr.join("");
      if (next !== changed) {
        changed = next;
        break;
      }
    }
  }
  return changed;
}

// ---------- 토큰 단위 Levenshtein (실제 WER 측정용) ----------
export function tokenLevenshtein(ref, hyp) {
  const m = ref.length;
  const n = hyp.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = ref[i - 1] === hyp[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[m][n];
}

export function wer(refText, hypText) {
  const ref = refText.trim().split(/\s+/);
  const hyp = hypText.trim().split(/\s+/);
  if (ref.length === 0) return 0;
  return tokenLevenshtein(ref, hyp) / ref.length;
}

// ---------- 메인: 목표 WER에 맞춰 노이즈 주입 ----------
// properNouns: 고유명사 힌트 배열(부분 문자열). 해당 토큰은 "고유명사 왜곡"으로 더 강하게 변형.
export function injectNoise(cleanText, targetWer, seed, properNouns = []) {
  const rnd = mulberry32(seed);
  const tokens = cleanText.trim().split(/\s+/);
  const N = tokens.length;

  if (targetWer <= 0) {
    return {
      text: cleanText,
      targetWer: 0,
      actualWer: 0,
      edits: [],
    };
  }

  const budget = Math.max(1, Math.round(targetWer * N));

  // 편집 대상 인덱스 선택 (조사/1음절 기능어는 후순위)
  const order = [...Array(N).keys()].sort((a, b) => rnd() - 0.5);
  const chosen = order.slice(0, budget);

  const out = [...tokens];
  const edits = [];
  const isProper = (tok) => properNouns.some((p) => p && tok.includes(p));

  for (const i of chosen) {
    const tok = tokens[i];
    if (out[i] === null) continue;

    let op;
    if (isProper(tok)) {
      op = "propnoun";
    } else {
      const r = rnd();
      op = r < 0.6 ? "sub_phon" : "delete";
    }

    if (op === "delete") {
      out[i] = null;
      edits.push({ index: i, op, from: tok, to: null });
    } else if (op === "propnoun") {
      // 고유명사: 음절 2회 치환 + 30% 확률로 끝 음절 탈락
      let distorted = substitutePhonetic(tok, 2, rnd);
      if (rnd() < 0.3 && [...distorted].length > 1) {
        distorted = [...distorted].slice(0, -1).join("");
      }
      if (distorted === tok) distorted = substitutePhonetic(tok, 3, rnd);
      out[i] = distorted;
      edits.push({ index: i, op, from: tok, to: distorted });
    } else {
      const distorted = substitutePhonetic(tok, 1, rnd);
      if (distorted === tok) {
        out[i] = null; // 치환 실패 시 삭제로 대체
        edits.push({ index: i, op: "delete", from: tok, to: null });
      } else {
        out[i] = distorted;
        edits.push({ index: i, op, from: tok, to: distorted });
      }
    }
  }

  const hypText = out.filter((t) => t !== null).join(" ");
  return {
    text: hypText,
    targetWer,
    actualWer: wer(cleanText, hypText),
    edits,
  };
}
