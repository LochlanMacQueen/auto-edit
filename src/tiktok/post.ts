import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { remote, type Browser } from 'webdriverio';

import { loadRegisteredDevices, resolveDeviceCoordinates, WdaRemoteControl } from '@git-agni/phone-farm-core';
import type { PostManifest } from './post-manifest.js';
import { type TikTokCoordinates } from './coordinates.js';
import { coordinateProfile, registeredAccounts } from './runtime-settings.js';
import { switchTikTokAccount, tapCoordinate, typeText } from './actions.js';
import { recentPickerTargets } from './post-layout.js';
import { isRedCheckboxChecked } from './pixel.js';
import { matchPickerCellToVideo, filterCellsByDurationBadge } from './post-picker-match.js';
import { recognizeWords } from './ocr.js';

const execFileAsync = promisify(execFile);
const POST_DEBUG_DIR = path.resolve('.wda', 'post-debug');

async function savePostDebugScreenshot(remote: WdaRemoteControl, udid: string, label: string): Promise<string | undefined> {
    // Extra WDA screenshots compete with MJPEG — only when debugging a picker/publish miss.
    if (process.env.POST_DEBUG_SCREENSHOTS !== '1') return undefined;
    await mkdir(POST_DEBUG_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filePath = path.join(POST_DEBUG_DIR, `${stamp}-${label}.png`);
    await writeFile(filePath, await remote.getScreenshot(udid));
    console.log(`Saved post debug screenshot: ${filePath}`);
    return filePath;
}

/** Round file duration to the MM:SS / M:SS strings TikTok paints on thumbnails. */
function durationBadgeLabels(seconds: number): string[] {
    const total = Math.max(0, Math.round(seconds));
    const m = Math.floor(total / 60);
    const s = total % 60;
    const ss = String(s).padStart(2, '0');
    return Array.from(new Set([
        `${String(m).padStart(2, '0')}:${ss}`,
        `${m}:${ss}`,
    ]));
}

async function probeMediaDurationSeconds(filePath: string): Promise<number | undefined> {
    try {
        const { stdout } = await execFileAsync('ffprobe', [
            '-v', 'error',
            '-show_entries', 'format=duration',
            '-of', 'default=noprint_wrappers=1:nokey=1',
            filePath,
        ], { timeout: 30_000 });
        const value = Number.parseFloat(stdout.trim());
        return Number.isFinite(value) && value > 0 ? value : undefined;
    } catch (error) {
        console.log(`ffprobe failed for ${path.basename(filePath)}: ${error instanceof Error ? error.message : String(error)}`);
        return undefined;
    }
}

interface PickerCellInfo {
    index: number;
    label: string;
    name: string;
    duration?: string;
    x: number;
    y: number;
    width: number;
    height: number;
    // WebdriverIO element from $$ — click() is enough for selection.
    element: { click(): Promise<void> };
}

function isCameraOrUtilityCell(label: string, name: string): boolean {
    const text = `${label} ${name}`.toLowerCase();
    return /camera|take (a )?(photo|video|picture)|record|shoot|capture|add from|live photo/.test(text);
}

const DURATION_RE = /\b(\d{1,2}:\d{2})\b/;

async function readCellDuration(element: {
    getAttribute(name: string): Promise<string | null>;
    $$?: (selector: string) => any;
}): Promise<string | undefined> {
    for (const attr of ['label', 'name', 'value'] as const) {
        const raw = await element.getAttribute(attr).catch(() => '');
        const match = raw?.match(DURATION_RE);
        if (match) return match[1];
    }
    if (!element.$$) return undefined;
    try {
        const texts = await element.$$('-ios class chain:**/XCUIElementTypeStaticText');
        for (const text of texts) {
            for (const attr of ['label', 'name', 'value'] as const) {
                const raw = await text.getAttribute(attr).catch(() => '');
                const match = raw?.match(DURATION_RE);
                if (match) return match[1];
            }
        }
    } catch {
        // Nested query can fail on stale cells.
    }
    return undefined;
}

async function listPickerCells(driver: Browser): Promise<PickerCellInfo[]> {
    const cells = await driver.$$('-ios class chain:**/XCUIElementTypeCollectionView/XCUIElementTypeCell');
    const listed: PickerCellInfo[] = [];
    let index = 0;
    for (const element of cells) {
        index += 1;
        try {
            if (!(await element.isDisplayed())) continue;
            const [label, name, location, size] = await Promise.all([
                element.getAttribute('label').catch(() => ''),
                element.getAttribute('name').catch(() => ''),
                element.getLocation(),
                element.getSize(),
            ]);
            if (size.width < 40 || size.height < 40) continue;
            const duration = await readCellDuration(element);
            listed.push({
                index,
                label: label ?? '',
                name: name ?? '',
                duration,
                x: location.x,
                y: location.y,
                width: size.width,
                height: size.height,
                element,
            });
        } catch {
            // Cell may disappear mid-enumeration.
        }
    }
    listed.sort((a, b) => (a.y - b.y) || (a.x - b.x));
    return listed;
}

function pickMediaCells(
    cells: PickerCellInfo[],
    want: number,
    durationLabels: string[] | undefined,
): PickerCellInfo[] {
    const media = cells.filter((cell) => !isCameraOrUtilityCell(cell.label, cell.name));
    if (durationLabels?.length) {
        const matched = media.filter((cell) => cell.duration && durationLabels.includes(cell.duration));
        if (matched.length >= want) {
            console.log(
                `Matched ${matched.length} cell(s) by duration badge `
                + `(looking for ${durationLabels.join(' / ')})`,
            );
            return matched.slice(0, want);
        }
        console.log(
            `Duration match missed (wanted ${durationLabels.join(' / ')}, `
            + `saw ${media.map((c) => c.duration ?? '?').join(', ')}); using top-left media`,
        );
    }
    return media.slice(0, want);
}

function positiveInteger(name: string, fallback: number): number {
    const raw = process.env[name] ?? String(fallback);
    const value = Number.parseInt(raw, 10);
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
    return value;
}

async function importMedia(manifest: PostManifest): Promise<number> {
    const wdaUrl = process.env.WDA_URL ?? 'http://127.0.0.1:8100';
    let assetCount = 0;
    // Photos Recents is newest-first. Reverse import makes cell 0 the user's first item.
    for (const [index, file] of [...manifest.files].reverse().entries()) {
        console.log(`Importing media ${manifest.files.length - index}/${manifest.files.length}: ${file.name}`);
        const data = await readFile(file.path);
        // WDA's /wda/import-media takes the whole file base64-encoded in a JSON
        // body. base64 is 4*ceil(n/3) chars and JSON.stringify allocates a
        // second copy; Node's max string length (~512 MiB) caps the input near
        // 384 MiB, so refuse well before that.
        if (data.length > 350 * 1024 * 1024) {
            throw new Error(`${file.name} is ${(data.length / 1_048_576).toFixed(0)} MB — the TikTok media import limit is 350 MB`);
        }
        const response = await fetch(`${wdaUrl}/wda/import-media`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: file.name, mimeType: file.mimeType, data: data.toString('base64') }),
        });
        const result = await response.json() as { value?: { error?: unknown; assetCount?: number } };
        if (!response.ok || (result.value && typeof result.value === 'object' && 'error' in result.value)) {
            throw new Error(`WDA could not import ${file.name}: ${JSON.stringify(result)}`);
        }
        assetCount = result.value?.assetCount ?? 0;
    }
    if (!assetCount) throw new Error('WDA did not return the Photos asset count');
    // Give Photos a beat to surface the import at the front of Recents.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    return assetCount;
}

