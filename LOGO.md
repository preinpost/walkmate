# Walkmate 로고 디자인 브리프

이 문서는 Walkmate의 로고를 이미지 생성 모델(Gemini Nano Banana, FLUX, Recraft, Seedream 등)에
넘겨 일관된 결과를 얻기 위한 디자인 브리프다. 섹션 1~6은 배경 설명이고, 섹션 7의 프롬프트를
모델에 입력하면 된다. 모델별 주의점은 섹션 8에 정리했다.

## 0. 확정 현황

| 항목 | 상태 |
|---|---|
| 메인 일러스트 | ✅ A안 확정 — `logo-drafts/seedream-lite-duck-A-01.jpg` (Seedream 5.0 Lite, 7.2 + 7.1 프롬프트) |
| 단순화 심볼 | 🔶 시안 1 — `logo-drafts/symbol-duck-A-01.jpg` (보완 필요: 16px에서 두 오리가 붙어 보임) |
| 워드마크 조합 | 미정 (7.5) |
| 단색 변형 | 미정 (7.7) |
| README 적용 | ✅ `assets/walkmate-icon.png`(상단 아이콘, 512px), `assets/walkmate-symbol.png`(제목 옆 심볼, 256px) — 위 두 시안의 바깥 흰 배경을 투명하게 처리한 PNG |

확정 시안에서 벡터화할 때 손볼 점:

- 눈 색을 검정에서 슬레이트 #0F172A로 바꾼다.
- 어미 발 옆 흐릿한 잔상과 캔버스 가장자리 잡티를 지운다.
- 색을 섹션 6의 hex로 맞춘다.
- 단순화 심볼을 만들 때는 아기 오리 부리와 어미 꼬리 사이에 간격을 벌린다. 지금은 거의
  붙어 있어서 16px에서 한 덩어리로 뭉친다.

## 1. 브랜드 정의

| 항목 | 내용 |
|---|---|
| 이름 | Walkmate (워크메이트) |
| 슬로건 | Show once. Let your agent check again. |
| 한 줄 소개 | 사람이 앱을 한 번 보여 주면, 코딩 에이전트가 같은 절차를 다시 실행하고 검증하는 브라우저 시연·실행 런타임 |
| 대상 | 코딩 에이전트(Claude Code, Codex, pi)와 함께 일하는 개발자, QA 담당자 |

### 브랜드가 전달해야 하는 핵심 개념

1. **같이 걷는 동반자(mate)**: 사람이 앞서 걸으며 시연하면, 에이전트가 그 발자취를 따라간다.
2. **한 번의 시연, 반복되는 실행**: 녹화(replay) → 플레이북 → 에이전트 실행의 순환.
3. **시간축 위의 기록**: 행동·음성·화면·네트워크가 하나의 타임라인에 기록된다.
4. **개발자 도구다운 신뢰감**: MCP stdio 서버, CDP 기반의 실용적인 CLI 도구다.

로고 하나에 네 가지를 다 담을 수는 없다. 1번(사람 → 에이전트로 이어지는 동반)을 최우선으로
하고, 나머지는 후보안마다 하나씩만 보조로 싣는다.

### 메인 모티프: 어미 오리와 아기 오리

아기 오리는 태어나 처음 본 대상을 그대로 따라 걷는다(각인, imprinting). 사람이 한 번 보여
주면 에이전트가 같은 길을 따라 걷는 Walkmate의 구조와 그대로 겹친다.

| 오리 | 역할 | 대응 |
|---|---|---|
| 어미 오리 | 앞서 걸으며 길을 보여 준다 | 사람(시연자) |
| 아기 오리 | 같은 길을 그대로 따라 걷는다 | 코딩 에이전트 |

덤으로, 개발자에게 오리는 러버덕 디버깅으로 익숙하고 친근한 동물이다.

## 2. 브랜드 무드

- 친근하지만 장난스럽지 않다. "walk(걷다)" + "mate(친구)"라는 이름의 온기를 유지한다.
- 동시에 개발자 도구이므로 단정하고 신뢰감 있어야 한다. 오리가 들어가도 유아용 그림책이나
  장난감 브랜드처럼 보이면 안 된다. 형태는 기하학적으로 정돈하고, 표정·소품은 최소로 한다.
- 픽셀아트·모자이크 표현은 쓰지 않는다. 시안에서 모자이크 검열처럼 보였다.

## 3. 로고 구성: 2단계

일러스트 스타일은 표현력이 좋지만 작은 크기에서 디테일이 뭉개진다. 그래서 로고를 두 단계로
나눈다.

