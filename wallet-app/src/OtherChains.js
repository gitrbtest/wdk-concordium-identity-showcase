/**
 * The wallet's Ethereum account (Sepolia testnet), from the same seed phrase, through WDK's own EVM module: its
 * address and balances, signing a pledge text ("this address is mine"), paying a pledge in test USDT, and getting
 * test USDT to try it with.
 */
import { useState } from 'react';
import { Text, View } from 'react-native';
import WalletManagerEvm from '@tetherto/wdk-wallet-evm';
import { JsonRpcProvider, Contract, Interface, formatEther, formatUnits } from 'ethers';

const SEPOLIA = 'https://ethereum-sepolia-rpc.publicnode.com';
const TEST_USDT = '0x2F22064e87195D6D5aD22277FEDDFa2e2f59165F'; // a test USDT stand-in on Sepolia: anyone can mint it

/** This wallet's Ethereum address (account 0 of WDK's EVM module, from the seed phrase). */
export async function ethereumAddress(seedPhrase) {
  const wallet = new WalletManagerEvm(seedPhrase, {});
  try { return await (await wallet.getAccount(0)).getAddress(); } finally { wallet.dispose(); }
}

/** Sign a text with this wallet's Ethereum key: "I control this address". */
export async function ethereumSign(seedPhrase, text) {
  const wallet = new WalletManagerEvm(seedPhrase, {});
  try { return await (await wallet.getAccount(0)).sign(text); } finally { wallet.dispose(); }
}

/** Pay in a token on Ethereum (Sepolia) from this wallet's Ethereum account, through WDK's EVM module. Returns the
 *  transaction hash as soon as it is sent (the receiver checks it on chain). */
export async function ethereumPay(seedPhrase, { tokenAddress, to, amount, decimals }) {
  const wallet = new WalletManagerEvm(seedPhrase, { provider: SEPOLIA });
  try {
    const account = await wallet.getAccount(0);
    const { hash } = await account.transfer({ token: tokenAddress, recipient: to, amount: BigInt(amount) * 10n ** BigInt(decimals) });
    return hash;
  } finally {
    wallet.dispose();
  }
}

/** Get 1,000 test USDT on Sepolia (testnet only: the stand-in token lets anyone mint it), for the pledge story.
 *  Needs a little Sepolia ETH for the fee. */
export async function ethereumMint(seedPhrase) {
  const wallet = new WalletManagerEvm(seedPhrase, { provider: SEPOLIA });
  try {
    const account = await wallet.getAccount(0);
    const address = await account.getAddress();
    const { hash } = await account.sendTransaction({ to: TEST_USDT, value: 0n,
      data: new Interface(['function mint(address,uint256)']).encodeFunctionData('mint', [address, 1000_000000n]) });
    const receipt = await new JsonRpcProvider(SEPOLIA).waitForTransaction(hash, 1, 180_000);
    return { hash, ok: receipt?.status === 1 };
  } finally {
    wallet.dispose();
  }
}

/** This wallet's Ethereum account: its address and its Sepolia balances (test USDT, and ETH for fees). Read-only. */
export async function ethereumAccount(seedPhrase) {
  const wallet = new WalletManagerEvm(seedPhrase, { provider: SEPOLIA });
  try {
    const address = await (await wallet.getAccount(0)).getAddress();
    const provider = new JsonRpcProvider(SEPOLIA);
    const usdt = new Contract(TEST_USDT, ['function balanceOf(address) view returns (uint256)'], provider);
    const [eth, tokens] = await Promise.all([provider.getBalance(address), usdt.balanceOf(address)]);
    return { address, eth: formatEther(eth), usdt: formatUnits(tokens, 6) };
  } finally {
    wallet.dispose();
  }
}

export function OtherChainsCard({ result, sent, Button, onRun, onMint }) {
  if (!result) return <Button label="Show the Ethereum account" kind="quiet" onPress={onRun} />;
  return (
    <View>
      <Text style={{ fontSize: 12, color: '#6a727c' }}>Address (Ethereum Sepolia)</Text>
      <Text selectable style={{ fontFamily: 'monospace', fontSize: 12, marginBottom: 10 }}>{result.address}</Text>
      <Text style={{ fontSize: 12, color: '#6a727c' }}>Test USDT (a stand-in for USDT)</Text>
      <Text style={{ fontSize: 15, marginBottom: 10 }}>{result.usdt}</Text>
      <Text style={{ fontSize: 12, color: '#6a727c' }}>ETH, for Ethereum's network fees</Text>
      <Text style={{ fontSize: 15, marginBottom: 6 }}>{Number(result.eth).toFixed(4)}</Text>
      <Text style={{ fontSize: 12, color: '#6a727c', lineHeight: 17 }}>On Ethereum, fees are paid in ETH. WDK can also let
        fees be paid in USDT, or by someone else (gasless), so a wallet could hold only USDT.</Text>
      <Button label="Refresh" kind="quiet" onPress={onRun} />
      <Button label="Get 1,000 test USDT (testnet only)" kind="quiet" onPress={onMint} />
      {sent && <Text selectable style={{ fontSize: 12, marginTop: 8 }}>{sent.ok ? 'Done' : 'Failed'}: {sent.hash}</Text>}
    </View>
  );
}