async function firstDisplayed(driver: Browser, selectors: string[]) {
    for (const selector of selectors) {
        const candidate = await driver.$(selector);
        if (await candidate.isExisting() && await candidate.isDisplayed()) return candidate;
    }
    return undefined;
}

/** Optional UI probes — never block for Appium's default implicit wait. */
async function firstDisplayedQuick(driver: Browser, selectors: string[], timeoutMs = 600) {
    await driver.setTimeout({ implicit: timeoutMs });
    try {
        return await firstDisplayed(driver, selectors);
    } finally {
        await driver.setTimeout({ implicit: 0 });
    }
}

async function clickOne(driver: Browser, label: string, selectors: string[]): Promise<void> {
    const element = await firstDisplayedQuick(driver, selectors, 2_500);
    if (!element) throw new Error(`TikTok control not found: ${label}`);
    await element.click();
    console.log(`Tapped ${label}`);
}

async function dismissContinueEditingDialog(
    driver: Browser,
    _remote: WdaRemoteControl,
    _udid: string,
): Promise<void> {
    // Abandoned composers leave "Continue editing this post?" over Home.
    // Right after activateApp, skip a11y / screenshots — FYP spin-up already
    // saturates WDA. Blind tap the usual Save draft spot (left button on the
    // top card); harmless if the dialog is absent.
    await tapCoordinate(driver, 136, 105, 'Save draft (coord only)');
    await driver.pause(800);
}

