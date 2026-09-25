import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyHingeScreen } from '../src/hinge/screen.js';
import type { OcrWord } from '../src/instagram/ocr.js';

// Points → 3x pixels, matching the iPhone 13 map in src/hinge/coordinates.ts.
const w = (text: string, xPt: number, yPt: number): OcrWord => ({
    text, x: (xPt - 10) * 3, y: (yPt - 8) * 3, width: 60, height: 48, confidence: 90,
});
const opts = { scale: 3 };

test('discover at top: filter chips plus left-aligned name', () => {
    const screen = classifyHingeScreen([w('Signals', 98, 80), w('Age', 183, 80), w('Height', 275, 80), w('Kati', 45, 137)], opts);
    assert.deepEqual(screen, { kind: 'discover', name: 'Kati', atTop: true });
});

test('discover scrolled: centred sticky header name', () => {
    const screen = classifyHingeScreen([w('Kati', 195, 70), w('geek', 120, 400), w('out', 160, 400)], opts);
    assert.deepEqual(screen, { kind: 'discover', name: 'Kati', atTop: false });
});

test('like sheet wins over the header name behind it', () => {
    const screen = classifyHingeScreen([w('Kati', 195, 70), w('Add', 68, 410), w('comment', 135, 410), w('Send', 236, 500), w('Like', 269, 500)], opts);
    assert.equal(screen.kind, 'like-sheet');
});

test('other tabs are recognised by their titles', () => {
    assert.equal(classifyHingeScreen([w('Likes', 45, 120), w('You', 100, 120)], opts).kind, 'likes-you');
    assert.equal(classifyHingeScreen([w('Matches', 60, 120)], opts).kind, 'matches');
    assert.equal(classifyHingeScreen([w('Standouts', 85, 162)], opts).kind, 'standouts');
    assert.equal(classifyHingeScreen([w('Hinge+', 60, 70), w('Safety', 195, 300)], opts).kind, 'profile');
});

test('no anchors means unknown, and status-bar text is never a name', () => {
    assert.equal(classifyHingeScreen([w('11:02', 54, 30), w('SOS', 295, 20)], opts).kind, 'unknown');
    assert.equal(classifyHingeScreen([], opts).kind, 'unknown');
});
