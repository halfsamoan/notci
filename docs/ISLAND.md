# 하나의 섬(island) 계약 — Archsport · matci · notci

세 확장은 상단 패널 아래에 **slab 하나**를 공유한다. slab은 공유 코어가 그리고, 각 확장(모듈)은 내용·크기·우선순위만 제공한다. 이 문서는 세 저장소에 같은 내용으로 둔다.

## 공유 코어 (바이트 동일 5파일)

`docs/design/design-tokens.json`, `extension/designTokens.js`, `extension/dockModel.js`, `extension/notchDock.js`, `extension/notchSurface.js`. `python3 tools/check_shared_design.py`가 형제 디렉터리(`ux/<repo>`) 또는 GitHub 같은 이름 브랜치와 비교한다. 코어는 `ux/archsport`에서 고치고 나머지 둘에 복사한다. `DOCK_PROTOCOL`(현재 7)은 레지스트리 키 `_notchIslandDock_v7`에 들어가므로, 번호가 다른 빌드는 서로 다른 섬을 만든다 → 세 확장을 **같은 로그인에서 함께** 올린다. 같은 번호인데 소스가 다르면 `layoutSourceHash` 경고만 난다.

## 참가자 API

```js
new DockParticipant({id, content, monitor, order, triggerActor, onOutside, onYield, onPlacement, onShellShutdown})
participant.claim(priority)                   // 섬 소유권. 같은 우선순위면 나중 claim이 이김
participant.update({width, height, visible, expanded})
participant.destroy()
```

- `content`는 모듈의 루트 `St.BoxLayout`(`reactive:false, can_focus:false, clip_to_allocation:true`). 코어가 생성 시점에 숨긴 채 slab holder에 붙이므로 `ensure_style`·`get_preferred_height` 측정이 스테이지 위에서 된다. 코어는 content를 **절대 destroy하지 않는다**(모듈이 `dock.destroy()` 뒤에 직접).
- `order`: Archsport 0, matci 1, notci/spotify 2, notci/kakao 3, notci/audio 4, notci/agent 5, notci/download 6 (compact 행의 왼→오른쪽). agent·download는 claim하지 않는 compact 전용 모듈이라 사다리에 없다.
- 우선순위 사다리: 수동 열기 100 > 골·상태 알림 80 > 카카오톡 메시지 60 > 오디오 기기 연결 토스트 50 > Spotify 곡 변경 peek 40 > matci 자동 제안 30. 상위가 claim하면 하위 소유자의 `onYield`가 불리고, 각 모듈이 자기 항목을 다시 큐에 넣는다(공유 큐 없음).

## 배치 (`dockModel.layoutIsland`)

- 펼친 소유자(`expanded && active`)가 있으면 그 모듈만 보이고 섬 폭·높이는 소유자 값(모니터 폭 − 24로 클램프).
- 없으면 보이는 compact 모듈을 `order`순으로 한 행에 놓는다. compact 폭은 8px 스냅(`SNAP`), 간격 `spacing.compactGap`(12), 높이는 가장 큰 모듈. 행이 모니터에 안 들어가면 active(없으면 첫째)만 남긴다.
- 모니터 그룹당 slab 1개. `onPlacement({x, y, width, height, expanded, shown})`로 자기 슬롯을 알 수 있다.

## 표면과 모션

- `#000` 불투명, lift 0, 1px 흰 8% 키라인(귀·옆·아래). notci가 켜져 있는 동안 상단 패널도 `Main.panel` 인라인 스타일로 `#000`(disable 시 복원, 잠금 화면은 user 세션 모드라 영향 없음). 오목 귀 6→14, 아래 반경 22(36px compact에서는 16). 그림자 없음.
- 클릭 영역(귀를 뺀 본체 + 둥근 아래)은 `notchSurface.js`의 `NotchLayout`(`Clutter.LayoutManager`)이 할당 중에 직접 배치한다. notify::width·style-changed에서 margin/width를 바꾸면 할당 도중 relayout이 다시 걸려 morph마다 "needs an allocation" 경고가 약 40건씩 났다(v31에서 0건).
- slab morph는 감쇠 스프링(`dockModel.SPRING_OPEN` 응답 0.44 s·감쇠 0.78 → 약 2.5% 이내로 넘쳤다 505 ms에 정착, `SPRING_CLOSE` 0.31 s·1.0 → 넘침 없이 363 ms). 완전히 닫힐 때는 마지막 `SLAB_FADE_MS`(110 ms) 동안 slab이 투명해지고, 높이 36 미만에서는 귀·모서리가 높이에 비례해 줄어 끝까지 둥근 물방울로 패널에 들어간다(v32까지는 10 px 이하를 직사각형으로 그려 닫힘 끝 약 90 ms가 네모 막대로 보였다). Mutter 50의 GJS에서는 Clutter 진행 함수(`set_progress_func`)가 호출만 되고 반환값이 무시되므로, 스프링마다 2% 안으로 따라가는 cubic-bezier(`spring.curve`, 테스트로 고정)를 쓴다. 반복 없음, 세로 seed 104×6에서 자람. 카드가 펼쳐질 때 content도 같은 스프링으로 96%→100%(위쪽 가운데 기준) 자란다(Dynamic Island처럼 내용이 섬과 함께 커짐). 모듈이 들어오고 나갈 때 코어가 content를 100ms 크로스페이드. 접힐 때만 콘텐츠 크기 맞춤을 100ms 미룬다. `enable-animations=false`면 즉시.
- 바깥 좌·우클릭은 소유자의 `onOutside`. **수동으로 연 카드(claim ≥ 100)가 떠 있는 동안 코어가 slab에 Clutter grab을 건다**(`dockModel.needsGrab`): Wayland에서 앱 창 위 클릭은 Mutter가 먼저 처리해 stage `captured-event`에 오지 않으므로(Mutter 50 `events.c`), grab 없이는 "이미 포커스된 창"을 클릭해도 카드가 닫히지 않았다(v28까지의 버그). grab 중 바깥 클릭(어느 버튼이든)·터치 탭·Esc는 slab의 `captured-event`가 받아 카드만 닫고 **앱엔 전달되지 않는다**(GNOME 메뉴와 동일, 두 번째 클릭부터 앱으로). grab 동안 slab을 reactive로 바꿔 카드 안에 키 포커스가 있어도 Esc가 닿고, stage가 이벤트 체인에서 빠지므로 Tab/화살표 이동은 slab의 `key-press-event`에서 `focus_manager.navigate_from_event`로 처리한다(v30, 리뷰에서 키보드가 카드에 갇히는 회귀를 발견). `claim()`도 grab을 다시 맞춘다(크기가 같은 30→100 승격은 reflow가 없음). 토스트(≤ 80)는 grab 하지 않아 타이핑·클릭을 빼앗지 않으며 타이머·포커스 이동으로만 닫힌다. grab은 `reflow()`가 섬 상태에 맞춰 잡고 풀며 `shutdown`·`destroySlabs`에서 무조건 푼다.

