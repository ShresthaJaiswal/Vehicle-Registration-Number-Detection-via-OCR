import express from 'express';
import multer from 'multer';
import { ComputerVisionClient } from '@azure/cognitiveservices-computervision';
import { ApiKeyCredentials } from '@azure/ms-rest-js';
import fs from 'fs';
import { promisify } from 'util';
import pg from 'pg';
import fetch from 'node-fetch';
import sharp from 'sharp';

// Add these imports at the top if not already present
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const sleep = promisify(setTimeout);

// Azure Computer Vision configuration
const key = process.env.VISION_KEY;
const endpoint = process.env.VISION_ENDPOINT;

if (!key || !endpoint) {
    throw new Error('Set VISION_KEY and VISION_ENDPOINT environment variables');
}

// Ensure endpoint has proper format
const normalizedEndpoint = endpoint.endsWith('/') ? endpoint.slice(0, -1) : endpoint;
console.log('Using endpoint:', normalizedEndpoint);

// Add this route to serve the UI
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'test-ui.html'));
});

// Create Computer Vision client with proper configuration
const computerVisionClient = new ComputerVisionClient(
    new ApiKeyCredentials({ inHeader: { 'Ocp-Apim-Subscription-Key': key } }),
    normalizedEndpoint
);

// Configure multer for file uploads
const upload = multer({
    dest: 'uploads/',
    fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith('image/')) {
            cb(null, true);
        } else {
            cb(new Error('Only image files are allowed'), false);
        }
    },
    limits: {
        fileSize: 10 * 1024 * 1024 // 10MB limit
    }
});

const { Client } = pg;

// Database connection configuration
const dbConfig = {
    host: '34.93.196.129',
    port: 5432,
    database: 'bounceb2b',
    user: 'postgres',
    password: '37s_.gP0[o$[9CDo',
};

// Function to extract text using Azure OCR
async function extractTextFromImage(imagePath) {
    try {
        // Read the image file
        const imageBuffer = fs.readFileSync(imagePath);
        
        // Call Azure Computer Vision Read API
        const readResult = await computerVisionClient.readInStream(imageBuffer, {
            language: 'en',
            detectOrientation: true,
        });
        
        // Get the operation ID from the response
        const operationId = readResult.operationLocation.split('/').slice(-1)[0];
        
        // Poll for the result
        let result;
        let attempts = 0;
        const maxAttempts = 30; // Maximum 30 seconds
        
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
        console.error('Error during OCR:', error);
        throw error;
    }
}

// Function to extract text from buffer (for URL-based images)
async function extractTextFromBuffer(imageBuffer) {
    try {
        // Call Azure Computer Vision Read API
        const readResult = await computerVisionClient.readInStream(imageBuffer, {
            language: 'en',
            detectOrientation: true,
        });
        
        // Get the operation ID from the response
        const operationId = readResult.operationLocation.split('/').slice(-1)[0];
        
        // Poll for the result
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
        console.error('Error during OCR:', error);
        throw error;
    }
}

// Debug version - let's see what we're missing
// Enhanced function to get all Indian state codes
function getIndianStateCodes() {
    return [
        // Major states and territories (most common first)
        'DL', 'UP', 'KA', 'MH', 'TN', 'GJ', 'RJ', 'MP', 'WB', 'AP', 'TG', 'OR', 'KL', 'AS', 'BR', 'HR', 'HP', 'JH', 'UK', 'PB',
        // Union Territories and Special codes
        'NCR', 'CH', 'GA', 'MN', 'ML', 'MZ', 'NL', 'SK', 'TR', 'AR', 'JK', 'LA', 'LD', 'PY', 'AN', 'DN', 'DD',
        // Some 3-letter codes
        'BH', 'CG'
    ];
}

