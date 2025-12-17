/**
 * Quantum Atomic Swaps v2.0 - BTC Chain Interface
 * 
 * Handles all BTC blockchain interactions using Blockstream API.
 * BTC still uses P2SH normally for HTLCs.
 */

const axios = require('axios');
const crypto = require('./crypto');
const htlc = require('./htlc');
const bs58check = require('bs58check');

// =============================================================================
// CONFIGURATION
// =============================================================================

const config = {
    apiBase: process.env.BTC_API_BASE || 'https://blockstream.info/api',
    network: process.env.BTC_NETWORK || 'mainnet',
    feeRate: parseInt(process.env.BTC_FEE_RATE) || 10,  // sat/vB
    dustLimit: 546
};

// =============================================================================
// UTXO AND BALANCE QUERIES
// =============================================================================

/**
 * Get UTXOs for an address
 * @param {string} address - BTC address
 * @returns {Promise<Array>} Array of UTXOs
 */
async function getUTXOs(address) {
    try {
        const response = await axios.get(`${config.apiBase}/address/${address}/utxo`);
        return response.data.map(utxo => ({
            txid: utxo.txid,
            vout: utxo.vout,
            satoshis: utxo.value,
            confirmed: utxo.status.confirmed,
            blockHeight: utxo.status.block_height
        }));
    } catch (error) {
        if (error.response && error.response.status === 404) {
            return [];
        }
        throw new Error(`Failed to fetch UTXOs: ${error.message}`);
    }
}

/**
 * Get balance for an address
 * @param {string} address - BTC address
 * @returns {Promise<Object>} Balance information
 */
async function getBalance(address) {
    try {
        const utxos = await getUTXOs(address);
        const satoshis = utxos.reduce((sum, utxo) => sum + utxo.satoshis, 0);
        const confirmed = utxos.filter(u => u.confirmed).reduce((sum, u) => sum + u.satoshis, 0);
        
        return {
            address,
            satoshis,
            confirmed,
            btc: (satoshis / 100000000).toFixed(8),
            utxoCount: utxos.length,
            utxos
        };
    } catch (error) {
        throw new Error(`Failed to fetch balance: ${error.message}`);
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
        const response = await axios.get(`${config.apiBase}/blocks/tip/height`);
        return parseInt(response.data);
    } catch (error) {
        throw new Error(`Failed to fetch block height: ${error.message}`);
    }
}

/**
 * Get recommended fee rates
 * @returns {Promise<Object>} Fee estimates in sat/vB
 */
async function getFeeEstimates() {
    try {
        const response = await axios.get(`${config.apiBase}/fee-estimates`);
        return {
            fastest: Math.ceil(response.data['1'] || 20),
            halfHour: Math.ceil(response.data['3'] || 15),
            hour: Math.ceil(response.data['6'] || 10),
            economy: Math.ceil(response.data['144'] || 5)
        };
    } catch (error) {
        return { fastest: 20, halfHour: 15, hour: 10, economy: 5 };
    }
}

// =============================================================================
// TRANSACTION BUILDING
// =============================================================================

/**
 * Build a sweep transaction for P2SH HTLC funds
 * @param {Object} params - Transaction parameters
 * @returns {Object} Transaction details
 */
