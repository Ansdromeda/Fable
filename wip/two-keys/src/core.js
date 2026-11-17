/* ==== Two Keys core =========================================================================
   The sealed-file format, the key cards and the maths behind them. Pure functions on WebCrypto,
   no DOM. Format notes for anyone opening a file without this page are in "How the file is made".
   ============================================================================================ */
function tkCore() {
  'use strict';
  const subtle = globalThis.crypto.subtle;
  const te = new TextEncoder(), td = new TextDecoder('utf-8', { fatal: true });
  const FORMAT = 'two-keys-envelope', VERSION = 1, CARD_VERSION = 1, KDF_ITERATIONS = 600000;
  const CODE_CHARS = 72;                                  // 45 bytes in Crockford base32
  const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';    // no I, L, O, U

  class TKError extends Error {
    constructor(code, info) { super(code); this.name = 'TKError'; this.code = code; this.info = info || {}; }
  }

  /* ---- bytes ---- */
  const rand = n => globalThis.crypto.getRandomValues(new Uint8Array(n));
  function toB64(u8) { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); }
  function fromB64(str) {
    let s; try { s = atob(String(str)); } catch (_) { throw new TKError('corrupt'); }
    const u8 = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i); return u8;
  }
  const toHex = u8 => Array.from(u8, b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
  function fromHex(h) {
    if (!/^(?:[0-9A-Fa-f]{2})*$/.test(h)) throw new TKError('corrupt');
    const u8 = new Uint8Array(h.length / 2); for (let i = 0; i < u8.length; i++) u8[i] = parseInt(h.substr(i * 2, 2), 16); return u8;
  }
  function concat(...parts) { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; }
  async function sha256(u8) { return new Uint8Array(await subtle.digest('SHA-256', u8)); }

  /* ---- GF(2^8), reduction polynomial 0x11b, generator 3 ---- */
  const EXP = new Uint8Array(510), LOG = new Uint8Array(256);
  (() => { let x = 1; for (let i = 0; i < 255; i++) { EXP[i] = x; EXP[i + 255] = x; LOG[x] = i; let d = x << 1; if (d & 0x100) d ^= 0x11b; x = d ^ x; } })();
  const gmul = (a, b) => (a && b) ? EXP[LOG[a] + LOG[b]] : 0;
  const gdiv = (a, b) => { if (!b) throw new TKError('corrupt'); return a ? EXP[LOG[a] + 255 - LOG[b]] : 0; };

  /* ---- Shamir secret sharing, byte by byte. Any k of the n points rebuild the secret; fewer reveal nothing. ---- */
  function split(secret, n, k) {
    if (!Number.isInteger(n) || !Number.isInteger(k) || k < 2 || n < k || n > 255) throw new TKError('bad_request');
    const points = Array.from({ length: n }, (_, i) => ({ x: i + 1, y: new Uint8Array(secret.length) }));
    for (let b = 0; b < secret.length; b++) {
      const coef = new Uint8Array(k); coef[0] = secret[b]; coef.set(rand(k - 1), 1);
      for (const p of points) { let acc = 0; for (let j = k - 1; j >= 0; j--) acc = gmul(acc, p.x) ^ coef[j]; p.y[b] = acc; }
    }
    return points;
  }
  function combine(points) {
    const len = points[0].y.length, out = new Uint8Array(len);
    const weight = points.map((p, i) => { let num = 1, den = 1; points.forEach((q, j) => { if (i !== j) { num = gmul(num, q.x); den = gmul(den, p.x ^ q.x); } }); return gdiv(num, den); });
    for (let b = 0; b < len; b++) { let acc = 0; for (let i = 0; i < points.length; i++) acc ^= gmul(points[i].y[b], weight[i]); out[b] = acc; }
    return out;
  }

  /* ---- Crockford base32 ---- */
  function b32encode(u8) {
    let bits = 0, acc = 0, out = '';
    for (const b of u8) { acc = (acc << 8) | b; bits += 8; while (bits >= 5) { bits -= 5; out += ALPHABET[(acc >>> bits) & 31]; } acc &= (1 << bits) - 1; }
    if (bits) out += ALPHABET[(acc << (5 - bits)) & 31];
    return out;
  }
  function b32decode(str) {
    let bits = 0, acc = 0; const out = [];
    for (const ch of str) { const v = ALPHABET.indexOf(ch); if (v < 0) throw new TKError('card_chars', { char: ch }); acc = (acc << 5) | v; bits += 5; if (bits >= 8) { bits -= 8; out.push((acc >>> bits) & 255); acc &= (1 << bits) - 1; } }
    return new Uint8Array(out);
  }

  /* ---- key cards: 45 bytes = version, 4-byte envelope ID, k, n, x, 32 key bytes, 5-byte checksum ---- */
  const CARD_TAG = te.encode('two-keys-card-v1');
  async function cardChecksum(body) { return (await sha256(concat(CARD_TAG, body))).subarray(0, 5); }
  const group = code => code.match(/.{4}/g).join('-');
  // Forgiving read of what someone typed: any case, any spacing, O for 0, I or L for 1.
  const tidy = text => String(text == null ? '' : text).toUpperCase().replace(/O/g, '0').replace(/[IL]/g, '1');
  const strip = text => tidy(text).replace(/[^0-9A-Z]/g, '');
  const VALID = /^[0-9A-HJKMNP-TV-Z]*$/;

  async function encodeCard({ keyId, k, n, x, y }) {
    const body = new Uint8Array(40);
    body[0] = CARD_VERSION; body.set(keyId, 1); body[5] = k; body[6] = n; body[7] = x; body.set(y, 8);
    return group(b32encode(concat(body, await cardChecksum(body))));
  }
  // How far along a typed code is, before judging it: { have, need, badChar }
  function codeProgress(text) { const c = strip(text); const bad = c.match(/[^0-9A-HJKMNP-TV-Z]/); return { have: c.length, need: CODE_CHARS, badChar: bad ? bad[0] : null }; }

  async function readCard(text) {
    const whole = strip(text);
    if (!whole) throw new TKError('card_empty');
    // A code may arrive inside a longer message ("Key card 2 of 3 ... 4KQ7-9M2X-..."): look for the printed shape first.
    const candidates = [];
    const shape = /(?:^|[^0-9A-Z])([0-9A-HJKMNP-TV-Z]{4}(?:[-‐-―][0-9A-HJKMNP-TV-Z]{4}){17})(?![0-9A-Z])/g;
    const t = tidy(text); let m;
    while ((m = shape.exec(t))) candidates.push(m[1].replace(/[^0-9A-Z]/g, ''));
    if (whole.length === CODE_CHARS && VALID.test(whole) && !candidates.includes(whole)) candidates.push(whole);
    let raw = null;
    for (const c of candidates) {
      const bytes = b32decode(c), want = await cardChecksum(bytes.subarray(0, 40));
      if (want.every((v, i) => v === bytes[40 + i])) { raw = bytes; break; }
    }
    if (!raw) {
      if (candidates.length) throw new TKError('card_checksum');
      const bad = whole.match(/[^0-9A-HJKMNP-TV-Z]/);
      if (bad) throw new TKError('card_chars', { char: bad[0] });
      throw new TKError('card_length', { have: whole.length, need: CODE_CHARS });
    }
    if (raw[0] !== CARD_VERSION) throw new TKError('card_version', { version: raw[0] });
    const k = raw[5], n = raw[6], x = raw[7];
    if (k < 2 || n < k || x < 1 || x > n) throw new TKError('card_checksum');
    return { keyId: toHex(raw.subarray(1, 5)), k, n, x, y: raw.slice(8, 40), code: group(b32encode(raw)) };
  }

  /* ---- encryption ---- */
  const aad = (id, purpose) => te.encode(FORMAT + '/v' + VERSION + '/' + id + '/' + purpose);
  const importAes = raw => subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
  async function gcmEncrypt(key, plain, ad) {
    const iv = rand(12);
    return { iv: toB64(iv), ct: toB64(new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: ad }, key, plain))) };
  }
  async function gcmDecrypt(key, box, ad) {
    return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: fromB64(box.iv), additionalData: ad }, key, fromB64(box.ct)));
  }
  // The same passphrase must work on any keyboard: normalise accents and stray spaces before stretching it.
  const cleanPass = p => String(p).normalize('NFKC').trim().replace(/\s+/g, ' ');
  async function deriveKek(passphrase, salt, iterations) {
    const base = await subtle.importKey('raw', te.encode(cleanPass(passphrase)), 'PBKDF2', false, ['deriveKey']);
    return subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }

  /* ---- making a file ---- */
  // Stretch the owner's passphrase once per session. The returned key never leaves memory.
  async function newOwnerKey(passphrase) {
    const salt = rand(16);
    return { kek: await deriveKek(passphrase, salt, KDF_ITERATIONS), kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: KDF_ITERATIONS, salt: toB64(salt) } };
  }
  // A new lock: fresh master key, fresh envelope ID, master key wrapped for the owner.
  async function newLock(kek) {
    const mk = rand(32), id = toHex(rand(4));
    return { mk, id, wrappedKey: await gcmEncrypt(kek, mk, aad(id, 'owner-key')) };
  }
  // One key card code per holder. Call once per lock: a second set for the same lock would not mix with the first.
  async function issueCards(mk, id, n, k) {
    const keyId = fromHex(id);
    if (keyId.length !== 4 || mk.length !== 32) throw new TKError('bad_request');
    return Promise.all(split(mk, n, k).map(p => encodeCard({ keyId, k, n, x: p.x, y: p.y })));
  }
  // Encrypt the content and assemble the envelope. JSON.stringify(envelope, null, 2) is the sealed file.
  async function seal({ mk, id, kdf, wrappedKey, content, owner, holders, threshold, created, updated, draft }) {
    const now = updated || new Date().toISOString();
    const payload = await gcmEncrypt(await importAes(mk), te.encode(JSON.stringify(content)), aad(id, 'payload'));
    const env = { format: FORMAT, version: VERSION, id, created: created || now, updated: now, owner: owner || '', holders: holders || [], threshold: threshold || 0, cards: (holders || []).length, kdf, wrappedKey, payload };
    if (draft) env.draft = true;
    return env;
  }

  /* ---- opening a file ---- */
  function parseEnvelope(text) {
    let env; try { env = JSON.parse(String(text).replace(/^﻿/, '')); } catch (_) { throw new TKError('bad_json'); }
    if (!env || typeof env !== 'object' || env.format !== FORMAT) throw new TKError('not_envelope');
    if (env.version !== VERSION) throw new TKError('unsupported_version', { version: env.version });
    const box = b => b && typeof b.iv === 'string' && typeof b.ct === 'string';
    if (typeof env.id !== 'string' || !/^[0-9A-F]{8}$/.test(env.id) || !box(env.payload)) throw new TKError('corrupt');
    return env;
  }
  async function openPayload(mk, env) {
    return JSON.parse(td.decode(await gcmDecrypt(await importAes(mk), env.payload, aad(env.id, 'payload'))));
  }
  async function unlockWithCards(env, cardTexts) {
    const cards = [];
    for (let i = 0; i < cardTexts.length; i++) {
      let c; try { c = await readCard(cardTexts[i]); } catch (e) { if (e instanceof TKError) e.info.index = i; throw e; }
      if (c.keyId !== env.id) throw new TKError('card_other_envelope', { index: i, cardId: c.keyId });
      if (cards.some(o => o.x === c.x)) throw new TKError('card_duplicate', { index: i });
      cards.push(c);
    }
    const need = cards.length ? cards[0].k : (env.threshold || 2);
    if (cards.some(c => c.k !== need || c.n !== cards[0].n)) throw new TKError('cards_mixed');
    if (cards.length < need) throw new TKError('cards_too_few', { have: cards.length, need });
    const used = cards.slice(0, need), mk = combine(used);
    let content; try { content = await openPayload(mk, env); } catch (_) { throw new TKError('cards_wrong'); }
    return { mk, content, used: used.map(c => c.x) };
  }
  async function unlockWithPassphrase(env, passphrase) {
    const kdf = env.kdf, box = env.wrappedKey;
    if (!kdf || !box) throw new TKError('no_passphrase');
    if (kdf.name !== 'PBKDF2' || kdf.hash !== 'SHA-256' || !Number.isInteger(kdf.iterations) || kdf.iterations < 1 || kdf.iterations > 10000000 || typeof box.iv !== 'string' || typeof box.ct !== 'string') throw new TKError('corrupt');
    const kek = await deriveKek(passphrase, fromB64(kdf.salt), kdf.iterations);
    let mk; try { mk = await gcmDecrypt(kek, box, aad(env.id, 'owner-key')); } catch (_) { throw new TKError('pass_wrong'); }
    let content; try { content = await openPayload(mk, env); } catch (_) { throw new TKError('corrupt'); }
    return { mk, kek, content };
  }

  return { TKError, FORMAT, VERSION, KDF_ITERATIONS, CODE_CHARS, newOwnerKey, newLock, issueCards, seal, parseEnvelope, unlockWithCards, unlockWithPassphrase, readCard, codeProgress, group, toHex,
    _internals: { split, combine, gmul, gdiv, b32encode, b32decode, encodeCard, rand, deriveKek, gcmEncrypt, aad, fromHex, strip } };
}
if (typeof module !== 'undefined' && module.exports) module.exports = tkCore;
