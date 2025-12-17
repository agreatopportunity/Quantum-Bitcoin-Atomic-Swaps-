/**
 * Quantum Atomic Swaps v2.0 - Swap Coordinator
 * 
 * Manages the lifecycle of quantum-safe atomic swaps across:
 * - BSV (Bitcoin SV) - BARE SCRIPTS (no P2SH)
 * - BTC (Bitcoin) - P2SH
 * - SOL (Solana) - Program accounts
 * 
 * Security Model:
 * - Winternitz One-Time Signatures for quantum resistance
 * - 1024-byte preimages (32 × 32-byte commitments)
 * - SHA256 hash-locks (quantum-safe)
 * - CHECKLOCKTIMEVERIFY for timeouts
 */

const { v4: uuidv4 } = require('uuid');
const cryptoLib = require('./crypto');
const htlc = require('./htlc');
const bsv = require('./bsv');
const btc = require('./btc');
const sol = require('./sol');

// =============================================================================
// STORAGE
// =============================================================================

// In-memory swap storage (use database in production)
const swaps = new Map();

// =============================================================================
// CONSTANTS
// =============================================================================

const SwapStatus = {
    INITIATED: 'initiated',
    COUNTERPARTY_JOINED: 'counterparty_joined',
    INITIATOR_FUNDED: 'initiator_funded',
    RESPONDER_FUNDED: 'responder_funded',
    FULLY_FUNDED: 'fully_funded',
    CLAIMING: 'claiming',
    COMPLETED: 'completed',
    REFUNDING: 'refunding',
    REFUNDED: 'refunded',
    EXPIRED: 'expired',
    FAILED: 'failed'
};

const SupportedChains = ['BSV', 'BTC', 'SOL'];

// Timeout configuration
const config = {
    initiatorTimeoutSeconds: parseInt(process.env.INITIATOR_TIMEOUT_SECONDS) || 86400,  // 24 hours
    responderTimeoutSeconds: parseInt(process.env.RESPONDER_TIMEOUT_SECONDS) || 43200,   // 12 hours
    minConfirmations: {
        BSV: 1,
        BTC: 1,
        SOL: 1  // Solana uses 'confirmed' status
    }
};

// =============================================================================
// CHAIN MODULE SELECTION
// =============================================================================

/**
 * Get the appropriate chain module
 * @param {string} chain - Chain identifier (BSV, BTC, SOL)
 * @returns {Object} Chain module
 */
function getChainModule(chain) {
    switch (chain.toUpperCase()) {
        case 'BSV': return bsv;
        case 'BTC': return btc;
        case 'SOL': return sol;
        default: throw new Error(`Unsupported chain: ${chain}`);
    }
}

// =============================================================================
// SWAP INITIATION (Alice)
// =============================================================================

/**
 * Initiate a new atomic swap (Initiator/Alice perspective)
 * 
 * Creates all necessary secrets and prepares HTLC details.
 * Supports any combination of BSV, BTC, SOL.
 * 
 * @param {Object} params - Swap parameters
 * @returns {Object} Swap details including secrets to save
 */
