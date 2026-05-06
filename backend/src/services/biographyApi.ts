import {
  GenerateResponse,
  SaveMemoirResponse,
  SaveRecordingResponse,
  SttResponse,
  UploadResponse,
} from "../types";

const API_BASE_URL = "http://localhost:4000";

export async function uploadAudio(blob: Blob): Promise<UploadResponse> {
  const extension = blob.type.includes("mp4")
    ? "mp4"
    : blob.type.includes("ogg")
    ? "ogg"
    : "webm";

  const file = new File([blob], `recording.${extension}`, {
    type: blob.type || "audio/webm",
  });

  const formData = new FormData();
  formData.append("audio", file);

  const response = await fetch(`${API_BASE_URL}/upload`, {
    method: "POST",
    body: formData,
  });

  if (!response.ok) {
    throw new Error("오디오 업로드에 실패했습니다.");
  }

  return response.json();
}

export async function saveRecording(audioPath: string): Promise<SaveRecordingResponse> {
  const response = await fetch(`${API_BASE_URL}/recordings/save`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ audioPath }),
  });

  if (!response.ok) {
    throw new Error("녹음 데이터 저장에 실패했습니다.");
  }

  return response.json();
}

export async function requestStt(audioPath: string, recordingId: number): Promise<SttResponse> {
  const response = await fetch(`${API_BASE_URL}/stt`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      audioPath,
      recordingId,
    }),
  });

  if (!response.ok) {
    throw new Error("STT 처리에 실패했습니다.");
  }

  return response.json();
}

export async function requestGenerate(text: string): Promise<GenerateResponse> {
  const response = await fetch(`${API_BASE_URL}/generate`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ text }),
  });

  if (!response.ok) {
    throw new Error("자서전 생성에 실패했습니다.");
  }

  return response.json();
}

export async function saveMemoir(
  recordingId: number,
  content: string,
  title?: string,
  time?: string,
  location?: string
): Promise<SaveMemoirResponse> {
  const response = await fetch(`${API_BASE_URL}/memoirs/save`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      recordingId,
      title: title || "내 이야기",
      content,
      time,
      location
    }),
  });

  if (!response.ok) {
    throw new Error("자서전 저장에 실패했습니다.");
  }

  return response.json();
}