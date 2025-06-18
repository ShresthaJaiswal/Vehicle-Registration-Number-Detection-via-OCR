import express from 'express';
import pg from 'pg';
import fetch from 'node-fetch';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// =====================================================================================
// CONTINUOUS ANALYSIS SERVICE WITH REAL-TIME MONITORING
// =====================================================================================

const { Client } = pg;

// Database configuration
const dbConfig = {
    host: '34.93.196.129',
    port: 5432,
    database: 'bounceb2b',
    user: 'postgres',
    password: '37s_.gP0[o$[9CDo',
};

// Configuration
const OCR_SERVICE_URL = 'http://localhost:3000';
const ANALYSIS_PORT = 3001;

// VIN accuracy threshold (configurable)
const VIN_ACCURACY_THRESHOLD = 100; // 100% VIN match required for counting as accurate

// Global state for continuous monitoring
let lastProcessedBookingId = 0;
let isMonitoring = false;
let currentMonitoringInterval = null;
let monitoringStats = {
    startTime: null,
    totalBookingsProcessed: 0,
    vinAccurateMatches: 0,
    failedProcessing: 0,
    lastProcessedBooking: null
};

// Real-time processed bookings cache (for the dashboard)
let processedBookingsCache = [];
const MAX_CACHE_SIZE = 100;

const app = express();
app.use(express.json());

// Add CORS headers
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    next();
});

// Serve the monitoring dashboard
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'monitoring-dashboard.html'));
});

// =====================================================================================
// SMART PARSING LOGIC
// =====================================================================================

function getIndianStateCodes() {
    return [
        'DL', 'UP', 'KA', 'MH', 'TN', 'GJ', 'RJ', 'MP', 'WB', 'AP', 'TG', 'OR', 'KL', 'AS', 'BR', 'HR', 'HP', 'JH', 'UK', 'PB',
        'NCR', 'CH', 'GA', 'MN', 'ML', 'MZ', 'NL', 'SK', 'TR', 'AR', 'JK', 'LA', 'LD', 'PY', 'AN', 'DN', 'DD',
        'BH', 'CG'
    ];
}

function scoreRegistrationCandidate(str) {
    if (!str || str.length < 8 || str.length > 10) return 0;
    
    const stateCodes = getIndianStateCodes();
    let score = 0;
    
    const stateCode = stateCodes.find(code => str.startsWith(code));
    if (!stateCode) return 0;
    
    score += 100;
    
    const commonStates = ['DL', 'NCR', 'KA', 'UP'];
    if (commonStates.includes(stateCode)) {
        score += 20;
    }
    
    const afterState = str.substring(stateCode.length);
    
    if (/^\d{1,2}[A-Z]{1,2}\d{4}$/.test(afterState)) {
        score += 50;
    } else if (/^[A-Z]{1,2}\d{4,5}$/.test(afterState)) {
        score += 40;
    } else if (/^\d+[A-Z]+\d+$/.test(afterState)) {
        score += 30;
    } else if (/^\d+$/.test(afterState)) {
        score += 10;
    }
    
    if (str.length === 10) score += 15;
    else if (str.length === 9) score += 10;
    else if (str.length === 8) score += 5;
    
    if (str.includes('O0') || str.includes('0O')) score -= 10;
    if (str.includes('I1') || str.includes('1I')) score -= 10;
    
    return score;
}

function applyTargetedOCRCorrections(text) {
    let corrected = text.toUpperCase();
    
    const corrections = [
        ['Q', '0'], ['O', '0'], ['S', '5'], ['B', '8'], ['G', '6'], ['Z', '2']
    ];
    
    let bestCandidate = corrected;
    let bestScore = scoreRegistrationCandidate(corrected);
    
    corrections.forEach(([from, to]) => {
        if (corrected.includes(from)) {
            const candidate = corrected.replace(new RegExp(from, 'g'), to);
            const score = scoreRegistrationCandidate(candidate);
            if (score > bestScore) {
                bestScore = score;
                bestCandidate = candidate;
            }
        }
    });
    
    return bestCandidate;
}

