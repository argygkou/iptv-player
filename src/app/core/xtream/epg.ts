import { EpgListing, GuideProgramme, LiveStream, Programme } from './xtream.models';

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

/** What is on at `now` and the first programme after it, from a list in any order. */
export function nowAndNext(
  programmes: Programme[],
  now: Date,
): { current?: Programme; next?: Programme } {
  const current = programmes.find((p) => isAiring(p, now));
  const next = programmes
    .filter((p) => p.start > now)
    .reduce<Programme | undefined>((a, b) => (a && a.start <= b.start ? a : b), undefined);
  return { current, next };
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

export function fromGuide(programme: GuideProgramme): Programme {
  return {
    title: programme.title,
    description: programme.description,
    start: new Date(programme.start * 1000),
    end: new Date(programme.end * 1000),
  };
}

const DAY = 24 * 60 * 60 * 1000;
/** The relay asks for at most a day of recording. */
const MAX_CATCHUP_MINUTES = 24 * 60;

/** How many days of recordings the channel keeps; 0 without catch-up. */
export function archiveDays(stream: LiveStream): number {
  if (Number(stream.tv_archive) !== 1) {
    return 0;
  }
  const days = Number(stream.tv_archive_duration);
  // Panels that record but leave the duration out usually keep a few days.
  return Number.isFinite(days) && days > 0 ? days : 3;
}

/** Whether the programme has started and is still within the channel's archive. */
export function canCatchUp(stream: LiveStream, programme: Programme, now: Date): boolean {
  const days = archiveDays(stream);
  return (
    days > 0 && programme.start <= now && programme.start.getTime() >= now.getTime() - days * DAY
  );
}

/** Length to ask the panel for, in whole minutes. */
export function catchupMinutes(programme: Programme): number {
  const minutes = Math.ceil((programme.end.getTime() - programme.start.getTime()) / 60_000);
  return Math.min(MAX_CATCHUP_MINUTES, Math.max(1, minutes));
}

/**
 * `date` as `YYYY-MM-DD:HH-MM` in the panel's time zone (`server_info.timezone`),
 * which is how Xtream timeshift URLs name a start time. Falls back to UTC for
 * a zone the webview does not know.
 */
export function panelTime(date: Date, timeZone: string | undefined): string {
  let format: Intl.DateTimeFormat;
  try {
    format = new Intl.DateTimeFormat('en-GB', {
      timeZone: timeZone || 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
  } catch {
    return panelTime(date, 'UTC');
  }
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    format.formatToParts(date).find((p) => p.type === type)?.value ?? '00';
  return `${part('year')}-${part('month')}-${part('day')}:${part('hour')}-${part('minute')}`;
}
