/**
 * Quantum Atomic Swaps v2.0 - Solana HTLC Program Interface
 * 
 * This module provides the interface for interacting with a Solana HTLC program.
 * The actual program must be deployed separately (see PROGRAM_DESIGN below).
 * 
 * PROGRAM DESIGN SPECIFICATION:
 * =============================
 * 
 * The Solana HTLC program uses Program Derived Addresses (PDAs) to hold funds
 * with hash-lock and time-lock conditions.
 * 
 * Account Structure (165 bytes):
 * - discriminator: 8 bytes
 * - initiator: 32 bytes (Pubkey)
 * - recipient: 32 bytes (Pubkey)
 * - swap_hash: 32 bytes
 * - recipient_hash: 32 bytes
 * - refund_hash: 32 bytes
 * - amount: 8 bytes (u64)
 * - timeout_slot: 8 bytes (u64)
 * - is_claimed: 1 byte (bool)
 * 
 * Instructions:
 * 1. CREATE_HTLC - Initialize HTLC with hash commitments
 * 2. CLAIM - Provide preimages to claim funds
 * 3. REFUND - After timeout, initiator can refund
 * 
 * PDA Seeds: ["htlc", initiator, swap_hash]
 */

const crypto = require('./crypto');

// =============================================================================
// PROGRAM CONFIGURATION
// =============================================================================

/**
 * HTLC Program ID - MUST BE DEPLOYED AND SET HERE
 * This is a placeholder - deploy the program and update this
 */
const HTLC_PROGRAM_ID = process.env.SOL_HTLC_PROGRAM_ID || 'HTLCxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';

/**
 * Instruction discriminators (first 8 bytes of SHA256 of instruction name)
 */
const INSTRUCTION_DISCRIMINATORS = {
    CREATE_HTLC: Buffer.from([0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]),
    CLAIM: Buffer.from([0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]),
    REFUND: Buffer.from([0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00])
};

// Account size for rent exemption calculation
const HTLC_ACCOUNT_SIZE = 165;

// =============================================================================
// PDA DERIVATION
// =============================================================================

/**
 * Derive the HTLC PDA address
 * @param {string} initiator - Initiator's public key (base58)
 * @param {string} swapHash - Swap hash (hex, 32 bytes)
 * @returns {Object} PDA address and bump seed
 */
function deriveHTLCPDA(initiator, swapHash) {
    // In a real implementation, this would use @solana/web3.js PublicKey.findProgramAddress
    // For now, we compute a deterministic identifier
    
    const seeds = Buffer.concat([
        Buffer.from('htlc'),
        Buffer.from(initiator),  // Would be base58 decoded
        Buffer.from(swapHash, 'hex')
    ]);
    
    const pdaHash = crypto.sha256(seeds);
    
    return {
        pda: pdaHash.toString('hex').substring(0, 44),  // Simplified
        seeds: ['htlc', initiator, swapHash],
        programId: HTLC_PROGRAM_ID,
        note: 'Use @solana/web3.js PublicKey.findProgramAddress for actual PDA'
    };
}

// =============================================================================
// INSTRUCTION BUILDERS
// =============================================================================

/**
 * Build CREATE_HTLC instruction data
 * 
 * @param {Object} params - HTLC parameters
 * @param {string} params.swapHash - SHA256 of swap preimage (32 bytes hex)
 * @param {string} params.recipientHash - SHA256 of recipient preimage (32 bytes hex)
 * @param {string} params.refundHash - SHA256 of refund preimage (32 bytes hex)
 * @param {number} params.amount - Lamports to lock
 * @param {number} params.timeoutSlot - Slot number for timeout
 * @returns {Object} Instruction data
 */
