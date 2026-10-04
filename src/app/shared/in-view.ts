import { Directive, ElementRef, inject, OnDestroy, output } from '@angular/core';

/** Emits whenever the host scrolls into view; used to grow long grids lazily. */
@Directive({ selector: '[appInView]' })
export class InView implements OnDestroy {
  readonly appInView = output<void>();

  private readonly observer = new IntersectionObserver(
    (entries) => entries.some((e) => e.isIntersecting) && this.appInView.emit(),
    { rootMargin: '400px' },
  );

  constructor() {
    this.observer.observe(inject<ElementRef<HTMLElement>>(ElementRef).nativeElement);
  }

  ngOnDestroy(): void {
    this.observer.disconnect();
  }
}
