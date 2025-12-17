/**
 * Quantum Atomic Swaps v2.0 - HTLC Script Generation
 * 
 * Creates quantum-safe Hash Time-Locked Contract scripts using
 * Winternitz-compatible preimages (1024-byte commitments).
 * 
 * CRITICAL: BSV uses BARE SCRIPTS (not P2SH)
 * - P2SH was deprecated in BSV Genesis (Feb 2020)
 * - Addresses starting with '3' DO NOT WORK on BSV mainnet
 * - BTC still uses P2SH normally
 * 
 * Security Model:
 * - Claim path requires TWO preimages (swap + recipient)
 * - Each preimage is 1024 bytes (32 Winternitz commitments)
 * - SHA256(preimage) must match committed hash
 * - Refund path protected by CHECKLOCKTIMEVERIFY
 */

const crypto = require('./crypto');
const bs58check = require('bs58check');

// =============================================================================
// BITCOIN SCRIPT OPCODES
// =============================================================================

const OP = {
    // Constants
    FALSE: '00',
    TRUE: '51',
    PUSHDATA1: '4c',
    PUSHDATA2: '4d',
    
    // Flow control
    IF: '63',
    ELSE: '67',
    ENDIF: '68',
    
    // Stack
    DROP: '75',
    DUP: '76',
    
    // Comparison
    EQUAL: '87',
    EQUALVERIFY: '88',
    
    // Crypto
    SHA256: 'a8',
    HASH160: 'a9',
    HASH256: 'aa',
    
    // Signature (not used - quantum unsafe)
    CHECKSIG: 'ac',
    
    // Locktime
    CHECKLOCKTIMEVERIFY: 'b1',
    CHECKSEQUENCEVERIFY: 'b2',
    
    // NOP
    NOP: '61'
};

// =============================================================================
// QUANTUM-SAFE HTLC SCRIPT
// =============================================================================

/**
 * Create a quantum-safe HTLC script
 * 
 * Script Logic:
 * IF
 *   // Claim path: recipient provides swap_preimage + recipient_preimage
 *   OP_SHA256 <swap_hash> OP_EQUALVERIFY
 *   OP_SHA256 <recipient_hash> OP_EQUAL
 * ELSE
 *   // Refund path: after timeout, provide refund_preimage
 *   <timeout> OP_CHECKLOCKTIMEVERIFY OP_DROP
 *   OP_SHA256 <refund_hash> OP_EQUAL
 * ENDIF
 * 
 * @param {Object} params - HTLC parameters
 * @param {string} params.swapHash - SHA256 hash of swap preimage (32 bytes hex)
 * @param {string} params.recipientHash - SHA256 hash of recipient preimage (32 bytes hex)
 * @param {string} params.refundHash - SHA256 hash of refund preimage (32 bytes hex)
 * @param {number} params.timeout - Unix timestamp for refund timeout
 * @returns {Object} Script details
 */
