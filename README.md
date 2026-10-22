# notci

Ubuntu GNOME 50 상단 패널 아래의 Dynamic Island 노치에 **카카오톡 메시지 미리보기**와 **Spotify 재생 정보**를 더하는 GNOME Shell 확장입니다. [Archsport](https://github.com/halfsamoan/archsport)(축구)·[matci](https://github.com/halfsamoan/matci)(메모리)와 같은 섬 코어를 공유해, 네 카테고리가 한 덩어리 검정 섬 안에서 카테고리별 크기로 변형됩니다.

## 동작

- **Spotify**: 재생 중이면 섬 오른쪽에 앨범 아트(20px)와 파형 4개가 작게 보입니다. 곡이 바뀌면 3초 동안 펼쳐져 아트·제목·아티스트·진행 막대·이전/재생/다음을 보여 주고, 작은 알약을 누르면 펼치고 다시 누르거나 카드의 빈 곳을 누르면 접힙니다(8초 동안 가만두면 저절로 접힘). 앨범 색은 파형·아티스트·진행 막대에만 쓰이고 배경은 늘 검정입니다.
- **카카오톡**: 메시지가 오면 5초 동안 카드(464×96)가 펼쳐집니다. 보낸 사람·내용(두 줄)·프로필 사진, 노란 말풍선 배지. 마우스를 올리면 유지되고, 누르면 카카오톡 창을 앞으로 가져오며, 바깥 클릭이나 Esc로 닫습니다. 출처는 둘입니다.
  - 휴대폰(GSConnect): `gnome-extensions enable gsconnect@andyholmes.github.io` 후 휴대폰 KDE Connect와 페어링하고 알림 동기화에서 카카오톡을 허용합니다. 카카오톡은 PC 클라이언트를 쓰는 동안 휴대폰 알림을 3~10분 보류하므로, PC 카톡이 활성일 때는 아래 경로가 담당합니다.
  - PC 카카오톡(Wine): 카카오톡 PC는 D-Bus 알림을 내지 않고 자체 팝업 창을 그립니다. notci는 `desktop-entry=wine-Programs-카카오톡` 힌트가 붙은 `org.freedesktop.Notifications` 알림을 PC 메시지로 받습니다(`notify-send -a KakaoTalk -h string:desktop-entry:wine-Programs-카카오톡 '보낸이' '내용'`으로 시험 가능). 팝업 창을 감지해 보낸 사람·내용을 이 형식으로 전달하는 Wine 쪽 브리지(`kakaotalk-compat`의 `kakao-activate.exe`)는 `--probe`로 팝업의 창 클래스·크기·접근성 텍스트를 먼저 기록한 뒤(`~/.cache/notci@local/probe.log`) 그 결과에 맞춰 `--watch`에 붙입니다. 텍스트를 읽을 수 없으면 팝업 창 자체를 섬 안에 비추는 경로(`POPUP_FINGERPRINT`)를 켭니다.

notci가 켜져 있는 동안 상단 패널도 섬과 같은 `#000`이 되어 한 덩어리로 보입니다(끄면 테마 색으로 돌아갑니다).

## 프라이버시

- 카카오톡의 로컬 데이터베이스·프로세스 메모리·화면 캡처(OCR)는 읽지 않습니다. 카카오톡이 스크린리더에 스스로 노출하는 텍스트만 씁니다.
- 전달 경로는 로컬 세션 버스뿐이며 네트워크로 나가지 않습니다. 임시 파일은 `~/.cache/notci@local`(0700)에서 즉시 삭제됩니다.
- 메시지 본문·보낸 사람은 로그에 남기지 않습니다. 설정에서 "메시지 내용 표시"를 끄면 이름만 보입니다.
- 잠금 화면에서는 확장이 내려가므로(`session-modes: user`) 본문이 노출되지 않습니다.

## 설치·검증

```bash
python3 tools/install_extension.py            # 최초 설치
python3 tools/install_extension.py --upgrade  # 다음 로그인에 적용되는 스테이징
gnome-extensions enable notci@local
```

검사: `node --test tests/*.mjs`, `python3 tools/build_design.py --check`, `python3 tools/check_shared_design.py`, `glib-compile-schemas --strict --dry-run extension/schemas`.

Archsport·matci와 같은 섬 코어(`DOCK_PROTOCOL` 7)를 쓰는 버전이 함께 설치돼 있어야 한 섬을 이룹니다(Archsport v26+, matci v24+).
