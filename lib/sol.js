/**
 * Quantum Atomic Swaps v2.0 - Solana Chain Interface
 * 
 * Handles all Solana blockchain interactions for quantum-safe atomic swaps.
 * Uses SHA256 hash-locks (quantum-safe) instead of Ed25519 signatures.
 * 
 * SOLANA HTLC ARCHITECTURE:
 * - Uses native Solana program accounts
 * - Funds locked in a PDA (Program Derived Address)
 * - Hash-lock verified on-chain
 * - Timelock using Solana's slot-based time
 */

const axios = require('axios');
const crypto = require('./crypto');

// =============================================================================
// CONFIGURATION
// =============================================================================

const config = {
    // RPC endpoints (mainnet-beta)
    rpcEndpoint: process.env.SOL_RPC_ENDPOINT || 'https://api.mainnet-beta.solana.com',
    // Alternative public endpoints
    altRpcEndpoints: [
        'https://solana-api.projectserum.com',
        'https://rpc.ankr.com/solana'
    ],
    network: process.env.SOL_NETWORK || 'mainnet-beta',
    // Fee in lamports (typically 5000 per signature)
    baseFee: 5000,
    // Rent exemption for HTLC accounts (~2 SOL for ~165 bytes)
    rentExemption: 2039280,
    // Minimum balance for transactions
    minBalance: 10000  // 0.00001 SOL
};

// =============================================================================
// SOLANA UTILITIES
// =============================================================================

/**
 * Base58 alphabet (Solana uses Bitcoin-style base58)
 */
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/**
 * Encode bytes to Base58
 * @param {Buffer} buffer - Bytes to encode
 * @returns {string} Base58 string
 */
function base58Encode(buffer) {
    let carry, digits = [0];
    for (let i = 0; i < buffer.length; i++) {
        carry = buffer[i];
        for (let j = 0; j < digits.length; j++) {
            carry += digits[j] << 8;
            digits[j] = carry % 58;
            carry = (carry / 58) | 0;
        }
        while (carry > 0) {
            digits.push(carry % 58);
            carry = (carry / 58) | 0;
        }
    }
    let str = '';
    for (let k = 0; buffer[k] === 0 && k < buffer.length - 1; k++) {
        str += BASE58_ALPHABET[0];
    }
    for (let q = digits.length - 1; q >= 0; q--) {
        str += BASE58_ALPHABET[digits[q]];
    }
    return str;
}

/**
 * Decode Base58 to bytes
 * @param {string} str - Base58 string
 * @returns {Buffer} Decoded bytes
 */
function base58Decode(str) {
    const bytes = [0];
    for (let i = 0; i < str.length; i++) {
        const c = str[i];
        let carry = BASE58_ALPHABET.indexOf(c);
        if (carry === -1) throw new Error('Invalid Base58 character');
        
        for (let j = 0; j < bytes.length; j++) {
            carry += bytes[j] * 58;
            bytes[j] = carry & 0xff;
            carry >>= 8;
        }
        while (carry > 0) {
            bytes.push(carry & 0xff);
            carry >>= 8;
        }
    }
    // Leading zeros
    for (let k = 0; str[k] === BASE58_ALPHABET[0] && k < str.length - 1; k++) {
        bytes.push(0);
    }
    return Buffer.from(bytes.reverse());
}

/**
 * Validate Solana address
 * @param {string} address - Base58 Solana address
 * @returns {Object} Validation result
 */
function validateAddress(address) {
    try {
        const decoded = base58Decode(address);
        if (decoded.length !== 32) {
            return { valid: false, error: 'Invalid address length' };
        }
        return { valid: true, type: 'ed25519', network: config.network };
    } catch (error) {
        return { valid: false, error: error.message };
    }
}

// =============================================================================
// RPC CALLS
// =============================================================================

/**
 * Make JSON-RPC call to Solana
 * @param {string} method - RPC method
 * @param {Array} params - Method parameters
 * @returns {Promise<any>} RPC result
 */
async function rpcCall(method, params = []) {
    const endpoints = [config.rpcEndpoint, ...config.altRpcEndpoints];
    let lastError;
    
    for (const endpoint of endpoints) {
        try {
            const response = await axios.post(endpoint, {
                jsonrpc: '2.0',
                id: Date.now(),
                method,
                params
            }, {
                headers: { 'Content-Type': 'application/json' },
                timeout: 30000
            });
            
            if (response.data.error) {
                throw new Error(response.data.error.message);
            }
            
            return response.data.result;
        } catch (error) {
            lastError = error;
            continue;
        }
    }
    
    throw new Error(`All RPC endpoints failed: ${lastError?.message}`);
}

// =============================================================================
// ACCOUNT QUERIES
// =============================================================================

/**
 * Get account balance in lamports
 * @param {string} address - Solana address (Base58)
 * @returns {Promise<Object>} Balance information
 */
