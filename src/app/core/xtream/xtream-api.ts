import { Injectable } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';

import { toProgramme } from './epg';
import {
  AccountInfo,
  Category,
  Credentials,
  LiveStream,
  Programme,
  SeriesInfo,
  SeriesItem,
  ShortEpgResponse,
  StreamKind,
  VodInfo,
  VodStream,
  XtreamId,
} from './xtream.models';

type Action =
  | 'get_live_categories'
  | 'get_vod_categories'
  | 'get_series_categories'
  | 'get_live_streams'
  | 'get_vod_streams'
  | 'get_series'
  | 'get_vod_info'
  | 'get_series_info'
  | 'get_short_epg';

interface Query {
  categoryId?: string;
  streamId?: string;
  vodId?: string;
  seriesId?: string;
  limit?: number;
}

/**
 * Typed facade over the Rust `xtream` commands. Catalogue calls are cached for
 * the session because providers serve large, rarely changing lists; EPG is not.
 */
@Injectable({ providedIn: 'root' })
export class XtreamApi {
  private readonly cache = new Map<string, Promise<unknown>>();

  async login(credentials: Credentials): Promise<AccountInfo> {
    this.cache.clear();
    return invoke<AccountInfo>('login', { ...credentials });
  }

  async logout(): Promise<void> {
    this.cache.clear();
    await invoke('logout');
  }

  liveCategories(): Promise<Category[]> {
    return this.cached('get_live_categories');
  }

  movieCategories(): Promise<Category[]> {
    return this.cached('get_vod_categories');
  }

  seriesCategories(): Promise<Category[]> {
    return this.cached('get_series_categories');
  }

  liveStreams(categoryId?: string): Promise<LiveStream[]> {
    return this.cached('get_live_streams', { categoryId });
  }

  movies(categoryId?: string): Promise<VodStream[]> {
    return this.cached('get_vod_streams', { categoryId });
  }

  series(categoryId?: string): Promise<SeriesItem[]> {
    return this.cached('get_series', { categoryId });
  }

  movieInfo(vodId: XtreamId): Promise<VodInfo> {
    return this.cached('get_vod_info', { vodId: String(vodId) });
  }

  seriesInfo(seriesId: XtreamId): Promise<SeriesInfo> {
    return this.cached('get_series_info', { seriesId: String(seriesId) });
  }

  async shortEpg(streamId: XtreamId, limit = 4): Promise<Programme[]> {
    const response = await this.call<ShortEpgResponse>('get_short_epg', {
      streamId: String(streamId),
      limit,
    });
    return (response?.epg_listings ?? []).map(toProgramme);
  }

  /** A local relay URL the player can load; credentials stay in the backend. */
  streamUrl(kind: StreamKind, id: XtreamId, extension: string): Promise<string> {
    return invoke<string>('stream_url', { kind, id: String(id), ext: extension });
  }

  private call<T>(action: Action, query?: Query): Promise<T> {
    return invoke<T>('xtream', { action, query });
  }

  private cached<T>(action: Action, query: Query = {}): Promise<T> {
    const key = `${action}:${JSON.stringify(query)}`;
    let pending = this.cache.get(key) as Promise<T> | undefined;
    if (!pending) {
      pending = this.call<T>(action, query);
      // Do not keep failures around; the next caller retries.
      pending.catch(() => this.cache.delete(key));
      this.cache.set(key, pending);
    }
    return pending;
  }
}
