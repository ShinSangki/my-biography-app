import {
  extractTimeLocation,
  reconcileTimeLocation,
  TimeLocation,
} from "./contextExtractionService.js";
import { cleanMemoirText } from "./geminiGenerateCleanService.js";

// 논문 III장 "제안 파이프라인"의 전체 오케스트레이션.
// 기준 방식(geminiGENERATEService.generateMemoirText)은 단일 호출로 문체 정리 + 시간/장소
// 추출 + 제목 생성을 동시에 수행한다. 제안 방식은 이를 분리하고, 두 개의 독립적인 시간/장소
// 후보(원문 기반 / 정리문 기반)가 서로 불일치할 때만 선택적으로 재보정한다.

export interface ProposedMemoirResult {
  title: string;
  memoir: string;
  time: string;
  location: string;
  corrected: boolean; // 선택적 보정이 실제로 발동했는지 여부 (논문 IV장 "보정 발동 빈도" 지표에 사용 가능)
  reason: string | null; // 보정이 발동한 경우 그 판단 근거
  candidates: {
    fromRaw: TimeLocation; // STT 원문에서 직접 추출한 값
    fromClean: TimeLocation; // 문체 정리 후 텍스트에서 추출한 값
  };
}

function normalize(value: string): string {
  return value.trim().replace(/\s+/g, "").toLowerCase();
}

function isMismatch(a: TimeLocation, b: TimeLocation): boolean {
  return normalize(a.time) !== normalize(b.time) || normalize(a.location) !== normalize(b.location);
}

/**
 * STT 원문(rawText)을 입력받아, 시간·장소 추출을 문체 정리와 분리된 단계로 수행하고
 * 두 후보가 불일치할 때만 선택적으로 재보정하는 제안 파이프라인.
 */
export async function generateMemoirWithSelectiveCorrection(
  rawText: string
): Promise<ProposedMemoirResult> {
  // ③ 시간·장소 추출(원문 기반)과 문체 정리를 각각 독립적으로 병렬 수행
  const [candidateFromRaw, cleaned] = await Promise.all([
    extractTimeLocation(rawText),
    cleanMemoirText(rawText),
  ]);

  // 정리문에서도 동일한 방식으로 시간·장소를 재추출 (두 번째 후보)
  const candidateFromClean = await extractTimeLocation(cleaned.memoir);

  // ④ 두 후보 간 불일치 탐지
  const mismatch = isMismatch(candidateFromRaw, candidateFromClean);

  if (!mismatch) {
    return {
      title: cleaned.title,
      memoir: cleaned.memoir,
      time: candidateFromRaw.time,
      location: candidateFromRaw.location,
      corrected: false,
      reason: null,
      candidates: { fromRaw: candidateFromRaw, fromClean: candidateFromClean },
    };
  }

  // ⑤ 불일치 구간에 대해서만 선택적 보정 수행 (전체 재생성 아님)
  const reconciled = await reconcileTimeLocation(
    rawText,
    cleaned.memoir,
    candidateFromRaw,
    candidateFromClean
  );

  return {
    title: cleaned.title,
    memoir: cleaned.memoir,
    time: reconciled.time,
    location: reconciled.location,
    corrected: true,
    reason: reconciled.reason,
    candidates: { fromRaw: candidateFromRaw, fromClean: candidateFromClean },
  };
}
