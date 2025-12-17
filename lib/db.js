/**
 * Quantum Atomic Swaps v2.0 - Database Layer
 * 
 * Persistent storage for swap state using SQLite.
 * Production deployments should migrate to PostgreSQL.
 */

const Database = require('better-sqlite3');
const path = require('path');

// Database file location
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'swaps.db');

// Initialize database connection
let db = null;

/**
 * Initialize the database and create tables
 */
function init() {
    // Ensure data directory exists
    const fs = require('fs');
    const dataDir = path.dirname(DB_PATH);
    if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
    }
    
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    
    // Create swaps table
    db.exec(`
        CREATE TABLE IF NOT EXISTS swaps (
            swap_id TEXT PRIMARY KEY,
            status TEXT NOT NULL,
            version TEXT NOT NULL DEFAULT '2.0',
            quantum_safe INTEGER NOT NULL DEFAULT 1,
            
            -- Chain info
            from_chain TEXT NOT NULL,
            to_chain TEXT NOT NULL,
            from_amount INTEGER NOT NULL,
            to_amount INTEGER NOT NULL,
            to_address TEXT NOT NULL,
            refund_address TEXT NOT NULL,
            
            -- Initiator secrets (encrypted JSON)
            initiator_data TEXT,
            
            -- Responder secrets (encrypted JSON)
            responder_data TEXT,
            
            -- Initiator HTLC (JSON)
            initiator_htlc TEXT,
            
            -- Responder HTLC (JSON)
            responder_htlc TEXT,
            
            -- Transactions (JSON array)
            transactions TEXT DEFAULT '[]',
            
            -- Timestamps
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )
    `);
    
    // Create indexes
    db.exec(`
        CREATE INDEX IF NOT EXISTS idx_swaps_status ON swaps(status);
        CREATE INDEX IF NOT EXISTS idx_swaps_from_chain ON swaps(from_chain);
        CREATE INDEX IF NOT EXISTS idx_swaps_to_chain ON swaps(to_chain);
        CREATE INDEX IF NOT EXISTS idx_swaps_created_at ON swaps(created_at);
    `);
    
    console.log('[DB] Database initialized:', DB_PATH);
    return db;
}

/**
 * Save a swap to the database
 * @param {Object} swap - Swap object
 */
function saveSwap(swap) {
    const stmt = db.prepare(`
        INSERT OR REPLACE INTO swaps (
            swap_id, status, version, quantum_safe,
            from_chain, to_chain, from_amount, to_amount,
            to_address, refund_address,
            initiator_data, responder_data,
            initiator_htlc, responder_htlc,
            transactions, created_at, updated_at
        ) VALUES (
            @swapId, @status, @version, @quantumSafe,
            @fromChain, @toChain, @fromAmount, @toAmount,
            @toAddress, @refundAddress,
            @initiatorData, @responderData,
            @initiatorHTLC, @responderHTLC,
            @transactions, @createdAt, @updatedAt
        )
    `);
    
    stmt.run({
        swapId: swap.swapId,
        status: swap.status,
        version: swap.version || '2.0',
        quantumSafe: swap.quantumSafe ? 1 : 0,
        fromChain: swap.fromChain,
        toChain: swap.toChain,
        fromAmount: swap.fromAmount,
        toAmount: swap.toAmount,
        toAddress: swap.toAddress,
        refundAddress: swap.refundAddress,
        initiatorData: JSON.stringify(swap.initiator || {}),
        responderData: JSON.stringify(swap.responder || {}),
        initiatorHTLC: JSON.stringify(swap.initiatorHTLC || {}),
        responderHTLC: JSON.stringify(swap.responderHTLC || {}),
        transactions: JSON.stringify(swap.transactions || []),
        createdAt: swap.createdAt,
        updatedAt: swap.updatedAt
    });
}

/**
 * Get a swap by ID
 * @param {string} swapId - Swap ID
 * @returns {Object|null} Swap object or null
 */
