import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Outbox } from './outbox.entity.js';
import { OutboxService } from './outbox.service.js';

@Module({
  imports: [TypeOrmModule.forFeature([Outbox])],
  providers: [OutboxService],
  exports: [OutboxService],
})
export class OutboxModule {}
