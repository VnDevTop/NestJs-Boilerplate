import { config as loadEnv } from 'dotenv';
import { DataSource } from 'typeorm';

import {
  EmailVerificationToken,
  PasswordResetToken,
  TwoFactorSecret,
  RefreshToken,
  UserDevice,
} from '../modules/auth/entities/index.js';
import { MaintenanceLog } from '../modules/maintenance/entities/index.js';
import {
  Permission,
  RolePermission,
  User,
} from '../modules/users/entities/index.js';

/**
 * A standalone DataSource for the TypeORM CLI, which runs outside Nest.
 *
 * Entities are listed explicitly because `autoLoadEntities` only works inside the
 * Nest container, and a migration that silently missed an entity would generate
 * an incomplete schema. Keeping the list here is also what makes this file the
 * single place to update when an entity is added.
 */
loadEnv();

export const ENTITIES = [
  User,
  RefreshToken,
  UserDevice,
  TwoFactorSecret,
  EmailVerificationToken,
  PasswordResetToken,
  MaintenanceLog,
  Permission,
  RolePermission,
];

export const migrations = ['dist/database/migrations/*.js'];

/** Defaults to public. Useful for keeping a test schema beside a real one. */
const schema = process.env.DATABASE_SCHEMA || 'public';

export default new DataSource({
  type: 'postgres',
  url: process.env.DATABASE_URL,
  entities: ENTITIES,
  migrations,
  schema,
  // The app never creates or alters tables at runtime. Schema changes go through
  // a reviewed migration, so a deployment cannot quietly rewrite production data.
  synchronize: false,
  ssl:
    process.env.DATABASE_SSL === 'false'
      ? false
      : { rejectUnauthorized: false },
  extra: {
    ssl:
      process.env.DATABASE_SSL === 'false'
        ? false
        : { rejectUnauthorized: false },
  },
});
