import { Injectable } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';

import { StreamKind } from '../xtream/xtream.models';
import { CategoryPrefs, Library, LibraryItem, LibraryKind, Progress } from './library.models';

/** The backend's library commands; each returns the updated library. */
@Injectable({ providedIn: 'root' })
export class LibraryApi {
  get(): Promise<Library> {
    return invoke<Library>('library_get');
  }

  setFavourite(item: LibraryItem, favourite: boolean): Promise<Library> {
    return invoke<Library>('library_set_favourite', { item: toItem(item), favourite });
  }

  record(item: LibraryItem, progress?: Progress): Promise<Library> {
    return invoke<Library>('library_record', {
      item: toItem(item),
      position: progress?.position ?? null,
      duration: progress?.duration ?? null,
    });
  }

  forget(kind: LibraryKind, id: string): Promise<Library> {
    return invoke<Library>('library_forget', { kind, id });
  }

  setCategories(catalogue: StreamKind, prefs: CategoryPrefs): Promise<Library> {
    return invoke<Library>('library_set_categories', { catalogue, prefs });
  }
}

/** Only the item's own fields, never a `Favourite` or `Watched` wrapper's. */
function toItem({ kind, id, name, image, seriesId, seriesName }: LibraryItem): LibraryItem {
  return { kind, id, name, image, seriesId, seriesName };
}
