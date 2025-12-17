/**
 * Quantum Atomic Swaps v2.0 - BSV Chain Interface
 * 
 * Handles all BSV blockchain interactions with BARE SCRIPT support.
 * 
 * CRITICAL: BSV Genesis (Feb 2020) DEPRECATED P2SH
 * - Addresses starting with '3' DO NOT WORK on BSV mainnet
 * - This module uses BARE SCRIPTS instead
 * - UTXOs are looked up by script hash, not address
 */

const axios = require('axios');
const crypto = require('./crypto');
const htlc = require('./htlc');
const bs58check = require('bs58check');

// =============================================================================
// CONFIGURATION
// =============================================================================

const config = {
    apiBase: process.env.BSV_API_BASE || 'https://api.whatsonchain.com/v1/bsv/main',
    network: process.env.BSV_NETWORK || 'mainnet',
    feeRate: parseInt(process.env.BSV_FEE_RATE) || 1,  // sat/byte
    dustLimit: 546
};

// =============================================================================
// UTXO AND BALANCE QUERIES
// =============================================================================

/**
 * Get UTXOs for a P2PKH address
 * @param {string} address - BSV P2PKH address (starts with '1')
 * @returns {Promise<Array>} Array of UTXOs
 */
async function getUTXOs(address) {
    try {
        const response = await axios.get(`${config.apiBase}/address/${address}/unspent`);
        return response.data.map(utxo => ({
            txid: utxo.tx_hash,
            vout: utxo.tx_pos,
            satoshis: utxo.value,
            height: utxo.height
        }));
    } catch (error) {
        if (error.response && error.response.status === 404) {
            return [];
        }
        throw new Error(`Failed to fetch UTXOs: ${error.message}`);
    }
}

/**
 * Get UTXOs for a BARE SCRIPT by script hash
 * 
 * This is how we find funds locked in HTLC scripts on BSV.
 * WhatsOnChain allows lookup by SHA256 hash of the locking script.
 * 
 * @param {string} scriptHash - SHA256 hash of locking script (hex)
 * @returns {Promise<Array>} Array of UTXOs
 */
async function getUTXOsByScriptHash(scriptHash) {
    try {
        const response = await axios.get(`${config.apiBase}/script/${scriptHash}/unspent`);
        return response.data.map(utxo => ({
            txid: utxo.tx_hash,
            vout: utxo.tx_pos,
            satoshis: utxo.value,
            height: utxo.height
        }));
    } catch (error) {
        if (error.response && error.response.status === 404) {
            return [];
        }
        throw new Error(`Failed to fetch script UTXOs: ${error.message}`);
    }
}

/**
 * Get balance for a P2PKH address
 * @param {string} address - BSV address
 * @returns {Promise<Object>} Balance information
 */
async function getBalance(address) {
    try {
        const utxos = await getUTXOs(address);
        const satoshis = utxos.reduce((sum, utxo) => sum + utxo.satoshis, 0);
        
        return {
            address,
            satoshis,
            bsv: (satoshis / 100000000).toFixed(8),
            utxoCount: utxos.length,
            utxos
        };
    } catch (error) {
        throw new Error(`Failed to fetch balance: ${error.message}`);
    }
}

/**
 * Get balance for a bare script HTLC
 * @param {string} scriptHash - SHA256 hash of locking script
 * @returns {Promise<Object>} Balance information
 */
async function getHTLCBalance(scriptHash) {
    try {
        const utxos = await getUTXOsByScriptHash(scriptHash);
        const satoshis = utxos.reduce((sum, utxo) => sum + utxo.satoshis, 0);
        
        return {
            scriptHash,
            satoshis,
            bsv: (satoshis / 100000000).toFixed(8),
            utxoCount: utxos.length,
            utxos,
            canSweep: satoshis > config.dustLimit
        };
    } catch (error) {
        throw new Error(`Failed to fetch HTLC balance: ${error.message}`);
    }
}

// =============================================================================
// TRANSACTION QUERIES
// =============================================================================

/**
 * Get transaction details
 * @param {string} txid - Transaction ID
 * @returns {Promise<Object>} Transaction details
 */
async function getTransaction(txid) {
    try {
        const response = await axios.get(`${config.apiBase}/tx/${txid}`);
        return response.data;
    } catch (error) {
        throw new Error(`Failed to fetch transaction: ${error.message}`);
    }
}

/**
 * Get raw transaction hex
 * @param {string} txid - Transaction ID
 * @returns {Promise<string>} Raw transaction hex
 */
async function getRawTransaction(txid) {
    try {
        const response = await axios.get(`${config.apiBase}/tx/${txid}/hex`);
        return response.data;
    } catch (error) {
        throw new Error(`Failed to fetch raw transaction: ${error.message}`);
    }
}

