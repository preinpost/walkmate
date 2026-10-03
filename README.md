<p align="center">
  <img src="assets/walkmate-icon.png" alt="Walkmate icon: a duckling following its mother duck" width="160">
</p>

<h1 align="center"><img src="assets/walkmate-symbol.png" alt="" height="36"> Walkmate</h1>

<p align="center"><strong>Show once. Let your agent check again.</strong></p>

<p align="center"><b>English</b> · <a href="README.ko.md">한국어</a></p>

Show how you use your app and talk through it. Walkmate records actions, voice, screen, and network on a single timeline and hands it to your coding agent.
A recording can be turned into a draft playbook, and the agent can use it to write reusable skills or test code.
The agent then runs the procedure against the real app with Walkmate's execution tools, and that run can be saved as a replay page too.

**Walkmate is a browser demonstration and execution runtime, and MCP is the interface agents use to drive it.**
The agent decides what to run; Walkmate handles Chrome control, recording, and storing results.
It is a stdio MCP server, so it is not tied to any particular agent such as Claude Code, Codex, or pi.

- **Live review**: Open your app (e.g. `http://localhost:5173/dashboard`) in a dedicated review Chrome window, use it, and talk.
  Each utterance is linked to the element you were pointing at, its React component, source file and line, and a screenshot. The screen and voice can be replayed with rrweb.
- **Document review**: Read a page of decisions, questions, and diffs prepared by the agent, and comment or answer by voice.
- **Agent execution**: The agent reads a demonstrated procedure or an E2E skill, then inspects, operates, and verifies the screen over MCP.
  It uses the Chrome DevTools Protocol directly, with no separate browser CLI, and records step results along with the run's screen.

