import express from 'express';
import pg from 'pg';
import fetch from 'node-fetch';
import path from 'path';
import { fileURLToPath } from 'url';
import sharp from 'sharp';
import { promisify } from 'util';

// Azure Computer Vision imports
import { ComputerVisionClient } from '@azure/cognitiveservices-computervision';
import { ApiKeyCredentials } from '@azure/ms-rest-js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const sleep = promisify(setTimeout);

// =====================================================================================
// ANALYSIS SERVICE WITH REAL-TIME MONITORING
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

const testDbConfig = {
    host: '34.135.250.20',
    port: 5432,
    database: 'bounceb2btest', // Test DB
    user: 'postgres',
    password: 'MR=}B\\2:L#<mBU*t',
};

// Azure Computer Vision configuration
const AZURE_VISION_KEY = process.env.VISION_KEY;
const AZURE_VISION_ENDPOINT = process.env.VISION_ENDPOINT;

if (!AZURE_VISION_KEY || !AZURE_VISION_ENDPOINT) {
    console.error('⚠️  Warning: Azure Computer Vision credentials not found in environment variables');
    console.error('Set VISION_KEY and VISION_ENDPOINT environment variables for OCR functionality');
}
const ANALYSIS_PORT = 3001;

// VIN accuracy threshold (configurable)
const VIN_ACCURACY_THRESHOLD = 100; // 100% VIN match required for counting as accurate

// Global state for continuous monitoring
let lastProcessedTime = null;
let isMonitoring = false;
let currentMonitoringInterval = null;
let monitoringStats = {
    startTime: null,
    totalBookingsProcessed: 0,
    vinAccurateMatches: 0,
    failedProcessing: 0,
    lastProcessedBooking: null,
    lastProcessedTime: null
};

// Real-time processed bookings cache (for the dashboard)
let processedBookingsCache = [];
const MAX_CACHE_SIZE = 100;

// Create Azure Computer Vision client
let computerVisionClient = null;
if (AZURE_VISION_KEY && AZURE_VISION_ENDPOINT) {
    const normalizedEndpoint = AZURE_VISION_ENDPOINT.endsWith('/') ? 
        AZURE_VISION_ENDPOINT.slice(0, -1) : AZURE_VISION_ENDPOINT;
    
    computerVisionClient = new ComputerVisionClient(
        new ApiKeyCredentials({ inHeader: { 'Ocp-Apim-Subscription-Key': AZURE_VISION_KEY } }),
        normalizedEndpoint
    );
    console.log('✅ Azure Computer Vision client initialized');
} else {
    console.log('❌ Azure Computer Vision client not initialized - OCR will be disabled');
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..')));

// Serve the monitoring dashboard
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '../index.html'));
});