function getSwap(swapId) {
    const stmt = db.prepare('SELECT * FROM swaps WHERE swap_id = ?');
    const row = stmt.get(swapId);
    
    if (!row) return null;
    
    return {
        swapId: row.swap_id,
        status: row.status,
        version: row.version,
        quantumSafe: row.quantum_safe === 1,
        fromChain: row.from_chain,
        toChain: row.to_chain,
        fromAmount: row.from_amount,
        toAmount: row.to_amount,
        toAddress: row.to_address,
        refundAddress: row.refund_address,
        initiator: JSON.parse(row.initiator_data || '{}'),
        responder: JSON.parse(row.responder_data || '{}'),
        initiatorHTLC: JSON.parse(row.initiator_htlc || '{}'),
        responderHTLC: JSON.parse(row.responder_htlc || '{}'),
        transactions: JSON.parse(row.transactions || '[]'),
        createdAt: row.created_at,
        updatedAt: row.updated_at
    };
}

/**
 * List all swaps with optional filtering
 * @param {Object} filters - Optional filters
 * @returns {Array} Array of swap summaries
 */
function listSwaps(filters = {}) {
    let query = 'SELECT swap_id, status, from_chain, to_chain, from_amount, to_amount, created_at FROM swaps';
    const conditions = [];
    const params = {};
    
    if (filters.status) {
        conditions.push('status = @status');
        params.status = filters.status;
    }
    if (filters.fromChain) {
        conditions.push('from_chain = @fromChain');
        params.fromChain = filters.fromChain;
    }
    if (filters.toChain) {
        conditions.push('to_chain = @toChain');
        params.toChain = filters.toChain;
    }
    
    if (conditions.length > 0) {
        query += ' WHERE ' + conditions.join(' AND ');
    }
    
    query += ' ORDER BY created_at DESC';
    
    if (filters.limit) {
        query += ' LIMIT @limit';
        params.limit = filters.limit;
    }
    
    const stmt = db.prepare(query);
    return stmt.all(params).map(row => ({
        swapId: row.swap_id,
        status: row.status,
        fromChain: row.from_chain,
        toChain: row.to_chain,
        fromAmount: row.from_amount,
        toAmount: row.to_amount,
        createdAt: row.created_at
    }));
}

/**
 * Update swap status
 * @param {string} swapId - Swap ID
 * @param {string} status - New status
 */
function updateStatus(swapId, status) {
    const stmt = db.prepare(`
        UPDATE swaps 
        SET status = ?, updated_at = ? 
        WHERE swap_id = ?
    `);
    stmt.run(status, new Date().toISOString(), swapId);
}

/**
 * Delete a swap (for testing/cleanup)
 * @param {string} swapId - Swap ID
 */
function deleteSwap(swapId) {
    const stmt = db.prepare('DELETE FROM swaps WHERE swap_id = ?');
    stmt.run(swapId);
}

/**
 * Get swap statistics
 * @returns {Object} Statistics
 */
function getStats() {
    const stats = db.prepare(`
        SELECT 
            COUNT(*) as total,
            SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
            SUM(CASE WHEN status = 'refunded' THEN 1 ELSE 0 END) as refunded,
            SUM(CASE WHEN status IN ('initiated', 'counterparty_joined', 'fully_funded') THEN 1 ELSE 0 END) as active
        FROM swaps
    `).get();
    
    const chains = db.prepare(`
        SELECT 
            from_chain || '->' || to_chain as pair,
            COUNT(*) as count
        FROM swaps
        GROUP BY pair
        ORDER BY count DESC
    `).all();
    
    return {
        total: stats.total,
        completed: stats.completed,
        refunded: stats.refunded,
        active: stats.active,
        chainPairs: chains
    };
}

/**
 * Close database connection
 */
function close() {
    if (db) {
        db.close();
        db = null;
    }
}

// =============================================================================
// EXPORTS
// =============================================================================

module.exports = {
    init,
    saveSwap,
    getSwap,
    listSwaps,
    updateStatus,
    deleteSwap,
    getStats,
    close
};
