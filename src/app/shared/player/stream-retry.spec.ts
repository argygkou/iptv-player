import {
  describeFailure,
  isRetryable,
  MAX_RETRIES,
  retryDelay,
  STABLE_PLAYBACK,
  StreamRetry,
  WATCH_INTERVAL,
} from './stream-retry';

describe('retryDelay', () => {
  it('doubles from one second, with ±25% jitter', () => {
    expect([1, 2, 3, 4, 5].map((n) => retryDelay(n, () => 0.5))).toEqual([
      1000, 2000, 4000, 8000, 16000,
    ]);
    expect(retryDelay(1, () => 0)).toBe(750);
    expect(retryDelay(5, () => 1)).toBe(20000);
  });
});

describe('isRetryable', () => {
  it('gives up on refused or missing streams and unreadable files', () => {
    expect(isRetryable({ message: 'loading failed' })).toBe(true);
    expect(isRetryable({ message: 'loading failed', status: 502 })).toBe(true);
    // Often the account's connection limit, which clears by itself.
    expect(isRetryable({ message: 'loading failed', status: 403 })).toBe(true);
    expect(isRetryable({ message: 'loading failed', status: 401 })).toBe(false);
    expect(isRetryable({ message: 'loading failed', status: 404 })).toBe(false);
    expect(isRetryable({ message: 'unrecognized file format' })).toBe(false);
    expect(isRetryable({ message: 'x', fatal: true })).toBe(false);
  });
});

describe('describeFailure', () => {
  it('explains the HTTP statuses users can act on', () => {
    expect(describeFailure({ message: 'loading failed' })).toBe('loading failed');
    expect(describeFailure({ message: 'loading failed', status: 404 })).toBe(
      'the provider does not have this stream, HTTP 404',
    );
    expect(describeFailure({ message: 'loading failed', status: 401 })).toBe(
      'the provider refused access, HTTP 401',
    );
    expect(describeFailure({ message: 'loading failed', status: 502 })).toBe(
      'loading failed, HTTP 502',
    );
  });
});

describe('StreamRetry', () => {
  const failure = { message: 'loading failed' };
  let reopen: ReturnType<typeof vi.fn<() => void>>;
  let retry: StreamRetry;

  beforeEach(() => {
    vi.useFakeTimers();
    reopen = vi.fn<() => void>();
    retry = new StreamRetry(reopen, () => 0.5);
  });

  afterEach(() => {
    retry.dispose();
    vi.useRealTimers();
  });

  function failAndWait(): void {
    const state = retry.state();
    retry.fail(failure);
    const next = retry.state();
    if (next.kind === 'retrying' && state !== next) {
      vi.advanceTimersByTime(retryDelay(next.attempt, () => 0.5));
    }
  }

  it(`reopens ${MAX_RETRIES} times with backoff, then gives up`, () => {
    retry.fail(failure);
    expect(retry.state()).toEqual({ kind: 'retrying', attempt: 1, of: MAX_RETRIES, failure });
    vi.advanceTimersByTime(999);
    expect(reopen).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(reopen).toHaveBeenCalledTimes(1);

    for (let n = 2; n <= MAX_RETRIES; n++) {
      failAndWait();
    }
    expect(reopen).toHaveBeenCalledTimes(MAX_RETRIES);

    retry.fail(failure);
    expect(retry.state()).toEqual({ kind: 'failed', failure });
    vi.runAllTimers();
    expect(reopen).toHaveBeenCalledTimes(MAX_RETRIES);
  });

  it('ignores a second report of the failure it is already handling', () => {
    retry.fail(failure);
    retry.fail(failure);
    vi.runAllTimers();
    expect(reopen).toHaveBeenCalledTimes(1);
    expect(retry.state()).toMatchObject({ attempt: 1 });
  });

  it('fails at once when another attempt cannot help', () => {
    const missing = { message: 'loading failed', status: 404 };
    retry.fail(missing);
    expect(retry.state()).toEqual({ kind: 'failed', failure: missing });
    vi.runAllTimers();
    expect(reopen).not.toHaveBeenCalled();
  });

  it('shows the stream as playing once it moves again', () => {
    failAndWait();
    retry.watched(10);
    expect(retry.state().kind).toBe('retrying');
    retry.watched(15);
    expect(retry.state().kind).toBe('playing');
  });

  it('earns every attempt back after stable playback', () => {
    for (let n = 1; n < MAX_RETRIES; n++) {
      failAndWait();
    }
    for (let t = 0; t <= STABLE_PLAYBACK; t += WATCH_INTERVAL) {
      retry.watched(t / 1000);
    }
    failAndWait();
    expect(retry.state()).toMatchObject({ kind: 'retrying', attempt: 1 });
  });

  it('does not count a paused or stalled stream as stable', () => {
    for (let n = 1; n < MAX_RETRIES; n++) {
      failAndWait();
    }
    for (let t = 0; t <= STABLE_PLAYBACK; t += WATCH_INTERVAL) {
      retry.watched(t === WATCH_INTERVAL * 3 ? 0 : t / 1000);
    }
    failAndWait();
    expect(retry.state()).toMatchObject({ kind: 'retrying', attempt: MAX_RETRIES });
  });

  it('stops on request and starts over on a manual retry', () => {
    retry.fail(failure);
    retry.giveUp();
    expect(retry.state()).toEqual({ kind: 'failed', failure });
    vi.runAllTimers();
    expect(reopen).not.toHaveBeenCalled();

    retry.retryNow();
    expect(reopen).toHaveBeenCalledTimes(1);
    expect(retry.state().kind).toBe('playing');
    retry.fail(failure);
    expect(retry.state()).toMatchObject({ kind: 'retrying', attempt: 1 });
  });

  it('forgets a pending attempt when the stream changes', () => {
    retry.fail(failure);
    retry.reset();
    vi.runAllTimers();
    expect(reopen).not.toHaveBeenCalled();
    expect(retry.state().kind).toBe('playing');
  });
});
