import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk?version=4.0';
import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const SOURCES = [['both', 'PC와 휴대폰'], ['pc', 'PC 카카오톡만'], ['phone', '휴대폰(GSConnect)만']];

export default class NotciPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const page = new Adw.PreferencesPage({title: 'notci', icon_name: 'preferences-system-symbolic'});
        window.add(page);

        const kakao = new Adw.PreferencesGroup({title: '카카오톡',
            description: '메시지가 오면 노치가 잠시 펼쳐져 보낸 사람과 내용을 보여 줍니다.'});
        page.add(kakao);
        const kakaoEnabled = new Adw.SwitchRow({title: '카카오톡 알림 표시'});
        settings.bind('kakao-enabled', kakaoEnabled, 'active', Gio.SettingsBindFlags.DEFAULT);
        kakao.add(kakaoEnabled);
        const source = new Adw.ComboRow({title: '메시지 출처', model: new Gtk.StringList({strings: SOURCES.map(([, label]) => label)})});
        source.selected = Math.max(0, SOURCES.findIndex(([value]) => value === settings.get_string('kakao-source')));
        source.connect('notify::selected', () => settings.set_string('kakao-source', SOURCES[source.selected][0]));
        kakao.add(source);
        const body = new Adw.SwitchRow({title: '메시지 내용 표시', subtitle: '끄면 보낸 사람 이름만 보입니다.'});
        settings.bind('kakao-show-body', body, 'active', Gio.SettingsBindFlags.DEFAULT);
        kakao.add(body);
        const seconds = new Adw.SpinRow({title: '표시 시간(초)', adjustment: new Gtk.Adjustment({lower: 2, upper: 15, step_increment: 1})});
        settings.bind('kakao-seconds', seconds, 'value', Gio.SettingsBindFlags.DEFAULT);
        kakao.add(seconds);

        const spotify = new Adw.PreferencesGroup({title: 'Spotify',
            description: '재생 중에는 앨범 아트와 파형이 작게 보이고, 곡이 바뀌면 잠시 펼쳐집니다.'});
        page.add(spotify);
        const spotifyEnabled = new Adw.SwitchRow({title: 'Spotify 재생 정보 표시'});
        settings.bind('spotify-enabled', spotifyEnabled, 'active', Gio.SettingsBindFlags.DEFAULT);
        spotify.add(spotifyEnabled);
        const peek = new Adw.SpinRow({title: '곡 변경 때 펼치는 시간(초)', adjustment: new Gtk.Adjustment({lower: 1, upper: 10, step_increment: 1})});
        settings.bind('spotify-peek-seconds', peek, 'value', Gio.SettingsBindFlags.DEFAULT);
        spotify.add(peek);
        const accent = new Adw.SwitchRow({title: '앨범 색 사용', subtitle: '파형·아티스트·진행 막대에만 쓰이고 배경은 늘 검정입니다.'});
        settings.bind('spotify-accent', accent, 'active', Gio.SettingsBindFlags.DEFAULT);
        spotify.add(accent);

        const audio = new Adw.PreferencesGroup({title: '오디오·주변기기',
            description: '헤드셋이나 USB 기기가 연결되면 잠시 펼쳐지고, 오디오 기기는 연결 중 작은 알약으로 남습니다. 카드에서 출력 장치와 EasyEffects 프리셋을 바꿉니다.'});
        page.add(audio);
        const audioEnabled = new Adw.SwitchRow({title: '기기 연결 표시'});
        settings.bind('audio-enabled', audioEnabled, 'active', Gio.SettingsBindFlags.DEFAULT);
        audio.add(audioEnabled);
        const toast = new Adw.SpinRow({title: '연결 카드 표시 시간(초)', adjustment: new Gtk.Adjustment({lower: 1, upper: 10, step_increment: 1})});
        settings.bind('audio-toast-seconds', toast, 'value', Gio.SettingsBindFlags.DEFAULT);
        audio.add(toast);
        const usb = new Adw.SwitchRow({title: 'USB 마우스·키보드 알림', subtitle: '꽂거나 뽑을 때만 카드가 뜨고 알약은 생기지 않습니다.'});
        settings.bind('audio-usb', usb, 'active', Gio.SettingsBindFlags.DEFAULT);
        audio.add(usb);
        const easyeffects = new Adw.SwitchRow({title: 'EasyEffects 프리셋 표시', subtitle: 'Flatpak 설치본(com.github.wwmm.easyeffects)의 출력 프리셋입니다.'});
        settings.bind('audio-easyeffects', easyeffects, 'active', Gio.SettingsBindFlags.DEFAULT);
        audio.add(easyeffects);
        const autostart = new Adw.SwitchRow({title: 'EasyEffects 자동 실행', subtitle: '꺼져 있으면 창 없이 서비스로 띄운 뒤 프리셋을 적용합니다.'});
        settings.bind('audio-easyeffects-autostart', autostart, 'active', Gio.SettingsBindFlags.DEFAULT);
        audio.add(autostart);

        const extras = new Adw.PreferencesGroup({title: 'AI 답변·다운로드',
            description: '다른 창에서 일하는 동안 Claude·ChatGPT 답변이 끝나면 작은 캐릭터가 튀어나오고, 그 앱으로 돌아가면 들어갑니다. 0.7 GB 이상 다운로드는 진행률 알약으로 보입니다.'});
        page.add(extras);
        const agent = new Adw.SwitchRow({title: 'AI 답변 완료 캐릭터', subtitle: '주황은 Claude, 하늘색은 ChatGPT입니다.'});
        settings.bind('agent-enabled', agent, 'active', Gio.SettingsBindFlags.DEFAULT);
        extras.add(agent);
        const download = new Adw.SwitchRow({title: '큰 다운로드 진행률', subtitle: '다운로드 폴더의 Firefox·Chrome 임시 파일을 봅니다. 누르면 폴더가 열립니다.'});
        settings.bind('download-enabled', download, 'active', Gio.SettingsBindFlags.DEFAULT);
        extras.add(download);
    }
}
