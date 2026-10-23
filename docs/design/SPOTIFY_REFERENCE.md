# Spotify 모듈 — 다음 모듈이 따르는 디자인 기준 (notci v5 코드 실측, 2026-10-23)

사용자가 확정한 디자인이다. 이 문서는 변경 금지 장치가 아니라 **새 모듈을 만들 때 그대로 따라야 할 수치·상태·모션의 기록**이다. 값은 전부 코드에서 읽었고 줄 번호는 v5(`3006e5b`) 기준이다. `docs/design/design-tokens.json`은 아래에서 `tokens.json`으로 적는다.

## 두 상태

| 상태 | 크기 | 내용 |
|---|---|---|
| compact 알약 | 슬롯 56×36 (`tokens.json` `geometry.spotifyCompact`, `control.compactHeight`) | 아트 20px(radius 4) + 파형 4개(3×12, 간격 1). 클릭 = 토글 (`spotify.js:458-469`) |
| 카드 (peek와 수동 펼침이 같은 화면) | 폭 464 (`geometry.expandedWide`), 높이는 `ensure_style` → `get_preferred_height(464)` 실측 ≈146 (`spotify.js:420-436`; 토큰 `spotifyExpandedHeight` 168은 측정 전 기본값) | 헤더(아트 64 · 제목/아티스트/앨범 · 파형) / 본문(진행 막대 → 시간 → 이전·재생·다음) (`spotify.js:471-523`) |

peek(곡 변경, claim 40, 3 s)와 수동 펼침(알약 클릭, claim 100, 8 s 유휴)은 같은 `_buildCard()`를 쓴다. 차이는 우선순위와 타이머뿐이다 (`spotify.js:89-110`).

## 치수 (CSS: `extension/stylesheet.css.in`)

| 요소 | 값 | 줄 |
|---|---|---|
| 알약 `.notci-compact-module` | min-height 28, padding 0 6, radius 14, hover `hoverWash`, focus 2px `focus` 링 | 7–10 |
| 카드 `.notci-card` | padding **10/16/12**, spacing 6 (22px 슬랩 모서리와 동심) | 13 |
| 행·열 | `.notci-card-row` spacing 12, `.notci-card-column` spacing 2 | 14–15 |
| 제목 `.notci-title` | 14px / 600 / `labelPrimary` | 16 |
| 보조 `.notci-accent-text` | 13px / 500 / 기본 `labelSecondary`(Spotify는 앨범색으로 덮음) | 20 |
| 캡션 `.notci-caption` | 11px / 500 / `labelSecondary`, 숫자는 `.notci-tnum` | 19, 21 |
| 컨트롤 `.notci-control` | 32×32 radius 16, hover `hoverWash`, insensitive `labelTertiary` | 26–30 |
| 아트 | compact 20 radius 4 / 카드 64 radius 12, 배경 `surfaceTrack`, cover | 34–35 |
| 파형 | `.notci-bars` 높이 12 spacing 1, `.notci-bar` 3×12 radius 1.5 | 36–37 |
| 재생 버튼 `.notci-spotify-play` | 28 흰 원(`labelPrimary`) + 검은 아이콘 16 | 38 |
| 진행 막대 | track/fill 4px radius 2 | 39–40 |
| 컨트롤 간격 `.notci-controls` | 8, 가운데 정렬 | 41 |
| 아이콘 | skip 20 / play 16 / 아트 대체 16 (`ICON_*`) | `spotify.js:34-36` |

px 글자 크기는 `tools/build_design.py`가 ×0.75 pt로 바꿔 GNOME 큰 글씨 설정을 따른다.

## 색

- 배경은 항상 `#000`: 슬랩(`notchSurface.js`), 모듈 투명(`css.in:2`), 패널(`extension.js:21`).
- 악센트(앨범색)는 **파형·아티스트·진행 fill 세 곳만** (`spotify.js:576, 581, 583`). 제목·캡션·컨트롤·아트 배경에는 쓰지 않는다.
- 추출: 8×8 디코드 → 채도×밝기 최대 픽셀 → 검정 대비 4.5:1까지 보정, 채도 <0.25면 `brandSpotify` (`spotifyModel.js:38-60`, `spotify.js:304-322`).

