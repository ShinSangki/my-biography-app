import cors from "cors";
import express, { NextFunction, Request, Response } from "express";
import fs from "node:fs";
import path from "node:path";
import multer from "multer";

import { env } from "./config/env.js";
import {
  createMemoir,
  findMemoirById,
  getAllMemoirs,
  updateMemoir,
  deleteMemoir
} from "./repositories/memoirRepository.js";
import {
  createRecording,
  findRecordingById,
  updateRecordingText
} from "./repositories/recordingRepository.js";
import { transcribeAudioFromFile } from "./services/geminiSTTService.js";
import { generateMemoirText } from "./services/geminiGENERATEService.js";
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

// Multer 파일 필터: 오디오 파일(또는 웹 브라우저 녹음 파일)만 허용하도록 검증
const audioFilter = (_req: Request, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
  if (file.mimetype.startsWith("audio/") || file.mimetype === "video/webm") {
    cb(null, true);
  } else {
    cb(new Error("오디오 형식의 파일만 업로드 가능합니다."));
  }
};

const upload = multer({ storage, fileFilter: audioFilter });

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
 * 음성 파일 업로드 (form-data key: audio)
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
 * recordings 테이블에 녹음 메타데이터 저장
 */
app.post("/recordings/save", async (req, res, next) => {
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

  try {
    // fs.promises.stat을 사용해 비동기적으로 파일 정보를 가져오고 존재 여부를 확인합니다.
    const stat = await fs.promises.stat(absolutePath);
    
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
  } catch (error: any) {
    // 파일이 존재하지 않을 때 발생하는 에러(ENOENT) 처리
    if (error.code === "ENOENT") {
      return res.status(404).json({
        success: false,
        message: "해당 오디오 파일을 찾을 수 없습니다."
      });
    }
    next(error);
  }
});

/**
 * STT(Speech-to-Text) 변환 처리
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
 * 자서전 초안 텍스트 생성
 */
app.post("/generate", async (req, res, next) => {
  try {
    const { text, audioPath } = req.body as { text?: string; audioPath?: string };

    if (!text || !text.trim()) {
      return res.status(400).json({
        success: false,
        message: "text 가 필요합니다."
      });
    }

    const generated = await generateMemoirText(text);

    return res.json({
      success: true,
      memoir: generated.memoir,
      content: generated.memoir,
      title: generated.title,
      time: generated.time,
      location: generated.location,
      transcript: text,
      audioPath: audioPath
    });
  } catch (error) {
    next(error);
  }
});

/**
 * 자서전 데이터 저장
 */
app.post("/memoirs/save", (req, res) => {
  const { recordingId, title, content, time, location } = req.body as {
    recordingId?: number;
    title?: string;
    content?: string;
    time?: string;
    location?: string;
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
    content: content.trim(),
    time: time?.trim() || null,
    location: location?.trim() || null
  });

  return res.json({
    success: true,
    memoirId
  });
});

/**
 * 저장된 자서전 상세 조회
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
 * 특정 녹음 데이터 조회
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
 * 자서전 목록 전체 조회 (프론트엔드 연동용)
 */
app.get("/autobiographies", (req, res) => {
  const memoirs = getAllMemoirs();
  
  const formatted = memoirs.map(m => ({
    id: m.id.toString(),
    title: m.title,
    content: m.content,
    date: m.time || m.created_at,
    location: m.location,
    recordingId: m.recording_id
  }));

  return res.json({
    success: true,
    data: formatted
  });
});

/**
 * 자서전 내용 수정 (프론트엔드 연동용)
 */
app.put("/autobiographies/:id", (req, res) => {
  const id = Number(req.params.id);
  const { title, content } = req.body;
  updateMemoir(id, title, content);
  return res.json({ success: true });
});

/**
 * 자서전 내용 삭제 (프론트엔드 연동용)
 */
app.delete("/autobiographies/:id", (req, res) => {
  const id = Number(req.params.id);
  deleteMemoir(id);
  return res.json({ success: true });
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