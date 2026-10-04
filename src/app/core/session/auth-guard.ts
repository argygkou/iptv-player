import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';

import { SessionStore } from './session-store';

export const authGuard: CanActivateFn = () =>
  inject(SessionStore).isSignedIn() || inject(Router).createUrlTree(['/login']);

/** Keeps a signed-in user (for example after auto sign-in) off the login page. */
export const guestGuard: CanActivateFn = () =>
  !inject(SessionStore).isSignedIn() || inject(Router).createUrlTree(['/live']);
