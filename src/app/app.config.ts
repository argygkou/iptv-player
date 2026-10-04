import {
  ApplicationConfig,
  inject,
  provideAppInitializer,
  provideBrowserGlobalErrorListeners,
} from '@angular/core';
import { provideRouter, withComponentInputBinding, withHashLocation } from '@angular/router';

import { routes } from './app.routes';
import { SessionStore } from './core/session/session-store';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    // Sign in with the saved profile before the first navigation, so a returning
    // user lands on the main screen instead of the login page.
    provideAppInitializer(() => inject(SessionStore).restore()),
    // Hash routing: the bundled app is served from Tauri's asset protocol,
    // which has no server-side fallback for deep links on reload.
    provideRouter(routes, withComponentInputBinding(), withHashLocation()),
  ],
};