/**
 * Get current block height
 * @returns {Promise<number>} Current block height
 */
async function getBlockHeight() {
    try {
        const response = await axios.get(`${config.apiBase}/chain/info`);
        return response.data.blocks;
    } catch (error) {
        throw new Error(`Failed to fetch block height: ${error.message}`);
    }
}

// =============================================================================
// TRANSACTION BUILDING
// =============================================================================

/**
 * Build a sweep transaction for HTLC funds (bare script)
 * 
 * @param {Object} params - Transaction parameters
 * @param {Object} params.utxo - { txid, vout, satoshis }
 * @param {string} params.lockingScript - The original locking script (hex)
 * @param {string} params.scriptSig - Unlocking script (hex)
 * @param {string} params.toAddress - Destination P2PKH address
 * @param {number} params.locktime - For CLTV refunds
 * @returns {Object} Transaction details
 */
function buildSweepTransaction(params) {
    const {
        utxo,
        lockingScript,
        scriptSig,
        toAddress,
        locktime = 0
    } = params;
    
    // Calculate fees based on transaction size
    const scriptSigBytes = scriptSig.length / 2;
    const baseSize = 10 + 32 + 4 + 4 + 8 + 25 + 4;  // Version + input overhead + output
    const totalSize = baseSize + scriptSigBytes + 5;  // +5 for varint overhead
    
    const fee = Math.ceil(totalSize * config.feeRate);
    const outputSatoshis = utxo.satoshis - fee;
    
    if (outputSatoshis <= config.dustLimit) {
        throw new Error(`Output would be dust after fees (${outputSatoshis} sats)`);
    }
    
    // Build raw transaction
    let tx = '';
    
    // Version (4 bytes LE)
    tx += '01000000';
    
    // Input count
    tx += '01';
    
    // Input:
    // - Previous txid (32 bytes reversed)
    tx += reverseHex(utxo.txid);
    // - Previous vout (4 bytes LE)
    tx += toLittleEndian32(utxo.vout);
    // - ScriptSig length + scriptSig
    tx += crypto.encodeVarInt(scriptSigBytes);
    tx += scriptSig;
    // - Sequence (4 bytes) - 0xfffffffe for CLTV compatibility
    tx += 'feffffff';
    
    // Output count
    tx += '01';
    
    // Output:
    // - Value (8 bytes LE)
    tx += toLittleEndian64(outputSatoshis);
    // - ScriptPubKey
    const scriptPubKey = addressToScriptPubKey(toAddress);
    tx += crypto.encodeVarInt(scriptPubKey.length / 2);
    tx += scriptPubKey;
    
    // Locktime (4 bytes LE)
    tx += toLittleEndian32(locktime);
    
    // Calculate txid
    const txid = crypto.hash256(Buffer.from(tx, 'hex')).reverse().toString('hex');
    
    return {
        txHex: tx,
        txid,
        fee,
        size: tx.length / 2,
        outputSatoshis,
        feeRate: config.feeRate
    };
}

/**
 * Build claim transaction for HTLC
 * @param {Object} params - Claim parameters
 * @returns {Object} Transaction details
 */
function buildClaimTransaction(params) {
    const {
        utxo,
        swapSecret,      // 1024 bytes hex for WOTS, 32 bytes for simple
        recipientSecret,
        lockingScript,
        toAddress
    } = params;
    
    // Parse and verify HTLC script
    const htlcDetails = htlc.parseHTLCScript(lockingScript);
    
    // Verify secrets hash correctly
    if (crypto.sha256Hex(swapSecret) !== htlcDetails.swapHash) {
        throw new Error('Swap secret does not match hash in script');
    }
    if (crypto.sha256Hex(recipientSecret) !== htlcDetails.recipientHash) {
        throw new Error('Recipient secret does not match hash in script');
    }
    
    // Build scriptSig for BSV bare script
    const scriptSig = htlc.createClaimScriptSig(
        swapSecret, 
        recipientSecret, 
        lockingScript, 
        'BSV'
    );
    
    return buildSweepTransaction({
        utxo,
        lockingScript,
        scriptSig,
        toAddress,
        locktime: 0
    });
}

/**
 * Build refund transaction for HTLC
 * @param {Object} params - Refund parameters
 * @returns {Object} Transaction details
 */
