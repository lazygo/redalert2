/**
 * Flat MIX layout helpers for the client.
 * Nested packs are produced by the Go mixcache (`data/mix-cache`, served as /mix-cache/).
 * Source of truth for extract lists lives in internal/mix/extract.go.
 */

/** Required on RFS to treat layout as flat (ra2.mix parent not needed). */
export const FLAT_REQUIRED_FOR_DETECT = [
    "language.mix",
    "multi.mix",
    "conquer.mix",
    "local.mix",
    "cache.mix",
    "audio.mix",
    "generic.mix",
] as const;

/** Large flat mixes that should use LazyMixFile when available as File. */
export const FLAT_LAZY_MIXES = new Set<string>([
    "cache.mix",
    "load.mix",
    "local.mix",
    "neutral.mix",
    "audio.mix",
    "conquer.mix",
    "generic.mix",
    "isogen.mix",
    "cameo.mix",
    "cameocd.mix",
    "isotemp.mix",
    "temperat.mix",
    "tem.mix",
    "isosnow.mix",
    "snow.mix",
    "sno.mix",
    "isourb.mix",
    "urb.mix",
    "urban.mix",
    "sidec01.mix",
    "sidec02.mix",
    "sidec01cd.mix",
    "sidec02cd.mix",
    "multi.mix",
    "language.mix",
]);

export function isFlatLayoutReady(entryNames: Iterable<string>): boolean {
    const lower = new Set([...entryNames].map((e) => e.toLowerCase()));
    return FLAT_REQUIRED_FOR_DETECT.every((name) => lower.has(name.toLowerCase()));
}
