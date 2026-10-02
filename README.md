# review-recorder

실행 중인 앱이나 리뷰 페이지를 보면서 말로 리뷰하면, 음성과 "그때 무엇을 가리키고 있었는지"가
하나의 타임라인으로 합쳐져 코딩 에이전트에게 돌아간다. Claude Code, Codex 등은 MCP 서버로, pi는 확장으로 쓴다.

- **라이브 리뷰**: 앱(예: `http://localhost:5173/dashboard`)을 리뷰 전용 Chrome 창에서 열고, 직접 써 보면서 말한다.
  발화마다 그때 가리킨 요소, React 컴포넌트, 소스 파일과 줄, 스크린샷이 붙는다. rrweb로 화면과 음성을 다시 재생할 수 있다.
- **문서 리뷰**: 에이전트가 정리한 결정·질문·diff 페이지를 읽으며 말하고 답한다.

[ETOOMANYTHINGS? Run Fewer Agents](https://blog.exe.dev/etoomanythings)의 DOM 녹화 아이디어에서 출발했다.

## 준비 (macOS)

```bash
brew install ffmpeg whisper-cpp     # Chrome도 필요
```

## 설치

### Claude Code / Codex (MCP)

```bash
git clone <이 저장소> ~/dev/review-recorder
cd ~/dev/review-recorder && npm install    # dist/ 빌드까지 된다
npm link                                   # review-recorder 명령 등록

review-recorder setup                      # whisper 모델(약 1.6GB)을 ~/.review-recorder/models 에 받는다
review-recorder doctor --mic               # 점검. 처음이면 macOS가 터미널 앱에 마이크 권한을 묻는다

claude mcp add -s user review-recorder -- review-recorder mcp
codex mcp add review-recorder -- review-recorder mcp
```

whisper.cpp 대신 OpenAI `whisper-1`을 쓰려면 `OPENAI_API_KEY`만 있으면 된다(MCP 서버 환경에 전달되도록).

### pi

```bash
pi install ~/dev/review-recorder       # 또는 한 번만: pi -e ~/dev/review-recorder
```

pi에서는 `request_review` 도구 하나가 제출될 때까지 기다리고, `/review` 명령과 진행 위젯이 있다.

## 쓰는 법

에이전트에게 말하면 된다.

- "localhost:5173/dashboard 라이브 리뷰 열어줘"
- "방금 한 작업 리뷰 페이지로 보여줘"

명령으로도 시작할 수 있다.

| | 라이브 리뷰 | 문서 리뷰 |
|---|---|---|
| Claude Code | `/review-recorder:live_review` (MCP 프롬프트) | `/review-recorder:review_changes` |
| pi | `/review <url> [제목]` | `/review [제목]` |

### 라이브 리뷰

리뷰 전용 Chrome 창이 열린다(프로필 `~/.review-recorder/chrome-profile`, 로그인은 처음 한 번).
오른쪽 아래 툴바:

| | |
|---|---|
| **● 녹음** `Alt+R` | 마이크 녹음 켜기/끄기. 페이지를 이동하거나 새로고침해도 끊기지 않는다 |
| **📌 핀** `Alt+P` | 다음에 클릭한 요소를 "여기"로 지정(클릭은 앱에 전달되지 않음). 메모를 붙일 수 있다 |
| **포인트** | 에이전트가 준 리뷰 포인트. 누르면 "지금 이 포인트 이야기 중"으로 표시 |
| **제출** / **✕** | 제출하면 창이 닫히고 결과가 간다. 창을 그냥 닫아도 녹음이나 핀이 있으면 제출된다 |

새 탭, 앱 안 이동, 새로고침 모두 기록된다. 마이크는 ffmpeg로 직접 녹음한다.

### 문서 리뷰

기본 브라우저에 페이지가 열린다. `R` 또는 **● 녹음**으로 녹음을 켜고 끈다.
섹션마다 텍스트 코멘트를, 질문에는 선택지 버튼을 쓸 수 있다. 탭을 닫았다면 리뷰 폴더의 `url.txt`로 다시 연다.

## MCP 도구

리뷰는 몇 분씩 걸리고 MCP 클라이언트는 도구 호출에 타임아웃이 있어서, 기다리는 도구를 나눴다.

| 도구 | |
|---|---|
| `review_start` | 리뷰를 열고 바로 id를 돌려준다. `url`이 있으면 라이브, 없으면 `sections`로 문서 리뷰 |
| `review_wait` | 최대 45초(`REVIEW_RECORDER_WAIT_SEC`) 기다린다. 끝났으면 피드백(텍스트+스크린샷), 아니면 "다시 호출" |
| `review_cancel` | 열린 리뷰를 닫는다 |

한 서버에서 동시에 하나의 리뷰만 연다. 에이전트가 끝나면(서버 종료) 열린 리뷰와 리뷰 창도 닫힌다.

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
```

원본(녹음, 이벤트, 스크린샷, rrweb, 보고서)은 `~/.review-recorder/reviews/<세션>/<시각>/`에 남는다.
라이브 리뷰의 `replay.html`을 열면 rrweb 화면과 녹음이 같이 재생되고, 발화 목록을 누르면 그 시점으로 간다.

## 설정 (환경 변수)

| 변수 | 기본값 | |
|---|---|---|
| `REVIEW_RECORDER_HOME` | `~/.review-recorder` | 모델, 리뷰 기록, 브라우저 프로필 |
| `REVIEW_RECORDER_TRANSCRIBER` | `auto` | `whisper-cpp`, `openai`, `none` |
| `REVIEW_RECORDER_LANG` | `ko` | 받아쓰기 언어 |
| `REVIEW_RECORDER_WHISPER_BIN` | `whisper-cli` | |
| `REVIEW_RECORDER_WHISPER_MODEL` | `$HOME/models/ggml-large-v3-turbo.bin` | |
| `REVIEW_RECORDER_TIMEOUT_MIN` | `60` | 리뷰 제한 시간. `0`이면 무제한 |
| `REVIEW_RECORDER_WAIT_SEC` | `45` | MCP `review_wait` 한 번의 대기. 클라이언트 도구 타임아웃보다 짧게 |
| `REVIEW_RECORDER_OPEN` | | 문서 리뷰: `0`이면 브라우저를 자동으로 열지 않음 |
| `REVIEW_RECORDER_MIC` | `default` | 마이크 (ffmpeg avfoundation 장치 이름이나 번호) |
| `REVIEW_RECORDER_MAX_SHOTS` | `6` | 라이브 리뷰 결과에 붙일 스크린샷 수 |
| `REVIEW_RECORDER_CHROME` | macOS Chrome 경로 | |
| `REVIEW_RECORDER_CHROME_PROFILE` | `$HOME/chrome-profile` | |

## 구조

```
src/core/   에이전트와 무관한 리뷰 엔진
src/mcp/    stdio MCP 서버와 review-recorder 명령 (dist/로 빌드)
src/pi/     pi 확장 (pi가 TypeScript를 바로 읽는다)
```

| 파일 | 역할 |
|---|---|
| `core/review.ts` | 한 번의 리뷰: 열기 → 대기 → 받아쓰기 → 보고서 (문서·라이브). 호스트는 `ReviewEnv`로 연결 |
| `core/types.ts` | 요청 JSON Schema와 검사 |
| `core/render.ts`, `core/server.ts`, `core/diff.ts`, `core/timeline.ts` | 문서 리뷰 페이지, 127.0.0.1 서버, git diff, 보고서 |
| `core/live/cdp.ts` | CDP 클라이언트, 전용 프로필 Chrome 실행/재연결 |
| `core/live/session.ts` | 모든 탭에 스크립트 주입, 이벤트 수신, 녹음 제어, 스크린샷, rrweb 저장 |
| `core/live/mic.ts` | ffmpeg 마이크 녹음과 레벨 미터 |
| `core/live/report.ts` | 이벤트 압축, 발화 ↔ 대상 연결, 스크린샷 선택·표시, 보고서 |
| `core/live/replay.ts` | rrweb + 음성 동기 재생 페이지 |
| `core/page/live.js` | 앱 페이지: 툴바, 포인터·클릭·선택·입력·스크롤·이동 추적, React 컴포넌트·소스 찾기, 핀 |
| `core/transcribe.ts` | whisper.cpp / OpenAI, 단어 단위 타임스탬프, 무음 클립 제외 |
| `mcp/server.ts` | MCP 도구 `review_start` / `review_wait` / `review_cancel`, 프롬프트 |
| `mcp/cli.ts` | `review-recorder mcp | doctor | setup` |
| `pi/index.ts` | pi 도구 `request_review`, `/review`, 위젯 |

## 개발

```bash
npm run check                      # tsc
npm test                           # node --test (MCP 서버 포함)
npm run build                      # dist/
node scripts/e2e.ts                # 문서 리뷰: 헤드리스 Chrome + 가짜 마이크(say -v Yuna)
node scripts/e2e-live.ts           # 라이브 리뷰: 테스트 앱, 핀, 앱 안 이동, 새 탭, 보고서, replay.html
node scripts/e2e-agent.ts claude   # 실제 에이전트(claude 또는 codex)가 MCP로 리뷰를 열고 기다려 결과를 받는지
```

`tsconfig.json`의 `paths`는 이 머신의 전역 pi 설치 경로를 가리킨다(pi 확장 타입 검사용). 다른 곳에서는 고쳐야 한다.