// Function to extract text from image buffer using Azure OCR
async function extractTextFromImageUrl(imageUrl) {
    if (!computerVisionClient) {
        throw new Error('Azure Computer Vision not configured. Set VISION_KEY and VISION_ENDPOINT environment variables.');
    }

    try {
        // Download and compress the image first
        const response = await fetch(imageUrl);
        if (!response.ok) {
            throw new Error(`Failed to download image: ${response.statusText}`);
        }
        
        const imageArrayBuffer = await response.arrayBuffer();
        const imageBuffer = Buffer.from(imageArrayBuffer);
        
        // Compress the image using Sharp to ensure it's under 4MB
        const compressedBuffer = await sharp(imageBuffer)
            .resize(1200, null, {
                withoutEnlargement: true,
                fit: 'inside'
            })
            .jpeg({ quality: 85 })
            .toBuffer();
        
        console.log(`Image compressed: ${imageBuffer.length} -> ${compressedBuffer.length} bytes`);
        
        // Call Azure Computer Vision Read API
        const readResult = await computerVisionClient.readInStream(compressedBuffer, {
            language: 'en',
            detectOrientation: true,
        });
        
        const operationId = readResult.operationLocation.split('/').slice(-1)[0];
        
        let result;
        let attempts = 0;
        const maxAttempts = 30;
        
        while (result?.status !== "succeeded" && attempts < maxAttempts) {
            await sleep(1000);
            result = await computerVisionClient.getReadResult(operationId);
            attempts++;
            
            if (result?.status === "failed") {
                throw new Error('OCR operation failed');
            }
        }
        
        if (attempts >= maxAttempts) {
            throw new Error('OCR operation timed out');
        }
        
        // Extract text from all pages
        const extractedText = [];
        for (const page of result.analyzeResult.readResults) {
            for (const line of page.lines) {
                extractedText.push(line.text);
            }
        }
        
        return extractedText;
        
    } catch (error) {
        console.error('OCR Error:', error);
        throw error;
    }
}

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
    console.log(`\n=== Scoring candidate: "${str}" ===`);

    if (!str || str.length < 8 || str.length > 10){
        console.log('Failed basic validation (length check)');
        return 0;
    }
    
    const stateCodes = getIndianStateCodes();
    let score = 0;
    console.log('Initial score:', score);
    
    const stateCode = stateCodes.find(code => str.startsWith(code));
    if (!stateCode){
        console.log('No valid state code found at start');
        return 0;
    }

    console.log(`Found state code: "${stateCode}"`);
    score += 100;
    console.log('Score after state code:', score);
    
    const commonStates = ['DL', 'NCR', 'KA', 'UP'];
    if (commonStates.includes(stateCode)) {
        console.log(`"${stateCode}" is a common state, adding 20 points`);
        score += 20;
        console.log('Score after common state bonus:', score);
    } else {
        console.log(`"${stateCode}" is not a common state, no bonus`);
    }
    
    const afterState = str.substring(stateCode.length);
    console.log(`Text after state code: "${afterState}"`);
    
    if (/^\d{1,2}[A-Z]{1,2}\d{4}$/.test(afterState)) {
        console.log('Matches pattern: 1-2 digits + 1-2 letters + 4 digits, adding 50 points');
        score += 50;
    } else if (/^[A-Z]{1,2}\d{4,5}$/.test(afterState)) {
        console.log('Matches pattern: 1-2 letters + 4-5 digits, adding 40 points');
        score += 40;
    } else if (/^\d+[A-Z]+\d+$/.test(afterState)) {
        console.log('Matches pattern: digits + letters + digits, adding 30 points');
        score += 30;
    } else if (/^\d+$/.test(afterState)) {
        console.log('Matches pattern: only digits, adding 10 points');
        score += 10;
    }else {
        console.log('No pattern match for remaining text, no points added');
    }
    console.log('Score after pattern matching:', score);
    
    if (str.length === 10) {
        console.log('Length is 10, adding 15 points');
        score += 15;
    } else if (str.length === 9) {
        console.log('Length is 9, adding 10 points');
        score += 10;
    } else if (str.length === 8) {
        console.log('Length is 8, adding 5 points');
        score += 5;
    }
    console.log('Score after length bonus:', score);
    
    if (str.includes('O0') || str.includes('0O')) {
        console.log('Contains O0 or 0O pattern, subtracting 10 points');
        score -= 10;
        console.log('Score after O0/0O penalty:', score);
    }
    
    if (str.includes('I1') || str.includes('1I')) {
        console.log('Contains I1 or 1I pattern, subtracting 10 points');
        score -= 10;
        console.log('Score after I1/1I penalty:', score);
    }
    
    console.log(`=== Final score for "${str}": ${score} ===\n`);
    
    return score;
}

