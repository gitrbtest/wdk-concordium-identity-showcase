/**
 * The showcase's server (testnet, fictional organisations): the demo page, the organisations' side of each story, and
 * a small relay to the customer's wallet (the phone app).
 *
 *   npm start            then open http://localhost:4400
 *
 * The stories (one tab each): 1 Example Exchange, a withdrawal to the customer's own account (the wallet proves the
 * account is hers, and shows her name); 2 Example Exchange, over 18? (proved from the identity, nothing else shared);
 * 3 Example Community Fund, verified pledges paid in USDT on Ethereum; 4 Maya's wallet on a new phone (the page only
 * guides; the phone does the work); 5 Example Corp, a company card for approved suppliers, fees paid by the company.
 * The code each tab shows ("Show the code") is marked below with SHOWN IN STORY n.
 *
 * The relay stands in for the wallet connection (WalletConnect, or a wallet's browser interface): it carries the
 * question to the phone and the answer back. Nothing else goes through it, and nothing personal is kept by it beyond
 * the answer the customer chose to send.
 *
 * Settings (environment variables):
 *   PORT          default 4400
 *   RELAY_BASE    the address the phone uses to reach this server (default http://10.0.2.2:4400: the Android
 *                 emulator's name for this computer; for a real phone on the same Wi-Fi, http://<this PC's IP>:4400)
 *   CUSTOMER      the customer record file (default customer.json)
 *   PAYOUT_SEED, PAYOUT_PROVIDER_INDEX, PAYOUT_IDENTITY_INDEX, PAYOUT_ACCOUNT_NUMBER (default 0), PAYOUT_ADDRESS
 *                 the testnet account Example Exchange pays withdrawals from (in .env.payout, read by npm start).
 *                 Without them, a released withdrawal is not paid out.
 *   ASK_IDENTITY_INDEX, ASK_ACCOUNT_NUMBER, ASK_ADDRESS, SPONSOR_ACCOUNT_NUMBER, SPONSOR_ADDRESS
 *                 the testnet account that records each question on chain (withdrawal, over 18, pledge), and the
 *                 account that pays its fee (same seed as PAYOUT_SEED; in .env.payout). Without them, no questions.
 *   PC_ETHEREUM_SEED  a test seed for this computer's Ethereum (Sepolia) accounts: the campaign's receiving address
 *                 and the test donors (in .env.ethereum). Without it, no pledge campaign.
 *   CARD_HOLDER   the Concordium account that holds Example Corp's card (story 5): the phone's account
 */
import http from 'node:http';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import QRCode from 'qrcode';
import * as sdk from '@concordium/web-sdk';
import * as plt from '@concordium/web-sdk/plt';
import WalletManagerConcordium, { CONCORDIUM_TESTNET_CONFIG } from '@concordium/wdk-wallet-concordium';
import { createHash } from 'node:crypto';
import { HDNodeWallet, Mnemonic, verifyMessage, JsonRpcProvider, Interface, getAddress } from 'ethers';
import {
  requestFor, checkPresentation, connectToNode, describeProofRequest, describeProofContext,
} from '@concordium/wdk-identity-concordium/verify';

const PORT = Number(process.env.PORT || 4400);
const RELAY_BASE = process.env.RELAY_BASE || `http://10.0.2.2:${PORT}`;
const here = (file) => new URL(file, import.meta.url);
const customer = JSON.parse(readFileSync(here(process.env.CUSTOMER || 'customer.json'), 'utf8'));
const page = () => readFileSync(here('public/index.html'), 'utf8');

const node = connectToNode('testnet'); // Example Exchange reads the chain through Concordium's public testnet node
const ACCEPTED_PROVIDERS = [0, 1, 2, 3, 4, 5]; // whose identities Example Exchange trusts: its own decision

const withdrawals = new Map(); // id → the withdrawal and its wallet check
const relay = new Map();       // code → the question waiting for the wallet, then its answer
const answered = new Set();    // questions already answered (by their anchor): each can be answered once
const MAX_PAYOUT_CCD = 50;     // testnet demo: never pay out more than this per withdrawal
const ageChecks = new Map();   // id → an over-18 question and its answer

// Story 3: Example Community Fund's campaign (a different organisation on the same demo page).
const campaign = {
  organiser: 'Example Community Fund',
  cause: 'A new playground for Example Park',
  goal: 1000,                       // test USDT
  token: 'test USDT',
  chain: 'Ethereum Sepolia',
  status: 'open',                   // open | reached | missed
  receiveAddress: null,             // the campaign's Ethereum address (set below)
  pledges: [],
};
const pledgesById = new Map();
const SEPOLIA = new JsonRpcProvider('https://ethereum-sepolia-rpc.publicnode.com');
const TEST_USDT = { address: '0x2F22064e87195D6D5aD22277FEDDFa2e2f59165F', decimals: 6 }; // stand-in on Sepolia
const ERC20 = new Interface(['event Transfer(address indexed from, address indexed to, uint256 value)']);
const usedPayments = new Set(); // each Sepolia transaction settles one pledge only

// Story 5: Example Corp gives Maya, an employee, a company card: an allowance in a token, for approved suppliers only.
const corp = {
  name: 'Example Corp',
  token: 'TN', decimals: 6,                 // a testnet protocol-level token (PLT) standing in for a stablecoin
  maxTopUp: 100, maxPayment: 50,            // per top-up, per payment (test tokens)
  cardholder: { name: 'Maya', address: process.env.CARD_HOLDER || '4RiXaepfrhAjcKXkCRLg1ze6X7ATGgi5hfW7RxhCHnGe53nU1c' },
  suppliers: [                              // testnet accounts playing the suppliers
    { id: 'office', name: 'Example Office Supplies', address: '3xgMzAoz9QVnyFCwe2kqWuqL3PgH737DjnH4DPtJJTAt8AQhZX', approved: true },
    { id: 'casino', name: 'Example Casino', address: '3sMhG8xZZCN3Noe2bF2F4Q1K5tSo7MPwGS6rr9Whoq2GUeBZtC', approved: false },
  ],
  regulatedToken: 'UPEU',                   // a testnet token whose issuer keeps an allow list (not ours)
  payments: [],                             // card payments and top-ups, newest first
};
const pendingCard = new Map();               // card payments authorised by Example Corp, waiting for the card holder
const CORP_FILE = here('corp-state.json');
if (existsSync(CORP_FILE)) corp.payments = JSON.parse(readFileSync(CORP_FILE, 'utf8')).payments ?? [];
let corpSaved = '';
setInterval(() => {
  const text = JSON.stringify({ payments: corp.payments });
  if (text !== corpSaved) { writeFileSync(CORP_FILE, text); corpSaved = text; }
}, 1000);

