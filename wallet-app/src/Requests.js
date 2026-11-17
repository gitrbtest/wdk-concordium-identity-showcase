/**
 * Requests from websites (showcase): a website asks the wallet to prove something; the person sees exactly what is
 * asked and agrees or declines; on agreeing, the identity package builds the proof here, on the phone.
 *
 * How the question arrives: the website shows a QR code (a link wdkshowcase://request?relay=…&code=…) and a short
 * code. A real phone opens the link from its camera; on the emulator, type the code. The relay stands in for the
 * wallet connection (WalletConnect in a real app): it carries the question here and the answer back.
 *
 * The kinds of request (each question is recorded on chain by the website first; the proof is tied to it):
 *   withdrawal  about an account ("prove this account is yours, and show your name"): answered from that account
 *   age         about the person only ("over 18?"): answered from the identity itself, no account named
 *   pledge      a question answered from one of the identity's accounts, plus a pledge text signed with the
 *               wallet's Ethereum key (the paying address)
 *   pay         pay a pledge: a USDT transfer on Ethereum from the wallet's Ethereum account (WDK's EVM module)
 */
import { useState } from 'react';
import { View, Text, TextInput, StyleSheet } from 'react-native';
import { ethereumAddress, ethereumSign, ethereumPay } from './OtherChains';

/**
 * The showcase server (relay): where typed codes, the company card and a restored wallet's pledges are looked up. By
 * default the computer running the server, as the Android emulator reaches it; for a real phone, start Metro with
 * EXPO_PUBLIC_RELAY=http://<the computer's address on the Wi-Fi>:4400 (a QR code carries its own address anyway).
 */
export const DEFAULT_RELAY = process.env.EXPO_PUBLIC_RELAY || 'http://10.0.2.2:4400';

/** Read a request link (wdkshowcase://request?relay=…&code=…), or null if it is not one. */
export function readRequestLink(url) {
  const match = /^wdkshowcase:\/\/request\?(.*)$/.exec(url ?? '');
  if (!match) return null;
  const params = Object.fromEntries(match[1].split('&').map((pair) => pair.split('=').map(decodeURIComponent)));
  return params.code ? { relay: params.relay || DEFAULT_RELAY, code: params.code } : null;
}

/** New phone: ask a campaign for the pledges paid from this wallet's Ethereum address, proving it owns the address. */
export async function findMyPledges(relay, seedPhrase) {
  const from = await ethereumAddress(seedPhrase);
  const at = String(Date.now());
  const signature = await ethereumSign(seedPhrase, `List the pledges paid from ${from} (${at})`);
  const res = await fetch(`${relay}/relay/pledges?from=${from}&at=${at}&signature=${signature}`);
  const list = await res.json();
  if (!res.ok) throw new Error(list.error ?? `The campaign answered ${res.status}.`);
  return list.map((p) => ({ ...p, relay }));
}

/** Fetch the question waiting under a code, and find which of this identity's accounts it is about. */
export async function fetchRequest(identity, summary, { relay, code }, seedPhrase) {
  const response = await fetch(`${relay}/relay/${encodeURIComponent(code.trim().toUpperCase())}`);
  const question = await response.json();
  if (!response.ok) throw new Error(question.error ?? `The website answered ${response.status}.`);
  const { providerIndex, identityIndex } = summary;
  if (question.kind === 'age') return { relay, code: code.trim().toUpperCase(), question, account: null }; // no account involved
  if (question.kind === 'pay') {
    const myAddress = await ethereumAddress(seedPhrase);
    return { relay, code: code.trim().toUpperCase(), question, account: null, payFrom: myAddress,
      mine: myAddress === question.pay.from }; // the pledge was made from this wallet's address
  }
  if (question.kind === 'pledge') {
    // Any of the identity's accounts can answer; the pledge is paid from the wallet's Ethereum account.
    const [account] = await identity.accountsThatCanAnswer({ providerIndex, identityIndex, request: question.request });
    const payFrom = await ethereumAddress(seedPhrase);
    return { relay, code: code.trim().toUpperCase(), question, account: account ?? null, payFrom,
      text: question.pledge.textTemplate.replace('{payFrom}', payFrom) };
  }
  // The accounts of this identity that can truly answer (none if the identity cannot, e.g. a provider not accepted).
  const accounts = await identity.accountsThatCanAnswer({ providerIndex, identityIndex, request: question.request });
  return { relay, code: code.trim().toUpperCase(), question, account: accounts.find((a) => a.address === question.account) ?? null };
}