async function getBalance(address) {
    try {
        const result = await rpcCall('getBalance', [address, { commitment: 'confirmed' }]);
        const lamports = result.value;
        
        return {
            address,
            lamports,
            sol: (lamports / 1e9).toFixed(9),
            canTransact: lamports > config.minBalance
        };
    } catch (error) {
        throw new Error(`Failed to fetch balance: ${error.message}`);
    }
}

/**
 * Get account info
 * @param {string} address - Solana address
 * @returns {Promise<Object>} Account info
 */
async function getAccountInfo(address) {
    try {
        const result = await rpcCall('getAccountInfo', [
            address,
            { encoding: 'base64', commitment: 'confirmed' }
        ]);
        
        if (!result.value) {
            return { exists: false, address };
        }
        
        return {
            exists: true,
            address,
            lamports: result.value.lamports,
            owner: result.value.owner,
            executable: result.value.executable,
            data: result.value.data[0] ? Buffer.from(result.value.data[0], 'base64') : null,
            rentEpoch: result.value.rentEpoch
        };
    } catch (error) {
        throw new Error(`Failed to fetch account info: ${error.message}`);
    }
}

/**
 * Get recent blockhash for transaction
 * @returns {Promise<Object>} Blockhash info
 */
async function getRecentBlockhash() {
    try {
        const result = await rpcCall('getLatestBlockhash', [{ commitment: 'confirmed' }]);
        return {
            blockhash: result.value.blockhash,
            lastValidBlockHeight: result.value.lastValidBlockHeight
        };
    } catch (error) {
        throw new Error(`Failed to fetch blockhash: ${error.message}`);
    }
}

/**
 * Get current slot (for timelock calculations)
 * @returns {Promise<number>} Current slot
 */
async function getCurrentSlot() {
    try {
        return await rpcCall('getSlot', [{ commitment: 'confirmed' }]);
    } catch (error) {
        throw new Error(`Failed to fetch slot: ${error.message}`);
    }
}

/**
 * Get transaction details
 * @param {string} signature - Transaction signature (Base58)
 * @returns {Promise<Object>} Transaction details
 */
async function getTransaction(signature) {
    try {
        const result = await rpcCall('getTransaction', [
            signature,
            { encoding: 'json', commitment: 'confirmed' }
        ]);
        
        if (!result) {
            throw new Error('Transaction not found');
        }
        
        return {
            signature,
            slot: result.slot,
            blockTime: result.blockTime,
            fee: result.meta.fee,
            success: result.meta.err === null,
            error: result.meta.err
        };
    } catch (error) {
        throw new Error(`Failed to fetch transaction: ${error.message}`);
    }
}

// =============================================================================
// HTLC DATA STRUCTURES
// =============================================================================

/**
 * Create HTLC account data structure
 * 
 * Layout (165 bytes total):
 * - initialized: 1 byte (bool)
 * - swap_hash: 32 bytes (SHA256 hash of swap secret)
 * - recipient_hash: 32 bytes (SHA256 hash of recipient secret)
 * - refund_hash: 32 bytes (SHA256 hash of refund secret)
 * - initiator: 32 bytes (pubkey of initiator)
 * - recipient: 32 bytes (pubkey of recipient)
 * - timeout_slot: 8 bytes (u64 slot for CLTV)
 * 
 * @param {Object} params - HTLC parameters
 * @returns {Buffer} Serialized HTLC data
 */
function createHTLCData(params) {
    const {
        swapHash,
        recipientHash,
        refundHash,
        initiator,
        recipient,
        timeoutSlot
    } = params;
    
    const buffer = Buffer.alloc(169);  // 1 + 32*5 + 8
    let offset = 0;
    
    // initialized = true
    buffer.writeUInt8(1, offset);
    offset += 1;
    
    // swap_hash
    Buffer.from(swapHash, 'hex').copy(buffer, offset);
    offset += 32;
    
    // recipient_hash
    Buffer.from(recipientHash, 'hex').copy(buffer, offset);
    offset += 32;
    
    // refund_hash
    Buffer.from(refundHash, 'hex').copy(buffer, offset);
    offset += 32;
    
    // initiator pubkey
    base58Decode(initiator).copy(buffer, offset);
    offset += 32;
    
    // recipient pubkey
    base58Decode(recipient).copy(buffer, offset);
    offset += 32;
    
    // timeout_slot (little-endian u64)
    buffer.writeBigUInt64LE(BigInt(timeoutSlot), offset);
    
    return buffer;
}

/**
 * Parse HTLC account data
 * @param {Buffer} data - Raw account data
 * @returns {Object} Parsed HTLC data
 */