// The campaign is kept in a file, so a restart of this server forgets nothing (a real organisation keeps it in its
// database). "Start the campaign again (demo)" clears it on purpose. Withdrawals and over-18 questions stay in memory.
const CAMPAIGN_FILE = here('campaign-state.json');
function loadCampaign() {
  if (!existsSync(CAMPAIGN_FILE)) return;
  const saved = JSON.parse(readFileSync(CAMPAIGN_FILE, 'utf8'));
  Object.assign(campaign, saved.campaign);
  for (const p of campaign.pledges) pledgesById.set(p.id, p);
  for (const [code, entry] of saved.relay) relay.set(code, entry);
  for (const hash of saved.usedPayments) usedPayments.add(hash);
  console.log(`Campaign loaded from ${CAMPAIGN_FILE.pathname.split('/').pop()}: ${campaign.pledges.length} pledges, ${campaign.status}.`);
}
let savedText = '';
function saveCampaign() {
  const text = JSON.stringify({
    campaign: { status: campaign.status, pledges: campaign.pledges },
    relay: [...relay].filter(([, e]) => e.kind === 'pledge' || e.kind === 'pay'),
    usedPayments: [...usedPayments],
  });
  if (text !== savedText) { writeFileSync(CAMPAIGN_FILE, text); savedText = text; }
}

// ── SHOWN IN STORY 1: START ──
/** A withdrawal to a private wallet: before releasing it, ask the wallet to prove the account is the customer's. */
async function startWithdrawal({ to, amount }) {
  const request = await requestFor(
    { network: 'testnet', website: 'exchange.example', purpose: 'withdrawal check', providers: ACCEPTED_PROVIDERS,
      reveal: ['firstName', 'lastName', 'idDocNo'], // to match our own customer record
      answerFrom: 'account' },                       // answered from an account: the proof names it
    { node, sender: asker.address, signer: asker.signer, sponsor }, // recorded on chain (its anchor); the sponsor pays
  );
  const withdrawal = { id: randomUUID(), to, amount, request, status: 'waiting-for-wallet', checks: [] };
  withdrawals.set(withdrawal.id, withdrawal);
  return withdrawal;
}

/** The wallet's answer arrives: check it, then apply our own rules. */
async function receiveAnswer(withdrawal, presentation) {
  if (answered.has(withdrawal.request.transactionRef)) return refuse(withdrawal, 'This question was already answered.');
  answered.add(withdrawal.request.transactionRef);

  const result = await withRetries(() => checkPresentation(presentation, withdrawal.request, { node, network: 'testnet' }));
  const account = result.credentials?.[0]?.account; // the account the proof came from
  const same = (name) => result.revealed?.[name] === customer.record[name];
  withdrawal.checks = [
    { label: 'The proof is genuine (checked against the chain)', ok: result.ok, why: result.reasons.map((r) => r.message).join(' ') },
    { label: 'It comes from the account being withdrawn to', ok: result.ok && account === withdrawal.to, why: `answered from ${account ?? 'no account'}` },
    { label: 'Same person as our customer (name and ID number)', ok: result.ok && same('firstName') && same('lastName') && same('idDocNo'), why: 'compared with our customer record' },
  ];
  withdrawal.revealed = result.revealed;
  withdrawal.status = withdrawal.checks.every((c) => c.ok) ? 'released' : 'refused';
  withdrawal.evidence = { checkedAt: new Date().toISOString(), account, revealed: result.revealed, auditRecord: result.auditRecord }; // kept for the audit trail
}
// ── SHOWN IN STORY 1: END ──

// ── SHOWN IN STORY 2: START ──
/** Over 18? Ask the wallet to prove it from the identity itself: no account, nothing revealed. */
async function startAgeCheck(check) {
  check.question = await requestFor(
    { network: 'testnet', website: 'exchange.example', purpose: 'age check before trading', providers: ACCEPTED_PROVIDERS, adult: true },
    { node, sender: asker.address, signer: asker.signer, sponsor },  // the question is recorded on chain (its anchor);
  );                                                                  // the sponsor pays the fee
  // Who paid for recording it, and how much (read back from the chain).
  const status = await node.getBlockItemStatus(sdk.TransactionHash.fromHexString(check.question.transactionRef));
  const summary = status.outcome?.summary;
  check.fee = summary?.sponsor ? { ccd: sdk.CcdAmount.toCcd(summary.sponsor.cost).toString(), payer: summary.sponsor.sponsor.toString() }
    : summary?.cost ? { ccd: sdk.CcdAmount.toCcd(summary.cost).toString(), payer: summary.sender?.toString() } : null;
  check.status = 'waiting-for-wallet';
}

/** The answer arrives: check it against the chain and the recorded question. */
async function receiveAgeAnswer(check, presentation) {
  if (answered.has(check.question.transactionRef)) return refuse(check, 'This question was already answered.');
  answered.add(check.question.transactionRef);

  const result = await withRetries(() => checkPresentation(presentation, check.question, { node, network: 'testnet' }));
  check.checks = [
    { label: 'The proof is genuine, and answers our recorded question', ok: result.ok, why: result.reasons.map((r) => r.message).join(' ') },
    { label: 'Over 18', ok: result.ok, why: 'proved from the identity, without the date of birth' },
    { label: 'Nothing else shared', ok: result.ok && Object.keys(result.revealed ?? {}).length === 0, why: 'no name, no account, no date of birth' },
  ];
  check.revealed = result.revealed;
  check.status = check.checks.every((c) => c.ok) ? 'passed' : 'refused';
}
// ── SHOWN IN STORY 2: END ──

