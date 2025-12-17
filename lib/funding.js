/**
 * Quantum Atomic Swaps v2.0 - Funding Transaction Builder
 * 
 * Creates funding transactions for HTLCs on BSV and BTC.
 * 
 * CRITICAL NOTES:
 * - BSV: Funds go directly to BARE SCRIPT (the HTLC locking script IS the output)
 * - BTC: Funds go to P2SH address wrapping the HTLC script
 * - This module builds UNSIGNED transactions - signing requires external wallet
 */

const crypto = require('./crypto');

// =============================================================================
// BSV BARE SCRIPT FUNDING
// =============================================================================

/**
 * Build a BSV funding transaction for a bare script HTLC
 * 
 * The output scriptPubKey IS the HTLC locking script (no P2SH wrapper).
 * This is BSV Genesis compliant - P2SH is deprecated.
 * 
 * @param {Object} params - Funding parameters
 * @param {Array} params.utxos - Array of {txid, vout, satoshis, scriptPubKey} from your wallet
 * @param {string} params.lockingScript - The HTLC locking script (hex)
 * @param {number} params.amount - Satoshis to lock in HTLC
 * @param {string} params.changeAddress - Address for change output (must start with '1')
 * @param {number} params.feeRate - Fee rate in sat/byte (default: 1)
 * @returns {Object} Unsigned transaction and details
 */
function buildBSVFundingTx(params) {
    const {
        utxos,
        lockingScript,
        amount,
        changeAddress,
        feeRate = 1
    } = params;
    
    // Validate inputs
    if (!utxos || utxos.length === 0) {
        throw new Error('No UTXOs provided');
    }
    if (!lockingScript) {
        throw new Error('No locking script provided');
    }
    if (!amount || amount < 546) {
        throw new Error('Amount must be at least 546 satoshis (dust limit)');
    }
    if (changeAddress && changeAddress.startsWith('3')) {
        throw new Error('BSV does not support P2SH addresses (starting with 3)');
    }
    
    // Calculate total input value
    const totalInput = utxos.reduce((sum, u) => sum + u.satoshis, 0);
    
    // Estimate transaction size
    // Version: 4, InputCount: 1-3, Outputs: 2, Locktime: 4
    // Each input: ~148 bytes (with signature placeholder)
    // HTLC output: variable (locking script can be ~100-200 bytes)
    // Change output: ~34 bytes (P2PKH)
    const lockingScriptBytes = lockingScript.length / 2;
    const estimatedSize = 10 + (utxos.length * 180) + lockingScriptBytes + 50 + 4;
    const estimatedFee = Math.ceil(estimatedSize * feeRate);
    
    // Calculate change
    const change = totalInput - amount - estimatedFee;
    
    if (change < 0) {
        throw new Error(`Insufficient funds. Need ${amount + estimatedFee}, have ${totalInput}`);
    }
    
    // Build transaction structure
    const tx = {
        version: 1,
        inputs: utxos.map((utxo, index) => ({
            txid: utxo.txid,
            vout: utxo.vout,
            satoshis: utxo.satoshis,
            scriptPubKey: utxo.scriptPubKey || '',
            sequence: 0xfffffffe,  // Enable CLTV
            // Signature placeholder - to be filled by wallet
            scriptSig: null,
            signatureRequired: true
        })),
        outputs: [
            {
                // HTLC output - bare script
                satoshis: amount,
                scriptPubKey: lockingScript,
                type: 'bare-htlc',
                index: 0
            }
        ],
        locktime: 0
    };
    
    // Add change output if significant
    if (change > 546) {
        tx.outputs.push({
            satoshis: change,
            scriptPubKey: addressToP2PKH(changeAddress),
            type: 'p2pkh-change',
            index: 1
        });
    }
    
    // Build raw transaction hex (without signatures)
    const rawTxHex = buildRawTxHex(tx, false);
    
    // Calculate script hash for UTXO lookup
    const scriptHash = crypto.sha256Hex(lockingScript);
    
    return {
        success: true,
        chain: 'BSV',
        type: 'bare-script-funding',
        
        // Transaction details
        transaction: tx,
        rawTxUnsigned: rawTxHex,
        estimatedSize,
        estimatedFee,
        feeRate,
        
        // Input/Output summary
        totalInput,
        htlcAmount: amount,
        changeAmount: change > 546 ? change : 0,
        
        // HTLC identification
        htlcOutput: {
            index: 0,
            scriptPubKey: lockingScript,
            scriptHash: scriptHash,
            lookupNote: 'Use scriptHash to find UTXOs via WhatsOnChain: /api/v1/bsv/main/script/{scriptHash}/unspent'
        },
        
        // Signing instructions
        signingInstructions: {
            note: 'Sign each input with your wallet',
            inputs: tx.inputs.map((inp, i) => ({
                index: i,
                txid: inp.txid,
                vout: inp.vout,
                satoshis: inp.satoshis,
                sighashType: 'SIGHASH_ALL | SIGHASH_FORKID (0x41)'
            }))
        }
    };
}