function createHTLCScript(params) {
    const { swapHash, recipientHash, refundHash, timeout } = params;
    
    // Validate inputs
    if (!swapHash || swapHash.length !== 64) {
        throw new Error('Invalid swap hash: must be 64 hex characters (32 bytes)');
    }
    if (!recipientHash || recipientHash.length !== 64) {
        throw new Error('Invalid recipient hash: must be 64 hex characters (32 bytes)');
    }
    if (!refundHash || refundHash.length !== 64) {
        throw new Error('Invalid refund hash: must be 64 hex characters (32 bytes)');
    }
    if (!timeout || timeout < 1) {
        throw new Error('Invalid timeout: must be positive unix timestamp');
    }
    
    // Encode timeout as minimal push
    const timeoutHex = encodeMinimalNumber(timeout);
    
    // Build the HTLC script
    const script = [
        OP.IF,
        // Claim path: verify swap_preimage AND recipient_preimage
        OP.SHA256,
        crypto.pushData(swapHash),
        OP.EQUALVERIFY,
        OP.SHA256,
        crypto.pushData(recipientHash),
        OP.EQUAL,
        OP.ELSE,
        // Refund path: verify timeout + refund_preimage
        crypto.pushData(timeoutHex),
        OP.CHECKLOCKTIMEVERIFY,
        OP.DROP,
        OP.SHA256,
        crypto.pushData(refundHash),
        OP.EQUAL,
        OP.ENDIF
    ].join('');
    
    // Generate script hashes
    const scriptBuffer = Buffer.from(script, 'hex');
    const scriptHash = crypto.hash160(scriptBuffer).toString('hex');
    const sha256Hash = crypto.sha256(scriptBuffer).toString('hex');
    
    return {
        redeemScript: script,
        redeemScriptHash: scriptHash,
        sha256Hash,
        swapHash,
        recipientHash,
        refundHash,
        timeout,
        timeoutHex,
        scriptSize: scriptBuffer.length
    };
}

/**
 * Create complete HTLC with addresses for both BTC (P2SH) and BSV (bare script)
 * 
 * @param {Object} params - HTLC parameters
 * @param {string} chain - 'BTC' or 'BSV'
 * @param {string} network - 'mainnet' or 'testnet'
 * @returns {Object} Complete HTLC with appropriate address type
 */
function createHTLC(params, chain = 'BSV', network = 'mainnet') {
    const htlcScript = createHTLCScript(params);
    
    if (chain === 'BSV') {
        // BSV: Use BARE SCRIPT - no P2SH!
        // The "address" is actually the script hash for lookups
        // Funding requires creating a raw transaction with the locking script
        return {
            ...htlcScript,
            chain: 'BSV',
            network,
            outputType: 'bare-script',
            lockingScript: htlcScript.redeemScript,
            scriptHash: htlcScript.sha256Hash,  // For WhatsOnChain lookup
            address: null,  // BSV bare scripts don't have standard addresses
            fundingNote: 'BARE_SCRIPT: Must create raw transaction with lockingScript as output',
            scriptASM: decodeScriptToASM(htlcScript.redeemScript)
        };
    } else {
        // BTC: Use P2SH (still works on BTC)
        const p2shAddress = scriptHashToP2SH(htlcScript.redeemScriptHash, network);
        return {
            ...htlcScript,
            chain: 'BTC',
            network,
            outputType: 'p2sh',
            address: p2shAddress,
            scriptASM: decodeScriptToASM(htlcScript.redeemScript)
        };
    }
}

// =============================================================================
// ADDRESS GENERATION
// =============================================================================

/**
 * Generate P2SH address from script hash (BTC only)
 * @param {string} scriptHash - HASH160 of redeem script (20 bytes hex)
 * @param {string} network - 'mainnet' or 'testnet'
 * @returns {string} P2SH address (starts with '3' for mainnet)
 */
function scriptHashToP2SH(scriptHash, network = 'mainnet') {
    const prefix = network === 'mainnet' ? 0x05 : 0xc4;
    const payload = Buffer.concat([
        Buffer.from([prefix]),
        Buffer.from(scriptHash, 'hex')
    ]);
    return bs58check.encode(payload);
}

/**
 * Create scriptPubKey for P2SH output
 * @param {string} scriptHash - HASH160 of redeem script
 * @returns {string} Hex-encoded scriptPubKey
 */
function createP2SHScriptPubKey(scriptHash) {
    // OP_HASH160 <20 bytes> OP_EQUAL
    return OP.HASH160 + crypto.pushData(scriptHash) + OP.EQUAL;
}

// =============================================================================
// SCRIPTSIG CREATION (Unlocking Scripts)
// =============================================================================

