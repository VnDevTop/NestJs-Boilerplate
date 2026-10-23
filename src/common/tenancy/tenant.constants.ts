/**
 * The tenant every row belongs to while multi-tenancy is off.
 *
 * **A fixed id, not a generated one.** The column is present from the start on
 * every table, so the default has to be a value the database can fill on its own
 * — a `uuid_generate_v4()` default would give every row its own tenant and
 * every query would have to know which one, which is the opposite of a default.
 *
 * A fixed value is also what makes the feature switchable: with the column
 * always present and always the same value, turning the feature on is a matter
 * of resolving a *different* tenant, and turning it off is a matter of
 * resolving this one. Nothing has to be backfilled either way.
 */
export const DEFAULT_TENANT_ID = '00000000-0000-4000-8000-000000000001';

/**
 * The header the tenant is read from, when the feature is on.
 *
 * **Overridable, because the header is a deployment's business.** A gateway
 * that terminates TLS and sets the tenant for its own reasons uses a different
 * name, and a name that cannot be changed is a name somebody will work around
 * by setting a header nobody reads.
 */
export const DEFAULT_TENANT_HEADER = 'x-tenant-id';