function buildRefundTransaction(params) {
    const {
        utxo,
        refundSecret,
        lockingScript,
        toAddress
    } = params;
    
    // Parse and verify HTLC script
    const htlcDetails = htlc.parseHTLCScript(lockingScript);
    
    // Verify refund secret
    if (crypto.sha256Hex(refundSecret) !== htlcDetails.refundHash) {
        throw new Error('Refund secret does not match hash in script');
    }
    
    // Check timeout has passed
    const now = Math.floor(Date.now() / 1000);
    if (now < htlcDetails.timeout) {
        const remaining = htlcDetails.timeout - now;
        throw new Error(`Timeout not reached. ${remaining} seconds remaining.`);
    }
    
    // Build scriptSig for BSV bare script
    const scriptSig = htlc.createRefundScriptSig(refundSecret, lockingScript, 'BSV');
    
    return buildSweepTransaction({
        utxo,
        lockingScript,
        scriptSig,
        toAddress,
        locktime: htlcDetails.timeout  // Must be >= script timeout
    });
}

// =============================================================================
// BROADCASTING
// =============================================================================

/**
 * Broadcast a raw transaction with fallback endpoints
 * @param {string} txHex - Raw transaction hex
 * @returns {Promise<string>} Transaction ID
 */
async function broadcastTransaction(txHex) {
    const errors = [];
    
    // Try TAAL first (if API key available)
    if (process.env.TAAL_API_KEY) {
        try {
            const response = await axios.post(
                'https://api.taal.com/api/v1/broadcast',
                { rawTx: txHex },
                { 
                    headers: { 
                        'Authorization': `Bearer ${process.env.TAAL_API_KEY}`,
                        'Content-Type': 'application/json'
                    },
                    timeout: 30000
                }
            );
            console.log('[BSV] Broadcast via TAAL successful');
            return response.data.txid;
        } catch (error) {
            errors.push(`TAAL: ${error.response?.data?.message || error.message}`);
        }
    }
    
    // Try GorillaPool
    try {
        const response = await axios.post(
            'https://mapi.gorillapool.io/mapi/tx',
            { rawtx: txHex },
            { 
                headers: { 'Content-Type': 'application/json' },
                timeout: 30000
            }
        );
        if (response.data?.payload) {
            const payload = JSON.parse(response.data.payload);
            if (payload.txid) {
                console.log('[BSV] Broadcast via GorillaPool successful');
                return payload.txid;
            }
        }
    } catch (error) {
        errors.push(`GorillaPool: ${error.response?.data?.message || error.message}`);
    }
    
    // Fallback to WhatsOnChain
    try {
        const response = await axios.post(
            `${config.apiBase}/tx/raw`,
            { txhex: txHex },
            { timeout: 30000 }
        );
        console.log('[BSV] Broadcast via WhatsOnChain successful');
        return response.data;
    } catch (error) {
        errors.push(`WoC: ${error.response?.data || error.message}`);
    }
    
    throw new Error(`All broadcast attempts failed:\n${errors.join('\n')}`);
}

// =============================================================================
// ADDRESS UTILITIES
// =============================================================================

/**
 * Convert P2PKH address to scriptPubKey
 * @param {string} address - BSV address (must start with '1')
 * @returns {string} Hex-encoded scriptPubKey
 */
function addressToScriptPubKey(address) {
    const decoded = bs58check.decode(address);
    const version = decoded[0];
    const hash = decoded.slice(1).toString('hex');
    
    if (version === 0x00) {
        // P2PKH mainnet (1...)
        return '76a914' + hash + '88ac';
    } else if (version === 0x6f) {
        // P2PKH testnet (m/n...)
        return '76a914' + hash + '88ac';
    } else if (version === 0x05) {
        // P2SH - NOT SUPPORTED ON BSV!
        throw new Error('P2SH addresses (starting with 3) are NOT supported on BSV post-Genesis');
    } else {
        throw new Error(`Unknown address version: 0x${version.toString(16)}`);
    }
}

/**
 * Validate BSV address
 * @param {string} address - Address to validate
 * @returns {Object} Validation result
 */
function validateAddress(address) {
    try {
        if (address.startsWith('3')) {
            return {
                valid: false,
                error: 'P2SH addresses (starting with 3) are NOT supported on BSV',
                type: 'p2sh',
                supported: false
            };
        }
        
        const decoded = bs58check.decode(address);
        const version = decoded[0];
        
        if (version === 0x00 && address.startsWith('1')) {
            return { valid: true, type: 'p2pkh', network: 'mainnet' };
        } else if (version === 0x6f) {
            return { valid: true, type: 'p2pkh', network: 'testnet' };
        }
        
        return { valid: false, error: 'Unknown address type' };
    } catch (error) {
        return { valid: false, error: error.message };
    }
}

/**
 * Create a funding output for bare script HTLC
 * Returns the data needed to create a funding transaction.
 * 
 * @param {string} lockingScript - HTLC locking script (hex)
 * @param {number} satoshis - Amount to fund
 * @returns {Object} Funding output data
 */
