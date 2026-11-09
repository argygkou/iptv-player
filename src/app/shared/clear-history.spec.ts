import { TestBed } from '@angular/core/testing';

import { LibraryStore } from '../core/library/library-store';
import { LibraryItem } from '../core/library/library.models';
import { ClearHistory } from './clear-history';

const items: LibraryItem[] = [
  { kind: 'movie', id: '1', name: 'Heat', image: '' },
  { kind: 'episode', id: '2', name: 'S1 E3', image: '' },
];

describe('ClearHistory', () => {
  let forget: ReturnType<typeof vi.fn>;

  async function setup() {
    forget = vi.fn().mockResolvedValue(undefined);
    TestBed.configureTestingModule({
      providers: [{ provide: LibraryStore, useValue: { forget } }],
    });
    const fixture = TestBed.createComponent(ClearHistory);
    fixture.componentRef.setInput('list', 'Continue watching');
    fixture.componentRef.setInput('items', items);
    await fixture.whenStable();
    const el: HTMLElement = fixture.nativeElement;
    const click = async (selector: string) => {
      el.querySelector<HTMLButtonElement>(selector)!.click();
      await fixture.whenStable();
    };
    return { fixture, el, click };
  }

  it('asks before clearing, with focus on Cancel', async () => {
    const { el, click } = await setup();
    await click('.start');

    expect(el.textContent).toContain('Remove 2 items?');
    expect(document.activeElement).toBe(el.querySelector('.cancel'));
    expect(forget).not.toHaveBeenCalled();
  });

  it('clears every item once confirmed', async () => {
    const { fixture, click } = await setup();
    const cleared = vi.fn();
    fixture.componentInstance.cleared.subscribe(cleared);

    await click('.start');
    await click('.danger');

    expect(forget).toHaveBeenCalledWith(items);
    expect(cleared).toHaveBeenCalled();
  });

  it('clears nothing when cancelled', async () => {
    const { el, click } = await setup();
    await click('.start');
    await click('.cancel');

    expect(forget).not.toHaveBeenCalled();
    expect(el.querySelector('.start')).not.toBeNull();
  });
});
