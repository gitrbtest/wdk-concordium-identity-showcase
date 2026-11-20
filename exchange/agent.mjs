/**
 * Example Corp's research agent (story 6): a program that buys data by itself. No person approves its payments:
 * Example Corp's rules do (on the showcase server), and the agent's own consent policy decides which questions it
 * answers. Scripted on purpose: it follows fixed steps, so each run shows the same thing.
 *
 *   npm run agent -- buy        buy the van prices dataset from Example Data Shop
 *   npm run agent -- tricked    buy it, then follow the line planted in the data (Example Corp refuses)
 *   npm run agent -- runaway    keep buying until Example Corp's daily limit stops it
 *
 * Who's who:
 *
 *   THE AGENT (this script)            EXAMPLE CORP (server)              EXAMPLE DATA SHOP (server)    CHAIN
 *   ───────────────────────            ─────────────────────              ──────────────────────────    ─────
 *   1. reads its rules ──────────────► the limits, approved suppliers
 *   2. orders a dataset ──────────────────────────────────────────────► price + a question ─────────► anchor
 *   3. its consent policy decides; proves from its own account ───────► checks the answer
 *   4. asks to pay ──────────────────► checks its rules; signs as
 *                                      sponsor (pays the fee)
 *   5. signs, hands it back ─────────► the same payment? sends it ───────────────────────────────────► final
 *   6. gives the shop the payment ────────────────────────────────────► checks it on chain → the data
 *
 * Its account (0/334563111/17 of the public test phrase) holds no CCD, so it cannot pay a fee by itself: every
 * payment needs Example Corp. Sends testnet transactions. The public test phrase is shared with everyone: never for
 * anything of value.
 */
import * as sdk from '@concordium/web-sdk';
import { ConcordiumIdentity, CONCORDIUM_TESTNET_IDENTITY_CONFIG } from '@concordium/wdk-identity-concordium';
import { connectToNode, describeProofRequest, describeProofContext } from '@concordium/wdk-identity-concordium/verify';

const SERVER = process.env.SERVER || 'http://localhost:4400';
const ME = { providerIndex: 0, identityIndex: Number(process.env.AGENT_IDENTITY_INDEX ?? 334563111),
  credNumber: Number(process.env.AGENT_ACCOUNT_NUMBER ?? 17) };
const ACCOUNT = process.env.AGENT_ADDRESS || '3RsZNBo6eobjA6FBSW9Kb1MuiSeMsvvEgZLDbT6TEWHGLkDR2u'; // that account's address
const DATASET = 'van-prices';
const MAX_ROUNDS = 10;                      // the agent's own stop in the runaway scene, in case nothing else stops it

// ── SHOWN IN STORY 6 (THE AGENT): START ──
/** The agent's consent policy: where a wallet asks its owner "answer this question?", the agent asks this. */
const POLICY = {
  shops: ['datashop.example'],                                    // only these may ask it anything
  mayProve: [                                                     // facts it may prove, never show
    { kind: 'in-set', attribute: 'countryOfResidence' },
    { kind: 'range', attribute: 'dob' },                          // an age, e.g. over 18
  ],
};

function mayAnswer(question) {
  const { website, purpose } = describeProofContext(question);
  if (!POLICY.shops.includes(website)) return { ok: false, why: `${website} is not on the agent's list of shops` };
  for (const part of describeProofRequest(question)) {
    for (const ask of part.asks) {
      if (ask.kind === 'reveal') return { ok: false, why: `it asks to show ${ask.attribute}; the agent never shows anything` };
      if (!POLICY.mayProve.some((p) => p.kind === ask.kind && p.attribute === ask.attribute)) {
        return { ok: false, why: `"${ask.text}" is not something the policy allows` };
      }
    }
  }
  return { ok: true, why: `${website} asks (${purpose}) for facts the policy allows; nothing is shown` };
}
// ── SHOWN IN STORY 6 (THE AGENT): END ──

