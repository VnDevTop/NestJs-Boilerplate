import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('outbox')
export class Outbox {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 255 })
  aggregate!: string;

  @Column({ type: 'varchar', length: 255, unique: true })
  eventId!: string;

  @Column('jsonb')
  payload!: Record<string, unknown>;

  @CreateDateColumn({ type: 'timestamp with time zone' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamp with time zone', nullable: true })
  processedAt?: Date;
}
