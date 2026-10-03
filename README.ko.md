<p align="center">
  <img src="assets/walkmate-icon.png" alt="Walkmate 아이콘: 어미 오리를 따라 걷는 아기 오리" width="160">
</p>

<h1 align="center"><img src="assets/walkmate-symbol.png" alt="" height="36"> Walkmate</h1>

<p align="center"><strong>Show once. Let your agent check again.</strong></p>

<p align="center"><a href="README.md">English</a> · <b>한국어</b></p>

앱을 사용하는 과정을 보여 주고 말로 설명하면, 행동·음성·화면·네트워크를 같은 시간축으로 기록해 코딩 에이전트에게 전달한다.
녹화에서 플레이북 초안을 만들 수 있고, 에이전트는 이 자료를 바탕으로 재사용할 skill이나 테스트 코드를 작성할 수 있다.
에이전트는 Walkmate의 실행 기능으로 실제 앱에서 절차를 수행하고, 그 실행 과정도 재생 페이지로 남길 수 있다.

**Walkmate는 브라우저 시연·실행 런타임이며, MCP는 에이전트가 이 런타임을 사용하는 인터페이스다.**
무엇을 실행할지는 에이전트가 판단하고, Walkmate는 Chrome 조작·기록·실행 결과 저장을 담당한다.
stdio MCP 서버라서 Claude Code, Codex, pi 등 특정 에이전트에 종속되지 않는다.

- **라이브 리뷰**: 앱(예: `http://localhost:5173/dashboard`)을 리뷰 전용 Chrome 창에서 열고, 직접 써 보면서 말한다.
  발화마다 그때 가리킨 요소, React 컴포넌트, 소스 파일과 줄, 스크린샷이 붙는다. rrweb로 화면과 음성을 다시 재생할 수 있다.
- **문서 리뷰**: 에이전트가 정리한 결정·질문·diff 페이지를 읽으며 말하고 답한다.
- **에이전트 실행**: 시연한 절차나 E2E skill을 에이전트가 읽고 MCP로 화면 확인·조작·검증을 수행한다.
  별도 브라우저 CLI 없이 Chrome DevTools Protocol을 사용하며, 단계 결과와 실행 화면을 함께 기록한다.

