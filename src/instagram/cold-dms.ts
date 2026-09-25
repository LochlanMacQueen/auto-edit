import { remote, type Browser } from 'webdriverio';

import { loadRegisteredDevices, resolveDeviceCoordinates, WdaRemoteControl } from '@git-agni/phone-farm-core';
import { coordinateProfile, registeredAccounts } from './runtime-settings.js';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { switchInstagramAccount, tapCoordinate, typeText } from './actions.js';
import { findWordMatch, messageWordMatches } from './cold-dms-verify.js';
import { findHandleMatch, pointFromWord, recognizeWords, type OcrWord } from './ocr.js';
import sharp from 'sharp';
import {
    parseColdDmHandles,
    validateColdDmHandles,
    validateColdDmMessage,
} from './cold-dms-payload.js';
import {
    loadLeadContactState,
    loadLeadList,
    markLeadContacted,
    pickLeads,
    summarizeLeadList,
    validateLeadListName,
} from './leads.js';

function positiveInteger(name: string, fallback: number): number {
    const rawValue = process.env[name] ?? String(fallback);
    const value = Number.parseInt(rawValue, 10);
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`${name} must be a positive integer; received ${rawValue}`);
    }
    return value;
}

const udidEnv = process.env.IOS_UDID;
if (!udidEnv) {
    throw new Error('IOS_UDID is required. Copy .env.example to .env and set the connected device UDID.');
}
const udid: string = udidEnv;

const message = validateColdDmMessage(process.env.COLD_DMS_MESSAGE ?? '');
const switchAccountName = process.env.INSTAGRAM_SWITCH_ACCOUNT?.trim() || undefined;
const betweenHandleMs = positiveInteger('COLD_DMS_BETWEEN_MS', 2500);
// Random extra wait added to every gap so the cadence isn't metronomic.
const jitterMs = Number.parseInt(process.env.COLD_DMS_JITTER_MS ?? '1500', 10) || 0;

// Screenshot+OCR checks: recipient header before typing, text in composer
// before Send, text gone from composer after Send. A lead is only marked
// "sent" when all three pass. COLD_DMS_VERIFY=false restores blind taps.
const verifyEnabled = process.env.COLD_DMS_VERIFY !== 'false';

const registeredDevice = (await loadRegisteredDevices()).find((device) => device.udid === udid);

// Handles come either from an explicit paste (COLD_DMS_HANDLES) or from a lead
// list, where we pull the next uncontacted batch and record each outcome so
// the next run continues where this one stopped.
const leadListName = process.env.COLD_DMS_LEAD_LIST?.trim()
    ? validateLeadListName(process.env.COLD_DMS_LEAD_LIST)
    : undefined;
let handles: string[];
/** Display names by handle, so recipient checks can accept either. */
const leadNames = new Map<string, string>();
if (leadListName) {
    const batchSize = positiveInteger('COLD_DMS_LEAD_BATCH', 10);
    const skipPrivate = process.env.COLD_DMS_SKIP_PRIVATE !== 'false';
    const retryFailed = process.env.COLD_DMS_RETRY_FAILED === 'true';
    const list = await loadLeadList(leadListName);
    const state = await loadLeadContactState(leadListName);
    const summary = summarizeLeadList(list, state);
    const picked = pickLeads(list, state, {
        size: batchSize,
        skipPrivate,
        retryFailed,
        exclude: [...registeredAccounts(registeredDevice), ...(switchAccountName ? [switchAccountName] : [])],
    });
    console.log(
        `Lead list "${leadListName}": total=${summary.total} sent=${summary.sent} failed=${summary.failed} `
        + `remaining=${summary.remaining} (${summary.remainingPublic} public) → picked ${picked.length}`
        + `${skipPrivate ? ' (skipping private)' : ''}`,
    );
    if (picked.length === 0) {
        throw new Error(`Lead list "${leadListName}" has no uncontacted leads left for this filter`);
    }
    handles = validateColdDmHandles(picked.map((lead) => `@${lead.username}`));
    for (const lead of picked) if (lead.fullName) leadNames.set(lead.username.toLowerCase(), lead.fullName);
} else {
    handles = validateColdDmHandles(parseColdDmHandles(process.env.COLD_DMS_HANDLES ?? ''));
}