async function openComposer(
    driver: Browser,
    remote: WdaRemoteControl,
    udid: string,
    coordinates: TikTokCoordinates['tiktok'],
    screenSize: { width: number; height: number },
    musicUrl?: string,
): Promise<void> {
    if (musicUrl) {
        console.log(`Opening music URL: ${musicUrl}`);
        await driver.execute('mobile: deepLink', { url: musicUrl });
        await driver.pause(4000);
        await clickOne(driver, 'Use this sound', [
            '~Use this sound', '~Use sound', '-ios predicate string:(label CONTAINS[c] "Use this sound") OR (name CONTAINS[c] "Use this sound")',
        ]);
    } else {
        await driver.activateApp(process.env.TIKTOK_BUNDLE_ID ?? 'com.zhiliaoapp.musically');
        // FYP cold-start is the WDA cliff — wait, then chrome taps only.
        // Never tap screen-center on Home: that opens Effects / video chrome.
        await driver.pause(6000);
        await dismissContinueEditingDialog(driver, remote, udid);
        // Create (+) only lives on the Home tab chrome. Account-switch attempts
        // (or a cold launch onto Profile/Inbox) leave us off Home — retap first.
        await tapCoordinate(
            driver,
            coordinates.homeTab.x,
            coordinates.homeTab.y,
            'Home tab',
        );
        await driver.pause(1500);
        console.log(`Opening Create (+) at (${coordinates.create.x}, ${coordinates.create.y})`);
        await tapCoordinate(
            driver,
            coordinates.create.x,
            coordinates.create.y,
            'Create',
        );
    }
    await driver.pause(2500);
    // Camera defaults to PHOTO/TEXT often. Opening the gallery from PHOTO
    // filters to stills — the first cell is a picture and TikTok routes it to
    // Story. Switch to a video duration mode first so Recents shows videos.
    try {
        await clickOne(driver, '15s video mode', [
            '~15s',
            '-ios predicate string:(label == "15s" OR name == "15s") AND visible == 1',
            '-ios class chain:**/XCUIElementTypeStaticText[`label == "15s"`]',
            '-ios class chain:**/XCUIElementTypeButton[`label == "15s"`]',
        ]);
        await driver.pause(700);
    } catch (error) {
        const videoModeX = Math.round(screenSize.width * 0.40);
        const videoModeY = Math.round(screenSize.height * 0.705);
        console.log(
            `15s control not found (${error instanceof Error ? error.message : String(error)}); `
            + `tapping video mode at (${videoModeX}, ${videoModeY})`,
        );
        await tapCoordinate(driver, videoModeX, videoModeY, '15s video mode');
        await driver.pause(700);
    }
    // Gallery / Upload is the small Recents thumbnail at bottom-left (above All
    // effects). Do NOT tap top-center — that opens Sounds.
    await tapCoordinate(driver, coordinates.upload.x, coordinates.upload.y, 'Upload');
    await driver.pause(2500);
}

const CHECKBOX_RETRY_ATTEMPTS = 3;

// TikTok's Photos picker checkboxes ("Select multiple", "Use layout") are
// persistent toggles, not one-time buttons — they can already be in the
// desired state from a previous picker session. A blind tap assuming a
// fixed starting state can flip a checkbox the WRONG way (e.g. turning off
// an already-on "Select multiple", silently dropping into single-select
// mode). Check the actual on-screen color before deciding whether to tap.
async function ensureCheckboxState(
    driver: Browser,
    remote: WdaRemoteControl,
    udid: string,
    point: { x: number; y: number },
    label: string,
    desired: boolean,
): Promise<void> {
    const { scale } = await remote.getScreenInfo(udid);
    for (let attempt = 1; attempt <= CHECKBOX_RETRY_ATTEMPTS; attempt += 1) {
        const checked = await isRedCheckboxChecked(await remote.getScreenshot(udid), point, scale);
        if (checked === desired) {
            console.log(`"${label}" confirmed ${desired ? 'on' : 'off'}`);
            return;
        }
        await tapCoordinate(driver, point.x, point.y, `${label} (attempt ${attempt})`);
        await driver.pause(1000);
    }
    throw new Error(`Could not get "${label}" into the ${desired ? 'on' : 'off'} state after ${CHECKBOX_RETRY_ATTEMPTS} attempts`);
}

