// Must run before anything touches the Tauri API; a no-op outside `npm run start:mock`.
import './dev/mock-backend';

import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { App } from './app/app';

bootstrapApplication(App, appConfig).catch((err) => console.error(err));
