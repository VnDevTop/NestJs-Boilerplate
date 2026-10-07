import { ArgumentsHost } from '@nestjs/common';
import { HttpException, HttpStatus } from '@nestjs/common';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { LoginLockedException } from '../../modules/auth/exceptions/login-locked.exception.js';
import { HttpExceptionFilter } from './http-exception.filter.js';

/**
 * `Retry-After` is the only place the wait reaches the client: the 429 body
 * deliberately omits it, because a body naming the time left is a progress bar for
 * somebody guessing a password. Losing the header means a client has no way to
 * know when to retry and either retries immediately or gives up.
 */
function host() {
  const response = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    setHeader: vi.fn(),
  };

  const request = { originalUrl: '/auth/login' };

  return {
    response,
    host: {
      switchToHttp: () => ({
        getResponse: () => response,
        getRequest: () => request,
      }),
    } as unknown as ArgumentsHost,
  };
}

describe('Retry-After on a 429', () => {
  let filter: HttpExceptionFilter;
  let h: ReturnType<typeof host>;

  beforeEach(() => {
    filter = new HttpExceptionFilter();
    h = host();
  });

  it('is set from the exception, in whole seconds', () => {
    filter.catch(new LoginLockedException(90), h.host);

    expect(h.response.setHeader).toHaveBeenCalledWith('Retry-After', '90');
  });

  it('rounds a fractional remainder up', () => {
    // 0.4 seconds left has to round to one, not zero: a zero tells the client to
    // come back immediately and be refused again.
    filter.catch(new LoginLockedException(0.4), h.host);

    expect(h.response.setHeader).toHaveBeenCalledWith('Retry-After', '1');
  });

  it('is not set for a 429 that carries no wait', () => {
    filter.catch(
      new HttpException('Too many requests', HttpStatus.TOO_MANY_REQUESTS),
      h.host,
    );

    // The throttler throws plain 429s and sets its own header; inventing one here
    // would overwrite it.
    expect(h.response.setHeader).not.toHaveBeenCalled();
  });

  it('is not set for a status that is not 429', () => {
    // Carries a `retryAfterSeconds` on purpose, so loosening the condition to
    // "any 4xx" would show up here instead of passing because the property was
    // absent.
    class WithWait extends HttpException {
      constructor() {
        super('Nope', HttpStatus.FORBIDDEN);
      }
      readonly retryAfterSeconds = 30;
    }

    filter.catch(new WithWait(), h.host);

    expect(h.response.setHeader).not.toHaveBeenCalled();
  });

  it('still answers with the status and the body', () => {
    filter.catch(new LoginLockedException(60), h.host);

    expect(h.response.status).toHaveBeenCalledWith(429);
    expect(h.response.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, statusCode: 429 }),
    );
  });

  it('does not put the wait in the body', () => {
    filter.catch(new LoginLockedException(60), h.host);

    const body = JSON.stringify(h.response.json.mock.calls[0][0]);

    expect(body).not.toContain('60');
  });
});