async function tapDurationBadge(
    driver: Browser,
    badges: string[],
): Promise<boolean> {
    for (const badge of badges) {
        const hit = await firstDisplayed(driver, [
            `~${badge}`,
            `-ios predicate string:(label == "${badge}" OR name == "${badge}" OR value == "${badge}") AND visible == 1`,
            `-ios class chain:**/XCUIElementTypeStaticText[\`label == "${badge}"\`]`,
        ]);
        if (!hit) continue;
        // Tap the badge — it's painted on the thumbnail; that selects the cell.
        await hit.click();
        console.log(`Tapped duration badge "${badge}" (imported-file match)`);
        return true;
    }
    return false;
}

async function chooseRecentMedia(
    driver: Browser, remote: WdaRemoteControl, udid: string, files: PostManifest['files'], assetCount: number,
    coordinates: TikTokCoordinates['tiktok'],
): Promise<void> {
    const count = files.length;
    const primaryDuration = files[0] ? await probeMediaDurationSeconds(files[0].path) : undefined;
    const badges = primaryDuration !== undefined ? durationBadgeLabels(primaryDuration) : undefined;
    if (primaryDuration !== undefined) {
        console.log(
            `Selecting import by duration ~${primaryDuration.toFixed(1)}s `
            + `(badge ${badges?.join(' / ')}); All-grid newest = bottom row right→left`,
        );
    }

    // Do NOT tap "Recents" / album titles — that opens the Albums browser.
    // Default Upload "All" grid: a fresh WDA import sits on the BOTTOM row,
    // right → left. Never scroll toward the top of the library (that hides it).

    // A leftover "Select multiple" from a prior run changes single-tap behavior.
    if (count === 1) {
        await ensureCheckboxState(driver, remote, udid, {
            x: coordinates.selectMultiple.x,
            y: coordinates.selectMultiple.y,
        }, 'Select multiple', false).catch((error) => {
            console.log(
                `Select multiple check skipped (${error instanceof Error ? error.message : String(error)})`,
            );
        });
    }

    // Grid can take a beat after Upload open. If we somehow landed on Albums,
    // dismiss back to the media grid.
    let cells: PickerCellInfo[] = [];
    for (let attempt = 1; attempt <= 6; attempt += 1) {
        cells = await listPickerCells(driver);
        if (cells.some((cell) => !isCameraOrUtilityCell(cell.label, cell.name))) break;
        console.log(`Waiting for picker cells (attempt ${attempt}/6)`);
        if (attempt === 3) {
            try {
                const back = await firstDisplayedQuick(driver, [
                    '~Back',
                    '~Close',
                    '~Cancel',
                    '-ios predicate string:(label == "Back" OR label == "Close" OR label == "Cancel") AND visible == 1',
                ], 800);
                if (back) {
                    await back.click();
                    console.log('Dismissed album browser — returning to media grid');
                    await driver.pause(900);
                }
            } catch { /* stay put */ }
        }
        await driver.pause(700);
    }

    await savePostDebugScreenshot(remote, udid, 'picker-before-select');
    console.log(
        `Picker cells (top→bottom, left→right), assetCount=${assetCount}, want=${count}:\n`
        + (cells.length
            ? cells.map((cell, i) => (
                `  [${i}] dom#${cell.index} (${Math.round(cell.x)},${Math.round(cell.y)}) `
                + `${Math.round(cell.width)}x${Math.round(cell.height)} `
                + `dur=${cell.duration ?? '?'} `
                + `label=${JSON.stringify(cell.label)} name=${JSON.stringify(cell.name)}`
                + (isCameraOrUtilityCell(cell.label, cell.name) ? ' [skip-camera]' : '')
            )).join('\n')
            : '  (none found)'),
    );

    const mediaCells = cells.filter((cell) => !isCameraOrUtilityCell(cell.label, cell.name));

    /** Bottom-most row of the visible grid, ordered right → left (newest import first). */
    const bottomRowRightToLeft = (pool: PickerCellInfo[]): PickerCellInfo[] => {
        if (!pool.length) return [];
        const maxY = Math.max(...pool.map((cell) => cell.y));
        const rowSlack = Math.max(40, Math.round((pool[0]?.height ?? 120) * 0.45));
        return pool
            .filter((cell) => cell.y >= maxY - rowSlack)
            .sort((a, b) => b.x - a.x);
    };

    const advanceAfterSelect = async (label: string): Promise<void> => {
        await driver.pause(1000);
        await savePostDebugScreenshot(remote, udid, 'picker-after-select');
        await driver.pause(2000);
        await tapCoordinate(driver, coordinates.pickerNext.x, coordinates.pickerNext.y, 'picker Next');
        await driver.pause(4000);
        await savePostDebugScreenshot(remote, udid, 'editor-before-next');
        await tapCoordinate(driver, coordinates.editorNext.x, coordinates.editorNext.y, 'editor Next');
        await driver.pause(3000);
        console.log(`Advanced from picker after ${label}`);
    };

    // Single-file: stay on the visible All grid. Newest WDA import = bottom row, R→L.
    if (count === 1 && files[0] && mediaCells.length) {
        const bottomRow = bottomRowRightToLeft(mediaCells);
        console.log(
            `Bottom-row candidates (right→left): `
            + bottomRow.map((cell) => (
                `(${Math.round(cell.x + cell.width / 2)},${Math.round(cell.y + cell.height / 2)})`
            )).join(' '),
        );

        const { scale } = await remote.getScreenInfo(udid);
        const shot = await remote.getScreenshot(udid);
        let candidates = bottomRow.map((cell) => ({
            index: cell.index,
            x: cell.x,
            y: cell.y,
            width: cell.width,
            height: cell.height,
        }));

        if (badges?.length && candidates.length) {
            const byDuration = await filterCellsByDurationBadge(
                shot,
                scale,
                candidates,
                badges,
                recognizeWords,
            );
            if (byDuration.length === 1) {
                const cell = byDuration[0]!;
                const tapX = Math.round(cell.x + cell.width / 2);
                const tapY = Math.round(cell.y + cell.height / 2);
                await tapCoordinate(driver, tapX, tapY, `imported media (duration OCR ${badges.join('/')})`);
                await advanceAfterSelect('duration OCR bottom-row');
                return;
            }
            if (byDuration.length > 1) {
                // Prefer rightmost among duration hits (newest on this layout).
                byDuration.sort((a, b) => b.x - a.x);
                console.log(`Duration OCR found ${byDuration.length} on bottom row — using rightmost`);
                candidates = byDuration;
            } else {
                console.log('Duration OCR missed on bottom row — visual match on bottom row only');
            }
        }

        const match = candidates.length
            ? await matchPickerCellToVideo(shot, scale, candidates, files[0].path)
            : undefined;

        if (match) {
            const tapX = Math.round(match.cell.x + match.cell.width / 2);
            const tapY = Math.round(match.cell.y + match.cell.height / 2);
            await tapCoordinate(driver, tapX, tapY, `imported media (visual score ${match.score.toFixed(1)})`);
            await advanceAfterSelect('visual match bottom-row');
            return;
        }

        // Deterministic: rightmost cell on the bottom row = newest import on All media.
        const newest = bottomRow[0] ?? mediaCells[mediaCells.length - 1]!;
        const tapX = Math.round(newest.x + newest.width / 2);
        const tapY = Math.round(newest.y + newest.height / 2);
        console.log(
            `Selecting newest import at bottom-row right (${tapX},${tapY}) `
            + `(assetCount=${assetCount})`,
        );
        await tapCoordinate(driver, tapX, tapY, 'newest import (bottom-row right)');
        await advanceAfterSelect('bottom-row right fallback');
        return;
    }

    if (count === 1 && badges?.length && await tapDurationBadge(driver, badges)) {
        await advanceAfterSelect('duration badge');
        return;
    }

    const chosen = pickMediaCells(mediaCells, count, badges);
    if (count > 1) {
        await ensureCheckboxState(driver, remote, udid, {
            x: coordinates.selectMultiple.x,
            y: coordinates.selectMultiple.y,
        }, 'Select multiple', true);
        if (chosen.length >= count) {
            for (let selection = 0; selection < count; selection += 1) {
                const cell = chosen[selection]!;
                await cell.element.click();
                console.log(
                    `Tapped media ${selection + 1}/${count} `
                    + `dur=${cell.duration ?? '?'} at `
                    + `(${Math.round(cell.x + cell.width / 2)},${Math.round(cell.y + cell.height / 2)})`,
                );
                await driver.pause(600);
            }
        } else {
            const targets = recentPickerTargets(assetCount, count, {
                circleX: coordinates.picker.circleX,
                columnStep: coordinates.picker.columnStep,
                firstY: coordinates.picker.firstY,
                trayY: coordinates.picker.trayY,
                rowStep: coordinates.picker.rowStep,
            });
            for (const [selection, { x, y }] of targets.entries()) {
                await tapCoordinate(driver, x, y, `media ${selection + 1}/${count}`);
                await driver.pause(600);
            }
        }
        await ensureCheckboxState(driver, remote, udid, {
            x: coordinates.useLayout.x,
            y: coordinates.useLayout.y,
        }, 'Use layout', false);
        await advanceAfterSelect('multi-select');
        return;
    }

    throw new Error('No media cells found in the TikTok picker');
}