/**
 * Build a BTC funding transaction for a P2SH HTLC
 * 
 * @param {Object} params - Funding parameters
 * @param {Array} params.utxos - Array of {txid, vout, satoshis, scriptPubKey}
 * @param {string} params.redeemScript - The HTLC redeem script (hex)
 * @param {string} params.p2shAddress - The P2SH address (starts with '3')
 * @param {number} params.amount - Satoshis to lock
 * @param {string} params.changeAddress - Change address
 * @param {number} params.feeRate - Fee rate in sat/vB (default: 10)
 * @returns {Object} Unsigned transaction and details
 */
function buildBTCFundingTx(params) {
    const {
        utxos,
        redeemScript,
        p2shAddress,
        amount,
        changeAddress,
        feeRate = 10
    } = params;
    
    // Validate
    if (!utxos || utxos.length === 0) {
        throw new Error('No UTXOs provided');
    }
    if (!redeemScript || !p2shAddress) {
        throw new Error('Redeem script and P2SH address required');
    }
    if (!p2shAddress.startsWith('3') && !p2shAddress.startsWith('2')) {
        throw new Error('P2SH address must start with 3 (mainnet) or 2 (testnet)');
    }
    
    const totalInput = utxos.reduce((sum, u) => sum + u.satoshis, 0);
    
    // Estimate size (BTC uses vBytes for segwit, bytes for legacy)
    const estimatedVSize = 10 + (utxos.length * 148) + 34 + 34 + 4;
    const estimatedFee = Math.ceil(estimatedVSize * feeRate);
    
    const change = totalInput - amount - estimatedFee;
    
    if (change < 0) {
        throw new Error(`Insufficient funds. Need ${amount + estimatedFee}, have ${totalInput}`);
    }
    
    // P2SH scriptPubKey: OP_HASH160 <20-byte-hash> OP_EQUAL
    const scriptHash = crypto.hash160(redeemScript).toString('hex');
    const p2shScriptPubKey = 'a914' + scriptHash + '87';
    
    const tx = {
        version: 1,
        inputs: utxos.map(utxo => ({
            txid: utxo.txid,
            vout: utxo.vout,
            satoshis: utxo.satoshis,
            scriptPubKey: utxo.scriptPubKey || '',
            sequence: 0xfffffffe,
            scriptSig: null,
            signatureRequired: true
        })),
        outputs: [
            {
                satoshis: amount,
                scriptPubKey: p2shScriptPubKey,
                type: 'p2sh-htlc',
                address: p2shAddress,
                index: 0
            }
        ],
        locktime: 0
    };
    
    if (change > 546) {
        // Determine change output type
        let changeScriptPubKey;
        if (changeAddress.startsWith('bc1') || changeAddress.startsWith('tb1')) {
            changeScriptPubKey = bech32ToScriptPubKey(changeAddress);
        } else {
            changeScriptPubKey = addressToP2PKH(changeAddress);
        }
        
        tx.outputs.push({
            satoshis: change,
            scriptPubKey: changeScriptPubKey,
            type: 'change',
            address: changeAddress,
            index: 1
        });
    }
    
    const rawTxHex = buildRawTxHex(tx, false);
    
    return {
        success: true,
        chain: 'BTC',
        type: 'p2sh-funding',
        
        transaction: tx,
        rawTxUnsigned: rawTxHex,
        estimatedVSize,
        estimatedFee,
        feeRate,
        
        totalInput,
        htlcAmount: amount,
        changeAmount: change > 546 ? change : 0,
        
        htlcOutput: {
            index: 0,
            address: p2shAddress,
            scriptPubKey: p2shScriptPubKey,
            redeemScriptHash: scriptHash,
            note: 'To spend, provide the redeem script in scriptSig'
        },
        
        signingInstructions: {
            note: 'Sign each input with your wallet',
            inputs: tx.inputs.map((inp, i) => ({
                index: i,
                txid: inp.txid,
                vout: inp.vout,
                satoshis: inp.satoshis,
                sighashType: 'SIGHASH_ALL (0x01)'
            }))
        }
    };
}

// =============================================================================
// HELPER: BUILD RAW TRANSACTION HEX
// =============================================================================

/**
 * Build raw transaction hex from transaction object
 * @param {Object} tx - Transaction object
 * @param {boolean} includeScriptSig - Include scriptSig (false for unsigned)
 * @returns {string} Raw transaction hex
 */
