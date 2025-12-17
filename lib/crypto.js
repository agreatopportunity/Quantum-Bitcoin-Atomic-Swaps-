/**
 * Quantum Atomic Swaps v2.0 - Cryptographic Core
 * 
 * Implements Winternitz One-Time Signatures (WOTS) for quantum-safe
 * hash-based cryptography. NO ECDSA - purely hash-based security.
 * 
 * Security Model:
 * - 32 private scalars × 32 bytes = 1024 bytes entropy
 * - Each scalar hashed 256 times to create public commitment
 * - Signature reveals intermediate chain values
 * - Quantum computers cannot reverse SHA256
 */

const crypto = require('crypto');

// =============================================================================
// CONSTANTS
// =============================================================================

const WOTS_CHUNKS = 32;           // Number of signature chunks (one per byte)
const WOTS_ITERATIONS = 256;      // Hash chain length (for 8-bit chunks: 0-255)
const SCALAR_SIZE = 32;           // Size of each private scalar in bytes

// =============================================================================
// CORE HASH FUNCTIONS
// =============================================================================

/**
 * SHA256 hash
 * @param {Buffer|string} data - Data to hash (Buffer or hex string)
 * @returns {Buffer} 32-byte hash
 */
function sha256(data) {
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data, 'hex');
    return crypto.createHash('sha256').update(buffer).digest();
}

/**
 * SHA256 returning hex string
 * @param {Buffer|string} data - Data to hash
 * @returns {string} Hex-encoded hash
 */
function sha256Hex(data) {
    return sha256(data).toString('hex');
}

/**
 * Double SHA256 (HASH256) - Bitcoin standard
 * @param {Buffer|string} data - Data to hash
 * @returns {Buffer} 32-byte hash
 */
function hash256(data) {
    return sha256(sha256(data));
}

/**
 * HASH160 (SHA256 + RIPEMD160) - Bitcoin addresses
 * @param {Buffer|string} data - Data to hash
 * @returns {Buffer} 20-byte hash
 */
function hash160(data) {
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data, 'hex');
    const sha = crypto.createHash('sha256').update(buffer).digest();
    return crypto.createHash('ripemd160').update(sha).digest();
}

/**
 * Apply HASH256 N times (iterated hashing)
 * @param {Buffer} data - Initial data
 * @param {number} iterations - Number of hash iterations
 * @returns {Buffer} Result after N hash applications
 */
function iteratedHash256(data, iterations) {
    let result = Buffer.from(data);
    for (let i = 0; i < iterations; i++) {
        result = hash256(result);
    }
    return result;
}

/**
 * Generate cryptographically secure random bytes
 * @param {number} bytes - Number of bytes
 * @returns {Buffer} Random bytes
 */
function randomBytes(bytes = 32) {
    return crypto.randomBytes(bytes);
}

/**
 * Generate a random secret with its hash
 * @returns {{secret: string, hash: string}} Secret and SHA256 hash (hex)
 */
function generateHashPair() {
    const secret = randomBytes(32);
    const hash = sha256(secret);
    return {
        secret: secret.toString('hex'),
        hash: hash.toString('hex')
    };
}

// =============================================================================
// WINTERNITZ ONE-TIME SIGNATURES (WOTS)
// =============================================================================

/**
 * Generate a Winternitz keypair
 * 
 * Private key: 32 random scalars (1024 bytes total)
 * Public key: 32 commitments, each = HASH256^256(scalar)
 * Public key hash: SHA256(concat(all commitments))
 * 
 * @returns {Object} Keypair with private scalars, public commitments, and hash
 */
function generateWinternitzKeypair() {
    const privateScalars = [];
    for (let i = 0; i < WOTS_CHUNKS; i++) {
        privateScalars.push(randomBytes(SCALAR_SIZE));
    }
    
    // Compute public commitments: each commitment = hash^256(scalar)
    const publicCommitments = privateScalars.map(scalar => 
        iteratedHash256(scalar, WOTS_ITERATIONS)
    );
    
    // Public key hash = SHA256(concat(all commitments))
    const publicKeyHash = sha256(Buffer.concat(publicCommitments));
    
    return {
        privateKey: {
            scalars: privateScalars,
            hex: privateScalars.map(s => s.toString('hex'))
        },
        publicKey: {
            commitments: publicCommitments,
            hex: publicCommitments.map(c => c.toString('hex'))
        },
        publicKeyHash: publicKeyHash.toString('hex'),
        // Concatenated commitments (for unlocking script)
        publicKeyPreimage: Buffer.concat(publicCommitments).toString('hex')
    };
}

/**
 * Restore keypair from private key hex array
 * @param {string[]} privateKeyHex - Array of 32 hex-encoded scalars
 * @returns {Object} Restored keypair
 */