async function addCaption(driver: Browser, coordinates: TikTokCoordinates['tiktok'], caption?: string): Promise<void> {
    if (!caption) return;

    // Prefer the description TextView — the first visible TextView is often the
    // hashtag chip/search box, which seeds a leading "#".
    let field = await firstDisplayedQuick(driver, [
        '-ios predicate string:type == "XCUIElementTypeTextView" AND visible == 1 AND ('
            + 'label CONTAINS[c] "Describe" OR name CONTAINS[c] "Describe" '
            + 'OR label CONTAINS[c] "description" OR name CONTAINS[c] "description" '
            + 'OR label CONTAINS[c] "caption" OR label CONTAINS[c] "Add a" '
            + 'OR value CONTAINS[c] "Describe" OR value CONTAINS[c] "Add a")',
        '-ios class chain:**/XCUIElementTypeTextView[`label CONTAINS[c] "Describe" OR label CONTAINS[c] "Add a"`]',
    ], 2_000);

    if (field) {
        await field.click();
        console.log('Focused caption via description TextView');
    } else {
        // Description sits under the cover — above the "# Hashtags" row.
        await tapCoordinate(driver, coordinates.caption.x, coordinates.caption.y, 'caption');
        field = await firstDisplayedQuick(driver, [
            '-ios class chain:**/XCUIElementTypeTextView[`visible == 1`]',
            '-ios predicate string:type == "XCUIElementTypeTextView" AND visible == 1',
        ], 1_500);
        if (field) await field.click();
    }
    await driver.pause(350);

    // Wipe a seeded "#" / leftover hashtag-mode text before inserting.
    if (field) {
        try { await field.clearValue(); } catch { /* TikTok often rejects clear */ }
    }
    for (let i = 0; i < 16; i += 1) {
        await driver.keys(['Backspace']);
    }

    await typeText(driver, caption);
    console.log(`Caption pasted (${caption.length} chars)`);
    await driver.pause(400);

    // If hashtag mode still won, rewrite without paste.
    if (field) {
        const raw = String(
            await field.getAttribute('value').catch(() => '')
            || await field.getText().catch(() => '')
            || '',
        );
        const shown = raw.replace(/\uFFFC/g, '').trimStart();
        if (shown.startsWith('#') && !caption.trimStart().startsWith('#')) {
            console.log(`Stray leading # in caption (${JSON.stringify(raw)}); clearing and setValue`);
            try { await field.clearValue(); } catch { /* */ }
            for (let i = 0; i < 24; i += 1) await driver.keys(['Backspace']);
            await field.setValue(caption);
            await driver.pause(300);
            const again = String(
                await field.getAttribute('value').catch(() => '')
                || await field.getText().catch(() => '')
                || '',
            ).replace(/\uFFFC/g, '').trimStart();
            if (again.startsWith('#') && !caption.trimStart().startsWith('#')) {
                // Cursor is after the seeded # — delete it, then re-paste.
                console.log('setValue still seeded #; backspacing hash then pasting');
                await driver.keys(['Home']); // may no-op on iOS
                for (let i = 0; i < again.length + 4; i += 1) await driver.keys(['Backspace']);
                await typeText(driver, caption);
            }
        }
    }

    await driver.pause(400);
    // Do NOT tap top-left "Back" — on the caption screen that chevron leaves the
    // composer and dumps the post into Drafts. Dismiss the keyboard instead.
    try {
        await driver.hideKeyboard();
        console.log('Keyboard dismissed via hideKeyboard');
    } catch {
        await tapCoordinate(driver, 200, 180, 'dismiss keyboard (tap chrome-safe area)');
    }
    await driver.pause(800);
    console.log('Caption added');
}

