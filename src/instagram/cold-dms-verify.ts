import type { OcrWord } from './ocr.js';

/**
 * Pure helpers that turn an OCR pass over the DM thread into a verdict about
 * whether the preset text is still sitting in the composer or has moved up
 * into the conversation as a sent bubble. The runner screenshots once after
 * typing (text must be in the composer) and once after tapping Send (text
 * must have left the composer).
 */

export interface MessagePlacement {
    /** A message token was read inside the composer row band. */
    inComposer: boolean;
    /** A message token was read above the composer, i.e. in the thread. */
    inThread: boolean;
    /** The tokens that were matched anywhere, for logging. */
    matched: string[];
}

export interface ComposerBand {
    /** Composer row centre, in screenshot pixels. */
    centerY: number;
    /** Half-height of the band, in screenshot pixels. */
    halfHeight: number;
}

function normalizeToken(text: string): string {
    return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

/** Distinctive tokens from the preset worth looking for in OCR output. */
export function messageTokens(message: string): string[] {
    const tokens = message.split(/\s+/).map(normalizeToken).filter((token) => token.length >= 3);
    if (tokens.length > 0) return Array.from(new Set(tokens));
    const whole = normalizeToken(message);
    return whole ? [whole] : [];
}

function wordMatchesToken(word: OcrWord, token: string): boolean {
    const normalized = normalizeToken(word.text);
    if (!normalized) return false;
    if (normalized === token) return true;
    // OCR glues punctuation and neighbours; accept containment when the
    // token is long enough not to be noise.
    return token.length >= 4 && normalized.includes(token);
}

/** OCR words that read as one of the message's tokens. */
export function messageWordMatches(words: OcrWord[], message: string): OcrWord[] {
    const tokens = messageTokens(message);
    return words.filter((word) => tokens.some((token) => wordMatchesToken(word, token)));
}

/** First OCR word whose normalized text matches `pattern`, optionally below `minY` px. */
export function findWordMatch(words: OcrWord[], pattern: RegExp, minY = 0): OcrWord | undefined {
    return words.find((word) => word.y + word.height / 2 >= minY && pattern.test(word.text.trim()));
}

export function classifyMessagePlacement(
    words: OcrWord[],
    message: string,
    band: ComposerBand,
): MessagePlacement {
    const tokens = messageTokens(message);
    const placement: MessagePlacement = { inComposer: false, inThread: false, matched: [] };
    for (const word of words) {
        const token = tokens.find((candidate) => wordMatchesToken(word, candidate));
        if (!token) continue;
        placement.matched.push(word.text);
        const centerY = word.y + word.height / 2;
        if (Math.abs(centerY - band.centerY) <= band.halfHeight) placement.inComposer = true;
        else if (centerY < band.centerY - band.halfHeight) placement.inThread = true;
    }
    return placement;
}

export type SendVerdict = 'sent' | 'still-in-composer' | 'unconfirmed';

/**
 * Given the placement before and after the Send tap, decide what happened.
 * `before` must show the text in the composer for any verdict other than
 * `unconfirmed` — otherwise we never typed the message in the first place.
 */
export function judgeSend(before: MessagePlacement, after: MessagePlacement): SendVerdict {
    if (!before.inComposer) return 'unconfirmed';
    if (after.inComposer) return 'still-in-composer';
    return 'sent';
}
