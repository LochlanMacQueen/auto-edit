import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyMessagePlacement, judgeSend, messageTokens } from '../src/instagram/cold-dms-verify.js';
import type { OcrWord } from '../src/instagram/ocr.js';

const word = (text: string, y: number): OcrWord => ({ text, x: 100, y, width: 80, height: 30, confidence: 90 });
const band = { centerY: 1506, halfHeight: 84 }; // composer at 502pt on a 3x screen

test('messageTokens keeps distinctive words and falls back to the whole message', () => {
    assert.deepEqual(messageTokens('Hey — love your content, quick question?'), ['hey', 'love', 'your', 'content', 'quick', 'question']);
    assert.deepEqual(messageTokens('test'), ['test']);
    assert.deepEqual(messageTokens('ok'), ['ok']);
    assert.deepEqual(messageTokens('   '), []);
});

test('classifyMessagePlacement separates composer row from thread bubbles', () => {
    const typed = classifyMessagePlacement([word('Message...', 400), word('test', 1500)], 'test', band);
    assert.equal(typed.inComposer, true);
    assert.equal(typed.inThread, false);

    const sent = classifyMessagePlacement([word('test', 1200), word('Message...', 1506)], 'test', band);
    assert.equal(sent.inComposer, false);
    assert.equal(sent.inThread, true);
    assert.deepEqual(sent.matched, ['test']);

    const noise = classifyMessagePlacement([word('Send', 1506), word('Latest', 1200)], 'test', band);
    assert.equal(noise.inComposer, false);
    assert.equal(noise.inThread, true, 'containment is accepted for 4+ char tokens');
    const short = classifyMessagePlacement([word('ok!', 1506)], 'ok', band);
    assert.equal(short.inComposer, true);
});

test('judgeSend requires the text to have been in the composer and then gone', () => {
    const inComposer = { inComposer: true, inThread: false, matched: ['test'] };
    const inThread = { inComposer: false, inThread: true, matched: ['test'] };
    const nowhere = { inComposer: false, inThread: false, matched: [] };
    assert.equal(judgeSend(inComposer, inThread), 'sent');
    assert.equal(judgeSend(inComposer, nowhere), 'sent');
    assert.equal(judgeSend(inComposer, inComposer), 'still-in-composer');
    assert.equal(judgeSend(nowhere, inThread), 'unconfirmed');
});
