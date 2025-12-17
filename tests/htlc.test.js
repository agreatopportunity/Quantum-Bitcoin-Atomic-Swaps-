/**
 * Quantum Atomic Swaps v2.0 - HTLC Module Tests
 * 
 * Tests for Hash Time-Locked Contract script generation
 */

const htlc = require('../lib/htlc');
const crypto = require('../lib/crypto');

describe('HTLC Script Creation', () => {
    
    const validParams = {
        swapHash: crypto.sha256Hex('deadbeef'.repeat(8)),
        recipientHash: crypto.sha256Hex('cafebabe'.repeat(8)),
        refundHash: crypto.sha256Hex('12345678'.repeat(8)),
        timeout: Math.floor(Date.now() / 1000) + 3600  // 1 hour from now
    };
    
    test('createHTLCScript generates valid script', () => {
        const result = htlc.createHTLCScript(validParams);
        
        expect(result.redeemScript).toBeDefined();
        expect(result.redeemScriptHash).toBeDefined();
        expect(result.sha256Hash).toBeDefined();
        expect(result.swapHash).toBe(validParams.swapHash);
        expect(result.recipientHash).toBe(validParams.recipientHash);
        expect(result.refundHash).toBe(validParams.refundHash);
        expect(result.timeout).toBe(validParams.timeout);
    });
    
    test('createHTLCScript includes proper opcodes', () => {
        const result = htlc.createHTLCScript(validParams);
        const script = result.redeemScript;
        
        // Should start with OP_IF
        expect(script.startsWith('63')).toBe(true);
        
        // Should contain OP_SHA256 (a8)
        expect(script.includes('a8')).toBe(true);
        
        // Should contain OP_CHECKLOCKTIMEVERIFY (b1)
        expect(script.includes('b1')).toBe(true);
        
        // Should end with OP_ENDIF (68)
        expect(script.endsWith('68')).toBe(true);
    });
    
    test('createHTLCScript rejects invalid swap hash', () => {
        expect(() => {
            htlc.createHTLCScript({
                ...validParams,
                swapHash: 'invalid'
            });
        }).toThrow('Invalid swap hash');
    });
    
    test('createHTLCScript rejects invalid timeout', () => {
        expect(() => {
            htlc.createHTLCScript({
                ...validParams,
                timeout: 0
            });
        }).toThrow('Invalid timeout');
    });
});

describe('HTLC Creation for Different Chains', () => {
    
    const params = {
        swapHash: crypto.sha256Hex('deadbeef'.repeat(8)),
        recipientHash: crypto.sha256Hex('cafebabe'.repeat(8)),
        refundHash: crypto.sha256Hex('12345678'.repeat(8)),
        timeout: Math.floor(Date.now() / 1000) + 3600
    };
    
    test('createHTLC for BSV uses bare script', () => {
        const result = htlc.createHTLC(params, 'BSV', 'mainnet');
        
        expect(result.chain).toBe('BSV');
        expect(result.outputType).toBe('bare-script');
        expect(result.address).toBeNull();  // BSV bare scripts have no standard address
        expect(result.lockingScript).toBe(result.redeemScript);
        expect(result.scriptHash).toBeDefined();
        expect(result.fundingNote).toContain('BARE_SCRIPT');
    });
    
    test('createHTLC for BTC uses P2SH', () => {
        const result = htlc.createHTLC(params, 'BTC', 'mainnet');
        
        expect(result.chain).toBe('BTC');
        expect(result.outputType).toBe('p2sh');
        expect(result.address).toBeDefined();
        expect(result.address.startsWith('3')).toBe(true);  // Mainnet P2SH
    });
    
    test('createHTLC for BTC testnet uses correct prefix', () => {
        const result = htlc.createHTLC(params, 'BTC', 'testnet');
        
        expect(result.address.startsWith('2')).toBe(true);  // Testnet P2SH
    });
    
    test('scriptASM is human-readable', () => {
        const result = htlc.createHTLC(params, 'BSV');
        
        expect(result.scriptASM).toBeDefined();
        expect(result.scriptASM).toContain('OP_IF');
        expect(result.scriptASM).toContain('OP_SHA256');
        expect(result.scriptASM).toContain('OP_CHECKLOCKTIMEVERIFY');
        expect(result.scriptASM).toContain('OP_ENDIF');
    });
});