async function initiateSwap(params) {
    const {
        fromChain,      // Source chain: BSV, BTC, or SOL
        toChain,        // Destination chain: BSV, BTC, or SOL
        fromAmount,     // Amount in smallest unit (sats/lamports)
        toAmount,       // Amount to receive in smallest unit
        toAddress,      // Address to receive funds on toChain
        refundAddress   // Address to refund on fromChain
    } = params;
    
    // Validate chains
    if (!SupportedChains.includes(fromChain.toUpperCase())) {
        throw new Error(`Invalid fromChain. Supported: ${SupportedChains.join(', ')}`);
    }
    if (!SupportedChains.includes(toChain.toUpperCase())) {
        throw new Error(`Invalid toChain. Supported: ${SupportedChains.join(', ')}`);
    }
    if (fromChain.toUpperCase() === toChain.toUpperCase()) {
        throw new Error('fromChain and toChain must be different');
    }
    
    // Validate addresses
    const fromModule = getChainModule(fromChain);
    const toModule = getChainModule(toChain);
    
    const refundValidation = fromModule.validateAddress(refundAddress);
    if (!refundValidation.valid) {
        throw new Error(`Invalid refund address: ${refundValidation.error}`);
    }
    
    const toValidation = toModule.validateAddress(toAddress);
    if (!toValidation.valid) {
        throw new Error(`Invalid destination address: ${toValidation.error}`);
    }
    
    // Generate swap ID
    const swapId = 'qswap_' + uuidv4().replace(/-/g, '').substring(0, 16);
    
    // Generate quantum-safe secrets (Winternitz keypairs)
    const initiatorSecrets = cryptoLib.generateInitiatorSecrets();
    
    // Calculate timeouts
    const now = Math.floor(Date.now() / 1000);
    const initiatorTimeout = now + config.initiatorTimeoutSeconds;
    const responderTimeout = now + config.responderTimeoutSeconds;
    
    // Build swap object
    const swap = {
        swapId,
        status: SwapStatus.INITIATED,
        version: '2.0',
        quantumSafe: true,
        
        // Chain info
        fromChain: fromChain.toUpperCase(),
        toChain: toChain.toUpperCase(),
        fromAmount: parseInt(fromAmount),
        toAmount: parseInt(toAmount),
        toAddress,
        refundAddress,
        
        // Initiator secrets (Alice) - QUANTUM SAFE
        initiator: {
            swap_keypair: initiatorSecrets.swap.keypair,
            swap_secret: initiatorSecrets.swap_secret,  // 1024 bytes (hex)
            swap_hash: initiatorSecrets.swap_hash,      // 32 bytes (hex)
            refund_keypair: initiatorSecrets.refund.keypair,
            refund_secret: initiatorSecrets.refund_secret,
            refund_hash: initiatorSecrets.refund_hash,
            claim_keypair: initiatorSecrets.claim.keypair,
            claim_secret: initiatorSecrets.claim_secret,
            claim_hash: initiatorSecrets.claim_hash
        },
        
        // Initiator's HTLC (Alice deposits here, Bob claims)
        initiatorHTLC: {
            chain: fromChain.toUpperCase(),
            address: null,
            lockingScript: null,
            scriptHash: null,
            timeout: initiatorTimeout,
            funded: false,
            fundingTxid: null
        },
        
        // Responder's HTLC (Bob deposits here, Alice claims)
        responderHTLC: {
            chain: toChain.toUpperCase(),
            address: null,
            lockingScript: null,
            scriptHash: null,
            timeout: responderTimeout,
            funded: false,
            fundingTxid: null
        },
        
        // Responder secrets (filled when Bob joins)
        responder: {
            recipient_secret: null,
            recipient_hash: null,
            refund_secret: null,
            refund_hash: null,
            toAddress: null,
            refundAddress: null
        },
        
        // Transaction history
        transactions: [],
        
        // Timestamps
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
    };
    
    // Store swap
    swaps.set(swapId, swap);
    
    // Return public info
    return {
        success: true,
        swapId,
        status: swap.status,
        version: '2.0',
        quantumSafe: true,
        
        fromChain: swap.fromChain,
        toChain: swap.toChain,
        fromAmount: swap.fromAmount,
        toAmount: swap.toAmount,
        
        // Share swap_hash with counterparty (they need it for their HTLC)
        swap_hash: initiatorSecrets.swap_hash,
        
        // Timeouts
        initiatorTimeout,
        initiatorTimeoutDate: new Date(initiatorTimeout * 1000).toISOString(),
        responderTimeout,
        responderTimeoutDate: new Date(responderTimeout * 1000).toISOString(),
        
        // Instructions
        nextStep: 'Share swapId and swap_hash with counterparty. Wait for them to join.',
        
        // CRITICAL: Save these secrets!
        secretsToSave: {
            warning: 'SAVE THESE SECRETS SECURELY! Required to claim or refund funds.',
            swap_secret: initiatorSecrets.swap_secret,
            refund_secret: initiatorSecrets.refund_secret,
            claim_secret: initiatorSecrets.claim_secret
        }
    };
}

// =============================================================================
// SWAP JOINING (Bob)
// =============================================================================

