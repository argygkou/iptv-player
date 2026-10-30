import { DatePipe, PercentPipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';

import { SessionStore } from '../../core/session/session-store';
import { UpdateStore } from '../../core/updates/update-store';

@Component({
  selector: 'app-shell',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterOutlet, RouterLink, RouterLinkActive, DatePipe, PercentPipe],
  templateUrl: './shell.html',
  styleUrl: './shell.scss',
})
export class Shell {
  protected readonly session = inject(SessionStore);
  protected readonly updates = inject(UpdateStore);
  private readonly router = inject(Router);

  protected readonly sections = [
    { path: '/library', label: 'My List', icon: '⭐' },
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