/** Build the proof here (the person agreed) and send it back. Returns the website's reply. */
export async function approveRequest(identity, summary, { relay, code, question, account, payFrom, text }, seedPhrase) {
  const { providerIndex, identityIndex } = summary;
  if (question.kind === 'age') {
    // From the identity itself; refused before anything is built if the answer would not be true.
    const proof = await identity.prove({ providerIndex, identityIndex, request: question.request });
    return send(relay, code, { presentation: JSON.stringify(proof) });
  }
  if (question.kind === 'pay') {
    const hash = await ethereumPay(seedPhrase, question.pay);
    return send(relay, code, { hash }); // the campaign finds it on Ethereum and matches it to the pledge
  }
  if (question.kind === 'pledge') {
    // Who: the Concordium proof. Which address pays: the pledge text signed with the Ethereum key. Both for this pledge.
    const proof = await identity.prove({ providerIndex, identityIndex, request: question.request, credNumber: account.credNumber });
    const signature = await ethereumSign(seedPhrase, text);
    return send(relay, code, { presentation: JSON.stringify(proof), payFrom, signature });
  }
  // From the account being withdrawn to: the proof names it.
  const proof = await identity.prove({ providerIndex, identityIndex, request: question.request, credNumber: account.credNumber });
  return send(relay, code, { presentation: JSON.stringify(proof) });
}

export const declineRequest = ({ relay, code }) => send(relay, code, { declined: true });

