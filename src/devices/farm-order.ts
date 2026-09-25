/**
 * Farm seat order from the operator-facing device name.
 * "#1" / "Farm 1" / "1st" → 1. Unnumbered devices sort last.
 * Does not treat model names like "iPhone 17 Pro" as farm seats.
 */
export function farmOrderIndex(name: string): number {
    const patterns = [
        /#\s*(\d+)/,
        /\bfarm\s*#?\s*(\d+)/i,
        /\bphone\s+farm\s*#?\s*(\d+)/i,
        /\b(\d+)(?:st|nd|rd|th)\s+(?:iphone|phone|device)\b/i,
        /^(?:iphone|phone)?\s*#?\s*(\d+)\s*[-–:]/i,
    ];
    for (const pattern of patterns) {
        const match = name.match(pattern);
        if (match?.[1]) {
            const value = Number(match[1]);
            if (Number.isInteger(value) && value > 0 && value < 100) return value;
        }
    }
    return Number.MAX_SAFE_INTEGER;
}

/** Zero-based stagger slot: farm #1 → 0, #2 → 1, unnumbered → after numbered peers. */
export function farmStaggerSlot(name: string, rankedNames: string[]): number {
    const index = farmOrderIndex(name);
    if (index !== Number.MAX_SAFE_INTEGER) return Math.max(0, index - 1);
    const ordered = [...rankedNames].sort((a, b) => {
        const diff = farmOrderIndex(a) - farmOrderIndex(b);
        return diff !== 0 ? diff : a.localeCompare(b);
    });
    const position = ordered.indexOf(name);
    return position < 0 ? ordered.length : position;
}

export function shiftLocalTime(localTime: string, offsetMinutes: number): string {
    const match = /^(?:[01]\d|2[0-3]):[0-5]\d$/.exec(localTime);
    if (!match) throw new Error('localTime must use HH:mm');
    const [hour, minute] = localTime.split(':').map(Number);
    const total = (((hour! * 60 + minute! + offsetMinutes) % (24 * 60)) + (24 * 60)) % (24 * 60);
    return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}
