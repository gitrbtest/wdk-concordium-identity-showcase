/**
 * A small Android wallet showing Concordium identities with @concordium/wdk-identity-concordium in React Native
 * (testnet). Not a full wallet: just the steps an identity goes through, one screen at a time.
 *
 *   1. Wallet     a seed phrase, kept in the phone's secure storage (a new one, or the public test phrase)
 *   2. Verify     pick a provider; its page opens in a WebView; the app catches the return address (ProviderPage.js)
 *   3. Identity   collected, checked, kept (secure storage); after a restart it is imported from there
 *   4. Account    created on chain from the identity (free), with its address and CCD balance
 *   5. Requests   (showcase) a website such as Example Exchange asks the wallet to prove something: the person sees
 *                 what is asked and agrees; the proof is built here and sent back (src/Requests.js)
 *
 * The heavy cryptography runs in Concordium's native library (modules/concordium-native), plugged into the package.
 */
import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator, Alert, Image, Linking, Pressable, ScrollView, StyleSheet, Text, TextInput, View,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { generateMnemonic, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import ProviderPage from './src/ProviderPage';
import { RETURN_ADDRESS, identityFor, personProviders, ccdBalance } from './src/concordium';
import * as store from './src/storage';
import { ethereumAccount, ethereumMint, OtherChainsCard } from './src/OtherChains';
import { fetchCard, cardBalance, authoriseCardPayment, signAndPay, CompanyCard } from './src/CompanyCard';
import { findMyPledges, DEFAULT_RELAY, readRequestLink, fetchRequest, approveRequest, declineRequest, CodeEntry, Consent } from './src/Requests';

// Public demonstration phrase only (its identities are shared with everyone): never use it for anything of value.
const PUBLIC_TEST_PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

export default function App() {
  const identity = useRef(null); // the ConcordiumIdentity for this seed phrase
  const [screen, setScreen] = useState('loading'); // loading | wallet | verify | collecting | identity
  const [busy, setBusy] = useState(null);           // what is happening, while it happens
  const [error, setError] = useState(null);
  const [providers, setProviders] = useState([]);
  const [page, setPage] = useState(null);           // the provider page open in the WebView
  const [summary, setSummary] = useState(null);     // the identity's summary (no personal details)
  const [account, setAccount] = useState(null);     // { address, balance }
  const [request, setRequest] = useState(null);     // a website's question, open on the consent screen
  const [reply, setReply] = useState(null);         // what the website said after the answer
  const summaryRef = useRef(null);
  const scrollRef = useRef(null);                   // the screen, to bring the consent screen into view
  const requestsY = useRef(0);                      // where the Requests card is on the screen
  const [ethereum, setEthereum] = useState(null);       // the Ethereum account from the same seed (address, balances)
  const [ethereumSent, setEthereumSent] = useState(null); // the last Sepolia transaction (getting test USDT)
  const [pledges, setPledges] = useState([]);
  const [card, setCard] = useState(null);           // story 5: the company card's policy, if this account has one
  const [cardBal, setCardBal] = useState(null);     // its allowance (TN)
  const [cardPending, setCardPending] = useState(null); // a payment authorised by the company, waiting for her approval
  const [cardResult, setCardResult] = useState(null);
  const [restoreWords, setRestoreWords] = useState(''); // "New phone": the seed phrase typed or pasted to restore
  const [shownPhrase, setShownPhrase] = useState(null); // the seed phrase, while "Show my seed phrase" is open
  const [revealed, setRevealed] = useState(false);       // the words are masked (••••) until revealed
  const [showTyped, setShowTyped] = useState(false);     // the restore box shows dots until "Show" is pressed       // the pledges this wallet made, with their latest status                  // the identity shown, for links arriving at any time

  /** Run a step, showing what is happening, and any error in plain words. */
  const step = async (label, work) => {
    setBusy(label);
    setError(null);
    try {
      await work();
    } catch (e) {
      console.warn(`${label} failed:`, e?.stack ?? e);
      setError(`${e?.name ?? 'Error'}${e?.reason ? ` (${e.reason})` : ''}: ${e?.message ?? e}`);
    } finally {
      setBusy(null);
    }
  };

  // ---- Start: the seed phrase, then a waiting verification, a kept identity, or the providers ----
  const start = () => step('Opening the wallet…', async () => {
    setRequest(null); // a request left over from before cannot be answered again: start clean
    setReply(null);
    const seedPhrase = await store.loadSeedPhrase();
    if (!seedPhrase) { setScreen('wallet'); return; }
    identity.current?.dispose();
    identity.current = await identityFor(seedPhrase);

    const pending = await store.loadPending();
    if (pending) { await collect(pending); return; } // the app was closed while the provider was verifying

    const kept = await store.loadIdentity();
    if (kept) { await showIdentity(await identity.current.importIdentity(kept)); return; }

    setProviders(await personProviders());
    setScreen('verify');
  });
  useEffect(() => { start(); return () => identity.current?.dispose(); }, []);

  // ---- 1. Wallet ----
  const newWallet = (words) => step('Keeping the seed phrase in secure storage…', async () => {
    await store.keepSeedPhrase(words);
    await start();
  });

  // ---- New phone: restore everything from the seed phrase alone ----
  const restoreWallet = () => step('Restoring from the seed phrase: asking the identity providers, then the chain (up to a minute)…', async () => {
    const words = restoreWords.trim().toLowerCase().split(/\s+/).join(' ');
    if (!validateMnemonic(words, wordlist)) throw new Error('That is not a valid seed phrase: check the words and their order.');
    await store.keepSeedPhrase(words);
    identity.current?.dispose();
    identity.current = await identityFor(words);
    // The package gets every identity back from the providers, and finds each one's accounts on chain.
    const { identities } = await identity.current.recoverAll();
    const now = new Date().toISOString().slice(0, 7).replace('-', '');
    const found = identities.find((x) => x.summary.validTo >= now && x.accounts?.length) ?? identities.find((x) => x.summary.validTo >= now);
    setRestoreWords('');
    setShowTyped(false);
    if (!found) { setProviders(await personProviders()); setScreen('verify'); throw new Error('No identity was found for this seed phrase: verify a new one.'); }
    await store.keepIdentity(await identity.current.exportIdentity({ providerIndex: found.providerIndex, identityIndex: found.identityIndex }));
    await showIdentity(found.summary);
    // The pledges lived only on the old phone: ask the organisations this wallet knows (here Example Community Fund).
    try {
      for (const pledge of await findMyPledges(DEFAULT_RELAY, words)) await store.keepPledge(pledge);
      checkPledges();
    } catch { /* no campaign reachable: My pledges stays empty */ }
  });

  const toggleSeedPhrase = async () => { setRevealed(false); setShownPhrase(shownPhrase ? null : await store.loadSeedPhrase()); };

  // ---- 2. Verify: the provider's page in a WebView ----
  const verifyWith = (provider) => step(`Preparing the request for ${provider.name}…`, async () => {
    const providerIndex = provider.index;
    const identityIndex = await identity.current.nextIdentityIndex({ providerIndex }); // the next free number
    const { issuanceUrl } = await identity.current.createIdentityRequest({ providerIndex, identityIndex, redirectUri: RETURN_ADDRESS });
    setPage({ url: issuanceUrl, providerIndex, identityIndex });
  });

  /** The WebView caught the return address: keep the provider's reply first, then collect the identity. */
  const onReturn = (callbackUrl) => {
    const { providerIndex, identityIndex } = page;
    setPage(null);
    step('Reading the provider\'s reply…', async () => {
      const { codeUri } = identity.current.parseIdentityCallback(callbackUrl); // no network call
      const pending = { codeUri, providerIndex, identityIndex };
      await store.keepPending(pending); // so a restart can carry on (kept privately: the code_uri serves the details)
      await collect(pending);
    });
  };

  // ---- 3. Identity: collected (waiting for the provider if needed), checked, kept ----
  const collect = async ({ codeUri, providerIndex, identityIndex }) => {
    setScreen('collecting');
    setBusy('Waiting for the identity provider…');
    const issued = await identity.current.waitForIdentity(codeUri, { providerIndex, identityIndex });
    await store.keepIdentity(await identity.current.exportIdentity({ providerIndex, identityIndex }));
    await store.forgetPending();
    await showIdentity(issued);
  };

  const showIdentity = async (s) => {
    summaryRef.current = s;
    setSummary(s);
    setScreen('identity');
    const [first] = await identity.current.findAccounts({ providerIndex: s.providerIndex, identityIndex: s.identityIndex });
    setAccount(first ? { address: first.address, credNumber: first.credNumber, balance: await ccdBalance(first.address) } : null);
  };

  // ---- 4. Account ----
  const createAccount = () => step('Creating the account on chain (a few seconds, free)…', async () => {
    const { providerIndex, identityIndex } = summary;
    const credNumber = await identity.current.nextCredNumber({ providerIndex, identityIndex });
    const { address } = await identity.current.createAccount({ providerIndex, identityIndex, credNumber });
    setAccount({ address, credNumber, balance: await ccdBalance(address) });
  });
  const refreshBalance = () => step('Reading the balance…', async () => {
    setAccount({ ...account, balance: await ccdBalance(account.address) });
  });

  // ---- 5. Requests from websites (showcase) ----
  const openRequest = (link) => step('Reading the request…', async () => {
    if (!identity.current || !summaryRef.current) throw new Error('Open the wallet and its identity first, then open the request again.');
    setReply(null);
    setRequest(await fetchRequest(identity.current, summaryRef.current, link, await store.loadSeedPhrase()));
    setTimeout(() => scrollRef.current?.scrollTo({ y: requestsY.current, animated: true }), 100); // show the consent screen
  });
  const approve = () => step('Building the proof on this phone…', async () => {
    let answer;
    try {
      answer = await approveRequest(identity.current, summaryRef.current, request, await store.loadSeedPhrase());
    } finally {
      setRequest(null); // answered or not, this request is used up: the website starts a new one
    }
    if (request.question.kind === 'pledge' && answer.status === 'pledged') {
      await store.keepPledge({ relay: request.relay, id: request.question.pledge.id, organiser: request.question.from,
        amount: request.question.pledge.amount, token: request.question.pledge.token });
      checkPledges();
    }
    if (request.question.kind === 'pay') setEthereum(await ethereumAccount(await store.loadSeedPhrase())); // balances after paying
    setReply(answer.status === 'error'
      ? `Sent, but ${request.question.from} could not check it. Start a new withdrawal on the website.`
      : `Sent. ${request.question.from}: ${answer.status}.`);
  });
  const decline = () => step('Declining…', async () => {
    await declineRequest(request);
    setRequest(null);
    setReply('Declined: nothing was shared.');
  });

  const readEthereum = () => step('Reading the Ethereum account…', async () => {
    setEthereum(await ethereumAccount(await store.loadSeedPhrase()));
  });

  const mintTestUsdt = () => step('Getting test USDT on Sepolia (up to a minute)…', async () => {
    setEthereumSent(await ethereumMint(await store.loadSeedPhrase()));
    setEthereum(await ethereumAccount(await store.loadSeedPhrase())); // balances after it
  });

  // ---- My pledges: the wallet asks each campaign about its pledges, and says when it is time to pay ----
  const checkPledges = async () => {
    const mine = await store.loadPledges();
    setPledges(await Promise.all(mine.map(async (p) => {
      try {
        const res = await fetch(`${p.relay}/relay/pledge/${p.id}`);
        return { ...p, ...(res.ok ? await res.json() : { status: 'unknown' }) };
      } catch { return { ...p, status: 'unreachable' }; }
    })));
  };
  useEffect(() => {
    if (screen !== 'identity') return undefined;
    checkPledges();
    readEthereum();
    const timer = setInterval(checkPledges, 8000);
    return () => clearInterval(timer);
  }, [screen]);

  // ---- Story 5: the company card ----
  const refreshCard = async () => {
    if (!account?.address) return;
    try {
      const c = await fetchCard(DEFAULT_RELAY, account.address);
      setCard(c);
      if (c) setCardBal(await cardBalance(account.address, c.token));
    } catch { /* the company cannot be reached: no card shown */ }
  };
  useEffect(() => {
    if (screen !== 'identity' || !account?.address) return undefined;
    refreshCard();
    const timer = setInterval(refreshCard, 8000);
    return () => clearInterval(timer);
  }, [screen, account?.address]);
  const payWithCard = (supplier, amount) => {
    setCardResult(null);
    step(`Asking ${card.company} to authorise the payment…`, async () => {
      try {
        setCardPending(await authoriseCardPayment(card, account.address, supplier, amount));
      } catch (e) {
        setCardResult({ ok: false, text: e.message });
      }
    });
  };
  const approveCardPayment = () => step('Paying (signed on this phone; a few seconds)…', async () => {
    const pending = cardPending;
    setCardPending(null);
    const done = await signAndPay(card, pending, await store.loadSeedPhrase(),
      { providerIndex: summary.providerIndex, identityIndex: summary.identityIndex, credNumber: account.credNumber });
    setCardResult({ ok: done.ok, text: done.ok ? `Paid ${done.amount} ${card.token} to ${done.to}. Fee paid by ${card.company}.` : 'The chain refused the payment.' });
    setCardBal(await cardBalance(account.address, card.token));
  });

  // A request link from a QR code (wdkshowcase://request?…), when the app is opened by it or is already open.
  useEffect(() => {
    const onLink = (url) => { const link = readRequestLink(url); if (link) openRequest(link); };
    Linking.getInitialURL().then(onLink);
    const subscription = Linking.addEventListener('url', ({ url }) => onLink(url));
    return () => subscription.remove();
  }, []);

  const startAgain = () => Alert.alert('Start again?', 'This deletes the seed phrase and the identity from this phone. '
    + 'On testnet only: keep a real wallet\'s seed phrase written down.', [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Delete', style: 'destructive', onPress: () => step('Deleting…', async () => {
      identity.current?.dispose();
      identity.current = null;
      setSummary(null);
      summaryRef.current = null;
      setAccount(null);
      setRequest(null);
      setReply(null);
      setShownPhrase(null);
      setPledges([]);
      setCard(null);
      setCardPending(null);
      setCardResult(null);
      setEthereum(null);
      await store.forgetEverything();
      setScreen('wallet');
    }) },
  ]);

  // ---- Screens ----
  return (
    <View style={styles.app}>
      <StatusBar style="light" />
      <View style={styles.header}>
        {/* Concordium's official white logo (its Brand Kit), unaltered, with clear space around it. */}
        <Image source={require('./assets/concordium-logo-white.png')} style={styles.logo} resizeMode="contain"
          accessibilityLabel="Concordium" />
        <Text style={styles.sub}>WDK wallet · showcase · testnet</Text>
      </View>
      <ScrollView ref={scrollRef} contentContainerStyle={styles.body}>
        {screen === 'wallet' && (
          <Card title="1. Your wallet" note="A wallet starts with a seed phrase: every key comes from it. This example keeps it in the phone's secure storage (Android Keystore).">
            <Button label="Create a new wallet" onPress={() => newWallet(generateMnemonic(wordlist, 256))} />
            <Button label="Use the public test phrase" kind="quiet" onPress={() => newWallet(PUBLIC_TEST_PHRASE)} />
          </Card>
        )}
        {screen === 'wallet' && (
          <Card title="New phone? Restore your wallet" note="Type or paste your seed phrase. Your identity comes back from its provider, with no new verification, and your accounts are found on chain.">
            {/* A password-style field: the pasted words show as dots, so they never appear on screen (or in a recording). */}
            <TextInput value={restoreWords} onChangeText={setRestoreWords} placeholder="paste your 24 words here"
              secureTextEntry={!showTyped} autoCapitalize="none" autoCorrect={false} importantForAutofill="no"
              style={styles.wordsField} />
            <Text style={styles.small}>{restoreWords.trim() ? `${restoreWords.trim().split(/\s+/).length} words entered` : 'Long-press the box, then Paste.'}</Text>
            <Button label={showTyped ? 'Hide the words' : 'Show the words'} kind="quiet" onPress={() => setShowTyped(!showTyped)} />
            <Button label="Restore from a seed phrase" onPress={restoreWallet} />
          </Card>
        )}

        {screen === 'verify' && (
          <Card title="2. Verify your identity" note="Choose an identity provider. Its page opens inside the app; when you finish, it sends you back here.">
            {providers.map((p) => <Button key={p.index} label={p.name} onPress={() => verifyWith(p)} />)}
          </Card>
        )}

        {screen === 'collecting' && (
          <Card title="3. Collecting your identity" note="The provider is issuing your identity. If you close the app now, it carries on here next time." />
        )}

        {screen === 'identity' && summary && (
          <>
            <Card title="3. Your identity" note="Issued to this wallet's own key (worked out from your seed phrase), so it's yours, and kept in secure storage. Your details stay in the wallet: they are not shown here, and never go on chain.">
              <Fact label="Provider" value={`number ${summary.providerIndex}`} />
              <Fact label="Valid until" value={`${summary.validTo.slice(0, 4)}-${summary.validTo.slice(4)}`} />
              <Fact label="Accounts allowed" value={`up to ${summary.maxAccounts}`} />
              <Button label={shownPhrase ? 'Hide my seed phrase' : 'Show my seed phrase'} kind="quiet" onPress={toggleSeedPhrase} />
              {shownPhrase && (
                <View style={styles.phraseBox}>
                  <Text style={styles.phraseWarn}>Keep these words secret: anyone with them controls this wallet. (Testnet demo.)</Text>
                  {revealed
                    ? <Text style={styles.phrase} selectable>{shownPhrase}</Text>
                    : <Text style={styles.phrase}>{shownPhrase.split(' ').map(() => '••••').join(' ')}</Text>}
                  <Button label={revealed ? 'Mask the words' : 'Reveal the words'} kind="quiet" onPress={() => setRevealed(!revealed)} />
                </View>
              )}
            </Card>
            <Card title="4. Your account" note={account ? 'On chain, created from your identity.' : 'Create an account from your identity: free, final in a few seconds.'}>
              {account ? (
                <>
                  <Fact label="Address" value={account.address} mono />
                  <Fact label="Balance" value={`${account.balance} CCD`} />
                  <Button label="Refresh the balance" kind="quiet" onPress={refreshBalance} />
                  <Button label="See it on CCDScan" kind="quiet" onPress={() => Linking.openURL(`https://testnet.ccdscan.io/?dcount=1&dentity=account&daddress=${account.address}`)} />
                </>
              ) : <Button label="Create account" onPress={createAccount} />}
            </Card>
            {account && (
              <View onLayout={(e) => { requestsY.current = e.nativeEvent.layout.y; }}>
              <Card title="5. Requests from websites" note={request ? 'Check what is asked before you agree.' : 'A website, such as Example Exchange, shows a QR code and a short code. Scan the QR code, or type the code here.'}>
                {request
                  ? <Consent request={request} onApprove={approve} onDecline={decline} Button={Button} />
                  : <CodeEntry onOpen={openRequest} Button={Button} />}
                {reply && <Text style={styles.reply}>{reply}</Text>}
              </Card>
              </View>
            )}
            {pledges.length > 0 && (
              <Card title="My pledges" note="The wallet keeps your pledges and checks each campaign, so it can tell you when it is time to pay.">
                {pledges.map((p) => (
                  <View key={p.id} style={styles.pledgeRow}>
                    <Text style={styles.factValue}>{p.amount} {p.token} · {p.organiser}</Text>
                    <Text style={styles.factLabel}>{({ pledged: 'pledged · waiting for the campaign to close', 'to-pay': 'the goal is reached: time to pay',
                      'checking-payment': 'payment sent, being checked', paid: 'paid ✔', lapsed: 'the goal was not reached: nothing to pay', 'not-paid': 'not paid', 'payment-failed': 'payment not matched',
                      unknown: 'the campaign no longer knows this pledge', unreachable: 'the campaign cannot be reached' })[p.status] ?? p.status}
</Text>
                    {p.status === 'to-pay' && p.payCode && <Button label={`Pay now: ${p.amount} ${p.token}`} onPress={() => openRequest({ relay: p.relay, code: p.payCode })} />}
                  </View>
                ))}
              </Card>
            )}
            {card && (
              <Card title={`${card.company} card`} note={`Your employer's allowance, on your own account. Approved suppliers only; ${card.company} pays the network fees.`}>
                <CompanyCard card={card} balance={cardBal} pending={cardPending} result={cardResult}
                  onPay={payWithCard} onApprove={approveCardPayment} onCancel={() => setCardPending(null)} Button={Button} />
              </Card>
            )}
            <Card title="Ethereum account" note="From the same seed phrase, through WDK's EVM module: where your USDT is.">
              <OtherChainsCard result={ethereum} sent={ethereumSent} Button={Button} onRun={readEthereum} onMint={mintTestUsdt} />
            </Card>
          </>
        )}

        {busy && <View style={styles.busy}><ActivityIndicator color="#0d3a54" /><Text style={styles.busyText}>{busy}</Text></View>}
        {error && <Text style={styles.error}>{error}</Text>}
        {error && screen !== 'loading' && <Button label="Try again" kind="quiet" onPress={start} />}
        {screen !== 'wallet' && screen !== 'loading' && <Button label="Start again" kind="quiet" onPress={startAgain} />}
      </ScrollView>

      {page && (
        <ProviderPage url={page.url} returnAddress={RETURN_ADDRESS} onReturn={onReturn} onCancel={() => setPage(null)} />
      )}
    </View>
  );
}

