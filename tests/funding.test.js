/**
 * Quantum Atomic Swaps v2.0 - Funding Module Tests
 * 
 * Tests for funding transaction builders
 */

const funding = require('../lib/funding');
const htlc = require('../lib/htlc');
const crypto = require('../lib/crypto');

describe('BSV Funding Transaction Builder', () => {
    
    const mockUTXOs = [
        {
            txid: 'a'.repeat(64),
            vout: 0,
            satoshis: 100000,
            scriptPubKey: '76a914' + 'b'.repeat(40) + '88ac'
        }
    ];
    
    const mockLockingScript = '63a8' + '20' + 'c'.repeat(64) + '8788' + '67' + '04' + 'deadbeef' + 'b175' + 'a8' + '20' + 'd'.repeat(64) + '87' + '68';
    
    test('buildBSVFundingTx creates valid transaction structure', () => {
        const result = funding.buildBSVFundingTx({
            utxos: mockUTXOs,
            lockingScript: mockLockingScript,
            amount: 50000,
            changeAddress: '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2',
            feeRate: 1
        });
        
        expect(result.success).toBe(true);
        expect(result.chain).toBe('BSV');
        expect(result.type).toBe('bare-script-funding');
        expect(result.transaction).toBeDefined();
        expect(result.rawTxUnsigned).toBeDefined();
    });
    
    test('buildBSVFundingTx calculates correct amounts', () => {
        const result = funding.buildBSVFundingTx({
            utxos: mockUTXOs,
            lockingScript: mockLockingScript,
            amount: 50000,
            changeAddress: '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2',
            feeRate: 1
        });
        
        expect(result.htlcAmount).toBe(50000);
        expect(result.totalInput).toBe(100000);
        expect(result.changeAmount).toBeGreaterThan(0);
        expect(result.estimatedFee).toBeGreaterThan(0);
        
        // Verify: input = htlc + change + fee
        const expectedChange = 100000 - 50000 - result.estimatedFee;
        expect(Math.abs(result.changeAmount - expectedChange)).toBeLessThan(10);
    });
    
    test('buildBSVFundingTx rejects P2SH addresses', () => {
        expect(() => {
            funding.buildBSVFundingTx({
                utxos: mockUTXOs,
                lockingScript: mockLockingScript,
                amount: 50000,
                changeAddress: '3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy',  // P2SH
                feeRate: 1
            });
        }).toThrow('P2SH');
    });
    
    test('buildBSVFundingTx rejects insufficient funds', () => {
        expect(() => {
            funding.buildBSVFundingTx({
                utxos: mockUTXOs,
                lockingScript: mockLockingScript,
                amount: 1000000,  // More than available
                changeAddress: '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2',
                feeRate: 1
            });
        }).toThrow('Insufficient funds');
    });
    
    test('buildBSVFundingTx includes HTLC output correctly', () => {
        const result = funding.buildBSVFundingTx({
            utxos: mockUTXOs,
            lockingScript: mockLockingScript,
            amount: 50000,
            changeAddress: '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2',
            feeRate: 1
        });
        
        const htlcOutput = result.transaction.outputs[0];
        expect(htlcOutput.type).toBe('bare-htlc');
        expect(htlcOutput.scriptPubKey).toBe(mockLockingScript);
        expect(htlcOutput.satoshis).toBe(50000);
    });
    
    test('buildBSVFundingTx provides script hash for lookup', () => {
        const result = funding.buildBSVFundingTx({
            utxos: mockUTXOs,
            lockingScript: mockLockingScript,
            amount: 50000,
            changeAddress: '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2',
            feeRate: 1
        });
        
        expect(result.htlcOutput.scriptHash).toBeDefined();
        expect(result.htlcOutput.scriptHash.length).toBe(64);
        
        // Verify it's the correct hash
        const expectedHash = crypto.sha256Hex(mockLockingScript);
        expect(result.htlcOutput.scriptHash).toBe(expectedHash);
    });
    
    test('buildBSVFundingTx provides signing instructions', () => {
        const result = funding.buildBSVFundingTx({
            utxos: mockUTXOs,
            lockingScript: mockLockingScript,
            amount: 50000,
            changeAddress: '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2',
            feeRate: 1
        });
        
        expect(result.signingInstructions).toBeDefined();
        expect(result.signingInstructions.inputs.length).toBe(1);
        expect(result.signingInstructions.inputs[0].sighashType).toContain('FORKID');
    });
});

