/**
 * A stand-in for Maya's card on this computer (story 5), to test Example Corp's side: a test account of the public
 * test phrase plays the card holder. Start the server with CARD_HOLDER set to that account first:
 *
 *   $env:CARD_HOLDER="4jxBvquQ3xp9LJJCnfWsq2StQXvhtmjr77sSs8PpfQhTQkNz3o"; npm start      (account 10)
 *   node --env-file=.env.payout test-card.mjs
 *
 * Sends testnet transactions: 1 TN to Example Office Supplies (fee paid by Example Corp). The public test phrase is
 * shared with everyone: never for anything of value.
 */
import * as sdk from '@concordium/web-sdk';

const RELAY = process.env.RELAY || 'http://localhost:4400';
const HOLDER = { address: '4jxBvquQ3xp9LJJCnfWsq2StQXvhtmjr77sSs8PpfQhTQkNz3o', identityIndex: 334563111, credNumber: 10 };
const post = async (path, body) => {
  const res = await fetch(`${RELAY}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { ok: res.ok, body: await res.json() };
};

const policy = await (await fetch(`${RELAY}/relay/card/policy?account=${HOLDER.address}`)).json();
console.log('policy:', policy.company, policy.suppliers.map((s) => `${s.name}${s.approved ? '' : ' (not approved)'}`).join(', '));

const casino = await post('/relay/card/authorise', { from: HOLDER.address, supplierId: 'casino', amount: 1 });
console.log('pay Example Casino:', casino.ok ? 'authorised?!' : `refused: ${casino.body.error}`);

const office = await post('/relay/card/authorise', { from: HOLDER.address, supplierId: 'office', amount: 1 });
if (!office.ok) throw new Error(office.body.error);
console.log(`pay ${office.body.supplier}: authorised, sponsored by ${office.body.sponsor}`);
const key = sdk.ConcordiumHdWallet.fromSeedPhrase(process.env.PAYOUT_SEED, 'Testnet')
  .getAccountSigningKey(0, HOLDER.identityIndex, HOLDER.credNumber).toString('hex');
const signed = await sdk.Transaction.sign(sdk.Transaction.fromJSONString(office.body.transaction, sdk.Transaction.signableFromJSON),
  sdk.buildBasicAccountSigner(key));
const done = await post('/relay/card/submit', { id: office.body.id, transaction: sdk.Transaction.toJSONString(signed) });
console.log('submitted:', done.ok ? `${done.body.ok ? 'paid' : 'REJECTED'} ${done.body.hash}` : done.body.error);

const again = await post('/relay/card/submit', { id: office.body.id, transaction: sdk.Transaction.toJSONString(signed) });
console.log('the same payment again:', again.ok ? 'accepted?!' : `refused: ${again.body.error}`);