function Card({ title, note, children }) {
  return (
    <View style={styles.card}>
      <Text style={styles.cardTitle}>{title}</Text>
      {note && <Text style={styles.note}>{note}</Text>}
      {children}
    </View>
  );
}

function Fact({ label, value, mono }) {
  return (
    <View style={styles.fact}>
      <Text style={styles.factLabel}>{label}</Text>
      <Text style={[styles.factValue, mono && styles.mono]} selectable>{value}</Text>
    </View>
  );
}

function Button({ label, onPress, kind }) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.button, kind === 'quiet' && styles.quiet, pressed && styles.pressed]}>
      <Text style={[styles.buttonText, kind === 'quiet' && styles.quietText]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  app: { flex: 1, backgroundColor: '#f4f7f9' },
  header: { backgroundColor: '#1B2735', paddingTop: 60, paddingBottom: 18, paddingHorizontal: 24 },
  // 607 x 76 pixels; the clear space Concordium asks for (the height of the "C") is kept by the padding and margin.
  logo: { width: 200, height: 25, marginBottom: 25 },
  sub: { color: '#c9d4e0', fontSize: 13 },
  body: { padding: 16, paddingBottom: 48 },
  card: { backgroundColor: '#fff', borderRadius: 12, padding: 16, marginBottom: 14, borderWidth: 1, borderColor: '#d4dbe0' },
  cardTitle: { fontSize: 17, fontWeight: '700', color: '#0a1a2f', marginBottom: 6 },
  note: { fontSize: 13, color: '#4b5560', marginBottom: 12, lineHeight: 18 },
  fact: { marginBottom: 10 },
  factLabel: { fontSize: 12, color: '#6a727c' },
  factValue: { fontSize: 15, color: '#22262c' },
  mono: { fontFamily: 'monospace', fontSize: 12 },
  button: { backgroundColor: '#0d3a54', borderRadius: 8, paddingVertical: 12, paddingHorizontal: 14, marginTop: 8 },
  quiet: { backgroundColor: 'transparent', borderWidth: 1, borderColor: '#0d3a54' },
  pressed: { opacity: 0.7 },
  buttonText: { color: '#fff', fontSize: 15, fontWeight: '600', textAlign: 'center' },
  quietText: { color: '#0d3a54' },
  busy: { flexDirection: 'row', alignItems: 'center', gap: 10, marginVertical: 12 },
  busyText: { color: '#0d3a54', fontSize: 14, flexShrink: 1 },
  error: { color: '#b00020', fontSize: 13, marginVertical: 8 },
  reply: { color: '#0f7a4f', fontSize: 14, fontWeight: '600', marginTop: 10 },
  wordsField: { borderWidth: 1, borderColor: '#d4dbe0', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 10, fontSize: 14 },
  small: { fontSize: 12, color: '#6a727c', marginTop: 6 },
  words: { borderWidth: 1, borderColor: '#d4dbe0', borderRadius: 8, padding: 10, minHeight: 90, fontSize: 14, textAlignVertical: 'top' },
  phraseBox: { backgroundColor: '#fff7e6', borderRadius: 8, padding: 10, marginTop: 10 },
  phraseWarn: { fontSize: 12, color: '#8a5a00', marginBottom: 6 },
  phrase: { fontFamily: 'monospace', fontSize: 13, color: '#22262c', lineHeight: 19 },
  pledgeRow: { paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: '#eef0f2' },
});
