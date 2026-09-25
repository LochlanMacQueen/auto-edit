import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import sharp from 'sharp';

const execFileAsync = promisify(execFile);

export interface PickerMatchCell {
    index: number;
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface PickerMatchResult {
    cell: PickerMatchCell;
    score: number;
    runnerUpScore: number;
}

const SAMPLE_SIZE = 24;
/** Tight absolute gate — works when the thumbnail is nearly a video frame. */
const MAX_ACCEPT_SCORE = 32;
/**
 * Photos often generates a poster that is only loosely related to early
 * frames (split layouts, overlays). Accept a weaker absolute score when the
 * winner clearly beats every other cell — or when several cells tie because
 * the same import was added multiple times.
 */
const RELATIVE_ACCEPT_SCORE = 55;
const RELATIVE_MIN_GAP = 5;
/** Scores within this of the winner count as the same clip (re-imports). */
const TIE_EPSILON = 3.0;

async function sampleRgb(buffer: Buffer): Promise<Buffer> {
    const { data } = await sharp(buffer)
        .resize(SAMPLE_SIZE, SAMPLE_SIZE, { fit: 'cover' })
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
    return data;
}

function meanAbsDiff(a: Buffer, b: Buffer): number {
    const n = Math.min(a.length, b.length);
    let sum = 0;
    for (let i = 0; i < n; i += 1) sum += Math.abs(a[i]! - b[i]!);
    return sum / n;
}

async function probeDurationSeconds(filePath: string): Promise<number | undefined> {
    try {
        const { stdout } = await execFileAsync('ffprobe', [
            '-v', 'error',
            '-show_entries', 'format=duration',
            '-of', 'default=noprint_wrappers=1:nokey=1',
            filePath,
        ], { timeout: 30_000 });
        const value = Number.parseFloat(stdout.trim());
        return Number.isFinite(value) && value > 0 ? value : undefined;
    } catch {
        return undefined;
    }
}

async function extractVideoFrames(filePath: string): Promise<Buffer[]> {
    const duration = await probeDurationSeconds(filePath);
    const stamps = duration
        ? [0.3, 1, 2, Math.min(5, duration * 0.1), duration * 0.25, duration * 0.4, duration * 0.55]
            .map((t) => Math.max(0.05, Math.min(duration - 0.05, t)))
        : [0.5, 1, 2, 5];
    const unique = [...new Set(stamps.map((t) => Number(t.toFixed(2))))];

    const dir = await mkdtemp(path.join(os.tmpdir(), 'phone-farm-frame-'));
    try {
        const frames: Buffer[] = [];
        for (const [i, stamp] of unique.entries()) {
            const out = path.join(dir, `frame-${i}.png`);
            try {
                await execFileAsync('ffmpeg', [
                    '-y', '-ss', String(stamp), '-i', filePath, '-frames:v', '1', '-q:v', '2', out,
                ], { timeout: 60_000 });
                frames.push(await readFile(out));
            } catch {
                // Skip stamps ffmpeg cannot seek.
            }
        }
        if (!frames.length) throw new Error(`Could not extract frames from ${path.basename(filePath)}`);
        return frames;
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
}

async function referenceSamples(frames: Buffer[]): Promise<Buffer[]> {
    const samples: Buffer[] = [];
    for (const frame of frames) {
        const meta = await sharp(frame).metadata();
        const width = meta.width ?? 0;
        const height = meta.height ?? 0;
        samples.push(await sampleRgb(frame));
        if (width < 40 || height < 40) continue;
        const crops = [
            // Upper graphic / title cards common in edited verticals.
            { left: Math.floor(width * 0.05), top: Math.floor(height * 0.05), width: Math.floor(width * 0.9), height: Math.floor(height * 0.35) },
            // Mid band.
            { left: Math.floor(width * 0.1), top: Math.floor(height * 0.15), width: Math.floor(width * 0.8), height: Math.floor(height * 0.45) },
            // Lower talking-head band (Photos posters often show the person).
            { left: Math.floor(width * 0.1), top: Math.floor(height * 0.5), width: Math.floor(width * 0.8), height: Math.floor(height * 0.45) },
            { left: Math.floor(width * 0.2), top: Math.floor(height * 0.55), width: Math.floor(width * 0.6), height: Math.floor(height * 0.35) },
        ];
        for (const crop of crops) {
            samples.push(await sampleRgb(await sharp(frame).extract(crop).toBuffer()));
        }
    }
    return samples;
}

function acceptMatch(score: number, runnerUp: number): boolean {
    if (score <= MAX_ACCEPT_SCORE) return true;
    if (score > RELATIVE_ACCEPT_SCORE || !Number.isFinite(runnerUp)) return false;
    const gap = runnerUp - score;
    // Only a clear unique winner among mediocre posters — never treat two
    // similarly-bad scores as "duplicate imports" (that picked the wrong clip).
    return gap >= RELATIVE_MIN_GAP;
}

const DURATION_BADGE_RE = /\b(\d{1,2}:\d{2})\b/;

/**
 * OCR duration badges painted on picker thumbnails (not in the a11y tree).
 * Returns cells whose badge matches one of the expected labels (e.g. 1:14 / 01:14).
 */
export async function filterCellsByDurationBadge(
    screenshot: Buffer,
    scale: number,
    cells: PickerMatchCell[],
    durationLabels: string[],
    recognizeWords: (image: Buffer) => Promise<Array<{ text: string }>>,
): Promise<PickerMatchCell[]> {
    if (!cells.length || !durationLabels.length) return [];
    const wanted = new Set(durationLabels);
    const picker = sharp(screenshot);
    const meta = await picker.metadata();
    const imgW = meta.width ?? 0;
    const imgH = meta.height ?? 0;
    const matched: PickerMatchCell[] = [];

    for (const cell of cells) {
        const left = Math.round(cell.x * scale);
        const top = Math.round(cell.y * scale);
        const width = Math.round(cell.width * scale);
        const height = Math.round(cell.height * scale);
        if (left < 0 || top < 0 || left + width > imgW || top + height > imgH || width < 20 || height < 20) {
            continue;
        }
        // Duration sits in the lower-left of TikTok thumbnails.
        const crop = {
            left: left + Math.round(width * 0.02),
            top: top + Math.round(height * 0.62),
            width: Math.max(8, Math.round(width * 0.55)),
            height: Math.max(8, Math.round(height * 0.35)),
        };
        try {
            const badge = await picker.clone().extract(crop).png().toBuffer();
            const words = await recognizeWords(badge);
            const text = words.map((word) => word.text).join(' ');
            const hit = text.match(DURATION_BADGE_RE)?.[1];
            if (hit && wanted.has(hit)) {
                console.log(
                    `Duration OCR matched "${hit}" at `
                    + `(${Math.round(cell.x + cell.width / 2)},${Math.round(cell.y + cell.height / 2)})`,
                );
                matched.push(cell);
            }
        } catch {
            // OCR can fail on tiny/blurry crops — skip cell.
        }
    }
    return matched;
}

/**
 * Find the picker grid cell whose thumbnail best matches frames from the
 * imported video. Duration badges are not in the accessibility tree, and
 * TikTok Videos sorts by file creation date — so top-left is often wrong.
 */
export async function matchPickerCellToVideo(
    screenshot: Buffer,
    scale: number,
    cells: PickerMatchCell[],
    videoPath: string,
): Promise<PickerMatchResult | undefined> {
    if (!cells.length) return undefined;
    const frames = await extractVideoFrames(videoPath);
    const references = await referenceSamples(frames);
    const picker = sharp(screenshot);
    const meta = await picker.metadata();
    const imgW = meta.width ?? 0;
    const imgH = meta.height ?? 0;

    const scored: Array<{ cell: PickerMatchCell; score: number }> = [];
    for (const cell of cells) {
        const left = Math.round(cell.x * scale);
        const top = Math.round(cell.y * scale);
        const width = Math.round(cell.width * scale);
        const height = Math.round(cell.height * scale);
        if (left < 0 || top < 0 || left + width > imgW || top + height > imgH || width < 20 || height < 20) {
            continue;
        }
        // Trim edges / duration badge so we compare content, not chrome.
        const crop = {
            left: left + Math.round(width * 0.08),
            top: top + Math.round(height * 0.05),
            width: Math.max(8, Math.round(width * 0.84)),
            height: Math.max(8, Math.round(height * 0.8)),
        };
        const cellBuf = await picker.clone().extract(crop).toBuffer();
        const cellSample = await sampleRgb(cellBuf);
        let best = Number.POSITIVE_INFINITY;
        for (const reference of references) {
            best = Math.min(best, meanAbsDiff(reference, cellSample));
        }
        scored.push({ cell, score: best });
    }
    if (!scored.length) return undefined;
    scored.sort((a, b) => a.score - b.score);
    const winner = scored[0]!;
    const runnerUp = scored[1]?.score ?? Number.POSITIVE_INFINITY;
    const tapHint = `(${Math.round(winner.cell.x + winner.cell.width / 2)},${Math.round(winner.cell.y + winner.cell.height / 2)})`;
    if (!acceptMatch(winner.score, runnerUp)) {
        console.log(
            `Visual match rejected: best score ${winner.score.toFixed(1)} at ${tapHint} `
            + `(runnerUp=${Number.isFinite(runnerUp) ? runnerUp.toFixed(1) : 'n/a'}; `
            + `need ≤${MAX_ACCEPT_SCORE} or ≤${RELATIVE_ACCEPT_SCORE} with gap≥${RELATIVE_MIN_GAP})`,
        );
        return undefined;
    }
    // Duplicate re-imports only when the match is actually strong.
    if (winner.score <= MAX_ACCEPT_SCORE) {
        const tied = scored.filter((entry) => entry.score - winner.score <= TIE_EPSILON);
        if (tied.length > 1) {
            console.log(
                `Visual match: ${tied.length} near-tied strong cells (duplicate imports); picking top-left`,
            );
            tied.sort((a, b) => (a.cell.y - b.cell.y) || (a.cell.x - b.cell.x));
            const pick = tied[0]!;
            const pickHint = `(${Math.round(pick.cell.x + pick.cell.width / 2)},${Math.round(pick.cell.y + pick.cell.height / 2)})`;
            console.log(
                `Visual match: cell ${pickHint} score=${pick.score.toFixed(1)} `
                + `runnerUp=${Number.isFinite(runnerUp) ? runnerUp.toFixed(1) : 'n/a'} (tied)`,
            );
            return { cell: pick.cell, score: pick.score, runnerUpScore: runnerUp };
        }
    }
    console.log(
        `Visual match: cell ${tapHint} score=${winner.score.toFixed(1)} `
        + `runnerUp=${Number.isFinite(runnerUp) ? runnerUp.toFixed(1) : 'n/a'}`,
    );
    return { cell: winner.cell, score: winner.score, runnerUpScore: runnerUp };
}

/** Debug helper: write annotated crops (optional). */
export async function writeMatchDebugFrame(videoPath: string, outPath: string): Promise<void> {
    const [frame] = await extractVideoFrames(videoPath);
    if (frame) await writeFile(outPath, frame);
}
