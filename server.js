/**
 * Quantum Atomic Swaps v2.0 - API Server
 * 
 * Production server for quantum-safe cross-chain atomic swaps.
 * Supports: BSV ↔ BTC ↔ SOL (all combinations)
 * 
 * Security Features:
 * - Winternitz One-Time Signatures (quantum-resistant)
 * - BSV bare scripts (Genesis compliant)
 * - SHA256 hash-locks (no ECDSA)
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

// Import modules
const swap = require('./lib/swap');
const bsv = require('./lib/bsv');
const btc = require('./lib/btc');
const sol = require('./lib/sol');
const cryptoLib = require('./lib/crypto');
const htlc = require('./lib/htlc');
const db = require('./lib/db');

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize database
db.init();

// =============================================================================
// MIDDLEWARE
// =============================================================================

app.use(cors());
app.use(express.json({ limit: '10mb' }));  // Large payloads for Winternitz secrets
app.use(express.static(path.join(__dirname, 'public')));

// Request logging
app.use((req, res, next) => {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] ${req.method} ${req.path}`);
    next();
});

// =============================================================================
// SWAP LIFECYCLE ENDPOINTS
// =============================================================================

/**
 * POST /api/swap/initiate
 * Initiator (Alice) creates a new swap
 */
app.post('/api/swap/initiate', async (req, res) => {
    try {
        const { fromChain, toChain, fromAmount, toAmount, toAddress, refundAddress } = req.body;
        
        if (!fromChain || !toChain || !fromAmount || !toAmount || !toAddress || !refundAddress) {
            return res.status(400).json({
                success: false,
                error: 'Missing required fields: fromChain, toChain, fromAmount, toAmount, toAddress, refundAddress'
            });
        }
        
        const result = await swap.initiateSwap({
            fromChain,
            toChain,
            fromAmount,
            toAmount,
            toAddress,
            refundAddress
        });
        
        res.json(result);
    } catch (error) {
        res.status(400).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/swap/join
 * Responder (Bob) joins an existing swap
 */
app.post('/api/swap/join', async (req, res) => {
    try {
        const { swapId, toAddress, refundAddress } = req.body;
        
        if (!swapId || !toAddress || !refundAddress) {
            return res.status(400).json({
                success: false,
                error: 'Missing required fields: swapId, toAddress, refundAddress'
            });
        }
        
        const result = await swap.joinSwap({ swapId, toAddress, refundAddress });
        res.json(result);
    } catch (error) {
        res.status(400).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/swap/fund/initiator
 * Record initiator funding
 */
app.post('/api/swap/fund/initiator', async (req, res) => {
    try {
        const { swapId, txid } = req.body;
        
        if (!swapId) {
            return res.status(400).json({
                success: false,
                error: 'Missing required field: swapId'
            });
        }
        
        const result = await swap.recordInitiatorFunding({ swapId, txid });
        res.json(result);
    } catch (error) {
        res.status(400).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/swap/fund/responder
 * Record responder funding
 */
app.post('/api/swap/fund/responder', async (req, res) => {
    try {
        const { swapId, txid } = req.body;
        
        if (!swapId) {
            return res.status(400).json({
                success: false,
                error: 'Missing required field: swapId'
            });
        }
        
        const result = await swap.recordResponderFunding({ swapId, txid });
        res.json(result);
    } catch (error) {
        res.status(400).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/swap/claim/initiator
 * Initiator claims responder's funds
 */
app.post('/api/swap/claim/initiator', async (req, res) => {
    try {
        const { swapId, toAddress } = req.body;
        
        if (!swapId) {
            return res.status(400).json({
                success: false,
                error: 'Missing required field: swapId'
            });
        }
        
        const result = await swap.initiatorClaim({ swapId, toAddress });
        res.json(result);
    } catch (error) {
        res.status(400).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/swap/claim/responder
 * Responder claims initiator's funds
 */
app.post('/api/swap/claim/responder', async (req, res) => {
    try {
        const { swapId, swapSecret, toAddress } = req.body;
        
        if (!swapId || !swapSecret) {
            return res.status(400).json({
                success: false,
                error: 'Missing required fields: swapId, swapSecret'
            });
        }
        
        const result = await swap.responderClaim({ swapId, swapSecret, toAddress });
        res.json(result);
    } catch (error) {
        res.status(400).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/swap/refund/initiator
 * Initiator refunds after timeout
 */
app.post('/api/swap/refund/initiator', async (req, res) => {
    try {
        const { swapId, toAddress } = req.body;
        
        if (!swapId) {
            return res.status(400).json({
                success: false,
                error: 'Missing required field: swapId'
            });
        }
        
        const result = await swap.initiatorRefund({ swapId, toAddress });
        res.json(result);
    } catch (error) {
        res.status(400).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/swap/refund/responder
 * Responder refunds after timeout
 */
app.post('/api/swap/refund/responder', async (req, res) => {
    try {
        const { swapId, toAddress } = req.body;
        
        if (!swapId) {
            return res.status(400).json({
                success: false,
                error: 'Missing required field: swapId'
            });
        }
        
        const result = await swap.responderRefund({ swapId, toAddress });
        res.json(result);
    } catch (error) {
        res.status(400).json({ success: false, error: error.message });
    }
});

/**
 * GET /api/swap/status/:swapId
 * Get swap status
 */
app.get('/api/swap/status/:swapId', (req, res) => {
    try {
        const { swapId } = req.params;
        const includeSecrets = req.query.secrets === 'true';
        
        const result = swap.getSwapStatus(swapId, includeSecrets);
        res.json({ success: true, ...result });
    } catch (error) {
        res.status(404).json({ success: false, error: error.message });
    }
});

/**
 * GET /api/swap/list
 * List all swaps
 */
app.get('/api/swap/list', (req, res) => {
    try {
        const swaps = swap.listSwaps();
        res.json({ success: true, swaps, count: swaps.length });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /api/swap/stats
 * Get swap statistics
 */
app.get('/api/swap/stats', (req, res) => {
    try {
        const stats = db.getStats();
        res.json({ success: true, ...stats });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// =============================================================================
// CHAIN QUERY ENDPOINTS
// =============================================================================

/**
 * GET /api/balance/:chain/:address
 * Get address balance
 */
app.get('/api/balance/:chain/:address', async (req, res) => {
    try {
        const { chain, address } = req.params;
        
        let balance;
        switch (chain.toUpperCase()) {
            case 'BSV':
                balance = await bsv.getBalance(address);
                break;
            case 'BTC':
                balance = await btc.getBalance(address);
                break;
            case 'SOL':
                balance = await sol.getBalance(address);
                break;
            default:
                return res.status(400).json({ success: false, error: 'Invalid chain' });
        }
        
        res.json({ success: true, chain: chain.toUpperCase(), ...balance });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /api/balance/htlc/:chain/:scriptHash
 * Get HTLC balance (BSV bare scripts)
 */
app.get('/api/balance/htlc/:chain/:scriptHash', async (req, res) => {
    try {
        const { chain, scriptHash } = req.params;
        
        if (chain.toUpperCase() !== 'BSV') {
            return res.status(400).json({ 
                success: false, 
                error: 'Script hash lookup only supported on BSV. Use address lookup for BTC.' 
            });
        }
        
        const balance = await bsv.getHTLCBalance(scriptHash);
        res.json({ success: true, chain: 'BSV', ...balance });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /api/tx/:chain/:txid
 * Get transaction details
 */
app.get('/api/tx/:chain/:txid', async (req, res) => {
    try {
        const { chain, txid } = req.params;
        
        let tx;
        switch (chain.toUpperCase()) {
            case 'BSV':
                tx = await bsv.getTransaction(txid);
                break;
            case 'BTC':
                tx = await btc.getTransaction(txid);
                break;
            case 'SOL':
                tx = await sol.getTransaction(txid);
                break;
            default:
                return res.status(400).json({ success: false, error: 'Invalid chain' });
        }
        
        res.json({ success: true, chain: chain.toUpperCase(), ...tx });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /api/height/:chain
 * Get current block height
 */
app.get('/api/height/:chain', async (req, res) => {
    try {
        const { chain } = req.params;
        
        let height;
        switch (chain.toUpperCase()) {
            case 'BSV':
                height = await bsv.getBlockHeight();
                break;
            case 'BTC':
                height = await btc.getBlockHeight();
                break;
            case 'SOL':
                height = await sol.getCurrentSlot();
                break;
            default:
                return res.status(400).json({ success: false, error: 'Invalid chain' });
        }
        
        res.json({ success: true, chain: chain.toUpperCase(), height });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /api/fees/btc
 * Get BTC fee estimates
 */
app.get('/api/fees/btc', async (req, res) => {
    try {
        const fees = await btc.getFeeEstimates();
        res.json({ success: true, chain: 'BTC', ...fees });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// =============================================================================
// HTLC ENDPOINTS
// =============================================================================

/**
 * POST /api/htlc/create
 * Create an HTLC script
 */
app.post('/api/htlc/create', (req, res) => {
    try {
        const { swapHash, recipientHash, refundHash, timeout, chain, network } = req.body;
        
        if (!swapHash || !recipientHash || !refundHash || !timeout) {
            return res.status(400).json({
                success: false,
                error: 'Missing required fields: swapHash, recipientHash, refundHash, timeout'
            });
        }
        
        const htlcData = htlc.createHTLC(
            { swapHash, recipientHash, refundHash, timeout },
            chain || 'BSV',
            network || 'mainnet'
        );
        
        res.json({ success: true, ...htlcData });
    } catch (error) {
        res.status(400).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/htlc/parse
 * Parse an HTLC script
 */
app.post('/api/htlc/parse', (req, res) => {
    try {
        const { script } = req.body;
        
        if (!script) {
            return res.status(400).json({
                success: false,
                error: 'Missing required field: script'
            });
        }
        
        const parsed = htlc.parseHTLCScript(script);
        const asm = htlc.decodeScriptToASM(script);
        
        res.json({ success: true, ...parsed, asm });
    } catch (error) {
        res.status(400).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/htlc/verify
 * Verify a preimage against a hash
 */
app.post('/api/htlc/verify', (req, res) => {
    try {
        const { preimage, hash } = req.body;
        
        if (!preimage || !hash) {
            return res.status(400).json({
                success: false,
                error: 'Missing required fields: preimage, hash'
            });
        }
        
        const valid = cryptoLib.verifyPreimage(preimage, hash);
        const actualHash = cryptoLib.sha256Hex(preimage);
        
        res.json({ 
            success: true, 
            valid,
            preimageLength: preimage.length / 2,
            providedHash: hash,
            computedHash: actualHash
        });
    } catch (error) {
        res.status(400).json({ success: false, error: error.message });
    }
});

// =============================================================================
// CRYPTOGRAPHIC UTILITY ENDPOINTS
// =============================================================================

/**
 * GET /api/crypto/generate-secret
 * Generate quantum-safe secrets
 */
app.get('/api/crypto/generate-secret', (req, res) => {
    try {
        const type = req.query.type || 'initiator';
        
        let secrets;
        if (type === 'initiator') {
            secrets = cryptoLib.generateInitiatorSecrets();
        } else {
            secrets = cryptoLib.generateResponderSecrets();
        }
        
        res.json({
            success: true,
            type,
            quantumSafe: true,
            signatureType: 'Winternitz OTS (32×256)',
            keyEntropy: '1024 bytes',
            warning: 'SAVE THESE SECRETS SECURELY! Required for claiming/refunding.',
            secrets: {
                swap_secret: secrets.swap_secret,
                swap_hash: secrets.swap_hash,
                refund_secret: secrets.refund_secret,
                refund_hash: secrets.refund_hash,
                ...(type === 'initiator' ? {
                    claim_secret: secrets.claim_secret,
                    claim_hash: secrets.claim_hash
                } : {
                    recipient_secret: secrets.recipient_secret,
                    recipient_hash: secrets.recipient_hash
                })
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/crypto/hash
 * Hash data with various algorithms
 */
app.post('/api/crypto/hash', (req, res) => {
    try {
        const { data, algorithm } = req.body;
        
        if (!data) {
            return res.status(400).json({
                success: false,
                error: 'Missing required field: data'
            });
        }
        
        let hash;
        switch (algorithm) {
            case 'sha256d':
            case 'hash256':
                hash = cryptoLib.hash256(data).toString('hex');
                break;
            case 'hash160':
                hash = cryptoLib.hash160(data).toString('hex');
                break;
            default:
                hash = cryptoLib.sha256Hex(data);
        }
        
        res.json({ 
            success: true, 
            input: data, 
            inputLength: data.length / 2,
            algorithm: algorithm || 'sha256', 
            hash,
            hashLength: hash.length / 2
        });
    } catch (error) {
        res.status(400).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/crypto/winternitz/keypair
 * Generate a Winternitz keypair
 */
app.post('/api/crypto/winternitz/keypair', (req, res) => {
    try {
        const keypair = cryptoLib.generateWinternitzKeypair();
        
        res.json({
            success: true,
            signatureType: 'Winternitz OTS',
            parameters: {
                chunks: cryptoLib.WOTS_CHUNKS,
                iterations: cryptoLib.WOTS_ITERATIONS,
                scalarSize: cryptoLib.SCALAR_SIZE
            },
            publicKeyHash: keypair.publicKeyHash,
            publicKeyPreimage: keypair.publicKeyPreimage,
            privateKey: keypair.privateKey.hex,
            warning: 'SAVE THE PRIVATE KEY SECURELY! One-time use only.'
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// =============================================================================
// ADDRESS VALIDATION
// =============================================================================

/**
 * GET /api/validate/:chain/:address
 * Validate an address for a specific chain
 */
app.get('/api/validate/:chain/:address', (req, res) => {
    try {
        const { chain, address } = req.params;
        
        let validation;
        switch (chain.toUpperCase()) {
            case 'BSV':
                validation = bsv.validateAddress(address);
                break;
            case 'BTC':
                validation = btc.validateAddress(address);
                break;
            case 'SOL':
                validation = sol.validateAddress(address);
                break;
            default:
                return res.status(400).json({ success: false, error: 'Invalid chain' });
        }
        
        res.json({ success: true, chain: chain.toUpperCase(), address, ...validation });
    } catch (error) {
        res.status(400).json({ success: false, error: error.message });
    }
});

// =============================================================================
// STATIC & DOCUMENTATION
// =============================================================================

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/api', (req, res) => {
    res.json({
        name: 'Quantum Atomic Swaps API',
        version: '2.0.0',
        description: 'Quantum-safe cross-chain atomic swaps using Winternitz One-Time Signatures',
        supportedChains: ['BSV', 'BTC', 'SOL'],
        features: {
            quantumSafe: true,
            bsvBareScripts: true,
            winternitzOTS: true
        },
        endpoints: {
            swap: {
                'POST /api/swap/initiate': 'Create new swap',
                'POST /api/swap/join': 'Join existing swap',
                'POST /api/swap/fund/initiator': 'Record initiator funding',
                'POST /api/swap/fund/responder': 'Record responder funding',
                'POST /api/swap/claim/initiator': 'Initiator claims',
                'POST /api/swap/claim/responder': 'Responder claims',
                'POST /api/swap/refund/initiator': 'Initiator refunds',
                'POST /api/swap/refund/responder': 'Responder refunds',
                'GET /api/swap/status/:swapId': 'Get swap status',
                'GET /api/swap/list': 'List all swaps',
                'GET /api/swap/stats': 'Get swap statistics'
            },
            chain: {
                'GET /api/balance/:chain/:address': 'Get address balance',
                'GET /api/balance/htlc/:chain/:scriptHash': 'Get HTLC balance (BSV)',
                'GET /api/tx/:chain/:txid': 'Get transaction',
                'GET /api/height/:chain': 'Get block height',
                'GET /api/fees/btc': 'Get BTC fee estimates',
                'GET /api/validate/:chain/:address': 'Validate address'
            },
            htlc: {
                'POST /api/htlc/create': 'Create HTLC script',
                'POST /api/htlc/parse': 'Parse HTLC script',
                'POST /api/htlc/verify': 'Verify preimage'
            },
            crypto: {
                'GET /api/crypto/generate-secret': 'Generate quantum-safe secret',
                'POST /api/crypto/hash': 'Hash data',
                'POST /api/crypto/winternitz/keypair': 'Generate Winternitz keypair'
            }
        }
    });
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({ success: false, error: 'Endpoint not found' });
});

// Error handler
app.use((err, req, res, next) => {
    console.error('Server error:', err);
    res.status(500).json({ success: false, error: 'Internal server error' });
});

// =============================================================================
// GRACEFUL SHUTDOWN
// =============================================================================

process.on('SIGTERM', () => {
    console.log('SIGTERM received. Closing database...');
    db.close();
    process.exit(0);
});

process.on('SIGINT', () => {
    console.log('SIGINT received. Closing database...');
    db.close();
    process.exit(0);
});

// =============================================================================
// START SERVER
// =============================================================================

app.listen(PORT, () => {
    console.log(`
╔════════════════════════════════════════════════════════════════════════╗
║           ⚛️  QUANTUM ATOMIC SWAPS v2.0  🔄                            ║
╠════════════════════════════════════════════════════════════════════════╣
║  Server running on http://localhost:${PORT}                               ║
║  API documentation: http://localhost:${PORT}/api                          ║
║                                                                        ║
║  ✓ Supported chains: BSV ↔ BTC ↔ SOL                                   ║
║  ✓ Security: Winternitz One-Time Signatures (Quantum-Safe)             ║
║  ✓ BSV: BARE SCRIPTS (Genesis compliant - no P2SH!)                    ║
║  ✓ BTC: P2SH (standard)                                                ║
║  ✓ SOL: Program accounts                                               ║
╠════════════════════════════════════════════════════════════════════════╣
║  ⚠️  CRITICAL: P2SH addresses (3xxx) do NOT work on BSV!               ║
║  BSV uses bare scripts - funds are looked up by script hash            ║
╚════════════════════════════════════════════════════════════════════════╝
    `);
});

module.exports = app;
