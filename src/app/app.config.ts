import { ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideRouter, withComponentInputBinding, withHashLocation } from '@angular/router';

import { routes } from './app.routes';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    // Hash routing: the bundled app is served from Tauri's asset protocol,
    // which has no server-side fallback for deep links on reload.
    provideRouter(routes, withComponentInputBinding(), withHashLocation()),
  ],
};
