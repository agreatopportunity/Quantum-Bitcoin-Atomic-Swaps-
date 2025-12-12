# Quantum Bitcoin Atomic Swaps ⚛️🔄

A quantum-resistant trustless exchange protocol for cross-chain atomic swaps using SHA256 hash-locks (HTLC) technology.

## 🌐 Overview

Traditional atomic swaps rely on ECDSA signatures, which are vulnerable to quantum computers running Shor's algorithm. This implementation replaces signature-based security with **SHA256 hash time-locked contracts (HTLCs)**, enabling trustless cross-chain swaps that remain secure even against quantum adversaries.

**Swap any quantum-vulnerable chain for quantum-safe storage — trustlessly.**

---

## 🔐 How It Works

### The Problem with Traditional Atomic Swaps

Standard HTLCs use hash-locks (good) but also require ECDSA signatures for the timeout refund path (bad). A quantum attacker could:

1. Wait for you to initiate a swap
2. Derive your private key from the revealed public key
3. Steal funds from the refund path

### The Quantum-Safe Solution

We construct HTLCs using **dual hash-locks** — one for the swap, one for the refund — eliminating ECDSA entirely.

```
┌─────────────────────────────────────────────────────────────────┐
│                    QUANTUM-SAFE HTLC SCRIPT                     │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  IF                                                             │
│      OP_SHA256 <swap_hash> OP_EQUALVERIFY                       │
│      OP_SHA256 <recipient_hash> OP_EQUAL                        │
│  ELSE                                                           │
│      <timeout> OP_CHECKLOCKTIMEVERIFY OP_DROP                   │
│      OP_SHA256 <refund_hash> OP_EQUAL                           │
│  ENDIF                                                          │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

**To claim (recipient):** Reveal `swap_secret` + `recipient_secret`  
**To refund (initiator):** Wait for timeout + reveal `refund_secret`

No private keys. No signatures. No quantum vulnerability.

---

## 🔄 Swap Protocol

### Participants

- **Alice:** Has BSV, wants BTC
- **Bob:** Has BTC, wants BSV

### Phase 1: Setup

```
Alice generates:
├── swap_secret      → swap_hash        (shared with Bob)
├── alice_secret     → alice_hash       (for her refund)
└── 