// Function to score how likely a string is to be a valid registration
function scoreRegistrationCandidate(str) {
    if (!str || str.length < 8 || str.length > 10) return 0;
    
    const stateCodes = getIndianStateCodes();
    let score = 0;
    
    // Check if starts with valid state code (high priority)
    const stateCode = stateCodes.find(code => str.startsWith(code));
    if (!stateCode) return 0;
    
    score += 100; // Base score for valid state code
    
    // Prefer common state codes
    const commonStates = ['DL', 'UP', 'KA', 'MH', 'TN', 'GJ', 'RJ', 'MP', 'WB'];
    if (commonStates.includes(stateCode)) {
        score += 20;
    }
    
    // Check pattern after state code
    const afterState = str.substring(stateCode.length);
    
    // Good patterns: numbers followed by letters followed by numbers
    // Examples: 01AB1234, 32QC1492, BD00012
    if (/^\d{1,2}[A-Z]{1,2}\d{4}$/.test(afterState)) {
        score += 50; // Perfect pattern
    } else if (/^[A-Z]{1,2}\d{4,5}$/.test(afterState)) {
        score += 40; // Good pattern (like BD00012)
    } else if (/^\d+[A-Z]+\d+$/.test(afterState)) {
        score += 30; // Acceptable pattern
    } else if (/^\d+$/.test(afterState)) {
        score += 10; // Only numbers (less likely but possible)
    }
    
    // Length preference (9-10 characters are most common)
    if (str.length === 10) score += 15;
    else if (str.length === 9) score += 10;
    else if (str.length === 8) score += 5;
    
    // Penalize obvious OCR errors in context
    if (str.includes('O0') || str.includes('0O')) score -= 10; // Likely O/0 confusion
    if (str.includes('I1') || str.includes('1I')) score -= 10; // Likely I/1 confusion
    
    return score;
}

