import { EpgListing, Programme } from './xtream.models';

/** Xtream sends EPG text as base64-encoded UTF-8. Falls back to the raw value. */
export function decodeBase64Utf8(value: string | null | undefined): string {
  if (!value) {
    return '';
  }
  try {
    const bytes = Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return value;
  }
}

export function toProgramme(listing: EpgListing): Programme {
  return {
    title: decodeBase64Utf8(listing.title),
    description: decodeBase64Utf8(listing.description),
    start: new Date(Number(listing.start_timestamp) * 1000),
    end: new Date(Number(listing.stop_timestamp) * 1000),
  };
}

export function isAiring(programme: Programme, now: Date): boolean {
  return programme.start <= now && now < programme.end;
}

/** Fraction of the programme already aired, clamped to 0..1. */
export function progress(programme: Programme, now: Date): number {
  const total = programme.end.getTime() - programme.start.getTime();
  if (total <= 0) {
    return 0;
  }
  const elapsed = now.getTime() - programme.start.getTime();
  return Math.min(1, Math.max(0, elapsed / total));
}
