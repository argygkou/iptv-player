import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';

import { SessionStore } from '../../core/session/session-store';

@Component({
  selector: 'app-shell',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterOutlet, RouterLink, RouterLinkActive, DatePipe],
  templateUrl: './shell.html',
  styleUrl: './shell.scss',
})
export class Shell {
  protected readonly session = inject(SessionStore);
  private readonly router = inject(Router);

  protected readonly sections = [
    { path: '/live', label: 'Live TV', icon: '📺' },
    { path: '/guide', label: 'TV Guide', icon: '🗓️' },
    { path: '/movies', label: 'Movies', icon: '🎬' },
    { path: '/series', label: 'Series', icon: '🎞️' },
  ];

  protected async signOut(): Promise<void> {
    await this.session.signOut();
    await this.router.navigateByUrl('/login');
  }
}
