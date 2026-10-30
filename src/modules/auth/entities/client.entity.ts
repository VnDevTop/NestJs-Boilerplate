import { Entity, Column, Index } from 'typeorm';
import { BaseEntity } from '../../../database/base.entity.js';

@Entity('clients')
export class Client extends BaseEntity {
  @Index({ unique: true })
  @Column({ name: 'client_id', type: 'varchar', length: 255, unique: true })
  clientId: string;

  @Column({ name: 'client_secret_hash', type: 'varchar', length: 255, select: false })
  clientSecretHash: string;

  @Column({ type: 'simple-array', default: '' })
  scopes: string[];

  @Column({ type: 'varchar', length: 32, default: 'active' })
  status: string;
}