function createFundingOutput(lockingScript, satoshis) {
    const scriptLen = lockingScript.length / 2;
    
    return {
        satoshis,
        scriptPubKey: lockingScript,
        scriptPubKeyHex: lockingScript,
        scriptLen,
        note: 'Use this scriptPubKey in your raw transaction output',
        example: {
            value: toLittleEndian64(satoshis),
            scriptLen: crypto.encodeVarInt(scriptLen),
            script: lockingScript
        }
    };
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

function reverseHex(hex) {
    return Buffer.from(hex, 'hex').reverse().toString('hex');
}

function toLittleEndian32(num) {
    const buf = Buffer.alloc(4);
    buf.writeUInt32LE(num);
    return buf.toString('hex');
}

function toLittleEndian64(num) {
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64LE(BigInt(num));
    return buf.toString('hex');
}

// =============================================================================
// SECRET EXTRACTION
// =============================================================================

/**
 * Extract swap secret from a claim transaction
 * @param {string} txid - Transaction ID of the claim
 * @returns {Promise<string>} Extracted swap secret
 */
async function extractSwapSecretFromTx(txid) {
    const rawTx = await getRawTransaction(txid);
    
    // Parse the scriptSig from the first input
    let i = 8; // Skip version
    const inputCount = parseInt(rawTx.substring(i, i + 2), 16);
    i += 2;
    
    // Skip prev txid and vout
    i += 64 + 8;
    
    // Get scriptSig length (could be varint)
    let scriptSigLen;
    const firstByte = parseInt(rawTx.substring(i, i + 2), 16);
    if (firstByte < 0xfd) {
        scriptSigLen = firstByte;
        i += 2;
    } else if (firstByte === 0xfd) {
        scriptSigLen = Buffer.from(rawTx.substring(i + 2, i + 6), 'hex').readUInt16LE(0);
        i += 6;
    } else {
        throw new Error('Unexpected scriptSig length encoding');
    }
    
    const scriptSig = rawTx.substring(i, i + scriptSigLen * 2);
    
    // Parse first push (swap secret)
    // Could be PUSHDATA1 or PUSHDATA2 for large preimages
    const pushByte = parseInt(scriptSig.substring(0, 2), 16);
    
    if (pushByte === 0x4d) {
        // PUSHDATA2 - for 1024-byte Winternitz preimages
        const pushLen = Buffer.from(scriptSig.substring(2, 6), 'hex').readUInt16LE(0);
        return scriptSig.substring(6, 6 + pushLen * 2);
    } else if (pushByte === 0x4c) {
        // PUSHDATA1
        const pushLen = parseInt(scriptSig.substring(2, 4), 16);
        return scriptSig.substring(4, 4 + pushLen * 2);
    } else if (pushByte <= 75) {
        // Direct push (for simple 32-byte preimages)
        return scriptSig.substring(2, 2 + pushByte * 2);
    }
    
    throw new Error('Could not extract swap secret from transaction');
}

/**
 * Wait for transaction confirmation
 * @param {string} txid - Transaction ID
 * @param {number} minConfirmations - Minimum confirmations required
 * @param {number} timeoutMs - Timeout in milliseconds
 * @returns {Promise<Object>} Confirmation details
 */
async function waitForConfirmation(txid, minConfirmations = 1, timeoutMs = 600000) {
    const startTime = Date.now();
    
    while (Date.now() - startTime < timeoutMs) {
        try {
            const tx = await getTransaction(txid);
            const confirmations = tx.confirmations || 0;
            
            if (confirmations >= minConfirmations) {
                return {
                    txid,
                    confirmations,
                    blockHash: tx.blockhash,
                    blockHeight: tx.blockheight
                };
            }
        } catch (error) {
            // Transaction might not be found yet
        }
        
        await new Promise(resolve => setTimeout(resolve, 10000));
    }
    
    throw new Error(`Timeout waiting for ${minConfirmations} confirmations`);
}

// =============================================================================
// EXPORTS
// =============================================================================

module.exports = {
    config,
    
    // UTXO queries
    getUTXOs,
    getUTXOsByScriptHash,
    getBalance,
    getHTLCBalance,
    
    // Transaction queries
    getTransaction,
    getRawTransaction,
    getBlockHeight,
    
    // Transaction building
    buildSweepTransaction,
    buildClaimTransaction,
    buildRefundTransaction,
    createFundingOutput,
    
    // Broadcasting
    broadcastTransaction,
    
    // Address utilities
    addressToScriptPubKey,
    validateAddress,
    
    // Secret extraction
    extractSwapSecretFromTx,
    waitForConfirmation
};
