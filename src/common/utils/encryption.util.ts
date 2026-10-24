import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const KEY_LENGTH = 32;

/**
 * A fixed salt, because the derivation has to be deterministic.
 *
 * It is not a secret and does not need to be unique per value — a random salt
 * would make the same passphrase produce a different key on every boot and every
 * stored secret would stop decrypting. What matters is that it is distinct from
 * the input, so that `deriveKey(p)` and `deriveKey(p + salt)` do not collide, and
 * that it names the version, so the derivation can be changed later and the
 * change be recognisable.
 */
const KEY_SALT = 'nestjs-boilerplate:two-factor-key:v1';

export interface EncryptedValue {
  ciphertext: string;
  iv: string;
  authTag: string;
}

function assertKey(key: Buffer): void {
  if (key.length !== KEY_LENGTH) {
    throw new Error(
      `Encryption key must be ${KEY_LENGTH} bytes, received ${key.length}`,
    );
  }
}

/**
 * Authenticated encryption for secrets that must survive a database leak.
 * The auth tag is verified on decrypt, so tampered rows fail loudly instead of
 * returning garbage.
 */
export function encrypt(plaintext: string, key: Buffer): EncryptedValue {
  assertKey(key);

  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);

  return {
    ciphertext: encrypted.toString('base64'),
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
  };
}

export function decrypt(value: EncryptedValue, key: Buffer): string {
  assertKey(key);

  const decipher = createDecipheriv(
    ALGORITHM,
    key,
    Buffer.from(value.iv, 'base64'),
  );
  decipher.setAuthTag(Buffer.from(value.authTag, 'base64'));

  return Buffer.concat([
    decipher.update(Buffer.from(value.ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

/**
 * Derives a stable 32 byte key from any passphrase, so operators can put a
 * readable secret in the environment instead of raw key bytes.
 *
 * scrypt rather than a single SHA-256, which is what this used to do. The
 * difference matters only when the passphrase is weak, and a passphrase in an
 * environment file is exactly the thing an operator writes as `changeme` and
 * forgets: one SHA-256 means the stored ciphertext is only as protected as the
 * guessability of that string, and a leaked database turns "weak passphrase" into
 * "readable TOTP secret" with no work at all. The salt is fixed because the
 * output has to be stable — see `KEY_SALT`.
 *
 * The cost is deliberate and is paid once per encryption or decryption, not per
 * request: this runs on enrol, on disable and on two-factor login, never on the
 * password path.
 *
 * **Changing this invalidates every stored two-factor secret**, because the key
 * changes and the old ciphertext no longer decrypts. The affected users re-enrol;
 * `TWO_FACTOR_ENCRYPTION_KEY` itself does not have to change.
 */
export function deriveKey(passphrase: string): Buffer {
  return scryptSync(passphrase, KEY_SALT, KEY_LENGTH);
}