/**
 * Responder joins an existing swap (Bob perspective)
 * 
 * Creates responder's secrets and builds both HTLCs with final parameters.
 * 
 * @param {Object} params - Join parameters
 * @returns {Object} Swap details including HTLCs
 */
async function joinSwap(params) {
    const {
        swapId,
        toAddress,      // Bob's address to receive funds
        refundAddress   // Bob's refund address
    } = params;
    
    // Get swap
    const swap = swaps.get(swapId);
    if (!swap) {
        throw new Error('Swap not found');
    }
    if (swap.status !== SwapStatus.INITIATED) {
        throw new Error(`Cannot join swap in status: ${swap.status}`);
    }
    
    // Validate addresses
    const fromModule = getChainModule(swap.fromChain);
    const toModule = getChainModule(swap.toChain);
    
    const toValidation = fromModule.validateAddress(toAddress);
    if (!toValidation.valid) {
        throw new Error(`Invalid toAddress: ${toValidation.error}`);
    }
    
    const refundValidation = toModule.validateAddress(refundAddress);
    if (!refundValidation.valid) {
        throw new Error(`Invalid refundAddress: ${refundValidation.error}`);
    }
    
    // Generate responder's quantum-safe secrets
    const responderSecrets = cryptoLib.generateResponderSecrets();
    
    // Store responder info
    swap.responder = {
        recipient_keypair: responderSecrets.recipient.keypair,
        recipient_secret: responderSecrets.recipient_secret,
        recipient_hash: responderSecrets.recipient_hash,
        refund_keypair: responderSecrets.refund.keypair,
        refund_secret: responderSecrets.refund_secret,
        refund_hash: responderSecrets.refund_hash,
        toAddress,
        refundAddress
    };
    
    // Now create the actual initiator HTLC with responder's recipient_hash
    const initiatorHTLCResult = htlc.createHTLC({
        swapHash: swap.initiator.swap_hash,
        recipientHash: responderSecrets.recipient_hash,
        refundHash: swap.initiator.refund_hash,
        timeout: swap.initiatorHTLC.timeout
    }, swap.fromChain, 'mainnet');
    
    if (swap.fromChain === 'BSV') {
        // BSV uses bare script
        swap.initiatorHTLC.lockingScript = initiatorHTLCResult.lockingScript;
        swap.initiatorHTLC.scriptHash = initiatorHTLCResult.scriptHash;
        swap.initiatorHTLC.address = null;  // No standard address for bare scripts
    } else if (swap.fromChain === 'BTC') {
        // BTC uses P2SH
        swap.initiatorHTLC.address = initiatorHTLCResult.address;
        swap.initiatorHTLC.lockingScript = initiatorHTLCResult.redeemScript;
        swap.initiatorHTLC.scriptHash = initiatorHTLCResult.redeemScriptHash;
    } else if (swap.fromChain === 'SOL') {
        // Solana uses program accounts
        const solHTLC = await sol.createHTLCInfo({
            swapHash: swap.initiator.swap_hash,
            recipientHash: responderSecrets.recipient_hash,
            refundHash: swap.initiator.refund_hash,
            initiator: swap.refundAddress,
            recipient: toAddress,
            lamports: swap.fromAmount,
            timeoutSeconds: swap.initiatorHTLC.timeout - Math.floor(Date.now() / 1000)
        });
        swap.initiatorHTLC.address = solHTLC.htlcAddress;
        swap.initiatorHTLC.htlcData = solHTLC.htlcData;
    }
    swap.initiatorHTLC.scriptASM = initiatorHTLCResult.scriptASM;
    
    // Create responder's HTLC on the other chain
    // Bob's HTLC: Alice can claim with swap_secret + claim_secret
    //             Bob can refund with bob_refund_secret after timeout
    const responderHTLCResult = htlc.createHTLC({
        swapHash: swap.initiator.swap_hash,
        recipientHash: swap.initiator.claim_hash,  // Alice uses her claim_secret
        refundHash: responderSecrets.refund_hash,
        timeout: swap.responderHTLC.timeout
    }, swap.toChain, 'mainnet');
    
    if (swap.toChain === 'BSV') {
        swap.responderHTLC.lockingScript = responderHTLCResult.lockingScript;
        swap.responderHTLC.scriptHash = responderHTLCResult.scriptHash;
        swap.responderHTLC.address = null;
    } else if (swap.toChain === 'BTC') {
        swap.responderHTLC.address = responderHTLCResult.address;
        swap.responderHTLC.lockingScript = responderHTLCResult.redeemScript;
        swap.responderHTLC.scriptHash = responderHTLCResult.redeemScriptHash;
    } else if (swap.toChain === 'SOL') {
        const solHTLC = await sol.createHTLCInfo({
            swapHash: swap.initiator.swap_hash,
            recipientHash: swap.initiator.claim_hash,
            refundHash: responderSecrets.refund_hash,
            initiator: refundAddress,
            recipient: swap.toAddress,
            lamports: swap.toAmount,
            timeoutSeconds: swap.responderHTLC.timeout - Math.floor(Date.now() / 1000)
        });
        swap.responderHTLC.address = solHTLC.htlcAddress;
        swap.responderHTLC.htlcData = solHTLC.htlcData;
    }
    swap.responderHTLC.scriptASM = responderHTLCResult.scriptASM;
    
    swap.status = SwapStatus.COUNTERPARTY_JOINED;
    swap.updatedAt = new Date().toISOString();
    
    return {
        success: true,
        swapId,
        status: swap.status,
        quantumSafe: true,
        
        // Initiator's HTLC (where initiator deposits)
        initiatorHTLC: {
            chain: swap.fromChain,
            address: swap.initiatorHTLC.address,
            lockingScript: swap.initiatorHTLC.lockingScript,
            scriptHash: swap.initiatorHTLC.scriptHash,
            amount: swap.fromAmount,
            timeout: swap.initiatorHTLC.timeout,
            timeoutDate: new Date(swap.initiatorHTLC.timeout * 1000).toISOString(),
            fundingNote: swap.fromChain === 'BSV' 
                ? 'BARE SCRIPT: Create raw transaction with lockingScript as output'
                : swap.fromChain === 'SOL'
                    ? 'Create Solana HTLC account and fund it'
                    : 'Send funds to P2SH address'
        },
        
        // Responder's HTLC (where responder deposits)
        responderHTLC: {
            chain: swap.toChain,
            address: swap.responderHTLC.address,
            lockingScript: swap.responderHTLC.lockingScript,
            scriptHash: swap.responderHTLC.scriptHash,
            amount: swap.toAmount,
            timeout: swap.responderHTLC.timeout,
            timeoutDate: new Date(swap.responderHTLC.timeout * 1000).toISOString(),
            fundingNote: swap.toChain === 'BSV'
                ? 'BARE SCRIPT: Create raw transaction with lockingScript as output'
                : swap.toChain === 'SOL'
                    ? 'Create Solana HTLC account and fund it'
                    : 'Send funds to P2SH address'
        },
        
        nextStep: 'Initiator should fund their HTLC first, then responder funds theirs.',
        
        // Responder's secrets to save
        secretsToSave: {
            warning: 'SAVE THESE SECRETS SECURELY! Required to claim or refund.',
            recipient_secret: responderSecrets.recipient_secret,
            refund_secret: responderSecrets.refund_secret
        }
    };
}