// ── SHOWN IN STORY 3: START ──
/** A pledge starts: ask the donor's wallet for proof that a verified adult makes it (and their name, if they choose). */
async function startPledge({ amount, showName }) {
  const request = await requestFor(
    { network: 'testnet', website: 'fund.example', purpose: 'pledge', providers: ACCEPTED_PROVIDERS,
      adult: true,                                                 // 18 or over
      ...(showName ? { reveal: ['firstName', 'lastName'] } : {}), // only if the donor ticked "show my name"
      answerFrom: 'account' },                                     // from the donor's Concordium account
    { node, sender: asker.address, signer: asker.signer, sponsor }, // recorded on chain; the sponsor pays
  );
  const pledge = { id: `P-${newCode().slice(0, 4)}`, amount, showName, request, status: 'waiting-for-wallet', checks: [] };
  campaign.pledges.push(pledge);
  pledgesById.set(pledge.id, pledge);
  return pledge;
}

/** The exact text the donor's wallet signs with its Ethereum key; the question's anchor ties it to the Concordium proof. */
const pledgeText = (pledge, payFrom) => `I pledge ${pledge.amount} ${campaign.token} to ${campaign.organiser} (${campaign.cause}), `
  + `paid from ${payFrom} on ${campaign.chain}. Pledge ${pledge.id}, proof question ${pledge.request.transactionRef}.`;

/** The wallet's answer: a Concordium proof (who) and an Ethereum signature (which address pays), over the same pledge. */
async function receivePledge(pledge, { presentation, payFrom, signature }) {
  const text = pledgeText(pledge, payFrom);
  const result = await withRetries(() => checkPresentation(presentation, pledge.request, { node, network: 'testnet' }));
  let signer = null;
  try { signer = verifyMessage(text, signature); } catch { /* not a valid signature */ }
  pledge.checks = [
    { label: 'A verified person, 18 or over (Concordium proof)', ok: result.ok, why: result.reasons.map((r) => r.message).join(' ') },
    { label: 'Controls the paying address (Ethereum signature)', ok: signer === payFrom, why: `signed by ${signer ?? 'nobody'}` },
  ];
  pledge.name = pledge.showName && result.ok ? `${result.revealed.firstName} ${result.revealed.lastName}` : null;
  pledge.organiser = { concordiumAccount: result.credentials?.[0]?.account, payFrom, text }; // what only the organiser sees
  if (!pledge.checks.every((c) => c.ok)) { pledge.status = 'refused'; return; }

  // A public, timestamped record of this exact pledge on Concordium: its fingerprint only, nothing personal.
  pledge.fingerprint = createHash('sha256').update(text).update(JSON.stringify(presentation)).update(signature).digest('hex');
  pledge.status = 'pledged';
  pledge.record = await recordOnConcordium(pledge.fingerprint);
}

/** The goal is reached: the donor's wallet reports its USDT payment; find it on Ethereum and match it to the pledge. */
async function receivePayment(pledge, txHash) {
  if (usedPayments.has(txHash)) return payFailed(pledge, 'This payment was already counted for another pledge.');
  const receipt = await SEPOLIA.waitForTransaction(txHash, 1, 180_000);
  if (!receipt || receipt.status !== 1) return payFailed(pledge, 'The transaction did not succeed on Ethereum.');
  const wanted = BigInt(pledge.amount) * 10n ** BigInt(TEST_USDT.decimals);
  const match = receipt.logs.some((log) => {
    if (getAddress(log.address) !== getAddress(TEST_USDT.address)) return false; // the USDT token
    const t = ERC20.parseLog(log);
    return t?.name === 'Transfer' && t.args.from === pledge.organiser.payFrom   // from the proven address
      && t.args.to === campaign.receiveAddress && t.args.value === wanted;       // to us, the pledged amount
  });
  if (!match) return payFailed(pledge, 'No transfer of the pledged USDT from the proven address to the campaign.');
  usedPayments.add(txHash);
  pledge.payment = { hash: txHash };
  pledge.status = 'paid';
}
// ── SHOWN IN STORY 3: END ──

// ── SHOWN IN STORY 5: START ──
/** The card asks to pay a supplier. Example Corp checks its policy, then builds the token transfer FROM the card
 *  holder's account and signs it as SPONSOR: it will pay the fee. The card holder signs it next, on her phone. */
async function authoriseCardPayment({ from, supplierId, amount }) {
  const supplier = corp.suppliers.find((x) => x.id === supplierId);
  if (from !== corp.cardholder.address) throw new Error('This account has no Example Corp card.');
  if (!supplier?.approved) throw new Error(`${supplier?.name ?? 'This supplier'} is not an approved supplier (Example Corp's policy).`);
  if (!(amount > 0 && amount <= corp.maxPayment)) throw new Error(`A card payment is between 1 and ${corp.maxPayment} ${corp.token}.`);
  const { token: allowance } = await tokenBalance(from);   // never send a payment the chain would refuse
  if (amount > allowance) throw new Error(`The card holds ${allowance} ${corp.token}; this payment needs ${amount}. Nothing was sent.`);

  const transfer = { recipient: plt.CborAccountAddress.fromAccountAddress(sdk.AccountAddress.fromBase58(supplier.address)),
    amount: plt.TokenAmount.create(BigInt(amount) * 10n ** BigInt(corp.decimals), corp.decimals) };
  const sender = sdk.AccountAddress.fromBase58(from);
  const { nonce } = await node.getNextAccountNonce(sender);
  const transaction = sdk.Transaction.tokenUpdate(plt.createTokenUpdatePayload(plt.TokenId.fromString(corp.token), { transfer }))
    .addMetadata({ sender, nonce, expiry: sdk.TransactionExpiry.futureMinutes(10) })
    .addSponsor(sdk.AccountAddress.fromBase58(payer.address))   // Example Corp pays the fee
    .build();
  const sponsored = await sdk.Transaction.sponsor(transaction, payer.signer); // signed as sponsor, first
  const id = randomUUID();
  const json = sdk.Transaction.toJSONString(sponsored);       // JSON text: travels to the phone as is
  pendingCard.set(id, { from, supplier, amount, json });
  return { id, transaction: json, supplier: supplier.name, amount, token: corp.token, sponsor: corp.name };
}