| 단계 | 용도 | 크기 | 스타일 |
|---|---|---|---|
| 1. 메인 일러스트 로고 | README 상단, 소개 페이지, 발표 자료 | 128px 이상 | 플랫 벡터 일러스트 (섹션 5) |
| 2. 단순화 심볼 | 파비콘, GitHub 아바타, 터미널·문서 아이콘 | 16~64px | 큰 오리 + 작은 오리 두 실루엣만 남긴 단색 면 |

2단계는 따로 구상하지 않는다. 1단계를 확정한 뒤 그 이미지를 첨부해서 단순화한다(섹션 7.6).

## 4. 후보 아이디어

세 안 모두 어미 오리 1마리와 아기 오리 **정확히 1마리**가 오른쪽으로 걷는 옆모습이다.
사람 1명과 에이전트 1개의 관계이므로 아기 오리를 여러 마리 두지 않는다.

### A. 함께 걷는 오리 (Walk Together)

어미 오리가 앞서 걷고, 아기 오리가 한 발짝 뒤에서 어미를 올려다보며 따라온다. 가장 단순하고
아이콘화하기 쉬운 기본안이다.

### B. 같은 발자국 따라 걷기 (Follow the Steps)

어미 오리가 지나간 자리에 물갈퀴 발자국이 남고, 아기 오리가 그 발자국을 정확히 밟으며
따라온다. "한 번 보여 준 절차를 그대로 다시 실행한다"는 replay 개념까지 담는다.

### C. 타임라인 위의 오리 (Duck on the Timeline)

미디어 플레이어의 타임라인 바가 땅이 되고, 그 위를 두 오리가 걷는다. 아기 오리는 재생
헤드(playhead) 위에 서 있다. "시간축 위의 기록"이라는 기술적 특징을 담는, 개발 도구 쪽에
가장 가까운 안이다.

### 리스크

- **DuckDuckGo**: 원 안에 오리 머리를 넣은 로고다. 오리 머리 클로즈업, 원형 배경 + 오리 한
  마리 구성은 피한다. 그래서 배경판을 원이 아닌 둥근 사각형으로 바꿨고, 항상 두 마리의
  전신 옆모습으로 그린다.
- **러버덕·목욕 장난감**: 노란 고무 오리처럼 보이면 장난감 브랜드가 된다. 오리 몸통을
  노란색으로 칠하지 않는다.

### 이전 시도 (폐기)

발자국 경로, 걷는 사람 + 재생 기호(Walkman 연상), 타임라인 걷기, 사람 발자국 + 픽셀
발자국 안을 시도했다. 발자국은 만보기·헬스 앱처럼 보였고, 픽셀 발자국은 모자이크처럼
보여서 폐기했다. 해당 시안 파일은 삭제했다.

## 5. 스타일 지침

- 스타일: **플랫 벡터 일러스트**. Stripe·Linear 블로그 삽화처럼 깔끔한 면과 부드러운 곡선.
- 오리 형태: 타원 몸통, 둥근 머리, 점 하나로 된 눈, 작은 부리, 작은 물갈퀴 발. 깃털 결,
  눈썹, 입 모양 같은 표정 디테일은 넣지 않는다.
- 입체감: 그라데이션 대신 색마다 **기본 톤 + 밝은 톤** 두 단계의 평면 색으로 표현한다
  (예: 날개만 밝은 톤).
- 선: 외곽선(outline)을 쓰지 않는다. 형태는 면으로만 만든다.
- 디테일: 장면은 두 오리 + 바닥 요소 하나(땅선, 발자국, 타임라인 중 하나)로 끝낸다.
- 구도: 1:1 정사각형. 옅은 둥근 사각형 배경판 위에 장면을 올리고, 장면이 캔버스의 약
  70%를 채운다.
