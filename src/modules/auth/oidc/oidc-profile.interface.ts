export interface OidcProfile {
  provider: string;
  subject: string;
  email?: string;
  name?: string;
  raw: Record<string, unknown>;
}