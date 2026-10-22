import {test} from 'node:test';
import assert from 'node:assert/strict';
import {classifyNotification, parseGsconnectBody, parseAttentionBody, messageEvent, mergeEvents,
    enqueueEvent, expireEvents, takeEvent, displayText} from '../extension/modules/kakaoModel.js';

const PC = 'wine-Programs-카카오톡.desktop';

test('classifyNotification: phone by id or title, pc, pc-attention, unrelated', () => {
    assert.deepEqual(classifyNotification({sourceTitle: 'GSConnect', appId: null, id: '0|com.kakao.talk|7',
        title: 'Something', forFeedback: false}), {source: 'phone'});
    assert.deepEqual(classifyNotification({sourceTitle: 'GSConnect', appId: null, id: null,
        title: 'KakaoTalk', forFeedback: false}), {source: 'phone'});
    assert.deepEqual(classifyNotification({sourceTitle: '카카오톡', appId: PC, id: null, title: '친구',
        forFeedback: false}), {source: 'pc'});
    assert.deepEqual(classifyNotification({sourceTitle: '카카오톡', appId: PC, id: null, title: '카카오톡',
        forFeedback: true}), {source: 'pc-attention'});
    assert.equal(classifyNotification({sourceTitle: 'GSConnect', appId: null, id: '0|com.example|1',
        title: 'Mail', forFeedback: false}), null);
    assert.equal(classifyNotification({sourceTitle: 'Firefox', appId: 'firefox.desktop', id: null,
        title: '카카오톡', forFeedback: false}), null);
});

test('parseGsconnectBody: 1:1, group, text containing ": ", empty', () => {
    assert.deepEqual(parseGsconnectBody('철수: 안녕'), {room: null, sender: '철수', text: '안녕'});
    assert.deepEqual(parseGsconnectBody('가족방: 엄마: 밥 먹었니'), {room: '가족방', sender: '엄마', text: '밥 먹었니'});
    assert.deepEqual(parseGsconnectBody('방: 철수: 시간: 3시: 확인'), {room: '방', sender: '철수', text: '시간: 3시: 확인'});
    assert.deepEqual(parseGsconnectBody(''), {room: null, sender: null, text: ''});
    assert.deepEqual(parseGsconnectBody(undefined), {room: null, sender: null, text: ''});
});

test('parseAttentionBody: curly or straight quotes, else null', () => {
    assert.equal(parseAttentionBody('“가족방” is ready'), '가족방');
    assert.equal(parseAttentionBody('"철수" is ready'), '철수');
    assert.equal(parseAttentionBody('is ready'), null);
});

test('mergeEvents: same sender within 10 s folds into the richer event and fills gaps', () => {
    const queue = [];
    const poor = messageEvent({source: 'pc', sender: '철수', text: '안녕', ts: 1000});
    poor.notification = 'pc-n';
    const rich = messageEvent({source: 'phone', sender: '철수', room: '가족방', text: '안녕', ts: 5000, hasIcon: true});
    rich.notification = 'phone-n';
    mergeEvents(queue, poor, 1000);
    mergeEvents(queue, rich, 5000);
    assert.equal(queue.length, 1);
    assert.equal(queue[0].source, 'phone');
    assert.equal(queue[0].notification, 'phone-n');
    assert.equal(queue[0].room, '가족방');
    assert.equal(queue[0].hasIcon, true);
});

test('mergeEvents: a poorer later event still fills the richer earlier one', () => {
    const queue = [];
    const rich = messageEvent({source: 'phone', sender: '철수', text: '안녕', ts: 1000, hasIcon: true});
    const poor = messageEvent({source: 'pc', sender: '철수', room: '가족방', text: '', ts: 4000});
    mergeEvents(queue, rich, 1000);
    mergeEvents(queue, poor, 4000);
    assert.equal(queue.length, 1);
    assert.equal(queue[0].source, 'phone');
    assert.equal(queue[0].room, '가족방');
    assert.equal(queue[0].text, '안녕');
});

test('mergeEvents: 11 s apart stays two events', () => {
    const queue = [];
    mergeEvents(queue, messageEvent({source: 'pc', sender: '철수', text: '하나', ts: 0}), 0);
    mergeEvents(queue, messageEvent({source: 'pc', sender: '철수', text: '둘', ts: 11000}), 11000);
    assert.equal(queue.length, 2);
});

test('mergeEvents: room-only attention merges with the text message of that room', () => {
    const queue = [];
    mergeEvents(queue, messageEvent({source: 'pc-attention', room: '가족방', ts: 0}), 0);
    mergeEvents(queue, messageEvent({source: 'pc', sender: '엄마', room: '가족방', text: '밥', ts: 500}), 500);
    assert.equal(queue.length, 1);
    assert.deepEqual([queue[0].source, queue[0].sender, queue[0].text], ['pc', '엄마', '밥']);
    // Different senders in the same room are different messages.
    mergeEvents(queue, messageEvent({source: 'pc', sender: '아빠', room: '가족방', text: '응', ts: 900}), 900);
    assert.equal(queue.length, 2);
});

test('enqueueEvent dedupes by key', () => {
    const queue = [];
    enqueueEvent(queue, messageEvent({source: 'pc', sender: '철수', text: '안녕', ts: 0}));
    enqueueEvent(queue, messageEvent({source: 'pc', sender: '철수', text: '안녕', ts: 50}));
    enqueueEvent(queue, messageEvent({source: 'pc', sender: '철수', text: '다른', ts: 50}));
    assert.equal(queue.length, 2);
});

test('expireEvents drops events older than 60 s', () => {
    const queue = [messageEvent({source: 'pc', sender: 'a', text: 'x', ts: 0}),
        messageEvent({source: 'pc', sender: 'b', text: 'y', ts: 30000})];
    expireEvents(queue, 61000);
    assert.equal(queue.length, 1);
    assert.equal(queue[0].sender, 'b');
});

test('takeEvent respects the claim', () => {
    const queue = [messageEvent({source: 'pc', sender: 'a', text: 'x', ts: 1000})];
    assert.equal(takeEvent(queue, () => false, 2000), null);
    assert.equal(queue.length, 1);
    assert.equal(takeEvent(queue, () => true, 2000).sender, 'a');
    assert.equal(queue.length, 0);
    assert.equal(takeEvent(queue, () => true, 2000), null);
});

test('displayText: body hidden shows the name only; room goes to the caption', () => {
    const event = messageEvent({source: 'phone', sender: '엄마', room: '가족방', text: '밥 먹었니'});
    assert.deepEqual(displayText(event, true), {primary: '엄마', secondary: '밥 먹었니', caption: '카카오톡 · 가족방'});
    assert.deepEqual(displayText(event, false), {primary: '엄마', secondary: '새 메시지', caption: '카카오톡 · 가족방'});
    assert.deepEqual(displayText(messageEvent({source: 'pc-attention', room: '가족방'}), true),
        {primary: '가족방', secondary: '새 메시지', caption: '카카오톡'});
    assert.deepEqual(displayText(messageEvent({source: 'pc'}), true),
        {primary: '카카오톡', secondary: '새 메시지', caption: '카카오톡'});
});