Inspired by the DOM recording idea in [ETOOMANYTHINGS? Run Fewer Agents](https://blog.exe.dev/etoomanythings).

> **Language note:** The review toolbar, review pages, and generated reports are currently in Korean, and
> transcription defaults to Korean (`WALKMATE_LANG=ko`). Set `WALKMATE_LANG=en` to transcribe English speech.
> UI labels in this README are shown as they appear, with an English gloss.

## Installation

**Voice is optional.** If you don't use the microphone, you don't need ffmpeg, whisper.cpp, or a speech model.
You need Node 22 or later and Git; live review also needs Chrome.

```bash
git clone https://github.com/preinpost/walkmate.git
cd walkmate
npm install                                # also builds dist/
node dist/mcp/cli.js doctor                 # checks Node and Chrome only
```

At this point clicks, input, navigation, pin notes, network recording, and playbook generation all work.
The microphone is used only when you press **● 녹음** (Record). If a tool or OS permission is missing, Walkmate shows a notice and keeps recording the screen.
Without ffmpeg, reports attach the original screenshots without target highlighting or downscaling.

### Voice setup (optional)

Live microphone recording needs **ffmpeg**; local transcription additionally needs **whisper.cpp and a model**.
Walkmate does not install these tools or models for you.

| OS | ffmpeg | Local transcription |
|---|---|---|
| macOS | `brew install ffmpeg` | `brew install whisper-cpp`, then run `setup` below |
| Ubuntu/Debian | `sudo apt install ffmpeg` | Prepare `whisper-cli` following the [whisper.cpp instructions](https://github.com/ggml-org/whisper.cpp) |
| Other Linux | Install ffmpeg with your distribution's package manager | Same whisper.cpp instructions |
| Windows | Install an [FFmpeg Windows build](https://ffmpeg.org/download.html) and add `ffmpeg.exe` to PATH | Prepare `whisper-cli.exe` following the whisper.cpp instructions |

```bash
# Only if you chose local transcription: downloads a model of about 1.6GB.
node dist/mcp/cli.js setup
node dist/mcp/cli.js doctor --voice          # checks tools and model. Does not open the microphone.
node dist/mcp/cli.js doctor --mic            # the checks above + a 2-second mic recording. Needs OS permission.
```

If `whisper-cli` is not on PATH, set `WALKMATE_WHISPER_BIN` to the executable's path.
To use OpenAI `whisper-1` instead of local whisper.cpp, set `OPENAI_API_KEY` and
`WALKMATE_TRANSCRIBER=openai` in the MCP server's environment. **In this case recordings are sent to OpenAI.**
The default, `auto`, uses OpenAI when the local engine is not ready and an API key is present.
To save recordings without transcribing them, set `WALKMATE_TRANSCRIBER=none`.

### Microphone setup by OS

- **macOS:** Uses AVFoundation. The default device is `default`, and your terminal app needs microphone permission.
- **Linux:** Uses PulseAudio input. Requires PulseAudio or PipeWire's PulseAudio-compatible service.
  Set `WALKMATE_MIC` to `default` or an input source name. You don't need a microphone in CI or headless environments.
- **Windows:** Uses DirectShow. Find your audio device name with `ffmpeg -list_devices true -f dshow -i dummy`,
  and set `WALKMATE_MIC` in the MCP server's environment to the actual device name (don't assume `default` is picked automatically).

Document review records through the browser's MediaRecorder. ffmpeg is used for local transcription and silence detection,
and `doctor --voice` / `--mic` check the ffmpeg recording path used by live review.
Input methods and setup instructions are provided for Windows and Linux, but actual microphone, permission, and browser behavior must be verified separately on each OS.

## Registering the MCP server

Walkmate uses `@modelcontextprotocol/server` from MCP SDK v2. `@modelcontextprotocol/client` is a dev dependency for tests.
Tool names and registration commands stay the same if the SDK is swapped.

The server command is just `node ~/dev/walkmate/dist/mcp/cli.js mcp`. Register it once per client.

```bash
REPO=~/dev/walkmate

# Claude Code (-s user: for all projects)
claude mcp add -s user walkmate -- node $REPO/dist/mcp/cli.js mcp

# Codex
codex mcp add walkmate -- node $REPO/dist/mcp/cli.js mcp

# pi (default codemode exposure)
pi mcp add walkmate -- node $REPO/dist/mcp/cli.js mcp
```

To confirm, use `/mcp` in Claude Code or pi, or `codex mcp list` / `pi mcp list` in a shell.
You should see `review_start`, `review_wait`, and `review_cancel` for human demonstrations, and `run_start`, `run_step`, and `run_finish` for agent execution. After `npm link`, you can use `walkmate` instead of `node $REPO/dist/mcp/cli.js`.

After changing the code, run `npm run build` and restart the client (`/reload` in pi). The MCP server starts when a session starts.

## Usage

Just ask your agent.

- "Turn on Walkmate"
- "Open a live review of localhost:5173/dashboard"
- "Show me what you just did as a review page"
- "Let's check this with Walkmate"
- "I'll show you with Walkmate"
- "Re-run and verify the login procedure I just demonstrated with Walkmate"
- "Run this E2E skill with Walkmate and keep a replay"

If you ask it to start without a target, as in "Turn on Walkmate", the agent calls `review_start({})` right away
instead of exploring paths, apps, or running ports, or asking for a URL. When a blank tab opens in the dedicated Chrome,
you type the address yourself and start demonstrating. The review toolbar appears once you navigate to a site, and the microphone turns on only when you press the record button.
If a URL is passed, that site opens directly; if document sections are passed without a URL, a document review opens.

Merely mentioning Walkmate's name or asking how it works or how it is implemented does not open a review.
These rules are instructions given to the agent, not a feature that detects keywords and runs automatically.
In clients that expose tools lazily, the agent must first search for Walkmate's `review_start` MCP tool.

The agent opens a review with `review_start`, calls `review_wait` repeatedly until it finishes, and then acts on the feedback.
In Claude Code you can also start with MCP prompts: `/walkmate:live_review [url]`, `/walkmate:review_changes`.
If you omit the URL in `live_review`, it starts with a blank Chrome tab.

### Live review

A dedicated review Chrome window opens (profile `~/.walkmate/chrome-profile`; you log in only the first time).
If you need to demonstrate from the login step (e.g. when turning the demonstration into a Playwright test), open it with `isolated: true`.
It starts from a logged-out temporary profile and deletes that profile when the review ends. The shared profile's login state is left untouched.
To keep a test account's ID and password as typed, also pass `record_inputs: true` ("record the password too").
Typed values are then stored unmasked in `events.json`, the report, the playbook and the rrweb replay; network bodies stay redacted. Do not use it with real accounts.
Toolbar in the bottom-right corner:

| | |
|---|---|
| **● 녹음** (Record) macOS `Cmd+R` · Windows/Linux `Alt+R` | Optional. Toggles microphone recording if ffmpeg is available. Persists across navigation and reloads |
| **📌 핀** (Pin) macOS `Cmd+P` · Windows/Linux `Alt+P` | In pin mode, click to mark an element or drag to mark an area as "here" (not passed to the app) |
| macOS `Cmd+drag` · Windows/Linux `Alt+drag` | Pin an area right away, even outside pin mode |
| **포인트** (Points) | Review points provided by the agent. Click one to mark "now talking about this point" |
| **제출** (Submit) / **✕** | Submitting closes the window and sends the result. Simply closing the window also submits if there are recordings or pins |

A note field appears right next to a new pin. Press Enter to save (it can be empty) or Esc to cancel. Saved pins stay on the page
as outlines with a number and note (they disappear when you go to another page), and area pins also pass along the elements and visible text inside them.

New tabs, in-app navigation, and reloads are all recorded. The microphone is recorded directly with ffmpeg.

### Document review

A page opens in your default browser. Toggle recording with `R` or **● 녹음** (Record).
You can leave text comments on each section and use choice buttons for questions. If you closed the tab, reopen it with `url.txt` in the review folder.

## Letting the agent re-run a demonstration

The agent reads a demonstration recording, playbook, or skill, works out the steps and verification conditions,
then operates the real app with `run_start` → repeated `run_step` → `run_finish`.
While a human is reviewing, the existing `review_wait` flow is used, but **agent execution does not call `review_wait`.**
A single MCP server cannot have a review and a run open at the same time.

| Tool | Role |
|---|---|
| `run_start` | Opens the dedicated Chrome and starts recording the run. Returns the current elements, a screenshot, the run id, and the output folder. Default URL is `about:blank` |
| `run_step` | Runs one step: observe, navigate, click, fill, select, check, key press, scroll, wait, or assert. Omitting `action` observes the screen. `actions` runs several steps at once |
| `run_finish` | Closes Chrome and saves the record. Returns the result and the `replay.html` path. `cancel: true` also aborts a step in progress |

Example MCP calls:

```json
{"tool":"run_start","arguments":{"cwd":"/path/to/project","url":"http://localhost:5173/login","title":"Login E2E","allow_actions":true,"isolated":true,"source_recording":"/path/to/project/.walkmate/reviews/mcp/demo"}}
{"tool":"run_step","arguments":{"id":"u1","action":{"type":"fill","target":{"kind":"testid","value":"auth-email"},"value_env":"E2E_EMAIL","source_step":"login-email"}}}
{"tool":"run_step","arguments":{"id":"u1","action":{"type":"fill","target":{"kind":"testid","value":"auth-password"},"value_env":"E2E_PASSWORD","source_step":"login-password"}}}
{"tool":"run_step","arguments":{"id":"u1","action":{"type":"click","target":{"kind":"testid","value":"auth-login-submit"},"source_step":"login-submit"}}}
{"tool":"run_step","arguments":{"id":"u1","action":{"type":"wait","target":{"kind":"testid","value":"dashboard"},"condition":"visible"}}}
{"tool":"run_step","arguments":{"id":"u1","action":{"type":"assert","condition":"url","expected":"/dashboard"}}}
{"tool":"run_finish","arguments":{"id":"u1"}}
```

### Running several steps at once

Calling a tool per step is slow, because the agent has to read each response (element list, screenshot) and decide the next step.
When the order is fixed and targets are pinned down by testid, css, or role, as in an E2E skill, pass them all at once with `actions`.

```json
{"tool":"run_step","arguments":{"id":"u1","evidence":"summary","actions":[
  {"type":"fill","target":{"kind":"testid","value":"auth-email"},"value_env":"E2E_EMAIL"},
  {"type":"fill","target":{"kind":"testid","value":"auth-password"},"value_env":"E2E_PASSWORD"},
  {"type":"click","target":{"kind":"testid","value":"auth-login-submit"}},
  {"type":"wait","target":{"kind":"testid","value":"dashboard"},"condition":"visible"},
  {"type":"assert","condition":"url","expected":"/dashboard"}
]}}
```

- Runs up to 50 steps in order and **stops at the first failure.** Remaining steps are not run.
- If any step is malformed, the whole batch is rejected and nothing runs.
- The response contains each step's status and screen evidence for the last (or failed) step only.
- A `ref` must come from the current screen response, so steps that require looking at the screen to choose a target are run one at a time.

`evidence` sets how much evidence the response includes. It also works with a single `action`.

| Value | Response |
|---|---|
| `full` (default) | Element list, page text, screenshot |
| `summary` | URL, title, tabs, element count, and the first 1000 characters of page text. No screenshot |
| `none` | Step results only |

A failed step is always returned as `full`, regardless of `evidence`.
Before/after screenshots for each step are saved to `shots/` regardless of response detail, and appear in `replay.html` as well.

Set `E2E_EMAIL` and `E2E_PASSWORD` in the MCP server's environment. Choose the testids and verification conditions in the example to match your app.
`source_recording` and `source_step` link a run to its demonstration; they do not read or replay that recording automatically.

### Finding elements and deciding success

- `target.kind` is one of `ref`, `testid`, `css`, or `role`. A `ref` is a value from the current screen response;
  observe the screen again when the page changes or the element is replaced. `role` and names are inferred from the DOM and are not a full accessibility tree.
- If multiple elements match, the step fails. Set `scope` to a CSS selector that points to exactly one container, or use a unique ref.
  Coordinates from the recording are never replayed as-is.
- `fill` and `select` take either `value` or `value_env`. `select` uses the option value of a native select.
  `check` takes the desired state and does not click a checkbox that is already in that state.
- `wait` waits until the condition is met; `assert` checks the current condition once.
  Conditions are `visible`, `hidden`, `text`, and `url`; `text` and `url` check whether `expected` is contained.
- The step time limit is set with `timeout_ms`: 10 seconds by default, 30 seconds at most. On timeout, the run is aborted to prevent follow-up actions from firing late.
  After a failure you can check evidence with `observe` or finish; state-changing actions are never silently retried.
- A run that ends without a successful `assert` is `completed`. It is `passed` only when every recorded step succeeded and at least one assertion passed.
  A failed step records `failed`, a user abort `cancelled`, and a timeout `timeout`.
  `passed` means the assertions you wrote passed, not that the run matched the demonstration exactly or verified every business condition.

### Run window and records

By default Chrome is visible to the user. `headless: true` is for test runs without a window.
The default login profile is the shared profile, which may already be logged in. When you are verifying login itself or need a clean initial state,
use `isolated: true` for a temporary profile. The temporary profile is deleted when the run ends; the shared login profile is kept.
The overall run time limit is set with `timeout_sec`: 3600 seconds by default and at most.

Records are saved to `<project>/.walkmate/runs/<run folder>/`:
`request.json`, `steps.json`, `run.json`, `events.json`, `network.json`, `console.json`, `shots/`, and the rrweb recording.
If a full snapshot of the screen was captured, `replay.html` is created as well. Without a snapshot, for example when only a blank tab was opened before finishing, no replay page can be made.
Clicking a step in the replay page jumps to that point in the run. This replays the record; it does not re-run the real app.

Run mode does not use the microphone. You can abort a run with the browser's cancel button or by closing the window.
Literal input values are masked in the step log and in the DOM recording.
In network request and response bodies, fields named like `password`, `token`, or `secret`, and JWTs, are replaced with `[redacted]` before saving (for both demonstrations and runs). **Screenshots, page text, and network bodies
are not fully de-identified**, so review records before sharing them.

`allow_actions` defaults to `false`. Set it to `true` only when the user has approved that test run.
Actions with hard-to-reverse results, such as saving, publishing, deleting, or paying, need explicit approval. This flag does not
classify what a button means for the business, and does not replace separate approval. Browser confirm dialogs are currently dismissed rather than accepted, and the step fails.

The first version operates on the top-level document's DOM. Searching inside iframes or shadow DOM, file upload, drag, and running arbitrary JavaScript are not supported.
**This is a feature for the agent to choose steps or pass a fixed batch of steps to run**; there is no unattended `workflow.json` execution or automatic comparison between demonstration and run yet.

## Exporting a demonstration as a Playwright test

After you demonstrate something, say "turn this demonstration into a Playwright test" and the agent exports the recording
to a `.spec.ts` file with `export_to_playwright`. It reads the saved recording only; no browser opens.

1. **Open with isolated and demonstrate.** To show the login too, use `isolated: true`; to reuse the test account's ID and password as typed,
   also pass `record_inputs: true` ("I'll show you from login, record the password too").
2. **Submit.** The agent receives the demonstration (actions, voice, pins, screenshots) through `review_wait`.
3. **Export.** The agent calls `export_to_playwright({ recording, cwd })`, which writes the file into the project's test folder and returns the code.
   Then it runs `npx playwright test <file>`, fixes the TODO lines and adds expect checks for the goal of the demonstration.

While recording, the page stores **locator candidates for each element together with how many elements matched at that moment**,
so the export can pick a unique one.

| Demonstration | Generated code |
|---|---|
| Start URL, navigation typed into the address bar | `page.goto(url)` |
| Click | Locator chosen in this order: unique testid → role+name → role+name inside a container with a unique testid → label → placeholder → id → name attribute, then `.click()` |
| Typing, select, checkbox/radio | `.fill(value)`, `.selectOption(value)`, `.check()` / `.uncheck()` |
| Enter in a text field, Escape | `.press("Enter")`, `page.keyboard.press("Escape")` |
| Address change right after an action (within 5s) | `expect(page).toHaveURL(url)` at the end of that step |
| New window (popup) | `page.waitForEvent("popup")` and a `page2` variable |
| Element pin | `expect(locator).toBeVisible()` with the pin memo as a comment |
| Voice | Comment above the matching step |

- Each action is wrapped in `test.step("3. 입력: 이메일", ...)`. If the project has the `walkmate` package, the test is wrapped with `withWalkmate`,
  so every run leaves `.walkmate/runs/<run folder>/replay.html` (set `with_walkmate` to choose explicitly).
- Events that duplicate another step are dropped: the click that focuses a field, the click on a checkbox label, and the default-button click
  the browser makes when Enter submits a form. Hovers and scrolls are left out (Playwright scrolls to the target).
- With `record_inputs: true`, typed values including passwords go into the code **as literals**, with a warning comment at the top of the file.
  Masked values are read from required environment variables such as `env("WALKMATE_PASSWORD")`.
- When an element was picked by its recorded position among same-named elements (`.nth(i)`), or can only be found by its text, a `// TODO:` goes above that line.
  Without a pin, a final TODO asks for a completion check. A URL check alone does not show the demonstration succeeded.
- The default location is `<title>.spec.ts` under `testDir` from `playwright.config`, otherwise `e2e/` or `tests/`. An existing file is not overwritten
  unless `overwrite: true`. `from`/`to` (seconds) export part of the recording.
- File uploads stay as a commented-out `setInputFiles` with a TODO, since the path is unknown. Drag and contenteditable typing are not converted yet.
  Older recordings without locator candidates fall back to visible text with a TODO.

The CLI does the same. Without a folder it uses the newest recording in the current project.

```bash
walkmate playwright [.walkmate/reviews/mcp/<recording folder>] [--out e2e/login.spec.ts] [--title title] [--from sec] [--to sec] [--overwrite]
```

## Turning a demonstration into a playbook (prototype)

To hand a human demonstration to an agent, convert a submitted **live review folder** into a draft playbook.
This does not open a browser or run any actions, and it reads only local files, with no LLM or external API calls.

```bash
# Run after building in the repository. Set REVIEW to a live review folder containing events.json.
npm run build
REVIEW="$PWD/.walkmate/reviews/mcp/<recording folder>"
node dist/mcp/cli.js playbook "$REVIEW" --from 42 --to 50 --title "Demonstrated task"
```

The result is saved to `$REVIEW/playbook/playbook.json` and `playbook.md`. By default the whole recording is used;
`--from` and `--to` are seconds elapsed since the recording started (`0 <= from < to <= duration`). Use `--out <folder>` to change the output folder.
Existing drafts are never overwritten. To regenerate, specify a different output folder. The original recording files are not modified.

A draft contains:

- Click, input, and scroll steps, with the URL before each action and the React component and source location
- **Element lookup candidates** using testid, role/name, text, and a short CSS description
- Address changes, new tabs, document MIME types, and API metadata observed within 2 seconds after a step. The link is cut at the next action in the same tab or at the end of the selected range.
- Parameter candidates built from input events, plus voice and pin notes. Masked input values must be provided again.
- Things to check for each step. Every result has `status: "draft"`.

**Observed changes are not confirmed completion conditions.** A testid may belong to a parent container, and roles and accessible names are
inferred from the recorded tags and text. Exploratory or mistaken actions are not removed automatically, and a `blob:` new tab
with no document type is not assumed to be a PDF. Special keys, file uploads, and drags are not converted into steps yet.

Have the agent read `playbook.md` and work out the following first.

1. Keep only the steps needed for the goal. If the range is too wide, regenerate with a narrower time window.
2. Turn input values and IDs embedded in URLs or rows into parameters so the playbook works for other customers and periods.
3. Find the elements in the current DOM, and when several match, narrow the scope to a row or container.
4. Settle the success check and wait condition for each step. Do not save, publish, delete, or pay without approval.

The playbook CLI only creates drafts and does not run actions automatically. After reviewing a draft, the agent can run it
step by step with the `run_*` tools above, but there is no automatic comparison between demonstration and run. Customer information, URLs, and notes may appear in drafts too, so check them before sharing externally. Network request and response bodies are not copied into drafts.

## What it collects

Live review collects, directly from the browser via the Chrome DevTools Protocol, what rrweb alone would not capture.

| | Saved as | Given to the agent |
|---|---|---|
| Speech | `clip-*.flac`, `transcript.json` | What you were pointing at for each utterance |
| Screen actions | `events.json`, `rrweb-tab*.jsonl` | Pointer, clicks, selection, input, scroll, navigation, tab switches, pins |
| Screenshots | `shots/` | Up to 6 per utterance and pin. Target highlighted and downscaled with ffmpeg, original otherwise |
| Network | `network.json`, API response bodies in `network/` | API list, with failed and slow requests attached to the related utterance. Previews of failed responses |
| Console | `console.json` | Errors, warnings, uncaught exceptions (source file:line) |
| PDFs and other non-HTML documents | Copies in `docs/` (including blob URLs) | That it was opened, and the copy's path. Clicks and scrolls inside it are not recorded (see screenshots) |
| Original images and fonts | `assets/` | Nothing. `replay.html` uses the copies instead of the original addresses |
| canvas | rrweb (1 frame per second, `WALKMATE_CANVAS_FPS`) | Nothing. For replay |

Request and response headers are not saved (cookies, tokens). Response bodies are saved only for API (fetch/XHR) text, up to 256KB.
Cross-origin iframes leave only screen (screenshots) and network records; their DOM is not recorded.
In pin mode a transparent overlay covers the page, so you can pin on top of PDF viewers and iframes too.

## MCP tools

Reviews take several minutes and MCP clients put timeouts on tool calls, so waiting is split into its own tool.

| Tool | |
|---|---|
| `review_start` | Called with no arguments, starts a live demonstration in a blank Chrome tab. With `url`, a live review on that site; with non-empty `sections` and no URL, a document review. `title` defaults to `Walkmate`. Returns the review id |
| `review_wait` | Waits up to 45 seconds (`WALKMATE_WAIT_SEC`). Returns feedback (text + screenshots) if finished, otherwise "call again" |
| `review_cancel` | Closes the open review |
| `export_to_playwright` | Exports a live demonstration recording as a Playwright test file. Returns the path, code and TODOs. Does not open a browser |

`review_wait` returns before the client's tool timeout (Codex `tool_timeout_sec`, Claude Code `MCP_TOOL_TIMEOUT`, pi `timeout`, 60 seconds by default),
so you don't need to change any settings. It also sends progress notifications.

One server opens only one review at a time. When the agent ends (the server shuts down), any open review and its window close too.

## What the agent receives

Report labels are generated in Korean (e.g. `핀` = pins, `메모` = note, `영역` = area, `안` = inside, `보이는 글자` = visible text).

Live review:

```
1. [00:01.0] 🗣 "These legend colors are too similar to tell apart."
   ↳ /dashboard · <ServiceUsageChart> li "Compute" (src/features/dashboard/chart/ServiceUsageChart.tsx:42)  🖼 #2
2. [00:05.6] 🗣 "Please right-align the numbers here."
   ↳ /dashboard · <InvoiceTable> td "1,234,000원" (src/features/dashboard/table/InvoiceTable.tsx:18)  🖼 #1

## 핀
📌1 [00:05.6] /dashboard · <InvoiceTable> td "1,234,000원" — 메모: "right-align"  🖼 #1
📌2 [00:07.6] /dashboard · 영역 210×132 — 메모: "more spacing"  🖼 #2
   안: <ServiceUsageChart> li "Compute" · <InvoiceTable> td "1,234,000원" (src/features/dashboard/table/InvoiceTable.tsx:18)
   보이는 글자: "Compute Storage 서비스 1,234,000원"
```

This is followed by the full timeline (navigation, pointer, clicks, input, scroll), with up to 6 screenshots attached.
With ffmpeg, targets are marked with a red box; otherwise the originals are attached. Components and files are found from React development build debug info (omitted in production builds).

Document review (`결정` = decision, `본 시간` = time viewed, `선택` = selection):

```
### d1 · 결정 · Make user_id nullable  (본 시간 0:04)
- 🗣 [00:02.0] "Hmm, this decision looks a bit off."
- ✂ [00:01.8] 선택: "user_id INTEGER NULL"
```

The originals (recordings, events, screenshots, rrweb, report) are kept in `<project>/.walkmate/reviews/<session>/<time>-<unique suffix>/`.
Opening a live review's `replay.html` plays the rrweb screen and the recording together; clicking an utterance in the list jumps to that moment.

## Per-project records and skills

Recordings and material made from them are gathered under the project's `.walkmate` folder.
Pass the root of the project you are working on as MCP `cwd`. If omitted, the MCP server's working directory is used;
Walkmate does not guess a repository from the app URL or search other projects. If the client pins the server's working directory,
the agent must pass the current project path it knows as `cwd`.

```text
<project>/.walkmate/
  .gitignore                     default: excludes all internal files from Git
  reviews/mcp/<recording folder>/  original records, reports, replay pages
    playbook/                    draft playbooks made by the CLI
  runs/<run folder>/             agent run records, step results, replay pages
  skills/<name>/SKILL.md          where the agent writes a requested E2E skill
  notes/<name>.md                where to save a demonstrated procedure you asked it to remember
```

`review_start` and feedback responses show the actual recording folder and where to save skills and notes.
MCP instructs the agent to use these paths and to record the original recording path alongside.
Unless the user specifies another location, they are not saved to global agent memory or unrelated folders.
Skills and notes are written by the agent on the user's request; submitting a recording does not create them automatically.
`.walkmate/skills` is a storage location, not a skill path that each agent discovers automatically.
To use one, have the agent read the file directly, or install it into that agent's skill path after review.

The login profile and speech model are kept in the shared folder `~/.walkmate`. The same Chrome profile is used
across projects, so you stay logged in unless the site expires the session.
`WALKMATE_HOME` changes only this shared folder; where project recordings go is decided by `cwd`.

**Recordings can contain sensitive information.** Passwords or tokens may remain in network request and response bodies,
so don't assume it is safe to push them to a public repository, even with a demo account. A new `.walkmate` folder gets a `.gitignore`
that excludes internal files from Git, and existing rules are not overwritten. Files already tracked by Git are not untracked by
ignore rules alone, so check them separately. Review the contents before sharing.
When turning a login procedure into a skill or note, don't copy passwords or tokens; have them read from environment variables.

## Migrating from earlier versions

The CLI is named `walkmate` and environment variables use the `WALKMATE_` prefix.
The shared model and Chrome profile folder is `~/.walkmate`, and new recordings are saved to the project's `.walkmate/reviews`.
The old `review-recorder` executable name and `REVIEW_RECORDER_*` environment variables are no longer supported,
and the old data folder `~/.review-recorder` is not read or moved automatically.
MCP tool names (`review_start`, `review_wait`, `review_cancel`) are unchanged.

To keep using your existing speech model and Chrome login profile, quit the MCP client and the review Chrome,
then move the shared data folder. The command below does not move anything if the target folder already exists.
If both folders exist, back them up first and move the data you need by hand.

```bash
if [ -d "$HOME/.review-recorder" ] && [ ! -e "$HOME/.walkmate" ]; then
  mv "$HOME/.review-recorder" "$HOME/.walkmate"
fi
```

Old recordings moved this way stay in `~/.walkmate/reviews`, but new recordings are not saved there.
Check the old recordings you need and move them into the relevant project's `.walkmate/reviews` yourself.
Update absolute paths written in existing playbooks and notes as well.

Rename any `REVIEW_RECORDER_<NAME>` set in the MCP server's environment to `WALKMATE_<NAME>`.
A custom shared folder can be set with `WALKMATE_HOME`. Also update model and Chrome profile settings with explicit paths
to match the new location. Moving the Chrome profile keeps your saved logins, but
you may need to log in again depending on site session expiry or OS encryption policy.

If you registered MCP under the old name, remove that registration and register again with the `walkmate` command above.
If you moved the repository directory, update the path in the server command. If you used the CLI through `npm link`, run it again.
Restart the MCP client after building (`/reload` in pi).

The dedicated pi extension has been removed. If you registered it with `pi install`, remove that installation and register via MCP.
Instead of the extension's `/review` command, `request_review` tool, and progress widget,
use MCP's `review_start`, `review_wait`, and `review_cancel`.

## Configuration (environment variables)

| Variable | Default | |
|---|---|---|
| `WALKMATE_HOME` | `~/.walkmate` | Shared model and browser profile. Recordings are saved to the project's `.walkmate/reviews` |
| `WALKMATE_TRANSCRIBER` | `auto` | `whisper-cpp`, `openai`, `none` |
| `WALKMATE_LANG` | `ko` | Transcription language |
| `WALKMATE_WHISPER_BIN` | `whisper-cli` | |
| `WALKMATE_WHISPER_MODEL` | `<data folder>/models/ggml-large-v3-turbo.bin` | The default data folder is `~/.walkmate`. Can be changed with `WALKMATE_HOME` |
| `WALKMATE_TIMEOUT_MIN` | `60` | Review time limit. `0` means unlimited |
| `WALKMATE_WAIT_SEC` | `45` | One MCP `review_wait` wait. Keep it shorter than the client's tool timeout |
| `WALKMATE_OPEN` | | Document review: `0` to not open the browser automatically |
| `WALKMATE_MIC` | `default` | macOS: AVFoundation device, Linux: PulseAudio source, Windows: actual DirectShow audio device name |
| `WALKMATE_MAX_SHOTS` | `6` | Number of screenshots attached to live review results |
| `WALKMATE_CANVAS_FPS` | `1` | Frames per second for rrweb canvas recording. `0` turns it off |
| `WALKMATE_CHROME` | Per-OS Chrome path or `google-chrome` | Set the executable path if the default can't find it |
| `WALKMATE_CHROME_PROFILE` | `<data folder>/chrome-profile` | Defaults to `~/.walkmate/chrome-profile`. Keeps login info between reviews |

## Structure

```
src/core/   agent-independent demonstration and review engine
src/mcp/    stdio MCP server and CLI (built to dist/)
```

| File | Role |
|---|---|
| `core/review.ts` | A single review: open → wait → transcribe → report (document and live). The host connects through `ReviewEnv` |
| `core/storage.ts` | Per-project `.walkmate` paths, unique recording and run folders, default Git ignore rules |
| `core/runtime/run.ts`, `core/runtime/types.ts` | Native browser run sessions, actions, assertions, run results, and argument validation |
| `core/page/runtime.js` | Current DOM observation, unique element lookup, ref management. Does not run user JavaScript |
| `mcp/runtime.ts` | Run tools `run_start` / `run_step` / `run_finish` and session management |
| `core/types.ts` | Request JSON Schema and validation |
| `core/dependencies.ts` | Per-OS executable lookup and setup guidance for optional voice tools |
| `core/render.ts`, `core/server.ts`, `core/diff.ts`, `core/timeline.ts` | Document review page, 127.0.0.1 server, git diff, report |
| `core/live/cdp.ts` | CDP client, launching and reconnecting Chrome with the dedicated profile |
| `core/live/session.ts` | Injects scripts into every tab, receives events, tracks the active tab, controls recording, takes screenshots, saves rrweb and document copies |
| `core/live/capture.ts` | Network (request and response bodies), console, exceptions, browser logs, original images and fonts |
| `core/live/mic.ts` | ffmpeg microphone recording and level meter |
| `core/live/report.ts` | Event compaction, linking utterances to targets, screenshot selection and marking, report |
| `core/live/replay.ts` | rrweb + voice synchronized replay page, rewriting addresses to the saved images and fonts |
| `core/live/playbook.ts` | Builds pre-run JSON and Markdown draft playbooks from a saved live review |
| `core/live/export-playwright.ts` | Converts a saved live review into a Playwright `.spec.ts`: locator choice, duplicate event cleanup, popups and URL checks |
| `core/page/live.js` | App page: toolbar, tracking pointer, clicks, selection, input, scroll, and navigation, finding React components and sources, pins |
| `core/transcribe.ts` | whisper.cpp / OpenAI, word-level timestamps, excluding silent clips |
| `mcp/server.ts` | MCP tools `review_start` / `review_wait` / `review_cancel` / `export_to_playwright`, prompts |
| `mcp/cli.ts` | CLI: `mcp` (server), `doctor` (checks), `setup` (download model), `playbook` (convert a demonstration), `playwright` (export a test) |

## Development

```bash
npm run check                      # tsc
npm test                           # node --test (includes the MCP server; only the silent transcription test is skipped without ffmpeg)
npm run build                      # dist/
node scripts/e2e.ts                # optional macOS voice integration test: Chrome + ffmpeg + say -v Yuna
node scripts/e2e-live.ts           # optional macOS live integration test: same voice tools + API, console, PDF, replay.html
node scripts/e2e-launch.ts         # optional Chrome integration test: blank tab → navigate to site → toolbar and recording (no voice tools needed)
WALKMATE_E2E=1 node --test test/runtime-browser.test.ts  # optional real MCP + Chrome run test (isolated headless profile)
node scripts/e2e-agent.ts claude   # whether a real agent (claude, codex, pi) opens a review over MCP, waits, and gets the result
```

Type checking and building do not need a global pi install or machine-specific type paths.