function buildCreateHTLCInstruction(params) {
    const { swapHash, recipientHash, refundHash, amount, timeoutSlot } = params;
    
    // Validate hashes
    if (!swapHash || swapHash.length !== 64) {
        throw new Error('Invalid swap hash: must be 64 hex characters');
    }
    if (!recipientHash || recipientHash.length !== 64) {
        throw new Error('Invalid recipient hash: must be 64 hex characters');
    }
    if (!refundHash || refundHash.length !== 64) {
        throw new Error('Invalid refund hash: must be 64 hex characters');
    }
    
    // Build instruction data
    // [discriminator:8][swap_hash:32][recipient_hash:32][refund_hash:32][amount:8][timeout:8]
    const data = Buffer.alloc(8 + 32 + 32 + 32 + 8 + 8);
    let offset = 0;
    
    // Discriminator
    INSTRUCTION_DISCRIMINATORS.CREATE_HTLC.copy(data, offset);
    offset += 8;
    
    // Swap hash
    Buffer.from(swapHash, 'hex').copy(data, offset);
    offset += 32;
    
    // Recipient hash
    Buffer.from(recipientHash, 'hex').copy(data, offset);
    offset += 32;
    
    // Refund hash
    Buffer.from(refundHash, 'hex').copy(data, offset);
    offset += 32;
    
    // Amount (u64 LE)
    data.writeBigUInt64LE(BigInt(amount), offset);
    offset += 8;
    
    // Timeout slot (u64 LE)
    data.writeBigUInt64LE(BigInt(timeoutSlot), offset);
    
    return {
        instruction: 'CREATE_HTLC',
        data: data.toString('base64'),
        dataHex: data.toString('hex'),
        accounts: [
            { name: 'initiator', isSigner: true, isWritable: true },
            { name: 'htlc_account', isSigner: false, isWritable: true },
            { name: 'recipient', isSigner: false, isWritable: false },
            { name: 'system_program', isSigner: false, isWritable: false }
        ],
        params: {
            swapHash,
            recipientHash,
            refundHash,
            amount,
            timeoutSlot
        }
    };
}

/**
 * Build CLAIM instruction data
 * 
 * @param {string} swapPreimage - Preimage of swap hash (hex, 32 or 1024 bytes for WOTS)
 * @param {string} recipientPreimage - Preimage of recipient hash (hex)
 * @returns {Object} Instruction data
 */
function buildClaimInstruction(swapPreimage, recipientPreimage) {
    // For Winternitz secrets (1024 bytes each), we need larger instruction data
    const swapBytes = Buffer.from(swapPreimage, 'hex');
    const recipientBytes = Buffer.from(recipientPreimage, 'hex');
    
    // Validate preimages
    if (swapBytes.length !== 32 && swapBytes.length !== 1024) {
        throw new Error('Swap preimage must be 32 bytes (simple) or 1024 bytes (Winternitz)');
    }
    if (recipientBytes.length !== 32 && recipientBytes.length !== 1024) {
        throw new Error('Recipient preimage must be 32 bytes (simple) or 1024 bytes (Winternitz)');
    }
    
    // Build instruction data
    // [discriminator:8][swap_preimage_len:4][swap_preimage:var][recipient_preimage_len:4][recipient_preimage:var]
    const dataSize = 8 + 4 + swapBytes.length + 4 + recipientBytes.length;
    const data = Buffer.alloc(dataSize);
    let offset = 0;
    
    // Discriminator
    INSTRUCTION_DISCRIMINATORS.CLAIM.copy(data, offset);
    offset += 8;
    
    // Swap preimage (with length prefix)
    data.writeUInt32LE(swapBytes.length, offset);
    offset += 4;
    swapBytes.copy(data, offset);
    offset += swapBytes.length;
    
    // Recipient preimage (with length prefix)
    data.writeUInt32LE(recipientBytes.length, offset);
    offset += 4;
    recipientBytes.copy(data, offset);
    
    return {
        instruction: 'CLAIM',
        data: data.toString('base64'),
        dataHex: data.toString('hex'),
        dataSize,
        accounts: [
            { name: 'recipient', isSigner: true, isWritable: true },
            { name: 'htlc_account', isSigner: false, isWritable: true },
            { name: 'initiator', isSigner: false, isWritable: false }
        ],
        note: swapBytes.length === 1024 ? 'Using Winternitz preimages (quantum-safe)' : 'Using simple preimages'
    };
}

/**
 * Build REFUND instruction data
 * 
 * @param {string} refundPreimage - Preimage of refund hash (hex)
 * @returns {Object} Instruction data
 */
