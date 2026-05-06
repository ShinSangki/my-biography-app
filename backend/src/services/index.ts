export type RecordItem = {
  id: string;
  createdAt: string;
  durationMs: number;
  mimeType: string;
  blob: Blob;
  audioUrl: string;
  status: "local" | "processing" | "done" | "error";
  audioPath?: string;
  recordingId?: number;
  memoirId?: number;
  sttText?: string;
  memoirText?: string;
  errorMessage?: string;
};

export type UploadResponse = {
  success: boolean;
  file: {
    fileName: string;
    originalName: string;
    mimeType: string;
    size: number;
    audioPath: string;
    url: string;
  };
};

export type SaveRecordingResponse = {
  success: boolean;
  recordingId: number;
};

export type SttResponse = {
  success: boolean;
  text: string;
};

export type GenerateResponse = {
  success: boolean;
  memoir: string;
  title: string;
  time: string;
  location: string;
};

export type SaveMemoirResponse = {
  success: boolean;
  memoirId: number;
};