## 모션 (토큰은 `tokens.json` `motion`)

| 순간 | 값 | 줄 |
|---|---|---|
| 슬랩 morph | 펼침 240 / 접힘 185, curve (.2,.8,.2,1), 104×6 seed | 코어 `notchDock.js` |
| 카드 열림 | header `primaryDuration` 185·`primaryDelay` 60, body `secondaryDuration` 180·`secondaryDelay` 90, `contentShift` 3px 위에서 내려옴 | `spotify.js:438-452` |
| 카드 닫힘 | 자식 반응·포커스 끔 → `micro` 100 페이드 → `update(compact)` → 100ms 뒤 compact 재구성이 185로 등장 | `spotify.js:391-410, 445` |
| 파형 | scale-y 0.3↔1.0, 420/560/380/500ms 왕복, `EASE_IN_OUT_SINE` 곡선, 피벗 (0.5, 1); 정지·미표시·전체화면·잠금·모션 꺼짐이면 `BAR_PAUSED` 0.4/0.75/1.0/0.6으로 고정. **v8부터 약 15 fps 타이머(`BAR_FRAME_MS` 66)로 scale-y를 직접 설정**한다. 예전 `Clutter.PropertyTransition`(무한 반복)은 화면 주사율(120 Hz)마다 셸 전체를 다시 그려 재생 중 gnome-shell CPU를 코어의 약 12% 더 썼다(2026-10-23 실측). 모양·곡선·주기는 같고 갱신 횟수만 줄였다 | `spotify.js` `_updateBars` |
| hover | 타이머 정지, 이탈 `hoverResume` 100ms 뒤 잔여 시간으로 재개 | `spotify.js:346-358` |

`St.Settings.enable_animations`가 꺼지면 페이드·등장을 생략하고 즉시 재구성한다.

## 동작

- 알약 클릭 = 토글, 큰 아트 클릭 = Spotify 열기, 카드 빈 곳(제목·아티스트·여백) 클릭 = 접힘(`global.stage.get_event_actor`, GNOME 50은 `get_source()`가 null) (`spotify.js:476-485`).
- 바깥 좌·우클릭, 다른 창으로 포커스 이동, Esc(포커스가 안에 있을 때), overview 진입, 상위 우선순위의 claim(`onYield`) → 접힘.
- 일시정지해도 접지 않는다. 파형만 멈춘다.
- 섬 안 위치 `order: 2`.

## 구조

- 순수 모델(`spotifyModel.js`, GI import 없음, `node --test`) + GJS 뷰(`spotify.js`).
- 타이머는 `TIMERS` 배열로 일괄 해제. `destroy()`: 타이머·시그널·cancellable → `dock.destroy()` → `focus_manager.remove_group` → `_shellEnding`이 아니면 `root.destroy()`.
- 크기는 모듈이 측정해 `dock.update({width, height, visible, expanded})`로 넘긴다. 코어가 8px 스냅·모니터 클램프·크로스페이드를 맡는다.

## 새 모듈이 지킬 것

1. 위 공유 클래스(`.notci-card`, `-row`, `-column`, `.notci-title`, `.notci-caption`, `.notci-accent-text`, `.notci-control`, `.notci-compact-module`)의 값을 바꾸지 않는다. 필요한 모양은 **자기 클래스를 새로 추가**해서 만든다.
2. 공유 토큰(`geometry.*`, `control.compactHeight`, `motion.*`, 색·글꼴)을 바꾸지 않는다. 새 토큰이 꼭 필요하면 세 저장소 동시 변경·버전 동시 상향이다(`ISLAND.md`).
3. compact 높이는 36을 넘기지 않는다(행 높이가 가장 큰 모듈을 따라가 Spotify 알약까지 커진다).
4. 열림·닫힘 연출과 hover 규칙은 `spotify.js:379-456`을 그대로 옮긴다. audio 모듈이 그렇게 했다.