/**
 * Create scriptSig for CLAIMING funds (recipient path)
 * 
 * For quantum-safe HTLCs, the preimages are 1024 bytes each (Winternitz)
 * Stack: <swap_preimage> <recipient_preimage> OP_TRUE [<redeemScript> for P2SH]
 * 
 * @param {string} swapPreimage - Swap secret (1024 bytes hex for WOTS, 32 bytes for simple)
 * @param {string} recipientPreimage - Recipient secret
 * @param {string} redeemScript - Full redeem script (hex)
 * @param {string} chain - 'BTC' (P2SH) or 'BSV' (bare script)
 * @returns {string} Hex-encoded scriptSig
 */
function createClaimScriptSig(swapPreimage, recipientPreimage, redeemScript, chain = 'BSV') {
    // Validate preimages
    if (!swapPreimage || swapPreimage.length < 64) {
        throw new Error('Invalid swap preimage');
    }
    if (!recipientPreimage || recipientPreimage.length < 64) {
        throw new Error('Invalid recipient preimage');
    }
    
    const parts = [
        crypto.pushData(swapPreimage),
        crypto.pushData(recipientPreimage),
        OP.TRUE  // Select IF branch
    ];
    
    // BTC P2SH requires redeem script in scriptSig
    // BSV bare scripts have redeem script as output, not input
    if (chain === 'BTC') {
        parts.push(crypto.pushData(redeemScript));
    }
    
    return parts.join('');
}

/**
 * Create scriptSig for REFUNDING funds (timeout path)
 * 
 * Stack: <refund_preimage> OP_FALSE [<redeemScript> for P2SH]
 * 
 * @param {string} refundPreimage - Refund secret
 * @param {string} redeemScript - Full redeem script (hex)
 * @param {string} chain - 'BTC' (P2SH) or 'BSV' (bare script)
 * @returns {string} Hex-encoded scriptSig
 */
function createRefundScriptSig(refundPreimage, redeemScript, chain = 'BSV') {
    if (!refundPreimage || refundPreimage.length < 64) {
        throw new Error('Invalid refund preimage');
    }
    
    const parts = [
        crypto.pushData(refundPreimage),
        OP.FALSE  // Select ELSE branch
    ];
    
    if (chain === 'BTC') {
        parts.push(crypto.pushData(redeemScript));
    }
    
    return parts.join('');
}

// =============================================================================
// SCRIPT PARSING AND VERIFICATION
// =============================================================================

/**
 * Parse and verify HTLC script structure
 * @param {string} scriptHex - Hex-encoded script
 * @returns {Object} Parsed script components
 */
