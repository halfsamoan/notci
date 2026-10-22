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
- `order`: Archsport 0, matci 1, notci/spotify 2, notci/kakao 3 (compact 행의 왼→오른쪽).
- 우선순위 사다리: 수동 열기 100 > 골·상태 알림 80 > 카카오톡 메시지 60 > Spotify 곡 변경 peek 40 > matci 자동 제안 30. 상위가 claim하면 하위 소유자의 `onYield`가 불리고, 각 모듈이 자기 항목을 다시 큐에 넣는다(공유 큐 없음).

## 배치 (`dockModel.layoutIsland`)

- 펼친 소유자(`expanded && active`)가 있으면 그 모듈만 보이고 섬 폭·높이는 소유자 값(모니터 폭 − 24로 클램프).
- 없으면 보이는 compact 모듈을 `order`순으로 한 행에 놓는다. compact 폭은 8px 스냅(`SNAP`), 간격 `spacing.compactGap`(12), 높이는 가장 큰 모듈. 행이 모니터에 안 들어가면 active(없으면 첫째)만 남긴다.
- 모니터 그룹당 slab 1개. `onPlacement({x, y, width, height, expanded, shown})`로 자기 슬롯을 알 수 있다.

## 표면과 모션

- `#000` 불투명, lift 0, 1px 흰 8% 키라인(귀·옆·아래). notci가 켜져 있는 동안 상단 패널도 `Main.panel` 인라인 스타일로 `#000`(disable 시 복원, 잠금 화면은 user 세션 모드라 영향 없음). 오목 귀 6→14, 아래 반경 22(36px compact에서는 16). 그림자 없음.
- slab morph 240/185ms `cubic-bezier(.2,.8,.2,1)`, 세로 seed 104×6에서 자람. 모듈이 들어오고 나갈 때 코어가 content를 100ms 크로스페이드. 접힐 때만 콘텐츠 크기 맞춤을 100ms 미룬다. `enable-animations=false`면 즉시.
- 바깥 좌·우클릭은 소유자의 `onOutside`(캡처 단계, 이벤트는 전달).

## 크기 티어 (`DESIGN.geometry`)

| 모듈 | compact | expanded |
|---|---|---|
| Archsport | 200×36 | 344(라이브) / 464(일정·문맥) × 측정 140–480 |
| matci | 없음(패널만) | 368 × 측정 |
| notci/spotify | 56×36 (아트 20 + 4바) | 464 × 측정(≈144; 카드 인셋 10/16/10, 컨트롤 32) |
| notci/kakao | 없음 | 464 × 측정(2줄 ≈92, 1줄 ≈76) |

알림 시간: 골 6s(`event-seconds`), 카카오톡 5s(`kakao-seconds`), Spotify peek 3s(`spotify-peek-seconds`), Spotify 수동 펼침은 8s 유휴 후 접힘; hover 중 정지, 이탈 100ms 후 재개; 다음 알림은 300ms 뒤.

닫는 방법(모든 카드 공통): 섬 바깥 좌·우클릭, Esc(포커스가 섬 안일 때). Spotify는 compact 알약 클릭이 토글이고 카드의 빈 곳(제목·아티스트·여백)을 클릭해도 접힌다. 카카오톡 카드는 클릭하면 카카오톡 창을 앞으로 가져오고 접힌다.

## 검증

- 순수 모델: 각 저장소 `node --test tests/*.mjs`.
- 격리 셸 캡처: `~/workspace/arch/ux-tools/harness.py start`(1728×972, 세 확장 설치) → `scene.py arch|matci|notci …` → `harness.py stop`. 한 번에 셸 하나, 캡처 직후 stop.
- 실세션: 세 확장을 같은 로그인에 적용한 뒤 `gnome-extensions info`로 버전·ACTIVE, `journalctl --user -b -g notchDock`에 "source differs" 없음.
