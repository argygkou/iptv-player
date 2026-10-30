import { inject, Injectable, signal } from '@angular/core';

import { mapWithConcurrency } from '../../shared/concurrency';
import { XtreamApi } from './xtream-api';
import { LiveStream, Programme } from './xtream.models';

/** Short EPG costs a request per channel, so the fallback covers this many. */
const SHORT_EPG_CHANNELS = 60;
const SHORT_EPG_CONCURRENCY = 6;

/**
 * Programmes for channels, from the provider's full XMLTV guide. Channels the
 * guide does not cover (no `epg_channel_id`, or a panel without `xmltv.php`)
 * fall back to short EPG, which only lists what is on now and next.
 */
@Injectable({ providedIn: 'root' })
export class TvGuide {
  private readonly api = inject(XtreamApi);

  /** When the backend downloaded the guide; `null` until it has one. */
  readonly updatedAt = signal<Date | null>(null);
  /** Why the full guide could not be loaded, if it failed. */
  readonly error = signal<string | null>(null);
  /** Bumped by `refresh()`, so resources that list programmes reload. */
  readonly version = signal(0);

  /** Programmes overlapping `from`..`to`, by `stream_id`. */
  async programmes(
    streams: LiveStream[],
    from: Date,
    to: Date,
    abortSignal?: AbortSignal,
  ): Promise<Map<string, Programme[]>> {
    const result = new Map<string, Programme[]>();
    const ids = [...new Set(streams.flatMap((s) => s.epg_channel_id || []))];
    if (ids.length > 0) {
      try {
        const guide = await this.api.guide(ids, from, to);
        this.updatedAt.set(guide.updatedAt);
        this.error.set(null);
        for (const stream of streams) {
          const list = stream.epg_channel_id && guide.programmes.get(stream.epg_channel_id);
          if (list) {
            result.set(String(stream.stream_id), list);
          }
        }
      } catch (err) {
        this.error.set(String(err));
      }
    }

    // Short EPG starts at the current programme, so it only helps windows that include now.
    const now = Date.now();
    if (from.getTime() <= now && now < to.getTime()) {
      const missing = streams
        .filter((s) => !result.has(String(s.stream_id)))
        .slice(0, SHORT_EPG_CHANNELS);
      const lists = await mapWithConcurrency(
        missing,
        SHORT_EPG_CONCURRENCY,
        (stream) => this.api.shortEpg(stream.stream_id, 12).catch(() => [] as Programme[]),
        abortSignal,
      );
      missing.forEach((stream, i) => {
        const list = (lists[i] ?? []).filter((p) => p.end > from && p.start < to);
        if (list.length > 0) {
          result.set(String(stream.stream_id), list);
        }
      });
    }
    return result;
  }

  /** Downloads the guide again and reloads whatever lists programmes. */
  async refresh(): Promise<void> {
    const now = new Date();
    try {
      const guide = await this.api.guide([], now, now, true);
      this.updatedAt.set(guide.updatedAt);
      this.error.set(null);
    } catch (err) {
      this.error.set(String(err));
    }
    this.version.update((n) => n + 1);
  }
}
