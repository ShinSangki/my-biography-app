# experiment/ — 논문 실험 하네스

논문 「음성 기반 자서전 생성 앱에서 STT 오류에 취약한 시간·장소 추출 구조 개선 방법에 관한 연구」의
IV장(실험 설계 및 평가 방법)을 코드로 구현한 것이다.

## 테스트 1단계 (RQ1)

> STT 오류율이 증가함에 따라 현재 구현과 같은 단일 호출 방식(baseline)의 자서전 생성 품질은 어떻게 저하되는가.

- **입력**: `dataset/samples.json` — 생애사 클린 텍스트 16편 + 시간·장소 골드 태그 + 사건 순서
- **STT 오류 시뮬레이션** (`src/noiseInjector.mjs`): 규칙 기반 노이즈
  - 음운 유사 치환 (ㅐ↔ㅔ, ㄷ↔ㅌ, 받침 탈락 등 자모 단위 변형)
  - 단어 삭제
  - 고유명사 왜곡 (지명·연도 토큰에 강한 변형)
  - 목표 WER 0 / 10 / 20 / 30% 4단계, 토큰 단위 Levenshtein으로 실측 WER 검증
- **baseline 생성** (`src/runPhase1.mjs`): `backend/src/services/geminiGENERATEService.ts`의
  `generateMemoirText`와 동일한 단일 호출 프롬프트 — 현재 앱 동작을 그대로 재현
- **평가 지표** (`src/metrics.mjs`):
  1. 개체 보존율 — 골드 대비 시간·장소 문자열 일치 (완전 1.0 / 부분 0.5 / 불일치 0.0)
  2. 의미 유사도 — 원본 텍스트 vs 생성 본문 임베딩 코사인 (`gemini-embedding-001`, BERTScore 대용)
  3. 사건 순서 정확도 — 사건 순서쌍(pairwise) 일치율

## 실행

```bash
cd backend/experiment/src
node runPhase1.mjs            # Gemini API 호출. 결과는 ../results/ 에 저장
node runPhase1.mjs --resume   # 중단 지점부터 이어서 실행 (phase1_raw_partial.json 기준)
node makeReport.mjs           # ../results/phase1_report.md 생성
```

- API 키는 `backend/.env`의 `GEMINI_GENERATE_API_KEY`를 사용한다.
- 케이스마다 `results/phase1_raw_partial.json`에 체크포인트를 남기므로, 무료 티어
  할당량(분당·일일 제한) 초과로 중단돼도 `--resume`으로 이어서 돌릴 수 있다.
- 무료 티어는 분당 요청 수 제한이 빡빡해 64케이스 완주에 시간이 오래 걸린다.
  일일 할당량이 넉넉한 키(유료 또는 별도 프로젝트)를 쓰면 15분 내외로 끝난다.

## 산출물 (`results/`)

| 파일 | 내용 |
|---|---|
| `phase1_raw_<타임스탬프>.json` | 케이스별 원자료 (노이즈 텍스트, 생성 결과, 지표) |
| `phase1_summary_<타임스탬프>.json` | WER 레벨별 평균 |
| `phase1_summary_latest.json` | 최신 요약 (고정 이름) |
| `phase1_report.md` | 사람이 읽는 리포트 (표 + 관찰) |
| `human_eval_template.csv` | 사람 평가(자연스러움/전체 품질, 평가자 2인 5점 리커트)용 빈 양식 |

## 2단계 이후 (예정)

- 제안 방식(`/generate-v2`, `selectiveCorrectionService`) 동일 조건 실행 및 baseline과 비교 (RQ2)
- 오류율 수준별 개선 효과 차이 분석 (RQ3)
- 사람 평가 집계 (Cohen's kappa)
