let monitoringInterval = null;
let startTime = null;
let processedBookings = new Set(); // Track processed booking IDs
let stats = {
    totalProcessed: 0,
    vinMatches: 0,
    accuracyRate: 0
};

const SERVER_URL = 'http://localhost:3001';

async function checkOCRStatus() {
    try {
        const response = await fetch(`${SERVER_URL}/health`);
        const data = await response.json();

        const ocrStatusElement = document.getElementById('ocrStatus');
        const ocrStatusText = document.getElementById('ocrStatusText');

        if (data.azure_vision_configured) {
            ocrStatusElement.className = 'ocr-status available';
            ocrStatusText.textContent = 'Integrated Azure OCR Available';
            addLogEntry('Azure OCR service is configured and ready', 'success');
        } else {
            ocrStatusElement.className = 'ocr-status unavailable';
            ocrStatusText.textContent = 'Azure OCR Not Configured';
            addLogEntry('Warning: Azure OCR not configured. Set VISION_KEY and VISION_ENDPOINT environment variables.', 'error');
        }
    } catch (error) {
        const ocrStatusElement = document.getElementById('ocrStatus');
        const ocrStatusText = document.getElementById('ocrStatusText');
        ocrStatusElement.className = 'ocr-status unavailable';
        ocrStatusText.textContent = 'Service Unavailable';
        addLogEntry(`Error checking OCR status: ${error.message}`, 'error');
    }
}

async function testOCR() {
    addLogEntry('Testing OCR functionality...', 'info');

    // Get a sample image URL from the database
    try {
        const response = await fetch(`${SERVER_URL}/health`);
        const healthData = await response.json();

        if (!healthData.azure_vision_configured) {
            addLogEntry('Cannot test OCR: Azure Computer Vision not configured', 'error');
            return;
        }

        // Test with a placeholder URL (you might want to add a test endpoint with sample images)
        addLogEntry('OCR service is configured. Use the monitoring feature to test with real booking images.', 'info');

    } catch (error) {
        addLogEntry(`OCR test failed: ${error.message}`, 'error');
    }
}

function addLogEntry(message, type = 'info') {
    const logSection = document.getElementById('logSection');
    const entry = document.createElement('div');
    entry.className = `log-entry ${type}`;
    entry.textContent = `${new Date().toLocaleTimeString()} - ${message}`;

    logSection.insertBefore(entry, logSection.firstChild);

    // Keep only last 50 entries
    const entries = logSection.querySelectorAll('.log-entry');
    if (entries.length > 50) {
        entries[entries.length - 1].remove();
    }
}

function updateStats() {
    document.getElementById('totalProcessed').textContent = stats.totalProcessed;
    document.getElementById('vinMatches').textContent = stats.vinMatches;
    document.getElementById('accuracyRate').textContent = stats.accuracyRate + '%';
    document.getElementById('lastUpdate').textContent = new Date().toLocaleTimeString();
    document.getElementById('tableCount').textContent = `${stats.totalProcessed} bookings`;
}