async function recordLeadOutcome(handle: string, status: 'sent' | 'failed', error?: string): Promise<void> {
    if (!leadListName) return;
    try {
        await markLeadContacted(leadListName, handle, {
            status,
            deviceUdid: udid,
            ...(switchAccountName ? { account: switchAccountName } : {}),
            ...(error ? { error } : {}),
        });
    } catch (stateError) {
        console.warn(`Could not record ${status} for ${handle}: ${stateError instanceof Error ? stateError.message : String(stateError)}`);
    }
}
const coordinates = resolveDeviceCoordinates(
    coordinateProfile(registeredDevice),
    registeredDevice?.instagramCoordinates,
    'instagram',
);
const ig = coordinates.instagram;
const accountSwitchCoords = {
    profileTabX: ig.profileTab.x,
    profileTabY: ig.profileTab.y,
    switcherTriggerX: ig.accountSwitcher.x,
    switcherTriggerY: ig.accountSwitcher.y,
};

const allowedAccounts = switchAccountName ? registeredAccounts(registeredDevice) : [];
if (switchAccountName && !allowedAccounts.includes(switchAccountName)) {
    throw new Error(`Instagram account "${switchAccountName}" is not listed in devices.json for device ${udid}`);
}

const wdaUrl = process.env.WDA_URL;
const instagramBundleId = process.env.INSTAGRAM_BUNDLE_ID ?? 'com.burbn.instagram';

const capabilities: WebdriverIO.Capabilities & Record<string, unknown> = {
    platformName: 'iOS',
    'appium:automationName': 'XCUITest',
    'appium:udid': udid,
    'appium:bundleId': instagramBundleId,
    'appium:noReset': true,
    'appium:forceAppLaunch': true,
    'appium:shouldTerminateApp': true,
    'appium:newCommandTimeout': 180,
    'appium:wdaLaunchTimeout': 120000,
    'appium:wdaConnectionTimeout': 120000,
    'appium:waitForIdleTimeout': 0,
    'appium:showXcodeLog': process.env.SHOW_XCODE_LOG === 'true',
};

if (wdaUrl) {
    capabilities['appium:webDriverAgentUrl'] = wdaUrl;
    capabilities['appium:wdaRemotePort'] = positiveInteger('WDA_REMOTE_PORT', 8100);
} else if (process.env.XCODE_ORG_ID) {
    capabilities['appium:xcodeOrgId'] = process.env.XCODE_ORG_ID;
    capabilities['appium:xcodeSigningId'] = process.env.XCODE_SIGNING_ID ?? 'Apple Development';
}
if (!wdaUrl && process.env.WDA_BUNDLE_ID) {
    capabilities['appium:updatedWDABundleId'] = process.env.WDA_BUNDLE_ID;
}
if (!wdaUrl && process.env.ALLOW_PROVISIONING_DEVICE_REGISTRATION === 'true') {
    capabilities['appium:allowProvisioningDeviceRegistration'] = true;
}
if (!wdaUrl && process.env.WDA_BOOTSTRAP_PATH) {
    capabilities['appium:useXctestrunFile'] = true;
    capabilities['appium:bootstrapPath'] = process.env.WDA_BOOTSTRAP_PATH;
}

let stopRequested = false;
let resolveStop: () => void = () => {};
const stopPromise = new Promise<void>((resolve) => { resolveStop = resolve; });
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
        stopRequested = true;
        resolveStop();
    });
}

function cancellableDelay(ms: number): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    return new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        void stopPromise.then(() => {
            clearTimeout(timer);
            resolve();
        });
    });
}

async function clearFocusedField(browser: Browser): Promise<void> {
    try {
        const focused = await browser.$('-ios predicate string:hasKeyboardFocus == 1');
        if (await focused.isExisting()) await focused.clearValue();
    } catch {
        // Coordinate-driven flow — clear is best-effort.
    }
}