async function send(relay, code, body) {
  const response = await fetch(`${relay}/relay/${code}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const reply = await response.json();
  if (!response.ok) throw new Error(reply.error ?? `The website answered ${response.status}.`);
  return reply;
}

/** The code box. */
export function CodeEntry({ onOpen, Button }) {
  const [code, setCode] = useState('');
  return (
    <View>
      <TextInput value={code} onChangeText={setCode} placeholder="Code, e.g. N97ZG4" autoCapitalize="characters"
        autoCorrect={false} maxLength={6} style={styles.input} />
      <Button label="Open the request" onPress={() => onOpen({ relay: DEFAULT_RELAY, code })} />
    </View>
  );
}

/** The consent screen: who asks, why, exactly what, from which account. */
export function Consent({ request, onApprove, onDecline, Button }) {
  const { question, account } = request;
  if (question.kind === 'pay') {
    const { pay } = question;
    return (
      <View>
        <Text style={styles.from}>{question.from}</Text>
        <Text style={styles.small}>(as the website names itself)</Text>
        <Text style={styles.purpose}>{question.purpose}</Text>
        <Text style={styles.label}>You pay</Text>
        <Text style={styles.amount}>{pay.amount} {pay.token}</Text>
        <Text style={styles.label}>To the campaign's address, on {pay.chain}</Text>
        <Text style={styles.mono} selectable>{pay.to}</Text>
        <Text style={styles.label}>From your Ethereum account</Text>
        <Text style={styles.mono} selectable>{request.payFrom}</Text>
        <Text style={styles.small}>Ethereum's network fee is paid in ETH from the same account.</Text>
        {request.mine
          ? <Button label={`Pay ${pay.amount} ${pay.token}`} onPress={onApprove} />
          : <Text style={styles.warn}>This pledge was made from another address, so this wallet cannot pay it.</Text>}
        <Button label="Not now" kind="quiet" onPress={onDecline} />
      </View>
    );
  }
  if (question.kind === 'pledge') {
    return (
      <View>
        <Text style={styles.from}>{question.from}</Text>
        <Text style={styles.small}>(as the website names itself)</Text>
        <Text style={styles.purpose}>{question.purpose}</Text>
        <Text style={styles.label}>You sign this pledge:</Text>
        <Text style={styles.pledge} selectable>{request.text}</Text>
        <Text style={styles.label}>And you prove:</Text>
        {question.wording.flatMap((part) => part.asks).map((ask) => <Text key={ask.text} style={styles.ask}>• {ask.text}</Text>)}
        <Text style={styles.small}>The pledge is paid later from your Ethereum account, only if the goal is reached. Nothing
          else about you is shared.</Text>
        {account
          ? <Button label="Approve and pledge" onPress={onApprove} />
          : <Text style={styles.warn}>This identity cannot answer (for example under 18), so the wallet cannot pledge.</Text>}
        <Button label="Decline" kind="quiet" onPress={onDecline} />
      </View>
    );
  }
  if (question.kind === 'age') {
    return (
      <View>
        <Text style={styles.from}>{question.from}</Text>
        <Text style={styles.small}>(as the website names itself)</Text>
        <Text style={styles.purpose}>{question.purpose}</Text>
        <Text style={styles.label}>It asks you to:</Text>
        {question.wording.flatMap((part) => part.asks).map((ask) => <Text key={ask.text} style={styles.ask}>• {ask.text}</Text>)}
        <Text style={styles.small}>Answered from your identity: no account, no name and no date of birth are shared. Only the
          answer to this question.</Text>
        <Button label="Approve and send" onPress={onApprove} />
        <Button label="Decline" kind="quiet" onPress={onDecline} />
      </View>
    );
  }
  return (
    <View>
      <Text style={styles.from}>{question.from}</Text>
      <Text style={styles.small}>(as the website names itself)</Text>
      <Text style={styles.purpose}>{question.purpose}</Text>
      <Text style={styles.label}>It asks you to:</Text>
      <Text style={styles.ask}>• prove that you own this account</Text>
      {question.wording.flatMap((part) => part.asks).map((ask) => <Text key={ask.text} style={styles.ask}>• {ask.text}</Text>)}
      <Text style={styles.label}>Account</Text>
      <Text style={styles.mono} selectable>{question.account}</Text>
      {account ? (
        <>
          <Text style={styles.small}>One of this wallet's accounts. Only what is listed above is shared: nothing else about you.</Text>
          <Button label="Approve and send" onPress={onApprove} />
        </>
      ) : (
        <Text style={styles.warn}>This account is not one of this wallet's accounts (or this identity cannot answer), so the wallet
          cannot prove it is yours.</Text>
      )}
      <Button label="Decline" kind="quiet" onPress={onDecline} />
    </View>
  );
}

const styles = StyleSheet.create({
  input: { borderWidth: 1, borderColor: '#d4dbe0', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, fontSize: 18, letterSpacing: 3, fontFamily: 'monospace' },
  from: { fontSize: 18, fontWeight: '700', color: '#0a1a2f' },
  purpose: { fontSize: 14, color: '#22262c', marginTop: 8 },
  label: { fontSize: 12, color: '#6a727c', marginTop: 12, marginBottom: 4 },
  ask: { fontSize: 15, color: '#22262c', marginBottom: 2 },
  mono: { fontFamily: 'monospace', fontSize: 12, color: '#22262c' },
  small: { fontSize: 12, color: '#6a727c', marginTop: 4 },
  warn: { fontSize: 13, color: '#b00020', marginTop: 8 },
  amount: { fontSize: 22, fontWeight: '700', color: '#0a1a2f' },
  pledge: { fontSize: 13, color: '#22262c', backgroundColor: '#f1f4f6', borderRadius: 8, padding: 10, lineHeight: 19 },
});
