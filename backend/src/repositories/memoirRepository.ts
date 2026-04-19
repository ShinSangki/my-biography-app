import db from "../db/db.js";

export interface CreateMemoirInput {
  recordingId?: number | null;
  title: string;
  content: string;
}

export interface Memoir {
  id: number;
  recording_id: number | null;
  title: string;
  content: string;
  created_at: string;
  updated_at: string;
}

export function createMemoir(input: CreateMemoirInput): number {
  const stmt = db.prepare(`
    INSERT INTO memoirs (
      recording_id,
      title,
      content,
      created_at,
      updated_at
    ) VALUES (
      @recordingId,
      @title,
      @content,
      datetime('now', 'localtime'),
      datetime('now', 'localtime')
    )
  `);

  const result = stmt.run({
    recordingId: input.recordingId ?? null,
    title: input.title,
    content: input.content
  });

  return Number(result.lastInsertRowid);
}

export function findMemoirById(id: number): Memoir | undefined {
  const stmt = db.prepare(`
    SELECT *
    FROM memoirs
    WHERE id = ?
  `);
  return stmt.get(id) as Memoir | undefined;
}