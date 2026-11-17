/**
 * A stand-in for the phone, to test Example Exchange on this computer: it fetches the question waiting under a code,
 * answers it from an identity of the public test phrase, and sends the answer back, as the phone app does.
 *
 *   npm run test-wallet -- <code>            answer (identity 1 with provider 0, its account 0)
 *   npm run test-wallet -- <code> decline    the customer declines
 *   npm run test-wallet -- details           print that identity's name and ID number (for a test customer record)
 *
 * Read-only on the chain. The public test phrase is shared with everyone: never for anything of value.
 */
import { ConcordiumIdentity, CONCORDIUM_TESTNET_IDENTITY_CONFIG } from '@concordium/wdk-identity-concordium';
import { ConcordiumGRPCNodeClient, credentials } from '@concordium/web-sdk/nodejs';

const PUBLIC_TEST_PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const [code, action] = process.argv.slice(2);
const RELAY = process.env.RELAY || 'http://localhost:4400';
const providerIndex = 0;
const identityIndex = 1;

const identityProviders = await (await fetch('https://wallet-proxy.testnet.concordium.com/v2/ip_info')).json();
const node = new ConcordiumGRPCNodeClient('grpc.testnet.concordium.com', 20000, credentials.createSsl());
const identity = new ConcordiumIdentity(PUBLIC_TEST_PHRASE, { ...CONCORDIUM_TESTNET_IDENTITY_CONFIG, identityProviders, node });

try {
  await identity.recoverIdentity({ providerIndex, identityIndex });

  if (code === 'details') {
    const exported = JSON.parse(await identity.exportIdentity({ providerIndex, identityIndex }));
    const find = (o) => (o && typeof o === 'object' ? (o.chosenAttributes ?? Object.values(o).map(find).find(Boolean)) : undefined);
    const { firstName, lastName, idDocNo } = find(exported);
    console.log(JSON.stringify({ firstName, lastName, idDocNo }));
  } else {
    const question = await (await fetch(`${RELAY}/relay/${code}`)).json();
    if (question.error) throw new Error(question.error);
    console.log(`${question.from} asks (${question.purpose}):`);
    for (const part of question.wording) for (const ask of part.asks) console.log(`  "${ask.text}"`);

    let body;
    if (action === 'decline') {
      body = { declined: true };
    } else if (question.kind === 'age') {
      // Over 18: answered from the identity itself, no account.
      const proof = await identity.prove({ providerIndex, identityIndex, request: question.request });
      body = { presentation: JSON.stringify(proof) };
    } else {
      // Answer from the account the withdrawal goes to, if it is one of this identity's accounts.
      const accounts = await identity.accountsThatCanAnswer({ providerIndex, identityIndex, request: question.request });
      const account = accounts.find((a) => a.address === question.account) ?? accounts[0];
      console.log(`  answering from account ${account.address}`);
      const proof = await identity.prove({ providerIndex, identityIndex, request: question.request, credNumber: account.credNumber });
      body = { presentation: JSON.stringify(proof) };
    }
    const reply = await (await fetch(`${RELAY}/relay/${code}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
    console.log(`Example Exchange: ${reply.status ?? reply.error}`);
  }
} finally {
  identity.dispose();
}
