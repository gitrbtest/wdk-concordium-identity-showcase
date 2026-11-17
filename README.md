# Showcase: a Concordium identity in a WDK wallet

A working demo, on test networks only, of what a WDK wallet holding a Concordium identity makes possible. One phone
app (Maya's wallet) and one demo page with a tab per story, each played by a made-up organisation:

| Tab | Organisation | Story | What it shows |
|---|---|---|---|
| 1 | Example Exchange | Withdraw to your own wallet | the wallet proves the account is Maya's and shows her name; the exchange checks the proof against the chain and pays out test CCD |
| 2 | Example Exchange | Over 18? | the wallet proves one fact from the identity itself: no account, no name, no date of birth |
| 3 | Example Community Fund | Pledge to a cause | each pledge: a Concordium proof (a verified adult) and an Ethereum signature (the paying address); paid later in test USDT on Ethereum Sepolia through WDK's EVM module, matched to its pledge |
| 4 | Maya's wallet | New phone | restore from the seed phrase alone: the identity back from its provider (no new verification), the accounts found on chain, the pledges asked back from the fund |
| 5 | Example Corp | Company card | an allowance in a token on Maya's own account: approved suppliers only, each payment authorised by the company, which pays its fee (sponsored); a regulated token's allow list checked before sending |

Each tab explains the story (today vs. with a Concordium identity), says how to try it, lists what a real system
would add ("Kept simple on purpose"), and shows the organisation's own code ("Show the code").

Proofs are Concordium's version 1 proofs: the organisation records its question on chain first (a small fee, paid by
a sponsor account), and the wallet answers from the identity itself (tab 2) or from an account (tabs 1 and 3).

## What is in the repository

```
exchange/      the organisations' side: one Node.js server (port 4400) with the demo page, the relay to the phone,
               the checks, the payouts, the pledge campaign and the company card
  server.mjs, public/index.html
  customer.json            Example Exchange's record of Maya (made-up: Maya Example, MX1234567)
  test-wallet.mjs          a stand-in phone for tabs 1-2, to try them from the computer
  test-donor.mjs           Rob and Sam, the other two donors of tab 3 (run from the computer)
  test-card.mjs            a stand-in card holder for tab 5
  .env.payout.example      template: the testnet accounts that pay (works as it is)
  .env.ethereum.example    template: your own Ethereum test seed
  packages/                our packages, packed (see "Which version of the packages")
wallet-app/    Maya's phone: a React Native (Expo) app built on the identity package's React Native example, with
               the requests card, "My pledges", the Ethereum account (WDK's EVM module) and the company card
```

## What you need

- **Node.js 22** or newer, and **Git**.
- For the phone app: **Android Studio** with an emulator (any recent phone image), **Java 17**, and the environment
  variables `JAVA_HOME` (your JDK 17) and `ANDROID_HOME` (your Android SDK). The identity package's React Native
  example explains this set-up step by step: `identity/examples/react-native/README.md` in the fork.
- A browser, for the demo page.

## Set it up (once)

**1. Clone and install** (the commands are for PowerShell; on macOS or Linux, use `cp` instead of `copy`):

```powershell
git clone <this repository> wdk-concordium-showcase
cd wdk-concordium-showcase\exchange
npm install
cd ..\wallet-app
npm install
```

**2. The server's settings**, in `exchange`:

```powershell
cd ..\exchange
copy .env.payout.example .env.payout
copy .env.ethereum.example .env.ethereum
node -e "console.log(require('ethers').Wallet.createRandom().mnemonic.phrase)"
```

- `.env.payout` works as it is: it uses the shared test accounts of the public test phrase, so nothing in it is
  secret (see "Costs" below).
- In `.env.ethereum`, replace the placeholder with the new phrase the last command printed. It is your own test seed
  for the computer's Ethereum accounts (Rob, Sam and the campaign's address). Keep it to yourself, and never use the
  public test phrase on Ethereum: bots empty its addresses.

**3. Build the phone app** on the emulator (start the emulator first, from Android Studio's Device Manager; the first
build takes a few minutes):

```powershell
cd ..\wallet-app
npm run android
```

**4. Make Maya's wallet** in the app: "Create a new wallet", then "2. Verify your identity": choose Concordium's
test identity provider (provider 0) and fill in its test form. Type first name **Maya**, last name **Example** and ID document number **MX1234567** (so tab 1 recognises
her as Example Exchange's customer), and keep the form's default date of birth (over 18). Then create her account
("Create account"). The app shows her Concordium address.

**5. Test funds for the pledge story** (tab 3):
- **Maya's Ethereum account** (in the app, "Ethereum account") needs a little Sepolia ETH for Ethereum's fees, from a
  faucet (for example sepolia-faucet.pk910.de, no sign-in; 0.05 ETH is plenty). Then press "Get 1,000 test USDT".
- **Rob and Sam:** give Rob's address Sepolia ETH from a faucet (run `npm run donor -- setup` in `exchange` once to
  see his address), then run `npm run donor -- setup` again: Sam gets half of Rob's ETH, and both get 1,000 test USDT.

