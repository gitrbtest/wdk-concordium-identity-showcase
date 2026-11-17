/**
 * Story 5: Maya's company card. Example Corp tops up an allowance in a token (TN) on her own account; she pays
 * approved suppliers with it, and Example Corp pays each payment's fee (a sponsored transaction). Her keys stay here.
 *
 *   1 the card checks Example Corp's policy (approved suppliers): not approved → refused here, nothing sent
 *   2 Example Corp authorises: it builds the transfer from her account and signs it as SPONSOR
 *   3 she approves; the phone signs it as the SENDER (Concordium's SDK, with her account key)
 *   4 Example Corp sends it; it is final in seconds
 */
import * as sdk from '@concordium/web-sdk';
import { View, Text, StyleSheet } from 'react-native';
import { node } from './concordium';

/** The card's policy from the company, or null if this account has no company card. */
export async function fetchCard(relay, address) {
  const res = await fetch(`${relay}/relay/card/policy?account=${address}`);
  return res.ok ? { relay, ...(await res.json()) } : null;
}

/** The card's balance: the account's holding of the card's token (TN), read from the chain. */
export async function cardBalance(address, tokenId) {
  const info = await node.getAccountInfo(sdk.AccountAddress.fromBase58(address));
  const held = (info.accountTokens ?? []).find((t) => t.id.toString() === tokenId);
  return held ? Number(held.state.balance.value) / 10 ** held.state.balance.decimals : 0;
}

/** Step 1 (here) and 2 (the company): the card's own policy check, then the company's authorisation. */
export async function authoriseCardPayment(card, from, supplier, amount) {
  if (!supplier.approved) throw new Error(`${supplier.name} is not an approved supplier (${card.company}'s policy). Nothing was sent.`);
  const allowance = await cardBalance(from, card.token);
  if (amount > allowance) throw new Error(`Your card holds ${allowance} ${card.token}; this payment needs ${amount}. Nothing was sent.`);
  const res = await fetch(`${card.relay}/relay/card/authorise`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ from, supplierId: supplier.id, amount }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error);
  // The phone checks what it is asked to sign: from her own account, in the card's token.
  const { header, payload } = JSON.parse(body.transaction);
  if (header.sender !== from || payload.tokenId !== card.token) throw new Error('The company sent a payment this card did not ask for.');
  return body;
}

/** Step 3 and 4: she approved; sign as the sender with her account key, and hand it back to be sent. */
export async function signAndPay(card, authorisation, seedPhrase, { providerIndex, identityIndex, credNumber }) {
  const key = sdk.ConcordiumHdWallet.fromSeedPhrase(seedPhrase, 'Testnet')
    .getAccountSigningKey(providerIndex, identityIndex, credNumber).toString('hex');
  const transaction = sdk.Transaction.fromJSONString(authorisation.transaction, sdk.Transaction.signableFromJSON);
  const signed = await sdk.Transaction.sign(transaction, sdk.buildBasicAccountSigner(key));
  const res = await fetch(`${card.relay}/relay/card/submit`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: authorisation.id, transaction: sdk.Transaction.toJSONString(signed) }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error);
  return body;
}

export function CompanyCard({ card, balance, pending, result, onPay, onApprove, onCancel, Button }) {
  if (pending) {
    return (
      <View>
        <Text style={styles.label}>Pay</Text>
        <Text style={styles.amount}>{pending.amount} {pending.token}</Text>
        <Text style={styles.label}>To</Text>
        <Text style={styles.value}>{pending.supplier} (approved by {card.company})</Text>
        <Text style={styles.small}>From your account, with your {card.company} card. {pending.sponsor} pays the network fee.</Text>
        <Button label={`Pay ${pending.amount} ${pending.token}`} onPress={onApprove} />
        <Button label="Cancel" kind="quiet" onPress={onCancel} />
      </View>
    );
  }
  return (
    <View>
      <Text style={styles.label}>Allowance</Text>
      <Text style={styles.amount}>{balance ?? '…'} {card.token}</Text>
      <Text style={styles.label}>Pay a supplier ({card.maxPayment} {card.token} at most per payment)</Text>
      {card.suppliers.map((s) => (
        <Button key={s.id} label={`Pay ${s.name} 20 ${card.token}`} kind={s.approved ? undefined : 'quiet'} onPress={() => onPay(s, 20)} />
      ))}
      {result && <Text style={result.ok ? styles.ok : styles.warn}>{result.text}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  label: { fontSize: 12, color: '#6a727c', marginTop: 10, marginBottom: 2 },
  amount: { fontSize: 22, fontWeight: '700', color: '#0a1a2f' },
  value: { fontSize: 15, color: '#22262c' },
  small: { fontSize: 12, color: '#6a727c', marginTop: 8 },
  ok: { fontSize: 14, color: '#0f7a4f', fontWeight: '600', marginTop: 10 },
  warn: { fontSize: 13, color: '#b00020', marginTop: 10 },
});