/** The card holder signed it on her phone: check it is the very transaction authorised, then send it. */
async function submitCardPayment({ id, transaction }) {
  const pending = pendingCard.get(id);
  if (!pending) throw new Error('No payment waiting with this reference.');
  pendingCard.delete(id);
  if (unsigned(transaction) !== unsigned(pending.json)) throw new Error('This is not the payment Example Corp authorised.');
  const signed = sdk.Transaction.fromJSONString(transaction, sdk.Transaction.signableFromJSON);
  const hash = await node.sendTransaction(sdk.Transaction.finalize(signed));
  const { summary } = await node.waitForTransactionFinalization(hash);
  const record = { kind: 'payment', from: corp.cardholder.name, to: pending.supplier.name, amount: pending.amount,
    hash: hash.toString(), ok: !sdk.isRejectTransaction(summary), at: new Date().toISOString() };
  corp.payments.unshift(record);
  return record;
}
// ── SHOWN IN STORY 5: END ──

/** A transaction's content without its signatures, to compare two copies of it. */
function unsigned(jsonText) {
  const { signatures, ...rest } = JSON.parse(jsonText); // { version, signatures: { sender, sponsor }, header, payload }
  return JSON.stringify(rest);
}

/** Example Corp tops up the card: a token transfer from its treasury, which pays its own fee. */
async function topUpCard(amount) {
  if (!(amount > 0 && amount <= corp.maxTopUp)) throw new Error(`A top-up is between 1 and ${corp.maxTopUp} ${corp.token}.`);
  await checkPayer();
  const transfer = { recipient: plt.CborAccountAddress.fromAccountAddress(sdk.AccountAddress.fromBase58(corp.cardholder.address)),
    amount: plt.TokenAmount.create(BigInt(amount) * 10n ** BigInt(corp.decimals), corp.decimals) };
  const sender = sdk.AccountAddress.fromBase58(payer.address);
  const { nonce } = await node.getNextAccountNonce(sender);
  const tx = sdk.Transaction.tokenUpdate(plt.createTokenUpdatePayload(plt.TokenId.fromString(corp.token), { transfer }))
    .addMetadata({ sender, nonce, expiry: sdk.TransactionExpiry.futureMinutes(10) }).build();
  const hash = await node.sendTransaction(await sdk.Transaction.signAndFinalize(tx, payer.signer));
  const { summary } = await node.waitForTransactionFinalization(hash);
  const record = { kind: 'top-up', to: corp.cardholder.name, amount, hash: hash.toString(), ok: !sdk.isRejectTransaction(summary),
    at: new Date().toISOString() };
  corp.payments.unshift(record);
  return record;
}

/** Some tokens enforce such rules on chain: check (send nothing) a payment in a regulated token, with our wallet
 *  package's checkTransfer. */
async function checkRegulatedPayment() {
  const manager = new WalletManagerConcordium(process.env.PAYOUT_SEED, { ...CONCORDIUM_TESTNET_CONFIG });
  try {
    const treasury = await manager.getAccountByPath(`${process.env.PAYOUT_PROVIDER_INDEX}/${process.env.PAYOUT_IDENTITY_INDEX}/${Number(process.env.PAYOUT_ACCOUNT_NUMBER ?? 0)}`);
    const office = corp.suppliers.find((x) => x.id === 'office');
    const check = await treasury.checkTransfer({ token: corp.regulatedToken, recipient: office.address, amount: 20n * 10n ** 6n });
    return { token: corp.regulatedToken, to: office.name, ok: check.ok, reasons: check.reasons.map((r) => ({ reason: r.reason, message: r.message })) };
  } finally {
    manager.dispose();
  }
}

/** A token balance of an account, in whole tokens. */
async function tokenBalance(address, tokenId = corp.token) {
  const info = await node.getAccountInfo(sdk.AccountAddress.fromBase58(address));
  const held = (info.accountTokens ?? []).find((t) => t.id.toString() === tokenId);
  return { token: held ? Number(held.state.balance.value) / 10 ** held.state.balance.decimals : 0, ccd: sdk.CcdAmount.toCcd(info.accountAmount).toString() };
}

// ── The payout: a real CCD transfer on testnet, from Example Exchange's account to the customer's ─────────────

/** Example Exchange's paying account (testnet), or null if none is set up. */
function payoutAccount() {
  const { PAYOUT_SEED, PAYOUT_PROVIDER_INDEX, PAYOUT_IDENTITY_INDEX, PAYOUT_ACCOUNT_NUMBER = '0', PAYOUT_ADDRESS } = process.env;
  if (!PAYOUT_SEED || !PAYOUT_ADDRESS) return null;
  const keys = sdk.ConcordiumHdWallet.fromSeedPhrase(PAYOUT_SEED, 'Testnet');
  const [p, i, c] = [Number(PAYOUT_PROVIDER_INDEX), Number(PAYOUT_IDENTITY_INDEX), Number(PAYOUT_ACCOUNT_NUMBER)];
  return {
    address: PAYOUT_ADDRESS,
    publicKey: keys.getAccountPublicKey(p, i, c).toString('hex'),
    signer: sdk.buildBasicAccountSigner(keys.getAccountSigningKey(p, i, c).toString('hex')),
  };
}
const payer = payoutAccount();