async function tapPublishOrDraft(
    driver: Browser,
    remote: WdaRemoteControl,
    udid: string,
    coordinates: TikTokCoordinates['tiktok'],
    destination: 'draft' | 'publish',
): Promise<void> {
    await savePostDebugScreenshot(remote, udid, 'before-publish');
    if (destination === 'publish') {
        // Current TikTok publish form: red Post is top-right. Prefer that tap —
        // a11y "Post" is flaky / sometimes matches other chrome while keyboard
        // is still collapsing.
        console.log(`Tapping Post at (${coordinates.finish.x}, ${coordinates.finish.y})`);
        await tapCoordinate(driver, coordinates.finish.x, coordinates.finish.y, 'Post');
        await driver.pause(1200);
        // Second chance if first tap hit while keyboard was still up.
        try {
            const stillThere = await firstDisplayedQuick(driver, [
                '~Post',
                '-ios predicate string:(label == "Post" OR name == "Post") AND visible == 1',
                '-ios class chain:**/XCUIElementTypeButton[`label == "Post"`]',
            ], 1_200);
            if (stillThere) {
                console.log('Post still visible — tapping again');
                await stillThere.click();
                await driver.pause(800);
            }
        } catch { /* already navigated away */ }
        console.log('TikTok post submitted');
        await savePostDebugScreenshot(remote, udid, 'after-publish');
        // Upload continues in the background — tearing down too soon can interrupt it.
        await driver.pause(60_000);
    } else {
        try {
            await clickOne(driver, 'Drafts', [
                '~Drafts',
                '~Save draft',
                '-ios predicate string:(label CONTAINS[c] "Draft") AND visible == 1',
            ]);
        } catch {
            await tapCoordinate(driver, coordinates.draft.x, coordinates.draft.y, 'Drafts');
        }
        console.log('TikTok draft saved');
        await driver.pause(2500);
    }
}