- 배경: 배경판 바깥은 캔버스 끝까지 순백(#FFFFFF).
- 금지: 3D 렌더링, 사실적인 깃털, 만화풍 큰 눈·표정, 픽셀아트·모자이크, 그림자 과다,
  워터마크, 종이·노이즈 텍스처, 프레임 테두리.

## 6. 색상

색은 **요소의 역할**로 정한다. 모든 후보안에서 같은 규칙을 지킨다.

| 역할 | 기본 톤 | 밝은 톤 | 적용 대상 | 프롬프트 색 이름 |
|---|---|---|---|---|
| 사람 | 청록 틸 #14B8A6 | #5EEAD4 | 어미 오리, 어미가 남긴 발자국 | teal |
| 에이전트 | 인디고 #4F46E5 | #818CF8 | 아기 오리, 재생 헤드 | violet-indigo |
| 포인트 | 앰버 #F59E0B | — | 두 오리의 부리와 발에만 | warm amber |
| 배경판 | 인디고 틴트 #EEF2FF | — | 둥근 사각형 배경판, 땅선·타임라인 바 | pale lavender |
| 중립 | 슬레이트 #0F172A | — | 워드마크, 단색 변형 | dark slate navy |

- 그라데이션은 쓰지 않는다.
- 우연이지만 "teal"은 쇠오리를 가리키는 영어 단어이기도 하다. 어미 오리를 청록으로 칠하는
  근거로 삼을 수 있다.
- "deep indigo blue"라고 쓰면 모델이 짙은 남색으로 그렸다. 보랏빛이 도는 #4F46E5에
  가깝게 하려고 "violet-indigo"라고 쓴다.
- 이미지 모델은 hex 값을 정확히 재현하지 못한다. 프롬프트에는 색 이름만 쓰고, 정확한
  hex는 벡터화 단계에서 맞춘다(섹션 9).

## 7. 이미지 생성 프롬프트

메인 일러스트를 먼저 뽑고(7.2~7.4), 하나를 고른 뒤 워드마크 조합(7.5), 단순화 심볼(7.6),
단색 변형(7.7) 순서로 만든다.

작성 원칙:

- 프롬프트에는 제품 이름을 넣지 않는다(7.5 워드마크 제외). 이름을 쓰면 모델이 글자를
  그려 넣는다.
- hex 코드는 넣지 않는다. hex 문자열이 이미지에 글자로 찍히는 경우가 있다.
- 원하지 않는 것("no shadow")보다 원하는 것("flat solid colors")을 쓴다. 언급만 해도
  그 요소가 나타날 수 있다.
- 개수와 배치는 숫자와 위치로 정확히 쓴다("exactly one duckling", "one step behind").

### 7.1 일러스트 공통 꼬리 (7.2~7.4 끝에만 붙인다)

```
Flat vector illustration logo, square 1:1 canvas. Clean flat shapes with soft
rounded curves and no outlines. Each color uses two flat tones, a base tone and
a lighter tint, for gentle depth. Limited palette: teal, violet-indigo, a small
touch of warm amber, and a very pale lavender backdrop. The scene sits on a pale
lavender rounded-square backdrop with softly rounded corners and fills about 70%
of the canvas, centered. Outside the backdrop the canvas is plain white all the
way to the edges. Friendly, polished, modern tech brand illustration, simple and
iconic. Artwork only, with no lettering anywhere.
```

네거티브 프롬프트 입력란이 따로 있는 모델에서만 아래를 넣는다(FLUX에는 넣지 않는다).

```
text, letters, words, numbers, watermark, signature, rubber duck, bath toy,
yellow duck, realistic feathers, big cartoon eyes, eyebrows, smile, pixel art,
mosaic, checkerboard, 3D render, photo, gradient, outline, border, frame,
paper texture, noise, multiple ducklings
```

### 7.2 아이디어 A — 함께 걷는 오리

```
Side view of a mother duck and exactly one duckling walking together toward the
right on a short, soft ground line. The mother duck leads, in teal. The duckling
follows one step behind her, in violet-indigo, looking up at her. Both ducks are
built from simple rounded geometric shapes: an oval body, a round head, a single
small dot eye, a small warm amber beak, and small warm amber webbed feet
mid-stride. The wing on each duck is a lighter tint of its body color.
```

### 7.3 아이디어 B — 같은 발자국 따라 걷기

```
Side view of a mother duck in teal walking toward the right, leaving behind her
a gently curving trail of exactly three simple webbed footprints in a pale teal
tint. Exactly one duckling in violet-indigo follows at the start of the trail,
stepping precisely into her footprints, retracing the exact same path. Both ducks
are built from simple rounded geometric shapes: an oval body, a round head, a
single small dot eye, a small warm amber beak, and small warm amber webbed feet.
```

### 7.4 아이디어 C — 타임라인 위의 오리

```
A wide horizontal media timeline bar with rounded ends, in a slightly deeper
lavender, serves as the ground. Side view of a mother duck in teal walking
toward the right near the right end of the bar. Exactly one duckling in
violet-indigo follows behind her, standing on a round playhead knob in
violet-indigo on the bar, as if replaying her walk. Both ducks are built from
simple rounded geometric shapes: an oval body, a round head, a single small dot
eye, a small warm amber beak, and small warm amber webbed feet.
```

### 7.5 워드마크 조합 (메인 일러스트 확정 후)

확정된 일러스트를 첨부해서 생성한다. 이 프롬프트에는 7.1 공통 꼬리를 붙이지 않는다.

```
Horizontal combination logo on a plain white background: the attached
illustration on the left, and the single word "Walkmate" on the right, set in a
clean geometric sans-serif with rounded letterforms, semibold weight, dark slate
navy color. The illustration is about 1.5 times the height of the text. Keep the
illustration unchanged. Only that one word, nothing else.
```

이미지 모델의 글자는 자간·획이 불안정하다. 생성 결과는 배치·비율 시안으로만 쓰고, 최종
워드마크는 벡터 툴에서 실제 폰트(Poppins SemiBold 기준)로 직접 조판한다.

### 7.6 단순화 심볼 (메인 일러스트 확정 후)

확정된 일러스트를 첨부해서 생성한다(Nano Banana 이미지 편집, FLUX Kontext 등).

```
Simplify the attached illustration into a bold app-icon symbol. Keep only the
two duck silhouettes, the larger teal mother duck in front and the smaller
violet-indigo duckling behind her, in the same arrangement. Remove the backdrop,
ground, footprints, wings and other small details. Use one flat tone per duck,
keep the beaks as tiny amber shapes, plain white background. Make every shape
thick and chunky so it stays legible at 16 pixels. Square 1:1 canvas, symbol
centered and filling about 80% of it.
```

### 7.7 단색 변형 (단순화 심볼 확정 후)

7.6 결과를 첨부해서 생성한다. 두 오리가 한 덩어리로 붙어 보이지 않도록 사이에 흰 간격을 둔다.

흰 배경용:

```
Recolor the attached symbol into a single color: every shape in solid dark slate
navy on a plain white background, with a thin white gap separating the two
ducks. Keep the exact same shapes and composition. Flat, one color only.
```

어두운 배경용(반전):

```
Recolor the attached symbol into a single color: every shape in solid white on a
plain dark slate navy background, with a thin dark gap separating the two ducks.
Keep the exact same shapes and composition. Flat, one color only.
```

## 8. 모델별 참고

| 모델 | 참고 |
|---|---|
| Gemini Nano Banana | 문장형 설명을 잘 따른다. 이미지 편집이 되므로 7.5~7.7에 적합하다 |
| FLUX | 네거티브 프롬프트가 없다. 7.1 꼬리의 긍정형 문장만 쓴다. 첨부 이미지 편집은 FLUX Kontext로 한다 |
| Recraft | 벡터(SVG) 출력과 컬러 팔레트 지정을 지원한다. 팔레트에 섹션 6의 hex를 직접 넣고, 벡터 일러스트 계열 스타일이 있으면 그걸 고른다. 최종 후보 다듬기에 가장 적합하다 |
| Seedream | 5.0 Lite로 두 번 시도했다. 개수 지시는 숫자로 명시하니 지켰지만, "toeless" 같은 형태 지시는 잘 안 지켰다. "pixel" 요청은 여러 톤이 섞인 모자이크로 나왔다. "deep indigo"는 짙은 남색으로 나왔다. 출력은 JPEG이고 가장자리에 얇은 회색 선이 생기는 경우가 있다 |

같은 프롬프트로 모델마다 4장 이상 뽑아 비교한다. 한 장만 보고 아이디어를 버리지 않는다.

## 9. 산출물 체크리스트

- [x] 메인 일러스트 후보 생성 (A안 첫 시안에서 바로 확정, B·C는 생성하지 않음)
- [ ] DuckDuckGo·러버덕과 혼동되지 않는지 확인
- [x] 메인 일러스트 최종 선정
- [ ] 단순화 심볼 생성 (7.6)
- [ ] SVG 벡터화 (Recraft SVG 출력, 또는 Vectorizer.ai / Illustrator Image Trace)
- [ ] 벡터에서 색을 섹션 6의 hex로 정확히 보정
- [ ] 워드마크 조합 시안 생성 → 실제 폰트로 직접 조판
- [ ] 단색 변형 2종 (흰 배경 / 어두운 배경 반전)
- [ ] 단순화 심볼의 파비콘 크기(16·32px) 가시성 확인
- [ ] GitHub 리포지토리 아바타(원형 크롭)에서 확인
- [ ] README 상단 배치 시안 확인 (라이트·다크 모드 둘 다)
- [ ] "Walkmate" 이름과 유사 로고의 상표·중복 검색
