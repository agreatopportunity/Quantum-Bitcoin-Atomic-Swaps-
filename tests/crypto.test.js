/**
 * Quantum Atomic Swaps v2.0 - Crypto Module Tests
 * 
 * Tests for Winternitz One-Time Signatures and hash functions
 */

const crypto = require('../lib/crypto');

describe('Core Hash Functions', () => {
    
    test('sha256 produces correct 32-byte hash', () => {
        const data = Buffer.from('hello world');
        const hash = crypto.sha256(data);
        
        expect(Buffer.isBuffer(hash)).toBe(true);
        expect(hash.length).toBe(32);
        
        // Known hash value
        expect(hash.toString('hex')).toBe(
            'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9'
        );
    });
    
    test('sha256Hex returns hex string', () => {
        const hash = crypto.sha256Hex('deadbeef');
        expect(typeof hash).toBe('string');
        expect(hash.length).toBe(64);
    });
    
    test('hash256 double hashes correctly', () => {
        const data = Buffer.from('test');
        const hash = crypto.hash256(data);
        
        // hash256 = sha256(sha256(data))
        const expected = crypto.sha256(crypto.sha256(data));
        expect(hash.equals(expected)).toBe(true);
    });
    
    test('hash160 produces 20-byte hash', () => {
        const data = Buffer.from('test');
        const hash = crypto.hash160(data);
        
        expect(hash.length).toBe(20);
    });
    
    test('randomBytes generates unique values', () => {
        const a = crypto.randomBytes(32);
        const b = crypto.randomBytes(32);
        
        expect(a.length).toBe(32);
        expect(b.length).toBe(32);
        expect(a.equals(b)).toBe(false);  // Should be unique
    });
    
    test('generateHashPair creates valid secret/hash pair', () => {
        const pair = crypto.generateHashPair();
        
        expect(pair.secret.length).toBe(64);  // 32 bytes hex
        expect(pair.hash.length).toBe(64);    // 32 bytes hex
        
        // Verify hash is correct
        const computedHash = crypto.sha256Hex(pair.secret);
        expect(computedHash).toBe(pair.hash);
    });
});

