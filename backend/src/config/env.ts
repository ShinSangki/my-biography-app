import dotenv from "dotenv";

dotenv.config();

function getRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`환경변수 ${name} 가 설정되지 않았습니다.`);
  }
  return value;
}

export const env = {
  port: Number(process.env.PORT ?? 4000),
  geminiGenerateApiKey: getRequiredEnv("GEMINI_GENERATE_API_KEY"),
  geminiSttApiKey: getRequiredEnv("GEMINI_STT_API_KEY"),
  geminiSttModel: process.env.GEMINI_STT_MODEL ?? "gemini-2.5-flash",
  geminiGenerateModel: process.env.GEMINI_GENERATE_MODEL ?? "gemini-2.5-flash",
  gemmaApiUrl: process.env.GEMMA_API_URL ?? "http://localhost:8000/generate",
  dbPath: process.env.DB_PATH ?? "./data/app.db"
};