function buildRawTxHex(tx, includeScriptSig = false) {
    let hex = '';
    
    // Version (4 bytes LE)
    hex += toLittleEndian32(tx.version);
    
    // Input count
    hex += crypto.encodeVarInt(tx.inputs.length);
    
    // Inputs
    for (const input of tx.inputs) {
        // Previous txid (32 bytes, reversed)
        hex += reverseHex(input.txid);
        // Previous vout (4 bytes LE)
        hex += toLittleEndian32(input.vout);
        
        // ScriptSig
        if (includeScriptSig && input.scriptSig) {
            const scriptSigLen = input.scriptSig.length / 2;
            hex += crypto.encodeVarInt(scriptSigLen);
            hex += input.scriptSig;
        } else {
            hex += '00';  // Empty scriptSig for unsigned
        }
        
        // Sequence (4 bytes LE)
        hex += toLittleEndian32(input.sequence);
    }
    
    // Output count
    hex += crypto.encodeVarInt(tx.outputs.length);
    
    // Outputs
    for (const output of tx.outputs) {
        // Value (8 bytes LE)
        hex += toLittleEndian64(output.satoshis);
        // ScriptPubKey
        const scriptLen = output.scriptPubKey.length / 2;
        hex += crypto.encodeVarInt(scriptLen);
        hex += output.scriptPubKey;
    }
    
    // Locktime (4 bytes LE)
    hex += toLittleEndian32(tx.locktime);
    
    return hex;
}

/**
 * Create sighash for signing (BSV with FORKID)
 * @param {Object} tx - Transaction object
 * @param {number} inputIndex - Input to sign
 * @param {string} prevScriptPubKey - Previous output's scriptPubKey
 * @param {number} amount - Previous output's value
 * @param {number} sighashType - Sighash type (0x41 for BSV)
 * @returns {Buffer} 32-byte hash to sign
 */
function createBSVSighash(tx, inputIndex, prevScriptPubKey, amount, sighashType = 0x41) {
    // BIP143 sighash (used by BSV with FORKID)
    let preimage = '';
    
    // 1. Version
    preimage += toLittleEndian32(tx.version);
    
    // 2. hashPrevouts (hash of all input outpoints)
    let prevouts = '';
    for (const input of tx.inputs) {
        prevouts += reverseHex(input.txid);
        prevouts += toLittleEndian32(input.vout);
    }
    preimage += crypto.hash256(prevouts).toString('hex');
    
    // 3. hashSequence (hash of all sequences)
    let sequences = '';
    for (const input of tx.inputs) {
        sequences += toLittleEndian32(input.sequence);
    }
    preimage += crypto.hash256(sequences).toString('hex');
    
    // 4. Outpoint being spent
    const input = tx.inputs[inputIndex];
    preimage += reverseHex(input.txid);
    preimage += toLittleEndian32(input.vout);
    
    // 5. ScriptCode (previous scriptPubKey)
    preimage += crypto.encodeVarInt(prevScriptPubKey.length / 2);
    preimage += prevScriptPubKey;
    
    // 6. Value being spent (8 bytes LE)
    preimage += toLittleEndian64(amount);
    
    // 7. Sequence
    preimage += toLittleEndian32(input.sequence);
    
    // 8. hashOutputs (hash of all outputs)
    let outputs = '';
    for (const output of tx.outputs) {
        outputs += toLittleEndian64(output.satoshis);
        outputs += crypto.encodeVarInt(output.scriptPubKey.length / 2);
        outputs += output.scriptPubKey;
    }
    preimage += crypto.hash256(outputs).toString('hex');
    
    // 9. Locktime
    preimage += toLittleEndian32(tx.locktime);
    
    // 10. Sighash type (4 bytes LE)
    preimage += toLittleEndian32(sighashType);
    
    // Double SHA256 the preimage
    return crypto.hash256(preimage);
}

// =============================================================================
// ADDRESS HELPERS
// =============================================================================

const bs58check = require('bs58check');

function addressToP2PKH(address) {
    try {
        const decoded = bs58check.decode(address);
        const hash = decoded.slice(1).toString('hex');
        return '76a914' + hash + '88ac';
    } catch (e) {
        throw new Error(`Invalid address: ${e.message}`);
    }
}

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
        return '0014' + witnessProgram;
    } else if (witnessVersion === 0 && converted.length === 32) {
        return '0020' + witnessProgram;
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

function reverseHex(hex) {
    return Buffer.from(hex, 'hex').reverse().toString('hex');
}

function toLittleEndian32(num) {
    const buf = Buffer.alloc(4);
    buf.writeUInt32LE(num >>> 0);
    return buf.toString('hex');
}

function toLittleEndian64(num) {
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64LE(BigInt(num));
    return buf.toString('hex');
}

// =============================================================================
// EXPORTS
// =============================================================================

module.exports = {
    // Main builders
    buildBSVFundingTx,
    buildBTCFundingTx,
    
    // Helpers (for advanced use)
    buildRawTxHex,
    createBSVSighash,
    addressToP2PKH,
    bech32ToScriptPubKey
};