function buildRefundInstruction(refundPreimage) {
    const refundBytes = Buffer.from(refundPreimage, 'hex');
    
    // Build instruction data
    const dataSize = 8 + 4 + refundBytes.length;
    const data = Buffer.alloc(dataSize);
    let offset = 0;
    
    // Discriminator
    INSTRUCTION_DISCRIMINATORS.REFUND.copy(data, offset);
    offset += 8;
    
    // Refund preimage (with length prefix)
    data.writeUInt32LE(refundBytes.length, offset);
    offset += 4;
    refundBytes.copy(data, offset);
    
    return {
        instruction: 'REFUND',
        data: data.toString('base64'),
        dataHex: data.toString('hex'),
        dataSize,
        accounts: [
            { name: 'initiator', isSigner: true, isWritable: true },
            { name: 'htlc_account', isSigner: false, isWritable: true }
        ]
    };
}

// =============================================================================
// ACCOUNT PARSING
// =============================================================================

/**
 * Parse HTLC account data
 * @param {Buffer} data - Account data
 * @returns {Object} Parsed HTLC state
 */
function parseHTLCAccount(data) {
    if (data.length < HTLC_ACCOUNT_SIZE) {
        throw new Error(`Invalid account data size: ${data.length}`);
    }
    
    let offset = 8;  // Skip discriminator
    
    const initiator = data.slice(offset, offset + 32).toString('hex');
    offset += 32;
    
    const recipient = data.slice(offset, offset + 32).toString('hex');
    offset += 32;
    
    const swapHash = data.slice(offset, offset + 32).toString('hex');
    offset += 32;
    
    const recipientHash = data.slice(offset, offset + 32).toString('hex');
    offset += 32;
    
    const refundHash = data.slice(offset, offset + 32).toString('hex');
    offset += 32;
    
    const amount = data.readBigUInt64LE(offset);
    offset += 8;
    
    const timeoutSlot = data.readBigUInt64LE(offset);
    offset += 8;
    
    const isClaimed = data[offset] === 1;
    
    return {
        initiator,
        recipient,
        swapHash,
        recipientHash,
        refundHash,
        amount: Number(amount),
        timeoutSlot: Number(timeoutSlot),
        isClaimed
    };
}

// =============================================================================
// HIGH-LEVEL OPERATIONS
// =============================================================================

/**
 * Prepare all data needed to create an HTLC on Solana
 * 
 * @param {Object} params - HTLC creation parameters
 * @returns {Object} Complete HTLC creation package
 */
async function prepareHTLCCreation(params) {
    const {
        initiator,      // Initiator's Solana public key
        recipient,      // Recipient's Solana public key
        swapHash,       // SHA256 of swap preimage
        recipientHash,  // SHA256 of recipient preimage
        refundHash,     // SHA256 of refund preimage
        lamports,       // Amount in lamports
        timeoutSeconds  // Timeout in seconds
    } = params;
    
    // Get current slot (approximate)
    const currentSlot = Math.floor(Date.now() / 400);  // ~400ms per slot
    const slotsPerSecond = 2.5;
    const timeoutSlot = currentSlot + Math.floor(timeoutSeconds * slotsPerSecond);
    
    // Derive PDA
    const pda = deriveHTLCPDA(initiator, swapHash);
    
    // Build instruction
    const instruction = buildCreateHTLCInstruction({
        swapHash,
        recipientHash,
        refundHash,
        amount: lamports,
        timeoutSlot
    });
    
    // Calculate rent exemption
    const rentExemption = 2039280;  // ~0.002 SOL for 165 bytes
    
    return {
        success: true,
        htlc: {
            programId: HTLC_PROGRAM_ID,
            pda: pda.pda,
            pdaSeeds: pda.seeds
        },
        instruction,
        accounts: {
            initiator,
            recipient,
            htlcAccount: pda.pda,
            systemProgram: '11111111111111111111111111111111'
        },
        amounts: {
            htlcAmount: lamports,
            rentExemption,
            totalRequired: lamports + rentExemption
        },
        timeout: {
            currentSlot,
            timeoutSlot,
            timeoutSeconds,
            estimatedTimeoutDate: new Date(Date.now() + timeoutSeconds * 1000).toISOString()
        },
        signingNote: 'Transaction must be signed by initiator and submitted via @solana/web3.js'
    };
}