The test USDT is a stand-in token on Sepolia that anyone can mint (`0x2F22064e87195D6D5aD22277FEDDFa2e2f59165F`).

**6. Tab 5 (company card), optional:** in `exchange\.env.payout`, set `CARD_HOLDER=` to Maya's Concordium address.

## Run it

Three things run at once, each in its own terminal: the emulator, Metro (it serves the app's code) and the server.

```powershell
cd wallet-app
npm start
```

```powershell
cd exchange
npm start
```

Open the app on the emulator, and the demo page at **http://localhost:4400**. `?tabs=` shows only some tabs, in the
order given, for example `http://localhost:4400/?tabs=1,2`.

The first time the app loads its code it can take a few minutes (the development build is large: Concordium's
cryptography and WDK's EVM module). If it shows "Unable to load script", Metro was not ready: press Reload.

## Try the stories

Each tab's "Try it" section has the steps. In short:

- **Tab 1:** enter Maya's address and an amount (up to 50), press Withdraw. The question is recorded on chain (a few
  seconds), then a QR code and a short code appear. In the app's "Requests from websites", type the code, read the
  consent, approve. The page ticks three checks and pays out. Also try another account's address: the wallet refuses.
- **Tab 2:** press "Ask: are you over 18?", type the code in the app, approve.
- **Tab 3:** Maya pledges (type the code in the app). Then press Pledge for each other donor and, in `exchange`, run
  `npm run donor -- <code> rob` and `npm run donor -- <code> sam`. Close the campaign: the app's "My pledges" shows
  "Pay now"; Rob and Sam pay with `npm run donor -- <pay code> rob` (and `sam`). "Start the campaign again (demo)"
  clears the board.
- **Tab 4:** the steps are on the tab: show the seed phrase, keep a copy of the words, "Start again", then restore.
- **Tab 5:** top up Maya's card on the page, then pay the suppliers from the app's company card.

Without the phone, `npm run test-wallet -- <code>` in `exchange` answers tabs 1 and 2 from the computer, as the
public test phrase's identity 1. Its details differ from Maya's, so start the server with
`$env:CUSTOMER="customer.test.json"; npm start` for tab 1's name check to pass.

## Costs (all test coins, no value)

- Each question (tabs 1-3) is recorded on chain for about 5 test CCD, paid by the sponsor account (`4kJZHv…`).
- Withdrawals (up to 50 test CCD each), pledge fingerprints (about 3.4 test CCD) and the company card's fees are paid
  by the showcase's own account (`4Mcp1F…`, account 16 of the public test identity; it also holds Example Corp's TN).

Both are shared accounts of the public test phrase: anyone can use them, so they may run low. Top them up with test
CCD (for example with Concordium's testnet wallet faucet), or put your own testnet accounts in `.env.payout`.

## Good to know

- **The campaign is kept in a file** (`exchange\campaign-state.json`, not committed), so restarting the server keeps
  the pledges. Withdrawals and over-18 questions live in memory: a restart clears them.
- **Concordium's public testnet node** sometimes answers with a temporary error (for example HTTP 502). The page then
  says so: start that step again.
- **The relay** stands in for the wallet connection (WalletConnect in a real app). It listens on this computer only.
- **A real phone** (not tried yet): on the same Wi-Fi as the computer, start the server with `$env:HOST="0.0.0.0";
  $env:RELAY_BASE="http://<the computer's IP>:4400"; npm start`, and Metro with
  `$env:EXPO_PUBLIC_RELAY="http://<the computer's IP>:4400"; npm start`, then install the app on the phone with
  `npm run android` (USB debugging on). The QR codes then open the request in the app from the phone's camera.

## Which version of the packages

The showcase uses packed snapshots of our packages, in `exchange\packages\` and `wallet-app\packages\`: the
identity package (`@concordium/wdk-identity-concordium`) and the wallet package
(`@concordium/wdk-wallet-concordium`), from the `p2/20-tidy-up` branch of the fork. WDK's EVM module and everything
else are fixed versions from npm.

To use a newer identity package, clone the fork next to this repository (as `tether-wdk-concordium`), then:

```powershell
cd wallet-app
npm run pack-packages
npm install
copy packages\concordium-wdk-identity-concordium-0.0.0.tgz ..\exchange\packages\
cd ..\exchange
npm install
```

(npm keeps an already installed copy with the same version number: if it does not pick up the new snapshot, delete
`node_modules\@concordium\wdk-identity-concordium` and run `npm install` again.)

## Ports

| Port | What |
|---|---|
| 8081 | Metro (the phone app's code) |
| 4400 | the server and the demo page |

To stop everything: close the emulator, and stop Metro and the server (Ctrl+C in their terminals).

## Licence

Apache-2.0 (see `LICENSE`), as our packages. The Concordium logo (`wallet-app/assets/`) is Concordium's.