function buildSweepTransaction(params) {
    const {
        utxo,
        scriptSig,
        toAddress,
        locktime = 0
    } = params;
    
    const scriptSigBytes = scriptSig.length / 2;
    const baseSize = 10 + 32 + 4 + 4 + 8 + 34 + 4;
    const totalSize = baseSize + scriptSigBytes + 5;
    
    const fee = Math.ceil(totalSize * config.feeRate);
    const outputSatoshis = utxo.satoshis - fee;
    
    if (outputSatoshis <= config.dustLimit) {
        throw new Error(`Output would be dust after fees (${outputSatoshis} sats)`);
    }
    
    let tx = '';
    
    // Version
    tx += '01000000';
    
    // Input count
    tx += '01';
    
    // Input
    tx += reverseHex(utxo.txid);
    tx += toLittleEndian32(utxo.vout);
    tx += crypto.encodeVarInt(scriptSigBytes);
    tx += scriptSig;
    tx += 'feffffff';
    
    // Output count
    tx += '01';
    
    // Output
    tx += toLittleEndian64(outputSatoshis);
    const scriptPubKey = addressToScriptPubKey(toAddress);
    tx += crypto.encodeVarInt(scriptPubKey.length / 2);
    tx += scriptPubKey;
    
    // Locktime
    tx += toLittleEndian32(locktime);
    
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
 * Build claim transaction for P2SH HTLC
 * @param {Object} params - Claim parameters
 * @returns {Object} Transaction details
 */
function buildClaimTransaction(params) {
    const {
        utxo,
        swapSecret,
        recipientSecret,
        redeemScript,
        toAddress
    } = params;
    
    const htlcDetails = htlc.parseHTLCScript(redeemScript);
    
    if (crypto.sha256Hex(swapSecret) !== htlcDetails.swapHash) {
        throw new Error('Swap secret does not match hash in script');
    }
    if (crypto.sha256Hex(recipientSecret) !== htlcDetails.recipientHash) {
        throw new Error('Recipient secret does not match hash in script');
    }
    
    // BTC uses P2SH - include redeem script in scriptSig
    const scriptSig = htlc.createClaimScriptSig(
        swapSecret, 
        recipientSecret, 
        redeemScript, 
        'BTC'
    );
    
    return buildSweepTransaction({
        utxo,
        scriptSig,
        toAddress,
        locktime: 0
    });
}

/**
 * Build refund transaction for P2SH HTLC
 * @param {Object} params - Refund parameters
 * @returns {Object} Transaction details
 */
function buildRefundTransaction(params) {
    const {
        utxo,
        refundSecret,
        redeemScript,
        toAddress
    } = params;
    
    const htlcDetails = htlc.parseHTLCScript(redeemScript);
    
    if (crypto.sha256Hex(refundSecret) !== htlcDetails.refundHash) {
        throw new Error('Refund secret does not match hash in script');
    }
    
    const now = Math.floor(Date.now() / 1000);
    if (now < htlcDetails.timeout) {
        const remaining = htlcDetails.timeout - now;
        throw new Error(`Timeout not reached. ${remaining} seconds remaining.`);
    }
    
    const scriptSig = htlc.createRefundScriptSig(refundSecret, redeemScript, 'BTC');
    
    return buildSweepTransaction({
        utxo,
        scriptSig,
        toAddress,
        locktime: htlcDetails.timeout
    });
}

// =============================================================================
// BROADCASTING
// =============================================================================

/**
 * Broadcast a raw transaction
 * @param {string} txHex - Raw transaction hex
 * @returns {Promise<string>} Transaction ID
 */
async function broadcastTransaction(txHex) {
    try {
        const response = await axios.post(`${config.apiBase}/tx`, txHex, {
            headers: { 'Content-Type': 'text/plain' },
            timeout: 30000
        });
        return response.data;
    } catch (error) {
        const errorMsg = error.response?.data || error.message;
        throw new Error(`Broadcast failed: ${errorMsg}`);
    }
}

// =============================================================================
// ADDRESS UTILITIES
// =============================================================================

/**
 * Convert address to scriptPubKey (supports legacy, P2SH, and native segwit)
 * @param {string} address - Bitcoin address
 * @returns {string} Hex-encoded scriptPubKey
 */
function addressToScriptPubKey(address) {
    // Bech32 (native segwit)
    if (address.startsWith('bc1') || address.startsWith('tb1')) {
        return bech32ToScriptPubKey(address);
    }
    
    // Legacy (Base58Check)
    const decoded = bs58check.decode(address);
    const version = decoded[0];
    const hash = decoded.slice(1).toString('hex');
    
    if (version === 0x00 || version === 0x6f) {
        // P2PKH
        return '76a914' + hash + '88ac';
    } else if (version === 0x05 || version === 0xc4) {
        // P2SH
        return 'a914' + hash + '87';
    }
    
    throw new Error(`Unknown address version: 0x${version.toString(16)}`);
}

/**
 * Convert Bech32 address to scriptPubKey
 * @param {string} address - Bech32 address
 * @returns {string} Hex-encoded scriptPubKey
 */
function bech32ToScriptPubKey(address) {
    const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
    
    const hrp = address.startsWith('bc1') ? 'bc' : 'tb';
    const data = address.slice(hrp.length + 1).toLowerCase();
    
    const values = [];
    for (const char of data) {
        const index = CHARSET.indexOf(char);
        if (index === -1) throw new Error('Invalid Bech32 character');
        values.push(index);
    }
    
    const payload = values.slice(0, -6);
    const witnessVersion = payload[0];
    const converted = convert5to8(payload.slice(1));
    const witnessProgram = Buffer.from(converted).toString('hex');
    
    if (witnessVersion === 0 && converted.length === 20) {
        return '0014' + witnessProgram;  // P2WPKH
    } else if (witnessVersion === 0 && converted.length === 32) {
        return '0020' + witnessProgram;  // P2WSH
    } else if (witnessVersion === 1 && converted.length === 32) {
        return '5120' + witnessProgram;  // P2TR
    }
    
    throw new Error('Unsupported witness program');
}

function convert5to8(data) {
    let acc = 0, bits = 0;
    const result = [];
    for (const value of data) {
        acc = (acc << 5) | value;
        bits += 5;
        while (bits >= 8) {
            bits -= 8;
            result.push((acc >> bits) & 0xff);
        }
    }
    return result;
}

/**
 * Create P2SH address from redeem script
 * @param {string} redeemScript - Hex-encoded redeem script
 * @returns {string} P2SH address
 */
function createP2SHAddress(redeemScript) {
    const scriptHash = crypto.hash160(redeemScript);
    const prefix = config.network === 'mainnet' ? 0x05 : 0xc4;
    
    const payload = Buffer.concat([
        Buffer.from([prefix]),
        Buffer.isBuffer(scriptHash) ? scriptHash : Buffer.from(scriptHash, 'hex')
    ]);
    
    return bs58check.encode(payload);
}

/**
 * Validate BTC address
 * @param {string} address - Address to validate
 * @returns {Object} Validation result
 */
function validateAddress(address) {
    try {
        if (address.startsWith('bc1') || address.startsWith('tb1')) {
            // Basic Bech32 validation
            addressToScriptPubKey(address);
            return { valid: true, type: 'segwit', network: address.startsWith('bc1') ? 'mainnet' : 'testnet' };
        }
        
        const decoded = bs58check.decode(address);
        const version = decoded[0];
        
        if (version === 0x00) return { valid: true, type: 'p2pkh', network: 'mainnet' };
        if (version === 0x05) return { valid: true, type: 'p2sh', network: 'mainnet' };
        if (version === 0x6f) return { valid: true, type: 'p2pkh', network: 'testnet' };
        if (version === 0xc4) return { valid: true, type: 'p2sh', network: 'testnet' };
        
        return { valid: false, error: 'Unknown address type' };
    } catch (error) {
        return { valid: false, error: error.message };
    }
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
    const tx = await getTransaction(txid);
    
    // Try scriptSig first
    const scriptSig = tx.vin[0].scriptsig;
    
    if (scriptSig) {
        const pushByte = parseInt(scriptSig.substring(0, 2), 16);
        
        if (pushByte === 0x4d) {
            const pushLen = Buffer.from(scriptSig.substring(2, 6), 'hex').readUInt16LE(0);
            return scriptSig.substring(6, 6 + pushLen * 2);
        } else if (pushByte === 0x4c) {
            const pushLen = parseInt(scriptSig.substring(2, 4), 16);
            return scriptSig.substring(4, 4 + pushLen * 2);
        } else if (pushByte <= 75) {
            return scriptSig.substring(2, 2 + pushByte * 2);
        }
    }
    
    // Try witness data for segwit
    const witness = tx.vin[0].witness;
    if (witness && witness.length > 0) {
        if (witness[0].length >= 64) {
            return witness[0];
        }
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
async function waitForConfirmation(txid, minConfirmations = 1, timeoutMs = 3600000) {
    const startTime = Date.now();
    
    while (Date.now() - startTime < timeoutMs) {
        try {
            const tx = await getTransaction(txid);
            if (tx.status.confirmed) {
                const tipHeight = await getBlockHeight();
                const confirmations = tipHeight - tx.status.block_height + 1;
                
                if (confirmations >= minConfirmations) {
                    return {
                        txid,
                        confirmations,
                        blockHash: tx.status.block_hash,
                        blockHeight: tx.status.block_height
                    };
                }
            }
        } catch (error) {
            // Transaction might not be found yet
        }
        
        await new Promise(resolve => setTimeout(resolve, 30000));
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
    getBalance,
    
    // Transaction queries
    getTransaction,
    getRawTransaction,
    getBlockHeight,
    getFeeEstimates,
    
    // Transaction building
    buildSweepTransaction,
    buildClaimTransaction,
    buildRefundTransaction,
    
    // Broadcasting
    broadcastTransaction,
    
    // Address utilities
    addressToScriptPubKey,
    createP2SHAddress,
    validateAddress,
    
    // Secret extraction
    extractSwapSecretFromTx,
    waitForConfirmation
};