function applyMandatoryPatternCorrection(text) {
    const normalized = normalizeRegNumber(text);
    console.log('=== AQ Pattern Correction ===');
    console.log('Original detected:', text);
    console.log('After normalization:', normalized);
    
    const aqPattern = /^(KA\d{1,2})A0(\d+)$/;
    const match = normalized.match(aqPattern);
    const dlsevPattern = /^DLSEV(\d+)$/;
    const dlsevMatch = normalized.match(dlsevPattern);
    
    if (match) {
        const corrected = match[1] + 'AQ' + match[2];
        console.log(`🔧 Mandatory AQ Pattern Applied: ${normalized} → ${corrected}`);
        return corrected;
    } else if (dlsevMatch) {
        const corrected = 'DL9EV' + dlsevMatch[1];
        console.log(`🔧 Mandatory DLSEV Pattern Applied: ${normalized} → ${corrected}`);
        return corrected;
    }
    
    console.log('No AQ pattern found, returning original');
    return normalized;
}

function applyTargetedOCRCorrections(text) {
    let corrected = text.toUpperCase();
    console.log('Before correction:', corrected);

    const corrections = [
        ['S', '9'], ['0', 'Q'], ['O', '0'], ['S', '5'], ['B', '8'], ['G', '6'], ['Z', '2']
    ];
    
    let bestCandidate = corrected;
    let bestScore = scoreRegistrationCandidate(corrected);
    
    corrections.forEach(([from, to]) => {
        if (corrected.includes(from)) {
            console.log(`Going for correction due to ${from} in `, corrected);
            const candidate = corrected.replace(new RegExp(from, 'g'), to);
            const score = scoreRegistrationCandidate(candidate);
            console.log(`Trying correction ${from} → ${to}:`, candidate, 'Score:', score);
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
            // Apply mandatory AQ correction FIRST, before any scoring
            const aqCorrected = applyMandatoryPatternCorrection(cleaned);
            const score = scoreRegistrationCandidate(aqCorrected);
            if (score > 0) {
                candidates.push({ text: aqCorrected, score, source: `line_${index + 1}_aq_corrected` });
            }
            
            const corrected = applyTargetedOCRCorrections(aqCorrected);
            if (corrected !== aqCorrected) {
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
                    // Apply mandatory AQ correction
                    const aqCorrected = applyMandatoryPatternCorrection(combined);
                    
                    const score = scoreRegistrationCandidate(aqCorrected);
                    if (score > 0) {
                        candidates.push({ text: aqCorrected, score: score + 10, source: `spaced_line_${index + 1}_aq_corrected` });
                    }
                    
                    const corrected = applyTargetedOCRCorrections(aqCorrected);
                    if (corrected !== aqCorrected) {
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
        const aqCorrected = applyMandatoryPatternCorrection(allText);
        const score = scoreRegistrationCandidate(aqCorrected);
        if (score > 0) {
            candidates.push({ text: aqCorrected, score: score - 20, source: 'combined_aq_corrected' });
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
                        const aqCorrected = applyMandatoryPatternCorrection(extracted);
                        const score = scoreRegistrationCandidate(aqCorrected);
                        if (score > 0) {
                            candidates.push({ text: aqCorrected, score: score - 10, source: `extracted_${stateCode}_line_${index + 1}_aq_corrected` });
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
        console.log(`✅ Best candidate after mandatory AQ correction: ${best.text} (score: ${best.score})`);
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
        'VIN': 'N/A',
        'VIN Percentage Match': 0,
        'Match Status': 'NO MATCH',
        'Created': new Date(booking.booking_start_time).toLocaleDateString()
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
            const extractedText = await extractTextFromImageUrl(imageUrls[j]);
            
            const ocrResult = {
                success: true,
                extractedText: extractedText
            };
            
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
                        rowData[imageColumnName] = `${detected}`;
                    } else if (similarity > 80) {
                        rowData[imageColumnName] = `${detected}`;
                    } else {
                        rowData[imageColumnName] = `${detected}`;
                    }
                } else {
                    const errorReasons = analyzeImageError(ocrResult, imageUrls[j]);
                    const primaryError = errorReasons[0] || 'Unknown detection issue';
                    rowData[imageColumnName] = `${primaryError}`;
                    allSimilarities.push(0);
                }
            } else {
                const errorMessage = ocrResult.error || 'Unknown OCR error';
                rowData[imageColumnName] = `${errorMessage}`;
                allSimilarities.push(0);
            }
        } catch (error) {
            console.error(`Error processing image ${j + 1} for booking ${booking.booking_id}:`, error.message);
            rowData[imageColumnName] = `${error.message.includes('Azure') ? 'OCR Service Error' : 'Network Error'}`;
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
        rowData['Match Status'] = 'EXACT MATCH';
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
                b.booking_start_time
            FROM public.booking b
            LEFT JOIN public.bike bk ON b.bike_id = bk.id
            WHERE b.booking_starting_images IS NOT NULL 
                AND b.booking_starting_images != ''
                AND bk.reg_number IS NOT NULL
                AND b.booking_start_time > $1
                AND b.status = 'booking started and is in progress'
            ORDER BY b.booking_start_time ASC
        `;

        const result = await client.query(query, [lastProcessedTime]);
        const newBookings = result.rows;
        
        if (newBookings.length > 0) {
            console.log(`DEBUG: Running query with lastProcessedTime: ${lastProcessedTime}`);
            console.log(`🆕 Found ${newBookings.length} new booking(s) to process...`);

            // Start processing all bookings asynchronously
            newBookings.forEach(booking => {
                if (!processingQueue.has(booking.booking_id)) {
                    processingQueue.add(booking.booking_id);
                    processBookingAsync(booking);
                }
            });
            
            // Update lastProcessedTime immediately
            const latestBookingTime = new Date(Math.max(...newBookings.map(b => new Date(b.booking_start_time))));
            lastProcessedTime = latestBookingTime;
            console.log(`📍 Updated lastProcessedTime to: ${lastProcessedTime} (processing ${processingQueue.size} bookings in background)`);
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
        console.log(`📋 Starting async processing of Booking ID: ${booking.booking_id} (Start Time: ${booking.booking_start_time})`);
        
        const processingResult = await processBooking(booking);

        saveProcessingResultToTestDB(processingResult).catch(err => {
            console.error(`Failed to save booking ${booking.booking_id} to test DB:`, err.message);
        });
        
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
        monitoringStats.lastProcessedTime = booking.booking_start_time;
        
        console.log(`✅ Completed async processing of Booking ${booking.booking_id} - ${processingResult['Match Status']} - VIN: ${processingResult['VIN Percentage Match']}%`);
        
    } catch (error) {
        console.error(`❌ Error in async processing of booking ${booking.booking_id}:`, error.message);
        monitoringStats.failedProcessing++;
    } finally {
        // Remove from processing queue
        processingQueue.delete(booking.booking_id);
    }
}

async function getCurrentLatestBookingTime() {
    const client = new Client(dbConfig);
    
    try {
        await client.connect();
        
        const query = `
            SELECT COALESCE(MAX(b.booking_start_time), NOW() AT TIME ZONE 'UTC') as latest_time 
            FROM public.booking b
            LEFT JOIN public.bike bk ON b.bike_id = bk.id
            WHERE b.booking_starting_images IS NOT NULL 
                AND b.booking_starting_images != ''
                AND bk.reg_number IS NOT NULL
                AND b.status = 'booking started and is in progress'
        `;
        
        const result = await client.query(query);
        return result.rows[0].latest_time;
        
    } catch (error) {
        console.error('Error getting max booking ID:', error.message);
        const utcNow = new Date();
        console.log(`📅 Using fallback current time (UTC): ${utcNow}`);
        return utcNow;
    } finally {
        await client.end();
    }
}

async function saveProcessingResultToTestDB(rowData) {
    const client = new Client(testDbConfig); // Using test DB config
    
    try {
        await client.connect();
        
        const insertQuery = `
            INSERT INTO analysis_results (
                booking_id,
                actual_registration,
                image_1,
                image_2,
                image_3,
                image_4,
                best_percentage_match,
                vin,
                vin_percentage_match,
                match_status,
                created_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW() AT TIME ZONE 'UTC')
            RETURNING id;
        `;
        
        const values = [
            rowData['Booking ID'].toString(), // Convert to VARCHAR
            rowData['Actual Registration'],
            rowData['Image 1'],
            rowData['Image 2'],
            rowData['Image 3'],
            rowData['Image 4'],
            parseFloat(rowData['Best Percentage Match']) || 0.00, // Convert to DECIMAL
            rowData['VIN'],
            parseFloat(rowData['VIN Percentage Match']) || 0.00, // Convert to DECIMAL
            rowData['Match Status']
        ];
        
        const result = await client.query(insertQuery, values);
        console.log(`💾 Saved processing result to TEST DB (analysis_results) with ID: ${result.rows[0].id}`);
        
        return result.rows[0].id;
        
    } catch (error) {
        console.error(`❌ Error saving to TEST database:`, error.message);
        // Don't throw error - we don't want to break the main processing if DB save fails
    } finally {
        await client.end();
    }
}

// =====================================================================================
// API ENDPOINTS
// =====================================================================================

app.post('/ocr/registration-number-url', async (req, res) => {
    try {
        const { imageUrl, actualRegNumber } = req.body;
        
        if (!imageUrl) {
            return res.status(400).json({ error: 'Image URL is required' });
        }

        if (!computerVisionClient) {
            return res.status(503).json({ 
                error: 'OCR service not available',
                details: 'Azure Computer Vision not configured. Set VISION_KEY and VISION_ENDPOINT environment variables.'
            });
        }

        const extractedText = await extractTextFromImageUrl(imageUrl);
        const registrationNumbers = parseIndianRegistrationNumber(extractedText);
        
        // Build response object
        const response = {
            success: true,
            extractedText: extractedText,
            registrationNumbers: registrationNumbers,
            message: registrationNumbers.length > 0 ? `Found ${registrationNumbers.length} registration number(s)` : 'No registration numbers detected'
        };

        // If actualRegNumber is provided, calculate VIN match and similarity
        if (actualRegNumber && registrationNumbers.length > 0) {
            const detectedRegNumber = registrationNumbers[0]; // Use first detected number
            
            // Calculate VIN match (last 4 digits)
            const vinMatch = calculateVINMatch(actualRegNumber, detectedRegNumber);
            
            // Calculate overall similarity
            const overallSimilarity = calculateSimilarity(actualRegNumber, detectedRegNumber);
            
            // Get last 4 digits for comparison
            const actualLast4 = getLast4Digits(actualRegNumber);
            const detectedLast4 = getLast4Digits(detectedRegNumber);
            
            // Add comparison data to response
            response.comparison = {
                actual_reg_number: actualRegNumber,
                detected_reg_number: detectedRegNumber,
                vin_match_percentage: vinMatch,
                overall_similarity_percentage: overallSimilarity,
                actual_last_4_digits: actualLast4,
                detected_last_4_digits: detectedLast4,
                vin_match_exact: vinMatch === 100,
                overall_match_exact: overallSimilarity === 100
            };
            
            response.message += ` | VIN Match: ${vinMatch}% | Overall Similarity: ${overallSimilarity}%`;
        }
        
        res.json(response);
        
    } catch (error) {
        console.error('OCR Error:', error);
        res.status(500).json({
            error: 'OCR processing failed',
            details: error.message
        });
    }
});

app.get('/analyze/smart', async (req, res) => {
    try {
        const accuracy = monitoringStats.totalBookingsProcessed > 0 ? 
                        Math.round((monitoringStats.vinAccurateMatches / monitoringStats.totalBookingsProcessed) * 100) : 0;
        
        res.json({
            success: true,
            message: 'Smart analysis - real-time monitoring data',
            strategy: 'Real-time new booking processing',
            accuracy_percentage: accuracy,
            exact_matches: monitoringStats.vinAccurateMatches,
            total_processed: monitoringStats.totalBookingsProcessed,
            table_data: processedBookingsCache.slice(0, 100)
        });
        
    } catch (error) {
        console.error('Smart analysis error:', error);
        res.status(500).json({
            error: 'Smart analysis failed',
            details: error.message
        });
    }
});

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

app.post('/monitor/start', async (req, res) => {
    const hours = req.body?.hours || 4;
    
    if (isMonitoring) {
        return res.status(400).json({
            error: 'Monitoring is already running',
            current_stats: monitoringStats
        });
    }

    if (!computerVisionClient) {
        return res.status(503).json({
            error: 'Cannot start monitoring - OCR service not available',
            details: 'Azure Computer Vision not configured. Set VISION_KEY and VISION_ENDPOINT environment variables.'
        });
    }
    
    isMonitoring = true;
    
    // Get the latest booking_start_time to start monitoring from
    lastProcessedTime = await getCurrentLatestBookingTime();
    
    monitoringStats = {
        startTime: Date.now(),
        totalBookingsProcessed: 0,
        vinAccurateMatches: 0,
        failedProcessing: 0,
        lastProcessedBooking: null,
        lastProcessedTime: lastProcessedTime
    };
    
    processedBookingsCache = [];
    
    const endTime = Date.now() + (hours * 60 * 60 * 1000);
    
    console.log(`🚀 Starting continuous monitoring for ${hours} hours...`);
    console.log(`⏰ Start time: ${new Date().toLocaleString()}`);
    console.log(`🔍 Only processing bookings with booking_start_time > ${lastProcessedTime} and status = 'booking started and is in progress'`);
    console.log(`🔍 Checking every 60 seconds for new bookings...`);
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
    }, 60000);
    
    res.json({
        success: true,
        message: `Continuous monitoring started for ${hours} hours`,
        monitoring_interval_seconds: 60,
        start_time: new Date().toISOString(),
        will_stop_at: new Date(endTime).toISOString(),
        starting_from_time: lastProcessedTime,
        status_filter: 'booking started and is in progress',
        processing_method: 'time-based using booking_start_time'
    });
});

app.post('/monitor/stop', (req, res) => {
    if (!isMonitoring) {
        return res.status(400).json({
            error: 'No monitoring is currently running'
        });
    }
    
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
            exact_matches: monitoringStats.vinAccurateMatches,
            accuracy_percentage: accuracy,
            failed_processing: monitoringStats.failedProcessing,
            last_processed_booking: monitoringStats.lastProcessedBooking,
            last_processed_time: monitoringStats.lastProcessedTime,
            status_filter: 'booking started and is in progress',
            processing_method: 'time-based using booking_start_time'
        }
    });
});

app.get('/health', (req, res) => {

    const ocrStatus = computerVisionClient ? 'Available' : 'Not Configured';

    res.json({ 
        status: 'OK', 
        service: 'Continuous Registration Monitoring Service',
        monitoring_active: isMonitoring,
        ocr_service_status: ocrStatus,
        cached_results: processedBookingsCache.length,
        last_processed_time: lastProcessedTime,
        accuracy_method: 'VIN-based',
        vin_threshold: VIN_ACCURACY_THRESHOLD,
        azure_vision_configured: !!computerVisionClient
    });
});

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
    console.log(`  🔍 Direct OCR: POST http://localhost:${ANALYSIS_PORT}/ocr/registration-number-url`);
    console.log(`  ❤️  Health Check: GET http://localhost:${ANALYSIS_PORT}/health`);
    console.log(`🎯 Ready for real-time monitoring of new bookings!`);
    console.log(`📊 Accuracy will be calculated based on VIN percentage matches instead of exact matches`);

    if (!computerVisionClient) {
        console.log(`\n⚠️  WARNING: Set VISION_KEY and VISION_ENDPOINT environment variables to enable OCR functionality`);
    }
    
    console.log(`\nOpen http://localhost:${ANALYSIS_PORT}/ to view the monitoring dashboard`);
});

process.on('uncaughtException', (error) => {
    console.error('🚨 Uncaught Exception:', error);
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('🚨 Unhandled Rejection at:', promise, 'reason:', reason);
    process.exit(1);
});

export default app;