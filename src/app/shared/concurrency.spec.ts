import { mapWithConcurrency } from './concurrency';

describe('mapWithConcurrency', () => {
  it('keeps order and caps parallelism', async () => {
    let inFlight = 0;
    let peak = 0;
    const result = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (n) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5 - n));
      inFlight--;
      return n * 10;
    });

    expect(result).toEqual([10, 20, 30, 40, 50]);
    expect(peak).toBe(2);
  });
});