function parseIndianRegistrationNumber(textArray) {
    const candidates = [];
    const stateCodes = getIndianStateCodes();
    
    // Strategy 1: Check each line for registration patterns
    textArray.forEach((line, index) => {
        const cleaned = line.toUpperCase().replace(/[^A-Z0-9]/g, '');
        
        if (cleaned.length >= 8 && cleaned.length <= 10) {
            const score = scoreRegistrationCandidate(cleaned);
            if (score > 0) {
                candidates.push({ text: cleaned, score, source: `line_${index + 1}` });
            }
            
            const corrected = applyTargetedOCRCorrections(cleaned);
            if (corrected !== cleaned) {
                const correctedScore = scoreRegistrationCandidate(corrected);
                if (correctedScore > 0) {
                    candidates.push({ text: corrected, score: correctedScore, source: `line_${index + 1}_corrected` });
                }
            }
        }
    });
    
    // Strategy 2: Handle spaced formats
    textArray.forEach((line, index) => {
        const spacedMatches = [
            line.toUpperCase().match(/([A-Z]{2,3})\s+([A-Z0-9]{1,3})\s+([A-Z0-9]{4,5})/),
            line.toUpperCase().match(/([A-Z]{2,3})\s*([A-Z0-9]{6,7})/),
            line.toUpperCase().match(/([A-Z]{2,3})\s+([A-Z0-9]+)/),
        ];
        
        spacedMatches.forEach(match => {
            if (match) {
                const combined = match.slice(1).join('').replace(/\s/g, '');
                if (combined.length >= 8 && combined.length <= 10) {
                    const score = scoreRegistrationCandidate(combined);
                    if (score > 0) {
                        candidates.push({ text: combined, score: score + 10, source: `spaced_line_${index + 1}` });
                    }
                    
                    const corrected = applyTargetedOCRCorrections(combined);
                    if (corrected !== combined) {
                        const correctedScore = scoreRegistrationCandidate(corrected);
                        if (correctedScore > 0) {
                            candidates.push({ text: corrected, score: correctedScore + 10, source: `spaced_line_${index + 1}_corrected` });
                        }
                    }
                }
            }
        });
    });
    
    // Strategy 3: Try combining text
    const allText = textArray.join('').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (allText.length >= 8 && allText.length <= 10) {
        const score = scoreRegistrationCandidate(allText);
        if (score > 0) {
            candidates.push({ text: allText, score: score - 20, source: 'combined' });
        }
    }
    
    // Strategy 4: Look for state codes in longer strings
    textArray.forEach((line, index) => {
        const cleaned = line.toUpperCase().replace(/[^A-Z0-9]/g, '');
        stateCodes.forEach(stateCode => {
            const stateIndex = cleaned.indexOf(stateCode);
            if (stateIndex >= 0) {
                for (let len = 8; len <= 10; len++) {
                    if (stateIndex + len <= cleaned.length) {
                        const extracted = cleaned.substring(stateIndex, stateIndex + len);
                        const score = scoreRegistrationCandidate(extracted);
                        if (score > 0) {
                            candidates.push({ text: extracted, score: score - 10, source: `extracted_${stateCode}_line_${index + 1}` });
                        }
                    }
                }
            }
        });
    });
    
    // Remove duplicates and sort by score
    const uniqueCandidates = [];
    const seen = new Set();
    
    candidates.forEach(candidate => {
        if (!seen.has(candidate.text)) {
            seen.add(candidate.text);
            uniqueCandidates.push(candidate);
        }
    });
    
    uniqueCandidates.sort((a, b) => b.score - a.score);
    
    if (uniqueCandidates.length > 0 && uniqueCandidates[0].score >= 100) {
        const best = uniqueCandidates[0];
        return [best.text];
    }
    
    return [];
}

