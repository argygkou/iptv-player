import { intersect, measure } from './bounds';

describe('bounds', () => {
  it('intersects overlapping rectangles', () => {
    expect(
      intersect({ x: 0, y: -50, width: 400, height: 200 }, { x: 0, y: 0, width: 300, height: 600 }),
    ).toEqual({
      x: 0,
      y: 0,
      width: 300,
      height: 150,
    });
  });

  it('returns null when rectangles only touch or do not overlap', () => {
    expect(
      intersect({ x: 0, y: 0, width: 10, height: 10 }, { x: 10, y: 0, width: 10, height: 10 }),
    ).toBeNull();
    expect(
      intersect({ x: 0, y: 0, width: 10, height: 10 }, { x: 50, y: 50, width: 10, height: 10 }),
    ).toBeNull();
  });

  it('clips to ancestors that hide overflow', () => {
    const scroller = document.createElement('div');
    scroller.style.overflow = 'auto';
    const player = document.createElement('div');
    scroller.append(player);
    document.body.append(scroller);
    const box = (x: number, y: number, width: number, height: number) => () =>
      ({ x, y, width, height }) as DOMRect;
    scroller.getBoundingClientRect = box(0, 100, 500, 300);
    player.getBoundingClientRect = box(0, 50, 480, 270);

    const bounds = measure(player);

    expect(bounds.rect).toEqual({ x: 0, y: 50, width: 480, height: 270 });
    expect(bounds.visible).toEqual({ x: 0, y: 100, width: 480, height: 220 });
    scroller.remove();
  });

  it('does not clip a fixed element to its ancestors', () => {
    const main = document.createElement('main');
    main.style.overflow = 'hidden';
    const player = document.createElement('div');
    player.style.position = 'fixed';
    main.append(player);
    document.body.append(main);
    main.getBoundingClientRect = () => ({ x: 220, y: 0, width: 800, height: 768 }) as DOMRect;
    player.getBoundingClientRect = () => ({ x: 0, y: 0, width: 1024, height: 768 }) as DOMRect;

    expect(measure(player).visible).toEqual({ x: 0, y: 0, width: 1024, height: 768 });
    main.remove();
  });
});