describe('Winternitz One-Time Signatures', () => {
    
    test('generateWinternitzKeypair creates valid keypair', () => {
        const keypair = crypto.generateWinternitzKeypair();
        
        // Check structure
        expect(keypair.privateKey).toBeDefined();
        expect(keypair.publicKey).toBeDefined();
        expect(keypair.publicKeyHash).toBeDefined();
        expect(keypair.publicKeyPreimage).toBeDefined();
        
        // Check sizes
        expect(keypair.privateKey.scalars.length).toBe(crypto.WOTS_CHUNKS);
        expect(keypair.publicKey.commitments.length).toBe(crypto.WOTS_CHUNKS);
        expect(keypair.publicKeyHash.length).toBe(64);  // 32 bytes hex
        expect(keypair.publicKeyPreimage.length).toBe(2048);  // 1024 bytes hex
        
        // Verify public key hash is correct
        const commitmentConcat = Buffer.concat(keypair.publicKey.commitments);
        const expectedHash = crypto.sha256Hex(commitmentConcat);
        expect(keypair.publicKeyHash).toBe(expectedHash);
    });
    
    test('restoreKeypairFromPrivate reconstructs keypair', () => {
        const original = crypto.generateWinternitzKeypair();
        const restored = crypto.restoreKeypairFromPrivate(original.privateKey.hex);
        
        expect(restored.publicKeyHash).toBe(original.publicKeyHash);
        expect(restored.publicKeyPreimage).toBe(original.publicKeyPreimage);
    });
    
    test('restoreKeypairFromPrivate rejects invalid input', () => {
        expect(() => {
            crypto.restoreKeypairFromPrivate(['short']);
        }).toThrow();
        
        expect(() => {
            crypto.restoreKeypairFromPrivate(null);
        }).toThrow();
    });
    
    test('signWinternitz creates valid signature', () => {
        const keypair = crypto.generateWinternitzKeypair();
        const message = crypto.randomBytes(32);
        
        const signature = crypto.signWinternitz(message, keypair.privateKey);
        
        expect(signature.chunks.length).toBe(32);
        expect(signature.offsets.length).toBe(32);
        expect(signature.signaturePreimage.length).toBe(2048);  // 1024 bytes hex
        expect(signature.message).toBe(message.toString('hex'));
    });
    
    test('signWinternitz rejects non-32-byte messages', () => {
        const keypair = crypto.generateWinternitzKeypair();
        
        expect(() => {
            crypto.signWinternitz(Buffer.from('short'), keypair.privateKey);
        }).toThrow();
    });
    
    test('verifyWinternitz accepts valid signature', () => {
        const keypair = crypto.generateWinternitzKeypair();
        const message = crypto.randomBytes(32);
        
        const signature = crypto.signWinternitz(message, keypair.privateKey);
        const valid = crypto.verifyWinternitz(message, signature, keypair.publicKey);
        
        expect(valid).toBe(true);
    });
    
    test('verifyWinternitz rejects wrong message', () => {
        const keypair = crypto.generateWinternitzKeypair();
        const message = crypto.randomBytes(32);
        const wrongMessage = crypto.randomBytes(32);
        
        const signature = crypto.signWinternitz(message, keypair.privateKey);
        const valid = crypto.verifyWinternitz(wrongMessage, signature, keypair.publicKey);
        
        expect(valid).toBe(false);
    });
    
    test('verifyWinternitz rejects wrong public key', () => {
        const keypair1 = crypto.generateWinternitzKeypair();
        const keypair2 = crypto.generateWinternitzKeypair();
        const message = crypto.randomBytes(32);
        
        const signature = crypto.signWinternitz(message, keypair1.privateKey);
        const valid = crypto.verifyWinternitz(message, signature, keypair2.publicKey);
        
        expect(valid).toBe(false);
    });
    
    test('signature is deterministic for same message', () => {
        const keypair = crypto.generateWinternitzKeypair();
        const message = crypto.randomBytes(32);
        
        const sig1 = crypto.signWinternitz(message, keypair.privateKey);
        const sig2 = crypto.signWinternitz(message, keypair.privateKey);
        
        expect(sig1.signaturePreimage).toBe(sig2.signaturePreimage);
    });
});

describe('Swap Secret Generation', () => {
    
    test('generateInitiatorSecrets creates all required secrets', () => {
        const secrets = crypto.generateInitiatorSecrets();
        
        // Check swap secret
        expect(secrets.swap).toBeDefined();
        expect(secrets.swap.keypair).toBeDefined();
        expect(secrets.swap.secret.length).toBe(2048);  // 1024 bytes hex
        expect(secrets.swap.hash.length).toBe(64);       // 32 bytes hex
        
        // Check refund secret
        expect(secrets.refund).toBeDefined();
        expect(secrets.refund.secret.length).toBe(2048);
        expect(secrets.refund.hash.length).toBe(64);
        
        // Check claim secret
        expect(secrets.claim).toBeDefined();
        expect(secrets.claim.secret.length).toBe(2048);
        expect(secrets.claim.hash.length).toBe(64);
        
        // Check backward compatibility fields
        expect(secrets.swap_secret).toBe(secrets.swap.secret);
        expect(secrets.swap_hash).toBe(secrets.swap.hash);
    });
    
    test('generateResponderSecrets creates all required secrets', () => {
        const secrets = crypto.generateResponderSecrets();
        
        // Check recipient secret
        expect(secrets.recipient).toBeDefined();
        expect(secrets.recipient.secret.length).toBe(2048);
        expect(secrets.recipient.hash.length).toBe(64);
        
        // Check refund secret
        expect(secrets.refund).toBeDefined();
        expect(secrets.refund.secret.length).toBe(2048);
        expect(secrets.refund.hash.length).toBe(64);
        
        // Check backward compatibility
        expect(secrets.recipient_secret).toBe(secrets.recipient.secret);
        expect(secrets.recipient_hash).toBe(secrets.recipient.hash);
    });
    
    test('verifyPreimage validates correct preimage', () => {
        const secrets = crypto.generateInitiatorSecrets();
        
        const valid = crypto.verifyPreimage(
            secrets.swap_secret,
            secrets.swap_hash
        );
        
        expect(valid).toBe(true);
    });
    
    test('verifyPreimage rejects wrong preimage', () => {
        const secrets1 = crypto.generateInitiatorSecrets();
        const secrets2 = crypto.generateInitiatorSecrets();
        
        const valid = crypto.verifyPreimage(
            secrets1.swap_secret,
            secrets2.swap_hash
        );
        
        expect(valid).toBe(false);
    });
});