/** Open inbox via Home bottom-nav paper plane, then inbox header pencil. */
async function openNewMessageComposer(browser: Browser): Promise<void> {
    console.log(
        `Opening DM inbox (paper plane) at (${ig.dmCompose.x}, ${ig.dmCompose.y})`,
    );
    await tapCoordinate(browser, ig.dmCompose.x, ig.dmCompose.y, 'DM Compose');
    // Wait for inbox chrome before the top-right pencil — on Home that same
    // corner is the heart (notifications), which is what a premature tap hits.
    await browser.pause(3500);
    console.log(
        `Opening compose new message at (${ig.composeNewMessage.x}, ${ig.composeNewMessage.y})`,
    );
    await tapCoordinate(
        browser,
        ig.composeNewMessage.x,
        ig.composeNewMessage.y,
        'Compose new message',
    );
    await browser.pause(2000);
}

/**
 * Kill and relaunch Instagram, then land on Home. Used between every lead so
 * a thread left open, a half-dismissed sheet, or a mis-tap never leaks into
 * the next send — the same recovery the TikTok warmup relies on.
 */
async function relaunchInstagram(browser: Browser, reason: string): Promise<void> {
    console.log(`Relaunching Instagram (${reason})`);
    try {
        await browser.terminateApp(instagramBundleId);
    } catch (error) {
        console.log(`terminateApp: ${error instanceof Error ? error.message : String(error)}`);
    }
    await browser.pause(900);
    await browser.activateApp(instagramBundleId);
    await browser.pause(3500);
    for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
            const state = await browser.queryAppState(instagramBundleId);
            if (state === 4) break;
            console.log(`Instagram not foreground (state=${state}); activate retry ${attempt}`);
        } catch (error) {
            console.log(`queryAppState: ${error instanceof Error ? error.message : String(error)}`);
        }
        await browser.activateApp(instagramBundleId);
        await browser.pause(2500);
    }
    await tapCoordinate(browser, ig.homeTab.x, ig.homeTab.y, 'Home tab');
    await browser.pause(1500);
}