function analyzeImageError(ocrResult, imageUrl) {
    const errorReasons = [];
    
    if (!ocrResult.success) {
        if (ocrResult.error?.includes('network') || ocrResult.error?.includes('timeout')) {
            errorReasons.push('Network connectivity issue');
        } else if (ocrResult.error?.includes('400') || ocrResult.error?.includes('invalid')) {
            errorReasons.push('Invalid image format or corrupt image');
        } else if (ocrResult.error?.includes('500') || ocrResult.error?.includes('service')) {
            errorReasons.push('OCR service error');
        } else {
            errorReasons.push('OCR processing failed');
        }
        return errorReasons;
    }
    
    const extractedText = ocrResult.extractedText || [];
    const allText = extractedText.join(' ').toLowerCase();
    
    if (extractedText.length === 0) {
        errorReasons.push('No text detected - poor lighting or blur');
        return errorReasons;
    }
    
    const hasCommonMisreads = /[qosb6g2z]/i.test(allText);
    if (hasCommonMisreads) {
        errorReasons.push('Character misreads detected');
    }
    
    if (extractedText.length < 3) {
        errorReasons.push('Motion blur or poor angle');
    }
    
    const avgLineLength = extractedText.reduce((sum, line) => sum + line.length, 0) / extractedText.length;
    if (avgLineLength < 5) {
        errorReasons.push('Poor image quality');
    }
    
    const alphanumericRatio = allText.replace(/[^a-z0-9]/g, '').length / Math.max(allText.length, 1);
    if (alphanumericRatio < 0.5) {
        errorReasons.push('High noise content');
    }
    
    if (extractedText.length > 0) {
        const detectedRegs = parseIndianRegistrationNumber(extractedText);
        if (detectedRegs.length === 0) {
            errorReasons.push('Reg plate not clearly visible');
        }
    }
    
    return errorReasons.length > 0 ? errorReasons : ['Unknown detection issue'];
}

// =====================================================================================
// UTILITY FUNCTIONS
// =====================================================================================

function splitImageUrls(imageString) {
    if (!imageString) return [];
    return imageString.split('^').filter(url => url.trim() !== '');
}

