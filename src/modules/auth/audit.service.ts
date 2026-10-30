import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AuditLog } from './entities/audit-log.entity.js';

@Injectable()
export class AuditService {
  constructor(
    @InjectRepository(AuditLog)
    private readonly auditLogRepository: Repository<AuditLog>,
  ) {}

  async log(params: {
    action: string;
    userId?: string | null;
    ip?: string | null;
    userAgent?: string | null;
    metadata?: Record<string, unknown> | null;
  }): Promise<void> {
    try {
      await this.auditLogRepository.save(
        this.auditLogRepository.create({
          userId: params.userId ?? null,
          action: params.action,
          ip: params.ip ?? null,
          userAgent: params.userAgent ?? null,
          metadata: params.metadata ?? null,
        }),
      );
    } catch {
      // Audit logging must not break the main request flow.
    }
  }
}