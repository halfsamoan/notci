# notci contributor instructions

- 한국어로 응답한다. 커밋 메시지와 문서도 한국어.
- notci는 Archsport·matci와 **하나의 Dynamic Island 노치**를 공유하는 세 번째 확장이다. 공유 코어 5파일(`docs/design/design-tokens.json`, `extension/{designTokens,dockModel,notchDock,notchSurface}.js`)은 세 저장소에서 바이트 동일해야 하며 `python3 tools/check_shared_design.py`가 검사한다. 코어를 고칠 때는 `ux/archsport`에서 고친 뒤 matci·notci에 복사하고 세 버전을 함께 올린다.
- 모듈 계약: `new XModule({settings, uuid, path, cacheDir})` → `root`(St.BoxLayout, `notci-module`), `collapse()`, `destroy()`. 모듈은 `DockParticipant({id: `${uuid}/<name>`, content: this.root, order, monitor, triggerActor, onOutside, onYield, onShellShutdown})`로 섬에 참여하고 `claim(priority)`/`update({width, height, visible, expanded})`만 호출한다. 우선순위 사다리: 수동 100 > 골 80 > 카카오톡 60 > Spotify peek 40 > matci 제안 30.
- 배경은 항상 검정이다. 색은 파형·보조 글자·배지에만 쓴다(`DESIGN.color.*`). 크기는 `DESIGN.geometry.*`·`DESIGN.control.compactHeight`에서 가져오고 하드코딩하지 않는다.
- 카카오톡 본문·보낸 사람을 로그에 남기지 않는다. 카카오톡 로컬 DB·메모리·화면 캡처(OCR)를 읽지 않는다. 임시 파일은 `~/.cache/notci@local`(0700)에만.
- 앨범 아트는 `~/.cache/notci@local/art.jpg` 한 파일만 덮어쓴다(St 텍스처 캐시가 파일별로 영구 보관). 풀사이즈 pixbuf를 JS에 보관하지 않는다.
- GNOME 50 Shell 전용. `ease()`를 무한 반복 애니메이션에 쓰지 않는다(`Clutter.PropertyTransition`). 노치가 보이지 않거나 전체화면·잠금이면 애니메이션을 멈춘다.
- 검증: `node --test tests/*.mjs`, `npx --yes eslint@9 --no-config-lookup -c eslint.config.mjs --max-warnings 0 'extension/**/*.js'`, `glib-compile-schemas --strict --dry-run extension/schemas`, `python3 tools/build_design.py --check`, `python3 tools/check_shared_design.py`. Node 검사는 GJS 호환성 증거가 아니다. 실제 GNOME 검수를 하지 않은 항목을 통과로 적지 않는다.
- 설치: `python3 tools/install_extension.py` (최초) / `--upgrade` (스테이징, 다음 로그인 적용). 런타임을 바꾸면 `metadata.json`의 정수 `version`을 올린다.