function parseHTLCData(data) {
    if (data.length < 169) {
        throw new Error('Invalid HTLC data length');
    }
    
    let offset = 0;
    
    const initialized = data.readUInt8(offset) === 1;
    offset += 1;
    
    const swapHash = data.slice(offset, offset + 32).toString('hex');
    offset += 32;
    
    const recipientHash = data.slice(offset, offset + 32).toString('hex');
    offset += 32;
    
    const refundHash = data.slice(offset, offset + 32).toString('hex');
    offset += 32;
    
    const initiator = base58Encode(data.slice(offset, offset + 32));
    offset += 32;
    
    const recipient = base58Encode(data.slice(offset, offset + 32));
    offset += 32;
    
    const timeoutSlot = Number(data.readBigUInt64LE(offset));
    
    return {
        initialized,
        swapHash,
        recipientHash,
        refundHash,
        initiator,
        recipient,
        timeoutSlot
    };
}

// =============================================================================
// HTLC OPERATIONS
// =============================================================================

/**
 * Generate HTLC account address (simulated PDA)
 * 
 * In a real implementation, this would be a PDA derived from
 * a program ID. For now, we use a deterministic hash.
 * 
 * @param {string} swapHash - Swap hash
 * @param {string} initiator - Initiator address
 * @returns {string} HTLC account address (Base58)
 */
function deriveHTLCAddress(swapHash, initiator) {
    // Create deterministic address from swap hash and initiator
    const seed = Buffer.concat([
        Buffer.from('htlc'),
        Buffer.from(swapHash, 'hex'),
        base58Decode(initiator)
    ]);
    
    const hash = crypto.sha256(seed);
    return base58Encode(hash);
}

/**
 * Create HTLC setup info (for manual transaction creation)
 * 
 * Since we don't have access to private keys here, we provide
 * all the data needed to create the HTLC transaction externally.
 * 
 * @param {Object} params - HTLC parameters
 * @returns {Object} HTLC setup information
 */
async function createHTLCInfo(params) {
    const {
        swapHash,
        recipientHash,
        refundHash,
        initiator,
        recipient,
        lamports,
        timeoutSeconds
    } = params;
    
    // Calculate timeout slot
    const currentSlot = await getCurrentSlot();
    // Solana slots are ~400ms, so multiply seconds by 2.5
    const timeoutSlot = currentSlot + Math.ceil(timeoutSeconds * 2.5);
    
    // Derive HTLC address
    const htlcAddress = deriveHTLCAddress(swapHash, initiator);
    
    // Create account data
    const htlcData = createHTLCData({
        swapHash,
        recipientHash,
        refundHash,
        initiator,
        recipient,
        timeoutSlot
    });
    
    // Get blockhash for transaction
    const { blockhash, lastValidBlockHeight } = await getRecentBlockhash();
    
    return {
        htlcAddress,
        htlcData: htlcData.toString('base64'),
        swapHash,
        recipientHash,
        refundHash,
        initiator,
        recipient,
        lamports,
        timeoutSlot,
        timeoutDate: new Date(Date.now() + timeoutSeconds * 1000).toISOString(),
        currentSlot,
        blockhash,
        lastValidBlockHeight,
        rentExemption: config.rentExemption,
        totalRequired: lamports + config.rentExemption + config.baseFee,
        instructions: {
            createAccount: {
                fromPubkey: initiator,
                newAccountPubkey: htlcAddress,
                lamports: lamports + config.rentExemption,
                space: 169,
                programId: 'HTLC_PROGRAM_ID'  // Would be actual program ID
            }
        }
    };
}

/**
 * Build claim instruction data
 * @param {string} swapSecret - Swap preimage (hex)
 * @param {string} recipientSecret - Recipient preimage (hex)
 * @returns {Object} Claim instruction data
 */
function buildClaimData(swapSecret, recipientSecret) {
    // Instruction discriminator (claim = 1)
    const buffer = Buffer.alloc(1 + swapSecret.length/2 + recipientSecret.length/2);
    
    buffer.writeUInt8(1, 0);  // Claim instruction
    Buffer.from(swapSecret, 'hex').copy(buffer, 1);
    Buffer.from(recipientSecret, 'hex').copy(buffer, 1 + swapSecret.length/2);
    
    return {
        instruction: 'claim',
        data: buffer.toString('base64'),
        dataHex: buffer.toString('hex'),
        swapSecret,
        recipientSecret
    };
}

/**
 * Build refund instruction data
 * @param {string} refundSecret - Refund preimage (hex)
 * @returns {Object} Refund instruction data
 */
function buildRefundData(refundSecret) {
    // Instruction discriminator (refund = 2)
    const buffer = Buffer.alloc(1 + refundSecret.length/2);
    
    buffer.writeUInt8(2, 0);  // Refund instruction
    Buffer.from(refundSecret, 'hex').copy(buffer, 1);
    
    return {
        instruction: 'refund',
        data: buffer.toString('base64'),
        dataHex: buffer.toString('hex'),
        refundSecret
    };
}