// =============================================================================
// FUNDING RECORDING
// =============================================================================

/**
 * Record that initiator has funded their HTLC
 * @param {Object} params - Funding parameters
 * @returns {Object} Updated swap status
 */
async function recordInitiatorFunding(params) {
    const { swapId, txid } = params;
    
    const swap = swaps.get(swapId);
    if (!swap) {
        throw new Error('Swap not found');
    }
    if (swap.status !== SwapStatus.COUNTERPARTY_JOINED && 
        swap.status !== SwapStatus.RESPONDER_FUNDED) {
        throw new Error(`Cannot record funding in status: ${swap.status}`);
    }
    
    // Verify funding on-chain
    const chainModule = getChainModule(swap.fromChain);
    
    let balance;
    if (swap.fromChain === 'BSV') {
        balance = await bsv.getHTLCBalance(swap.initiatorHTLC.scriptHash);
    } else if (swap.fromChain === 'BTC') {
        balance = await btc.getBalance(swap.initiatorHTLC.address);
    } else if (swap.fromChain === 'SOL') {
        balance = await sol.getBalance(swap.initiatorHTLC.address);
    }
    
    if (balance.satoshis < swap.fromAmount || balance.lamports < swap.fromAmount) {
        throw new Error(`Insufficient funding. Expected ${swap.fromAmount}, got ${balance.satoshis || balance.lamports}`);
    }
    
    swap.initiatorHTLC.funded = true;
    swap.initiatorHTLC.fundingTxid = txid;
    
    if (swap.responderHTLC.funded) {
        swap.status = SwapStatus.FULLY_FUNDED;
    } else {
        swap.status = SwapStatus.INITIATOR_FUNDED;
    }
    
    swap.updatedAt = new Date().toISOString();
    swap.transactions.push({
        type: 'initiator_funding',
        chain: swap.fromChain,
        txid,
        timestamp: new Date().toISOString()
    });
    
    return {
        success: true,
        swapId,
        status: swap.status,
        initiatorFunded: true,
        responderFunded: swap.responderHTLC.funded,
        nextStep: swap.responderHTLC.funded 
            ? 'Both HTLCs funded! Initiator can now claim.'
            : 'Waiting for responder to fund their HTLC.'
    };
}

