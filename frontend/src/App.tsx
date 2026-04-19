import React, { useEffect, useMemo, useRef, useState } from "react";
import "./App.css";

type RecordItem = {
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

type UploadResponse = {
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

type SaveRecordingResponse = {
  success: boolean;
  recordingId: number;
};

type SttResponse = {
  success: boolean;
  text: string;
};

type GenerateResponse = {
  success: boolean;
  memoir: string;
};

type SaveMemoirResponse = {
  success: boolean;
  memoirId: number;
};

const API_BASE_URL =
  process.env.REACT_APP_API_BASE_URL || "http://localhost:4000";

function formatTime(totalSeconds: number) {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function getSupportedMimeType(): string {
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4",
    "audio/ogg;codecs=opus",
  ];

  for (const type of candidates) {
    if (MediaRecorder.isTypeSupported(type)) {
      return type;
    }
  }

  return "";
}

export default function App() {
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<number | null>(null);

  const [isSupported, setIsSupported] = useState<boolean | null>(null);
  const [hasPermission, setHasPermission] = useState<boolean>(false);
  const [isChecking, setIsChecking] = useState(true);

  const [isRecording, setIsRecording] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);

  const [records, setRecords] = useState<RecordItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [message, setMessage] = useState("준비되었습니다.");
  const [error, setError] = useState("");
  const [isProcessing, setIsProcessing] = useState(false);

  useEffect(() => {
    initRecorder();

    return () => {
      stopTimer();

      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
      }

      records.forEach((item) => {
        URL.revokeObjectURL(item.audioUrl);
      });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectedRecord = useMemo(() => {
    return records.find((item) => item.id === selectedId) ?? null;
  }, [records, selectedId]);

  async function initRecorder() {
    setIsChecking(true);
    setError("");

    try {
      const supported =
        typeof navigator !== "undefined" &&
        !!navigator.mediaDevices &&
        !!navigator.mediaDevices.getUserMedia &&
        typeof MediaRecorder !== "undefined";

      setIsSupported(supported);

      if (!supported) {
        setMessage("이 브라우저에서는 음성 녹음을 사용할 수 없습니다.");
        return;
      }

      try {
        const permissionStatus = await navigator.permissions?.query?.({
          name: "microphone" as PermissionName,
        });

        if (permissionStatus) {
          setHasPermission(permissionStatus.state === "granted");
        }
      } catch {
        // permissions API가 없을 경우 무시
      }

      setMessage("브라우저 녹음 준비가 완료되었습니다.");
    } catch (e) {
      console.error(e);
      setIsSupported(false);
      setError("녹음 기능 초기화에 실패했습니다.");
      setMessage("초기화 오류가 발생했습니다.");
    } finally {
      setIsChecking(false);
    }
  }

  async function requestPermission() {
    setError("");

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      setHasPermission(true);
      setMessage("마이크 권한이 허용되었습니다.");

      stream.getTracks().forEach((track) => track.stop());
    } catch (e) {
      console.error(e);
      setHasPermission(false);
      setError("권한 요청 중 오류가 발생했습니다.");
      setMessage("마이크 권한이 거부되었습니다. 브라우저 설정을 확인해주세요.");
    }
  }

  function startTimer() {
    stopTimer();
    timerRef.current = window.setInterval(() => {
      setRecordSeconds((prev) => prev + 1);
    }, 1000);
  }

  function stopTimer() {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }

  async function handleStartRecording() {
    setError("");

    if (isChecking || isStopping || isProcessing) return;

    try {
      if (!isSupported) {
        setMessage("이 브라우저에서는 녹음 기능을 사용할 수 없습니다.");
        return;
      }

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      setHasPermission(true);

      streamRef.current = stream;
      audioChunksRef.current = [];

      const mimeType = getSupportedMimeType();
      const recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);

      recorder.ondataavailable = (event: BlobEvent) => {
        if (event.data && event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      recorder.onstop = () => {
        const finalMimeType = recorder.mimeType || "audio/webm";
        const blob = new Blob(audioChunksRef.current, { type: finalMimeType });
        const audioUrl = URL.createObjectURL(blob);

        const item: RecordItem = {
          id: `${Date.now()}`,
          createdAt: new Date().toLocaleString("ko-KR"),
          durationMs: recordSeconds * 1000,
          mimeType: finalMimeType,
          blob,
          audioUrl,
          status: "local",
        };

        setRecords((prev) => [item, ...prev]);
        setSelectedId(item.id);
        setMessage("녹음이 저장되었습니다.");

        if (streamRef.current) {
          streamRef.current.getTracks().forEach((track) => track.stop());
          streamRef.current = null;
        }
      };

      mediaRecorderRef.current = recorder;
      recorder.start();

      setIsRecording(true);
      setRecordSeconds(0);
      startTimer();
      setMessage("녹음 중입니다.");
    } catch (e) {
      console.error(e);
      setIsRecording(false);
      stopTimer();
      setError("녹음을 시작하지 못했습니다.");
      setMessage("녹음 시작 실패");
    }
  }

  async function handleStopRecording() {
    if (!isRecording || isStopping) return;

    setIsStopping(true);
    setError("");

    try {
      const recorder = mediaRecorderRef.current;
      if (!recorder || recorder.state === "inactive") {
        setMessage("중지할 녹음이 없습니다.");
        return;
      }

      recorder.stop();
      stopTimer();
      setIsRecording(false);
    } catch (e) {
      console.error(e);
      stopTimer();
      setIsRecording(false);
      setError("녹음을 종료하지 못했습니다.");
      setMessage("녹음 종료 실패");
    } finally {
      setIsStopping(false);
    }
  }

  function handleDeleteRecord(id: string) {
    const target = records.find((item) => item.id === id);
    if (target) {
      URL.revokeObjectURL(target.audioUrl);
    }

    const next = records.filter((item) => item.id !== id);
    setRecords(next);

    if (selectedId === id) {
      setSelectedId(next.length > 0 ? next[0].id : null);
    }

    setMessage("녹음이 삭제되었습니다.");
  }

  function updateRecord(id: string, updater: (item: RecordItem) => RecordItem) {
    setRecords((prev) =>
      prev.map((item) => (item.id === id ? updater(item) : item))
    );
  }

  async function uploadAudio(blob: Blob): Promise<UploadResponse> {
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

  async function saveRecording(
    audioPath: string
  ): Promise<SaveRecordingResponse> {
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

  async function requestStt(
    audioPath: string,
    recordingId: number
  ): Promise<SttResponse> {
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

  async function requestGenerate(text: string): Promise<GenerateResponse> {
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

  async function saveMemoir(
    recordingId: number,
    content: string
  ): Promise<SaveMemoirResponse> {
    const response = await fetch(`${API_BASE_URL}/memoirs/save`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        recordingId,
        title: "내 이야기",
        content,
      }),
    });

    if (!response.ok) {
      throw new Error("자서전 저장에 실패했습니다.");
    }

    return response.json();
  }

  async function handleProcessRecord(id: string) {
    const target = records.find((item) => item.id === id);
    if (!target) return;

    try {
      setIsProcessing(true);
      setError("");
      setMessage("서버 처리를 시작합니다.");

      updateRecord(id, (item) => ({
        ...item,
        status: "processing",
        errorMessage: undefined,
      }));

      const uploadResult = await uploadAudio(target.blob);
      const audioPath = uploadResult.file.audioPath;

      updateRecord(id, (item) => ({
        ...item,
        audioPath,
      }));

      setMessage("녹음 파일을 저장하고 있습니다.");
      const saveRecordingResult = await saveRecording(audioPath);
      const recordingId = saveRecordingResult.recordingId;

      updateRecord(id, (item) => ({
        ...item,
        recordingId,
      }));

      setMessage("음성을 텍스트로 변환하고 있습니다.");
      const sttResult = await requestStt(audioPath, recordingId);

      updateRecord(id, (item) => ({
        ...item,
        sttText: sttResult.text,
      }));

      setMessage("자서전 초안을 생성하고 있습니다.");
      const generateResult = await requestGenerate(sttResult.text);

      updateRecord(id, (item) => ({
        ...item,
        memoirText: generateResult.memoir,
      }));

      setMessage("자서전 초안을 저장하고 있습니다.");
      const saveMemoirResult = await saveMemoir(
        recordingId,
        generateResult.memoir
      );

      updateRecord(id, (item) => ({
        ...item,
        memoirId: saveMemoirResult.memoirId,
        status: "done",
      }));

      setMessage("처리가 완료되었습니다.");
    } catch (e) {
      console.error(e);

      updateRecord(id, (item) => ({
        ...item,
        status: "error",
        errorMessage:
          e instanceof Error ? e.message : "처리 중 알 수 없는 오류가 발생했습니다.",
      }));

      setError(e instanceof Error ? e.message : "처리 중 오류가 발생했습니다.");
      setMessage("서버 처리 실패");
    } finally {
      setIsProcessing(false);
    }
  }

  function getRecordStatusLabel(item: RecordItem) {
    switch (item.status) {
      case "local":
        return "로컬 저장";
      case "processing":
        return "처리 중";
      case "done":
        return "처리 완료";
      case "error":
        return "오류";
      default:
        return "-";
    }
  }

  return (
    <div style={styles.page}>
      <div style={styles.appShell}>
        <header style={styles.header}>
          <div>
            <div style={styles.eyebrow}>VOICE BIOGRAPHY MVP</div>
            <h1 style={styles.title}>음성 자서전</h1>
            <p style={styles.subtitle}>
              버튼을 눌러 이야기를 녹음하고, 서버에서 텍스트와 자서전 초안으로
              변환하세요.
            </p>
          </div>
        </header>

        <main style={styles.main}>
          <section style={styles.heroCard}>
            <div style={styles.statusRow}>
              <div style={styles.statusChip}>
                {isChecking
                  ? "기기 확인 중"
                  : isSupported
                  ? "녹음 가능"
                  : "녹음 불가"}
              </div>

              <div style={styles.statusChip}>
                {hasPermission ? "권한 허용" : "권한 필요"}
              </div>

              <div style={styles.statusChip}>
                {isProcessing ? "서버 처리 중" : "대기 중"}
              </div>
            </div>

            <div style={styles.timerWrap}>
              <div style={styles.timerLabel}>
                {isRecording ? "현재 녹음 시간" : "대기 상태"}
              </div>
              <div style={styles.timerValue}>{formatTime(recordSeconds)}</div>
            </div>

            <div style={styles.actionGroup}>
              {!hasPermission && (
                <button
                  type="button"
                  onClick={requestPermission}
                  style={styles.secondaryButton}
                >
                  마이크 권한 허용
                </button>
              )}

              {!isRecording ? (
                <button
                  type="button"
                  onClick={handleStartRecording}
                  style={{
                    ...styles.primaryButton,
                    opacity:
                      isChecking || isSupported === false || isStopping || isProcessing
                        ? 0.6
                        : 1,
                  }}
                  disabled={
                    isChecking || isSupported === false || isStopping || isProcessing
                  }
                >
                  녹음 시작
                </button>
              ) : (
                <button
                  type="button"
                  onClick={handleStopRecording}
                  style={{
                    ...styles.stopButton,
                    opacity: isStopping ? 0.6 : 1,
                  }}
                  disabled={isStopping}
                >
                  녹음 종료
                </button>
              )}
            </div>

            <div style={styles.infoBox}>
              <div style={styles.infoTitle}>상태</div>
              <div style={styles.infoText}>{message}</div>
              {error ? <div style={styles.errorText}>{error}</div> : null}
            </div>
          </section>

          <section style={styles.section}>
            <div style={styles.sectionHeader}>
              <h2 style={styles.sectionTitle}>저장된 녹음</h2>
              <span style={styles.countBadge}>{records.length}개</span>
            </div>

            {records.length === 0 ? (
              <div style={styles.emptyCard}>아직 저장된 녹음이 없습니다.</div>
            ) : (
              <div style={styles.recordList}>
                {records.map((item, index) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setSelectedId(item.id)}
                    style={{
                      ...styles.recordItem,
                      ...(selectedId === item.id
                        ? styles.recordItemActive
                        : null),
                    }}
                  >
                    <div style={styles.recordTop}>
                      <div style={styles.recordIndex}>#{records.length - index}</div>
                      <div style={styles.recordDate}>{item.createdAt}</div>
                    </div>

                    <div style={styles.recordMeta}>
                      <span>{formatTime(Math.floor(item.durationMs / 1000))}</span>
                      <span>{item.mimeType}</span>
                      <span>{getRecordStatusLabel(item)}</span>
                    </div>

                    <div style={styles.recordActions}>
                      <span style={styles.selectHint}>선택해서 확인</span>

                      <div style={styles.inlineActions}>
                        <span
                          role="button"
                          tabIndex={0}
                          onClick={(e) => {
                            e.stopPropagation();
                            handleProcessRecord(item.id);
                          }}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              e.stopPropagation();
                              handleProcessRecord(item.id);
                            }
                          }}
                          style={styles.processText}
                        >
                          서버 처리
                        </span>

                        <span
                          role="button"
                          tabIndex={0}
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDeleteRecord(item.id);
                          }}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              e.stopPropagation();
                              handleDeleteRecord(item.id);
                            }
                          }}
                          style={styles.deleteText}
                        >
                          삭제
                        </span>
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </section>

          <section style={styles.section}>
            <div style={styles.sectionHeader}>
              <h2 style={styles.sectionTitle}>재생 영역</h2>
            </div>

            {!selectedRecord ? (
              <div style={styles.emptyCard}>재생할 녹음을 선택하세요.</div>
            ) : (
              <div style={styles.playerCard}>
                <div style={styles.playerMeta}>
                  <div style={styles.playerLabel}>선택된 녹음</div>
                  <div style={styles.playerDate}>{selectedRecord.createdAt}</div>
                </div>

                <audio controls src={selectedRecord.audioUrl} style={styles.audio} />

                <div style={styles.playerDetails}>
                  <div>
                    길이: {formatTime(Math.floor(selectedRecord.durationMs / 1000))}
                  </div>
                  <div>형식: {selectedRecord.mimeType}</div>
                  <div>상태: {getRecordStatusLabel(selectedRecord)}</div>
                  <div>recordingId: {selectedRecord.recordingId ?? "-"}</div>
                  <div>memoirId: {selectedRecord.memoirId ?? "-"}</div>
                </div>
              </div>
            )}
          </section>

          <section style={styles.section}>
            <div style={styles.sectionHeader}>
              <h2 style={styles.sectionTitle}>STT 결과</h2>
            </div>

            {!selectedRecord ? (
              <div style={styles.emptyCard}>녹음을 먼저 선택하세요.</div>
            ) : (
              <div style={styles.resultCard}>
                {selectedRecord.sttText ? (
                  <div style={styles.resultText}>{selectedRecord.sttText}</div>
                ) : selectedRecord.status === "processing" ? (
                  <div style={styles.emptyCard}>STT 처리 중입니다.</div>
                ) : (
                  <div style={styles.emptyCard}>아직 STT 결과가 없습니다.</div>
                )}
              </div>
            )}
          </section>

          <section style={styles.section}>
            <div style={styles.sectionHeader}>
              <h2 style={styles.sectionTitle}>자서전 초안</h2>
            </div>

            {!selectedRecord ? (
              <div style={styles.emptyCard}>녹음을 먼저 선택하세요.</div>
            ) : (
              <div style={styles.resultCard}>
                {selectedRecord.memoirText ? (
                  <div style={styles.resultText}>{selectedRecord.memoirText}</div>
                ) : selectedRecord.status === "processing" ? (
                  <div style={styles.emptyCard}>자서전 초안을 생성 중입니다.</div>
                ) : selectedRecord.status === "error" ? (
                  <div style={styles.errorText}>
                    {selectedRecord.errorMessage ?? "처리 중 오류가 발생했습니다."}
                  </div>
                ) : (
                  <div style={styles.emptyCard}>아직 생성된 자서전이 없습니다.</div>
                )}
              </div>
            )}
          </section>
        </main>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    minHeight: "100vh",
    background: "#f5f5f5",
    color: "#111",
    display: "flex",
    justifyContent: "center",
    padding: "16px",
    boxSizing: "border-box",
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Pretendard", "Noto Sans KR", sans-serif',
  },
  appShell: {
    width: "100%",
    maxWidth: "520px",
    minHeight: "100%",
    display: "flex",
    flexDirection: "column",
    gap: "16px",
  },
  header: {
    padding: "8px 4px 0",
  },
  eyebrow: {
    fontSize: "12px",
    fontWeight: 700,
    letterSpacing: "0.08em",
    color: "#666",
    marginBottom: "8px",
  },
  title: {
    margin: 0,
    fontSize: "34px",
    lineHeight: 1.15,
    fontWeight: 800,
  },
  subtitle: {
    margin: "10px 0 0",
    fontSize: "15px",
    color: "#555",
    lineHeight: 1.5,
  },
  main: {
    display: "flex",
    flexDirection: "column",
    gap: "16px",
    paddingBottom: "24px",
  },
  heroCard: {
    background: "#fff",
    borderRadius: "24px",
    padding: "20px",
    boxShadow: "0 10px 30px rgba(0,0,0,0.06)",
    border: "1px solid #ececec",
  },
  statusRow: {
    display: "flex",
    gap: "8px",
    flexWrap: "wrap",
    marginBottom: "18px",
  },
  statusChip: {
    fontSize: "13px",
    fontWeight: 700,
    borderRadius: "999px",
    padding: "8px 12px",
    background: "#f0f0f0",
  },
  timerWrap: {
    textAlign: "center",
    padding: "18px 0 8px",
  },
  timerLabel: {
    fontSize: "14px",
    color: "#666",
    marginBottom: "8px",
  },
  timerValue: {
    fontSize: "54px",
    lineHeight: 1,
    fontWeight: 800,
    letterSpacing: "-0.04em",
  },
  actionGroup: {
    display: "flex",
    flexDirection: "column",
    gap: "10px",
    marginTop: "18px",
  },
  primaryButton: {
    width: "100%",
    border: "none",
    borderRadius: "18px",
    padding: "18px 16px",
    fontSize: "18px",
    fontWeight: 800,
    background: "#111",
    color: "#fff",
    cursor: "pointer",
  },
  secondaryButton: {
    width: "100%",
    border: "1px solid #d8d8d8",
    borderRadius: "18px",
    padding: "16px 16px",
    fontSize: "16px",
    fontWeight: 700,
    background: "#fff",
    color: "#111",
    cursor: "pointer",
  },
  stopButton: {
    width: "100%",
    border: "none",
    borderRadius: "18px",
    padding: "18px 16px",
    fontSize: "18px",
    fontWeight: 800,
    background: "#222",
    color: "#fff",
    cursor: "pointer",
  },
  infoBox: {
    marginTop: "16px",
    background: "#fafafa",
    border: "1px solid #ededed",
    borderRadius: "18px",
    padding: "14px",
  },
  infoTitle: {
    fontSize: "13px",
    fontWeight: 800,
    color: "#666",
    marginBottom: "6px",
  },
  infoText: {
    fontSize: "15px",
    lineHeight: 1.5,
  },
  errorText: {
    marginTop: "8px",
    fontSize: "14px",
    color: "#b00020",
    lineHeight: 1.45,
    whiteSpace: "pre-wrap",
  },
  section: {
    background: "#fff",
    borderRadius: "24px",
    padding: "18px",
    boxShadow: "0 10px 30px rgba(0,0,0,0.06)",
    border: "1px solid #ececec",
  },
  sectionHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: "10px",
    marginBottom: "14px",
  },
  sectionTitle: {
    margin: 0,
    fontSize: "22px",
    fontWeight: 800,
  },
  countBadge: {
    fontSize: "13px",
    fontWeight: 700,
    background: "#f0f0f0",
    borderRadius: "999px",
    padding: "6px 10px",
  },
  emptyCard: {
    borderRadius: "18px",
    background: "#fafafa",
    border: "1px dashed #ddd",
    padding: "20px",
    fontSize: "15px",
    color: "#666",
    textAlign: "center",
  },
  recordList: {
    display: "flex",
    flexDirection: "column",
    gap: "12px",
  },
  recordItem: {
    width: "100%",
    border: "1px solid #ececec",
    background: "#fff",
    borderRadius: "18px",
    padding: "14px",
    textAlign: "left",
    cursor: "pointer",
  },
  recordItemActive: {
    border: "2px solid #111",
    background: "#fcfcfc",
  },
  recordTop: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: "10px",
    marginBottom: "10px",
  },
  recordIndex: {
    fontSize: "13px",
    fontWeight: 800,
    color: "#444",
  },
  recordDate: {
    fontSize: "12px",
    color: "#666",
  },
  recordMeta: {
    display: "flex",
    gap: "10px",
    flexWrap: "wrap",
    fontSize: "14px",
    fontWeight: 700,
    color: "#222",
    marginBottom: "10px",
  },
  recordActions: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: "10px",
  },
  inlineActions: {
    display: "flex",
    alignItems: "center",
    gap: "12px",
  },
  selectHint: {
    fontSize: "13px",
    color: "#666",
  },
  processText: {
    fontSize: "13px",
    fontWeight: 800,
    color: "#111",
  },
  deleteText: {
    fontSize: "13px",
    fontWeight: 800,
    color: "#111",
  },
  playerCard: {
    borderRadius: "18px",
    background: "#fafafa",
    border: "1px solid #ececec",
    padding: "16px",
  },
  playerMeta: {
    marginBottom: "12px",
  },
  playerLabel: {
    fontSize: "13px",
    fontWeight: 800,
    color: "#666",
    marginBottom: "4px",
  },
  playerDate: {
    fontSize: "15px",
    fontWeight: 700,
  },
  audio: {
    width: "100%",
    marginTop: "4px",
  },
  playerDetails: {
    display: "flex",
    flexDirection: "column",
    gap: "6px",
    marginTop: "12px",
    fontSize: "14px",
    color: "#444",
  },
  resultCard: {
    borderRadius: "18px",
    background: "#fafafa",
    border: "1px solid #ececec",
    padding: "16px",
    minHeight: "120px",
  },
  resultText: {
    fontSize: "15px",
    lineHeight: 1.8,
    color: "#222",
    whiteSpace: "pre-wrap",
  },
};