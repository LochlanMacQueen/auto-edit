import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import sharp from 'sharp';

import { loadRegisteredDevices, resolveDeviceCoordinates, WdaRemoteControl } from '@git-agni/phone-farm-core';
import { coordinateProfile } from '../instagram/runtime-settings.js';
import { recognizeWords, type OcrWord } from '../instagram/ocr.js';
import { classifyHingeScreen, type HingeScreen } from './screen.js';

/**
 * Hinge shadow mode: the agent never taps. It watches the screen while the
 * operator swipes by hand and records, per profile, every distinct frame they
 * looked at plus the decision they made — "like" if the like sheet was opened
 * before the next profile appeared, otherwise "pass". The result is the
 * labelled dataset the preference model is briefed from.
 *
 *   data/hinge/shadow/<session>/<n>-<name>/frame-XX.png
 *   data/hinge/shadow/<session>/<n>-<name>/meta.json
 *   data/hinge/shadow/<session>/session.jsonl   (one line per finished profile)
 */

const udid = process.env.IOS_UDID;
if (!udid) throw new Error('IOS_UDID is required');
const wdaUrl = process.env.WDA_URL;
const pollMs = Number(process.env.HINGE_SHADOW_POLL_MS ?? 800);
/** Mean per-pixel difference (0-255) below which two frames count as the same view. */
const frameDiffThreshold = Number(process.env.HINGE_SHADOW_FRAME_DIFF ?? 6);
const outRoot = process.env.HINGE_SHADOW_DIR ?? path.resolve('data', 'hinge', 'shadow');

const registeredDevice = (await loadRegisteredDevices()).find((device) => device.udid === udid);
const coordinates = resolveDeviceCoordinates(coordinateProfile(registeredDevice), undefined, 'instagram');
const remote = new WdaRemoteControl({
    deviceUdid: udid,
    ...(wdaUrl ? { wdaUrl } : {}),
    passcodeKeypadLayout: coordinates.passcodeKeypad,
});

const { scale } = await remote.getScreenInfo(udid);
const sessionId = new Date().toISOString().replace(/[:.]/g, '-');
const sessionDir = path.join(outRoot, sessionId);
await mkdir(sessionDir, { recursive: true });
console.log(`Hinge shadow session ${sessionId} → ${sessionDir}`);
console.log('Swipe on the phone as you normally would. Ctrl+C to stop.');

interface Frame { file: string; kind: HingeScreen['kind']; text: string; at: string }
interface Profile {
    index: number;
    name: string;
    dir: string;
    startedAt: string;
    frames: Frame[];
    likeSheetSeen: boolean;
    lastThumb?: Buffer;
}

let current: Profile | undefined;
let profileCount = 0;
let pendingName: { name: string; seen: number } | undefined;
let stopping = false;
process.on('SIGINT', () => { stopping = true; });
process.on('SIGTERM', () => { stopping = true; });

function safeName(name: string): string {
    return name.replace(/[^\p{L}\p{N}]+/gu, '_').slice(0, 30) || 'unknown';
}

async function thumbnail(image: Buffer): Promise<Buffer> {
    return sharp(image).resize(39, 84, { fit: 'fill' }).grayscale().raw().toBuffer();
}

function meanDiff(a: Buffer, b: Buffer): number {
    let total = 0;
    for (let i = 0; i < a.length; i += 1) total += Math.abs(a[i]! - b[i]!);
    return total / a.length;
}

async function finalize(profile: Profile, decision: 'like' | 'pass' | 'unknown'): Promise<void> {
    const meta = {
        index: profile.index,
        name: profile.name,
        decision,
        likeSheetSeen: profile.likeSheetSeen,
        startedAt: profile.startedAt,
        endedAt: new Date().toISOString(),
        frames: profile.frames,
    };
    await writeFile(path.join(profile.dir, 'meta.json'), `${JSON.stringify(meta, null, 1)}\n`);
    await writeFile(path.join(sessionDir, 'session.jsonl'), `${JSON.stringify({ ...meta, frames: meta.frames.length })}\n`, { flag: 'a' });
    console.log(`#${profile.index} ${profile.name}: ${decision.toUpperCase()} (${profile.frames.length} frames)`);
}

async function startProfile(name: string): Promise<Profile> {
    profileCount += 1;
    const dir = path.join(sessionDir, `${String(profileCount).padStart(3, '0')}-${safeName(name)}`);
    await mkdir(dir, { recursive: true });
    console.log(`#${profileCount} ${name} — watching`);
    return { index: profileCount, name, dir, startedAt: new Date().toISOString(), frames: [], likeSheetSeen: false };
}

async function recordFrame(profile: Profile, image: Buffer, screen: HingeScreen, words: OcrWord[]): Promise<void> {
    const thumb = await thumbnail(image);
    if (profile.lastThumb && meanDiff(profile.lastThumb, thumb) < frameDiffThreshold) return;
    profile.lastThumb = thumb;
    const file = `frame-${String(profile.frames.length + 1).padStart(2, '0')}.png`;
    await writeFile(path.join(profile.dir, file), image);
    profile.frames.push({
        file,
        kind: screen.kind,
        text: words.map((word) => word.text).join(' '),
        at: new Date().toISOString(),
    });
}

while (!stopping) {
    const tick = Date.now();
    try {
        const image = await remote.getScreenshot(udid);
        const words = await recognizeWords(image);
        const screen = classifyHingeScreen(words, { scale });

        if (screen.kind === 'like-sheet' && current) {
            current.likeSheetSeen = true;
            await recordFrame(current, image, screen, words);
        } else if (screen.kind === 'discover' && screen.name) {
            // Names must be read twice in a row before we trust an OCR change.
            if (!current || screen.name !== current.name) {
                if (pendingName?.name === screen.name) pendingName.seen += 1;
                else pendingName = { name: screen.name, seen: 1 };
                if (pendingName.seen >= 2) {
                    if (current) await finalize(current, current.likeSheetSeen ? 'like' : 'pass');
                    current = await startProfile(screen.name);
                    pendingName = undefined;
                }
            } else {
                pendingName = undefined;
            }
            if (current && screen.name === current.name) await recordFrame(current, image, screen, words);
        }
    } catch (error) {
        console.warn(`poll failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    const elapsed = Date.now() - tick;
    if (elapsed < pollMs) await new Promise((resolve) => setTimeout(resolve, pollMs - elapsed));
}

if (current) await finalize(current, 'unknown');
console.log(`Shadow session finished: ${profileCount} profiles in ${sessionDir}`);