/**
 * Record that responder has funded their HTLC
 * @param {Object} params - Funding parameters
 * @returns {Object} Updated swap status
 */
async function recordResponderFunding(params) {
    const { swapId, txid } = params;
    
    const swap = swaps.get(swapId);
    if (!swap) {
        throw new Error('Swap not found');
    }
    if (swap.status !== SwapStatus.COUNTERPARTY_JOINED &&
        swap.status !== SwapStatus.INITIATOR_FUNDED) {
        throw new Error(`Cannot record funding in status: ${swap.status}`);
    }
    
    // Verify funding
    let balance;
    if (swap.toChain === 'BSV') {
        balance = await bsv.getHTLCBalance(swap.responderHTLC.scriptHash);
    } else if (swap.toChain === 'BTC') {
        balance = await btc.getBalance(swap.responderHTLC.address);
    } else if (swap.toChain === 'SOL') {
        balance = await sol.getBalance(swap.responderHTLC.address);
    }
    
    if ((balance.satoshis || balance.lamports || 0) < swap.toAmount) {
        throw new Error(`Insufficient funding. Expected ${swap.toAmount}`);
    }
    
    swap.responderHTLC.funded = true;
    swap.responderHTLC.fundingTxid = txid;
    
    if (swap.initiatorHTLC.funded) {
        swap.status = SwapStatus.FULLY_FUNDED;
    } else {
        swap.status = SwapStatus.RESPONDER_FUNDED;
    }
    
    swap.updatedAt = new Date().toISOString();
    swap.transactions.push({
        type: 'responder_funding',
        chain: swap.toChain,
        txid,
        timestamp: new Date().toISOString()
    });
    
    return {
        success: true,
        swapId,
        status: swap.status,
        initiatorFunded: swap.initiatorHTLC.funded,
        responderFunded: true,
        nextStep: swap.initiatorHTLC.funded
            ? 'Both HTLCs funded! Initiator can now claim.'
            : 'Waiting for initiator to fund their HTLC.'
    };
}

// =============================================================================
// CLAIMING
// =============================================================================

/**
 * Initiator claims responder's funds (reveals swap_secret)
 * @param {Object} params - Claim parameters
 * @returns {Object} Claim transaction details
 */
