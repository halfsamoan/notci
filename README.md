# notci

Ubuntu GNOME 50 상단 패널 아래의 Dynamic Island 노치에 **카카오톡 메시지 미리보기**와 **Spotify 재생 정보**를 더하는 GNOME Shell 확장입니다. [Archsport](https://github.com/halfsamoan/archsport)(축구)·[matci](https://github.com/halfsamoan/matci)(메모리)와 같은 섬 코어를 공유해, 네 카테고리가 한 덩어리 검정 섬 안에서 카테고리별 크기로 변형됩니다.

## 동작

- **Spotify**: 재생 중이면 섬 오른쪽에 앨범 아트(20px)와 파형 4개가 작게 보입니다. 곡이 바뀌면 3초 동안 펼쳐져 아트·제목·아티스트·진행 막대·이전/재생/다음을 보여 주고, 작은 알약을 누르면 펼치고 다시 누르거나 카드의 빈 곳을 누르면 접힙니다(8초 동안 가만두면 저절로 접힘). 앨범 색은 파형·아티스트·진행 막대에만 쓰이고 배경은 늘 검정입니다.
- **카카오톡**: 메시지가 오면 5초 동안 카드(464×96)가 펼쳐집니다. 보낸 사람·내용(두 줄)·프로필 사진, 노란 말풍선 배지. 마우스를 올리면 유지되고, 누르면 카카오톡 창을 앞으로 가져오며, 바깥 클릭이나 Esc로 닫습니다. 출처는 둘입니다.
  - 휴대폰(GSConnect): `gnome-extensions enable gsconnect@andyholmes.github.io` 후 휴대폰 KDE Connect와 페어링하고 알림 동기화에서 카카오톡을 허용합니다. 카카오톡은 PC 클라이언트를 쓰는 동안 휴대폰 알림을 3~10분 보류하므로, PC 카톡이 활성일 때는 아래 경로가 담당합니다.
  - PC 카카오톡(Wine): 카카오톡 PC는 D-Bus 알림을 내지 않고 자체 팝업 창을 그립니다. notci는 `desktop-entry=wine-Programs-카카오톡` 힌트가 붙은 `org.freedesktop.Notifications` 알림을 PC 메시지로 받습니다(`notify-send -a KakaoTalk -h string:desktop-entry:wine-Programs-카카오톡 '보낸이' '내용'`으로 시험 가능). 팝업 창을 감지해 보낸 사람·내용을 이 형식으로 전달하는 Wine 쪽 브리지(`kakaotalk-compat`의 `kakao-activate.exe`)는 `--probe`로 팝업의 창 클래스·크기·접근성 텍스트를 먼저 기록한 뒤(`~/.cache/notci@local/probe.log`) 그 결과에 맞춰 `--watch`에 붙입니다. 텍스트를 읽을 수 없으면 팝업 창 자체를 섬 안에 비추는 경로(`POPUP_FINGERPRINT`)를 켭니다.

notci가 켜져 있는 동안 상단 패널도 섬과 같은 `#000`이 되어 한 덩어리로 보입니다(끄면 테마 색으로 돌아갑니다).

- **오디오 기기·EasyEffects**: 블루투스 헤드셋(WH-1000XM5 등)이나 USB 오디오·마우스·키보드가 연결되면 카드(464×≈88)가 4초 펼쳐져 이름·코덱·배터리를 보여 줍니다. 외장 오디오 기기와 배터리를 보고하는 기기는 연결 중 작은 알약(아이콘 + 배터리 링)으로 남습니다. 연결 순간 링이 0에서 현재 배터리까지 차오릅니다. 배터리가 20% 아래로, 다시 10% 이하로 내려가는 순간 작은 섬의 링이 2초 동안 두 번 숨 쉬듯 깜빡입니다(25% 이상이 되면 다시 알릴 수 있음). 알약을 누르면 카드에서 **출력 장치**(Shell 볼륨 메뉴와 같은 목록)와 **EasyEffects(Flatpak) 출력 프리셋**을 칩으로 고릅니다. EasyEffects가 꺼져 있으면 창 없이 서비스로 띄운 뒤 적용합니다(설정에서 끌 수 있음). 프리셋이 실제로 들리려면 EasyEffects의 "모든 출력 스트림 처리"(`processAllOutputs`)가 켜져 있어야 하므로 notci가 EasyEffects를 띄울 때 이 설정을 켭니다. 코덱은 PipeWire 카드 프로파일에서, 배터리는 UPower에서 읽으며, 노트북 내장 카드·웹캠·지문 장치는 알리지 않습니다.
- **AI 답변 완료 캐릭터**: Claude·ChatGPT 데스크톱 앱 창이 뒤에 있는 동안 답변(채팅·코드 작업)이 끝나면 작은 섬 아래에서 픽셀 캐릭터가 튀어나와 불꽃 머리로 짧게 두 번 뛰고, 그 뒤엔 끝난 앱 창 쪽을 힐끗 보고 깜빡이며 기다립니다(오래 기다릴수록 덜 움직임). 주황은 Claude, 하늘색은 ChatGPT입니다. 그 앱으로 돌아가거나 알약을 누르면(창이 앞으로 옴) 들어갑니다. 앱이 보내는 창 주의 요청·알림을 쓰므로 앱 쪽 알림 설정이 꺼져 있으면 뜨지 않습니다.
- **큰 다운로드**: 다운로드 폴더에 0.7 GB 이상 받는 파일이 있으면 알약(아이콘 + 링 + %)이 생깁니다. Firefox는 전체 크기를 알아 %를, Chrome은 전체 크기를 알 수 없어 받은 양(GB)을 보여 줍니다. 10초 멈추면 주황, 끝나면 초록 링 2초 뒤 사라집니다. 누르면 다운로드 폴더가 열립니다.

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
