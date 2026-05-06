import db from "../db/db.js";

export interface CreateMemoirInput {
  recordingId?: number | null;
  title: string;
  content: string;
  time?: string | null;
  location?: string | null;
}

export interface Memoir {
  id: number;
  recording_id: number | null;
  title: string;
  content: string;
  time: string | null;
  location: string | null;
  created_at: string;
  updated_at: string;
}

export function createMemoir(input: CreateMemoirInput): number {
  const stmt = db.prepare(`
    INSERT INTO memoirs (
      recording_id,
      title,
      content,
      time,
      location,
      created_at,
      updated_at
    ) VALUES (
      @recordingId,
      @title,
      @content,
      @time,
      @location,
      datetime('now', 'localtime'),
      datetime('now', 'localtime')
    )
  `);

  const result = stmt.run({
    recordingId: input.recordingId ?? null,
    title: input.title,
    content: input.content,
    time: input.time ?? null,
    location: input.location ?? null
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

export function getAllMemoirs(): Memoir[] {
  const stmt = db.prepare(`
    SELECT * FROM memoirs ORDER BY created_at DESC
  `);
  return stmt.all() as Memoir[];
}

export function updateMemoir(id: number, title: string, content: string): void {
  const stmt = db.prepare(`
    UPDATE memoirs 
    SET title = @title, content = @content, updated_at = datetime('now', 'localtime')
    WHERE id = @id
  `);
  stmt.run({ id, title, content });
}

export function deleteMemoir(id: number): void {
  const stmt = db.prepare(`
    DELETE FROM memoirs WHERE id = ?
  `);
  stmt.run(id);
}