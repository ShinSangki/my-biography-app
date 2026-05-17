import React, { useEffect, useRef, useState } from "react";
import "./App.css";

/* ==========================================
   [1] 데이터 타입 정의 (Types)
   ========================================== */
type RecordItem = {
  id: string;
  createdAt: string;
  durationMs: number;
  mimeType: string;
  blob?: Blob;
  audioUrl?: string;
  status: "local" | "processing" | "done" | "error";
  audioPath?: string;
  recordingId?: number;
  memoirId?: number;
  sttText?: string;
  memoirText?: string;
  title?: string;
  time?: string;
  location?: string;
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
  title: string;
  time: string;
  location: string;
};

type SaveMemoirResponse = {
  success: boolean;
  memoirId: number;
};

const API_BASE_URL =
  process.env.REACT_APP_API_BASE_URL || "http://localhost:4000";

/* ==========================================
   [2] 유틸리티 함수 (Utils)
   ========================================== */
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
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(type)) return type;
  }
  return "";
}

/* ==========================================
   [3] 메인 앱 컴포넌트 (Main App)
   ========================================== */
export default function App() {

  /* --- 3-1. 상태 및 참조 관리 (State & Refs) --- */
  const timerRef = useRef<number | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);

  const [isSupported, setIsSupported] = useState<boolean | null>(null);
  const [hasPermission, setHasPermission] = useState<boolean>(false);
  const [isChecking, setIsChecking] = useState(true);

  const [isRecording, setIsRecording] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);

  const [records, setRecords] = useState<RecordItem[]>([]);
  const [message, setMessage] = useState("준비되었습니다.");
  const [error, setError] = useState("");
  const [isProcessing, setIsProcessing] = useState(false);

  const [editingRecord, setEditingRecord] = useState<RecordItem | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editContent, setEditContent] = useState("");
  const [editTime, setEditTime] = useState("");
  const [editLocation, setEditLocation] = useState("");

  const [currentTab, setCurrentTab] = useState(0); // 0: 녹음(Home), 1: 내 자서전(History)
  const [touchStart, setTouchStart] = useState<number | null>(null);
  const [touchEnd, setTouchEnd] = useState<number | null>(null);

  /* --- 3-2. 생명주기 및 초기화 (Lifecycle) --- */
  useEffect(() => {
    initRecorder();
    loadHistory();

    return () => {
      stopTimer();

      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
      }

      records.forEach((item) => {
        if (item.audioUrl) URL.revokeObjectURL(item.audioUrl);
      });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* --- 3-3. 데이터 로드 (Data Fetching) --- */
  async function loadHistory() {
    try {
      const response = await fetch(`${API_BASE_URL}/autobiographies`);
      if (response.ok) {
        const result = await response.json();
        if (result.success && result.data) {
          const historyRecords: RecordItem[] = result.data.map((m: any) => ({
            id: `history-${m.id}`,
            memoirId: Number(m.id),
            recordingId: m.recordingId,
            createdAt: m.createdAt,
            time: m.time,
            location: m.location,
            title: m.title,
            memoirText: m.content,
            durationMs: 0,
            mimeType: "",
            status: "done",
          }));
          setRecords((prev) => {
            // 중복 로드 방지
            const newRecords = historyRecords.filter(hr => !prev.some(pr => pr.memoirId === hr.memoirId));
            return [...prev, ...newRecords];
          });
        }
      }
    } catch (e) {
      console.error("과거 기록을 불러오는데 실패했습니다.", e);
    }
  }

  const minSwipeDistance = 50;

  const onTouchStart = (e: React.TouchEvent | React.MouseEvent) => {
    setTouchEnd(null);
    if ("targetTouches" in e) setTouchStart(e.targetTouches[0].clientX);
    else setTouchStart((e as React.MouseEvent).clientX);
  };

  const onTouchMove = (e: React.TouchEvent | React.MouseEvent) => {
    if ("targetTouches" in e) setTouchEnd(e.targetTouches[0].clientX);
    else setTouchEnd((e as React.MouseEvent).clientX);
  };

  const onTouchEndHandler = () => {
    if (!touchStart || !touchEnd) return;
    const distance = touchStart - touchEnd;
    const isLeftSwipe = distance > minSwipeDistance;
    const isRightSwipe = distance < -minSwipeDistance;
    if (isLeftSwipe && currentTab === 0) setCurrentTab(1);
    if (isRightSwipe && currentTab === 1) setCurrentTab(0);
  };

  /* --- 3-4. 오디오 녹음 및 기기 제어 (Audio Control) --- */
  async function initRecorder() {
    setIsChecking(true);
    setError("");

    try {
      const supported =
        typeof navigator !== "undefined" && !!navigator.mediaDevices &&
        !!navigator.mediaDevices.getUserMedia && typeof MediaRecorder !== "undefined";
      setIsSupported(supported);
      if (!supported) {
        setMessage("이 브라우저에서는 음성 녹음을 사용할 수 없습니다.");
        return;
      }
      try {
        const permissionStatus = await navigator.permissions?.query?.({ name: "microphone" as PermissionName });
        if (permissionStatus) setHasPermission(permissionStatus.state === "granted");
      } catch { }
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
      setError(`권한 요청 실패: ${e instanceof Error ? e.message : String(e)}`);
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
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);

      recorder.ondataavailable = (event: BlobEvent) => {
        if (event.data && event.data.size > 0) audioChunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        const finalMimeType = recorder.mimeType || "audio/webm";
        const blob = new Blob(audioChunksRef.current, { type: finalMimeType });
        const audioUrl = URL.createObjectURL(blob);
        const item: RecordItem = {
          id: `${Date.now()}`, createdAt: new Date().toLocaleString("ko-KR"),
          durationMs: recordSeconds * 1000, mimeType: finalMimeType,
          blob, audioUrl, status: "local",
        };
        setRecords((prev) => [item, ...prev]);
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
      setError(`녹음 시작 실패: ${e instanceof Error ? e.message : String(e)}`);
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
      setError(`녹음 종료 실패: ${e instanceof Error ? e.message : String(e)}`);
      setMessage("녹음 종료 실패");
    } finally {
      setIsStopping(false);
    }
  }

  async function handleDeleteRecord(id: string) {
    const target = records.find((item) => item.id === id);
    if (target && target.audioUrl) {
      URL.revokeObjectURL(target.audioUrl);
    }

    // 백엔드 DB에서도 삭제 요청
    if (target && target.memoirId) {
      try {
        await fetch(`${API_BASE_URL}/autobiographies/${target.memoirId}`, {
          method: "DELETE"
        });
      } catch(e) {
        console.error(e);
      }
    }

    const next = records.filter((item) => item.id !== id);
    setRecords(next);

    setMessage("녹음이 삭제되었습니다.");
  }

  function updateRecord(id: string, updater: (item: RecordItem) => RecordItem) {
    setRecords((prev) =>
      prev.map((item) => (item.id === id ? updater(item) : item))
    );
  }

  /* --- 3-5. 서버 API 통신 (API Requests) --- */
  async function uploadAudio(blob: Blob): Promise<UploadResponse> {
    const extension = blob.type.includes("mp4")
      ? "mp4"
      : blob.type.includes("ogg")
      ? "ogg"
      : blob.type.includes("aac")
      ? "aac"
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

  async function handleProcessRecord(id: string) {
    const target = records.find((item) => item.id === id);
    if (!target) return;

    if (!target.blob) {
      setError("업로드할 오디오 데이터가 없습니다.");
      return;
    }

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
        title: generateResult.title,
        time: generateResult.time,
        location: generateResult.location,
      }));

      setMessage("자서전 초안을 저장하고 있습니다.");
      const saveMemoirResult = await saveMemoir(
        recordingId,
        generateResult.memoir,
        generateResult.title,
        generateResult.time,
        generateResult.location
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

  function openModal(item: RecordItem) {
    setEditingRecord(item);
    setEditTitle(item.title || "제목 없는 이야기");
    setEditContent(item.memoirText || "");
    setEditTime(item.time || "");
    setEditLocation(item.location || "");
  }

  async function saveModal() {
    if (editingRecord) {
      updateRecord(editingRecord.id, (r) => ({ ...r, title: editTitle, memoirText: editContent, time: editTime, location: editLocation }));
      
      // 백엔드 DB에도 수정 사항 반영
      if (editingRecord.memoirId) {
        try {
          await fetch(`${API_BASE_URL}/autobiographies/${editingRecord.memoirId}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ title: editTitle, content: editContent, time: editTime, location: editLocation })
          });
        } catch (e) {
          console.error("자서전 수정에 실패했습니다.", e);
        }
      }

      setEditingRecord(null);
      setMessage("이야기가 수정되었습니다.");
    }
  }

  /* ==========================================
     [4] UI 렌더링 (Render)
     ========================================== */
  return (
    <div style={styles.page}>
      <div style={styles.appShell}>
        <header style={styles.header}>
          <h1 style={styles.headerTitle}>{currentTab === 0 ? "음성 자서전" : "나의 자서전"}</h1>
        </header>

        <div
          style={styles.mainWrap}
          onTouchStart={onTouchStart}
          onTouchMove={onTouchMove}
          onTouchEnd={onTouchEndHandler}
          onMouseDown={onTouchStart}
          onMouseMove={onTouchMove}
          onMouseUp={onTouchEndHandler}
          onMouseLeave={onTouchEndHandler}
        >
          <div style={{ ...styles.swipeContainer, transform: `translateX(-${currentTab * 50}%)` }}>
            <div style={styles.tabView}>
              {/* ---------- [탭 1: 녹음 홈 화면] ---------- */}
              {isProcessing ? (
                <div style={styles.centerBox}>
                  <div style={styles.loadingText}>이야기를 다듬고 있습니다...</div>
                  <p style={styles.statusSubText}>AI가 멋진 문장으로 정리하고 있어요.</p>
                </div>
              ) : (
                <div style={styles.centerBox}>
                  <p style={styles.greetingText}>오늘의 기억을 들려주세요.</p>
                  <div style={styles.timerValue}>{formatTime(recordSeconds)}</div>
                  <button
                    onClick={isRecording ? handleStopRecording : handleStartRecording}
                    style={{
                      ...styles.recordButton,
                      backgroundColor: isRecording ? "#E74C3C" : "#D4A373",
                      transform: isRecording ? "scale(1.05)" : "scale(1)",
                    }}
                  >
                    {isRecording ? "녹음 종료" : "녹음 시작"}
                  </button>
                  <p style={styles.statusSubText}>
                    {!hasPermission ? "먼저 마이크 권한을 허용해 주세요." : isRecording ? "녹음 중..." : message}
                  </p>
                  {error && <p style={{ color: "#E74C3C", fontSize: "14px", marginTop: "8px", textAlign: "center", wordBreak: "break-word" }}>{error}</p>}
                  {!hasPermission && (
                    <button type="button" onClick={requestPermission} style={styles.permissionButton}>
                      마이크 권한 허용
                    </button>
                  )}
                </div>
              )}
            </div>

            <div style={styles.tabView}>
              {/* ---------- [탭 2: 자서전 목록(보관함) 화면] ---------- */}
              <div style={styles.historyHeader}>나의 이야기 보관함</div>
              {records.length === 0 ? (
                <div style={styles.emptyCard}>아직 저장된 이야기가 없습니다.</div>
              ) : (
                <div style={styles.recordList}>
                  {records.map((item) => (
                    <div key={item.id} style={styles.historyCard} onClick={() => openModal(item)}>
                      <h3 style={styles.historyTitle}>{item.title || "제목 없는 이야기"}</h3>
                      <div style={styles.historyDate}>{item.createdAt}</div>
                      <p style={styles.historyPreview}>
                        {item.status === "error"
                          ? `❌ 오류: ${item.errorMessage}`
                          : item.status === "processing"
                          ? "⏳ AI가 자서전을 작성 중입니다..."
                          : item.memoirText
                          ? item.memoirText.substring(0, 40) + "..."
                          : "STT 결과가 없습니다."}
                      </p>
                      {item.status === 'local' && (
                        <button 
                          style={styles.processButton}
                          onClick={(e) => { e.stopPropagation(); handleProcessRecord(item.id); }}>
                           서버 처리 시작
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* ---------- [하단 탭 네비게이션 바] ---------- */}
        <div style={styles.bottomNav}>
          <div
            style={{ ...styles.navItem, color: currentTab === 0 ? "#2C3E50" : "#A0A0A0" }}
            onClick={() => setCurrentTab(0)}
          >
            🎙️ 녹음하기
          </div>
          <div
            style={{ ...styles.navItem, color: currentTab === 1 ? "#2C3E50" : "#A0A0A0" }}
            onClick={() => setCurrentTab(1)}
          >
            📖 내 자서전
          </div>
        </div>
      </div>

      {/* ---------- [오버레이: 상세 보기 및 수정 모달창] ---------- */}
      {editingRecord && (
        <div style={styles.modalOverlay}>
          <div style={styles.modalContent}>
            <input
              style={styles.modalTitleInput}
              value={editTitle}
              onChange={(e) => setEditTitle(e.target.value)}
              placeholder="제목"
            />
            <div style={styles.modalTags}>
              <span style={styles.tagChip}>
                ️ 시기: <input style={styles.tagInput} value={editTime} onChange={e => setEditTime(e.target.value)} placeholder="알 수 없는 시기" />
              </span>
              <span style={styles.tagChip}>
                📍 장소: <input style={styles.tagInput} value={editLocation} onChange={e => setEditLocation(e.target.value)} placeholder="알 수 없는 장소" />
              </span>
            </div>
            
            {editingRecord.audioUrl && (
              <audio controls src={editingRecord.audioUrl} style={styles.audioPlayer} />
            )}

            <textarea
              style={styles.modalTextArea}
              value={editContent}
              onChange={(e) => setEditContent(e.target.value)}
              placeholder="아직 완성된 자서전 본문이 없습니다."
            />
            <div style={styles.modalActions}>
              <button style={styles.saveBtn} onClick={saveModal}>수정 완료</button>
              <button
                style={styles.deleteBtn}
                onClick={() => {
                  handleDeleteRecord(editingRecord.id);
                  setEditingRecord(null);
                }}
              >
                삭제
              </button>
              <button style={styles.cancelBtn} onClick={() => setEditingRecord(null)}>닫기</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ==========================================
   [5] 인라인 스타일시트 (CSS-in-JS)
   ========================================== */
const styles: Record<string, React.CSSProperties> = {
  page: {
    minHeight: "100vh",
    background: "#1a1a1a",
    display: "flex",
    justifyContent: "center",
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Pretendard", "Noto Sans KR", sans-serif',
  },
  appShell: {
    width: "100%",
    maxWidth: "520px",
    height: "100vh",
    background: "#FDFBF7",
    display: "flex",
    flexDirection: "column",
    position: "relative",
  },
  header: {
    background: "#2C3E50",
    padding: "20px 16px",
    textAlign: "center",
    color: "#FFFFFF",
  },
  headerTitle: {
    margin: 0,
    fontSize: "22px",
    fontWeight: "bold",
  },
  mainWrap: {
    flex: 1,
    overflow: "hidden",
    position: "relative",
  },
  swipeContainer: {
    display: "flex",
    width: "200%",
    height: "100%",
    transition: "transform 0.3s ease-out",
  },
  tabView: {
    width: "50%",
    height: "100%",
    overflowY: "auto",
    padding: "24px 16px",
    boxSizing: "border-box",
  },
  centerBox: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    height: "100%",
    gap: "20px",
  },
  greetingText: {
    fontSize: "22px",
    fontWeight: "bold",
    color: "#1E1E1E",
    margin: 0,
  },
  timerValue: {
    fontSize: "48px",
    fontWeight: "bold",
    color: "#2C3E50",
    margin: "10px 0",
  },
  recordButton: {
    width: "160px",
    height: "160px",
    borderRadius: "50%",
    color: "#FFFFFF",
    fontSize: "24px",
    fontWeight: "bold",
    border: "none",
    cursor: "pointer",
    boxShadow: "0 8px 24px rgba(0,0,0,0.15)",
  },
  statusSubText: {
    fontSize: "16px",
    color: "#4A4A4A",
    textAlign: "center",
  },
  permissionButton: {
    marginTop: "10px",
    padding: "12px 24px",
    background: "#2C3E50",
    color: "#FFFFFF",
    border: "none",
    borderRadius: "8px",
    fontSize: "16px",
    cursor: "pointer",
  },
  loadingText: {
    fontSize: "22px",
    fontWeight: "bold",
    color: "#D4A373",
    margin: 0,
  },
  historyHeader: {
    fontSize: "22px",
    fontWeight: "bold",
    color: "#1E1E1E",
    marginBottom: "20px",
  },
  emptyCard: {
    textAlign: "center",
    padding: "40px 20px",
    color: "#888",
    fontSize: "15px",
  },
  recordList: {
    display: "flex",
    flexDirection: "column",
    gap: "12px",
  },
  historyCard: {
    background: "#FFFFFF",
    borderRadius: "16px",
    padding: "20px",
    boxShadow: "0 4px 12px rgba(0,0,0,0.05)",
    cursor: "pointer",
  },
  historyTitle: {
    margin: "0 0 8px 0",
    fontSize: "20px",
    color: "#1E1E1E",
  },
  historyDate: {
    fontSize: "14px",
    color: "#888",
    marginBottom: "12px",
  },
  historyPreview: {
    fontSize: "16px",
    color: "#4A4A4A",
    lineHeight: 1.5,
    margin: 0,
  },
  processButton: {
    marginTop: "8px",
    padding: "8px 16px",
    background: "#2C3E50",
    color: "#FFF",
    border: "none",
    borderRadius: "8px",
    fontSize: "14px",
    cursor: "pointer",
  },
  bottomNav: {
    display: "flex",
    background: "#FFFFFF",
    borderTop: "1px solid #EEEEEE",
    padding: "16px 0",
  },
  navItem: {
    flex: 1,
    textAlign: "center",
    fontSize: "16px",
    fontWeight: "bold",
    cursor: "pointer",
  },
  modalOverlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    background: "rgba(0,0,0,0.6)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 1000,
    padding: "16px",
  },
  modalContent: {
    background: "#FDFBF7",
    width: "100%",
    maxWidth: "480px",
    borderRadius: "24px",
    padding: "24px",
    display: "flex",
    flexDirection: "column",
    gap: "16px",
    maxHeight: "90vh",
  },
  modalTitleInput: {
    fontSize: "24px",
    fontWeight: "bold",
    color: "#1E1E1E",
    border: "none",
    borderBottom: "2px solid #D4A373",
    padding: "8px 0",
    background: "transparent",
    outline: "none",
  },
  modalTags: { display: "flex", gap: "8px", flexWrap: "wrap" },
  tagChip: { background: "#ECECEC", padding: "6px 12px", borderRadius: "16px", fontSize: "14px", color: "#4A4A4A" },
  tagInput: {
    background: "transparent",
    border: "none",
    outline: "none",
    fontSize: "14px",
    color: "#4A4A4A",
    width: "140px",
  },
  audioPlayer: { width: "100%", height: "40px" },
  modalTextArea: {
    flex: 1,
    minHeight: "240px",
    fontSize: "18px",
    color: "#4A4A4A",
    lineHeight: 1.6,
    padding: "12px",
    border: "1px solid #DDDDDD",
    borderRadius: "12px",
    resize: "none",
    outline: "none",
  },
  modalActions: { display: "flex", gap: "12px", marginTop: "8px" },
  saveBtn: { flex: 1, padding: "14px", background: "#27AE60", color: "#fff", border: "none", borderRadius: "12px", fontSize: "16px", fontWeight: "bold", cursor: "pointer" },
  deleteBtn: { padding: "14px", background: "#E74C3C", color: "#fff", border: "none", borderRadius: "12px", fontSize: "16px", fontWeight: "bold", cursor: "pointer" },
  cancelBtn: { padding: "14px", background: "#888", color: "#fff", border: "none", borderRadius: "12px", fontSize: "16px", fontWeight: "bold", cursor: "pointer" },
};