function normalizeRegNumber(regNumber) {
    if (!regNumber) return '';
    return regNumber.toString().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function calculateSimilarity(actual, detected) {
    if (!actual || !detected) return 0;
    
    const actualNorm = normalizeRegNumber(actual);
    const detectedNorm = normalizeRegNumber(detected);
    
    if (actualNorm === detectedNorm) return 100;
    
    const maxLength = Math.max(actualNorm.length, detectedNorm.length);
    if (maxLength === 0) return 0;
    
    let matches = 0;
    const minLength = Math.min(actualNorm.length, detectedNorm.length);
    
    for (let i = 0; i < minLength; i++) {
        if (actualNorm[i] === detectedNorm[i]) matches++;
    }
    
    return Math.round((matches / maxLength) * 100);
}

function getLast4Digits(regNumber) {
    if (!regNumber) return '';
    const normalized = normalizeRegNumber(regNumber);
    // Extract last 4 characters (typically digits)
    return normalized.slice(-4);
}

function calculateVINMatch(actual, detected) {
    const actualLast4 = getLast4Digits(actual);
    const detectedLast4 = getLast4Digits(detected);
    
    if (!actualLast4 || !detectedLast4) return 0;
    if (actualLast4 === detectedLast4) return 100;
    
    // Calculate partial match
    let matches = 0;
    for (let i = 0; i < Math.min(actualLast4.length, detectedLast4.length); i++) {
        if (actualLast4[i] === detectedLast4[i]) matches++;
    }
    
    return Math.round((matches / 4) * 100);
}

// =====================================================================================
// CORE PROCESSING FUNCTIONS
// =====================================================================================

async function processBooking(booking) {
    const imageUrls = splitImageUrls(booking.booking_starting_images);
    const maxImages = Math.min(imageUrls.length, 4);
    
    // Initialize row data
    const rowData = {
        'Booking ID': booking.booking_id,
        'Actual Registration': booking.actual_reg_number,
        'Booking Status': booking.booking_status,
        'Image 1': 'N/A',
        'Image 2': 'N/A',
        'Image 3': 'N/A',
        'Image 4': 'N/A',
        'Best Percentage Match': 0,
        '': 'N/A',
        ' Percentage Match': 0,
        'Match Status': '❌ NO MATCH',
        'Created': new Date(booking.created_at).toLocaleDateString()
    };
    
    let hasExactMatch = false;
    let bestSimilarity = 0;
    let bestDetectedNumber = '';
    let bestVINMatch = 0;
    let allSimilarities = [];
    
    // Process each image
    for (let j = 0; j < maxImages; j++) {
        const imageColumnName = `Image ${j + 1}`;
        
        try {
            const ocrResponse = await fetch(`${OCR_SERVICE_URL}/ocr/registration-number-url`, {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                },
                body: JSON.stringify({ imageUrl: imageUrls[j] }),
                timeout: 30000
            });
            
            if (!ocrResponse.ok) {
                rowData[imageColumnName] = `🔴 OCR Failed (${ocrResponse.status})`;
                continue;
            }
            
            const ocrResult = await ocrResponse.json();
            
            if (ocrResult.success) {
                const smartDetectedNumbers = parseIndianRegistrationNumber(ocrResult.extractedText || []);
                
                if (smartDetectedNumbers.length > 0) {
                    const detected = smartDetectedNumbers[0];
                    const similarity = calculateSimilarity(booking.actual_reg_number, detected);
                    const vinMatch = calculateVINMatch(booking.actual_reg_number, detected);
                    
                    // Track all similarities for best match calculation
                    allSimilarities.push(similarity);
                    
                    // Update best match
                    if (similarity > bestSimilarity) {
                        bestSimilarity = similarity;
                        bestDetectedNumber = detected;
                    }

                    // Update best VIN match
                    if (vinMatch > bestVINMatch) {
                        bestVINMatch = vinMatch;
                    }
                    
                    if (similarity === 100) {
                        hasExactMatch = true;
                        rowData[imageColumnName] = `✅ ${detected}`;
                    } else if (similarity > 80) {
                        rowData[imageColumnName] = `🟡 ${detected}`;
                    } else {
                        rowData[imageColumnName] = `❌ ${detected}`;
                    }
                } else {
                    const errorReasons = analyzeImageError(ocrResult, imageUrls[j]);
                    const primaryError = errorReasons[0] || 'Unknown detection issue';
                    rowData[imageColumnName] = `❌ ${primaryError}`;
                    allSimilarities.push(0);
                }
            } else {
                const errorMessage = ocrResult.error || 'Unknown OCR error';
                rowData[imageColumnName] = `🔴 ${errorMessage}`;
                allSimilarities.push(0);
            }
        } catch (error) {
            rowData[imageColumnName] = `🔴 Network Error`;
            allSimilarities.push(0);
        }
        
        await new Promise(resolve => setTimeout(resolve, 100));
        
        // Early exit if exact match found
        if (hasExactMatch) break;
    }
    
    // Calculate new column values
    rowData['Best Percentage Match'] = bestSimilarity;
    
    // VIN (last 4 digits) analysis
    if (bestDetectedNumber) {
        const actualLast4 = getLast4Digits(booking.actual_reg_number);
        const detectedLast4 = getLast4Digits(bestDetectedNumber);
        rowData['VIN'] = detectedLast4 || 'N/A';
        rowData['VIN Percentage Match'] = bestVINMatch;
    }
    
    // Update final status
    if (hasExactMatch) {
        rowData['Match Status'] = '✅ EXACT MATCH';
    }
    
    return rowData;
}


let processingQueue = new Set(); // Track bookings currently being processed