// Function to apply targeted OCR corrections
function applyTargetedOCRCorrections(text) {
    // Only apply corrections that are very likely in registration number context
    let corrected = text.toUpperCase();
    
    // Apply most common registration number OCR corrections
    const corrections = [
        // In registration numbers, these are very likely corrections:
        ['Q', '0'],   // Q is almost never in registration numbers, likely 0
        ['O', '0'],   // O in middle/end of registration is likely 0
        ['S', '5'],   // S at end is often 5 in registration numbers
        ['B', '8'],   // B can be misread 8
        ['G', '6'],   // G can be misread 6
        ['Z', '2'],   // Z can be misread 2
    ];
    
    // Apply corrections but generate only the most likely single correction
    let bestCandidate = corrected;
    let bestScore = scoreRegistrationCandidate(corrected);
    
    // Try each correction one at a time (not combinatorial)
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

// Smart registration number parser that returns only the best candidate
function parseIndianRegistrationNumber(textArray) {
    const candidates = [];
    const stateCodes = getIndianStateCodes();
    
    console.log('OCR Text:', textArray);
    
    // Strategy 1: Check each line for registration patterns
    textArray.forEach((line, index) => {
        const cleaned = line.toUpperCase().replace(/[^A-Z0-9]/g, '');
        console.log(`Line ${index + 1}: "${line}" -> "${cleaned}"`);
        
        if (cleaned.length >= 8 && cleaned.length <= 10) {
            // Check original text
            const score = scoreRegistrationCandidate(cleaned);
            if (score > 0) {
                candidates.push({ text: cleaned, score, source: `line_${index + 1}` });
            }
            
            // Try OCR correction
            const corrected = applyTargetedOCRCorrections(cleaned);
            if (corrected !== cleaned) {
                const correctedScore = scoreRegistrationCandidate(corrected);
                if (correctedScore > 0) {
                    candidates.push({ text: corrected, score: correctedScore, source: `line_${index + 1}_corrected` });
                }
            }
        }
    });
    
    // Strategy 2: Handle spaced formats like "NCR BD 00012"
    textArray.forEach((line, index) => {
        // Look for spaced patterns
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
                        candidates.push({ text: combined, score: score + 10, source: `spaced_line_${index + 1}` }); // Bonus for spaced format
                    }
                    
                    // Try correction on spaced format
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
    
    // Strategy 3: Try combining text (as fallback)
    const allText = textArray.join('').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (allText.length >= 8 && allText.length <= 10) {
        const score = scoreRegistrationCandidate(allText);
        if (score > 0) {
            candidates.push({ text: allText, score: score - 20, source: 'combined' }); // Lower priority
        }
    }
    
    // Strategy 4: Look for state codes anywhere in longer strings
    textArray.forEach((line, index) => {
        const cleaned = line.toUpperCase().replace(/[^A-Z0-9]/g, '');
        stateCodes.forEach(stateCode => {
            const stateIndex = cleaned.indexOf(stateCode);
            if (stateIndex >= 0) {
                // Try extracting 8-10 characters starting from state code
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
    
    // Sort by score (highest first)
    uniqueCandidates.sort((a, b) => b.score - a.score);
    
    console.log('All candidates:', uniqueCandidates);
    
    // Return only the best candidate (or empty array if none found)
    if (uniqueCandidates.length > 0 && uniqueCandidates[0].score >= 100) {
        const best = uniqueCandidates[0];
        console.log(`Selected best registration: ${best.text} (score: ${best.score}, source: ${best.source})`);
        return [best.text];
    }
    
    console.log('No valid registration numbers found');
    return [];
}

// Enhanced validation function
function isValidRegistration(str) {
    return scoreRegistrationCandidate(str) >= 100;
}

// API endpoint for OCR
app.post('/ocr/registration-number', upload.single('image'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No image file provided' });
        }
        
        const imagePath = req.file.path;
        
        // Extract text from image
        const extractedText = await extractTextFromImage(imagePath);
        
        // Parse registration numbers
        const registrationNumbers = parseIndianRegistrationNumber(extractedText);
        
        // Clean up uploaded file
        fs.unlinkSync(imagePath);
        
        res.json({
            success: true,
            extractedText: extractedText,
            registrationNumbers: registrationNumbers,
            message: registrationNumbers.length > 0 
                ? `Found ${registrationNumbers.length} registration number(s)`
                : 'No registration numbers detected'
        });
        
    } catch (error) {
        // Clean up uploaded file if it exists
        if (req.file && fs.existsSync(req.file.path)) {
            fs.unlinkSync(req.file.path);
        }
        
        console.error('OCR Error:', error);
        res.status(500).json({
            error: 'OCR processing failed',
            details: error.message
        });
    }
});

// Alternative endpoint for URL-based images
app.post('/ocr/registration-number-url', express.json(), async (req, res) => {
    try {
        const { imageUrl } = req.body;
        
        if (!imageUrl) {
            return res.status(400).json({ error: 'Image URL is required' });
        }

        // Download and compress the image first
        const response = await fetch(imageUrl);
        if (!response.ok) {
            throw new Error(`Failed to download image: ${response.statusText}`);
        }
        
        // Use arrayBuffer() instead of deprecated buffer()
        const imageArrayBuffer = await response.arrayBuffer();
        const imageBuffer = Buffer.from(imageArrayBuffer);
        
        // Compress the image using Sharp to ensure it's under 4MB
        const compressedBuffer = await sharp(imageBuffer)
            .resize(1200, null, { // Resize to max width 1200px
                withoutEnlargement: true,
                fit: 'inside'
            })
            .jpeg({ quality: 85 }) // Use JPEG with 85% quality for better compression
            .toBuffer();
        
        console.log(`Original size: ${imageBuffer.length} bytes, Compressed size: ${compressedBuffer.length} bytes`);
        
        // Extract text using the buffer function
        const extractedText = await extractTextFromBuffer(compressedBuffer);
        
        const registrationNumbers = parseIndianRegistrationNumber(extractedText);
        
        res.json({
            success: true,
            extractedText: extractedText,
            registrationNumbers: registrationNumbers,
            message: registrationNumbers.length > 0 
                ? `Found ${registrationNumbers.length} registration number(s)`
                : 'No registration numbers detected'
        });
        
    } catch (error) {
        console.error('OCR Error:', error);
        res.status(500).json({
            error: 'OCR processing failed',
            details: error.message
        });
    }
});

// Test accuracy endpoint - with LIMIT for debugging
// Enhanced test accuracy endpoint with detailed statistics
app.get('/test/accuracy', async (req, res) => {
    const client = new Client(dbConfig);
    
    try {
        await client.connect();
        
        // Get only first 100 images for testing
        const query = `
            SELECT SPLIT_PART(booking_starting_images, '^', 1) as first_image_url,
                   id as booking_id
            FROM public.booking
            WHERE created_at >= CURRENT_DATE - INTERVAL '3 days'
                AND booking_starting_images IS NOT NULL 
                AND booking_starting_images != ''
            ORDER BY id ASC
            LIMIT 100;
        `;
        
        const result = await client.query(query);
        const imageUrls = result.rows.map(row => ({
            url: row.first_image_url,
            bookingId: row.booking_id
        }));
        
        console.log(`Testing ${imageUrls.length} images for accuracy analysis...`);
        
        // Initialize detailed counters
        let successfulOcrProcessing = 0;    // OCR worked (extracted text)
        let failedOcrProcessing = 0;        // OCR failed (network/API errors)
        let registrationsFound = 0;         // Successfully found registration numbers
        let noRegistrationFound = 0;        // OCR worked but no registration detected
        
        const PORT = process.env.PORT || 3000;
        const detailedResults = [];
        const startTime = Date.now();
        
        for (let i = 0; i < imageUrls.length; i++) {
            const { url, bookingId } = imageUrls[i];
            console.log(`\n=== Testing image ${i + 1}/${imageUrls.length} ===`);
            console.log(`Booking ID: ${bookingId}`);
            console.log(`URL: ${url}`);
            
            try {
                const response = await fetch(`http://localhost:${PORT}/ocr/registration-number-url`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ imageUrl: url })
                });
                
                const ocrResult = await response.json();
                
                if (response.ok && ocrResult.success) {
                    // OCR processing was successful
                    successfulOcrProcessing++;
                    
                    if (ocrResult.registrationNumbers && ocrResult.registrationNumbers.length > 0) {
                        // Registration numbers were found
                        registrationsFound++;
                        console.log(`✅ SUCCESS: Found ${ocrResult.registrationNumbers.join(', ')}`);
                        
                        detailedResults.push({
                            bookingId,
                            url,
                            status: 'REGISTRATION_FOUND',
                            registrationNumbers: ocrResult.registrationNumbers,
                            extractedText: ocrResult.extractedText,
                            success: true
                        });
                    } else {
                        // OCR worked but no registration found
                        noRegistrationFound++;
                        console.log(`⚠️  NO REGISTRATION FOUND`);
                        console.log(`Extracted text:`, ocrResult.extractedText?.slice(0, 3) || 'None');
                        
                        detailedResults.push({
                            bookingId,
                            url,
                            status: 'NO_REGISTRATION_FOUND',
                            registrationNumbers: [],
                            extractedText: ocrResult.extractedText,
                            success: true
                        });
                    }
                } else {
                    // OCR processing failed
                    failedOcrProcessing++;
                    console.log(`❌ OCR FAILED: ${ocrResult.error || 'Unknown error'}`);
                    
                    detailedResults.push({
                        bookingId,
                        url,
                        status: 'OCR_FAILED',
                        error: ocrResult.error || 'Unknown error',
                        details: ocrResult.details,
                        success: false
                    });
                }
                
            } catch (error) {
                // Network or other errors
                failedOcrProcessing++;
                console.log(`❌ NETWORK ERROR: ${error.message}`);
                
                detailedResults.push({
                    bookingId,
                    url,
                    status: 'NETWORK_ERROR',
                    error: error.message,
                    success: false
                });
            }
            
            // Add delay between requests to avoid overwhelming the API
            if (i < imageUrls.length - 1) {
                await new Promise(resolve => setTimeout(resolve, 100));
            }
        }
        
        const endTime = Date.now();
        const totalProcessingTime = Math.round((endTime - startTime) / 1000);
        
        // Calculate percentages
        const totalImages = imageUrls.length;
        const accuracyRate = totalImages > 0 ? ((registrationsFound / totalImages) * 100).toFixed(2) : '0.00';
        const ocrSuccessRate = totalImages > 0 ? ((successfulOcrProcessing / totalImages) * 100).toFixed(2) : '0.00';
        const registrationDetectionRate = successfulOcrProcessing > 0 ? ((registrationsFound / successfulOcrProcessing) * 100).toFixed(2) : '0.00';
        
        // Compile comprehensive results
        const comprehensiveResults = {
            // Summary Statistics
            summary: {
                totalImages,
                processingTimeSeconds: totalProcessingTime,
                averageTimePerImage: totalImages > 0 ? Math.round(totalProcessingTime / totalImages * 100) / 100 : 0
            },
            
            // Detailed Counts
            counts: {
                successfulOcrProcessing,      // OCR API worked and extracted text
                failedOcrProcessing,          // OCR API failed or network errors
                registrationsFound,           // Registration numbers detected
                noRegistrationFound,          // OCR worked but no registration detected
            },
            

            
            // Detailed Results (optional, can be large)
            detailedResults: detailedResults,
            
            // Quick Stats for Dashboard
            quickStats: {
                totalProcessed: totalImages,
                successful: registrationsFound,
                "ocr processing failed": failedOcrProcessing,
                noRegistration: noRegistrationFound,
                accuracy: `${accuracyRate}%`
            }
        };
        
        // Console summary
        console.log('\n=== COMPREHENSIVE ACCURACY RESULTS ===');
        console.log(`📊 Total Images Processed: ${totalImages}`);
        console.log(`✅ Successful OCR Processing: ${successfulOcrProcessing} (${ocrSuccessRate}%)`);
        console.log(`❌ Failed OCR Processing: ${failedOcrProcessing} (${(100 - parseFloat(ocrSuccessRate)).toFixed(2)}%)`);
        console.log(`🎯 Registration Numbers Found: ${registrationsFound} (${accuracyRate}%)`);
        console.log(`⚠️  No Registration Found: ${noRegistrationFound}`);
        console.log(`🔍 Registration Detection Rate: ${registrationDetectionRate}% (of successful OCR)`);
        console.log(`⏱️  Total Processing Time: ${totalProcessingTime} seconds`);
        console.log(`📈 Overall Accuracy: ${accuracyRate}%`);
        
        res.json(comprehensiveResults);
        
    } catch (error) {
        console.error('Accuracy test error:', error);
        res.status(500).json({ 
            error: 'Accuracy test failed',
            details: error.message 
        });
    } finally {
        await client.end();
    }
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ status: 'OK', service: 'Azure OCR Service' });
});

