import { Entity, Column, Index } from 'typeorm';
import { BaseEntity } from '../../../database/base.entity.js';

@Entity('jwt_keys')
export class JwtKey extends BaseEntity {
  @Index({ unique: true })
  @Column({ type: 'varchar', length: 255, unique: true })
  kid: string;

  @Column({ type: 'int' })
  version: number;

  @Column({ type: 'varchar', length: 32, default: 'RS256' })
  algorithm: string;

  @Column({ name: 'private_key', type: 'text' })
  privateKey: string;

  @Column({ name: 'public_key', type: 'text' })
  publicKey: string;

  @Column({ name: 'is_active', type: 'boolean', default: false })
  isActive: boolean;
}