async function checkForNewBookings() {
    const client = new Client(dbConfig);
    
    try {
        await client.connect();
        
        const query = `
            SELECT 
                b.id as booking_id,
                b.status as booking_status,
                b.booking_starting_images,
                bk.reg_number as actual_reg_number,
                b.created_at
            FROM public.booking b
            LEFT JOIN public.bike bk ON b.bike_id = bk.id
            WHERE b.booking_starting_images IS NOT NULL 
                AND b.booking_starting_images != ''
                AND bk.reg_number IS NOT NULL
                AND b.id > $1
                AND b.status = 'booking started and is in progress'
            ORDER BY b.id ASC
        `;

        const result = await client.query(query, [lastProcessedBookingId]);
        const newBookings = result.rows;
        
        if (newBookings.length > 0) {
            console.log(`DEBUG: Running query with lastProcessedBookingId: ${lastProcessedBookingId}`);
            console.log(`🆕 Found ${newBookings.length} new booking(s) to process...`);
            
        //     for (const booking of newBookings) {
        //         console.log(`📋 Processing Booking ID: ${booking.booking_id} (Status: ${booking.booking_status})`);
                
        //         const processingResult = await processBooking(booking);
                
        //         // Add to cache for dashboard
        //         processedBookingsCache.unshift(processingResult);
        //         if (processedBookingsCache.length > MAX_CACHE_SIZE) {
        //             processedBookingsCache.pop();
        //         }
                
        //         // Update stats
        //         monitoringStats.totalBookingsProcessed++;
        //         if (processingResult['VIN Percentage Match'] >= VIN_ACCURACY_THRESHOLD) {
        //             monitoringStats.vinAccurateMatches++;
        //         }
        //         monitoringStats.lastProcessedBooking = booking.booking_id;
                
        //         console.log(`✅ Processed Booking ${booking.booking_id} - ${processingResult['Match Status']} - VIN: ${processingResult['VIN Percentage Match']}%`);
                
        //         // Update lastProcessedBookingId to this booking's ID
        //         lastProcessedBookingId = booking.booking_id;
        //     }
        // }


            // Start processing all bookings asynchronously (don't wait)
            newBookings.forEach(booking => {
                if (!processingQueue.has(booking.booking_id)) {
                    processingQueue.add(booking.booking_id);
                    processBookingAsync(booking); // Don't await this!
                }
            });
            
            // Update lastProcessedBookingId immediately (don't wait for processing)
            const maxBookingId = Math.max(...newBookings.map(b => b.booking_id));
            lastProcessedBookingId = maxBookingId;
            console.log(`📍 Updated lastProcessedBookingId to: ${lastProcessedBookingId} (processing ${processingQueue.size} bookings in background)`);
        }
        
    } catch (error) {
        console.error(`❌ Error checking for new bookings:`, error.message);
        monitoringStats.failedProcessing++;
    } finally {
        await client.end();
    }
}

async function processBookingAsync(booking) {
    try {
        console.log(`📋 Starting async processing of Booking ID: ${booking.booking_id}`);
        
        const processingResult = await processBooking(booking);
        
        // Add to cache for dashboard
        processedBookingsCache.unshift(processingResult);
        if (processedBookingsCache.length > MAX_CACHE_SIZE) {
            processedBookingsCache.pop();
        }
        
        // Update stats
        monitoringStats.totalBookingsProcessed++;
        if (processingResult['VIN Percentage Match'] >= VIN_ACCURACY_THRESHOLD) {
            monitoringStats.vinAccurateMatches++;
        }
        monitoringStats.lastProcessedBooking = booking.booking_id;
        
        console.log(`✅ Completed async processing of Booking ${booking.booking_id} - ${processingResult['Match Status']} - VIN: ${processingResult['VIN Percentage Match']}%`);
        
    } catch (error) {
        console.error(`❌ Error in async processing of booking ${booking.booking_id}:`, error.message);
        monitoringStats.failedProcessing++;
    } finally {
        // Remove from processing queue
        processingQueue.delete(booking.booking_id);
    }
}

// Helper function to get the current maximum booking ID
async function getCurrentMaxBookingId() {
    const client = new Client(dbConfig);
    
    try {
        await client.connect();
        
        const query = `
            SELECT COALESCE(MAX(id), 0) as max_id 
            FROM public.booking
        `;
        
        const result = await client.query(query);
        return result.rows[0].max_id;
        
    } catch (error) {
        console.error('Error getting max booking ID:', error.message);
        return 0;
    } finally {
        await client.end();
    }
}

// =====================================================================================
// API ENDPOINTS
// =====================================================================================