async function initiatorClaim(params) {
    const { swapId, toAddress } = params;
    
    const swap = swaps.get(swapId);
    if (!swap) {
        throw new Error('Swap not found');
    }
    if (swap.status !== SwapStatus.FULLY_FUNDED) {
        throw new Error(`Cannot claim in status: ${swap.status}`);
    }
    
    swap.status = SwapStatus.CLAIMING;
    
    // Get responder's HTLC UTXOs
    let utxos;
    if (swap.toChain === 'BSV') {
        const balance = await bsv.getHTLCBalance(swap.responderHTLC.scriptHash);
        utxos = balance.utxos;
    } else if (swap.toChain === 'BTC') {
        const balance = await btc.getBalance(swap.responderHTLC.address);
        utxos = balance.utxos;
    }
    
    if (!utxos || utxos.length === 0) {
        throw new Error('No funds to claim in responder HTLC');
    }
    
    const utxo = utxos[0];
    const destination = toAddress || swap.toAddress;
    
    // Build claim transaction
    const chainModule = getChainModule(swap.toChain);
    
    const claimTx = chainModule.buildClaimTransaction({
        utxo: { txid: utxo.txid, vout: utxo.vout, satoshis: utxo.satoshis },
        swapSecret: swap.initiator.swap_secret,
        recipientSecret: swap.initiator.claim_secret,
        lockingScript: swap.responderHTLC.lockingScript,
        redeemScript: swap.responderHTLC.lockingScript,
        toAddress: destination
    });
    
    // Broadcast
    const txid = await chainModule.broadcastTransaction(claimTx.txHex);
    
    swap.status = SwapStatus.COMPLETED;
    swap.updatedAt = new Date().toISOString();
    swap.transactions.push({
        type: 'initiator_claim',
        chain: swap.toChain,
        txid,
        swapSecretRevealed: true,
        timestamp: new Date().toISOString()
    });
    
    return {
        success: true,
        swapId,
        status: swap.status,
        txid,
        chain: swap.toChain,
        explorerLink: getExplorerLink(swap.toChain, txid),
        message: 'Initiator claimed! Swap secret is now on-chain.',
        nextStep: 'Responder can now extract swap_secret from this tx and claim initiator HTLC.',
        revealedSecret: swap.initiator.swap_secret
    };
}

/**
 * Responder claims initiator's funds (using revealed swap_secret)
 * @param {Object} params - Claim parameters
 * @returns {Object} Claim transaction details
 */
async function responderClaim(params) {
    const { swapId, swapSecret, toAddress } = params;
    
    const swap = swaps.get(swapId);
    if (!swap) {
        throw new Error('Swap not found');
    }
    
    // Verify swap_secret
    if (cryptoLib.sha256Hex(swapSecret) !== swap.initiator.swap_hash) {
        throw new Error('Invalid swap secret');
    }
    
    // Get initiator's HTLC UTXOs
    let utxos;
    if (swap.fromChain === 'BSV') {
        const balance = await bsv.getHTLCBalance(swap.initiatorHTLC.scriptHash);
        utxos = balance.utxos;
    } else if (swap.fromChain === 'BTC') {
        const balance = await btc.getBalance(swap.initiatorHTLC.address);
        utxos = balance.utxos;
    }
    
    if (!utxos || utxos.length === 0) {
        throw new Error('No funds to claim in initiator HTLC');
    }
    
    const utxo = utxos[0];
    const destination = toAddress || swap.responder.toAddress;
    
    const chainModule = getChainModule(swap.fromChain);
    
    const claimTx = chainModule.buildClaimTransaction({
        utxo: { txid: utxo.txid, vout: utxo.vout, satoshis: utxo.satoshis },
        swapSecret: swapSecret,
        recipientSecret: swap.responder.recipient_secret,
        lockingScript: swap.initiatorHTLC.lockingScript,
        redeemScript: swap.initiatorHTLC.lockingScript,
        toAddress: destination
    });
    
    const txid = await chainModule.broadcastTransaction(claimTx.txHex);
    
    swap.status = SwapStatus.COMPLETED;
    swap.updatedAt = new Date().toISOString();
    swap.transactions.push({
        type: 'responder_claim',
        chain: swap.fromChain,
        txid,
        timestamp: new Date().toISOString()
    });
    
    return {
        success: true,
        swapId,
        status: swap.status,
        txid,
        chain: swap.fromChain,
        explorerLink: getExplorerLink(swap.fromChain, txid),
        message: 'Swap completed successfully!'
    };
}

// =============================================================================
// REFUNDS
// =============================================================================

/**
 * Initiator refunds their funds (after timeout)
 * @param {Object} params - Refund parameters
 * @returns {Object} Refund transaction details
 */
