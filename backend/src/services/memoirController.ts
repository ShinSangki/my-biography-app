import { Request, Response } from "express";
import fs from "node:fs";
import { transcribeAudioFromFile } from "../services/geminiSTTService.js";
import { generateMemoirText } from "../services/geminiGENERATEService.js";

export async function createMemoirFromAudio(req: Request, res: Response) {
  try {
    // 1. 업로드된 오디오 파일 확인
    if (!req.file) {
      return res.status(400).json({ error: "오디오 파일이 제공되지 않았습니다." });
    }

    const audioFilePath = req.file.path;

    // 2. STT 서비스 호출 (오디오 -> 텍스트)
    console.log("[Controller] 1. STT 전사 시작...");
    const transcribedText = await transcribeAudioFromFile(audioFilePath);

    // 3. 자서전 생성 서비스 호출 (텍스트 -> JSON)
    console.log("[Controller] 2. 자서전 생성 시작...");
    const generatedMemoir = await generateMemoirText(transcribedText);

    // 4. 결과 반환
    console.log("[Controller] 3. 자서전 생성 완료");
    res.json({
      success: true,
      data: generatedMemoir,
    });
  } catch (error) {
    console.error("[Controller] 자서전 생성 중 오류 발생:", error);
    res.status(500).json({
      error: "자서전 생성 중 오류가 발생했습니다.",
      details: error instanceof Error ? error.message : String(error),
    });
  } finally {
    // 5. 서버에 남은 원본 임시 업로드 파일 정리
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
  }
}