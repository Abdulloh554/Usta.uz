import { startKeepAwake } from '../../src/config/keepAwake';

describe('startKeepAwake', () => {
  let fetchMock: jest.Mock;

  beforeEach(() => {
    jest.useFakeTimers();
    fetchMock = jest.fn().mockResolvedValue({ ok: true });
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('pings the public /health on every interval', () => {
    const timer = startKeepAwake('https://api.example.com/', 10, true);
    expect(timer).not.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();

    jest.advanceTimersByTime(10 * 60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.example.com/health');

    jest.advanceTimersByTime(20 * 60_000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('stays off outside production, without an address, or at 0 minutes', () => {
    expect(startKeepAwake('https://api.example.com', 10, false)).toBeNull();
    expect(startKeepAwake('', 10, true)).toBeNull();
    expect(startKeepAwake('https://api.example.com', 0, true)).toBeNull();
    jest.advanceTimersByTime(60 * 60_000);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('survives a failed ping', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network down'));
    startKeepAwake('https://api.example.com', 1, true);
    jest.advanceTimersByTime(60_000);
    await Promise.resolve();
    jest.advanceTimersByTime(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