async function initiatorRefund(params) {
    const { swapId, toAddress } = params;
    
    const swap = swaps.get(swapId);
    if (!swap) {
        throw new Error('Swap not found');
    }
    
    // Check timeout
    const now = Math.floor(Date.now() / 1000);
    if (now < swap.initiatorHTLC.timeout) {
        const remaining = swap.initiatorHTLC.timeout - now;
        throw new Error(`Timeout not reached. ${remaining} seconds remaining.`);
    }
    
    // Get UTXOs
    let utxos;
    if (swap.fromChain === 'BSV') {
        const balance = await bsv.getHTLCBalance(swap.initiatorHTLC.scriptHash);
        utxos = balance.utxos;
    } else if (swap.fromChain === 'BTC') {
        const balance = await btc.getBalance(swap.initiatorHTLC.address);
        utxos = balance.utxos;
    }
    
    if (!utxos || utxos.length === 0) {
        throw new Error('No funds to refund');
    }
    
    const utxo = utxos[0];
    const destination = toAddress || swap.refundAddress;
    
    const chainModule = getChainModule(swap.fromChain);
    
    const refundTx = chainModule.buildRefundTransaction({
        utxo: { txid: utxo.txid, vout: utxo.vout, satoshis: utxo.satoshis },
        refundSecret: swap.initiator.refund_secret,
        lockingScript: swap.initiatorHTLC.lockingScript,
        redeemScript: swap.initiatorHTLC.lockingScript,
        toAddress: destination
    });
    
    const txid = await chainModule.broadcastTransaction(refundTx.txHex);
    
    swap.status = SwapStatus.REFUNDED;
    swap.updatedAt = new Date().toISOString();
    swap.transactions.push({
        type: 'initiator_refund',
        chain: swap.fromChain,
        txid,
        timestamp: new Date().toISOString()
    });
    
    return {
        success: true,
        swapId,
        status: swap.status,
        txid,
        chain: swap.fromChain,
        explorerLink: getExplorerLink(swap.fromChain, txid),
        message: 'Funds refunded successfully'
    };
}

/**
 * Responder refunds their funds (after timeout)
 * @param {Object} params - Refund parameters
 * @returns {Object} Refund transaction details
 */
async function responderRefund(params) {
    const { swapId, toAddress } = params;
    
    const swap = swaps.get(swapId);
    if (!swap) {
        throw new Error('Swap not found');
    }
    
    const now = Math.floor(Date.now() / 1000);
    if (now < swap.responderHTLC.timeout) {
        const remaining = swap.responderHTLC.timeout - now;
        throw new Error(`Timeout not reached. ${remaining} seconds remaining.`);
    }
    
    let utxos;
    if (swap.toChain === 'BSV') {
        const balance = await bsv.getHTLCBalance(swap.responderHTLC.scriptHash);
        utxos = balance.utxos;
    } else if (swap.toChain === 'BTC') {
        const balance = await btc.getBalance(swap.responderHTLC.address);
        utxos = balance.utxos;
    }
    
    if (!utxos || utxos.length === 0) {
        throw new Error('No funds to refund');
    }
    
    const utxo = utxos[0];
    const destination = toAddress || swap.responder.refundAddress;
    
    const chainModule = getChainModule(swap.toChain);
    
    const refundTx = chainModule.buildRefundTransaction({
        utxo: { txid: utxo.txid, vout: utxo.vout, satoshis: utxo.satoshis },
        refundSecret: swap.responder.refund_secret,
        lockingScript: swap.responderHTLC.lockingScript,
        redeemScript: swap.responderHTLC.lockingScript,
        toAddress: destination
    });
    
    const txid = await chainModule.broadcastTransaction(refundTx.txHex);
    
    swap.status = SwapStatus.REFUNDED;
    swap.updatedAt = new Date().toISOString();
    swap.transactions.push({
        type: 'responder_refund',
        chain: swap.toChain,
        txid,
        timestamp: new Date().toISOString()
    });
    
    return {
        success: true,
        swapId,
        status: swap.status,
        txid,
        chain: swap.toChain,
        explorerLink: getExplorerLink(swap.toChain, txid),
        message: 'Funds refunded successfully'
    };
}

