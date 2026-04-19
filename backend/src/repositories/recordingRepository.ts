import db from "../db/db.js";

export interface CreateRecordingInput {
  fileName: string;
  filePath: string;
  mimeType?: string;
  fileSize?: number;
  rawText?: string;
}

export interface Recording {
  id: number;
  file_name: string;
  file_path: string;
  mime_type: string | null;
  file_size: number;
  raw_text: string | null;
  created_at: string;
  updated_at: string;
}

export function createRecording(input: CreateRecordingInput): number {
  const stmt = db.prepare(`
    INSERT INTO recordings (
      file_name,
      file_path,
      mime_type,
      file_size,
      raw_text,
      created_at,
      updated_at
    ) VALUES (
      @fileName,
      @filePath,
      @mimeType,
      @fileSize,
      @rawText,
      datetime('now', 'localtime'),
      datetime('now', 'localtime')
    )
  `);

  const result = stmt.run({
    fileName: input.fileName,
    filePath: input.filePath,
    mimeType: input.mimeType ?? null,
    fileSize: input.fileSize ?? 0,
    rawText: input.rawText ?? null
  });

  return Number(result.lastInsertRowid);
}

export function updateRecordingText(id: number, rawText: string): void {
  const stmt = db.prepare(`
    UPDATE recordings
    SET raw_text = ?, updated_at = datetime('now', 'localtime')
    WHERE id = ?
  `);
  stmt.run(rawText, id);
}

export function findRecordingById(id: number): Recording | undefined {
  const stmt = db.prepare(`
    SELECT *
    FROM recordings
    WHERE id = ?
  `);
  return stmt.get(id) as Recording | undefined;
}