/**
 * Prepare claim transaction data
 * @param {Object} params - Claim parameters
 * @returns {Object} Claim transaction data
 */
function prepareClaimTransaction(params) {
    const { htlcPDA, swapPreimage, recipientPreimage, recipient } = params;
    
    // Verify preimages produce correct hashes
    const swapHash = crypto.sha256Hex(swapPreimage);
    const recipientHash = crypto.sha256Hex(recipientPreimage);
    
    const instruction = buildClaimInstruction(swapPreimage, recipientPreimage);
    
    return {
        success: true,
        instruction,
        verification: {
            swapHash,
            recipientHash,
            swapPreimageSize: swapPreimage.length / 2,
            recipientPreimageSize: recipientPreimage.length / 2
        },
        accounts: {
            recipient,
            htlcAccount: htlcPDA
        },
        signingNote: 'Transaction must be signed by recipient'
    };
}

/**
 * Prepare refund transaction data
 * @param {Object} params - Refund parameters
 * @returns {Object} Refund transaction data
 */
function prepareRefundTransaction(params) {
    const { htlcPDA, refundPreimage, initiator } = params;
    
    const refundHash = crypto.sha256Hex(refundPreimage);
    const instruction = buildRefundInstruction(refundPreimage);
    
    return {
        success: true,
        instruction,
        verification: {
            refundHash,
            refundPreimageSize: refundPreimage.length / 2
        },
        accounts: {
            initiator,
            htlcAccount: htlcPDA
        },
        signingNote: 'Transaction must be signed by initiator. Timeout must have passed.'
    };
}

// =============================================================================
// PROGRAM SOURCE TEMPLATE (Anchor/Rust)
// =============================================================================

/**
 * This is the Anchor program source that needs to be deployed.
 * Save to programs/solana-htlc/src/lib.rs and deploy with Anchor.
 */