/** The over-18 scene's accounts: the one recording the question on chain, and the one paying its fee. */
function seedAccount(numberVar, addressVar) {
  const { PAYOUT_SEED, ASK_IDENTITY_INDEX } = process.env;
  if (!PAYOUT_SEED || !ASK_IDENTITY_INDEX || !process.env[addressVar]) return null;
  const key = sdk.ConcordiumHdWallet.fromSeedPhrase(PAYOUT_SEED, 'Testnet')
    .getAccountSigningKey(0, Number(ASK_IDENTITY_INDEX), Number(process.env[numberVar])).toString('hex');
  return { address: process.env[addressVar], signer: sdk.buildBasicAccountSigner(key) };
}
const asker = seedAccount('ASK_ACCOUNT_NUMBER', 'ASK_ADDRESS');
const sponsor = seedAccount('SPONSOR_ACCOUNT_NUMBER', 'SPONSOR_ADDRESS');

function payFailed(pledge, why) {
  pledge.payment = { ...(pledge.payment ?? {}), error: why };
  pledge.status = 'payment-failed';
}

/** The goal is reached: give every pledge a "pay your pledge" request (a code for its donor's wallet). */
async function askForPayments() {
  for (const pledge of campaign.pledges.filter((p) => p.status === 'pledged')) {
    pledge.payCode = newCode();
    relay.set(pledge.payCode, { kind: 'pay', id: pledge.id, state: 'waiting' });
    pledge.payQr = await QRCode.toDataURL(`wdkshowcase://request?relay=${encodeURIComponent(RELAY_BASE)}&code=${pledge.payCode}`, { margin: 1, width: 160 });
    pledge.status = 'to-pay';
  }
}

/** The campaign's Ethereum address: index 2 of the private PC seed (.env.ethereum). Not the public test phrase: its
 *  Ethereum addresses are swept by bots. */
if (process.env.PC_ETHEREUM_SEED) {
  campaign.receiveAddress = HDNodeWallet.fromMnemonic(Mnemonic.fromPhrase(process.env.PC_ETHEREUM_SEED), "m/44'/60'/0'/0/2").address;
}

/** Record a pledge's fingerprint on Concordium (register data), sent and paid by Example Community Fund's account
 *  (here the shared testnet funding account). Returns { hash } once final, or { error }. */
async function recordOnConcordium(fingerprint) {
  try {
    await checkPayer();
    const sender = sdk.AccountAddress.fromBase58(payer.address);
    const { nonce } = await node.getNextAccountNonce(sender);
    const tx = sdk.Transaction.registerData({ data: new sdk.DataBlob(Buffer.from(fingerprint, 'hex')) })
      .addMetadata({ sender, nonce, expiry: sdk.TransactionExpiry.futureMinutes(10) }).build();
    const hash = await node.sendTransaction(await sdk.Transaction.signAndFinalize(tx, payer.signer));
    const { summary } = await node.waitForTransactionFinalization(hash);
    console.log(`pledge fingerprint recorded on Concordium: ${hash.toString()}`);
    let fee = null;
    try { fee = sdk.CcdAmount.toCcd(sdk.CcdAmount.fromMicroCcd(summary.cost)).toString(); } catch { /* fee not readable: shown without it */ }
    return { hash: hash.toString(), fee };
  } catch (error) {
    console.error(error);
    return { error: error.message };
  }
}

/** Before the first payment: the key from the seed must be the paying account's key on chain. */
let payerChecked = false;
async function checkPayer() {
  if (payerChecked) return;
  const info = await node.getAccountInfo(sdk.AccountAddress.fromBase58(payer.address));
  const onChain = Object.values(info.accountCredentials).flatMap((c) => Object.values(c.value.contents.credentialPublicKeys?.keys ?? {}))
    .map((k) => k.verifyKey);
  if (!onChain.includes(payer.publicKey)) throw new Error('The paying account key on chain is not the one from PAYOUT_SEED.');
  payerChecked = true;
}

/** Send the withdrawal: a CCD transfer, then wait until it is final on chain. */
async function payOut(withdrawal) {
  const amount = Number(withdrawal.amount);
  if (!payer) { withdrawal.payout = { state: 'not-set-up' }; return; }
  if (!(amount > 0 && amount <= MAX_PAYOUT_CCD)) { withdrawal.payout = { state: 'failed', why: `This demo pays out between 0 and ${MAX_PAYOUT_CCD} CCD.` }; return; }
  withdrawal.payout = { state: 'sending' };
  try {
    await checkPayer();
    const sender = sdk.AccountAddress.fromBase58(payer.address);
    const { nonce } = await node.getNextAccountNonce(sender);
    const transfer = sdk.Transaction.transfer({ toAddress: sdk.AccountAddress.fromBase58(withdrawal.to), amount: sdk.CcdAmount.fromCcd(amount) })
      .addMetadata({ sender, nonce, expiry: sdk.TransactionExpiry.futureMinutes(10) }).build();
    const hash = await node.sendTransaction(await sdk.Transaction.signAndFinalize(transfer, payer.signer));
    withdrawal.payout = { state: 'sending', hash: hash.toString() };
    const { summary } = await node.waitForTransactionFinalization(hash);
    withdrawal.payout = sdk.isRejectTransaction(summary)
      ? { state: 'failed', hash: hash.toString(), why: JSON.stringify(sdk.getTransactionRejectReason(summary)) }
      : { state: 'paid', hash: hash.toString() };
  } catch (error) {
    withdrawal.payout = { ...withdrawal.payout, state: 'failed', why: error.message };
  }
  console.log(`payout ${withdrawal.amount} CCD → ${withdrawal.to}: ${withdrawal.payout.state} ${withdrawal.payout.hash ?? ''} ${withdrawal.payout.why ?? ''}`);
}

