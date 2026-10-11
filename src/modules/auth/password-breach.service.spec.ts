import { describe, expect, it } from 'vitest';

import {
  countMatches,
  PREFIX_LENGTH,
  passwordDigest,
} from './password-breach.service.js';

/**
 * The k-anonymity property is arithmetic, and these assert the arithmetic rather
 * than the HTTP. A digest computed with the wrong case or the wrong separator makes
 * every lookup return "not breached", which is a security control that silently
 * does nothing.
 */

/** The digest the API's own documentation uses for this well-known password. */
const PASSWORD_DIGEST = '5BAA61E4C9B93F3F0682250B6CF8331B7EE68FD8';

describe('passwordDigest', () => {
  it('is the SHA-1 the range API is defined in terms of, uppercased', () => {
    // Uppercase because the API returns uppercase suffixes; comparing a lowercase
    // digest against them finds nothing, and the check then passes everything.
    expect(passwordDigest('password')).toBe(PASSWORD_DIGEST);
  });

  it('is forty characters, which is what a prefix and a suffix are cut from', () => {
    expect(passwordDigest('anything')).toHaveLength(40);
  });

  it('sends only the first five characters, so the service learns one bucket', () => {
    // The whole reason to use this API. The other half of the digest never leaves
    // the process.
    const digest = passwordDigest('password');

    expect(digest.slice(0, PREFIX_LENGTH)).toHaveLength(5);
    expect(digest.slice(0, PREFIX_LENGTH)).toBe(PASSWORD_DIGEST.slice(0, 5));
  });

  it('splits the whole digest, so nothing is lost between the two halves', () => {
    // Five characters go out and thirty-five come back. The property that depends on
    // it is that the split is lossless: dropping a character would make two
    // passwords indistinguishable.
    const digest = passwordDigest('password');

    expect(digest.slice(PREFIX_LENGTH)).toHaveLength(35);
    expect(digest.slice(0, PREFIX_LENGTH) + digest.slice(PREFIX_LENGTH)).toBe(
      digest,
    );
  });

  it('distinguishes two passwords that share a prefix', () => {
    // Found by searching for a collision rather than picked: `password` and
    // `passwort` do not share five SHA-1 characters, so a test using them would
    // assert the prefix half and read as if it asserted the split. These two do
    // collide, and a comparison on the prefix alone would report both as breached.
    const a = passwordDigest('pw2001');
    const b = passwordDigest('pw2501');

    expect(a.slice(0, PREFIX_LENGTH)).toBe(b.slice(0, PREFIX_LENGTH));
    expect(a.slice(PREFIX_LENGTH)).not.toBe(b.slice(PREFIX_LENGTH));
  });

  it('handles a non-ascii password, which sha1 must encode as utf8', () => {
    // The service compares against hex, so an encoding mismatch here is a lookup
    // that always misses.
    expect(passwordDigest('pässwörd')).toMatch(/^[0-9A-F]{40}$/);
  });
});

describe('countMatches', () => {
  const body = [
    '0018A45C4D1DEF81644B54AB7F969B88D65:1',
    '00D4F6E8FA6EECAD2A3AA415EEC418D38EC:2',
    '5BAA61E4C9B93F3F0682250B6CF8331B7EE68FD8:3730471',
    '5BAA61E4C9B93F3F0682250B6CF8331B7EE68FD9:2',
  ].join('\r\n');

  it('finds a suffix and returns how many times it appears', () => {
    // The count is what the log line reports, and it is also how a caller can tell
    // `Password1!` from `123456789`.
    expect(countMatches(body, '5BAA61E4C9B93F3F0682250B6CF8331B7EE68FD8')).toBe(
      3_730_471,
    );
  });

  it('does not match a suffix that is a prefix of another entry', () => {
    // The `...FD9` line differs from the target only in its last character. A
    // `startsWith` comparison would report a match and refuse a password that has
    // never been in a breach.
    expect(countMatches(body, '5BAA61E4C9B93F3F0682250B6CF8331B7EE68FD')).toBe(
      0,
    );
  });

  it('handles CRLF line endings, which the service returns', () => {
    // Without the trim, the entry on the last line would never match.
    const single = 'ABCDEF:5\r\n';

    expect(countMatches(single, 'ABCDEF')).toBe(5);
  });

  it('returns zero for a suffix the corpus does not have', () => {
    expect(countMatches(body, 'FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF')).toBe(
      0,
    );
  });

  it('returns zero for an empty body rather than throwing', () => {
    // An empty body is what a 200 with no content looks like, and it must read as
    // "not breached" rather than take signup down.
    expect(countMatches('', 'ABCDEF')).toBe(0);
  });

  it('skips a malformed line rather than throwing on it', () => {
    // A line with no colon cannot be a suffix:count pair, and a body that happens
    // to contain one must not make the whole lookup fail open by accident.
    const withJunk = `not-a-pair\r\n${'ABCDEF:1'}`;

    expect(countMatches(withJunk, 'ABCDEF')).toBe(1);
  });

  it('treats a missing count as one occurrence', () => {
    // `ABCDEF:` is malformed but unambiguous. Returning 1 rather than 0 keeps the
    // fail-closed direction on the parsing path, which is the only place a
    // malformed response should err.
    expect(countMatches('ABCDEF:', 'ABCDEF')).toBe(1);
  });
});
