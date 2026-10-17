import type { PageMetaDto } from '../pagination/index.js';

export interface ApiSuccessResponse<TData = unknown> {
  success: true;
  data: TData;
  /**
   * Present only on a listing route.
   *
   * `undefined` rather than a null placeholder, so a route with nothing to page
   * serialises exactly as it did before Phase 23 — the field is absent, and a
   * client checking for it cannot mistake a body with no cursor for an empty page.
   */
  meta?: PageMetaDto;
  timestamp: string;
}

export interface ApiErrorResponse {
  success: false;
  statusCode: number;
  message: string | string[];
  error?: string;
  path: string;
  timestamp: string;
}