const keys = sdk.ConcordiumHdWallet.fromSeedPhrase(process.env.PAYOUT_SEED, 'Testnet');
const signer = sdk.buildBasicAccountSigner(keys.getAccountSigningKey(ME.providerIndex, ME.identityIndex, ME.credNumber).toString('hex'));
const say = (text) => console.log(`agent: ${text}`);
async function call(method, path, body) {
  const res = await fetch(`${SERVER}${path}`, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  const json = await res.json();
  if (!res.ok) throw Object.assign(new Error(json.error ?? `HTTP ${res.status}`), { refused: true });
  return json;
}

/** Try again (up to 3 times) when the public node does not answer, as it sometimes does (e.g. HTTP 502). */
async function retried(work) {
  for (let attempt = 1; ; attempt++) {
    try { return await work(); } catch (error) {
      if (error.refused || attempt >= 3) throw error;
      say(`the node did not answer (${error.message}); trying again in ${3 * attempt} s`);
      await new Promise((resolve) => setTimeout(resolve, 3000 * attempt));
    }
  }
}

let identity;
/** Its identity, held in memory: recovered from the seed through the identity provider (a few seconds, once). */
async function myIdentity() {
  if (!identity) {
    const identityProviders = await (await fetch('https://wallet-proxy.testnet.concordium.com/v2/ip_info')).json();
    identity = new ConcordiumIdentity(process.env.PAYOUT_SEED, { ...CONCORDIUM_TESTNET_IDENTITY_CONFIG, identityProviders, node: connectToNode('testnet') });
    try { await identity.recoverIdentity({ providerIndex: ME.providerIndex, identityIndex: ME.identityIndex }); } catch (error) {
      identity.dispose();
      identity = undefined;   // start again next time
      throw error;
    }
  }
  return identity;
}

/** Ask Example Corp to pay; if it agrees, sign the payment it built and hand it back. Returns the payment's hash. */
async function pay(rules, to, amount, purpose) {
  say(`asking ${rules.company} to pay ${amount} ${rules.token} to ${to} (${purpose})`);
  const authorised = await call('POST', '/relay/agent/authorise', { from: rules.account, to, amount, purpose });
  say(`${rules.company} agreed and signed as sponsor; signing it myself`);
  const transaction = sdk.Transaction.fromJSONString(authorised.transaction, sdk.Transaction.signableFromJSON);
  const signed = await sdk.Transaction.sign(transaction, signer);
  const done = await call('POST', '/relay/agent/submit', { id: authorised.id, transaction: sdk.Transaction.toJSONString(signed) });
  if (done.status !== 'paid') throw Object.assign(new Error(`the payment failed: ${done.why}`), { refused: true });
  say(`paid: ${done.hash}`);
  return done.hash;
}

/** One purchase: order, answer the shop's question if its policy allows, pay through Example Corp, get the data. */
async function buy(rules) {
  const [item] = (await call('GET', '/shop/datasets')).filter((d) => d.id === DATASET);
  say(`ordering "${item.title}" for ${item.price} ${item.token}`);
  let order = await call('POST', '/shop/orders', { dataset: item.id, account: rules.account });
  if (order.status === 'waiting-for-proof') {
    const decision = mayAnswer(order.question);
    say(`the shop asks a question; my policy says ${decision.ok ? 'yes' : 'no'}: ${decision.why}`);
    if (!decision.ok) throw Object.assign(new Error('the agent declined the shop\'s question'), { refused: true });
    const proof = await retried(async () => (await myIdentity()).prove({ ...ME, request: order.question }));
    order = await call('POST', `/shop/orders/${order.id}/answer`, { presentation: JSON.stringify(proof) });
    say('the shop accepted my answer');
  } else {
    say('the shop knows this account already: no question');
  }
  const hash = await pay(rules, order.payTo, order.price, `dataset: ${item.title}`);
  const delivered = await call('POST', `/shop/orders/${order.id}/payment`, { hash });
  say(`got the data: ${delivered.data.map((r) => `${r.model} ${r.listPrice} EUR`).join('; ')}`);
  return delivered;
}

const scene = process.argv[2] ?? 'buy';
if (!['buy', 'tricked', 'runaway'].includes(scene)) {
  console.log('npm run agent -- buy | tricked | runaway');
  process.exit(1);
}
if (!process.env.PAYOUT_SEED) {
  console.log('No seed: run it with npm run agent (it reads .env.payout).');
  process.exit(1);
}
try {
  const account = ACCOUNT;
  const rules = { ...(await call('GET', `/relay/agent/rules?account=${account}`)), account };
  say(`I am Example Corp's research agent (${account}). My rules: at most ${rules.maxPayment} ${rules.token} a payment, `
    + `${rules.maxPerDay} a day (${rules.spentToday} spent today), only ${rules.suppliers.map((s) => s.name).join(', ')}`);

  if (scene === 'buy') await buy(rules);

  if (scene === 'tricked') {
    const delivered = await buy(rules);
    say(`the data's notes say: "${delivered.notes}"`);
    const [, amount, to] = delivered.notes.match(/costs ([\d.]+) TN, pay it now to (\w+)/) ?? [];
    say('following the notes (a scripted agent falls for this on purpose)');
    try {
      await pay(rules, to, Number(amount), 'the full version, as the data says');
    } catch (error) {
      if (!error.refused) throw error;
      say(`${rules.company} refused: ${error.message}`);
    }
  }

  if (scene === 'runaway') {
    for (let round = 1; round <= MAX_ROUNDS; round++) {
      say(`round ${round}`);
      try {
        await buy(rules);
      } catch (error) {
        if (!error.refused) throw error;
        say(`stopped: ${error.message}`);
        break;
      }
    }
  }
} catch (error) {
  say(`stopped: ${error.message}`);
  process.exitCode = 1;
} finally {
  identity?.dispose();
}