describe('BTC Funding Transaction Builder', () => {
    
    const mockUTXOs = [
        {
            txid: 'a'.repeat(64),
            vout: 0,
            satoshis: 100000,
            scriptPubKey: '76a914' + 'b'.repeat(40) + '88ac'
        }
    ];
    
    const mockRedeemScript = '63a8' + '20' + 'c'.repeat(64) + '87';
    
    test('buildBTCFundingTx creates valid P2SH transaction', () => {
        const result = funding.buildBTCFundingTx({
            utxos: mockUTXOs,
            redeemScript: mockRedeemScript,
            p2shAddress: '3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy',
            amount: 50000,
            changeAddress: '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2',
            feeRate: 10
        });
        
        expect(result.success).toBe(true);
        expect(result.chain).toBe('BTC');
        expect(result.type).toBe('p2sh-funding');
    });
    
    test('buildBTCFundingTx outputs to P2SH address', () => {
        const result = funding.buildBTCFundingTx({
            utxos: mockUTXOs,
            redeemScript: mockRedeemScript,
            p2shAddress: '3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy',
            amount: 50000,
            changeAddress: '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2',
            feeRate: 10
        });
        
        const htlcOutput = result.transaction.outputs[0];
        expect(htlcOutput.type).toBe('p2sh-htlc');
        expect(htlcOutput.scriptPubKey.startsWith('a914')).toBe(true);
        expect(htlcOutput.scriptPubKey.endsWith('87')).toBe(true);
    });
    
    test('buildBTCFundingTx handles bech32 change addresses', () => {
        const result = funding.buildBTCFundingTx({
            utxos: mockUTXOs,
            redeemScript: mockRedeemScript,
            p2shAddress: '3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy',
            amount: 50000,
            changeAddress: 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq',
            feeRate: 10
        });
        
        expect(result.success).toBe(true);
        
        if (result.changeAmount > 546) {
            const changeOutput = result.transaction.outputs[1];
            expect(changeOutput.scriptPubKey.startsWith('0014')).toBe(true);  // P2WPKH
        }
    });
    
    test('buildBTCFundingTx uses higher fees than BSV', () => {
        const bsvResult = funding.buildBSVFundingTx({
            utxos: mockUTXOs,
            lockingScript: mockRedeemScript,
            amount: 50000,
            changeAddress: '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2',
            feeRate: 1
        });
        
        const btcResult = funding.buildBTCFundingTx({
            utxos: mockUTXOs,
            redeemScript: mockRedeemScript,
            p2shAddress: '3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy',
            amount: 50000,
            changeAddress: '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2',
            feeRate: 10
        });
        
        expect(btcResult.estimatedFee).toBeGreaterThan(bsvResult.estimatedFee);
    });
});

describe('Raw Transaction Building', () => {
    
    test('buildRawTxHex generates valid hex', () => {
        const tx = {
            version: 1,
            inputs: [
                {
                    txid: 'a'.repeat(64),
                    vout: 0,
                    sequence: 0xfffffffe,
                    scriptSig: null
                }
            ],
            outputs: [
                {
                    satoshis: 50000,
                    scriptPubKey: '76a914' + 'b'.repeat(40) + '88ac'
                }
            ],
            locktime: 0
        };
        
        const hex = funding.buildRawTxHex(tx, false);
        
        // Should be valid hex
        expect(/^[0-9a-f]+$/i.test(hex)).toBe(true);
        
        // Version should be at start (01000000)
        expect(hex.startsWith('01000000')).toBe(true);
        
        // Should end with locktime (00000000)
        expect(hex.endsWith('00000000')).toBe(true);
    });
    
    test('buildRawTxHex includes input correctly', () => {
        const txid = 'deadbeef'.repeat(8);
        const tx = {
            version: 1,
            inputs: [{
                txid,
                vout: 1,
                sequence: 0xffffffff,
                scriptSig: null
            }],
            outputs: [{
                satoshis: 1000,
                scriptPubKey: '00'
            }],
            locktime: 0
        };
        
        const hex = funding.buildRawTxHex(tx, false);
        
        // Input txid should be reversed
        const reversedTxid = txid.match(/../g).reverse().join('');
        expect(hex.includes(reversedTxid)).toBe(true);
    });
});

describe('Address Helpers', () => {
    
    test('addressToP2PKH generates correct scriptPubKey', () => {
        // Known address -> scriptPubKey mapping
        const scriptPubKey = funding.addressToP2PKH('1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2');
        
        expect(scriptPubKey.startsWith('76a914')).toBe(true);  // OP_DUP OP_HASH160 <20>
        expect(scriptPubKey.endsWith('88ac')).toBe(true);      // OP_EQUALVERIFY OP_CHECKSIG
        expect(scriptPubKey.length).toBe(50);                   // Full P2PKH scriptPubKey
    });
    
    test('bech32ToScriptPubKey handles P2WPKH', () => {
        const scriptPubKey = funding.bech32ToScriptPubKey('bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq');
        
        expect(scriptPubKey.startsWith('0014')).toBe(true);  // witness version 0, 20 bytes
        expect(scriptPubKey.length).toBe(44);                 // 0014 + 40 hex chars
    });
    
    test('addressToP2PKH throws on invalid address', () => {
        expect(() => {
            funding.addressToP2PKH('invalid');
        }).toThrow();
    });
});

describe('Integration: Full Funding Flow', () => {
    
    test('create HTLC and build funding transaction', () => {
        // Step 1: Generate secrets
        const initiatorSecrets = crypto.generateInitiatorSecrets();
        const responderSecrets = crypto.generateResponderSecrets();
        
        // Step 2: Create HTLC
        const htlcResult = htlc.createHTLC({
            swapHash: initiatorSecrets.swap_hash,
            recipientHash: responderSecrets.recipient_hash,
            refundHash: initiatorSecrets.refund_hash,
            timeout: Math.floor(Date.now() / 1000) + 3600
        }, 'BSV', 'mainnet');
        
        // Step 3: Build funding transaction
        const mockUTXOs = [{
            txid: crypto.sha256Hex('test').repeat(2),
            vout: 0,
            satoshis: 100000,
            scriptPubKey: '76a914' + crypto.hash160('pubkey').toString('hex') + '88ac'
        }];
        
        const fundingTx = funding.buildBSVFundingTx({
            utxos: mockUTXOs,
            lockingScript: htlcResult.lockingScript,
            amount: 50000,
            changeAddress: '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2',
            feeRate: 1
        });
        
        // Verify
        expect(fundingTx.success).toBe(true);
        expect(fundingTx.htlcOutput.scriptPubKey).toBe(htlcResult.lockingScript);
        expect(fundingTx.htlcOutput.scriptHash).toBe(htlcResult.sha256Hash);
    });
});