function updateRunTime() {
    if (startTime) {
        const elapsed = Date.now() - startTime;
        const hours = Math.floor(elapsed / 3600000);
        const minutes = Math.floor((elapsed % 3600000) / 60000);
        const seconds = Math.floor((elapsed % 60000) / 1000);

        document.getElementById('runTime').textContent =
            `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
    }
}

function getPercentageClass(percentage) {
    if (percentage >= 80) return 'percentage-high';
    if (percentage >= 50) return 'percentage-medium';
    return 'percentage-low';
}

function addTableRow(booking) {
    const tbody = document.getElementById('resultsBody');
    const row = document.createElement('tr');
    row.className = 'new-row';

    // Determine match status styling
    let matchStatusClass = 'match-none';
    if (booking['Match Status'].includes('EXACT')) {
        matchStatusClass = 'match-exact';
    }

    // Format percentages
    const bestPercentage = booking['Best Percentage Match'] || 0;
    const vinPercentage = booking['VIN Percentage Match'] || 0;

    row.innerHTML = `
                <td>${booking['Booking ID']}</td>
                <td><strong>${booking['Actual Registration']}</strong></td>
                <td class="image-cell">${booking['Image 1'] || 'N/A'}</td>
                <td class="image-cell">${booking['Image 2'] || 'N/A'}</td>
                <td class="image-cell">${booking['Image 3'] || 'N/A'}</td>
                <td class="image-cell">${booking['Image 4'] || 'N/A'}</td>
                <td class="percentage-cell ${getPercentageClass(bestPercentage)}">${bestPercentage}%</td>
                <td class="vin-cell">${booking['VIN'] || 'N/A'}</td>
                <td class="percentage-cell ${getPercentageClass(vinPercentage)}">${vinPercentage}%</td>
                <td><span class="${matchStatusClass}">${booking['Match Status']}</span></td>
                <td>${booking.Created}</td>
            `;

    // Insert at the top of the table
    tbody.insertBefore(row, tbody.firstChild);

    // Track this booking as processed
    processedBookings.add(booking['Booking ID']);

    addLogEntry(`Processed Booking ${booking['Booking ID']} - ${booking['Match Status']} - Best: ${bestPercentage}% - VIN: ${vinPercentage}%`,
        booking['Match Status'].includes('EXACT') ? 'success' : 'info');
}

async function exportResults(format) {

    try {
        addLogEntry(`Starting ${format.toUpperCase()} export...`, 'info');

        const response = await fetch(`${SERVER_URL}/export/results?format=${format}`);

        if (response.ok) {
            const blob = await response.blob();
            const url = window.URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `analysis_results_${new Date().toISOString().split('T')[0]}.${format}`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            window.URL.revokeObjectURL(url);

            addLogEntry(`${format.toUpperCase()} export completed successfully`, 'success');
        } else {
            const errorData = await response.json();
            addLogEntry(`Export failed: ${errorData.error || 'Unknown error'}`, 'error');
        }
    } catch (error) {
        addLogEntry(`Export error: ${error.message}`, 'error');
    }
}

async function fetchAndUpdateResults() {
    try {
        addLogEntry('Fetching new results...', 'info');

        const response = await fetch(`${SERVER_URL}/analyze/smart`);
        const data = await response.json();

        if (response.ok && data.success) {
            // Filter out bookings we've already processed
            const newBookings = data.table_data.filter(booking =>
                !processedBookings.has(booking['Booking ID'])
            );

            if (newBookings.length > 0) {
                addLogEntry(`Found ${newBookings.length} new booking(s)`, 'success');

                // Add new bookings to table
                newBookings.forEach(booking => {
                    addTableRow(booking);
                });
            } else {
                addLogEntry('No new bookings found', 'info');
            }

            stats.totalProcessed = data.total_processed || 0;
            stats.vinMatches = data.exact_matches || 0;
            stats.accuracyRate = data.accuracy_percentage || 0;
            updateStats();

        } else {
            throw new Error(data.error || 'Failed to fetch results');
        }

    } catch (error) {
        addLogEntry(`Error fetching results: ${error.message}`, 'error');
        console.error('Monitoring error:', error);
    }
}

async function startMonitoring() {
    const hours = parseInt(document.getElementById('monitoringHours').value);
    const interval = parseInt(document.getElementById('refreshInterval').value) * 1000;

    try {
        addLogEntry('Starting background monitoring...', 'info');

        const monitorResponse = await fetch(`${SERVER_URL}/monitor/start`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ hours: hours })
        });

        const monitorData = await monitorResponse.json();

        if (!monitorResponse.ok) {
            if (monitorData.error && monitorData.error.includes('already running')) {
                addLogEntry('Background monitoring already running', 'info');
            } else {
                throw new Error(monitorData.error || 'Failed to start background monitoring');
            }
        } else {
            addLogEntry('Background monitoring started successfully', 'success');
        }

        // Reset state
        processedBookings.clear();
        stats = { totalProcessed: 0, vinMatches: 0, accuracyRate: 0 };
        startTime = Date.now();

        // Update UI
        document.getElementById('startBtn').disabled = true;
        document.getElementById('stopBtn').disabled = false;
        document.getElementById('statusIndicator').className = 'status-indicator active';

        // Start dashboard polling
        fetchAndUpdateResults(); // Initial fetch
        monitoringInterval = setInterval(fetchAndUpdateResults, interval);

        // Start runtime counter
        const runtimeInterval = setInterval(() => {
            if (monitoringInterval) {
                updateRunTime();
            } else {
                clearInterval(runtimeInterval);
            }
        }, 1000);

        addLogEntry(`Dashboard polling started (${interval / 1000}s interval)`, 'success');

    } catch (error) {
        addLogEntry(`Error starting monitoring: ${error.message}`, 'error');
        console.error('Start monitoring error:', error);
    }
}

async function stopMonitoring() {
    try {
        const response = await fetch(`${SERVER_URL}/monitor/stop`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });

        if (response.ok) {
            addLogEntry('Background monitoring stopped', 'info');
        } else {
            addLogEntry('Could not stop background monitoring', 'error');
        }
    } catch (error) {
        addLogEntry(`Error stopping background monitoring: ${error.message}`, 'error');
    }

    // Stop dashboard polling
    if (monitoringInterval) {
        clearInterval(monitoringInterval);
        monitoringInterval = null;
    }

    // Update UI
    document.getElementById('startBtn').disabled = false;
    document.getElementById('stopBtn').disabled = true;
    document.getElementById('statusIndicator').className = 'status-indicator inactive';

    addLogEntry('Dashboard monitoring stopped', 'info');
}

function clearTable() {
    document.getElementById('resultsBody').innerHTML = '';
    processedBookings.clear();
    stats = { totalProcessed: 0, vinMatches: 0, accuracyRate: 0 };
    updateStats();
    addLogEntry('Table cleared', 'info');
}

// Initialize runtime display
updateRunTime();
updateStats();

// Initialize page
window.onload = function () {
    addLogEntry('Dashboard loaded and ready', 'success');
    checkOCRStatus();
};