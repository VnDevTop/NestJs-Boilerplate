import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  PERMISSIONS_KEY,
  MANAGER_ONLY_KEY,
} from '../../common/constants/index.js';
import { Permission } from '../../common/enums/index.js';
import { PaginatedResultDto } from '../../common/pagination/index.js';
import type { AuditService } from '../audit/audit.service.js';
import type { AuditQueryDto } from '../audit/dto/audit-query.dto.js';
import { AdminAuditController } from './audit.controller.js';

interface Harness {
  controller: AdminAuditController;
  list: ReturnType<typeof vi.fn>;
}

function harness(): Harness {
  const list = vi
    .fn()
    .mockResolvedValue(
      PaginatedResultDto.of([], {
        limit: 20,
        hasMore: false,
        nextCursor: null,
      }),
    );

  const controller = new AdminAuditController({
    list,
  } as unknown as AuditService);

  return { controller, list };
}

/** The handler's metadata, as Nest reads it. */
function metadataOf(name: string): Record<string, unknown> {
  const handler = (
    AdminAuditController.prototype as unknown as Record<string, unknown>
  )[name];

  return {
    permissions: Reflect.getMetadata(PERMISSIONS_KEY, handler as object),
    managerOnly: Reflect.getMetadata(MANAGER_ONLY_KEY, handler as object),
  };
}

describe('AdminAuditController', () => {
  let h: Harness;

  beforeEach(() => {
    h = harness();
  });

  describe('GET admin/audit', () => {
    it('reads a page of the trail', async () => {
      const query = { limit: 20 } as AuditQueryDto;

      await h.controller.findAll(query);

      expect(h.list).toHaveBeenCalledTimes(1);
      expect(h.list).toHaveBeenCalledWith(query);
    });

    it('passes the filters through to the service untouched', async () => {
      // The service builds the criteria from the DTO and the spec. A route that
      // reshaped the query on the way would put a second set of rules next to
      // the first, and the two would drift.
      const query = {
        limit: 20,
        action: 'users.update',
        targetId: 'u1',
        from: '2026-10-01T00:00:00Z',
      } as AuditQueryDto;

      await h.controller.findAll(query);

      expect(h.list.mock.calls[0]?.[0]).toEqual(query);
    });
  });

  /**
   * The gates, read off the handler rather than restated.
   *
   * A test that restated the list would pass with every decorator deleted,
   * which is exactly the failure this block exists to catch. The route's whole
   * value is who may read it.
   */
  describe('the gates', () => {
    it('requires the audit permission', () => {
      expect(metadataOf('findAll').permissions).toEqual([Permission.AuditRead]);
    });

    it('requires a manager', () => {
      // The path would require it anyway — the manager guard applies to every
      // `/admin/` path — but the route says so itself rather than relying on a
      // rule about paths that lives in a guard.
      expect(metadataOf('findAll').managerOnly).toBe(true);
    });
  });
});
