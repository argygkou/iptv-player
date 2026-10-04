import { Routes } from '@angular/router';

import { authGuard, guestGuard } from './core/session/auth-guard';

export const routes: Routes = [
  {
    path: 'login',
    canActivate: [guestGuard],
    loadComponent: () => import('./features/login/login-page').then((m) => m.LoginPage),
  },
  {
    path: '',
    canActivate: [authGuard],
    loadComponent: () => import('./features/shell/shell').then((m) => m.Shell),
    children: [
      { path: '', pathMatch: 'full', redirectTo: 'live' },
      {
        path: 'live',
        loadComponent: () => import('./features/live/live-page').then((m) => m.LivePage),
      },
      {
        path: 'guide',
        loadComponent: () => import('./features/guide/guide-page').then((m) => m.GuidePage),
      },
      {
        path: 'movies',
        loadComponent: () => import('./features/movies/movies-page').then((m) => m.MoviesPage),
      },
      {
        path: 'movies/:id',
        loadComponent: () =>
          import('./features/movies/movie-detail-page').then((m) => m.MovieDetailPage),
      },
      {
        path: 'series',
        loadComponent: () => import('./features/series/series-page').then((m) => m.SeriesPage),
      },
      {
        path: 'series/:id',
        loadComponent: () =>
          import('./features/series/series-detail-page').then((m) => m.SeriesDetailPage),
      },
    ],
  },
  { path: '**', redirectTo: '' },
];