function parseHTLCScript(scriptHex) {
    // Expected structure:
    // 63 (IF)
    // a8 (SHA256) 20 <swap_hash:32> 88 (EQUALVERIFY)
    // a8 (SHA256) 20 <recipient_hash:32> 87 (EQUAL)
    // 67 (ELSE)
    // <timeout:4-5> b1 (CLTV) 75 (DROP)
    // a8 (SHA256) 20 <refund_hash:32> 87 (EQUAL)
    // 68 (ENDIF)
    
    let i = 0;
    
    // OP_IF
    if (scriptHex.substring(i, i + 2) !== OP.IF) {
        throw new Error('Expected OP_IF at start');
    }
    i += 2;
    
    // OP_SHA256
    if (scriptHex.substring(i, i + 2) !== OP.SHA256) {
        throw new Error('Expected OP_SHA256');
    }
    i += 2;
    
    // Push 32 bytes (swap hash)
    if (scriptHex.substring(i, i + 2) !== '20') {
        throw new Error('Expected 32-byte push for swap hash');
    }
    i += 2;
    const swapHash = scriptHex.substring(i, i + 64);
    i += 64;
    
    // OP_EQUALVERIFY
    if (scriptHex.substring(i, i + 2) !== OP.EQUALVERIFY) {
        throw new Error('Expected OP_EQUALVERIFY');
    }
    i += 2;
    
    // OP_SHA256
    if (scriptHex.substring(i, i + 2) !== OP.SHA256) {
        throw new Error('Expected OP_SHA256');
    }
    i += 2;
    
    // Push 32 bytes (recipient hash)
    if (scriptHex.substring(i, i + 2) !== '20') {
        throw new Error('Expected 32-byte push for recipient hash');
    }
    i += 2;
    const recipientHash = scriptHex.substring(i, i + 64);
    i += 64;
    
    // OP_EQUAL
    if (scriptHex.substring(i, i + 2) !== OP.EQUAL) {
        throw new Error('Expected OP_EQUAL');
    }
    i += 2;
    
    // OP_ELSE
    if (scriptHex.substring(i, i + 2) !== OP.ELSE) {
        throw new Error('Expected OP_ELSE');
    }
    i += 2;
    
    // Parse timeout (variable length push)
    const timeoutPushLen = parseInt(scriptHex.substring(i, i + 2), 16);
    i += 2;
    const timeoutHex = scriptHex.substring(i, i + timeoutPushLen * 2);
    const timeout = decodeMinimalNumber(timeoutHex);
    i += timeoutPushLen * 2;
    
    // OP_CHECKLOCKTIMEVERIFY
    if (scriptHex.substring(i, i + 2) !== OP.CHECKLOCKTIMEVERIFY) {
        throw new Error('Expected OP_CHECKLOCKTIMEVERIFY');
    }
    i += 2;
    
    // OP_DROP
    if (scriptHex.substring(i, i + 2) !== OP.DROP) {
        throw new Error('Expected OP_DROP');
    }
    i += 2;
    
    // OP_SHA256
    if (scriptHex.substring(i, i + 2) !== OP.SHA256) {
        throw new Error('Expected OP_SHA256');
    }
    i += 2;
    
    // Push 32 bytes (refund hash)
    if (scriptHex.substring(i, i + 2) !== '20') {
        throw new Error('Expected 32-byte push for refund hash');
    }
    i += 2;
    const refundHash = scriptHex.substring(i, i + 64);
    i += 64;
    
    // OP_EQUAL
    if (scriptHex.substring(i, i + 2) !== OP.EQUAL) {
        throw new Error('Expected OP_EQUAL');
    }
    i += 2;
    
    // OP_ENDIF
    if (scriptHex.substring(i, i + 2) !== OP.ENDIF) {
        throw new Error('Expected OP_ENDIF');
    }
    
    return {
        valid: true,
        swapHash,
        recipientHash,
        refundHash,
        timeout,
        timeoutHex,
        timeoutDate: new Date(timeout * 1000).toISOString()
    };
}

/**
 * Decode script hex to human-readable ASM
 * @param {string} scriptHex - Hex-encoded script
 * @returns {string} ASM representation
 */
