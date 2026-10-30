import { registerAs } from '@nestjs/config';
import type { I18nOptions } from 'nestjs-i18n';
import { AcceptLanguageResolver, HeaderResolver, QueryResolver } from 'nestjs-i18n';
import { join } from 'path';

export interface I18nConfig extends I18nOptions {}

export const i18nConfig = registerAs<I18nConfig>(
  'i18n',
  (): I18nConfig => ({
    fallbackLanguage: process.env.I18N_FALLBACK_LANGUAGE ?? 'en',
    loaderOptions: {
      path: join(process.cwd(), 'src', 'i18n'),
      watch: true,
    },
    resolvers: [
      AcceptLanguageResolver,
      { use: QueryResolver, options: ['lang'] },
      HeaderResolver,
    ],
  }),
);