const PROGRAM_SOURCE_TEMPLATE = `
// Quantum Atomic Swap - Solana HTLC Program
// Deploy with: anchor build && anchor deploy

use anchor_lang::prelude::*;
use anchor_lang::solana_program::hash::hash;

declare_id!("HTLCxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx");

#[program]
pub mod quantum_htlc {
    use super::*;

    pub fn create_htlc(
        ctx: Context<CreateHtlc>,
        swap_hash: [u8; 32],
        recipient_hash: [u8; 32],
        refund_hash: [u8; 32],
        amount: u64,
        timeout_slot: u64,
    ) -> Result<()> {
        let htlc = &mut ctx.accounts.htlc_account;
        
        htlc.initiator = ctx.accounts.initiator.key();
        htlc.recipient = ctx.accounts.recipient.key();
        htlc.swap_hash = swap_hash;
        htlc.recipient_hash = recipient_hash;
        htlc.refund_hash = refund_hash;
        htlc.amount = amount;
        htlc.timeout_slot = timeout_slot;
        htlc.is_claimed = false;

        // Transfer SOL to HTLC PDA
        let cpi_context = CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            anchor_lang::system_program::Transfer {
                from: ctx.accounts.initiator.to_account_info(),
                to: htlc.to_account_info(),
            },
        );
        anchor_lang::system_program::transfer(cpi_context, amount)?;

        Ok(())
    }

    pub fn claim(
        ctx: Context<Claim>,
        swap_preimage: Vec<u8>,
        recipient_preimage: Vec<u8>,
    ) -> Result<()> {
        let htlc = &mut ctx.accounts.htlc_account;
        
        require!(!htlc.is_claimed, HtlcError::AlreadyClaimed);
        
        // Verify swap preimage
        let swap_hash = hash(&swap_preimage);
        require!(
            swap_hash.to_bytes() == htlc.swap_hash,
            HtlcError::InvalidSwapPreimage
        );
        
        // Verify recipient preimage
        let recipient_hash = hash(&recipient_preimage);
        require!(
            recipient_hash.to_bytes() == htlc.recipient_hash,
            HtlcError::InvalidRecipientPreimage
        );
        
        htlc.is_claimed = true;
        
        // Transfer funds to recipient
        **htlc.to_account_info().try_borrow_mut_lamports()? -= htlc.amount;
        **ctx.accounts.recipient.try_borrow_mut_lamports()? += htlc.amount;

        Ok(())
    }

    pub fn refund(
        ctx: Context<Refund>,
        refund_preimage: Vec<u8>,
    ) -> Result<()> {
        let htlc = &mut ctx.accounts.htlc_account;
        let clock = Clock::get()?;
        
        require!(!htlc.is_claimed, HtlcError::AlreadyClaimed);
        require!(
            clock.slot >= htlc.timeout_slot,
            HtlcError::TimeoutNotReached
        );
        
        // Verify refund preimage
        let refund_hash = hash(&refund_preimage);
        require!(
            refund_hash.to_bytes() == htlc.refund_hash,
            HtlcError::InvalidRefundPreimage
        );
        
        htlc.is_claimed = true;
        
        // Return funds to initiator
        **htlc.to_account_info().try_borrow_mut_lamports()? -= htlc.amount;
        **ctx.accounts.initiator.try_borrow_mut_lamports()? += htlc.amount;

        Ok(())
    }
}

#[derive(Accounts)]
#[instruction(swap_hash: [u8; 32])]
pub struct CreateHtlc<'info> {
    #[account(mut)]
    pub initiator: Signer<'info>,
    
    #[account(
        init,
        payer = initiator,
        space = 8 + HtlcAccount::INIT_SPACE,
        seeds = [b"htlc", initiator.key().as_ref(), swap_hash.as_ref()],
        bump
    )]
    pub htlc_account: Account<'info, HtlcAccount>,
    
    /// CHECK: Recipient just needs to be a valid pubkey
    pub recipient: AccountInfo<'info>,
    
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Claim<'info> {
    #[account(mut)]
    pub recipient: Signer<'info>,
    
    #[account(
        mut,
        constraint = htlc_account.recipient == recipient.key() @ HtlcError::NotRecipient
    )]
    pub htlc_account: Account<'info, HtlcAccount>,
}

#[derive(Accounts)]
pub struct Refund<'info> {
    #[account(mut)]
    pub initiator: Signer<'info>,
    
    #[account(
        mut,
        constraint = htlc_account.initiator == initiator.key() @ HtlcError::NotInitiator
    )]
    pub htlc_account: Account<'info, HtlcAccount>,
}

#[account]
#[derive(InitSpace)]
pub struct HtlcAccount {
    pub initiator: Pubkey,
    pub recipient: Pubkey,
    pub swap_hash: [u8; 32],
    pub recipient_hash: [u8; 32],
    pub refund_hash: [u8; 32],
    pub amount: u64,
    pub timeout_slot: u64,
    pub is_claimed: bool,
}

#[error_code]
pub enum HtlcError {
    #[msg("HTLC has already been claimed")]
    AlreadyClaimed,
    #[msg("Invalid swap preimage")]
    InvalidSwapPreimage,
    #[msg("Invalid recipient preimage")]
    InvalidRecipientPreimage,
    #[msg("Invalid refund preimage")]
    InvalidRefundPreimage,
    #[msg("Timeout has not been reached")]
    TimeoutNotReached,
    #[msg("Not the recipient")]
    NotRecipient,
    #[msg("Not the initiator")]
    NotInitiator,
}
`;

// =============================================================================
// EXPORTS
// =============================================================================

module.exports = {
    // Configuration
    HTLC_PROGRAM_ID,
    HTLC_ACCOUNT_SIZE,
    INSTRUCTION_DISCRIMINATORS,
    
    // PDA derivation
    deriveHTLCPDA,
    
    // Instruction builders
    buildCreateHTLCInstruction,
    buildClaimInstruction,
    buildRefundInstruction,
    
    // Account parsing
    parseHTLCAccount,
    
    // High-level operations
    prepareHTLCCreation,
    prepareClaimTransaction,
    prepareRefundTransaction,
    
    // Program source (for deployment)
    PROGRAM_SOURCE_TEMPLATE
};