/** Ask again (up to 3 times, a few seconds apart) when the node had a temporary problem (e.g. HTTP 502). */
async function withRetries(work, tries = 3) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await work();
    } catch (error) {
      if (error?.reason !== 'node' || attempt >= tries) throw error;
      console.log(`The node did not answer (${error.detail}); asking again in ${3 * attempt} s.`);
      await new Promise((resolve) => setTimeout(resolve, 3000 * attempt));
    }
  }
}

function refuse(withdrawal, why) {
  withdrawal.status = 'refused';
  withdrawal.checks = [{ label: 'A fresh answer to this question', ok: false, why }];
}

/** A short code for the question, easy to type on a phone (no 0/O or 1/I). */
function newCode() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do code = Array.from(randomBytes(6), (b) => letters[b % letters.length]).join(''); while (relay.has(code));
  return code;
}

// ── The web server ──────────────────────────────────────────────────────────────────────────────────────────────

const send = (res, status, body, type = 'application/json') => {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
};
const readBody = (req) => new Promise((resolve, reject) => {
  let text = '';
  req.on('data', (chunk) => { text += chunk; if (text.length > 1_000_000) req.destroy(); });
  req.on('end', () => { try { resolve(text ? JSON.parse(text) : {}); } catch (e) { reject(e); } });
  req.on('error', reject);
});
const ageView = (c) => ({ id: c.id, status: c.status, code: c.code, qr: c.qr, checks: c.checks, revealed: c.revealed,
  anchor: c.question?.transactionRef, fee: c.fee, asker: asker?.address, why: c.why });
const pledgeView = (p) => ({ id: p.id, amount: p.amount, name: p.name ?? null, status: p.status, checks: p.checks,
  code: p.code, qr: p.qr, record: p.record, organiser: p.organiser, fingerprint: p.fingerprint,
  payCode: p.payCode, payQr: p.payQr, payment: p.payment });
const campaignView = () => {
  const counted = campaign.pledges.filter((p) => ['pledged', 'to-pay', 'paid', 'payment-failed', 'not-paid', 'lapsed'].includes(p.status));
  return { organiser: campaign.organiser, cause: campaign.cause, goal: campaign.goal, token: campaign.token,
    chain: campaign.chain, status: campaign.status, receiveAddress: campaign.receiveAddress,
    pledged: counted.reduce((sum, p) => sum + p.amount, 0),
    paid: campaign.pledges.filter((p) => p.status === 'paid').reduce((sum, p) => sum + p.amount, 0),
    pledges: campaign.pledges.map(pledgeView) };
};
const publicView = (w) => ({ id: w.id, to: w.to, amount: w.amount, status: w.status, checks: w.checks, revealed: w.revealed, code: w.code, payout: w.payout });

