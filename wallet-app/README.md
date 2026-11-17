# WDK wallet (showcase): Maya's phone

The showcase's phone app (`com.wdkshowcase.wallet`, link scheme `wdkshowcase`), built on the identity package's
React Native example (`identity/examples/react-native` in the fork), with what the stories need:

- `src/Requests.js`: "Requests from websites" (type a code, or open a `wdkshowcase://request?…` link): the consent
  screens for a withdrawal (answered from an account), over 18 (answered from the identity), a pledge (a proof plus an
  Ethereum signature) and paying a pledge.
- `src/OtherChains.js`: the Ethereum account through WDK's EVM module (`@tetherto/wdk-wallet-evm`): address,
  balances, signing, paying in test USDT on Sepolia, getting test USDT.
- `src/CompanyCard.js`: Example Corp's card (story 5).
- `App.js`: the screens, including "My pledges" (the wallet asks each campaign about its pledges and shows "Pay now").
- `modules/concordium-native/`: Concordium's native cryptography as the identity package's cryptography plug-in
  (React Native has no WebAssembly), as in the fork's example.
- `metro.config.js` + `src/shims/sodium-universal.js`, and the `Buffer` line in `polyfill.js`: the two changes WDK's
  EVM module needs in React Native.
- `scripts/pack-packages.mjs`: packs a newer identity package from a clone of the fork into `packages/`.

How to set it up and run it: see `../README.md`.