// Enhanced smart endpoint for dashboard compatibility
app.get('/analyze/smart', async (req, res) => {
    try {
        // Return recent processed bookings from cache
        const accuracy = monitoringStats.totalBookingsProcessed > 0 ? 
                        Math.round((monitoringStats.vinAccurateMatches / monitoringStats.totalBookingsProcessed) * 100) : 0;
        
        res.json({
            success: true,
            message: 'Smart analysis - real-time monitoring data',
            strategy: 'Real-time new booking processing',
            accuracy_percentage: accuracy,
            exact_matches: monitoringStats.vinAccurateMatches,
            total_processed: monitoringStats.totalBookingsProcessed,
            table_data: processedBookingsCache.slice(0, 50) // Return last 50 for dashboard
        });
        
    } catch (error) {
        console.error('Smart analysis error:', error);
        res.status(500).json({
            error: 'Smart analysis failed',
            details: error.message
        });
    }
});

// Export results from cache
app.get('/export/results', (req, res) => {
    try {
        const format = req.query.format || 'json';
        
        if (processedBookingsCache.length === 0) {
            return res.status(404).json({ 
                error: 'No results found to export',
                message: 'Process some bookings first before exporting'
            });
        }
        
        if (format === 'csv') {
            // Generate CSV from cache
            const headers = [
                'Booking ID', 'Actual Registration', 'Image 1', 'Image 2', 'Image 3', 'Image 4',
                'Best Percentage Match', 'VIN', 'VIN Percentage Match', 'Match Status', 'Created'
            ];
            
            const csvContent = [
                headers.join(','),
                ...processedBookingsCache.map(row => [
                    row['Booking ID'],
                    `"${row['Actual Registration']}"`,
                    `"${row['Image 1']}"`,
                    `"${row['Image 2']}"`,
                    `"${row['Image 3']}"`,
                    `"${row['Image 4']}"`,
                    row['Best Percentage Match'],
                    `"${row['VIN']}"`,
                    row['VIN Percentage Match'],
                    `"${row['Match Status']}"`,
                    `"${row['Created']}"`
                ].join(','))
            ].join('\n');
            
            res.setHeader('Content-Type', 'text/csv');
            res.setHeader('Content-Disposition', `attachment; filename=analysis_results_${new Date().toISOString().split('T')[0]}.csv`);
            res.send(csvContent);
        } else {
            // JSON export from cache
            const jsonData = processedBookingsCache.map(row => ({
                ...row,
                timestamp: new Date().toISOString(),
                processed_at: new Date().toLocaleString()
            }));
            
            res.setHeader('Content-Type', 'application/json');
            res.setHeader('Content-Disposition', `attachment; filename=analysis_results_${new Date().toISOString().split('T')[0]}.json`);
            res.json(jsonData);
        }
        
    } catch (error) {
        console.error('Export error:', error);
        res.status(500).json({
            error: 'Export failed',
            details: error.message
        });
    }
});

// Start continuous monitoring
app.post('/monitor/start', async (req, res) => {
    const { hours = 4 } = req.body;
    
    if (isMonitoring) {
        return res.status(400).json({
            error: 'Monitoring is already running',
            current_stats: monitoringStats
        });
    }
    
    isMonitoring = true;
    
    // Get the current maximum booking ID to start monitoring from
    lastProcessedBookingId = await getCurrentMaxBookingId();
    
    monitoringStats = {
        startTime: Date.now(),
        totalBookingsProcessed: 0,
        vinAccurateMatches: 0,
        failedProcessing: 0,
        lastProcessedBooking: null
    };
    
    // Clear cache
    processedBookingsCache = [];
    
    const endTime = Date.now() + (hours * 60 * 60 * 1000);
    
    console.log(`🚀 Starting continuous monitoring for ${hours} hours...`);
    console.log(`⏰ Start time: ${new Date().toLocaleString()}`);
    console.log(`🔍 Only processing bookings with ID > ${lastProcessedBookingId} and status = 'booking started and is in progress'`);
    console.log(`🔍 Checking every 30 seconds for new bookings...`);
    console.log(`🎯 Accuracy calculation: VIN-based (${VIN_ACCURACY_THRESHOLD}% threshold)`);
    
    currentMonitoringInterval = setInterval(async () => {
        if (Date.now() >= endTime) {
            clearInterval(currentMonitoringInterval);
            currentMonitoringInterval = null;
            isMonitoring = false;
            console.log(`🏁 Monitoring completed after ${hours} hours`);
            return;
        }
        
        await checkForNewBookings();
    }, 30000); // Check every 30 seconds
    
    res.json({
        success: true,
        message: `Continuous monitoring started for ${hours} hours`,
        monitoring_interval_seconds: 30,
        start_time: new Date().toISOString(),
        will_stop_at: new Date(endTime).toISOString(),
        starting_from_booking_id: lastProcessedBookingId,
        status_filter: 'booking started and is in progress'
    });
});