const routes = {
  // The page
  'GET /': (req, res) => send(res, 200, page(), 'text/html; charset=utf-8'),
  'GET /api/customer': (req, res) => send(res, 200, customer),
  'GET /api/code/:story': (req, res, { story }) => {
    const parts = readFileSync(here('server.mjs'), 'utf8').split(`// ── SHOWN IN STORY ${Number(story)}: START ──\n`);
    if (parts.length < 2) return send(res, 404, { error: 'No such story.' });
    send(res, 200, { code: parts[1].split(`// ── SHOWN IN STORY ${Number(story)}: END ──`)[0].trim() });
  },

  // The customer asks to withdraw: Example Exchange starts the wallet check and gives the page a QR code for it.
  'POST /api/withdrawals': async (req, res) => {
    const { to, amount } = await readBody(req);
    if (typeof to !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{50}$/.test(to)) return send(res, 400, { error: 'Enter a Concordium account address.' });
    if (!(Number(amount) > 0 && Number(amount) <= MAX_PAYOUT_CCD)) return send(res, 400, { error: `Enter an amount between 0 and ${MAX_PAYOUT_CCD} CCD (the most this demo pays out).` });
    if (!asker || !sponsor) return send(res, 400, { error: 'The wallet check is not set up (.env.payout).' });
    let withdrawal;
    try { withdrawal = await startWithdrawal({ to, amount: String(amount ?? '') }); } // recorded on chain: a few seconds
    catch (error) { return send(res, 502, { error: `The question could not be recorded on chain: ${error.message}` }); }
    withdrawal.code = newCode();
    relay.set(withdrawal.code, { kind: 'withdrawal', id: withdrawal.id, state: 'waiting' });
    const link = `wdkshowcase://request?relay=${encodeURIComponent(RELAY_BASE)}&code=${withdrawal.code}`;
    send(res, 201, { ...publicView(withdrawal), link, qr: await QRCode.toDataURL(link, { margin: 1, width: 220 }) });
  },
  'GET /api/withdrawals/:id': (req, res, { id }) => {
    const w = withdrawals.get(id);
    return w ? send(res, 200, publicView(w)) : send(res, 404, { error: 'No such withdrawal.' });
  },

  // Story 5: Example Corp's card
  'GET /api/corp': async (req, res) => {
    const [treasury, card] = await Promise.all([tokenBalance(payer.address), tokenBalance(corp.cardholder.address)]);
    send(res, 200, { name: corp.name, token: corp.token, treasury: { address: payer.address, ...treasury },
      cardholder: { ...corp.cardholder, balance: card.token }, suppliers: corp.suppliers, maxTopUp: corp.maxTopUp,
      maxPayment: corp.maxPayment, payments: corp.payments.slice(0, 20) });
  },
  'POST /api/corp/top-up': async (req, res) => {
    const { amount } = await readBody(req);
    try { send(res, 200, await topUpCard(Number(amount))); } catch (error) { send(res, 400, { error: error.message }); }
  },
  'POST /api/corp/check-regulated': async (req, res) => {
    try { send(res, 200, await checkRegulatedPayment()); } catch (error) { send(res, 400, { error: error.message }); }
  },
  // The card (Maya's phone) reads the policy, asks for authorisation, then hands back the signed payment.
  'GET /relay/card/policy': (req, res) => {
    const account = new URL(req.url, 'http://localhost').searchParams.get('account');
    if (account !== corp.cardholder.address) return send(res, 404, { error: 'No Example Corp card for this account.' });
    send(res, 200, { company: corp.name, token: corp.token, maxPayment: corp.maxPayment,
      suppliers: corp.suppliers.map(({ id, name, approved }) => ({ id, name, approved })) });
  },
  'POST /relay/card/authorise': async (req, res) => {
    try { send(res, 200, await authoriseCardPayment(await readBody(req))); } catch (error) { send(res, 400, { error: error.message }); }
  },
  'POST /relay/card/submit': async (req, res) => {
    try { send(res, 200, await submitCardPayment(await readBody(req))); } catch (error) { send(res, 400, { error: error.message }); }
  },

  // Story 3: the campaign
  'GET /api/campaign': (req, res) => send(res, 200, campaignView()),
  'POST /api/pledges': async (req, res) => {
    if (campaign.status !== 'open') return send(res, 400, { error: 'The campaign is closed.' });
    const { amount, showName } = await readBody(req);
    if (!(Number.isInteger(Number(amount)) && Number(amount) > 0 && Number(amount) <= 500)) {
      return send(res, 400, { error: 'Pledge a whole amount between 1 and 500 test USDT.' });
    }
    if (!asker || !sponsor) return send(res, 400, { error: 'The pledge check is not set up (.env.payout).' });
    let pledge;
    try { pledge = await startPledge({ amount: Number(amount), showName: Boolean(showName) }); } // recorded on chain: a few seconds
    catch (error) { return send(res, 502, { error: `The question could not be recorded on chain: ${error.message}` }); }
    pledge.code = newCode();
    relay.set(pledge.code, { kind: 'pledge', id: pledge.id, state: 'waiting' });
    pledge.qr = await QRCode.toDataURL(`wdkshowcase://request?relay=${encodeURIComponent(RELAY_BASE)}&code=${pledge.code}`, { margin: 1, width: 220 });
    send(res, 201, pledgeView(pledge));
  },
  // A wallet on a new phone asks for the pledges paid from its Ethereum address. It must prove it owns that address
  // (a signature over a recent message), so nobody else can list someone's pledges.
  'GET /relay/pledges': (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const [from, at, signature] = ['from', 'at', 'signature'].map((k) => url.searchParams.get(k) ?? '');
    let signer = null;
    try { signer = verifyMessage(`List the pledges paid from ${from} (${at})`, signature); } catch { /* not a signature */ }
    if (signer !== from || Math.abs(Date.now() - Number(at)) > 5 * 60_000) {
      return send(res, 403, { error: 'Prove you own this address: sign a recent request with its key.' });
    }
    send(res, 200, campaign.pledges.filter((p) => p.organiser?.payFrom === from && p.status !== 'refused')
      .map((p) => ({ id: p.id, amount: p.amount, token: campaign.token, organiser: campaign.organiser })));
  },

  // A donor's wallet asks about its own pledge (it keeps the pledge's id): pledged, goal reached and to pay, paid…
  // When it is time to pay, the answer includes the pay request's code, so the wallet can open it by itself.
  'GET /relay/pledge/:id': (req, res, { id }) => {
    const p = pledgesById.get(id);
    if (!p) return send(res, 404, { error: 'No such pledge.' });
    send(res, 200, { id: p.id, amount: p.amount, token: campaign.token, organiser: campaign.organiser, cause: campaign.cause,
      campaign: campaign.status, status: p.status, payCode: p.status === 'to-pay' ? p.payCode : null, payment: p.payment?.hash ?? null });
  },
  'POST /api/campaign/close': async (req, res) => {
    if (campaign.status === 'open') {
      campaign.status = campaignView().pledged >= campaign.goal ? 'reached' : 'missed';
      if (campaign.status === 'reached') await askForPayments();
      // Goal not reached: the pledges lapse, and nobody is asked to pay.
      else campaign.pledges.filter((p) => p.status === 'pledged').forEach((p) => { p.status = 'lapsed'; });
    }
    send(res, 200, campaignView());
  },
  'POST /api/campaign/reset': (req, res) => {
    Object.assign(campaign, { status: 'open', pledges: [] });
    pledgesById.clear();
    for (const [code, entry] of relay) if (entry.kind === 'pledge' || entry.kind === 'pay') relay.delete(code);
    send(res, 200, campaignView());
  },

  // The over-18 scene: record the question on chain (a few seconds), then show its code.
  'POST /api/age-checks': (req, res) => {
    if (!asker || !sponsor) return send(res, 400, { error: 'The over-18 scene is not set up (.env.payout).' });
    const check = { id: randomUUID(), status: 'recording', checks: [] };
    ageChecks.set(check.id, check);
    startAgeCheck(check).then(async () => {
      check.code = newCode();
      relay.set(check.code, { kind: 'age', id: check.id, state: 'waiting' });
      check.qr = await QRCode.toDataURL(`wdkshowcase://request?relay=${encodeURIComponent(RELAY_BASE)}&code=${check.code}`, { margin: 1, width: 220 });
      console.log(`over-18 question recorded on chain: ${check.question.transactionRef}`);
    }).catch((error) => {
      console.error(error);
      check.status = 'error';
      check.why = `The question could not be recorded on chain: ${error.message}`;
    });
    send(res, 201, ageView(check));
  },
  'GET /api/age-checks/:id': (req, res, { id }) => {
    const c = ageChecks.get(id);
    return c ? send(res, 200, ageView(c)) : send(res, 404, { error: 'No such question.' });
  },

  // The relay: the wallet fetches the question, then sends its answer (or says the customer declined).
  'GET /relay/:code': (req, res, { code }) => {
    const entry = relay.get(code.toUpperCase());
    if (!entry || entry.state !== 'waiting') return send(res, 404, { error: 'No question waiting with this code.' });
    if (entry.kind === 'pay') {
      const p = pledgesById.get(entry.id);
      return send(res, 200, {
        kind: 'pay',
        from: campaign.organiser,
        purpose: `The goal is reached: pay your pledge ${p.id}`,
        pay: { pledgeId: p.id, amount: p.amount, token: campaign.token, tokenAddress: TEST_USDT.address,
          decimals: TEST_USDT.decimals, chain: campaign.chain, to: campaign.receiveAddress, from: p.organiser.payFrom },
      });
    }
    if (entry.kind === 'pledge') {
      const p = pledgesById.get(entry.id);
      return send(res, 200, {
        kind: 'pledge',
        from: campaign.organiser,
        purpose: `Pledge ${p.amount} ${campaign.token} to ${campaign.cause}`,
        pledge: { id: p.id, amount: p.amount, token: campaign.token, chain: campaign.chain,
          textTemplate: pledgeText(p, '{payFrom}') }, // the wallet puts in its own Ethereum address, then signs
        request: p.request,
        wording: describeProofRequest(p.request),
      });
    }
    if (entry.kind === 'age') {
      const c = ageChecks.get(entry.id);
      const context = describeProofContext(c.question);
      return send(res, 200, {
        kind: 'age',
        from: 'Example Exchange',
        purpose: `${context.purpose ?? 'Age check'} (${context.website ?? 'exchange.example'})`,
        request: c.question,
        wording: describeProofRequest(c.question),
      });
    }
    const w = withdrawals.get(entry.id);
    send(res, 200, {
      kind: 'withdrawal',
      from: 'Example Exchange',
      purpose: `Withdrawal of ${w.amount} CCD to your account`,
      account: w.to, // the account the answer must come from
      request: w.request,
      wording: describeProofRequest(w.request),
    });
  },
  'POST /relay/:code': async (req, res, { code }) => {
    const entry = relay.get(code.toUpperCase());
    if (!entry || entry.state !== 'waiting') return send(res, 404, { error: 'No question waiting with this code.' });
    const body = await readBody(req);
    entry.state = 'answered';
    if (entry.kind === 'pay') {
      const p = pledgesById.get(entry.id);
      if (body.declined) {
        p.status = 'not-paid';
        p.payment = { error: 'declined in the wallet' };
      } else {
        p.status = 'checking-payment';
        try {
          await receivePayment(p, String(body.hash));
        } catch (error) {
          payFailed(p, `The payment could not be checked: ${error.message}`);
        }
      }
      return send(res, 200, { status: p.status });
    }
    if (entry.kind === 'pledge') {
      const p = pledgesById.get(entry.id);
      if (body.declined) {
        p.status = 'declined';
        p.checks = [{ label: 'The donor agreed', ok: false, why: 'declined in the wallet' }];
      } else {
        p.status = 'checking';
        try {
          await receivePledge(p, body);
        } catch (error) {
          p.status = 'error';
          p.checks = [{ label: 'The pledge could be checked', ok: false, why: error?.reason === 'node'
            ? `Concordium's testnet node did not answer (${error.detail}). Please pledge again.` : error.message }];
        }
      }
      return send(res, 200, { status: p.status });
    }
    if (entry.kind === 'age') {
      const c = ageChecks.get(entry.id);
      if (body.declined) {
        c.status = 'declined';
        c.checks = [{ label: 'The customer agreed to answer', ok: false, why: 'declined in the wallet' }];
      } else {
        c.status = 'checking';
        try {
          await receiveAgeAnswer(c, body.presentation);
        } catch (error) {
          c.status = 'error';
          c.checks = [{ label: 'The answer could be checked', ok: false, why: error?.reason === 'node'
            ? `Concordium's testnet node did not answer (${error.detail}). Please ask again.` : error.message }];
        }
      }
      return send(res, 200, { status: c.status });
    }
    const w = withdrawals.get(entry.id);
    if (body.declined) {
      w.status = 'declined';
      w.checks = [{ label: 'The customer agreed to answer', ok: false, why: 'declined in the wallet' }];
    } else {
      w.status = 'checking';
      try {
        await receiveAnswer(w, body.presentation);
      } catch (error) {
        w.status = 'error';
        w.checks = [{ label: 'The answer could be checked', ok: false,
          why: error?.reason === 'node' ? `Concordium's testnet node did not answer (${error.detail}). Please try again with a new withdrawal.` : error.message }];
      }
      if (w.status === 'released') payOut(w); // in the background: the page follows it
    }
    send(res, 200, { status: w.status });
  },
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    for (const [route, handle] of Object.entries(routes)) {
      const [method, pattern] = route.split(' ');
      if (method !== req.method) continue;
      const names = [];
      const regex = new RegExp(`^${pattern.replace(/:(\w+)/g, (_, name) => { names.push(name); return '([^/]+)'; })}$`);
      const match = url.pathname.match(regex);
      if (match) return await handle(req, res, Object.fromEntries(names.map((n, i) => [n, decodeURIComponent(match[i + 1])])));
    }
    send(res, 404, { error: 'Not found.' });
  } catch (error) {
    console.error(error);
    send(res, 500, { error: error.message });
  }
});

loadCampaign();
setInterval(saveCampaign, 1000); // saved within a second of any change

// Listens on this computer only: the emulator reaches it as 10.0.2.2. (For a real phone, listen on the network.)
server.listen(PORT, process.env.HOST || '127.0.0.1', () => {
  console.log(`Example Exchange (testnet): http://localhost:${PORT}   (the phone reaches it as ${RELAY_BASE})`);
  console.log(asker && sponsor ? `Questions are recorded on chain by ${asker.address} (fees paid by ${sponsor.address}).` : 'Questions not set up (.env.payout): tabs 1-3 cannot ask.');
  console.log(payer ? `Withdrawals are paid from ${payer.address} (testnet).` : 'No paying account set up (.env.payout): withdrawals are checked, not paid.');
});
