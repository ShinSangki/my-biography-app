import ffmpeg from "fluent-ffmpeg";
import ffmpegPath from "ffmpeg-static";
import path from "node:path";
import fs from "node:fs";
import { ensureDir } from "./fileUtils.js";

if (typeof ffmpegPath === "string") {
  ffmpeg.setFfmpegPath(ffmpegPath);
}

export async function convertWebmToWav(inputPath: string): Promise<string> {
  const outputDir = path.join(process.cwd(), "uploads", "converted");
  ensureDir(outputDir);

  const outputPath = path.join(
    outputDir,
    `${path.basename(inputPath, path.extname(inputPath))}.wav`
  );

  if (fs.existsSync(outputPath)) {
    fs.unlinkSync(outputPath);
  }

  await new Promise<void>((resolve, reject) => {
    ffmpeg(inputPath)
      .noVideo()
      .audioChannels(1)
      .audioFrequency(16000)
      .audioCodec("pcm_s16le")
      .format("wav")
      .on("end", () => resolve())
      .on("error", (err) => reject(err))
      .save(outputPath);
  });

  return outputPath;
}