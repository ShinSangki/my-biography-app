# My Biography App

간단한 음성 녹음 기반 자서전 생성 앱입니다. 이 앱은 브라우저에서 음성을 녹음하고, 서버로 전송하여 STT 및 자서전 생성 처리를 수행합니다.

## 프로젝트 구성

- `src/`: React 프론트엔드 소스 코드
- `backend/`: Express 기반 백엔드 API 소스 코드
- `backend/src/index.ts`: API 라우트와 서버 설정
- `backend/uploads/`: 업로드된 오디오 파일 저장 위치

## 실행 방법

### 프론트엔드

```bash
npm install
npm start
```

### 백엔드

```bash
cd backend
npm install
npm run dev
```

## API 문서

프론트엔드에서 사용하는 백엔드 API는 다음과 같습니다.

### 1) 헬스 체크

- 경로: `GET /health`
- 설명: 서버 상태 확인용 엔드포인트
- 응답 예시:
  ```json
  {
    "success": true,
    "message": "server is running"
  }
  ```

### 2) 음성 파일 업로드

- 경로: `POST /upload`
- 설명: 클라이언트가 녹음한 오디오 파일을 업로드합니다.
- 요청 방식: `multipart/form-data`
- 필드:
  - `audio`: 오디오 파일
- 응답 예시:
  ```json
  {
    "success": true,
    "file": {
      "fileName": "<저장된 파일명>",
      "originalName": "<원본 파일명>",
      "mimeType": "<MIME 타입>",
      "size": <파일 크기>,
      "audioPath": "<서버 저장 경로>",
      "url": "<접근 가능한 URL>"
    }
  }
  ```

### 3) 녹음 메타데이터 저장

- 경로: `POST /recordings/save`
- 설명: 업로드된 오디오의 경로와 메타데이터를 녹음 레코드로 저장합니다.
- 요청 바디: JSON
  - `audioPath` (필수): 업로드된 오디오 경로
  - `rawText` (선택): 원문 텍스트
- 응답 예시:
  ```json
  {
    "success": true,
    "recordingId": 1
  }
  ```

### 4) STT 처리 요청

- 경로: `POST /stt`
- 설명: 저장된 오디오 파일을 텍스트로 변환합니다.
- 요청 바디: JSON
  - `audioPath` (필수): 오디오 파일 경로
  - `recordingId` (선택): 녹음 ID
- 응답 예시:
  ```json
  {
    "success": true,
    "text": "변환된 텍스트"
  }
  ```

### 5) 자서전 초안 생성

- 경로: `POST /generate`
- 설명: STT 결과 텍스트를 받아 자서전 초안 문장을 생성합니다.
- 요청 바디: JSON
  - `text` (필수): 변환된 텍스트
- 응답 예시:
  ```json
  {
    "success": true,
    "memoir": "생성된 자서전 텍스트"
  }
  ```

### 6) 자서전 저장

- 경로: `POST /memoirs/save`
- 설명: 생성된 자서전 내용을 저장합니다.
- 요청 바디: JSON
  - `recordingId` (선택): 녹음 ID
  - `title` (선택): 자서전 제목
  - `content` (필수): 자서전 내용
- 응답 예시:
  ```json
  {
    "success": true,
    "memoirId": 1
  }
  ```

### 7) 저장된 자서전 조회

- 경로: `GET /memoirs/:id`
- 설명: 저장된 자서전을 ID로 조회합니다.
- 응답 예시:
  ```json
  {
    "success": true,
    "memoir": {
      "id": 1,
      "recordingId": 1,
      "title": "내 이야기",
      "content": "자서전 내용"
    }
  }
  ```

### 8) 녹음 데이터 조회

- 경로: `GET /recordings/:id`
- 설명: 녹음 메타데이터를 ID로 조회합니다.
- 응답 예시:
  ```json
  {
    "success": true,
    "recording": {
      "id": 1,
      "fileName": "...",
      "filePath": "...",
      "mimeType": "...",
      "fileSize": 12345,
      "rawText": "..."
    }
  }
  ```

## API 사용 흐름

1. 클라이언트에서 음성을 녹음합니다.
2. 녹음 결과를 `POST /upload`로 서버에 업로드합니다.
3. 업로드 결과로 받은 `audioPath`를 `POST /recordings/save`에 전달해 녹음 정보를 저장합니다.
4. `POST /stt`로 오디오 파일을 텍스트로 변환합니다.
5. 변환된 텍스트를 `POST /generate`에 보내 자서전 초안을 생성합니다.
6. 생성된 자서전 문장을 `POST /memoirs/save`로 저장합니다.

## 참고

- 프론트엔드에서 기본 API URL은 `http://localhost:4000`으로 설정되어 있습니다.
- 오디오 파일은 `backend/uploads` 디렉터리에 저장됩니다.