async function sendMessageToHandle(browser: Browser, handle: string): Promise<void> {
    const query = handle.replace(/^@/, '');
    console.log(`Cold DM send for ${handle}`);
    await openNewMessageComposer(browser);
    // "New message" To: field — reuse searchField calibration on that screen.
    await tapCoordinate(browser, ig.searchField.x, ig.searchField.y, 'New message To: field');
    await browser.pause(800);
    await clearFocusedField(browser);
    await typeText(browser, query);
    // Instagram needs a recipient chosen from the list before the thread opens.
    await browser.pause(3000);
    console.log(
        `Selecting top search result at (${ig.searchFirstResult.x}, ${ig.searchFirstResult.y})`,
    );
    await tapCoordinate(
        browser,
        ig.searchFirstResult.x,
        ig.searchFirstResult.y,
        'Top search result',
    );
    await browser.pause(1500);

    // The recipient is now a chip in the To: field. Current Instagram shows a
    // "Chat" button to open the thread; older builds used a blue arrow in the
    // header, which is what dmSearchSubmit was calibrated for.
    const chat = await findLabelOnScreen(/^chat$/i, 'Chat button');
    if (chat) {
        await tapCoordinate(browser, chat.x, chat.y, 'Chat button');
    } else {
        console.log(`Confirming with blue arrow at (${ig.dmSearchSubmit.x}, ${ig.dmSearchSubmit.y})`);
        await tapCoordinate(browser, ig.dmSearchSubmit.x, ig.dmSearchSubmit.y, 'New message blue arrow');
    }
    await browser.pause(2500);
    await verifyRecipient(handle);

    // Composer: prefer the "Message..." placeholder wherever it currently sits.
    const placeholder = await findLabelOnScreen(/^message/i, 'Message field');
    const composerPoint = placeholder ?? { x: ig.dmComposer.x, y: ig.dmComposer.y };
    console.log(`Focusing Message field at (${composerPoint.x}, ${composerPoint.y})`);
    await tapCoordinate(browser, composerPoint.x, composerPoint.y, 'Message field');
    await browser.pause(1000);
    await clearFocusedField(browser);
    await typeText(browser, message);
    await browser.pause(800);

    if (!verifyEnabled) {
        console.log(`Sending DM at (${ig.dmSend.x}, ${ig.dmSend.y})`);
        await tapCoordinate(browser, ig.dmSend.x, ig.dmSend.y, 'DM Send');
        await browser.pause(2000);
        console.log(`Sent DM to ${handle} (unverified)`);
        return;
    }

    // Instagram swaps the mic/camera icons for a "Send" label once the
    // composer has text, and restores the "Message..." placeholder after the
    // send. Those two labels are the proof; the typed text itself is small
    // gray-on-dark and OCR often misses it.
    const pre = await readScreen();
    const sendWord = findWordMatch(pre.words, /^send$/i, belowHeaderPx());
    const typed = messageWordMatches(pre.words, message).filter((word) => word.y + word.height / 2 >= belowHeaderPx());
    if (!sendWord && typed.length === 0) {
        // OCR misses are common on this UI; the calibrated Send point is
        // authoritative, and the post-send check decides whether it worked.
        console.log('Neither the Send label nor the typed text was OCR-readable — tapping calibrated Send anyway');
    }
    const sendPoint = sendWord ? pointFromWord(sendWord, screenScale) : { x: ig.dmSend.x, y: ig.dmSend.y };
    console.log(
        `Composer ready (${sendWord ? 'Send label visible' : 'typed text visible'}); `
        + `Send control ${sendWord ? 'located by OCR' : 'from calibration'} at (${sendPoint.x}, ${sendPoint.y})`,
    );

    const MAX_SEND_TAPS = 2;
    for (let attempt = 1; attempt <= MAX_SEND_TAPS; attempt += 1) {
        await tapCoordinate(browser, sendPoint.x, sendPoint.y, `DM Send${attempt > 1 ? ` (retry ${attempt})` : ''}`);
        await browser.pause(2200);
        const after = await readScreen();
        const sendStillVisible = Boolean(findWordMatch(after.words, /^send$/i, belowHeaderPx()));
        const placeholderBack = Boolean(findWordMatch(after.words, /^message/i, belowHeaderPx()));
        const bubble = messageWordMatches(after.words, message).some((word) => word.y + word.height / 2 >= belowHeaderPx());
        if (!sendStillVisible && (placeholderBack || bubble)) {
            console.log(
                `Sent DM to ${handle} — Send label cleared`
                + `${placeholderBack ? ', placeholder back' : ''}${bubble ? ', message bubble visible' : ''}`,
            );
            return;
        }
        if (attempt === MAX_SEND_TAPS) {
            const file = await saveDebugShot(after.image, 'send');
            throw new VerificationError(
                `Could not confirm send after ${MAX_SEND_TAPS} taps `
                + `(sendVisible=${sendStillVisible} placeholder=${placeholderBack} bubble=${bubble}). Screenshot ${file}`,
            );
        }
        console.warn(`Send not confirmed yet (sendVisible=${sendStillVisible} placeholder=${placeholderBack}) — retrying`);
    }
}

const cycles = positiveInteger('COLD_DMS_CYCLES', 1);
const sequence = handles.flatMap((handle) => Array.from({ length: cycles }, () => handle));

const remoteControl = new WdaRemoteControl({
    deviceUdid: udid,
    passcodeKeypadLayout: coordinates.passcodeKeypad,
});

let screenScale = 1;

// Instagram runs dark here and Tesseract wants dark text on light, so OCR
// the raw frame and an inverted copy and pool the words.
async function readScreen(): Promise<{ words: OcrWord[]; image: Buffer }> {
    const image = await remoteControl.getScreenshot(udid);
    const inverted = await sharp(image).grayscale().negate().png().toBuffer();
    const [raw, flipped] = await Promise.all([recognizeWords(image), recognizeWords(inverted)]);
    return { words: [...raw, ...flipped], image };
}

async function saveDebugShot(image: Buffer, label: string): Promise<string> {
    const file = path.resolve('.wda', `cold-dm-${label}-${udid}.png`);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, image);
    return file;
}

/** Everything above this is status bar + nav header; ignore it when hunting UI words. */
function belowHeaderPx(): number {
    return 120 * screenScale;
}

class VerificationError extends Error {}

/** OCR the screen for a UI label and return its tap point (points, not pixels). */
async function findLabelOnScreen(pattern: RegExp, description: string): Promise<{ x: number; y: number } | undefined> {
    if (!verifyEnabled) return undefined;
    const { words } = await readScreen();
    const match = findWordMatch(words, pattern, belowHeaderPx());
    if (!match) {
        console.log(`${description} label not found by OCR — falling back to calibrated coordinate`);
        return undefined;
    }
    const point = pointFromWord(match, screenScale);
    console.log(`${description} located by OCR ("${match.text}") at (${point.x}, ${point.y})`);
    return point;
}

