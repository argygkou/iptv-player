import { Injectable } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';

import { fromGuide, toProgramme } from './epg';
import {
  CatalogueListName,
  CatalogueSnapshot,
  Credentials,
  GuideWindow,
  Profile,
  Programme,
  SeriesInfo,
  ShortEpgResponse,
  SignedIn,
  StreamKind,
  VodInfo,
  XtreamId,
} from './xtream.models';

type Action = 'get_vod_info' | 'get_series_info' | 'get_short_epg';

interface Query {
  streamId?: string;
  vodId?: string;
  seriesId?: string;
  limit?: number;
}

/**
 * Typed facade over the Rust `xtream` commands. Movie and series details are
 * cached for the session; the category and stream lists are cached on disk by
 * the backend (see `CatalogueStore`); EPG is not cached here.
 */
@Injectable({ providedIn: 'root' })
export class XtreamApi {
  private readonly cache = new Map<string, Promise<unknown>>();

  login(credentials: Credentials, remember: boolean): Promise<SignedIn> {
    this.cache.clear();
    return invoke<SignedIn>('login', { ...credentials, remember });
  }

  /** Signs in with the profile used last; `null` when none is saved. */
  restoreSession(): Promise<SignedIn | null> {
    this.cache.clear();
    return invoke<SignedIn | null>('restore_session');
  }

  signInProfile(id: string): Promise<SignedIn> {
    this.cache.clear();
    return invoke<SignedIn>('sign_in_profile', { id });
  }

  listProfiles(): Promise<Profile[]> {
    return invoke<Profile[]>('list_profiles');
  }

  removeProfile(id: string): Promise<void> {
    return invoke('remove_profile', { id });
  }

  async logout(): Promise<void> {
    this.cache.clear();
    await invoke('logout');
  }

  /** A list from the backend's cache, or downloaded when nothing is cached. */
  catalogue<T>(list: CatalogueListName): Promise<CatalogueSnapshot<T>> {
    return invoke<CatalogueSnapshot<T>>('catalogue_get', { list });
  }

  /** Downloads a list again; `items` is `null` when it did not change. */
  refreshCatalogue<T>(list: CatalogueListName): Promise<CatalogueSnapshot<T>> {
    return invoke<CatalogueSnapshot<T>>('catalogue_refresh', { list });
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

  /**
   * Programmes of the given XMLTV channel ids that overlap `from`..`to`, from
   * the provider's full guide. The backend downloads it on first use and keeps
   * it for 12 hours; `refresh` downloads it again.
   */
  async guide(
    channelIds: string[],
    from: Date,
    to: Date,
    refresh = false,
  ): Promise<{ updatedAt: Date; programmes: Map<string, Programme[]> }> {
    const window = await invoke<GuideWindow>('epg_guide', {
      channels: channelIds,
      from: Math.floor(from.getTime() / 1000),
      to: Math.ceil(to.getTime() / 1000),
      refresh,
    });
    return {
      updatedAt: new Date(window.updatedAt * 1000),
      programmes: new Map(
        Object.entries(window.programmes).map(([id, list]) => [id, list.map(fromGuide)]),
      ),
    };
  }

  /**
   * A relay URL for a channel's recording: `minutes` from `start`, which is
   * `YYYY-MM-DD:HH-MM` in the panel's time zone (see `panelTime`).
   */
  catchupUrl(streamId: XtreamId, start: string, minutes: number): Promise<string> {
    return invoke<string>('catchup_url', { id: String(streamId), start, duration: minutes });
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