Bob generates:
├── bob_secret       → bob_hash         (for his refund)
└── recipient_secret → recipient_hash   (to claim Alice's funds)
```

### Phase 2: Contract Creation

```
┌──────────────────────────────────────────────────────────────────────┐
│  STEP 1: Alice creates HTLC on BSV                                   │
│  ────────────────────────────────────────────────────────────────    │
│  Lock: 1 BSV                                                         │
│  Claim: swap_secret + recipient_secret (Bob can claim)               │
│  Refund: alice_secret after 24 hours (Alice can reclaim)             │
└──────────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌──────────────────────────────────────────────────────────────────────┐
│  STEP 2: Bob verifies Alice's contract, creates HTLC on BTC          │
│  ────────────────────────────────────────────────────────────────    │
│  Lock: 0.003 BTC (agreed exchange rate)                              │
│  Claim: swap_secret + alice_claim_secret (Alice can claim)           │
│  Refund: bob_secret after 12 hours (Bob can reclaim)                 │
└──────────────────────────────────────────────────────────────────────┘
```

### Phase 3: Execution

```
┌──────────────────────────────────────────────────────────────────────┐
│  STEP 3: Alice claims BTC                                            │
│  ────────────────────────────────────────────────────────────────    │
│  Alice reveals swap_secret to claim Bob's BTC                        │
│  This exposes swap_secret on the BTC blockchain                      │
└──────────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌──────────────────────────────────────────────────────────────────────┐
│  STEP 4: Bob claims BSV                                              │
│  ────────────────────────────────────────────────────────────────    │
│  Bob sees swap_secret on BTC chain                                   │
│  Bob uses swap_secret + recipient_secret to claim Alice's BSV        │
└──────────────────────────────────────────────────────────────────────┘
```

### Phase 4: Refund (If Swap Fails)

```
If Alice never claims (24+ hours):
└── Bob refunds his BTC using bob_secret

If Bob never creates his contract (24+ hours):
└── Alice refunds her BSV using alice_secret
```

---

## 🛡️ Security Model

### Attack Vector Analysis

| Attack | Traditional HTLC | Quantum-Safe HTLC |
|--------|------------------|-------------------|
| Quantum (Shor's Algorithm) | ❌ Refund path vulnerable | ✅ No signatures to break |
| Brute Force Hash | ✅ 2^256 attempts | ✅ 2^256 attempts |
| Timeout Race | ⚠️ Signature malleability | ✅ Hash-only verification |
| Front-Running | ⚠️ MEV possible | ⚠️ MEV possible |
| Replay Attack | ✅ One-time use | ✅ One-time use |

### Quantum Security Proof

The security relies entirely on SHA256 preimage resistance:

- **Classical attack:** 2^256 operations (impossible)
- **Quantum attack (Grover's):** 2^128 operations (still impossible)

No elliptic curve math = No Shor's algorithm attack surface.

### Timeout Security

```
CRITICAL: Timeout Differential

Alice's refund timeout:  24 hours
Bob's refund timeout:    12 hours

Bob MUST have less time. This ensures:
1. Alice has time to claim BTC before Bob can refund
2. Bob can refund BTC before Alice can refund BSV (if Alice disappears)
```

---

## 🚀 Quick Start

### Installation

```bash
git clone https://github.com/yourusername/quantum-atomic-swaps.git
cd quantum-atomic-swaps
npm install
```

### Configuration

```bash
cp .env.example .env
```

Edit `.env`:

```env
# Server
PORT=3000

# BSV Configuration
BSV_NETWORK=mainnet
BSV_API=https://api.whatsonchain.com/v1/bsv/main

# BTC Configuration  
BTC_NETWORK=mainnet
BTC_API=https://blockstream.info/api

# Timeouts (in blocks)
INITIATOR_TIMEOUT_BLOCKS=144    # ~24 hours on BTC
RESPONDER_TIMEOUT_BLOCKS=72     # ~12 hours on BTC
BSV_TIMEOUT_BLOCKS=144          # ~24 hours on BSV
```

### Run Server

```bash
npm start
```

Open `http://localhost:3000` in your browser.

### Development Mode

```bash
npm run dev
```

---

## 📡 API Endpoints

### Initiate Swap (Alice)

```http
POST /api/swap/initiate

Request:
{
  "fromChain": "BSV",
  "toChain": "BTC",
  "fromAmount": "100000000",        // 1 BSV in satoshis
  "toAmount": "300000",             // 0.003 BTC in satoshis
  "toAddress": "bc1q...",           // Alice's BTC address to receive
  "refundAddress": "1ABC..."        // Alice's BSV address for refund
}

Response:
{
  "success": true,
  "swapId": "swap_abc123",
  "swap_hash": "a1b2c3...",
  "alice_refund_hash": "d4e5f6...",
  "htlc_address": "3XYZ...",        // P2SH address on BSV
  "htlc_script": "63a820...",
  "timeout": 1702425600,
  "status": "awaiting_funding"
}
```

### Fund Swap (Alice)

```http
POST /api/swap/fund

Request:
{
  "swapId": "swap_abc123",
  "txid": "funding_txid_here"
}

Response:
{
  "success": true,
  "status": "funded_awaiting_counterparty",
  "confirmations": 1
}
```

### Join Swap (Bob)

```http
POST /api/swap/join

Request:
{
  "swapId": "swap_abc123",
  "fromAmount": "300000",           // Bob's BTC amount
  "toAddress": "1DEF...",           // Bob's BSV address to receive
  "refundAddress": "bc1q...",       // Bob's BTC address for refund
  "recipient_secret": "bob_generated_secret_hex"
}

Response:
{
  "success": true,
  "bob_htlc_address": "bc1q...",    // P2SH address on BTC
  "bob_htlc_script": "63a820...",
  "recipient_hash": "789abc...",
  "timeout": 1702382400,            // 12 hours less than Alice
  "status": "awaiting_bob_funding"
}
```

### Claim Funds (Alice claims BTC)

```http
POST /api/swap/claim

Request:
{
  "swapId": "swap_abc123",
  "chain": "BTC",
  "swap_secret": "alice_swap_secret_hex",
  "claim_secret": "alice_claim_secret_hex"
}

Response:
{
  "success": true,
  "txid": "claim_txid_here",
  "explorerLink": "https://blockstream.info/tx/...",
  "status": "alice_claimed"
}
```

### Claim Funds (Bob claims BSV)

```http
POST /api/swap/claim

Request:
{
  "swapId": "swap_abc123",
  "chain": "BSV",
  "swap_secret": "from_btc_blockchain",  // Bob extracts this
  "recipient_secret": "bob_recipient_secret_hex"
}

Response:
{
  "success": true,
  "txid": "claim_txid_here",
  "explorerLink": "https://whatsonchain.com/tx/...",
  "status": "completed"
}
```

### Refund (Timeout Expired)

```http
POST /api/swap/refund

Request:
{
  "swapId": "swap_abc123",
  "chain": "BSV",
  "refund_secret": "alice_refund_secret_hex"
}

Response:
{
  "success": true,
  "txid": "refund_txid_here",
  "explorerLink": "https://whatsonchain.com/tx/...",
  "status": "refunded"
}
```

### Get Swap Status

```http
GET /api/swap/status/:swapId

Response:
{
  "success": true,
  "swapId": "swap_abc123",
  "status": "funded_awaiting_counterparty",
  "fromChain": "BSV",
  "toChain": "BTC",
  "fromAmount": "100000000",
  "toAmount": "300000",
  "alice_htlc": {
    "address": "3XYZ...",
    "funded": true,
    "balance": 100000000,
    "timeout": 1702425600
  },
  "bob_htlc": {
    "address": null,
    "funded": false,
    "balance": 0,
    "timeout": null
  },
  "created_at": "2024-12-10T10:00:00Z"
}
```

---

## 🔧 Script Details

### BSV HTLC Script (Alice's Side)

```
// Redeem Script (hex breakdown)
63                              // OP_IF
  a8                            // OP_SHA256
  20                            // PUSH 32 bytes
  <swap_hash>                   // 32-byte swap hash
  88                            // OP_EQUALVERIFY
  a8                            // OP_SHA256
  20                            // PUSH 32 bytes
  <recipient_hash>              // 32-byte recipient hash
  87                            // OP_EQUAL
67                              // OP_ELSE
  04                            // PUSH 4 bytes
  <timeout>                     // 4-byte little-endian timestamp
  b1                            // OP_CHECKLOCKTIMEVERIFY
  75                            // OP_DROP
  a8                            // OP_SHA256
  20                            // PUSH 32 bytes
  <alice_refund_hash>           // 32-byte refund hash
  87                            // OP_EQUAL
68                              // OP_ENDIF
```

### Claim Transaction (Bob spending Alice's BSV)

```
// ScriptSig
  20 <swap_secret>              // 32-byte swap preimage
  20 <recipient_secret>         // 32-byte recipient preimage
  01 51                         // OP_TRUE (select IF branch)
  <serialized_redeem_script>    // The full redeem script
```

### Refund Transaction (Alice reclaiming her BSV)

```
// ScriptSig
  20 <alice_refund_secret>      // 32-byte refund preimage
  01 00                         // OP_FALSE (select ELSE branch)
  <serialized_redeem_script>    // The full redeem script

// Note: nLockTime must be >= timeout value
```

---

## 📂 Project Structure

```
quantum-atomic-swaps/
├── server.js                 # Express backend
├── package.json              # Dependencies
├── .env.example              # Configuration template
├── lib/
│   ├── htlc.js               # HTLC script generation
│   ├── bsv.js                # BSV chain interactions
│   ├── btc.js                # BTC chain interactions
│   ├── swap.js               # Swap coordination logic
│   └── crypto.js             # Hash utilities
├── public/
│   ├── index.html            # Swap interface
│   ├── app.js                # Frontend logic
│   └── styles.css            # Styling
├── test/
│   ├── htlc.test.js          # Script tests
│   └── swap.test.js          # Integration tests
└── README.md
```

---

## 🔬 Technical Specifications

| Property | Value |
|----------|-------|
| Hash Algorithm | SHA256 |
| Secret Size | 256 bits (32 bytes) |
| Script Type | P2SH (Pay-to-Script-Hash) |
| BSV Address Prefix | `3` (mainnet) |
| BTC Address Prefix | `3` (P2SH) or `bc1` (P2WSH) |
| Min Confirmations | 1 (configurable) |
| Default Initiator Timeout | 144 blocks (~24 hours) |
| Default Responder Timeout | 72 blocks (~12 hours) |

---

## ⚠️ Security Considerations

### Critical Rules

1. **NEVER reuse secrets** — Each swap requires fresh random secrets
2. **VERIFY timeout differentials** — Responder timeout MUST be shorter
3. **SAVE ALL SECRETS** — Loss of secrets means loss of funds
4. **VERIFY HTLC SCRIPTS** — Always decode and verify scripts before funding
5. **MONITOR TIMEOUTS** — Set alerts before refund windows open

### Recommended Practices

```
✅ Generate secrets using cryptographically secure RNG
✅ Verify counterparty's HTLC script before creating yours  
✅ Wait for sufficient confirmations before proceeding
✅ Test with small amounts first
✅ Keep offline backups of all swap data
✅ Use fresh addresses for each swap

❌ Never share secrets before appropriate phase
❌ Never fund HTLC without verifying script
❌ Never let timeouts expire without action
❌ Never reuse swap secrets across swaps
```

### Timeout Attack Prevention

```
Scenario: Bob tries to wait out the clock

Timeline:
├── T+0h:   Alice creates BSV HTLC (24h timeout)
├── T+1h:   Bob creates BTC HTLC (12h timeout)
├── T+10h:  Alice claims BTC (reveals swap_secret)
├── T+11h:  Bob MUST claim BSV before T+12h
│           (or Alice could double-spend with swap_secret)
├── T+12h:  Bob's BTC refund window opens (but already spent)
└── T+24h:  Alice's BSV refund window opens (but already spent)

The 12-hour differential ensures Alice always has time to claim
before Bob can refund, and Bob has time to claim after seeing
Alice's secret on-chain.
```

---

## 🌍 Supported Chains

### Currently Implemented

| Chain | Status | Notes |
|-------|--------|-------|
| BSV | ✅ Full Support | Native P2SH |
| BTC | ✅ Full Support | P2SH and P2WSH |

### Planned Support

| Chain | Status | Notes |
|-------|--------|-------|
| BCH | 🔄 In Progress | Similar to BTC |
| LTC | 📋 Planned | Native SegWit |
| DOGE | 📋 Planned | Legacy P2SH |
| Liquid | 📋 Planned | Confidential HTLCs |

### Adding New Chains

New chains require:
1. SHA256 opcode support (OP_SHA256)
2. Timelock support (OP_CHECKLOCKTIMEVERIFY or equivalent)
3. P2SH or equivalent script hashing
4. API for UTXO queries and broadcasting

---

## 🧪 Testing

### Run Unit Tests

```bash
npm test
```

### Run Integration Tests (Testnet)

```bash
npm run test:integration
```

### Manual Testing Flow

```bash
# Terminal 1: Start server
npm run dev

# Terminal 2: Create test swap
curl -X POST http://localhost:3000/api/swap/initiate \
  -H "Content-Type: application/json" \
  -d '{
    "fromChain": "BSV",
    "toChain": "BTC", 
    "fromAmount": "10000",
    "toAmount": "100",
    "toAddress": "tb1q...",
    "refundAddress": "mtest..."
  }'
```

---

## 🔗 Dependencies

```json
{
  "dependencies": {
    "express": "^4.18.2",
    "cors": "^2.8.5",
    "dotenv": "^16.3.1",
    "bsv": "^1.5.6",
    "bitcoinjs-lib": "^6.1.5",
    "axios": "^1.6.2",
    "crypto-js": "^4.2.0",
    "uuid": "^9.0.0"
  },
  "devDependencies": {
    "jest": "^29.7.0",
    "nodemon": "^3.0.2"
  }
}
```

---

## 📜 License

MIT License — Built for the quantum-resistant future.

---

## 🔗 Resources

### Documentation
- [Bitcoin Script Reference](https://en.bitcoin.it/wiki/Script)
- [BIP-199: Hash Time Locked Contracts](https://github.com/bitcoin/bips/blob/master/bip-0199.mediawiki)
- [Quantum Resistance Analysis](https://bitcoinops.org/en/topics/quantum-resistance/)

### APIs
- [WhatsOnChain (BSV)](https://whatsonchain.com)
- [Blockstream (BTC)](https://blockstream.info)
- [TAAL (BSV Broadcasting)](https://taal.com)

### Related Projects
- [Quantum Bitcoin Vault](https://github.com/agreatopportunity/Quantum-Bitcoin-Vault)
- [Submarine Swaps](https://github.com/submarineswaps)
- [Atomic Swap Reference](https://github.com/decred/atomicswap)

---

## 🤝 Contributing

1. Fork the repository
2. Create feature branch (`git checkout -b feature/amazing-feature`)
3. Commit changes (`git commit -m 'Add amazing feature'`)
4. Push to branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

---

## ⚡ Roadmap

- [x] Core HTLC implementation
- [x] BSV support
- [x] BTC support
- [ ] Web interface
- [ ] Mobile app
- [ ] BCH support
- [ ] Lightning Network integration
- [ ] Automated market maker (AMM) mode
- [ ] Decentralized orderbook
- [ ] Multi-hop swaps

---

## 💬 Support

- **Issues:** [GitHub Issues](https://github.com/yourusername/quantum-atomic-swaps/issues)
- **Discussions:** [GitHub Discussions](https://github.com/yourusername/quantum-atomic-swaps/discussions)
- **Twitter:** [@yourusername](https://twitter.com/yourusername)

---

## ⚠️ Disclaimer

This software is provided "as is" without warranty of any kind. Use at your own risk. Always test with small amounts first. The authors are not responsible for any loss of funds due to bugs, user error, or misuse of this software.

**This is experimental software dealing with real money. Be careful.**

---

<p align="center">
  <b>Swap trustlessly. Store quantum-safe. Sleep soundly.</b>
</p>

<p align="center">
  ⚛️🔄🔐
</p>