function decodeScriptToASM(scriptHex) {
    const opcodeNames = {
        '00': 'OP_0',
        '51': 'OP_TRUE',
        '52': 'OP_2',
        '53': 'OP_3',
        '63': 'OP_IF',
        '67': 'OP_ELSE',
        '68': 'OP_ENDIF',
        '75': 'OP_DROP',
        '76': 'OP_DUP',
        '87': 'OP_EQUAL',
        '88': 'OP_EQUALVERIFY',
        'a8': 'OP_SHA256',
        'a9': 'OP_HASH160',
        'aa': 'OP_HASH256',
        'ac': 'OP_CHECKSIG',
        'b1': 'OP_CHECKLOCKTIMEVERIFY',
        'b2': 'OP_CHECKSEQUENCEVERIFY'
    };
    
    const parts = [];
    let i = 0;
    
    while (i < scriptHex.length) {
        const byte = scriptHex.substring(i, i + 2);
        const opcode = parseInt(byte, 16);
        
        if (opcodeNames[byte]) {
            parts.push(opcodeNames[byte]);
            i += 2;
        } else if (opcode >= 0x01 && opcode <= 0x4b) {
            // Direct push (1-75 bytes)
            const dataLen = opcode * 2;
            const data = scriptHex.substring(i + 2, i + 2 + dataLen);
            if (dataLen <= 16) {
                parts.push(`<${data}>`);
            } else {
                parts.push(`<${data.substring(0, 8)}...${dataLen/2}B>`);
            }
            i += 2 + dataLen;
        } else if (byte === '4c') {
            // OP_PUSHDATA1
            const lenByte = parseInt(scriptHex.substring(i + 2, i + 4), 16);
            const data = scriptHex.substring(i + 4, i + 4 + lenByte * 2);
            parts.push(`<PUSHDATA1:${lenByte}B>`);
            i += 4 + lenByte * 2;
        } else if (byte === '4d') {
            // OP_PUSHDATA2
            const lenBytes = scriptHex.substring(i + 2, i + 6);
            const len = Buffer.from(lenBytes, 'hex').readUInt16LE(0);
            parts.push(`<PUSHDATA2:${len}B>`);
            i += 6 + len * 2;
        } else {
            parts.push(`0x${byte}`);
            i += 2;
        }
    }
    
    return parts.join(' ');
}

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

/**
 * Encode a number in Bitcoin's minimal push format
 * @param {number} num - Number to encode
 * @returns {string} Hex string
 */
function encodeMinimalNumber(num) {
    if (num === 0) return '';
    
    const buf = Buffer.alloc(8);
    let i = 0;
    let n = num;
    
    while (n > 0) {
        buf[i++] = n & 0xff;
        n = Math.floor(n / 256);
    }
    
    // If high bit set, add 0x00 byte
    if (buf[i - 1] & 0x80) {
        buf[i++] = 0x00;
    }
    
    return buf.slice(0, i).toString('hex');
}

/**
 * Decode a minimally-encoded number from hex
 * @param {string} hex - Hex string (little-endian)
 * @returns {number} Decoded number
 */
function decodeMinimalNumber(hex) {
    if (!hex || hex.length === 0) return 0;
    
    const buf = Buffer.from(hex, 'hex');
    let result = 0;
    
    for (let i = buf.length - 1; i >= 0; i--) {
        result = result * 256 + buf[i];
    }
    
    return result;
}

/**
 * Calculate script size for fee estimation
 * @param {Object} htlc - HTLC object
 * @param {boolean} isQuantum - True for Winternitz (1024-byte preimages)
 * @returns {number} Estimated scriptSig size
 */
function estimateScriptSigSize(htlc, isQuantum = true) {
    if (isQuantum) {
        // Winternitz preimages: 1024 bytes each
        // scriptSig = <swap:1024> <recipient:1024> OP_TRUE [<redeemScript>]
        const preimageSize = 1024 + 1024 + 3;  // 2 preimages + pushdata overhead + OP_TRUE
        const redeemSize = htlc.redeemScript.length / 2 + 3;  // Script + pushdata overhead
        return preimageSize + (htlc.chain === 'BTC' ? redeemSize : 0);
    } else {
        // Simple preimages: 32 bytes each
        const preimageSize = 32 + 32 + 3;
        const redeemSize = htlc.redeemScript.length / 2 + 3;
        return preimageSize + (htlc.chain === 'BTC' ? redeemSize : 0);
    }
}

// =============================================================================
// EXPORTS
// =============================================================================

module.exports = {
    // Opcodes
    OP,
    
    // Script creation
    createHTLCScript,
    createHTLC,
    createP2SHScriptPubKey,
    
    // Address generation
    scriptHashToP2SH,
    
    // ScriptSig creation
    createClaimScriptSig,
    createRefundScriptSig,
    
    // Parsing
    parseHTLCScript,
    decodeScriptToASM,
    
    // Utilities
    encodeMinimalNumber,
    decodeMinimalNumber,
    estimateScriptSigSize
};
