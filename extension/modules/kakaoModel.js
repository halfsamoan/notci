// Pure KakaoTalk notification logic: no GI imports so node can test it.

const KAKAO_APP_ID = 'wine-Programs-카카오톡.desktop';
const KAKAO_TITLES = ['카카오톡', 'KakaoTalk'];
const KEY_MAX = 200;

export function classifyNotification({sourceTitle, appId, id, title, forFeedback}) {
    if (sourceTitle === 'GSConnect' && (/\|com\.kakao\.talk\|/.test(id ?? '') || KAKAO_TITLES.includes(title)))
        return {source: 'phone'};
    if (appId === KAKAO_APP_ID) return {source: forFeedback ? 'pc-attention' : 'pc'};
    return null;
}

// GSConnect body: "보낸이: 내용" or "방이름: 보낸이: 내용".
export function parseGsconnectBody(body) {
    // ponytail: ': ' inside the message text itself makes a 1:1 message look like a group
    // one (first chunk becomes the room); GSConnect carries no structured fields to disambiguate.
    const parts = (body ?? '').split(': ');
    if (parts.length >= 3) return {room: parts[0], sender: parts[1], text: parts.slice(2).join(': ')};
    if (parts.length === 2) return {room: null, sender: parts[0], text: parts[1]};
    return {room: null, sender: null, text: parts[0]};
}

export function parseFdoMessage(summary, body) {
    return {sender: summary ?? '', text: body ?? ''};
}

// Window-attention body looks like “방이름” is ready.
export function parseAttentionBody(body) {
    const match = /[“"]([^”"]+)[”"]/.exec(body ?? '');
    return match ? match[1] : null;
}

export function messageEvent({source, sender = null, room = null, text = '', ts = Date.now(),
    hasIcon = false, canReply = false}) {
    const key = `${source}|${sender ?? ''}|${text}`.slice(0, KEY_MAX);
    const score = (text ? 2 : 0) + (hasIcon ? 1 : 0) + (canReply ? 1 : 0);
    return {source, sender, room, text, ts, hasIcon, canReply, key, score};
}

function sameParty(a, b) {
    if (a.sender && b.sender) return a.sender === b.sender;
    return Boolean(a.room) && a.room === b.room;
}

const empty = value => value === null || value === undefined || value === '' || value === false;

// The same message often arrives twice (PC attention + text bridge, or phone + PC): fold
// it into one card. The richer side wins; ties go to the newer event.
export function mergeEvents(queue, incoming, now = Date.now(), windowMs = 10000) {
    const index = queue.findIndex(event => Math.abs(now - event.ts) <= windowMs && sameParty(event, incoming));
    if (index < 0) return enqueueEvent(queue, incoming);
    const existing = queue[index];
    const [rich, poor] = incoming.score >= existing.score ? [incoming, existing] : [existing, incoming];
    const merged = {...rich};
    for (const [field, value] of Object.entries(poor)) {
        if (empty(merged[field])) merged[field] = value;
    }
    queue[index] = merged;
    return queue;
}

export function enqueueEvent(queue, event) {
    if (!queue.some(item => item.key === event.key)) queue.push(event);
    return queue;
}

export function expireEvents(queue, now = Date.now(), ttlMs = 60000) {
    for (let index = queue.length - 1; index >= 0; index--) {
        const ts = queue[index]?.ts;
        if (!Number.isFinite(ts) || ts > now || now - ts > ttlMs) queue.splice(index, 1);
    }
    return queue;
}

export function takeEvent(queue, claim, now = Date.now()) {
    expireEvents(queue, now);
    if (!queue.length || !claim()) return null;
    return queue.shift();
}

export function displayText(event, showBody = true) {
    const primary = event.sender || event.room || '카카오톡';
    const secondary = showBody && event.text ? event.text : '새 메시지';
    const caption = event.room && event.room !== primary ? `카카오톡 · ${event.room}` : '카카오톡';
    return {primary, secondary, caption};
}
