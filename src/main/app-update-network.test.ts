import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

const { requestMock } = vi.hoisted(() => ({
  requestMock: vi.fn(),
}));

vi.mock('electron', () => ({
  net: {
    request: requestMock,
  },
}));

import { APP_UPDATE_API_URL } from '../shared/app-update';
import { ElectronUpdateHttpClient, UpdateHttpError } from './app-update-network';

class FakeClientRequest extends EventEmitter {
  readonly abort = vi.fn();
  readonly followRedirect = vi.fn();
  readonly end = vi.fn();
}

class FakeIncomingMessage extends EventEmitter {
  readonly statusCode = 200;
  readonly headers = { 'content-length': '2' };
}

describe('ElectronUpdateHttpClient', () => {
  it('waits for a response when ClientRequest closes its upload side first', async () => {
    const request = new FakeClientRequest();
    const response = new FakeIncomingMessage();
    requestMock.mockReturnValueOnce(request);
    const client = new ElectronUpdateHttpClient();

    const pending = client.get(APP_UPDATE_API_URL, {
      signal: new AbortController().signal,
      maximumBytes: 1_024,
      idleTimeoutMs: 1_000,
      onChunk: vi.fn(),
    });

    request.emit('close');
    request.emit('response', response);
    response.emit('data', Buffer.from('ok'));
    response.emit('end');

    await expect(pending).resolves.toEqual({
      statusCode: 200,
      headers: { 'content-length': '2' },
      receivedBytes: 2,
    });
    expect(request.abort).not.toHaveBeenCalled();
  });

  it('still rejects a real ClientRequest error as a network failure', async () => {
    const request = new FakeClientRequest();
    requestMock.mockReturnValueOnce(request);
    const client = new ElectronUpdateHttpClient();

    const pending = client.get(APP_UPDATE_API_URL, {
      signal: new AbortController().signal,
      maximumBytes: 1_024,
      idleTimeoutMs: 1_000,
      onChunk: vi.fn(),
    });

    request.emit('error', new Error('connection reset'));

    await expect(pending).rejects.toEqual(
      expect.objectContaining<Partial<UpdateHttpError>>({
        code: 'NETWORK',
      }),
    );
    expect(request.abort).toHaveBeenCalledTimes(1);
  });
});