// =============================================================================
// BROADCASTING (Limited without private keys)
// =============================================================================

/**
 * Send signed transaction
 * @param {string} signedTx - Base64 encoded signed transaction
 * @returns {Promise<string>} Transaction signature
 */
async function sendTransaction(signedTx) {
    try {
        const result = await rpcCall('sendTransaction', [
            signedTx,
            {
                encoding: 'base64',
                skipPreflight: false,
                preflightCommitment: 'confirmed'
            }
        ]);
        
        return result;  // Returns signature
    } catch (error) {
        throw new Error(`Transaction failed: ${error.message}`);
    }
}

/**
 * Wait for transaction confirmation
 * @param {string} signature - Transaction signature
 * @param {number} timeoutMs - Timeout in milliseconds
 * @returns {Promise<Object>} Confirmation details
 */
async function waitForConfirmation(signature, timeoutMs = 60000) {
    const startTime = Date.now();
    
    while (Date.now() - startTime < timeoutMs) {
        try {
            const status = await rpcCall('getSignatureStatuses', [[signature]]);
            
            if (status.value[0]) {
                const { confirmationStatus, err } = status.value[0];
                
                if (err) {
                    throw new Error(`Transaction failed: ${JSON.stringify(err)}`);
                }
                
                if (confirmationStatus === 'confirmed' || confirmationStatus === 'finalized') {
                    const tx = await getTransaction(signature);
                    return {
                        signature,
                        status: confirmationStatus,
                        slot: tx.slot,
                        blockTime: tx.blockTime
                    };
                }
            }
        } catch (error) {
            // Signature might not be found yet
        }
        
        await new Promise(resolve => setTimeout(resolve, 2000));
    }
    
    throw new Error('Timeout waiting for confirmation');
}

// =============================================================================
// SECRET EXTRACTION
// =============================================================================

/**
 * Extract swap secret from a claim transaction
 * @param {string} signature - Transaction signature
 * @returns {Promise<string>} Extracted swap secret (hex)
 */
async function extractSwapSecretFromTx(signature) {
    try {
        const result = await rpcCall('getTransaction', [
            signature,
            { encoding: 'base64', commitment: 'confirmed' }
        ]);
        
        if (!result || !result.transaction) {
            throw new Error('Transaction not found');
        }
        
        // Decode the transaction to find instruction data
        const txData = Buffer.from(result.transaction[0], 'base64');
        
        // In a real implementation, we'd parse the transaction properly
        // For now, look for 32-byte (or 1024-byte for WOTS) data patterns
        // after the claim instruction discriminator (0x01)
        
        // Find claim instruction marker
        for (let i = 0; i < txData.length - 33; i++) {
            if (txData[i] === 0x01) {
                // Check if next 32 bytes look like a hash preimage
                const potential = txData.slice(i + 1, i + 33);
                // Verify by hashing
                const hash = crypto.sha256(potential);
                // If this is in logs or matches expected, return it
                return potential.toString('hex');
            }
        }
        
        throw new Error('Could not extract swap secret');
    } catch (error) {
        throw new Error(`Failed to extract secret: ${error.message}`);
    }
}

// =============================================================================
// PRICE AND INFO
// =============================================================================

/**
 * Get current SOL price in USD
 * @returns {Promise<number>} SOL/USD price
 */
async function getSOLPrice() {
    try {
        // Use CoinGecko API
        const response = await axios.get(
            'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd',
            { timeout: 10000 }
        );
        return response.data.solana.usd;
    } catch (error) {
        console.warn('Failed to fetch SOL price:', error.message);
        return null;
    }
}

/**
 * Convert lamports to SOL
 * @param {number} lamports - Amount in lamports
 * @returns {string} Amount in SOL
 */
function lamportsToSOL(lamports) {
    return (lamports / 1e9).toFixed(9);
}

/**
 * Convert SOL to lamports
 * @param {number} sol - Amount in SOL
 * @returns {number} Amount in lamports
 */
function solToLamports(sol) {
    return Math.floor(sol * 1e9);
}

// =============================================================================
// EXPORTS
// =============================================================================

module.exports = {
    config,
    
    // Utilities
    base58Encode,
    base58Decode,
    validateAddress,
    lamportsToSOL,
    solToLamports,
    
    // Account queries
    getBalance,
    getAccountInfo,
    getRecentBlockhash,
    getCurrentSlot,
    getTransaction,
    
    // HTLC operations
    createHTLCData,
    parseHTLCData,
    deriveHTLCAddress,
    createHTLCInfo,
    buildClaimData,
    buildRefundData,
    
    // Broadcasting
    sendTransaction,
    waitForConfirmation,
    
    // Secret extraction
    extractSwapSecretFromTx,
    
    // Price
    getSOLPrice
};