describe('Utility Functions', () => {
    
    test('encodeVarInt handles small values', () => {
        expect(crypto.encodeVarInt(0)).toBe('00');
        expect(crypto.encodeVarInt(1)).toBe('01');
        expect(crypto.encodeVarInt(252)).toBe('fc');
    });
    
    test('encodeVarInt handles medium values', () => {
        const encoded = crypto.encodeVarInt(253);
        expect(encoded.startsWith('fd')).toBe(true);
        expect(encoded.length).toBe(6);  // fd + 2 bytes LE
    });
    
    test('encodeVarInt handles large values', () => {
        const encoded = crypto.encodeVarInt(70000);
        expect(encoded.startsWith('fe')).toBe(true);
        expect(encoded.length).toBe(10);  // fe + 4 bytes LE
    });
    
    test('pushData handles small data', () => {
        const data = 'abcd';  // 2 bytes
        const pushed = crypto.pushData(data);
        expect(pushed).toBe('02abcd');
    });
    
    test('pushData handles 75+ byte data', () => {
        const data = 'aa'.repeat(100);  // 100 bytes
        const pushed = crypto.pushData(data);
        expect(pushed.startsWith('4c64')).toBe(true);  // OP_PUSHDATA1 + 0x64 (100)
    });
    
    test('pushData handles 255+ byte data', () => {
        const data = 'bb'.repeat(300);  // 300 bytes
        const pushed = crypto.pushData(data);
        expect(pushed.startsWith('4d')).toBe(true);  // OP_PUSHDATA2
    });
    
    test('toLittleEndianHex converts correctly', () => {
        expect(crypto.toLittleEndianHex(1)).toBe('01000000');
        expect(crypto.toLittleEndianHex(256)).toBe('00010000');
        expect(crypto.toLittleEndianHex(0xdeadbeef)).toBe('efbeadde');
    });
    
    test('fromLittleEndianHex reverses correctly', () => {
        expect(crypto.fromLittleEndianHex('01000000')).toBe(1);
        expect(crypto.fromLittleEndianHex('00010000')).toBe(256);
    });
});

describe('Security Properties', () => {
    
    test('different messages produce different signatures', () => {
        const keypair = crypto.generateWinternitzKeypair();
        const msg1 = crypto.sha256(Buffer.from('message 1'));
        const msg2 = crypto.sha256(Buffer.from('message 2'));
        
        const sig1 = crypto.signWinternitz(msg1, keypair.privateKey);
        const sig2 = crypto.signWinternitz(msg2, keypair.privateKey);
        
        expect(sig1.signaturePreimage).not.toBe(sig2.signaturePreimage);
    });
    
    test('signature binds to exact message bytes', () => {
        const keypair = crypto.generateWinternitzKeypair();
        const message = crypto.randomBytes(32);
        
        const signature = crypto.signWinternitz(message, keypair.privateKey);
        
        // Each offset should match the corresponding message byte
        for (let i = 0; i < 32; i++) {
            expect(signature.offsets[i]).toBe(message[i]);
        }
    });
    
    test('public key preimage hashes to public key hash', () => {
        const keypair = crypto.generateWinternitzKeypair();
        
        const computedHash = crypto.sha256Hex(keypair.publicKeyPreimage);
        expect(computedHash).toBe(keypair.publicKeyHash);
    });
});