const manifestPath = process.argv[2];
if (!manifestPath) throw new Error('A post manifest path is required');
const manifest = JSON.parse(await readFile(path.resolve(manifestPath), 'utf8')) as PostManifest;

const switchAccountName = manifest.account?.trim() || undefined;
const registeredDevice = (await loadRegisteredDevices()).find((device) => device.udid === manifest.device.udid);
const coordinates = resolveDeviceCoordinates(coordinateProfile(registeredDevice), registeredDevice?.coordinates);
const tiktokCoordinates = coordinates.tiktok;
const accountSwitchCoords = {
    profileTabX: tiktokCoordinates.profileTab.x,
    profileTabY: tiktokCoordinates.profileTab.y,
    switcherTriggerX: tiktokCoordinates.accountSwitcher.x,
    switcherTriggerY: tiktokCoordinates.accountSwitcher.y,
};
// Fail fast, before unlocking or launching TikTok, if the requested account
// isn't one this device is registered for.
const allowedAccounts = switchAccountName
    ? registeredAccounts(registeredDevice)
    : [];
if (switchAccountName && !allowedAccounts.includes(switchAccountName)) {
    throw new Error(`TikTok account "${switchAccountName}" is not listed in devices.json for device ${manifest.device.udid}`);
}

const deviceRemote = new WdaRemoteControl({
    deviceUdid: manifest.device.udid,
    passcodeKeypadLayout: coordinates.passcodeKeypad,
});
console.log('Checking device lock state');
await deviceRemote.unlock(manifest.device.udid);

const assetCount = await importMedia(manifest);

