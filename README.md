# ⚛️ Quantum Atomic Swaps v2.0

Cross-chain atomic swaps with **Winternitz One-Time Signatures** for quantum resistance.

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Version](https://img.shields.io/badge/version-2.0.0-green.svg)
![Security](https://img.shields.io/badge/security-quantum--safe-purple.svg)

## 🌟 Features

- **⚛️ Quantum-Safe Cryptography** - Winternitz OTS instead of ECDSA
- **🔗 Multi-Chain Support** - BSV ↔ BTC ↔ SOL (all combinations)
- **📜 BSV Genesis Compliant** - Bare scripts (no deprecated P2SH)
- **⏰ Timelock Protection** - CHECKLOCKTIMEVERIFY for safe refunds
- **🔐 Hash-Lock Security** - SHA256 with 1024-byte preimages

## 🚨 Important: BSV and P2SH

**P2SH addresses (starting with `3`) do NOT work on BSV mainnet!**

BSV deprecated P2SH in the Genesis upgrade (Feb 2020). This system uses **bare scripts** for BSV:
- Funds are locked directly in the HTLC script
- UTXOs are looked up by SHA256 hash of the locking script
- No P2SH wrapping needed

BTC still uses P2SH normally.

## 🏗️ Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                    Quantum Atomic Swaps v2.0                      │
├──────────────────────────────────────────────────────────────────┤
│  Frontend (public/)         │  REST API (server.js)              │
│  - index.html               │  - /api/swap/*                     │
│  - app.js                   │  - /api/balance/*                  │
│  - style.css                │  - /api/htlc/*                     │
├─────────────────────────────┴────────────────────────────────────┤
│                           Core Library (lib/)                     │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐         │
│  │ crypto.js│  │  htlc.js │  │  swap.js │  │   db.js  │         │
│  │ WOTS     │  │ Scripts  │  │ Lifecycle│  │ SQLite   │         │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘         │
├─────────────────────────────────────────────────────────────────┤
│                      Chain Interfaces (lib/)                     │
│  ┌──────────┐       ┌──────────┐       ┌──────────┐             │
│  │  bsv.js  │       │  btc.js  │       │  sol.js  │             │
│  │  WoC API │       │Blockstm  │       │ RPC API  │             │
│  │BareScript│       │   P2SH   │       │  PDA     │             │
│  └──────────┘       └──────────┘       └──────────┘             │
└──────────────────────────────────────────────────────────────────┘
```

## 🚀 Quick Start

### Installation

```bash
# Clone repository
git clone https://github.com/your-repo/quantum-atomic-swaps.git
cd quantum-atomic-swaps

# Install dependencies
npm install

# Configure environment
cp .env.example .env

# Start server
npm start
```

### Usage

Open `http://localhost:3000` in your browser for the web interface.

Or use the API directly:

```bash
# Create a swap (Alice initiates)
curl -X POST http://localhost:3000/api/swap/initiate \
  -H "Content-Type: application/json" \
  -d '{
    "fromChain": "BSV",
    "toChain": "BTC",
    "fromAmount": 100000,
    "toAmount": 100000,
    "toAddress": "bc1q...",
    "refundAddress": "1xxx..."
  }'

# Join a swap (Bob responds)
curl -X POST http://localhost:3000/api/swap/join \
  -H "Content-Type: application/json" \
  -d '{
    "swapId": "qswap_abc123...",
    "toAddress": "1xxx...",
    "refundAddress": "bc1q..."
  }'
```

## 🔐 Security Model

### Winternitz One-Time Signatures

Traditional ECDSA is vulnerable to quantum computers running Shor's algorithm. WOTS is **hash-based** and quantum-safe:

```
Private Key:  32 random scalars × 32 bytes = 1024 bytes entropy
Public Key:   HASH256^256(each scalar) = 32 commitments
Signature:    Reveal intermediate hash values based on message
```

**Why it's quantum-safe:**
- Based only on SHA256 collision resistance
- Quantum computers cannot efficiently reverse hash functions
- Grover's algorithm provides only quadratic speedup (not enough)

### HTLC Script Structure

```
IF
  // Claim path (recipient proves knowledge of both secrets)
  OP_SHA256 <swap_hash> OP_EQUALVERIFY
  OP_SHA256 <recipient_hash> OP_EQUAL
ELSE
  // Refund path (initiator can reclaim after timeout)
  <timeout> OP_CHECKLOCKTIMEVERIFY OP_DROP
  OP_SHA256 <refund_hash> OP_EQUAL
ENDIF
```

## 📡 API Reference

### Swap Lifecycle

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/swap/initiate` | POST | Create new swap |
| `/api/swap/join` | POST | Join existing swap |
| `/api/swap/fund/initiator` | POST | Record funding |
| `/api/swap/fund/responder` | POST | Record funding |
| `/api/swap/claim/initiator` | POST | Claim funds |
| `/api/swap/claim/responder` | POST | Claim funds |
| `/api/swap/refund/initiator` | POST | Refund after timeout |
| `/api/swap/refund/responder` | POST | Refund after timeout |
| `/api/swap/status/:swapId` | GET | Get status |
| `/api/swap/list` | GET | List all swaps |

### Chain Queries

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/balance/:chain/:address` | GET | Get balance |
| `/api/balance/htlc/:chain/:scriptHash` | GET | HTLC balance (BSV) |
| `/api/tx/:chain/:txid` | GET | Transaction details |
| `/api/height/:chain` | GET | Block height |
| `/api/fees/btc` | GET | BTC fee estimates |

### HTLC Operations

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/htlc/create` | POST | Create HTLC script |
| `/api/htlc/parse` | POST | Parse script |
| `/api/htlc/verify` | POST | Verify preimage |

## 📝 Swap Flow

```
Alice (BSV) wants to swap with Bob (BTC)

1. INITIATE
   Alice: POST /api/swap/initiate
   → Creates swap, generates Winternitz secrets
   → Shares swapId and swap_hash with Bob

2. JOIN
   Bob: POST /api/swap/join
   → Generates his own secrets
   → HTLCs are created for both chains

3. FUND (Alice first)
   Alice: Sends BSV to her HTLC (bare script)
   → Records funding: POST /api/swap/fund/initiator

4. FUND (Bob second)
   Bob: Sends BTC to his HTLC (P2SH address)
   → Records funding: POST /api/swap/fund/responder

5. CLAIM (Alice first, reveals swap_secret)
   Alice: POST /api/swap/claim/initiator
   → Claims Bob's BTC
   → swap_secret is now on-chain

6. CLAIM (Bob extracts secret)
   Bob: Sees swap_secret on BTC chain
   → POST /api/swap/claim/responder
   → Claims Alice's BSV

TIMEOUT SCENARIOS:
- If Bob never funds: Alice waits for timeout, then refunds
- If Alice never claims: Bob waits for timeout, then refunds
```

## 🛠️ Development

```bash
# Development mode with auto-reload
npm run dev

# Run tests
npm test

# Lint code
npm run lint
```

## 📊 Status Codes

| Status | Description |
|--------|-------------|
| `initiated` | Swap created, waiting for counterparty |
| `counterparty_joined` | Both parties ready |
| `initiator_funded` | Initiator has funded HTLC |
| `responder_funded` | Responder has funded HTLC |
| `fully_funded` | Both HTLCs funded, ready for claims |
| `claiming` | Claim in progress |
| `completed` | Swap successful |
| `refunding` | Refund in progress |
| `refunded` | Funds returned |
| `expired` | Timeout reached |
| `failed` | Error occurred |

## ⚠️ Limitations

1. **Solana Program Required** - SOL swaps need a deployed on-chain program (not included)
2. **External Signing** - Users must sign transactions with their own wallets
3. **One-Time Keys** - Winternitz keys must not be reused
4. **Large Transactions** - WOTS preimages are 1024 bytes (higher fees)

## 📜 License

MIT License - see [LICENSE](LICENSE)

## 🙏 Credits

Built with:
- Node.js + Express
- SQLite (better-sqlite3)
- WhatsOnChain API (BSV)
- Blockstream API (BTC)
- Solana JSON-RPC (SOL)

---

**⚠️ REMINDER: P2SH (3xxx) addresses do NOT work on BSV. This is by design (Genesis rules).**