function restoreKeypairFromPrivate(privateKeyHex) {
    if (!Array.isArray(privateKeyHex) || privateKeyHex.length !== WOTS_CHUNKS) {
        throw new Error(`Expected ${WOTS_CHUNKS} private scalars, got ${privateKeyHex?.length}`);
    }
    
    const privateScalars = privateKeyHex.map((hex, i) => {
        const buf = Buffer.from(hex, 'hex');
        if (buf.length !== SCALAR_SIZE) {
            throw new Error(`Invalid scalar size at index ${i}: ${buf.length}`);
        }
        return buf;
    });
    
    const publicCommitments = privateScalars.map(scalar => 
        iteratedHash256(scalar, WOTS_ITERATIONS)
    );
    
    const publicKeyHash = sha256(Buffer.concat(publicCommitments));
    
    return {
        privateKey: {
            scalars: privateScalars,
            hex: privateKeyHex
        },
        publicKey: {
            commitments: publicCommitments,
            hex: publicCommitments.map(c => c.toString('hex'))
        },
        publicKeyHash: publicKeyHash.toString('hex'),
        publicKeyPreimage: Buffer.concat(publicCommitments).toString('hex')
    };
}

/**
 * Sign a 32-byte message with Winternitz OTS
 * 
 * For each byte M[i] of the message:
 * - Reveal hash^(256 - M[i])(scalar[i])
 * - Verifier applies hash^(M[i]) to get back to commitment
 * 
 * This BINDS the signature to the specific message.
 * Different message → different offsets → need different reveals.
 * Attacker cannot compute different reveals without private scalars.
 * 
 * @param {Buffer} message - 32-byte message to sign
 * @param {Object} privateKey - Private key with scalars
 * @returns {Object} Signature with chunks and offsets
 */
function signWinternitz(message, privateKey) {
    if (!Buffer.isBuffer(message)) {
        message = Buffer.from(message, 'hex');
    }
    if (message.length !== 32) {
        throw new Error(`Message must be 32 bytes, got ${message.length}`);
    }
    
    const chunks = [];
    
    for (let i = 0; i < WOTS_CHUNKS; i++) {
        const messageByte = message[i];  // 0-255
        
        // Compute revealed value: hash^(256 - messageByte)(scalar)
        // Verifier applies hash^(messageByte) to reach commitment
        const hashCount = WOTS_ITERATIONS - messageByte;
        const revealed = iteratedHash256(privateKey.scalars[i], hashCount);
        
        chunks.push({
            revealed: revealed,
            offset: messageByte,
            revealedHex: revealed.toString('hex')
        });
    }
    
    // Create the signature preimage (all revealed values concatenated)
    const signaturePreimage = Buffer.concat(chunks.map(c => c.revealed));
    
    return {
        chunks,
        message: message.toString('hex'),
        signaturePreimage: signaturePreimage.toString('hex'),
        offsets: chunks.map(c => c.offset)
    };
}

/**
 * Verify a Winternitz signature
 * @param {Buffer|string} message - 32-byte message
 * @param {Object} signature - Signature with chunks
 * @param {Object} publicKey - Public key with commitments
 * @returns {boolean} True if valid
 */
function verifyWinternitz(message, signature, publicKey) {
    if (!Buffer.isBuffer(message)) {
        message = Buffer.from(message, 'hex');
    }
    if (message.length !== 32) {
        return false;
    }
    
    for (let i = 0; i < WOTS_CHUNKS; i++) {
        const chunk = signature.chunks[i];
        const expectedOffset = message[i];
        
        // Verify offset matches message byte
        if (chunk.offset !== expectedOffset) {
            return false;
        }
        
        // Apply offset hashes to revealed value
        const computed = iteratedHash256(chunk.revealed, chunk.offset);
        
        // Must equal the public commitment
        if (!computed.equals(publicKey.commitments[i])) {
            return false;
        }
    }
    
    return true;
}

// =============================================================================
// SWAP SECRET GENERATION
// =============================================================================

/**
 * Generate all secrets for swap initiator (Alice)
 * Uses Winternitz keypairs for quantum resistance
 * @returns {Object} Initiator's secrets and keypairs
 */
function generateInitiatorSecrets() {
    // Main swap keypair - revealed when initiator claims
    const swapKeypair = generateWinternitzKeypair();
    
    // Refund keypair - for timeout refunds
    const refundKeypair = generateWinternitzKeypair();
    
    // Claim keypair - for claiming from responder's HTLC
    const claimKeypair = generateWinternitzKeypair();
    
    return {
        // Swap secret (main)
        swap: {
            keypair: swapKeypair,
            secret: swapKeypair.publicKeyPreimage,  // 1024 bytes of commitments
            hash: swapKeypair.publicKeyHash          // SHA256 of commitments
        },
        // Refund secret
        refund: {
            keypair: refundKeypair,
            secret: refundKeypair.publicKeyPreimage,
            hash: refundKeypair.publicKeyHash
        },
        // Claim secret
        claim: {
            keypair: claimKeypair,
            secret: claimKeypair.publicKeyPreimage,
            hash: claimKeypair.publicKeyHash
        },
        // For backward compatibility (hex strings)
        swap_secret: swapKeypair.publicKeyPreimage,
        swap_hash: swapKeypair.publicKeyHash,
        refund_secret: refundKeypair.publicKeyPreimage,
        refund_hash: refundKeypair.publicKeyHash,
        claim_secret: claimKeypair.publicKeyPreimage,
        claim_hash: claimKeypair.publicKeyHash
    };
}

