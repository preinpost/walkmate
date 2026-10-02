# pi-review-recorder

실행 중인 앱이나 리뷰 페이지를 보면서 말로 리뷰하면, 음성과 "그때 무엇을 가리키고 있었는지"가
하나의 타임라인으로 합쳐져 에이전트에게 돌아간다.

- **라이브 리뷰**: 앱(예: `http://localhost:5173/dashboard`)을 리뷰 전용 Chrome 창에서 열고, 직접 써 보면서 말한다.
  발화마다 그때 가리킨 요소, React 컴포넌트, 소스 파일과 줄, 스크린샷이 붙는다. rrweb로 화면과 음성을 다시 재생할 수 있다.
- **문서 리뷰**: 에이전트가 정리한 결정·질문·diff 페이지를 읽으며 말하고 답한다.

[ETOOMANYTHINGS? Run Fewer Agents](https://blog.exe.dev/etoomanythings)의 DOM 녹화 아이디어를 pi 확장으로 옮겼다.

## 설치

```bash
cd ~/dev/pi-review-recorder && npm install
pi install ~/dev/pi-review-recorder      # 또는 한 번만: pi -e ~/dev/pi-review-recorder
```

받아쓰기는 로컬 whisper.cpp가 기본이다.

```bash
brew install whisper-cpp
mkdir -p ~/.pi/agent/review-recorder/models
curl -L -o ~/.pi/agent/review-recorder/models/ggml-large-v3-turbo.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin
```

whisper.cpp가 없고 `OPENAI_API_KEY`(또는 pi에 등록된 openai 키)가 있으면 OpenAI `whisper-1`을 쓴다.
둘 다 없어도 텍스트 코멘트와 답, 화면 추적은 그대로 전달되고 녹음 파일 경로가 경고로 붙는다.

## 쓰는 법

- **`/review <url> [제목]`**: 라이브 리뷰. 예: `/review localhost:5173/dashboard 대시보드`
- **`/review [제목]`**: 문서 리뷰. 에이전트의 마지막 응답과 커밋하지 않은 변경 전체로 페이지를 만든다.
- **`request_review` 도구**: 에이전트가 스스로 호출한다. `url`을 주면 라이브, 없으면 문서 리뷰.
  라이브에서는 섹션이 툴바의 "리뷰 포인트" 목록이 된다(섹션에 `url`을 주면 누를 때 그 페이지로 이동).

명령으로 시작하면 피드백은 사용자 메시지로, 도구로 시작하면 도구 결과로 에이전트에게 간다.

### 라이브 리뷰

리뷰 전용 Chrome 창이 열린다(프로필 `~/.pi/agent/review-recorder/chrome-profile`, 로그인은 처음 한 번).
오른쪽 아래 툴바:

| | |
|---|---|
| **● 녹음** `Alt+R` | 마이크 녹음 켜기/끄기. 페이지를 이동하거나 새로고침해도 끊기지 않는다 |
| **📌 핀** `Alt+P` | 다음에 클릭한 요소를 "여기"로 지정(클릭은 앱에 전달되지 않음). 메모를 붙일 수 있다 |
| **포인트** | 에이전트가 준 리뷰 포인트. 누르면 "지금 이 포인트 이야기 중"으로 표시 |
| **제출** / **✕** | 제출하면 창이 닫히고 결과가 간다. 창을 그냥 닫아도 녹음이나 핀이 있으면 제출된다 |

새 탭, 앱 안 이동, 새로고침 모두 기록된다. 마이크는 확장이 ffmpeg로 직접 녹음하므로,
처음 한 번 macOS가 터미널 앱에 마이크 권한을 묻는다.

### 문서 리뷰

페이지에서 `R` 또는 **● 녹음**으로 녹음을 켜고 끈다. 여러 번 끊어 녹음해도 된다.
섹션마다 텍스트 코멘트를, 질문에는 선택지 버튼을 쓸 수 있다.

## 에이전트가 받는 것

라이브 리뷰:

```
1. [00:01.0] 🗣 "이 범례 색이 너무 비슷해서 구분이 안 돼요."
   ↳ /dashboard · <ServiceUsageChart> li "Compute" (src/features/dashboard/chart/ServiceUsageChart.tsx:42)  🖼 #2
2. [00:05.6] 🗣 "여기 숫자는 오른쪽 정렬해 주세요."
   ↳ /dashboard · <InvoiceTable> td "1,234,000원" (src/features/dashboard/table/InvoiceTable.tsx:18)  🖼 #1

## 핀
📌1 [00:05.6] /dashboard · <InvoiceTable> td "1,234,000원" — 메모: "오른쪽 정렬"  🖼 #1
```

뒤에 전체 타임라인(페이지 이동, 포인터, 클릭, 입력, 스크롤)이 오고, 대상에 빨간 상자를 그린 스크린샷이
최대 6장 붙는다. 컴포넌트와 파일은 React 개발 빌드의 디버그 정보에서 찾는다(프로덕션 빌드에서는 생략된다).

문서 리뷰:

```
### d1 · 결정 · user_id를 nullable로 변경  (본 시간 0:04)
- 🗣 [00:02.0] "음 이 결정은 좀 이상한데요"
- ✂ [00:01.8] 선택: "user_id INTEGER NULL"

## 타임라인
[00:07.3] 👉 src/auth.go L40-58 L42(추가): `if u.ID == nil {`
[00:08.1] 🗣 "아 여기서 쓰는구나, 그럼 괜찮아요"
```

원본(녹음, 이벤트, 스크린샷, rrweb, 보고서)은 `~/.pi/agent/review-recorder/reviews/<세션>/<시각>/`에 남는다.
라이브 리뷰의 `replay.html`을 열면 rrweb 화면과 녹음이 같이 재생되고, 발화 목록을 누르면 그 시점으로 간다.

## 설정 (환경 변수)

| 변수 | 기본값 | |
|---|---|---|
| `PI_REVIEW_TRANSCRIBER` | `auto` | `whisper-cpp`, `openai`, `none` |
| `PI_REVIEW_LANG` | `ko` | 받아쓰기 언어 |
| `PI_REVIEW_WHISPER_BIN` | `whisper-cli` | |
| `PI_REVIEW_WHISPER_MODEL` | `~/.pi/agent/review-recorder/models/ggml-large-v3-turbo.bin` | |
| `PI_REVIEW_TIMEOUT_MIN` | `60` | `0`이면 무제한 |
| `PI_REVIEW_OPEN` | | 문서 리뷰: `0`이면 브라우저를 자동으로 열지 않음 (URL은 위젯에 표시) |
| `PI_REVIEW_MIC` | `default` | 라이브 리뷰 마이크 (ffmpeg avfoundation 장치 이름이나 번호) |
| `PI_REVIEW_MAX_SHOTS` | `6` | 라이브 리뷰 결과에 붙일 스크린샷 수 |
| `PI_REVIEW_CHROME` | macOS Chrome 경로 | |
| `PI_REVIEW_CHROME_PROFILE` | `~/.pi/agent/review-recorder/chrome-profile` | |

## 구조

| 파일 | 역할 |
|---|---|
| `src/index.ts` | 도구, `/review` 명령, 종료 시 정리 |
| `src/review.ts` | 한 번의 리뷰: 열기 → 대기 → 받아쓰기 → 보고서 (문서·라이브) |
| `src/live/cdp.ts` | CDP 클라이언트, 전용 프로필 Chrome 실행/재연결 |
| `src/live/session.ts` | 모든 탭에 스크립트 주입, 이벤트 수신, 녹음 제어, 스크린샷, rrweb 저장 |
| `src/live/mic.ts` | ffmpeg 마이크 녹음과 레벨 미터 |
| `src/live/report.ts` | 이벤트 압축, 발화 ↔ 대상 연결, 스크린샷 선택·표시, 보고서 |
| `src/live/replay.ts` | rrweb + 음성 동기 재생 페이지 |
| `src/page/live.js` | 앱 페이지: 툴바, 포인터·클릭·선택·입력·스크롤·이동 추적, React 컴포넌트·소스 찾기, 핀 |
| `src/render.ts` | 섹션 → HTML. 모든 요소에 `data-rid`를 붙이고 사람이 읽을 이름표를 만든다 |
| `src/diff.ts` | git diff를 파일·hunk·줄 단위로 나눈다 |
| `src/server.ts` | 127.0.0.1 서버. 토큰 경로, nonce 전용 스크립트 정책 |
| `src/page/recorder.js` | 브라우저: 화면 중앙·포인터·선택·클릭 추적, 마이크 녹음 |
| `src/transcribe.ts` | whisper.cpp / OpenAI, 단어 단위 타임스탬프 |
| `src/timeline.ts` | 스쳐 간 이벤트 제거, 발화 묶기, 발화를 가리킨 대상에 연결, 보고서 |

## 개발

```bash
npm run check          # tsc
npm test               # node --test
node scripts/e2e.ts        # 문서 리뷰: 헤드리스 Chrome + 가짜 마이크(say -v Yuna)
node scripts/e2e-live.ts   # 라이브 리뷰: 테스트 앱, 핀, 앱 안 이동, 새 탭, 보고서, replay.html
```

`tsconfig.json`의 `paths`는 이 머신의 전역 pi 설치 경로를 가리킨다. 다른 곳에서는 고쳐야 한다.
