/**
 * Rob and Sam: two donors on this computer, for the pledge story (story 3), so the campaign board fills up. Each does
 * what the phone does: fetch the pledge waiting under a code, prove "a verified person, 18 or over" with Concordium
 * (their identity of the public test phrase), sign the pledge text with their Ethereum key (WDK's EVM module), and
 * send both back.
 *
 *   npm run donor -- <code> rob           (or sam; add "decline" to decline): pledge, or pay a pledge
 *   npm run donor -- setup                give Rob and Sam test USDT (minted), and Sam half of Rob's test ETH
 *
 * Their Concordium identities are the public test phrase's (identity 1 and 334563111 with provider 0); their Ethereum
 * accounts come from PC_ETHEREUM_SEED (.env.ethereum: your own test seed; the public phrase's Ethereum addresses are
 * emptied by bots). Pledging is read-only. Paying and setup send Sepolia testnet transactions (test ETH for fees).
 * Testnet only: never for anything of value.
 */
import { ConcordiumIdentity, CONCORDIUM_TESTNET_IDENTITY_CONFIG } from '@concordium/wdk-identity-concordium';
import { ConcordiumGRPCNodeClient, credentials } from '@concordium/web-sdk/nodejs';
import WalletManagerEvm from '@tetherto/wdk-wallet-evm';
import { Interface, JsonRpcProvider, formatEther } from 'ethers';

const SEPOLIA = 'https://ethereum-sepolia-rpc.publicnode.com';
const TEST_USDT = '0x2F22064e87195D6D5aD22277FEDDFa2e2f59165F'; // stand-in on Sepolia; anyone can mint

const PUBLIC_TEST_PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
// Concordium: identities of the public test phrase. Ethereum: a private seed (.env.ethereum), because the public
// phrase's Ethereum addresses are swept by bots (anything sent to them is moved away at once).
const ETHEREUM_SEED = process.env.PC_ETHEREUM_SEED;
if (!ETHEREUM_SEED) { console.error('PC_ETHEREUM_SEED is missing: run with --env-file=.env.ethereum (npm run donor).'); process.exit(1); }
const DONORS = {
  rob: { identityIndex: 1, evmIndex: 0 },          // Concordium identity 1 with provider 0; Ethereum m/44'/60'/0'/0/0
  sam: { identityIndex: 334563111, evmIndex: 1 },  // Concordium identity 334563111 with provider 0; Ethereum …/0/1
};
const [code, who = 'rob', action] = process.argv.slice(2);
const donor = DONORS[who];

if (code === 'setup') {
  // Rob holds the faucet ETH: give Sam half, and mint 1,000 test USDT for each.
  const wallet = new WalletManagerEvm(ETHEREUM_SEED, { provider: SEPOLIA });
  const provider = new JsonRpcProvider(SEPOLIA);
  const rob = await wallet.getAccountByPath(`0'/0/${DONORS.rob.evmIndex}`);
  const sam = await wallet.getAccountByPath(`0'/0/${DONORS.sam.evmIndex}`);
  const robEth = await rob.getBalance();
  console.log(`Rob ${await rob.getAddress()} holds ${formatEther(robEth)} test ETH`);
  if (robEth === 0n) { console.error('Rob has no test ETH yet: use the faucet first.'); process.exit(1); }
  const mint = new Interface(['function mint(address,uint256)']);
  for (const [name, account] of [['Rob', rob], ['Sam', sam]]) {
    if (name === 'Rob' && process.argv[3] === 'sam-only') continue;
    if (name === 'Sam' && (await sam.getBalance()) < 10n ** 16n) { // under 0.01 ETH: top up
      const { hash } = await rob.sendTransaction({ to: await sam.getAddress(), value: robEth / 2n });
      await provider.waitForTransaction(hash);
      console.log(`  Sam got ${formatEther(robEth / 2n)} test ETH: ${hash}`);
    }
    const { hash } = await account.sendTransaction({ to: TEST_USDT, value: 0n,
      data: mint.encodeFunctionData('mint', [await account.getAddress(), 1000_000000n]) });
    await provider.waitForTransaction(hash);
    console.log(`  ${name} minted 1,000 test USDT: ${hash}`);
  }
  wallet.dispose();
  process.exit(0);
}
if (!code || !donor) { console.error('Usage: node test-donor.mjs <code> rob|sam [decline]  |  node test-donor.mjs setup'); process.exit(1); }
const RELAY = process.env.RELAY || 'http://localhost:4400';
const providerIndex = 0;

const identityProviders = await (await fetch('https://wallet-proxy.testnet.concordium.com/v2/ip_info')).json();
const node = new ConcordiumGRPCNodeClient('grpc.testnet.concordium.com', 20000, credentials.createSsl());
const identity = new ConcordiumIdentity(PUBLIC_TEST_PHRASE, { ...CONCORDIUM_TESTNET_IDENTITY_CONFIG, identityProviders, node });
const ethereum = new WalletManagerEvm(ETHEREUM_SEED, { provider: SEPOLIA });

try {
  const question = await (await fetch(`${RELAY}/relay/${code}`)).json();
  if (question.error) throw new Error(question.error);
  if (question.kind === 'pay') {
    console.log(`${who}: ${question.from}: ${question.purpose}`);
    const evm = await ethereum.getAccountByPath(`0'/0/${donor.evmIndex}`);
    let body = { declined: true };
    if (action !== 'decline') {
      const { pay } = question;
      const { hash } = await evm.transfer({ token: pay.tokenAddress, recipient: pay.to, amount: BigInt(pay.amount) * 10n ** BigInt(pay.decimals) });
      console.log(`  paid ${pay.amount} ${pay.token} from ${await evm.getAddress()}: ${hash}`);
      body = { hash };
    }
    const reply = await (await fetch(`${RELAY}/relay/${code}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
    console.log(`${question.from}: ${reply.status ?? reply.error}`);
    process.exit(0);
  }
  if (question.kind !== 'pledge') throw new Error('This code is not a pledge.');
  console.log(`${who}: ${question.from} asks: ${question.purpose}`);
  for (const part of question.wording) for (const ask of part.asks) console.log(`  "${ask.text}"`);

  let body;
  if (action === 'decline') {
    body = { declined: true };
  } else {
    // Who: a Concordium proof from one of the identity's accounts.
    const { identityIndex } = donor;
    await identity.recoverIdentity({ providerIndex, identityIndex });
    const [account] = await identity.accountsThatCanAnswer({ providerIndex, identityIndex, request: question.request });
    if (!account) throw new Error('This identity cannot answer the question.');
    const proof = await identity.prove({ providerIndex, identityIndex, request: question.request, credNumber: account.credNumber });
    // Which address pays: the pledge text, signed with the Ethereum key.
    const evm = await ethereum.getAccountByPath(`0'/0/${donor.evmIndex}`);
    const payFrom = await evm.getAddress();
    const text = question.pledge.textTemplate.replace('{payFrom}', payFrom);
    console.log(`  from Concordium account ${account.address}, paying from ${payFrom}`);
    body = { presentation: JSON.stringify(proof), payFrom, signature: await evm.sign(text) };
  }
  const reply = await (await fetch(`${RELAY}/relay/${code}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
  console.log(`${question.from}: ${reply.status ?? reply.error}`);
} finally {
  identity.dispose();
  ethereum.dispose();
}
