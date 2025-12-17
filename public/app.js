/**
 * Quantum Atomic Swaps v2.0 - Frontend JavaScript
 */

// =============================================================================
// API HELPER
// =============================================================================

async function apiRequest(endpoint, method = 'GET', body = null) {
    const options = {
        method,
        headers: { 'Content-Type': 'application/json' }
    };
    
    if (body) {
        options.body = JSON.stringify(body);
    }

    try {
        const response = await fetch(endpoint, options);
        const data = await response.json();
        return data;
    } catch (error) {
        console.error('API Error:', error);
        return { success: false, error: 'Network error: ' + error.message };
    }
}

// =============================================================================
// TOAST NOTIFICATIONS
// =============================================================================

function showToast(message, type = 'info') {
    const toast = document.getElementById('toast');
    toast.textContent = message;
    toast.className = `toast ${type}`;
    toast.classList.remove('hidden');
    
    setTimeout(() => {
        toast.classList.add('hidden');
    }, 4000);
}

// =============================================================================
// COPY TO CLIPBOARD
// =============================================================================

function copyText(element) {
    const text = element.value || element.innerText;
    
    if (!text || text === '...') {
        showToast('Nothing to copy', 'warning');
        return;
    }
    
    navigator.clipboard.writeText(text).then(() => {
        showToast('📋 Copied to clipboard!', 'success');
    }).catch(err => {
        // Fallback
        const textarea = document.createElement('textarea');
        textarea.value = text;
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
        showToast('📋 Copied!', 'success');
    });
}

// =============================================================================
// FORM HANDLERS
// =============================================================================

// Update labels when chain selection changes
document.getElementById('fromChain').addEventListener('change', updateLabels);
document.getElementById('toChain').addEventListener('change', updateLabels);

function updateLabels() {
    const fromChain = document.getElementById('fromChain').value;
    const toChain = document.getElementById('toChain').value;
    
    // Update unit labels
    document.getElementById('fromUnit').textContent = getUnit(fromChain);
    document.getElementById('toUnit').textContent = getUnit(toChain);
    
    // Update address labels
    document.getElementById('fromChainLabel').textContent = fromChain;
    document.getElementById('toChainLabel').textContent = toChain;
}

function getUnit(chain) {
    switch (chain) {
        case 'BSV': return 'satoshis';
        case 'BTC': return 'satoshis';
        case 'SOL': return 'lamports';
        default: return 'units';
    }
}

// =============================================================================
// SWAP OPERATIONS
// =============================================================================

async function initiateSwap() {
    const fromChain = document.getElementById('fromChain').value;
    const toChain = document.getElementById('toChain').value;
    const fromAmount = document.getElementById('fromAmount').value;
    const toAmount = document.getElementById('toAmount').value;
    const toAddress = document.getElementById('toAddress').value;
    const refundAddress = document.getElementById('refundAddress').value;
    
    // Validation
    if (!fromAmount || !toAmount) {
        showToast('Please enter amounts', 'error');
        return;
    }
    
    if (!toAddress || !refundAddress) {
        showToast('Please enter both addresses', 'error');
        return;
    }
    
    if (fromChain === toChain) {
        showToast('From and To chains must be different', 'error');
        return;
    }
    
    showToast('⏳ Creating quantum-safe swap...', 'info');
    
    const result = await apiRequest('/api/swap/initiate', 'POST', {
        fromChain,
        toChain,
        fromAmount: parseInt(fromAmount),
        toAmount: parseInt(toAmount),
        toAddress,
        refundAddress
    });
    
    if (result.success) {
        // Display results
        document.getElementById('swapId').textContent = result.swapId;
        document.getElementById('swapStatus').textContent = result.status;
        document.getElementById('swapHash').textContent = result.swap_hash;
        
        // Display secrets
        if (result.secretsToSave) {
            document.getElementById('swapSecret').value = result.secretsToSave.swap_secret;
            document.getElementById('refundSecret').value = result.secretsToSave.refund_secret;
            document.getElementById('claimSecret').value = result.secretsToSave.claim_secret;
        }
        
        // Show result section
        document.getElementById('swapResult').classList.remove('hidden');
        document.getElementById('swapResult').scrollIntoView({ behavior: 'smooth' });
        
        showToast('✅ Swap created successfully!', 'success');
    } else {
        showToast('❌ ' + result.error, 'error');
    }
}

async function joinSwap() {
    const swapId = document.getElementById('joinSwapId').value.trim();
    const toAddress = document.getElementById('joinToAddress').value.trim();
    const refundAddress = document.getElementById('joinRefundAddress').value.trim();
    
    if (!swapId || !toAddress || !refundAddress) {
        showToast('Please fill in all fields', 'error');
        return;
    }
    
    showToast('⏳ Joining swap...', 'info');
    
    const result = await apiRequest('/api/swap/join', 'POST', {
        swapId,
        toAddress,
        refundAddress
    });
    
    if (result.success) {
        showToast('✅ Successfully joined swap!', 'success');
        
        // Show funding info
        alert(`Swap Joined Successfully!\n\n` +
            `Your HTLC Address: ${result.responderHTLC?.address || 'Check script hash'}\n` +
            `Script Hash: ${result.responderHTLC?.scriptHash || 'N/A'}\n` +
            `Amount to Fund: ${result.toAmount} (on ${result.toChain})\n\n` +
            `SAVE YOUR SECRETS!`);
    } else {
        showToast('❌ ' + result.error, 'error');
    }
}

async function checkStatus() {
    const swapId = document.getElementById('checkSwapId').value.trim();
    
    if (!swapId) {
        showToast('Please enter a Swap ID', 'error');
        return;
    }
    
    showToast('⏳ Fetching status...', 'info');
    
    const result = await apiRequest(`/api/swap/status/${swapId}?secrets=true`);
    
    if (result.success) {
        document.getElementById('statusJson').textContent = JSON.stringify(result, null, 2);
        document.getElementById('statusResult').classList.remove('hidden');
        showToast('✅ Status retrieved', 'success');
    } else {
        showToast('❌ ' + result.error, 'error');
    }
}

// =============================================================================
// INITIALIZE
// =============================================================================

document.addEventListener('DOMContentLoaded', () => {
    updateLabels();
    console.log('⚛️ Quantum Atomic Swaps v2.0 Loaded');
});
