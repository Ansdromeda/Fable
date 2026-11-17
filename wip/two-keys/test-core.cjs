// One test script for the Two Keys core. Loads the core from the BUILT page when it exists (the code that ships), else from src/core.js.
const fs = require('fs'); const assert = require('assert');
const built = '/home/user/Fable/two-keys.html';
let src, from;
if (process.argv[2] !== '--src' && fs.existsSync(built)) { const html = fs.readFileSync(built, 'utf8'); const a = html.indexOf('/* ==== Two Keys core'), b = html.indexOf('/* ==== end of Two Keys core'); assert(a > 0 && b > a, 'core markers not found in built page'); src = html.slice(a, b); from = 'built page'; }
else { src = fs.readFileSync(__dirname + '/src/core.js', 'utf8'); from = 'src/core.js'; }
const tkCore = new Function(src.replace(/if \(typeof module[^\n]*\n?/, '') + '\nreturn tkCore;')();
const TK = tkCore(); const I = TK._internals;
let passed = 0; const ok = (name) => { passed++; console.log('  ok  ' + name); };
const subsets = (arr, k) => { const out = []; (function rec(start, pick) { if (pick.length === k) { out.push(pick.slice()); return; } for (let i = start; i < arr.length; i++) { pick.push(arr[i]); rec(i + 1, pick); pick.pop(); } })(0, []); return out; };
const eq = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const rejects = async (p, code) => { try { await p; } catch (e) { assert(e instanceof TK.TKError, 'expected TKError, got ' + e); assert.strictEqual(e.code, code); return e; } assert.fail('expected rejection ' + code); };

(async () => {
  console.log('core loaded from ' + from);
  // 1. field arithmetic
  assert.strictEqual(I.gmul(0x57, 0x83), 0xC1); assert.strictEqual(I.gmul(0x57, 0x13), 0xFE);
  for (let a = 1; a < 256; a++) { assert.strictEqual(I.gmul(a, I.gdiv(1, a)), 1); for (const b of [1, 2, 3, 0x53, 0xCA, 255]) assert.strictEqual(I.gdiv(I.gmul(a, b), b), a); }
  ok('GF(2^8) multiplication matches FIPS-197 examples; every element has an inverse');

  // 2. Shamir: every k-subset rebuilds, k-1 does not
  for (const [k, n] of [[2, 2], [2, 3], [3, 5], [2, 6], [4, 6], [6, 6], [3, 3]]) {
    const secret = I.rand(32), pts = I.split(secret, n, k);
    for (const sub of subsets(pts, k)) assert(eq(I.combine(sub), secret), `k=${k} n=${n} subset failed`);
    for (const sub of subsets(pts, k - 1)) assert(!eq(I.combine(sub), secret), `k-1 subset rebuilt the secret (k=${k} n=${n})`);
    if (n > k) assert(eq(I.combine(pts), secret), 'all n points rebuild too');
  }
  ok('Shamir: every k-subset of n rebuilds the key for (2,2) (2,3) (3,5) (2,6) (4,6) (6,6) (3,3); k-1 never does');
  // statistical sanity: a single share byte is uniform regardless of the secret byte (weak check of the random coefficients)
  { const counts = new Uint32Array(256); for (let i = 0; i < 4000; i++) counts[I.split(new Uint8Array([0x41]), 3, 2)[0].y[0]]++; assert(counts.filter(c => c > 0).length > 250, 'share bytes not spread'); assert(Math.max(...counts) < 45); }
  ok('share bytes are spread across all values (random coefficients in use)');
  assert.throws(() => I.split(I.rand(32), 3, 1)); assert.throws(() => I.split(I.rand(32), 2, 3));
  ok('split refuses a threshold below 2 or above n');

  // 3. base32 + cards
  for (let i = 0; i < 50; i++) { const b = I.rand(45); const s = I.b32encode(b); assert.strictEqual(s.length, 72); assert(eq(I.b32decode(s), b)); }
  const keyId = I.rand(4), y = I.rand(32);
  const code = await I.encodeCard({ keyId, k: 2, n: 3, x: 2, y });
  assert(/^([0-9A-HJKMNP-TV-Z]{4}-){17}[0-9A-HJKMNP-TV-Z]{4}$/.test(code), code);
  const card = await TK.readCard(code);
  assert.deepStrictEqual([card.keyId, card.k, card.n, card.x, card.code], [TK.toHex(keyId), 2, 3, 2, code]); assert(eq(card.y, y));
  ok('card code is 18 groups of 4 and reads back exactly');
  const messy = [code.toLowerCase(), code.replace(/-/g, ' '), code.replace(/-/g, ''), '  ' + code.replace(/-/g, ' - ') + '\n', code.replace(/0/g, 'O').replace(/1/g, 'l'), code.replace(/1/g, 'I'),
    'Key card 2 of 3, held by Ingrid Oliphant. Box 7F3A-91C2. Code: ' + code + '\nAny 2 cards open the file.', code.replace(/-/g, '–')];
  for (const m of messy) { const c = await TK.readCard(m); assert(eq(c.y, y), 'messy form failed: ' + m.slice(0, 30)); }
  ok('reading tolerates lower case, spaces, no dashes, O/0 and I/L/1 mix-ups, en dashes, and a code inside a longer message');
  const plain = code.replace(/-/g, ''); let caught = 0, tried = 0;
  for (let pos = 0; pos < plain.length; pos++) for (const alt of ['7', 'X', 'B']) { if (plain[pos] === alt) continue; tried++; const bad = plain.slice(0, pos) + alt + plain.slice(pos + 1); try { await TK.readCard(bad); } catch (e) { if (e.code === 'card_checksum') caught++; } }
  assert.strictEqual(caught, tried);
  ok(`a single wrong character is always caught by the checksum (${caught} of ${tried} single-character changes)`);
  const groups = code.split('-'); [groups[3], groups[4]] = [groups[4], groups[3]];
  if (groups[3] !== groups[4]) await rejects(TK.readCard(groups.join('-')), 'card_checksum');
  await rejects(TK.readCard(''), 'card_empty'); await rejects(TK.readCard('   '), 'card_empty');
  const eLen = await rejects(TK.readCard(plain.slice(0, 40)), 'card_length'); assert.strictEqual(eLen.info.have, 40);
  await rejects(TK.readCard(plain.slice(0, 71) + 'U'), 'card_chars');
  assert.deepStrictEqual(TK.codeProgress(code.slice(0, 24)), { have: 20, need: 72, badChar: null });
  ok('swapped groups, empty, short and invalid-character codes are each reported for what they are');

  // 4. whole envelope flow
  const pass = 'copper lantern orbit meadow';
  const owner = await TK.newOwnerKey(pass);
  assert.strictEqual(owner.kdf.iterations, 600000); assert.strictEqual(owner.kdf.hash, 'SHA-256');
  const lock = await TK.newLock(owner.kek);
  const content = { kind: 'two-keys-content', v: 1, owner: 'Ruth Calloway', sections: { first: [{ t: 'Call first', d: 'Maya, then Priya. Ünïcödé ✓ 日本語' }] } };
  const cards = await TK.issueCards(lock.mk, lock.id, 3, 2);
  const env = await TK.seal({ mk: lock.mk, id: lock.id, kdf: owner.kdf, wrappedKey: lock.wrappedKey, content, owner: 'Ruth Calloway', holders: ['Maya', 'Daniel', 'Priya'], threshold: 2 });
  const fileText = JSON.stringify(env, null, 2);
  assert(!fileText.includes('Call first') && !fileText.includes('Priya.'), 'plaintext leaked into the file');
  const parsed = TK.parseEnvelope('﻿' + fileText);
  assert.deepStrictEqual([parsed.format, parsed.version, parsed.threshold, parsed.cards, parsed.kdf.name], ['two-keys-envelope', 1, 2, 3, 'PBKDF2']);
  for (const sub of subsets(cards, 2)) { const r = await TK.unlockWithCards(parsed, sub); assert.deepStrictEqual(r.content, content); assert(eq(r.mk, lock.mk)); }
  assert.deepStrictEqual((await TK.unlockWithCards(parsed, cards)).content, content);
  ok('round trip: every pair of the three cards opens the file from its saved text, and so do all three');
  for (const c of cards) { const e = await rejects(TK.unlockWithCards(parsed, [c]), 'cards_too_few'); assert.deepStrictEqual([e.info.have, e.info.need], [1, 2]); }
  await rejects(TK.unlockWithCards(parsed, []), 'cards_too_few');
  ok('one card alone is refused (cards_too_few), as is no card');
  const eDup = await rejects(TK.unlockWithCards(parsed, [cards[0], cards[0].toLowerCase()]), 'card_duplicate'); assert.strictEqual(eDup.info.index, 1);
  const flipped = cards[1].slice(0, 10) + (cards[1][10] === '7' ? '8' : '7') + cards[1].slice(11);
  const eTypo = await rejects(TK.unlockWithCards(parsed, [cards[0], flipped]), 'card_checksum'); assert.strictEqual(eTypo.info.index, 1);
  ok('the same card twice and a card with a typo are each named, with which card it was');

  // cards from another envelope
  const lock2 = await TK.newLock(owner.kek); const cards2 = await TK.issueCards(lock2.mk, lock2.id, 3, 2);
  const eOther = await rejects(TK.unlockWithCards(parsed, [cards[0], cards2[1]]), 'card_other_envelope'); assert.strictEqual(eOther.info.index, 1);
  // genuine-looking cards for the same envelope ID but a different key must fail on the GCM tag, never return garbage
  const forged = await TK.issueCards(I.rand(32), lock.id, 3, 2);
  await rejects(TK.unlockWithCards(parsed, [forged[0], forged[1]]), 'cards_wrong');
  await rejects(TK.unlockWithCards(parsed, [cards[0], forged[1]]), 'cards_wrong');
  const mixed = await TK.issueCards(lock.mk, lock.id, 4, 3);
  await rejects(TK.unlockWithCards(parsed, [cards[0], mixed[1]]), 'cards_mixed');
  ok('cards from another envelope are rejected by ID; cards with the right ID but the wrong key fail authentication (cards_wrong)');

  // tampering
  const t1 = JSON.parse(fileText); t1.payload.ct = t1.payload.ct.slice(0, 20) + (t1.payload.ct[20] === 'A' ? 'B' : 'A') + t1.payload.ct.slice(21);
  await rejects(TK.unlockWithCards(t1, cards.slice(0, 2)), 'cards_wrong');
  const t2 = JSON.parse(fileText); t2.id = lock2.id; await rejects(TK.unlockWithCards(t2, cards.slice(0, 2)), 'card_other_envelope');
  ok('a tampered file fails cleanly instead of opening');

  // passphrase path
  const viaPass = await TK.unlockWithPassphrase(parsed, pass);
  assert.deepStrictEqual(viaPass.content, content); assert(eq(viaPass.mk, lock.mk));
  await rejects(TK.unlockWithPassphrase(parsed, 'copper lantern orbit meadows'), 'pass_wrong');
  await rejects(TK.unlockWithPassphrase(parsed, ''), 'pass_wrong');
  assert.deepStrictEqual((await TK.unlockWithPassphrase(parsed, '  copper  lantern orbit   meadow ')).content, content);
  const acc = await TK.newOwnerKey('café résumé naïve'); const lk = await TK.newLock(acc.kek);
  const envAcc = await TK.seal({ mk: lk.mk, id: lk.id, kdf: acc.kdf, wrappedKey: lk.wrappedKey, content: { a: 1 }, draft: true });
  assert.deepStrictEqual((await TK.unlockWithPassphrase(envAcc, 'café résumé naïve')).content, { a: 1 });
  assert.strictEqual(envAcc.draft, true); await rejects(TK.unlockWithCards(envAcc, []), 'cards_too_few');
  ok('the passphrase opens the file; a wrong one fails cleanly; stray spaces and composed/decomposed accents make no difference; drafts open by passphrase only');
  const noPass = JSON.parse(fileText); delete noPass.wrappedKey; await rejects(TK.unlockWithPassphrase(noPass, pass), 'no_passphrase');
  const badKdf = JSON.parse(fileText); badKdf.kdf.iterations = 5e9; await rejects(TK.unlockWithPassphrase(badKdf, pass), 'corrupt');

  // 5. update keeps cards; re-key retires them
  const content2 = Object.assign({}, content, { note: 'updated a year later' });
  const env2 = await TK.seal({ mk: viaPass.mk, id: parsed.id, kdf: parsed.kdf, wrappedKey: parsed.wrappedKey, content: content2, owner: 'Ruth Calloway', holders: parsed.holders, threshold: 2, created: parsed.created });
  assert.strictEqual(env2.created, parsed.created); assert.notStrictEqual(env2.payload.iv, parsed.payload.iv);
  for (const sub of subsets(cards, 2)) assert.deepStrictEqual((await TK.unlockWithCards(TK.parseEnvelope(JSON.stringify(env2)), sub)).content, content2);
  assert.deepStrictEqual((await TK.unlockWithPassphrase(env2, pass)).content, content2);
  ok('re-sealing with the same master key: the old cards and the passphrase open the updated file');
  const relock = await TK.newLock(viaPass.kek); const newCards = await TK.issueCards(relock.mk, relock.id, 3, 2);
  const env3 = await TK.seal({ mk: relock.mk, id: relock.id, kdf: parsed.kdf, wrappedKey: relock.wrappedKey, content: content2, holders: ['Maya', 'Daniel', 'Sam'], threshold: 2 });
  assert.notStrictEqual(env3.id, parsed.id);
  await rejects(TK.unlockWithCards(env3, cards.slice(0, 2)), 'card_other_envelope');
  for (const sub of subsets(newCards, 2)) assert.deepStrictEqual((await TK.unlockWithCards(env3, sub)).content, content2);
  assert.deepStrictEqual((await TK.unlockWithPassphrase(env3, pass)).content, content2);
  assert.deepStrictEqual((await TK.unlockWithCards(parsed, cards.slice(1))).content, content);
  ok('re-keying: old cards no longer open the new file, new cards do, the passphrase still does, and the old file still opens with old cards');

  // 6. other thresholds through the whole flow
  for (const [k, n] of [[3, 5], [2, 6], [4, 4]]) {
    const l = await TK.newLock(owner.kek), cs = await TK.issueCards(l.mk, l.id, n, k);
    const e = await TK.seal({ mk: l.mk, id: l.id, kdf: owner.kdf, wrappedKey: l.wrappedKey, content, holders: cs.map((_, i) => 'H' + i), threshold: k });
    for (const sub of subsets(cs, k)) assert.deepStrictEqual((await TK.unlockWithCards(e, sub)).content, content);
    for (const sub of subsets(cs, k - 1)) await rejects(TK.unlockWithCards(e, sub), 'cards_too_few');
  }
  ok('full flow holds for 3-of-5, 2-of-6 and 4-of-4');

  // 7. parse errors
  for (const [text, code] of [['not json', 'bad_json'], ['{"format":"something-else"}', 'not_envelope'], ['[]', 'not_envelope'], [JSON.stringify(Object.assign({}, env, { version: 2 })), 'unsupported_version'], [JSON.stringify(Object.assign({}, env, { payload: {} })), 'corrupt'], [JSON.stringify(Object.assign({}, env, { id: 'xyz' })), 'corrupt']]) {
    assert.throws(() => TK.parseEnvelope(text), e => e instanceof TK.TKError && e.code === code, text.slice(0, 30));
  }
  ok('files that are not sealed files, are damaged, or come from a newer version are each recognised');
  console.log(`\nALL ${passed} CHECKS PASSED`);
})().catch(e => { console.error('\nFAILED:', e); process.exit(1); });
