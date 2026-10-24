import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

import {
  DEVICE_NAME_HEADER,
  DEVICE_NAME_MAX_LENGTH,
} from '../constants/index.js';
import { parseDeviceName } from '../utils/index.js';

function readHeader(request: FastifyRequest, name: string): string | null {
  const header = request.headers[name];
  const value = Array.isArray(header) ? header[0] : header;

  return typeof value === 'string' ? value : null;
}

/**
 * Resolves the friendly device name for the request.
 *
 * The user agent is the default source, so clients never have to send anything.
 * An explicit `x-device-name` header overrides it when a caller wants to show
 * something friendlier than "Chrome on macOS".
 *
 * Both sources are untrusted input, so the value is trimmed, collapsed and
 * capped at the column width before it reaches the database.
 */
export const DeviceName = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string | null => {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const explicit = readHeader(request, DEVICE_NAME_HEADER);
    const value =
      explicit ?? parseDeviceName(readHeader(request, 'user-agent') ?? '');

    if (!value?.trim()) {
      return null;
    }

    return value.trim().replace(/\s+/g, ' ').slice(0, DEVICE_NAME_MAX_LENGTH);
  },
);