const bundleId = process.env.TIKTOK_BUNDLE_ID ?? 'com.zhiliaoapp.musically';
const capabilities: WebdriverIO.Capabilities & Record<string, unknown> = {
    platformName: 'iOS', 'appium:automationName': 'XCUITest', 'appium:udid': manifest.device.udid,
    'appium:bundleId': bundleId, 'appium:noReset': true, 'appium:forceAppLaunch': true,
    'appium:shouldTerminateApp': true, 'appium:newCommandTimeout': 180,
    'appium:waitForIdleTimeout': 0,
};
if (process.env.WDA_URL) {
    capabilities['appium:webDriverAgentUrl'] = process.env.WDA_URL;
    capabilities['appium:wdaRemotePort'] = positiveInteger('WDA_REMOTE_PORT', 8100);
}

// The composer/picker flow (up to the caption screen) is the fragile part —
// flaky picker checkboxes, transient tooltips, TikTok UI timing — so it gets
// retried with a fresh app relaunch on failure. Caption entry and the final
// Post/Drafts tap are NOT retried: retrying after that risks a duplicate
// post or draft, which is worse than a single clean failure.
const REACH_CAPTION_SCREEN_ATTEMPTS = 3;
let driver: Browser | undefined;
let reachedCaptionScreen = false;
let lastAttemptError: unknown;

for (let attempt = 1; attempt <= REACH_CAPTION_SCREEN_ATTEMPTS && !reachedCaptionScreen; attempt += 1) {
    if (attempt > 1) {
        console.log(`Retrying up to the caption screen (attempt ${attempt}/${REACH_CAPTION_SCREEN_ATTEMPTS})`);
    }
    try {
        driver = await remote({ hostname: process.env.APPIUM_HOST ?? '127.0.0.1', port: positiveInteger('APPIUM_PORT', 4725), path: '/', logLevel: 'info', connectionRetryCount: 0, connectionRetryTimeout: 180000, capabilities });
        await driver.setTimeout({ implicit: 0 });
        await driver.updateSettings({
            defaultActiveApplication: bundleId,
            // Post owns the phone — starve MJPEG harder than warmup defaults
            // so a leftover Live Control client cannot stall WDA.
            mjpegServerScreenshotQuality: Number(process.env.POST_MJPEG_QUALITY ?? 15),
            mjpegScalingFactor: Number(process.env.POST_MJPEG_SCALING ?? 25),
            mjpegServerFramerate: Number(process.env.POST_MJPEG_FRAMERATE ?? 2),
            screenshotQuality: 1,
        });
        if (switchAccountName) {
            console.log(`Switching to TikTok account "${switchAccountName}"`);
            await driver.pause(2000);
            try {
                await switchTikTokAccount(driver, deviceRemote, manifest.device.udid, switchAccountName, accountSwitchCoords);
            } catch (error) {
                // Profile/switcher coords are often uncalibrated; blocking Create
                // here aborts the whole draft. Continue on the already-open account.
                console.warn(
                    `Account switch skipped (${error instanceof Error ? error.message : String(error)}). `
                    + 'Continuing with the currently signed-in TikTok account.',
                );
            }
        }
        await openComposer(driver, deviceRemote, manifest.device.udid, tiktokCoordinates, coordinates.screenSize, manifest.musicUrl);
        await chooseRecentMedia(driver, deviceRemote, manifest.device.udid, manifest.files, assetCount, tiktokCoordinates);
        reachedCaptionScreen = true;
    } catch (error) {
        lastAttemptError = error;
        console.error(`Attempt ${attempt}/${REACH_CAPTION_SCREEN_ATTEMPTS} failed before reaching the caption screen: ${error instanceof Error ? error.message : String(error)}`);
        if (driver) {
            await driver.deleteSession().catch(() => {});
            driver = undefined;
        }
    }
}

if (!reachedCaptionScreen || !driver) {
    throw lastAttemptError instanceof Error
        ? lastAttemptError
        : new Error(`Could not reach the TikTok caption screen after ${REACH_CAPTION_SCREEN_ATTEMPTS} attempts`);
}

try {
    await addCaption(driver, tiktokCoordinates, manifest.caption);
    await tapPublishOrDraft(driver, deviceRemote, manifest.device.udid, tiktokCoordinates, manifest.destination);
} finally {
    await driver.deleteSession();
}