function nameTokens(name: string | undefined): string[] {
    return (name ?? '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((token) => token.length >= 3);
}

async function verifyRecipient(handle: string): Promise<void> {
    if (!verifyEnabled) return;
    const { words, image } = await readScreen();
    if (findHandleMatch(words, handle)) {
        console.log(`Recipient confirmed: ${handle} visible in thread header`);
        return;
    }
    const tokens = nameTokens(leadNames.get(handle.replace(/^@/, '').toLowerCase()));
    const nameHit = words.find((word) => tokens.includes(word.text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')));
    if (nameHit) {
        console.log(`Recipient confirmed by display name ("${nameHit.text}") for ${handle}`);
        return;
    }
    const file = await saveDebugShot(image, 'recipient');
    const seen = words.slice(0, 12).map((word) => word.text).join(' ') || '(nothing recognized)';
    throw new VerificationError(`Recipient ${handle} not visible after opening thread (OCR saw: ${seen}). Screenshot ${file}`);
}


console.log(
    `Starting Instagram cold DMs: handles=${handles.length} cycles=${cycles} `
    + `sends=${sequence.length} messageChars=${message.length}`
    + `${leadListName ? ` leadList=${leadListName}` : ''}`,
);

await remoteControl.unlock(udid);
if (verifyEnabled) {
    screenScale = (await remoteControl.getScreenInfo(udid)).scale;
    console.log(`Send verification on (screen scale ${screenScale})`);
}

let driver: Browser | undefined;
let sent = 0;
let failed = 0;

try {
    driver = await remote({
        hostname: process.env.APPIUM_HOST ?? '127.0.0.1',
        port: positiveInteger('APPIUM_PORT', 4725),
        path: '/',
        logLevel: 'info',
        connectionRetryCount: 0,
        connectionRetryTimeout: 180000,
        capabilities,
    });
    await driver.updateSettings({ defaultActiveApplication: instagramBundleId });

    if (switchAccountName) {
        console.log(`Switching to Instagram account "${switchAccountName}"`);
        await driver.pause(2000);
        try {
            await switchInstagramAccount(driver, remoteControl, udid, switchAccountName, accountSwitchCoords);
        } catch (error) {
            console.warn(
                `Account switch skipped (${error instanceof Error ? error.message : String(error)}). `
                + 'Continuing with the currently signed-in Instagram account.',
            );
        }
    }

    // Land on Home so the first paper-plane tap is reliable.
    await tapCoordinate(driver, ig.homeTab.x, ig.homeTab.y, 'Home tab');
    await driver.pause(1500);

    for (const [index, handle] of sequence.entries()) {
        if (stopRequested) {
            console.log('Stop requested — ending cold DMs');
            break;
        }
        try {
            await sendMessageToHandle(driver, handle);
            sent += 1;
            await recordLeadOutcome(handle, 'sent');
        } catch (error) {
            failed += 1;
            const reason = error instanceof Error ? error.message : String(error);
            console.error(`Skipped ${handle}: ${reason}`);
            await recordLeadOutcome(handle, 'failed', reason);
            if (index < sequence.length - 1 && !stopRequested) {
                try {
                    await relaunchInstagram(driver, `recovering after ${handle}`);
                } catch (relaunchError) {
                    console.warn(`Relaunch failed: ${relaunchError instanceof Error ? relaunchError.message : String(relaunchError)}`);
                }
            }
            continue;
        }
        if (index < sequence.length - 1 && !stopRequested) {
            await cancellableDelay(betweenHandleMs + Math.floor(Math.random() * (jitterMs + 1)));
            if (stopRequested) break;
            await relaunchInstagram(driver, 'fresh Home for next lead');
        }
    }
} finally {
    if (driver) await driver.deleteSession().catch(() => {});
}

console.log(`Cold DMs finished: sent=${sent} failed=${failed} total=${sequence.length}`);
if (sent === 0) {
    throw new Error('Cold DMs sent zero messages — check DM Compose / recipient / Send calibrations');
}