describe('ScriptSig Creation', () => {
    
    test('createClaimScriptSig generates valid BSV scriptSig', () => {
        const swapPreimage = 'aa'.repeat(32);  // 32 bytes
        const recipientPreimage = 'bb'.repeat(32);
        const redeemScript = '63' + 'a8' + '20' + 'cc'.repeat(32) + '87';  // Simplified
        
        const scriptSig = htlc.createClaimScriptSig(
            swapPreimage,
            recipientPreimage,
            redeemScript,
            'BSV'
        );
        
        // Should contain both preimages
        expect(scriptSig.includes(swapPreimage)).toBe(true);
        expect(scriptSig.includes(recipientPreimage)).toBe(true);
        
        // Should contain OP_TRUE (51) for IF branch
        expect(scriptSig.includes('51')).toBe(true);
        
        // BSV bare script: should NOT include redeem script
        expect(scriptSig.includes(redeemScript)).toBe(false);
    });
    
    test('createClaimScriptSig generates valid BTC scriptSig', () => {
        const swapPreimage = 'aa'.repeat(32);
        const recipientPreimage = 'bb'.repeat(32);
        const redeemScript = '63' + 'a8' + '20' + 'cc'.repeat(32) + '87';
        
        const scriptSig = htlc.createClaimScriptSig(
            swapPreimage,
            recipientPreimage,
            redeemScript,
            'BTC'
        );
        
        // BTC P2SH: MUST include redeem script
        expect(scriptSig.includes(redeemScript)).toBe(true);
    });
    
    test('createClaimScriptSig handles Winternitz preimages', () => {
        const swapPreimage = 'aa'.repeat(1024);  // 1024 bytes (Winternitz)
        const recipientPreimage = 'bb'.repeat(1024);
        const redeemScript = '63a8' + '20' + 'cc'.repeat(32) + '87';
        
        const scriptSig = htlc.createClaimScriptSig(
            swapPreimage,
            recipientPreimage,
            redeemScript,
            'BSV'
        );
        
        // Should use PUSHDATA2 (4d) for large data
        expect(scriptSig.includes('4d')).toBe(true);
    });
    
    test('createRefundScriptSig generates valid scriptSig', () => {
        const refundPreimage = 'dd'.repeat(32);
        const redeemScript = '63a8' + '20' + 'cc'.repeat(32) + '87';
        
        const scriptSig = htlc.createRefundScriptSig(
            refundPreimage,
            redeemScript,
            'BSV'
        );
        
        // Should contain refund preimage
        expect(scriptSig.includes(refundPreimage)).toBe(true);
        
        // Should contain OP_FALSE (00) for ELSE branch
        expect(scriptSig.startsWith('20')).toBe(true);  // Push 32 bytes
    });
});

describe('HTLC Script Parsing', () => {
    
    test('parseHTLCScript extracts correct values', () => {
        const params = {
            swapHash: crypto.sha256Hex('swap_secret'),
            recipientHash: crypto.sha256Hex('recipient_secret'),
            refundHash: crypto.sha256Hex('refund_secret'),
            timeout: 1700000000
        };
        
        const created = htlc.createHTLCScript(params);
        const parsed = htlc.parseHTLCScript(created.redeemScript);
        
        expect(parsed.valid).toBe(true);
        expect(parsed.swapHash).toBe(params.swapHash);
        expect(parsed.recipientHash).toBe(params.recipientHash);
        expect(parsed.refundHash).toBe(params.refundHash);
        expect(parsed.timeout).toBe(params.timeout);
    });
    
    test('parseHTLCScript provides timeout date', () => {
        const params = {
            swapHash: crypto.sha256Hex('swap'),
            recipientHash: crypto.sha256Hex('recipient'),
            refundHash: crypto.sha256Hex('refund'),
            timeout: Math.floor(Date.now() / 1000) + 3600
        };
        
        const created = htlc.createHTLCScript(params);
        const parsed = htlc.parseHTLCScript(created.redeemScript);
        
        expect(parsed.timeoutDate).toBeDefined();
        expect(parsed.timeoutHex).toBe(created.timeoutHex);
    });
    
    test('parseHTLCScript throws on invalid script', () => {
        expect(() => {
            htlc.parseHTLCScript('00');  // Just OP_FALSE
        }).toThrow();
        
        expect(() => {
            htlc.parseHTLCScript('abcdef');  // Random bytes
        }).toThrow();
    });
});

describe('Script ASM Decoding', () => {
    
    test('decodeScriptToASM handles standard opcodes', () => {
        const script = '63a8205151515151515151515151515151515151515151515151515151515151515151878768';
        const asm = htlc.decodeScriptToASM(script);
        
        expect(asm).toContain('OP_IF');
        expect(asm).toContain('OP_SHA256');
        expect(asm).toContain('OP_EQUAL');
        expect(asm).toContain('OP_ENDIF');
    });
    
    test('decodeScriptToASM handles push operations', () => {
        const script = '0401020304';  // Push 4 bytes
        const asm = htlc.decodeScriptToASM(script);
        
        expect(asm).toContain('<01020304>');
    });
    
    test('decodeScriptToASM truncates large data', () => {
        // Push 100 bytes
        const data = 'aa'.repeat(100);
        const script = '4c64' + data;  // OP_PUSHDATA1 + 100
        const asm = htlc.decodeScriptToASM(script);
        
        expect(asm).toContain('PUSHDATA1:100B');
    });
});