// =============================================================================
// STATUS AND UTILITIES
// =============================================================================

/**
 * Get swap status and details
 * @param {string} swapId - Swap ID
 * @param {boolean} includeSecrets - Include secrets in response
 * @returns {Object} Swap details
 */
function getSwapStatus(swapId, includeSecrets = false) {
    const swap = swaps.get(swapId);
    if (!swap) {
        throw new Error('Swap not found');
    }
    
    const now = Math.floor(Date.now() / 1000);
    
    const result = {
        swapId,
        status: swap.status,
        version: swap.version,
        quantumSafe: swap.quantumSafe,
        fromChain: swap.fromChain,
        toChain: swap.toChain,
        fromAmount: swap.fromAmount,
        toAmount: swap.toAmount,
        
        initiatorHTLC: swap.initiatorHTLC.lockingScript ? {
            chain: swap.fromChain,
            address: swap.initiatorHTLC.address,
            scriptHash: swap.initiatorHTLC.scriptHash,
            funded: swap.initiatorHTLC.funded,
            timeout: swap.initiatorHTLC.timeout,
            timeoutDate: new Date(swap.initiatorHTLC.timeout * 1000).toISOString(),
            timeoutRemaining: Math.max(0, swap.initiatorHTLC.timeout - now),
            expired: now >= swap.initiatorHTLC.timeout
        } : null,
        
        responderHTLC: swap.responderHTLC.lockingScript ? {
            chain: swap.toChain,
            address: swap.responderHTLC.address,
            scriptHash: swap.responderHTLC.scriptHash,
            funded: swap.responderHTLC.funded,
            timeout: swap.responderHTLC.timeout,
            timeoutDate: new Date(swap.responderHTLC.timeout * 1000).toISOString(),
            timeoutRemaining: Math.max(0, swap.responderHTLC.timeout - now),
            expired: now >= swap.responderHTLC.timeout
        } : null,
        
        transactions: swap.transactions,
        createdAt: swap.createdAt,
        updatedAt: swap.updatedAt
    };
    
    if (includeSecrets) {
        result.initiatorSecrets = {
            swap_hash: swap.initiator.swap_hash,
            swap_secret: swap.initiator.swap_secret,
            refund_secret: swap.initiator.refund_secret,
            claim_secret: swap.initiator.claim_secret
        };
        result.responderSecrets = swap.responder.recipient_secret ? {
            recipient_hash: swap.responder.recipient_hash,
            recipient_secret: swap.responder.recipient_secret,
            refund_secret: swap.responder.refund_secret
        } : null;
        result.initiatorLockingScript = swap.initiatorHTLC.lockingScript;
        result.responderLockingScript = swap.responderHTLC.lockingScript;
    }
    
    return result;
}

/**
 * List all swaps
 * @returns {Array} All swaps (summary)
 */
function listSwaps() {
    return Array.from(swaps.values()).map(swap => ({
        swapId: swap.swapId,
        status: swap.status,
        fromChain: swap.fromChain,
        toChain: swap.toChain,
        fromAmount: swap.fromAmount,
        toAmount: swap.toAmount,
        createdAt: swap.createdAt
    }));
}

/**
 * Get explorer link for transaction
 * @param {string} chain - Chain identifier
 * @param {string} txid - Transaction ID
 * @returns {string} Explorer URL
 */
function getExplorerLink(chain, txid) {
    switch (chain.toUpperCase()) {
        case 'BSV':
            return `https://whatsonchain.com/tx/${txid}`;
        case 'BTC':
            return `https://blockstream.info/tx/${txid}`;
        case 'SOL':
            return `https://explorer.solana.com/tx/${txid}`;
        default:
            return null;
    }
}

// =============================================================================
// EXPORTS
// =============================================================================

module.exports = {
    SwapStatus,
    SupportedChains,
    
    // Lifecycle
    initiateSwap,
    joinSwap,
    recordInitiatorFunding,
    recordResponderFunding,
    initiatorClaim,
    responderClaim,
    initiatorRefund,
    responderRefund,
    
    // Status
    getSwapStatus,
    listSwaps,
    getExplorerLink
};
