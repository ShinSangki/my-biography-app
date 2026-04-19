import cors from "cors";
import express, { NextFunction, Request, Response } from "express";
import fs from "node:fs";
import path from "node:path";
import multer from "multer";

import { env } from "./config/env.js";
import {
  createMemoir,
  findMemoirById
} from "./repositories/memoirRepository.js";
import {
  createRecording,
  findRecordingById,
  updateRecordingText
} from "./repositories/recordingRepository.js";
import {
  generateMemoirText,
  transcribeAudioFromFile
} from "./services/geminiService.js";
import {
  ensureDir,
  fileExists,
  getMimeType,
  sanitizeFileName,
  toAbsolutePath,
  toRelativePath
} from "./utils/fileUtils.js";

// Express 앱 생성 및 미들웨어 설정
const app = express();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 업로드 디렉터리 생성 및 정적 파일 서비스 설정
const uploadsDir = path.join(process.cwd(), "uploads");
ensureDir(uploadsDir);

app.use("/uploads", express.static(uploadsDir));

// Multer 파일 저장 방식 설정: 업로드된 오디오 파일 이름 안전 처리
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (_req, file, cb) => {
    const timestamp = Date.now();
    const safeName = sanitizeFileName(file.originalname || "audio.webm");
    cb(null, `${timestamp}-${safeName}`);
  }
});

const upload = multer({ storage });

// 헬스 체크 엔드포인트
app.get("/health", (_req, res) => {
  res.json({
    success: true,
    message: "server is running"
  });
});

// -----------------------------
// 녹음 파일 및 자서전 관리 라우트
// -----------------------------

/**
 * 1) 음성 파일 업로드
 * form-data key: audio
 */
app.post("/upload", upload.single("audio"), (req, res) => {
  if (!req.file) {
    return res.status(400).json({
      success: false,
      message: "audio 파일이 필요합니다."
    });
  }

  const relativePath = toRelativePath(req.file.path);

  return res.json({
    success: true,
    file: {
      fileName: req.file.filename,
      originalName: req.file.originalname,
      mimeType: req.file.mimetype,
      size: req.file.size,
      audioPath: relativePath,
      url: `/${relativePath}`
    }
  });
});

/**
 * 2) recordings 테이블 저장
 */
app.post("/recordings/save", (req, res) => {
  const { audioPath, rawText } = req.body as {
    audioPath?: string;
    rawText?: string;
  };

  if (!audioPath) {
    return res.status(400).json({
      success: false,
      message: "audioPath 가 필요합니다."
    });
  }

  const absolutePath = toAbsolutePath(audioPath);

  if (!fileExists(absolutePath)) {
    return res.status(404).json({
      success: false,
      message: "해당 오디오 파일을 찾을 수 없습니다."
    });
  }

  const stat = fs.statSync(absolutePath);
  const fileName = path.basename(absolutePath);
  const mimeType = getMimeType(absolutePath);

  const recordingId = createRecording({
    fileName,
    filePath: toRelativePath(absolutePath),
    mimeType,
    fileSize: stat.size,
    rawText
  });

  return res.json({
    success: true,
    recordingId
  });
});

/**
 * 3) STT 처리
 */
app.post("/stt", async (req, res, next) => {
  try {
    const { audioPath, recordingId } = req.body as {
      audioPath?: string;
      recordingId?: number;
    };

    if (!audioPath) {
      return res.status(400).json({
        success: false,
        message: "audioPath 가 필요합니다."
      });
    }

    const absolutePath = toAbsolutePath(audioPath);

    if (!fileExists(absolutePath)) {
      return res.status(404).json({
        success: false,
        message: "해당 오디오 파일을 찾을 수 없습니다."
      });
    }

    const text = await transcribeAudioFromFile(absolutePath);

    if (recordingId) {
      updateRecordingText(Number(recordingId), text);
    }

    return res.json({
      success: true,
      text
    });
  } catch (error) {
    next(error);
  }
});

/**
 * 4) 자서전 문장 생성
 */
app.post("/generate", async (req, res, next) => {
  try {
    const { text } = req.body as { text?: string };

    if (!text || !text.trim()) {
      return res.status(400).json({
        success: false,
        message: "text 가 필요합니다."
      });
    }

    const memoir = await generateMemoirText(text);

    return res.json({
      success: true,
      memoir
    });
  } catch (error) {
    next(error);
  }
});

/**
 * 5) 자서전 저장
 */
app.post("/memoirs/save", (req, res) => {
  const { recordingId, title, content } = req.body as {
    recordingId?: number;
    title?: string;
    content?: string;
  };

  if (!content || !content.trim()) {
    return res.status(400).json({
      success: false,
      message: "content 가 필요합니다."
    });
  }

  const memoirId = createMemoir({
    recordingId: recordingId ? Number(recordingId) : null,
    title: title?.trim() || "내 이야기",
    content: content.trim()
  });

  return res.json({
    success: true,
    memoirId
  });
});

/**
 * 6) 저장된 자서전 조회
 */
app.get("/memoirs/:id", (req, res) => {
  const memoirId = Number(req.params.id);

  if (Number.isNaN(memoirId)) {
    return res.status(400).json({
      success: false,
      message: "유효한 memoir id 가 아닙니다."
    });
  }

  const memoir = findMemoirById(memoirId);

  if (!memoir) {
    return res.status(404).json({
      success: false,
      message: "자서전을 찾을 수 없습니다."
    });
  }

  return res.json({
    success: true,
    memoir
  });
});

/**
 * 7) recordings 조회
 */
app.get("/recordings/:id", (req, res) => {
  const recordingId = Number(req.params.id);

  if (Number.isNaN(recordingId)) {
    return res.status(400).json({
      success: false,
      message: "유효한 recording id 가 아닙니다."
    });
  }

  const recording = findRecordingById(recordingId);

  if (!recording) {
    return res.status(404).json({
      success: false,
      message: "녹음 데이터를 찾을 수 없습니다."
    });
  }

  return res.json({
    success: true,
    recording
  });
});

/**
 * 공통 에러 처리
 */
app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error(error);

  const message =
    error instanceof Error ? error.message : "서버 내부 오류가 발생했습니다.";

  res.status(500).json({
    success: false,
    message
  });
});

app.listen(env.port, () => {
  console.log(`Server started on http://localhost:${env.port}`);
});