describe('Number Encoding', () => {
    
    test('encodeMinimalNumber handles small values', () => {
        expect(htlc.encodeMinimalNumber(0)).toBe('');
        expect(htlc.encodeMinimalNumber(1)).toBe('01');
        expect(htlc.encodeMinimalNumber(127)).toBe('7f');
    });
    
    test('encodeMinimalNumber adds sign byte when needed', () => {
        // 128 has high bit set, needs sign byte
        const encoded = htlc.encodeMinimalNumber(128);
        expect(encoded).toBe('8000');
    });
    
    test('encodeMinimalNumber handles large values', () => {
        const timestamp = 1700000000;  // ~Nov 2023
        const encoded = htlc.encodeMinimalNumber(timestamp);
        
        // Decode it back
        const decoded = htlc.decodeMinimalNumber(encoded);
        expect(decoded).toBe(timestamp);
    });
    
    test('decodeMinimalNumber reverses encoding', () => {
        const values = [0, 1, 127, 128, 255, 256, 65535, 1000000, 1700000000];
        
        for (const value of values) {
            const encoded = htlc.encodeMinimalNumber(value);
            const decoded = htlc.decodeMinimalNumber(encoded);
            expect(decoded).toBe(value);
        }
    });
});

describe('Fee Estimation', () => {
    
    test('estimateScriptSigSize for Winternitz', () => {
        const htlcObj = {
            redeemScript: 'aa'.repeat(100),  // 100-byte script
            chain: 'BSV'
        };
        
        const size = htlc.estimateScriptSigSize(htlcObj, true);
        
        // 1024 + 1024 + overhead for Winternitz
        expect(size).toBeGreaterThan(2000);
    });
    
    test('estimateScriptSigSize for simple preimages', () => {
        const htlcObj = {
            redeemScript: 'aa'.repeat(100),
            chain: 'BTC'
        };
        
        const size = htlc.estimateScriptSigSize(htlcObj, false);
        
        // 32 + 32 + script + overhead
        expect(size).toBeLessThan(200);
    });
    
    test('BTC P2SH includes redeem script in estimate', () => {
        const htlcObj = {
            redeemScript: 'bb'.repeat(100),
            chain: 'BTC'
        };
        
        const bsvSize = htlc.estimateScriptSigSize({ ...htlcObj, chain: 'BSV' }, false);
        const btcSize = htlc.estimateScriptSigSize(htlcObj, false);
        
        // BTC should be larger (includes redeem script)
        expect(btcSize).toBeGreaterThan(bsvSize);
    });
});

describe('P2SH Address Generation', () => {
    
    test('scriptHashToP2SH generates mainnet address', () => {
        const scriptHash = crypto.hash160('test_script').toString('hex');
        const address = htlc.scriptHashToP2SH(scriptHash, 'mainnet');
        
        expect(address.startsWith('3')).toBe(true);
    });
    
    test('scriptHashToP2SH generates testnet address', () => {
        const scriptHash = crypto.hash160('test_script').toString('hex');
        const address = htlc.scriptHashToP2SH(scriptHash, 'testnet');
        
        expect(address.startsWith('2')).toBe(true);
    });
    
    test('createP2SHScriptPubKey generates correct format', () => {
        const scriptHash = 'aa'.repeat(20);  // 20 bytes
        const scriptPubKey = htlc.createP2SHScriptPubKey(scriptHash);
        
        // OP_HASH160 <20 bytes> OP_EQUAL
        expect(scriptPubKey.startsWith('a9')).toBe(true);  // OP_HASH160
        expect(scriptPubKey.endsWith('87')).toBe(true);    // OP_EQUAL
        expect(scriptPubKey.length).toBe(46);               // a9 + 14 + hash + 87
    });
});

describe('Integration: Full HTLC Flow', () => {
    
    test('create, fund, and claim flow', () => {
        // Generate secrets
        const initiatorSecrets = crypto.generateInitiatorSecrets();
        const responderSecrets = crypto.generateResponderSecrets();
        
        const timeout = Math.floor(Date.now() / 1000) + 3600;
        
        // Create HTLC
        const htlcResult = htlc.createHTLC({
            swapHash: initiatorSecrets.swap_hash,
            recipientHash: responderSecrets.recipient_hash,
            refundHash: initiatorSecrets.refund_hash,
            timeout
        }, 'BSV', 'mainnet');
        
        // Verify HTLC was created correctly
        expect(htlcResult.swapHash).toBe(initiatorSecrets.swap_hash);
        expect(htlcResult.recipientHash).toBe(responderSecrets.recipient_hash);
        
        // Create claim scriptSig
        const claimScriptSig = htlc.createClaimScriptSig(
            initiatorSecrets.swap_secret,
            responderSecrets.recipient_secret,
            htlcResult.redeemScript,
            'BSV'
        );
        
        // Verify scriptSig contains the secrets
        expect(claimScriptSig.includes(initiatorSecrets.swap_secret)).toBe(true);
        expect(claimScriptSig.includes(responderSecrets.recipient_secret)).toBe(true);
        
        // Verify secrets hash to committed values
        expect(crypto.verifyPreimage(
            initiatorSecrets.swap_secret,
            htlcResult.swapHash
        )).toBe(true);
        
        expect(crypto.verifyPreimage(
            responderSecrets.recipient_secret,
            htlcResult.recipientHash
        )).toBe(true);
    });
});