// Stop monitoring
app.post('/monitor/stop', (req, res) => {
    if (!isMonitoring) {
        return res.status(400).json({
            error: 'No monitoring is currently running'
        });
    }
    
    // Clear the monitoring interval
    if (currentMonitoringInterval) {
        clearInterval(currentMonitoringInterval);
        currentMonitoringInterval = null;
    }
    
    isMonitoring = false;
    
    const runtime = Date.now() - monitoringStats.startTime;
    const accuracy = monitoringStats.totalBookingsProcessed > 0 ? 
                   Math.round((monitoringStats.vinAccurateMatches / monitoringStats.totalBookingsProcessed) * 100) : 0;
    
    console.log(`🛑 Monitoring stopped manually`);
    
    res.json({
        success: true,
        message: 'Monitoring stopped',
        final_stats: {
            runtime_ms: runtime,
            total_bookings_processed: monitoringStats.totalBookingsProcessed,
            exact_matches: monitoringStats.vinAccurateMatches, // For dashboard compatibility
            accuracy_percentage: accuracy, // Now VIN-based
            failed_processing: monitoringStats.failedProcessing,
            last_processed_booking: monitoringStats.lastProcessedBooking,
            last_processed_booking_id: lastProcessedBookingId,
            status_filter: 'booking started and is in progress'
        }
    });
});

// Health check
app.get('/health', (req, res) => {
    res.json({ 
        status: 'OK', 
        service: 'Continuous Registration Monitoring Service',
        monitoring_active: isMonitoring,
        ocr_service_url: OCR_SERVICE_URL,
        cached_results: processedBookingsCache.length,
        last_processed_booking_id: lastProcessedBookingId,
        accuracy_method: 'VIN-based',
        vin_threshold: VIN_ACCURACY_THRESHOLD
    });
});

// Start the monitoring service
app.listen(ANALYSIS_PORT, () => {
    console.log(`🔬 Continuous Registration Monitoring Service running on port ${ANALYSIS_PORT}`);
    console.log(`🎯 Accuracy Calculation: VIN-based (${VIN_ACCURACY_THRESHOLD}% threshold)`);
    console.log('Available endpoints:');
    console.log(`  🌐 Dashboard: http://localhost:${ANALYSIS_PORT}/`);
    console.log(`  📊 Smart Analysis: GET http://localhost:${ANALYSIS_PORT}/analyze/smart`);
    console.log(`  🚀 Start Monitoring: POST http://localhost:${ANALYSIS_PORT}/monitor/start`);
    console.log(`  🛑 Stop Monitoring: POST http://localhost:${ANALYSIS_PORT}/monitor/stop`);
    console.log(`  📊 Check Status: GET http://localhost:${ANALYSIS_PORT}/monitor/status`);
    console.log(`  📁 Export Results: GET http://localhost:${ANALYSIS_PORT}/export/results?format=[json|csv]`);
    console.log(`  ❤️  Health Check: GET http://localhost:${ANALYSIS_PORT}/health`);
    console.log(`\n🔗 OCR Service: ${OCR_SERVICE_URL}`);
    console.log(`🎯 Ready for real-time monitoring of new bookings!`);
    console.log(`📊 Accuracy will be calculated based on VIN percentage matches instead of exact matches`);
    console.log(`\nOpen http://localhost:${ANALYSIS_PORT}/ to view the monitoring dashboard`);
});

export default app;