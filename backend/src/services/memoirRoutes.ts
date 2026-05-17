import { Router } from "express";
import multer from "multer";
import os from "node:os";
import path from "node:path";
import { createMemoirFromAudio } from "./memoirController.js";

const router = Router();

// OS 임시 폴더를 업로드 경로로 사용하여 디스크 낭비 방지
const upload = multer({ dest: path.join(os.tmpdir(), "memoir-uploads") });

// POST /api/memoirs/from-audio
router.post("/from-audio", upload.single("audio"), createMemoirFromAudio);

export default router;