[ETOOMANYTHINGS? Run Fewer Agents](https://blog.exe.dev/etoomanythings)의 DOM 녹화 아이디어에서 출발했다.

## 기본 설치

**음성은 선택 기능이다.** 마이크를 사용하지 않으면 ffmpeg·whisper.cpp·음성 모델을 설치하지 않아도 된다.
Node 22 이상과 Git이 필요하며, 라이브 리뷰에는 Chrome도 필요하다.

```bash
git clone https://github.com/preinpost/walkmate.git
cd walkmate
npm install                                # dist/ 빌드까지 된다
node dist/mcp/cli.js doctor                 # Node·Chrome만 점검한다
```

이 상태로 클릭·입력·이동·핀 메모·네트워크 기록과 플레이북 생성을 사용할 수 있다.
마이크는 **● 녹음**을 눌렀을 때만 사용한다. 도구나 OS 권한이 없으면 안내를 표시하며, 화면 기록은 계속된다.
ffmpeg가 없으면 보고서에 대상 표시·축소를 적용하지 않은 원본 스크린샷을 첨부한다.

### 음성을 사용할 때만 설치

라이브 마이크 녹음에는 **ffmpeg**, 로컬 전사에는 추가로 **whisper.cpp와 모델**이 필요하다.
도구나 모델은 Walkmate가 자동으로 설치하지 않는다.

| OS | ffmpeg | 로컬 전사 |
|---|---|---|
| macOS | `brew install ffmpeg` | `brew install whisper-cpp` 후 아래 `setup` 실행 |
| Ubuntu/Debian | `sudo apt install ffmpeg` | [whisper.cpp 설치 안내](https://github.com/ggml-org/whisper.cpp)를 따라 `whisper-cli` 준비 |
| 다른 Linux | 배포판 패키지 관리자로 ffmpeg 설치 | 같은 whisper.cpp 설치 안내 사용 |
| Windows | [FFmpeg Windows 빌드](https://ffmpeg.org/download.html) 설치 후 `ffmpeg.exe`를 PATH에 추가 | whisper.cpp 설치 안내를 따라 `whisper-cli.exe` 준비 |

```bash
# 로컬 전사를 선택했을 때만: 모델 약 1.6GB를 내려받는다.
node dist/mcp/cli.js setup
node dist/mcp/cli.js doctor --voice          # 도구·모델 점검. 마이크는 열지 않는다.
node dist/mcp/cli.js doctor --mic            # 위 점검 + 마이크 2초 녹음. OS 권한이 필요하다.
```

`whisper-cli`가 PATH에 없다면 `WALKMATE_WHISPER_BIN`에 실행 파일 경로를 지정한다.
로컬 whisper.cpp 대신 OpenAI `whisper-1`을 선택하려면 MCP 서버 환경에 `OPENAI_API_KEY`와
`WALKMATE_TRANSCRIBER=openai`를 설정한다. **이 경우 녹음 파일을 OpenAI에 전송한다.**
기본값 `auto`는 로컬 엔진이 준비되지 않았고 API 키가 있으면 OpenAI를 사용한다.
전사 없이 녹음 파일만 저장하려면 `WALKMATE_TRANSCRIBER=none`을 설정한다.

### OS별 마이크 설정

- **macOS:** AVFoundation을 사용한다. 기본 장치는 `default`이며, 터미널 앱에 마이크 권한을 허용해야 한다.
- **Linux:** PulseAudio 입력을 사용한다. PulseAudio 또는 PipeWire의 PulseAudio 호환 서비스가 필요하다.
  `WALKMATE_MIC`에는 `default`나 입력 소스 이름을 지정한다. CI·헤드리스 환경에서는 마이크를 사용하지 않아도 된다.
- **Windows:** DirectShow를 사용한다. `ffmpeg -list_devices true -f dshow -i dummy`로 오디오 장치 이름을 확인하고,
  MCP 서버 환경의 `WALKMATE_MIC`에 실제 장치 이름을 지정한다(`default`가 자동 선택된다고 가정하지 않는다).

문서 리뷰는 브라우저의 MediaRecorder로 녹음한다. ffmpeg는 로컬 전사와 무음 검사에 사용되며,
`doctor --voice`·`--mic`는 라이브 리뷰용 ffmpeg 녹음 경로를 점검한다.
Windows/Linux용 입력 방식과 설치 안내는 제공하지만, 실제 마이크·권한·브라우저 동작은 각 OS에서 별도 검증이 필요하다.

## MCP 서버 등록

MCP SDK v2의 `@modelcontextprotocol/server`를 사용한다. `@modelcontextprotocol/client`는 테스트용 개발 의존성이다.
SDK를 교체해도 도구 이름과 등록 명령은 동일하다.

서버 명령은 `node ~/dev/walkmate/dist/mcp/cli.js mcp` 하나다. 클라이언트마다 한 번 등록한다.

```bash
REPO=~/dev/walkmate

# Claude Code (-s user: 모든 프로젝트에서)
claude mcp add -s user walkmate -- node $REPO/dist/mcp/cli.js mcp

# Codex
codex mcp add walkmate -- node $REPO/dist/mcp/cli.js mcp

# pi (기본 codemode 노출)
pi mcp add walkmate -- node $REPO/dist/mcp/cli.js mcp
```

확인은 Claude Code·pi에서 `/mcp`, 셸에서 `codex mcp list` / `pi mcp list`.
사람 시연용 `review_start`·`review_wait`·`review_cancel`과 에이전트 실행용 `run_start`·`run_step`·`run_finish`가 보이면 된다. `npm link`를 해 두면 `node $REPO/dist/mcp/cli.js` 대신 `walkmate`로 써도 된다.

코드를 고친 뒤에는 `npm run build`를 하고 클라이언트를 다시 시작한다(pi는 `/reload`). MCP 서버는 세션이 시작될 때 뜬다.

## 쓰는 법

에이전트에게 말하면 된다.

- "walkmate 켜봐"
- "워크메이트 켜줘"
- "localhost:5173/dashboard 라이브 리뷰 열어줘"
- "방금 한 작업 리뷰 페이지로 보여줘"
- "Walkmate로 확인하자"
- "워크메이트로 보여줄게"
- "방금 시연한 로그인 절차를 Walkmate로 다시 실행하고 검증해 줘"
- "이 E2E skill을 Walkmate로 실행하고 재생 기록을 남겨 줘"

"walkmate 켜봐"처럼 대상 없이 시작해 달라고 하면 에이전트는 경로·앱·실행 중인 포트를 탐색하거나
URL을 되묻지 않고 바로 `review_start({})`를 호출한다. 전용 Chrome의 빈 탭이 열리면
사용자가 직접 주소를 입력해서 시연한다. 사이트로 이동하면 리뷰 툴바가 표시되며, 마이크는 녹음 버튼을 눌러야 켜진다.
URL을 전달하면 해당 사이트를 바로 열고, URL 없이 문서 섹션을 전달하면 문서 리뷰를 연다.

단순히 Walkmate의 이름을 언급하거나 사용법·구현을 묻는 경우에는 리뷰를 열지 않는다.
이 기준은 에이전트에게 전달하는 지침이며, 키워드를 감지해서 자동 실행하는 기능은 아니다.
도구가 지연 노출되는 클라이언트에서는 에이전트가 먼저 Walkmate의 `review_start` MCP 도구를 검색해야 한다.

에이전트가 `review_start`로 리뷰를 열고, 끝날 때까지 `review_wait`를 반복 호출한 뒤, 피드백대로 작업한다.
Claude Code에서는 MCP 프롬프트로도 시작할 수 있다: `/walkmate:live_review [url]`, `/walkmate:review_changes`.
`live_review`에서 URL을 생략하면 빈 Chrome 탭으로 시작한다.

### 라이브 리뷰

리뷰 전용 Chrome 창이 열린다(프로필 `~/.walkmate/chrome-profile`, 로그인은 처음 한 번).
로그인부터 시연해야 하면(예: 시연을 Playwright 테스트로 옮길 때) `isolated: true`로 연다.
로그아웃된 임시 프로필에서 시작하고, 리뷰가 끝나면 프로필을 지운다. 공유 프로필의 로그인 상태는 그대로 둔다.
테스트 계정의 아이디·비밀번호까지 그대로 남기려면 `record_inputs: true`를 함께 준다("비번도 기록해서 열어줘").
입력값을 가리지 않고 `events.json`·보고서·플레이북·rrweb 재생에 남기며, 네트워크 본문은 계속 가린다. 실제 계정에는 쓰지 않는다.
오른쪽 아래 툴바:

| | |
|---|---|
| **● 녹음** macOS `Cmd+R` · Windows/Linux `Alt+R` | 선택 기능. ffmpeg가 있으면 마이크 녹음 켜기/끄기. 페이지 이동·새로고침 중에도 유지 |
| **📌 핀** macOS `Cmd+P` · Windows/Linux `Alt+P` | 핀 모드에서 클릭하면 그 요소, 드래그하면 그 영역을 "여기"로 지정한다(앱에는 전달되지 않음) |
| macOS `Cmd+드래그` · Windows/Linux `Alt+드래그` | 핀 모드가 아니어도 바로 영역 핀 |
| **포인트** | 에이전트가 준 리뷰 포인트. 누르면 "지금 이 포인트 이야기 중"으로 표시 |
| **제출** / **✕** | 제출하면 창이 닫히고 결과가 간다. 창을 그냥 닫아도 녹음이나 핀이 있으면 제출된다 |

핀을 찍으면 바로 옆에 메모 칸이 뜬다. Enter로 저장(비워도 된다), Esc로 취소. 저장한 핀은 번호와 메모가 붙은 테두리로
페이지에 남고(다른 페이지로 가면 사라짐), 영역 핀은 안에 든 요소와 보이는 글자가 함께 전달된다.

새 탭, 앱 안 이동, 새로고침 모두 기록된다. 마이크는 ffmpeg로 직접 녹음한다.

### 문서 리뷰

기본 브라우저에 페이지가 열린다. `R` 또는 **● 녹음**으로 녹음을 켜고 끈다.
섹션마다 텍스트 코멘트를, 질문에는 선택지 버튼을 쓸 수 있다. 탭을 닫았다면 리뷰 폴더의 `url.txt`로 다시 연다.

## 시연을 에이전트가 다시 실행하기

에이전트가 시연 기록·플레이북·skill을 읽고 필요한 단계와 검증 조건을 정리한 뒤,
`run_start` → `run_step` 반복 → `run_finish`로 실제 앱을 조작한다.
사람이 리뷰 중일 때는 기존 `review_wait` 흐름을 사용하지만, **에이전트 실행에서는 `review_wait`를 호출하지 않는다.**
한 MCP 서버에서 리뷰와 실행을 동시에 열 수는 없다.

| 도구 | 역할 |
|---|---|
| `run_start` | 전용 Chrome을 열고 실행 기록을 시작한다. 현재 요소·스크린샷·실행 id·저장 폴더를 반환한다. 기본 URL은 `about:blank` |
| `run_step` | 화면 확인, 이동, 클릭, 입력, 선택, 체크, 키 입력, 스크롤, 대기, 검증 중 한 단계를 실행한다. `action`을 생략하면 화면을 확인한다. `actions`로 여러 단계를 한 번에 실행할 수 있다 |
| `run_finish` | Chrome을 닫고 기록을 저장한다. 결과와 `replay.html` 경로를 반환한다. `cancel: true`이면 실행 중인 단계도 중단한다 |

MCP 호출 예시:

```json
{"tool":"run_start","arguments":{"cwd":"/path/to/project","url":"http://localhost:5173/login","title":"로그인 E2E","allow_actions":true,"isolated":true,"source_recording":"/path/to/project/.walkmate/reviews/mcp/demo"}}
{"tool":"run_step","arguments":{"id":"u1","action":{"type":"fill","target":{"kind":"testid","value":"auth-email"},"value_env":"E2E_EMAIL","source_step":"login-email"}}}
{"tool":"run_step","arguments":{"id":"u1","action":{"type":"fill","target":{"kind":"testid","value":"auth-password"},"value_env":"E2E_PASSWORD","source_step":"login-password"}}}
{"tool":"run_step","arguments":{"id":"u1","action":{"type":"click","target":{"kind":"testid","value":"auth-login-submit"},"source_step":"login-submit"}}}
{"tool":"run_step","arguments":{"id":"u1","action":{"type":"wait","target":{"kind":"testid","value":"dashboard"},"condition":"visible"}}}
{"tool":"run_step","arguments":{"id":"u1","action":{"type":"assert","condition":"url","expected":"/dashboard"}}}
{"tool":"run_finish","arguments":{"id":"u1"}}
```

### 여러 단계를 한 번에 실행

단계마다 도구를 호출하면 에이전트가 매번 응답(요소 목록·스크린샷)을 읽고 다음 단계를 정해야 해서 느리다.
E2E skill처럼 순서가 정해져 있고 대상이 testid·css·role로 고정되어 있으면 `actions`로 한 번에 넘긴다.

```json
{"tool":"run_step","arguments":{"id":"u1","evidence":"summary","actions":[
  {"type":"fill","target":{"kind":"testid","value":"auth-email"},"value_env":"E2E_EMAIL"},
  {"type":"fill","target":{"kind":"testid","value":"auth-password"},"value_env":"E2E_PASSWORD"},
  {"type":"click","target":{"kind":"testid","value":"auth-login-submit"}},
  {"type":"wait","target":{"kind":"testid","value":"dashboard"},"condition":"visible"},
  {"type":"assert","condition":"url","expected":"/dashboard"}
]}}
```

- 최대 50단계를 순서대로 실행하고 **첫 실패에서 멈춘다.** 남은 단계는 실행하지 않는다.
- 하나라도 형식이 잘못된 단계가 있으면 아무것도 실행하지 않고 거부한다.
- 응답에는 단계별 상태와 마지막(또는 실패한) 단계의 화면 증거만 담는다.
- `ref`는 현재 화면 응답에서 받아야 하므로, 화면을 보고 골라야 하는 단계만 따로 한 단계씩 실행한다.

`evidence`로 응답에 담을 증거의 양을 정한다. 단일 `action`에도 쓸 수 있다.

| 값 | 응답 |
|---|---|
| `full` (기본) | 요소 목록, 페이지 글자, 스크린샷 |
| `summary` | URL·제목·탭·요소 개수, 페이지 글자 앞 1000자. 스크린샷 없음 |
| `none` | 단계 결과만 |

실패한 단계는 `evidence`와 관계없이 항상 `full`로 반환한다.
단계별 전후 스크린샷은 응답 상세도와 관계없이 `shots/`에 저장되며 `replay.html`에도 그대로 나온다.

`E2E_EMAIL`과 `E2E_PASSWORD`는 MCP 서버 환경에 설정한다. 예시의 testid와 검증 조건은 실제 앱에 맞춰 정한다.
`source_recording`과 `source_step`은 시연과 실행의 연결 정보이며, 해당 녹화 파일을 자동으로 읽거나 실행하지는 않는다.

### 요소 탐색과 성공 판정

- `target.kind`는 `ref`, `testid`, `css`, `role` 중 하나다. `ref`는 현재 화면 응답에서 받은 값을 사용하며,
  페이지가 바뀌거나 요소가 교체되면 다시 화면을 확인한다. `role`과 이름은 DOM에서 추정하며 완전한 접근성 트리는 아니다.
- 여러 요소가 일치하면 실패한다. `scope`에 정확히 한 컨테이너를 가리키는 CSS 선택자를 지정하거나 고유한 ref를 사용한다.
  녹화 당시 좌표를 그대로 반복하지 않는다.
- `fill`·`select`는 `value` 또는 `value_env` 중 하나를 받는다. `select`는 native select의 option value를 사용한다.
  `check`는 원하는 상태를 받아 이미 같은 상태인 체크박스를 다시 누르지 않는다.
- `wait`는 조건이 충족될 때까지 기다리고, `assert`는 현재 조건을 한 번 검사한다.
  조건은 `visible`, `hidden`, `text`, `url`이며 `text`·`url`은 `expected`가 포함되어 있는지 검사한다.
- 단계 제한 시간은 `timeout_ms`로 지정하며 기본 10초, 최대 30초다. 시간 초과 시 늦게 실행되는 후속 조작을 막기 위해 실행을 중단한다.
  실패 후에는 `observe`로 증거를 확인하거나 종료할 수 있고, 상태 변경 동작을 조용히 재시도하지 않는다.
- 성공한 `assert` 없이 끝낸 실행은 `completed`다. 모든 기록된 단계가 성공하고 하나 이상의 검증이 통과해야 `passed`가 된다.
  실패한 단계가 있으면 `failed`, 사용자 중단은 `cancelled`, 시간 초과는 `timeout`으로 기록한다.
  `passed`는 작성한 검증 조건이 통과했다는 뜻이지, 시연과 완전히 같거나 모든 업무 조건을 검증했다는 뜻은 아니다.

### 실행 화면과 기록

기본값은 사용자가 볼 수 있는 Chrome이다. `headless: true`는 화면 없는 테스트 실행에 사용한다.
기본 로그인 프로필은 공유 프로필이며 이미 로그인된 상태일 수 있다. 로그인 자체를 검증하거나 깨끗한 초기 상태가 필요한 경우
`isolated: true`로 임시 프로필을 사용한다. 임시 프로필은 실행이 끝나면 삭제하며, 공유 로그인 프로필은 유지한다.
전체 실행 제한은 `timeout_sec`로 지정하며 기본·최대 3600초다.

기록은 `<프로젝트>/.walkmate/runs/<실행 폴더>/`에 저장한다.
`request.json`, `steps.json`, `run.json`, `events.json`, `network.json`, `console.json`, `shots/`, rrweb 기록을 남기며,
화면의 전체 스냅샷을 얻었으면 `replay.html`도 만든다. 빈 탭만 열었다가 종료하는 등 스냅샷이 없으면 재생 페이지를 만들 수 없다.
재생 페이지의 단계 항목을 누르면 해당 실행 시점으로 이동한다. 이것은 실제 앱을 다시 실행하는 것이 아니라 기록을 재생하는 기능이다.

실행 모드에서는 마이크를 사용하지 않는다. 브라우저의 취소 버튼이나 창 닫기로 실행을 중단할 수 있다.
리터럴 입력값은 단계 로그에서 가리고, DOM 녹화에서도 입력값을 가린다.
네트워크 요청·응답 본문에서는 `password`·`token`·`secret` 같은 이름의 필드와 JWT를 `[redacted]`로 바꿔 저장한다(시연·실행 공통). **스크린샷·페이지 글자·네트워크 본문까지
완전히 비식별화하는 것은 아니므로** 기록을 공유하기 전에 확인해야 한다.

`allow_actions` 기본값은 `false`다. 사용자가 해당 테스트 실행을 승인했을 때만 `true`로 설정한다.
저장·발행·삭제·결제 같은 결과를 되돌리기 어려운 동작에는 명시적인 승인이 필요하며, 이 플래그는 버튼의 업무 의미를
자동으로 분류하거나 별도의 승인을 대신하지 않는다. 브라우저 확인 대화상자는 현재 자동 승인하지 않고 닫은 뒤 실패로 처리한다.

첫 버전은 상위 문서의 DOM을 조작한다. iframe·shadow DOM 내부 탐색, 파일 업로드·드래그, 임의 JavaScript 실행은 지원하지 않는다.
**에이전트가 단계를 고르거나 정해진 단계 묶음을 넘겨 실행하는 기능**이며, `workflow.json` 무인 실행이나 시연/실행 자동 비교 기능은 아직 없다.

## 시연을 Playwright 테스트로 내보내기

시연을 보여 준 뒤 "이 시연을 Playwright 테스트로 만들어 줘"라고 하면, 에이전트가 `export_to_playwright`로
녹화를 `.spec.ts` 파일로 내보낸다. 브라우저를 다시 열지 않고 저장된 녹화만 읽는다.

1. **isolated로 열고 시연한다.** 로그인부터 보여 주려면 `isolated: true`, 테스트 계정의 아이디·비밀번호까지 그대로 쓰려면
   `record_inputs: true`를 함께 준다("로그인부터 보여줄게, 비번도 기록해서 열어줘").
2. **제출한다.** 에이전트가 `review_wait`로 시연 내용(행동·음성·핀·스크린샷)을 받는다.
3. **내보낸다.** 에이전트가 `export_to_playwright({ recording, cwd })`를 호출하면 프로젝트의 테스트 폴더에 파일을 쓰고 코드를 돌려받는다.
4. **실행한다.** 에이전트가 `run_playwright({ spec })`로 실행하고, TODO 줄을 고치고 시연 목적을 확인하는 expect를 보탠다.

리뷰가 끝나면 에이전트는 시연 내용을 요약하고 `1. 문제 원인 찾기 2. Playwright 테스트로 만들기 3. skill로 저장`처럼
번호로 고를 수 있는 다음 단계로 답을 마친다. 번호만 답하면 그 작업을 한다.

### Walkmate로 테스트 실행 (`run_playwright`)

Walkmate는 `@playwright/test`를 함께 설치하므로 **프로젝트에 Playwright나 브라우저를 설치하지 않아도** 테스트를 돌릴 수 있다.
브라우저는 시연에 쓰는 시스템 Chrome(`WALKMATE_CHROME`)을 쓴다.

- spec을 `<프로젝트>/.walkmate/playwright/<실행 폴더>/`에 복사해 실행한다. 상대 import는 원래 폴더를 가리키게 바꾸고,
  `node_modules`가 없거나 ESM(`"type": "module"`)인 프로젝트에서도 돌아간다. 프로젝트의 `playwright.config`는 쓰지 않는다.
- spec이 `walkmate/playwright`를 쓰지 않아도 실행할 때 `withWalkmate`로 감싸서, 테스트마다 `.walkmate/runs/<실행 폴더>/replay.html`이 남는다
  (`replay: false`로 끈다). 원본 파일은 바꾸지 않는다.
- Playwright는 테스트 전체를 수십 ms 만에 끝내므로, replay에는 `test.step`마다 1.2초 간격을 넣어 재생한다(실제 시간은 `run.json`·`steps.json`).
  재생 페이지에서 속도(0.1×~4×)를 바꾸거나 **단계마다 멈춤**을 켜서 한 단계씩 볼 수 있다. 스페이스바로 재생/정지.
- `env`로 테스트 프로세스에만 환경 변수를 넘긴다. 가려진 입력값(`WALKMATE_PASSWORD` 등)은 에이전트가 사용자에게 물어서 넘기며, 파일로 저장하지 않는다.
- 결과로 테스트별 통과/실패, 실패한 `test.step`, 오류, 실패 시 스크린샷·trace 경로, replay 경로를 돌려준다.
  45초 안에 끝나지 않으면 id를 돌려주고, 에이전트가 `run_playwright({ id })`로 이어서 기다린다. `headed: true`면 Chrome 창을 띄운다.

```bash
walkmate test e2e/login.spec.ts --env WALKMATE_PASSWORD=... [--headed] [--grep 제목] [--no-replay]
```

녹화할 때 페이지에서 요소마다 **locator 후보와 그 순간의 일치 개수**를 함께 기록하므로, 내보낼 때 유일한 후보를 고를 수 있다.

| 시연 | 생성되는 코드 |
|---|---|
| 시작 주소, 주소창에 입력한 이동 | `page.goto(url)` |
| 클릭 | 유일한 testid → 역할+이름 → 고유 testid 컨테이너 안의 역할+이름 → label → placeholder → id → name 속성 순으로 locator를 골라 `.click()` |
| 글자 입력, select, 체크박스·라디오 | `.fill(값)`, `.selectOption(값)`, `.check()` / `.uncheck()` |
| 입력 칸에서 Enter, Escape | `.press("Enter")`, `page.keyboard.press("Escape")` |
| 행동 직후(5초 안) 주소 변화 | 그 단계 끝에 `expect(page).toHaveURL(url)` |
| 새 창(popup) | `page.waitForEvent("popup")`과 `page2` 변수 |
| 요소 핀 | `expect(locator).toBeVisible()`과 핀 메모 주석 |
| 음성 | 해당 단계 위에 주석 |

- 행동마다 `test.step("3. 입력: 이메일", ...)`으로 감싼다. 프로젝트에 `walkmate` 패키지가 있으면 `withWalkmate`로 감싸서
  테스트를 실행할 때마다 `.walkmate/runs/<실행 폴더>/replay.html`이 남는다(`with_walkmate`로 직접 지정 가능).
- 입력 칸을 누른 클릭, 체크박스 label 클릭, Enter로 제출할 때 브라우저가 기본 버튼을 누르는 클릭처럼 다른 단계와 겹치는 이벤트는 뺀다.
  호버·스크롤은 넣지 않는다(Playwright가 대상까지 스크롤한다).
- `record_inputs: true`로 녹화했으면 비밀번호를 포함한 입력값이 **코드에 그대로** 들어가고, 파일 맨 위에 경고 주석이 붙는다.
  가려진 값은 `env("WALKMATE_PASSWORD")`처럼 반드시 설정해야 하는 환경 변수로 읽는다.
- 같은 이름의 요소가 여러 개라 녹화 당시 순서(`.nth(i)`)로 골랐거나 글자로만 찾을 수 있으면 해당 줄 위에 `// TODO:`를 단다.
  핀이 없으면 마지막에 완료 조건을 추가하라는 TODO를 단다. 주소 확인만으로는 시연이 성공했다고 볼 수 없다.
- 저장 위치 기본값은 `playwright.config`의 `testDir`, 없으면 `e2e/` 또는 `tests/` 아래 `<제목>.spec.ts`다. 이미 있는 파일은
  `overwrite: true`가 없으면 덮어쓰지 않는다. `from`·`to`(초)로 녹화 일부만 내보낼 수 있다.
- 파일 업로드는 경로를 알 수 없어 주석 처리된 `setInputFiles`와 TODO로 남긴다. 드래그와 contenteditable 입력은 아직 옮기지 않는다.
  locator 후보가 없는 예전 녹화는 보이는 글자로 찾고 TODO를 단다.

CLI로도 내보낼 수 있다. 폴더를 빼면 현재 프로젝트에서 가장 최근 녹화를 쓴다.

```bash
walkmate playwright [.walkmate/reviews/mcp/<녹화 폴더>] [--out e2e/login.spec.ts] [--title 제목] [--from 초] [--to 초] [--overwrite]
```

## 시연을 플레이북으로 변환 (시제품)

사람이 보여 준 절차를 에이전트에게 전달하려면, 제출한 **라이브 리뷰 폴더**를 플레이북 초안으로 변환한다.
브라우저를 열거나 행동을 자동 실행하지 않으며, LLM이나 외부 API 호출 없이 로컬 파일만 읽는다.

```bash
# 저장소에서 빌드한 뒤 실행. REVIEW에는 events.json이 있는 라이브 리뷰 폴더를 지정한다.
npm run build
REVIEW="$PWD/.walkmate/reviews/mcp/<녹화 폴더>"
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

플레이북 CLI는 초안만 생성하며 행동을 자동 실행하지 않는다. 에이전트가 초안을 검토한 뒤 위의 `run_*` 도구로
단계별 실행을 할 수 있지만, 시연/실행 자동 비교 기능은 없다. 고객 정보·URL·메모는 초안에도 포함될 수 있으므로 외부 공유 전에 확인한다. 네트워크 요청/응답 본문은 초안에 복사하지 않는다.

## 무엇을 모으나

라이브 리뷰는 rrweb만으로는 남지 않는 것까지 Chrome DevTools Protocol로 브라우저에서 직접 모은다.

| | 저장 | 에이전트에게 |
|---|---|---|
| 말 | `clip-*.flac`, `transcript.json` | 발화마다 그때 가리킨 대상 |
| 화면 행동 | `events.json`, `rrweb-tab*.jsonl` | 포인터, 클릭, 선택, 입력, 스크롤, 페이지 이동, 탭 전환, 핀 |
| 스크린샷 | `shots/` | 발화와 핀마다 최대 6장. ffmpeg가 있으면 대상 표시·축소, 없으면 원본 |
| 네트워크 | `network.json`, API 응답 본문 `network/` | API 목록, 실패와 느린 요청을 그 발화에 붙여서. 실패 응답은 앞부분 미리보기 |
| 콘솔 | `console.json` | 오류·경고, 잡히지 않은 예외(소스 파일:줄) |
| PDF 등 HTML이 아닌 문서 | `docs/` 사본 (blob URL 포함) | 열었다는 것과 사본 경로. 안의 클릭·스크롤은 안 남는다(스크린샷으로 본다) |
| 이미지·폰트 원본 | `assets/` | 없음. `replay.html`이 원래 주소 대신 사본을 쓴다 |
| canvas | rrweb (초당 1프레임, `WALKMATE_CANVAS_FPS`) | 없음. 재생용 |

요청·응답 헤더는 저장하지 않는다(쿠키, 토큰). 응답 본문은 API(fetch/XHR) 텍스트만 256KB까지 저장한다.
다른 도메인 iframe은 화면(스크린샷)과 네트워크만 남고, 안의 DOM은 기록하지 않는다.
핀 모드에서는 투명한 덮개가 페이지를 덮어서 PDF 뷰어나 iframe 위에서도 핀을 찍을 수 있다.

## MCP 도구

리뷰는 몇 분씩 걸리고 MCP 클라이언트는 도구 호출에 타임아웃이 있어서, 기다리는 도구를 나눴다.

| 도구 | |
|---|---|
| `review_start` | 인자 없이 호출하면 빈 Chrome 탭에서 라이브 시연을 시작한다. `url`이 있으면 해당 사이트에서 라이브 리뷰, URL 없이 비어 있지 않은 `sections`를 전달하면 문서 리뷰. `title` 기본값은 `Walkmate`. 리뷰 id를 반환 |
| `review_wait` | 최대 45초(`WALKMATE_WAIT_SEC`) 기다린다. 끝났으면 피드백(텍스트+스크린샷), 아니면 "다시 호출" |
| `review_cancel` | 열린 리뷰를 닫는다 |
| `export_to_playwright` | 라이브 시연 녹화를 Playwright 테스트 파일로 내보낸다. 경로·코드·TODO를 반환. 브라우저는 열지 않는다 |
| `run_playwright` | Walkmate에 들어 있는 Playwright와 시스템 Chrome으로 spec을 실행한다. 프로젝트에 설치 불필요. 테스트별 결과·실패 단계·스크린샷·trace·replay를 반환 |

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

뒤에 전체 타임라인(페이지 이동, 포인터, 클릭, 입력, 스크롤)이 오고, 스크린샷이 최대 6장 붙는다.
ffmpeg가 있으면 대상에 빨간 상자를 표시하고, 없으면 원본을 첨부한다. 컴포넌트와 파일은 React 개발 빌드의 디버그 정보에서 찾는다(프로덕션 빌드에서는 생략된다).

문서 리뷰:

```
### d1 · 결정 · user_id를 nullable로 변경  (본 시간 0:04)
- 🗣 [00:02.0] "음 이 결정은 좀 이상한데요"
- ✂ [00:01.8] 선택: "user_id INTEGER NULL"
```

원본(녹음, 이벤트, 스크린샷, rrweb, 보고서)은 `<프로젝트>/.walkmate/reviews/<세션>/<시각>-<고유 접미사>/`에 남는다.
라이브 리뷰의 `replay.html`을 열면 rrweb 화면과 녹음이 같이 재생되고, 발화 목록을 누르면 그 시점으로 간다.

## 프로젝트별 기록과 skill

녹화와 녹화에서 만든 자료는 해당 프로젝트의 `.walkmate` 아래에 모은다.
MCP의 `cwd`에는 현재 작업 중인 프로젝트 루트를 전달한다. 생략하면 MCP 서버의 작업 디렉터리를 사용하며,
앱 URL에서 저장소를 추측하거나 다른 프로젝트를 탐색하지 않는다. 클라이언트가 서버 작업 디렉터리를 고정했다면
에이전트가 알고 있는 현재 프로젝트 경로를 `cwd`로 전달해야 한다.

```text
<프로젝트>/.walkmate/
  .gitignore                     기본값: 모든 내부 파일을 Git에서 제외
  reviews/mcp/<녹화 폴더>/         원본 기록·보고서·재생 페이지
    playbook/                    CLI가 만든 플레이북 초안
  runs/<실행 폴더>/               에이전트 실행 기록·단계 결과·재생 페이지
  skills/<이름>/SKILL.md          요청한 E2E skill을 에이전트가 작성할 위치
  notes/<이름>.md                시연한 절차를 기억해 달라고 했을 때 사용할 위치
```

`review_start`와 피드백 응답에는 실제 녹화 폴더와 skill·메모를 저장할 경로가 표시된다.
MCP는 에이전트에게 이 경로를 사용하고 원본 녹화 경로를 함께 적도록 안내한다.
사용자가 다른 위치를 지정하지 않았다면 전역 에이전트 메모리나 무관한 폴더에 저장하지 않는다.
skill과 메모는 사용자 요청에 따라 에이전트가 작성하며, 녹화 제출만으로 자동 생성되지는 않는다.
`.walkmate/skills`는 자료 보관 위치이며, 각 에이전트가 자동으로 발견하는 skill 경로는 아니다.
실행할 때는 파일을 직접 읽히거나 검토 후 해당 에이전트의 skill 경로에 설치한다.

로그인 프로필과 음성 모델은 공유 폴더 `~/.walkmate`에 유지한다. 프로젝트가 바뀌어도
같은 Chrome 프로필을 사용하므로 사이트에서 세션을 만료시키지 않았다면 로그인 상태가 유지된다.
`WALKMATE_HOME`은 이 공유 폴더만 바꾸며, 프로젝트 녹화 위치는 `cwd`로 결정한다.

**녹화에는 민감정보가 포함될 수 있다.** 네트워크 요청·응답 본문에 비밀번호나 토큰이 남을 수 있으므로,
데모 계정이라도 공개 저장소에 올려도 안전하다고 가정하지 않는다. 새로운 `.walkmate` 폴더에는 내부 파일을
Git에서 제외하는 `.gitignore`를 만들며, 기존 규칙은 덮어쓰지 않는다. 이미 Git에 추적 중인 파일은 제외 규칙만으로
추적이 해제되지 않으므로 따로 확인한다. 자료를 공유하기 전에 내용을 검토한다.
로그인 절차를 skill·메모로 정리할 때는 비밀번호나 토큰을 복사하지 말고 환경 변수로 받도록 작성한다.

## 이전 버전에서 전환하기

CLI 이름은 `walkmate`, 환경 변수 접두사는 `WALKMATE_`로 통일했다.
공유 모델·Chrome 프로필 폴더는 `~/.walkmate`이며, 새 녹화는 프로젝트의 `.walkmate/reviews`에 저장한다.
이전 `review-recorder` 실행 이름과 `REVIEW_RECORDER_*` 환경 변수는 더 이상 지원하지 않으며,
이전 데이터 폴더 `~/.review-recorder`를 자동으로 읽거나 이동하지 않는다.
MCP 도구 이름(`review_start`·`review_wait`·`review_cancel`)은 그대로 유지한다.

기존 음성 모델·Chrome 로그인 프로필을 계속 사용하려면 MCP 클라이언트와 리뷰 전용 Chrome을 종료한 뒤
공유 데이터 폴더를 옮긴다. 아래 명령은 대상 폴더가 이미 있으면 이동하지 않는다.
두 폴더가 모두 있다면 먼저 백업하고 필요한 데이터를 직접 옮긴다.

```bash
if [ -d "$HOME/.review-recorder" ] && [ ! -e "$HOME/.walkmate" ]; then
  mv "$HOME/.review-recorder" "$HOME/.walkmate"
fi
```

위 명령으로 옮긴 기존 녹화는 `~/.walkmate/reviews`에 남지만 새 녹화를 그곳에 저장하지는 않는다.
필요한 기존 녹화는 내용을 확인한 뒤 해당 프로젝트의 `.walkmate/reviews`로 직접 옮긴다.
기존 플레이북·메모에 적힌 절대 경로도 함께 갱신한다.

MCP 서버 환경에 설정한 `REVIEW_RECORDER_<이름>`은 `WALKMATE_<이름>`으로 바꾼다.
사용자 지정 공유 폴더는 `WALKMATE_HOME`으로 지정할 수 있다. 경로를 직접 지정한 모델·Chrome 프로필 설정도
이동 후 경로에 맞춰 갱신한다. Chrome 프로필을 옮기면 저장된 로그인 정보를 계속 사용할 수 있지만,
사이트의 세션 만료나 OS 암호화 정책에 따라 다시 로그인해야 할 수 있다.

이전 이름으로 MCP를 등록했다면 해당 등록을 제거하고 위의 `walkmate` 등록 명령으로 다시 등록한다.
저장소 디렉터리를 옮겼다면 서버 명령의 경로도 갱신한다. `npm link`로 CLI를 사용했다면 다시 실행한다.
빌드 후 MCP 클라이언트를 다시 시작한다(pi는 `/reload`).

전용 pi 확장은 제거했다. 이전에 `pi install`로 확장을 등록했다면 해당 설치 선언을 제거하고 MCP로 등록한다.
확장에서 제공하던 `/review` 명령·`request_review` 도구·진행 위젯 대신
MCP의 `review_start`·`review_wait`·`review_cancel`을 사용한다.

## 설정 (환경 변수)

| 변수 | 기본값 | |
|---|---|---|
| `WALKMATE_HOME` | `~/.walkmate` | 공유 모델·브라우저 프로필. 녹화는 프로젝트의 `.walkmate/reviews`에 저장 |
| `WALKMATE_TRANSCRIBER` | `auto` | `whisper-cpp`, `openai`, `none` |
| `WALKMATE_LANG` | `ko` | 받아쓰기 언어 |
| `WALKMATE_WHISPER_BIN` | `whisper-cli` | |
| `WALKMATE_WHISPER_MODEL` | `<데이터 폴더>/models/ggml-large-v3-turbo.bin` | 기본 데이터 폴더는 `~/.walkmate`. `WALKMATE_HOME`으로 변경 가능 |
| `WALKMATE_TIMEOUT_MIN` | `60` | 리뷰 제한 시간. `0`이면 무제한 |
| `WALKMATE_WAIT_SEC` | `45` | MCP `review_wait` 한 번의 대기. 클라이언트 도구 타임아웃보다 짧게 |
| `WALKMATE_OPEN` | | 문서 리뷰: `0`이면 브라우저를 자동으로 열지 않음 |
| `WALKMATE_MIC` | `default` | macOS: AVFoundation 장치, Linux: PulseAudio 소스, Windows: 실제 DirectShow 오디오 장치 이름 |
| `WALKMATE_MAX_SHOTS` | `6` | 라이브 리뷰 결과에 붙일 스크린샷 수 |
| `WALKMATE_CANVAS_FPS` | `1` | rrweb canvas 기록 초당 프레임. `0`이면 끈다 |
| `WALKMATE_CHROME` | OS별 Chrome 경로 또는 `google-chrome` | 기본값으로 찾지 못하면 실행 파일 경로 지정 |
| `WALKMATE_CHROME_PROFILE` | `<데이터 폴더>/chrome-profile` | 기본값은 `~/.walkmate/chrome-profile`. 리뷰 사이에 로그인 정보를 유지 |

## 구조

```
src/core/   에이전트와 무관한 시연·리뷰 엔진
src/mcp/    stdio MCP 서버와 CLI (dist/로 빌드)
```

| 파일 | 역할 |
|---|---|
| `core/review.ts` | 한 번의 리뷰: 열기 → 대기 → 받아쓰기 → 보고서 (문서·라이브). 호스트는 `ReviewEnv`로 연결 |
| `core/storage.ts` | 프로젝트별 `.walkmate` 경로, 고유 녹화·실행 폴더, 기본 Git 제외 규칙 |
| `core/runtime/run.ts`, `core/runtime/types.ts` | 네이티브 브라우저 실행 세션·행동·검증·실행 결과와 인자 검사 |
| `core/page/runtime.js` | 현재 DOM 관찰·고유 요소 탐색·ref 관리. 사용자 JavaScript는 실행하지 않음 |
| `mcp/runtime.ts` | 실행 도구 `run_start` / `run_step` / `run_finish`와 세션 관리 |
| `core/types.ts` | 요청 JSON Schema와 검사 |
| `core/dependencies.ts` | OS별 실행 파일 탐색과 선택 음성 도구 설치 안내 |
| `core/render.ts`, `core/server.ts`, `core/diff.ts`, `core/timeline.ts` | 문서 리뷰 페이지, 127.0.0.1 서버, git diff, 보고서 |
| `core/live/cdp.ts` | CDP 클라이언트, 전용 프로필 Chrome 실행/재연결 |
| `core/live/session.ts` | 모든 탭에 스크립트 주입, 이벤트 수신, 활성 탭 추적, 녹음 제어, 스크린샷, rrweb·문서 사본 저장 |
| `core/live/capture.ts` | 네트워크(요청·응답 본문), 콘솔·예외·브라우저 로그, 이미지·폰트 원본 |
| `core/live/mic.ts` | ffmpeg 마이크 녹음과 레벨 미터 |
| `core/live/report.ts` | 이벤트 압축, 발화 ↔ 대상 연결, 스크린샷 선택·표시, 보고서 |
| `core/live/replay.ts` | rrweb + 음성 동기 재생 페이지, 저장한 이미지·폰트로 주소 바꾸기 |
| `core/live/playbook.ts` | 저장된 라이브 리뷰에서 실행 전 검토용 JSON·Markdown 플레이북 초안 생성 |
| `core/live/run-playwright.ts`, `mcp/playwright.ts` | 내장 Playwright로 spec 실행: 복사·`withWalkmate` 감싸기·결과 정리, `run_playwright` 도구 |
| `core/live/export-playwright.ts` | 저장된 라이브 리뷰를 Playwright `.spec.ts`로 변환: locator 선택, 겹치는 이벤트 정리, 팝업·주소 확인 |
| `core/page/live.js` | 앱 페이지: 툴바, 포인터·클릭·선택·입력·스크롤·이동 추적, React 컴포넌트·소스 찾기, 핀 |
| `core/transcribe.ts` | whisper.cpp / OpenAI, 단어 단위 타임스탬프, 무음 클립 제외 |
| `mcp/server.ts` | MCP 도구 `review_start` / `review_wait` / `review_cancel` / `export_to_playwright`, 프롬프트 |
| `mcp/cli.ts` | CLI: `mcp`(서버), `doctor`(점검), `setup`(모델 받기), `playbook`(시연 변환), `playwright`(테스트 내보내기), `test`(테스트 실행) |

## 개발

```bash
npm run check                      # tsc
npm test                           # node --test (MCP 서버 포함, ffmpeg가 없으면 무음 전사 테스트만 skip)
npm run build                      # dist/
node scripts/e2e.ts                # 선택 macOS 음성 통합 테스트: Chrome + ffmpeg + say -v Yuna
node scripts/e2e-live.ts           # 선택 macOS 라이브 통합 테스트: 같은 음성 도구 + API·콘솔·PDF·replay.html
node scripts/e2e-launch.ts         # 선택 Chrome 통합 테스트: 빈 탭 시작 → 사이트 이동 → 툴바·시연 기록 (음성 도구 불필요)
WALKMATE_E2E=1 node --test test/runtime-browser.test.ts  # 선택 실제 MCP+Chrome 실행 테스트 (격리된 headless 프로필)
node scripts/e2e-agent.ts claude   # 실제 에이전트(claude, codex, pi)가 MCP로 리뷰를 열고 기다려 결과를 받는지
```

타입 검사와 빌드에는 전역 pi 설치나 머신별 타입 경로가 필요하지 않다.
