import type { OcrWord } from '../instagram/ocr.js';

/**
 * Classify a Hinge screenshot from its OCR words. Hinge runs light-mode, so
 * plain OCR reads it well; every rule here is anchored on stable UI copy
 * rather than on photos or prompt text.
 */
export type HingeScreenKind =
    | 'discover'
    | 'like-sheet'
    | 'likes-you'
    | 'matches'
    | 'standouts'
    | 'profile'
    | 'unknown';

export interface HingeScreen {
    kind: HingeScreenKind;
    /** Discover only: the name in the sticky header (or the top-left title). */
    name?: string;
    /** Discover only: filter chips visible means the card is at its top. */
    atTop?: boolean;
}

interface Options {
    /** Screenshot pixels per point (3 on the iPhone 13). */
    scale: number;
}

const NAME_PATTERN = /^[\p{L}][\p{L}'’.-]{0,30}$/u;

function centerY(word: OcrWord, scale: number): number {
    return (word.y + word.height / 2) / scale;
}

function centerX(word: OcrWord, scale: number): number {
    return (word.x + word.width / 2) / scale;
}

function has(words: OcrWord[], pattern: RegExp, scale: number, band?: [number, number]): boolean {
    return words.some((word) => pattern.test(word.text.trim())
        && (!band || (centerY(word, scale) >= band[0] && centerY(word, scale) <= band[1])));
}

export function classifyHingeScreen(words: OcrWord[], { scale }: Options): HingeScreen {
    // Like sheet: "Send Like" button around y≈500 with the comment box above.
    if (has(words, /^Send$/i, scale, [430, 660]) && has(words, /^Like$/i, scale, [430, 660])) {
        return { kind: 'like-sheet' };
    }
    if (has(words, /^Likes$/i, scale, [90, 150]) && has(words, /^You$/i, scale, [90, 150])) return { kind: 'likes-you' };
    if (has(words, /^Matches$/i, scale, [90, 150])) return { kind: 'matches' };
    if (has(words, /^Standouts/i, scale, [110, 230])) return { kind: 'standouts' };
    if (has(words, /^Hinge\+?$/i, scale, [50, 120]) && (has(words, /^Safety$/i, scale) || has(words, /^Get$/i, scale))) {
        return { kind: 'profile' };
    }

    const atTop = has(words, /^Signals$/i, scale, [60, 100]) || has(words, /^Height$/i, scale, [60, 100]);
    // Unscrolled Discover: name is a left-aligned title under the filter chips.
    // Scrolled Discover: name is centred in the sticky header at y≈70.
    const candidates = atTop
        ? words.filter((word) => centerY(word, scale) >= 120 && centerY(word, scale) <= 155 && centerX(word, scale) < 200)
        : words.filter((word) => centerY(word, scale) >= 55 && centerY(word, scale) <= 90 && Math.abs(centerX(word, scale) - 195) < 90);
    const nameWord = candidates.find((word) => NAME_PATTERN.test(word.text.trim()));
    if (nameWord) return { kind: 'discover', name: nameWord.text.trim(), atTop };
    return { kind: 'unknown' };
}