## 크기 티어 (`DESIGN.geometry`)

| 모듈 | compact | expanded |
|---|---|---|
| Archsport | 200×36 | 344(라이브) / 464(일정·문맥) × 측정 140–480 |
| matci | 없음(패널만) | 368 × 측정 |
| notci/spotify | 56×36 (아트 20 + 4바) | 464 × 측정(≈146; 카드 인셋 10/16/12, 컨트롤 32) |
| notci/kakao | 없음 | 464 × 측정(2줄 ≈92, 1줄 ≈76) |
| notci/agent | 측정(픽셀 펫 24×28 + 앱 이름)×36 — Claude·ChatGPT 답변이 끝난 뒤 그 앱으로 돌아갈 때까지 | 없음 |
| notci/download | 측정(아이콘 16 + 링 Ø18 + 숫자, "100%"/"00.00 GB" 폭으로 고정)×36 — 0.7 GB 이상 다운로드 중 | 없음 |
| notci/audio | 측정(아이콘 16 + 배터리 링 Ø18, 링을 켠 채 1회 측정해 고정, 52 → 56)×36 — 외장 오디오·배터리 보고 기기가 연결된 동안만 | 464 × 측정(연결 토스트 ≈88, 카드 ≈220: 기기 헤더 + 출력 칩 + EasyEffects 프리셋 칩) |

알림 시간: 골 6s(`event-seconds`), 카카오톡 5s(`kakao-seconds`), 오디오 연결/해제 토스트 4s(`audio-toast-seconds`, 토스트 중 새 이벤트는 같은 카드의 글만 바꾸고 시간을 다시 잼; 상위에 양보하면 폐기 — 알약이 같은 상태를 보여준다), Spotify peek 3s(`spotify-peek-seconds`), Spotify·오디오 수동 펼침은 8s 유휴 후 접힘; hover 중 정지, 이탈 100ms 후 재개; 다음 알림은 300ms 뒤.

닫는 방법(모든 카드 공통): 섬 바깥 좌·우클릭(수동 카드는 앱 창 위 클릭 포함, 그 클릭은 앱에 안 감; 토스트는 Shell 크롬 위 클릭과 앱 창 포커스 이동만), Esc(수동 카드는 포커스 위치와 무관, 토스트는 포커스가 섬 안일 때). Spotify는 compact 알약 클릭이 토글이고 카드의 빈 곳(제목·아티스트·여백)을 클릭해도 접힌다. 오디오 카드도 같다(알약 토글, 빈 곳 클릭 접힘; 출력·프리셋 칩은 슬랩 안의 인라인 버튼이지 팝업 메뉴가 아니다 — 슬랩 밖 클릭은 바깥 클릭으로 접힌다). 카카오톡 카드는 클릭하면 카카오톡 창을 앞으로 가져오고 접힌다.

## 검증

- 순수 모델: 각 저장소 `node --test tests/*.mjs`.
- 격리 셸 캡처: `~/workspace/arch/ux-tools/harness.py start`(1728×972, 세 확장 설치) → `scene.py arch|matci|notci …` → `harness.py stop`. 한 번에 셸 하나, 캡처 직후 stop.
- 실세션: 세 확장을 같은 로그인에 적용한 뒤 `gnome-extensions info`로 버전·ACTIVE, `journalctl --user -b -g notchDock`에 "source differs" 없음.