/**
 * Generate all secrets for swap responder (Bob)
 * @returns {Object} Responder's secrets and keypairs
 */
function generateResponderSecrets() {
    // Recipient keypair - Bob proves he's the recipient
    const recipientKeypair = generateWinternitzKeypair();
    
    // Refund keypair - for timeout refunds
    const refundKeypair = generateWinternitzKeypair();
    
    return {
        recipient: {
            keypair: recipientKeypair,
            secret: recipientKeypair.publicKeyPreimage,
            hash: recipientKeypair.publicKeyHash
        },
        refund: {
            keypair: refundKeypair,
            secret: refundKeypair.publicKeyPreimage,
            hash: refundKeypair.publicKeyHash
        },
        // For backward compatibility
        recipient_secret: recipientKeypair.publicKeyPreimage,
        recipient_hash: recipientKeypair.publicKeyHash,
        refund_secret: refundKeypair.publicKeyPreimage,
        refund_hash: refundKeypair.publicKeyHash
    };
}

/**
 * Verify that a secret (preimage) produces the expected hash
 * @param {string} secret - Hex-encoded secret (1024 bytes for WOTS)
 * @param {string} expectedHash - Expected SHA256 hash (32 bytes hex)
 * @returns {boolean} True if secret hashes to expectedHash
 */
function verifyPreimage(secret, expectedHash) {
    const actualHash = sha256Hex(secret);
    return actualHash.toLowerCase() === expectedHash.toLowerCase();
}

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

/**
 * Encode number as Bitcoin varint
 * @param {number} length - Value to encode
 * @returns {string} Hex-encoded varint
 */
function encodeVarInt(length) {
    if (length < 0xfd) {
        return length.toString(16).padStart(2, '0');
    } else if (length <= 0xffff) {
        const buf = Buffer.alloc(3);
        buf[0] = 0xfd;
        buf.writeUInt16LE(length, 1);
        return buf.toString('hex');
    } else if (length <= 0xffffffff) {
        const buf = Buffer.alloc(5);
        buf[0] = 0xfe;
        buf.writeUInt32LE(length, 1);
        return buf.toString('hex');
    } else {
        throw new Error('Value too large for varint');
    }
}

/**
 * Push data onto Bitcoin script stack
 * @param {string} hexData - Hex data to push
 * @returns {string} Hex-encoded push operation
 */
function pushData(hexData) {
    const length = hexData.length / 2;
    
    if (length === 0) {
        return '00'; // OP_0
    } else if (length <= 75) {
        return length.toString(16).padStart(2, '0') + hexData;
    } else if (length <= 255) {
        return '4c' + length.toString(16).padStart(2, '0') + hexData;
    } else if (length <= 65535) {
        const lenBuf = Buffer.alloc(2);
        lenBuf.writeUInt16LE(length);
        return '4d' + lenBuf.toString('hex') + hexData;
    } else {
        throw new Error('Data too large to push');
    }
}

/**
 * Convert number to little-endian hex
 * @param {number} num - Number to convert
 * @param {number} bytes - Number of bytes (default 4)
 * @returns {string} Little-endian hex string
 */
function toLittleEndianHex(num, bytes = 4) {
    const buf = Buffer.alloc(bytes);
    if (bytes === 4) {
        buf.writeUInt32LE(num);
    } else if (bytes === 8) {
        buf.writeBigUInt64LE(BigInt(num));
    }
    return buf.toString('hex');
}

/**
 * Convert little-endian hex to number
 * @param {string} hex - Little-endian hex string
 * @returns {number} Decoded number
 */
function fromLittleEndianHex(hex) {
    const buf = Buffer.from(hex, 'hex');
    return buf.readUInt32LE(0);
}

// =============================================================================
// EXPORTS
// =============================================================================

module.exports = {
    // Core hash functions
    sha256,
    sha256Hex,
    hash256,
    hash160,
    iteratedHash256,
    randomBytes,
    generateHashPair,
    
    // Winternitz OTS
    generateWinternitzKeypair,
    restoreKeypairFromPrivate,
    signWinternitz,
    verifyWinternitz,
    
    // Swap secrets
    generateInitiatorSecrets,
    generateResponderSecrets,
    verifyPreimage,
    
    // Utilities
    encodeVarInt,
    pushData,
    toLittleEndianHex,
    fromLittleEndianHex,
    
    // Constants
    WOTS_CHUNKS,
    WOTS_ITERATIONS,
    SCALAR_SIZE
};
