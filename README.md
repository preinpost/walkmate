# Walkmate

**Show once. Let your agent check again.**

앱을 사용하는 과정을 보여 주고 말로 설명하면, 행동·음성·화면·네트워크를 같은 시간축으로 기록해 코딩 에이전트에게 전달한다.
녹화에서 플레이북 초안을 만들 수 있고, 에이전트는 이 자료를 바탕으로 재사용할 skill이나 테스트 코드를 작성할 수 있다.
stdio MCP 서버라서 Claude Code, Codex, pi 등 특정 에이전트에 종속되지 않는다.

- **라이브 리뷰**: 앱(예: `http://localhost:5173/dashboard`)을 리뷰 전용 Chrome 창에서 열고, 직접 써 보면서 말한다.
  발화마다 그때 가리킨 요소, React 컴포넌트, 소스 파일과 줄, 스크린샷이 붙는다. rrweb로 화면과 음성을 다시 재생할 수 있다.
- **문서 리뷰**: 에이전트가 정리한 결정·질문·diff 페이지를 읽으며 말하고 답한다.

[ETOOMANYTHINGS? Run Fewer Agents](https://blog.exe.dev/etoomanythings)의 DOM 녹화 아이디어에서 출발했다.

## 설치 (macOS)

```bash
brew install ffmpeg whisper-cpp            # Chrome, Node 22 이상도 필요

git clone https://github.com/preinpost/walkmate.git ~/dev/walkmate
cd ~/dev/walkmate
npm install                                # dist/ 빌드까지 된다

node dist/mcp/cli.js setup                 # whisper 모델(약 1.6GB)을 ~/.review-recorder/models 에 받는다
node dist/mcp/cli.js doctor --mic          # 점검. 처음이면 macOS가 터미널 앱에 마이크 권한을 묻는다
```

whisper.cpp 대신 OpenAI `whisper-1`을 쓰려면 MCP 서버 환경에 `OPENAI_API_KEY`가 있으면 된다.

## MCP 서버 등록

서버 명령은 `node ~/dev/walkmate/dist/mcp/cli.js mcp` 하나다. 클라이언트마다 한 번 등록한다.

```bash
REPO=~/dev/walkmate

# Claude Code (-s user: 모든 프로젝트에서)
claude mcp add -s user walkmate -- node $REPO/dist/mcp/cli.js mcp

# Codex
codex mcp add walkmate -- node $REPO/dist/mcp/cli.js mcp

# pi: 기본 노출(codemode)이 아니라 direct 로 등록해야 모델이 도구를 바로 본다
pi mcp add walkmate --exposure direct -- node $REPO/dist/mcp/cli.js mcp
```

확인은 Claude Code·pi에서 `/mcp`, 셸에서 `codex mcp list` / `pi mcp list`. 도구 세 개(`review_start`, `review_wait`,
`review_cancel`)가 보이면 된다. `npm link`를 해 두면 `node $REPO/dist/mcp/cli.js` 대신 `walkmate`로 써도 된다.

코드를 고친 뒤에는 `npm run build`를 하고 클라이언트를 다시 시작한다(pi는 `/reload`). MCP 서버는 세션이 시작될 때 뜬다.

## 쓰는 법

에이전트에게 말하면 된다.

- "localhost:5173/dashboard 라이브 리뷰 열어줘"
- "방금 한 작업 리뷰 페이지로 보여줘"

에이전트가 `review_start`로 리뷰를 열고, 끝날 때까지 `review_wait`를 반복 호출한 뒤, 피드백대로 작업한다.
Claude Code에서는 MCP 프롬프트로도 시작할 수 있다: `/walkmate:live_review <url>`, `/walkmate:review_changes`.

### 라이브 리뷰

리뷰 전용 Chrome 창이 열린다(프로필 `~/.review-recorder/chrome-profile`, 로그인은 처음 한 번).
오른쪽 아래 툴바:

| | |
|---|---|
| **● 녹음** `Alt+R` | 마이크 녹음 켜기/끄기. 페이지를 이동하거나 새로고침해도 끊기지 않는다 |
| **📌 핀** `Alt+P` | 핀 모드에서 클릭하면 그 요소, 드래그하면 그 영역을 "여기"로 지정한다(앱에는 전달되지 않음) |
| `Alt+드래그` | 핀 모드가 아니어도 바로 영역 핀 |
| **포인트** | 에이전트가 준 리뷰 포인트. 누르면 "지금 이 포인트 이야기 중"으로 표시 |
| **제출** / **✕** | 제출하면 창이 닫히고 결과가 간다. 창을 그냥 닫아도 녹음이나 핀이 있으면 제출된다 |

핀을 찍으면 바로 옆에 메모 칸이 뜬다. Enter로 저장(비워도 된다), Esc로 취소. 저장한 핀은 번호와 메모가 붙은 테두리로
페이지에 남고(다른 페이지로 가면 사라짐), 영역 핀은 안에 든 요소와 보이는 글자가 함께 전달된다.

새 탭, 앱 안 이동, 새로고침 모두 기록된다. 마이크는 ffmpeg로 직접 녹음한다.

### 문서 리뷰

기본 브라우저에 페이지가 열린다. `R` 또는 **● 녹음**으로 녹음을 켜고 끈다.
섹션마다 텍스트 코멘트를, 질문에는 선택지 버튼을 쓸 수 있다. 탭을 닫았다면 리뷰 폴더의 `url.txt`로 다시 연다.

## 시연을 플레이북으로 변환 (시제품)

사람이 보여 준 절차를 에이전트에게 전달하려면, 제출한 **라이브 리뷰 폴더**를 플레이북 초안으로 변환한다.
브라우저를 열거나 행동을 자동 실행하지 않으며, LLM이나 외부 API 호출 없이 로컬 파일만 읽는다.

```bash
# 저장소에서 빌드한 뒤 실행. REVIEW에는 events.json이 있는 라이브 리뷰 폴더를 지정한다.
npm run build
REVIEW="$HOME/.review-recorder/reviews/mcp/<녹화 시각>"
node dist/mcp/cli.js playbook "$REVIEW" --from 42 --to 50 --title "시연한 작업"
```

결과는 `$REVIEW/playbook/playbook.json`과 `playbook.md`에 저장된다. 기본값은 녹화 전체이며,
`--from`·`--to`는 녹화 시작부터 경과한 초다(`0 <= from < to <= duration`). `--out <폴더>`로 출력 폴더를 바꿀 수 있다.
기존 초안은 덮어쓰지 않는다. 다시 생성할 때는 다른 출력 폴더를 지정한다. 원본 녹화 파일은 수정하지 않는다.

초안에는 다음 정보가 있다.

- 클릭·입력·스크롤 단계와 작업 전 URL, React 컴포넌트·소스 위치
- testid·역할/이름·글자·짧은 CSS 설명을 활용한 **요소 탐색 후보**
- 단계 직후 최대 2초 안에 관찰된 주소 변화·새 탭·문서 MIME·API 메타데이터. 다음 같은 탭의 행동이나 선택 구간 끝에서 연결을 끊는다.
- 입력 이벤트에서 만든 매개변수 후보와 음성·핀 메모. 가려진 입력값은 새로 제공해야 한다.
- 단계마다 확인해야 할 사항. 모든 결과는 `status: "draft"`다.

**관찰된 변화는 확정된 완료 조건이 아니다.** testid는 상위 컨테이너의 값일 수 있고, 역할과 접근성 이름은
기록된 태그·글자에서 추정한다. 탐색 동작이나 잘못 누른 동작을 자동으로 삭제하지 않으며, 문서 종류가 없는
`blob:` 새 탭을 PDF라고 단정하지 않는다. 특수 키·파일 업로드·드래그는 아직 단계로 변환하지 않는다.

에이전트에게 `playbook.md`를 읽히고 다음을 먼저 정리하게 한다.

1. 목적에 필요한 단계만 선택한다. 범위가 넓으면 시간을 좁혀 다시 생성한다.
2. 다른 고객사·기간에 적용할 입력값과 URL·행에 포함된 ID를 매개변수로 바꾼다.
3. 현재 DOM에서 요소를 찾고, 여러 개가 일치하면 행·컨테이너로 범위를 제한한다.
4. 각 단계의 성공 판정과 대기 조건을 확정한다. 저장·발행·삭제·결제는 승인 없이 실행하지 않는다.

이 시제품에는 실행 에이전트나 시연/실행 비교 기능이 없다. 고객 정보·URL·메모는 초안에도 포함될 수 있으므로
외부 공유 전에 확인한다. 네트워크 요청/응답 본문은 초안에 복사하지 않는다.

## 무엇을 모으나

라이브 리뷰는 rrweb만으로는 남지 않는 것까지 Chrome DevTools Protocol로 브라우저에서 직접 모은다.

| | 저장 | 에이전트에게 |
|---|---|---|
| 말 | `clip-*.flac`, `transcript.json` | 발화마다 그때 가리킨 대상 |
| 화면 행동 | `events.json`, `rrweb-tab*.jsonl` | 포인터, 클릭, 선택, 입력, 스크롤, 페이지 이동, 탭 전환, 핀 |
| 스크린샷 | `shots/` | 발화와 핀마다 대상에 상자를 그린 것 최대 6장 |
| 네트워크 | `network.json`, API 응답 본문 `network/` | API 목록, 실패와 느린 요청을 그 발화에 붙여서. 실패 응답은 앞부분 미리보기 |
| 콘솔 | `console.json` | 오류·경고, 잡히지 않은 예외(소스 파일:줄) |
| PDF 등 HTML이 아닌 문서 | `docs/` 사본 (blob URL 포함) | 열었다는 것과 사본 경로. 안의 클릭·스크롤은 안 남는다(스크린샷으로 본다) |
| 이미지·폰트 원본 | `assets/` | 없음. `replay.html`이 원래 주소 대신 사본을 쓴다 |
| canvas | rrweb (초당 1프레임, `REVIEW_RECORDER_CANVAS_FPS`) | 없음. 재생용 |

요청·응답 헤더는 저장하지 않는다(쿠키, 토큰). 응답 본문은 API(fetch/XHR) 텍스트만 256KB까지 저장한다.
다른 도메인 iframe은 화면(스크린샷)과 네트워크만 남고, 안의 DOM은 기록하지 않는다.
핀 모드에서는 투명한 덮개가 페이지를 덮어서 PDF 뷰어나 iframe 위에서도 핀을 찍을 수 있다.

## MCP 도구

리뷰는 몇 분씩 걸리고 MCP 클라이언트는 도구 호출에 타임아웃이 있어서, 기다리는 도구를 나눴다.

| 도구 | |
|---|---|
| `review_start` | 리뷰를 열고 바로 id를 돌려준다. `url`이 있으면 라이브, 없으면 `sections`로 문서 리뷰 |
| `review_wait` | 최대 45초(`REVIEW_RECORDER_WAIT_SEC`) 기다린다. 끝났으면 피드백(텍스트+스크린샷), 아니면 "다시 호출" |
| `review_cancel` | 열린 리뷰를 닫는다 |

`review_wait`는 클라이언트의 도구 타임아웃(Codex `tool_timeout_sec`, Claude Code `MCP_TOOL_TIMEOUT`, pi `timeout` 기본 60초)보다
짧게 기다리고 돌아오므로 설정을 바꿀 필요가 없다. 진행 알림(progress)도 보낸다.

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
📌2 [00:07.6] /dashboard · 영역 210×132 — 메모: "간격 넓히기"  🖼 #2
   안: <ServiceUsageChart> li "Compute" · <InvoiceTable> td "1,234,000원" (src/features/dashboard/table/InvoiceTable.tsx:18)
   보이는 글자: "Compute Storage 서비스 1,234,000원"
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

## 기존 review-recorder 사용자

프로젝트명과 새 CLI 이름은 `walkmate`다. 기존 `review-recorder` 실행 이름도 유지하며,
MCP 도구 이름(`review_start`·`review_wait`·`review_cancel`)은 바꾸지 않았다.
기존 MCP 등록 이름도 그대로 쓸 수 있다. 새로 등록하는 경우에는 위 예시처럼 `walkmate`를 사용한다.

녹화·모델·Chrome 로그인 프로필을 그대로 사용하도록 기본 데이터 폴더 `~/.review-recorder`와
`REVIEW_RECORDER_*` 환경 변수는 유지한다. 저장소 디렉터리를 옮겼다면 MCP 서버 명령의 경로도 갱신해야 한다.

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
| `REVIEW_RECORDER_CANVAS_FPS` | `1` | rrweb canvas 기록 초당 프레임. `0`이면 끈다 |
| `REVIEW_RECORDER_CHROME` | macOS Chrome 경로 | |
| `REVIEW_RECORDER_CHROME_PROFILE` | `$HOME/chrome-profile` | |

## pi 확장 (선택)

pi에서는 MCP 대신 확장으로도 쓸 수 있다. 같은 엔진을 쓰고, 도구 하나(`request_review`)가 제출될 때까지 기다리며,
`/review <url>`·`/review` 명령과 진행 위젯이 있다. MCP 서버와 같이 켜면 도구가 겹치니 둘 중 하나만 쓴다.

```bash
pi -e ~/dev/walkmate        # 한 번만
pi install ~/dev/walkmate   # 계속
```

## 구조

```
src/core/   에이전트와 무관한 리뷰 엔진
src/mcp/    stdio MCP 서버와 CLI (dist/로 빌드)
src/pi/     pi 확장 (선택, pi가 TypeScript를 바로 읽는다)
```

| 파일 | 역할 |
|---|---|
| `core/review.ts` | 한 번의 리뷰: 열기 → 대기 → 받아쓰기 → 보고서 (문서·라이브). 호스트는 `ReviewEnv`로 연결 |
| `core/types.ts` | 요청 JSON Schema와 검사 |
| `core/render.ts`, `core/server.ts`, `core/diff.ts`, `core/timeline.ts` | 문서 리뷰 페이지, 127.0.0.1 서버, git diff, 보고서 |
| `core/live/cdp.ts` | CDP 클라이언트, 전용 프로필 Chrome 실행/재연결 |
| `core/live/session.ts` | 모든 탭에 스크립트 주입, 이벤트 수신, 활성 탭 추적, 녹음 제어, 스크린샷, rrweb·문서 사본 저장 |
| `core/live/capture.ts` | 네트워크(요청·응답 본문), 콘솔·예외·브라우저 로그, 이미지·폰트 원본 |
| `core/live/mic.ts` | ffmpeg 마이크 녹음과 레벨 미터 |
| `core/live/report.ts` | 이벤트 압축, 발화 ↔ 대상 연결, 스크린샷 선택·표시, 보고서 |
| `core/live/replay.ts` | rrweb + 음성 동기 재생 페이지, 저장한 이미지·폰트로 주소 바꾸기 |
| `core/live/playbook.ts` | 저장된 라이브 리뷰에서 실행 전 검토용 JSON·Markdown 플레이북 초안 생성 |
| `core/page/live.js` | 앱 페이지: 툴바, 포인터·클릭·선택·입력·스크롤·이동 추적, React 컴포넌트·소스 찾기, 핀 |
| `core/transcribe.ts` | whisper.cpp / OpenAI, 단어 단위 타임스탬프, 무음 클립 제외 |
| `mcp/server.ts` | MCP 도구 `review_start` / `review_wait` / `review_cancel`, 프롬프트 |
| `mcp/cli.ts` | CLI: `mcp`(서버), `doctor`(점검), `setup`(모델 받기), `playbook`(시연 변환) |
| `pi/index.ts` | pi 도구 `request_review`, `/review`, 위젯 |

## 개발

```bash
npm run check                      # tsc
npm test                           # node --test (MCP 서버 포함)
npm run build                      # dist/
node scripts/e2e.ts                # 문서 리뷰: 헤드리스 Chrome + 가짜 마이크(say -v Yuna)
node scripts/e2e-live.ts           # 라이브 리뷰: 테스트 앱, 핀, 앱 안 이동, 새 탭, API·콘솔, PDF 미리보기, replay.html
node scripts/e2e-agent.ts claude   # 실제 에이전트(claude, codex, pi)가 MCP로 리뷰를 열고 기다려 결과를 받는지
```

`tsconfig.json`의 `paths`는 이 머신의 전역 pi 설치 경로를 가리킨다(pi 확장 타입 검사용). 다른 곳에서는 고쳐야 한다.