// Test endpoint with local image from assets
app.get('/test', async (req, res) => {
    try {
        // Use one of your local images from assets folder
        const localImagePath = './assets/car.jpg'; // Change this to test different images
        
        // Check if file exists
        if (!fs.existsSync(localImagePath)) {
            return res.status(404).json({
                error: 'Test image not found',
                availableImages: ['./assets/1.png', './assets/car.jpg', './assets/image.png']
            });
        }
        
        // Extract text from local image
        const extractedText = await extractTextFromImage(localImagePath);
        
        // Parse for Indian registration numbers
        const registrationNumbers = parseIndianRegistrationNumber(extractedText);
        
        res.json({
            success: true,
            message: 'Azure OCR is working with local image!',
            imagePath: localImagePath,
            extractedText: extractedText,
            registrationNumbers: registrationNumbers,
            found: registrationNumbers.length > 0 
                ? `Found ${registrationNumbers.length} registration number(s)` 
                : 'No registration numbers detected'
        });
        
    } catch (error) {
        res.status(500).json({
            error: 'Test failed',
            details: error.message
        });
    }
});

// Test endpoint for specific image
app.get('/test/:imageName', async (req, res) => {
    try {
        const { imageName } = req.params;
        const localImagePath = `./assets/${imageName}`;
        
        // Check if file exists
        if (!fs.existsSync(localImagePath)) {
            return res.status(404).json({
                error: `Image ${imageName} not found in assets folder`,
                availableImages: fs.readdirSync('./assets').filter(file => 
                    file.match(/\.(jpg|jpeg|png|bmp|gif)$/i)
                )
            });
        }
        
        // Extract text from specified image
        const extractedText = await extractTextFromImage(localImagePath);
        
        // Parse for Indian registration numbers
        const registrationNumbers = parseIndianRegistrationNumber(extractedText);
        
        res.json({
            success: true,
            message: `OCR completed for ${imageName}`,
            imagePath: localImagePath,
            extractedText: extractedText,
            registrationNumbers: registrationNumbers,
            found: registrationNumbers.length > 0 
                ? `Found ${registrationNumbers.length} registration number(s)` 
                : 'No registration numbers detected'
        });
        
    } catch (error) {
        res.status(500).json({
            error: 'OCR failed',
            details: error.message
        });
    }
});

app.get('/api/sample-urls', async (req, res) => {
    const client = new Client(dbConfig);
    try {
        await client.connect();
        const result = await client.query(`
            SELECT SPLIT_PART(booking_starting_images, '^', 1) as image_url,
                   id as booking_id
            FROM public.booking 
            WHERE booking_starting_images IS NOT NULL 
            AND booking_starting_images != ''
            ORDER BY created_at DESC
            LIMIT 50
        `);
        res.json(result.rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    } finally {
        await client.end();
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log('Azure Computer Vision OCR service ready');
    console.log('Test the service at: http://localhost:3000/test');
    console.log('Test accuracy at: http://localhost:3000/test/accuracy');
});

export default app;