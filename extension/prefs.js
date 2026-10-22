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
    }
}
