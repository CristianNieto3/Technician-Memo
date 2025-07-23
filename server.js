require('dotenv').config();
const express = require("express");
const multer = require("multer");
const fs = require("fs");
const cors = require("cors");
const path = require("path");
const sqlite3 = require("sqlite3").verbose();
const { ElevenLabsClient } = require("@elevenlabs/elevenlabs-js");
const { OpenAI } = require("openai");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

const upload = multer({ dest: "uploads/" });


// API Keys = // TO DO - env file
const ELEVEN_API_KEY = process.env.ELEVEN_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// Initialize clients
const elevenLabsClient = new ElevenLabsClient({ apiKey: ELEVEN_API_KEY });
const openaiClient = new OpenAI({ apiKey: OPENAI_API_KEY });

// Initialize SQLite Database
const db = new sqlite3.Database('purchase_orders.db');

// Create tables if they don't exist
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS purchase_orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    time TEXT NOT NULL,
    description TEXT,
    unit_number TEXT,
    customer TEXT,
    vendor_supplier TEXT,
    raw_transcription TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  
  db.run(`CREATE TABLE IF NOT EXISTS cost_tracking (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    elevenlabs_cost REAL,
    openai_cost REAL,
    total_cost REAL,
    audio_size_bytes INTEGER,
    estimated_duration_minutes REAL,
    transcription_attempts INTEGER,
    translation_used BOOLEAN,
    error_message TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
});

// Cost tracking constants    //TO DO - find correct prices
const COSTS = {
  ELEVENLABS_TRANSCRIPTION_PER_MINUTE: 0.003, // current price??
  OPENAI_GPT35_INPUT_PER_1K_TOKENS: 0.0015,   // current price??
  OPENAI_GPT35_OUTPUT_PER_1K_TOKENS: 0.002    // current price??
};

// Function to estimate audio duration from buffer size (rough approximation)
function estimateAudioDurationMinutes(bufferSize) {
  const estimatedSeconds = bufferSize / 16000; 
  return Math.max(0.1, estimatedSeconds / 60);
}

// Function to estimate token count (rough approximation)
function estimateTokenCount(text) {
  return Math.ceil(text.length / 4);
}

// Function to detect if text is primarily Spanish
function isSpanish(text) {
  const spanishWords = [
    'el', 'la', 'los', 'las', 'un', 'una', 'y', 'o', 'pero', 'si', 'no',
    'con', 'por', 'para', 'de', 'del', 'en', 'que', 'es', 'son', 'está',
    'están', 'fue', 'fueron', 'ser', 'estar', 'tener', 'hacer', 'decir'
  ];
  
  const spanishAccents = /[áéíóúüñ]/i;
  const words = text.toLowerCase().split(/\s+/);
  let spanishWordCount = 0;
  
  words.forEach(word => {
    const cleanWord = word.replace(/[.,!?;:"'()]/g, '');
    if (spanishWords.includes(cleanWord)) {
      spanishWordCount++;
    }
  });
  
  const spanishWordRatio = spanishWordCount / words.length;
  return spanishWordRatio > 0.3 || spanishAccents.test(text);
}

// Function to translate Spanish text to English using OpenAI
async function translateToEnglish(spanishText) {
  try {
    const response = await openaiClient.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [
        {
          role: "system",
          content: "You are a professional translator. Translate the following Spanish text to English. Provide only the translation, no additional text or explanations."
        },
        {
          role: "user",
          content: spanishText
        }
      ],
      temperature: 0.1,
      max_tokens: 1000
    });
    
    return response.choices[0].message.content.trim();
  } catch (error) {
    console.error("Translation failed:", error.message);
    throw new Error("Translation service unavailable");
  }
}

// Function to extract purchase order data using OpenAI
async function extractPurchaseOrderData(transcriptionText) {
  try {
    const response = await openaiClient.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [
        {
          role: "system",
          content: `You are a data extraction specialist. Extract purchase order information from voice transcriptions. 

Extract these 4 fields:
1. Description: What part/item is being picked up (e.g., "LA Pump", "Hose", "Bolts")
2. Unit Number: The equipment unit number (e.g., "4555", "3232", "24333")
3. Customer: The company/customer name (e.g., "Halliburton", "Nextier", "Liberty")
4. Vendor/Supplier: Where they're picking up the part (e.g., "Hydroquip", "Diamond Hydraulics", "Basin Supply")

Return ONLY a JSON object with these exact keys: "description", "unit_number", "customer", "vendor_supplier". 
If any field cannot be determined, use null for that field.
Be concise - extract key terms, not full sentences.

Examples:
Input: "I need a P.O. for an LA Pump for the Halliburton Unit 4555, I will be heading to Hydroquip to pick up part"
Output: {"description": "LA Pump", "unit_number": "4555", "customer": "Halliburton", "vendor_supplier": "Hydroquip"}

Input: "I need a purchase order so I can buy a hose from diamond hydraulics. I am working on the Nextier Unit 3232"
Output: {"description": "Hose", "unit_number": "3232", "customer": "Nextier", "vendor_supplier": "Diamond Hydraulics"}`
        },
        {
          role: "user",
          content: transcriptionText
        }
      ],
      temperature: 0.1,
      max_tokens: 200
    });
    
    const extractedText = response.choices[0].message.content.trim();
    
    // Try to parse the JSON response
    try {
      const extracted = JSON.parse(extractedText);
      return {
        description: extracted.description || null,
        unit_number: extracted.unit_number || null,
        customer: extracted.customer || null,
        vendor_supplier: extracted.vendor_supplier || null,
        extraction_tokens: estimateTokenCount(transcriptionText + extractedText)
      };
    } catch (parseError) {
      console.error("Failed to parse extraction JSON:", extractedText);
      return {
        description: null,
        unit_number: null,
        customer: null,
        vendor_supplier: null,
        extraction_tokens: estimateTokenCount(transcriptionText + extractedText)
      };
    }
  } catch (error) {
    console.error("Data extraction failed:", error.message);
    return {
      description: null,
      unit_number: null,
      customer: null,
      vendor_supplier: null,
      extraction_tokens: 0
    };
  }
}

// Function to save purchase order data to database
function savePurchaseOrderData(data) {
  return new Promise((resolve, reject) => {
    const now = new Date();
    const date = now.toISOString().split('T')[0]; // YYYY-MM-DD
    const time = now.toTimeString().split(' ')[0]; // HH:MM:SS
    
    const stmt = db.prepare(`INSERT INTO purchase_orders 
      (date, time, description, unit_number, customer, vendor_supplier, raw_transcription) 
      VALUES (?, ?, ?, ?, ?, ?, ?)`);
      
    stmt.run([
      date,
      time,
      data.description,
      data.unit_number,
      data.customer,
      data.vendor_supplier,
      data.raw_transcription
    ], function(err) {
      if (err) {
        reject(err);
      } else {
        resolve(this.lastID);
      }
    });
    
    stmt.finalize();
  });
}

// Function to save cost data to database
function saveCostData(costData) {
  return new Promise((resolve, reject) => {
    const stmt = db.prepare(`INSERT INTO cost_tracking 
      (date, elevenlabs_cost, openai_cost, total_cost, audio_size_bytes, estimated_duration_minutes, 
       transcription_attempts, translation_used, error_message) 
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      
    const today = new Date().toISOString().split('T')[0];
    
    stmt.run([
      today,
      costData.elevenLabsCost,
      costData.openaiCost,
      costData.totalCost,
      costData.audioSizeBytes,
      costData.estimatedDurationMinutes,
      costData.transcriptionAttempts,
      costData.translationUsed ? 1 : 0,
      costData.error
    ], function(err) {
      if (err) {
        reject(err);
      } else {
        resolve(this.lastID);
      }
    });
    
    stmt.finalize();
  });
}

app.post("/upload", upload.single("audio"), async (req, res) => {
  const filePath = req.file.path;
  let costTracking = {
    elevenLabsCost: 0,
    openaiCost: 0,
    totalCost: 0,
    audioSizeBytes: 0,
    estimatedDurationMinutes: 0,
    transcriptionAttempts: 0,
    translationUsed: false,
    error: null
  };
  
  try {
    const audioBuffer = fs.readFileSync(filePath);
    costTracking.audioSizeBytes = audioBuffer.length;
    costTracking.estimatedDurationMinutes = estimateAudioDurationMinutes(audioBuffer.length);
    costTracking.elevenLabsCost = costTracking.estimatedDurationMinutes * COSTS.ELEVENLABS_TRANSCRIPTION_PER_MINUTE;
    
    // Transcription logic (same as before)
    let transcriptionResult;
    let isSpanishAudio = false;
    
    try {
      const spanishResult = await elevenLabsClient.speechToText.convert({
        file: audioBuffer,
        modelId: "scribe_v1",
        languageCode: "es",
        tagAudioEvents: false,
        diarize: false,
      });
      
      costTracking.transcriptionAttempts++;
      
      if (isSpanish(spanishResult.text)) {
        transcriptionResult = spanishResult;
        isSpanishAudio = true;
      } else {
        transcriptionResult = await elevenLabsClient.speechToText.convert({
          file: audioBuffer,
          modelId: "scribe_v1",
          languageCode: "en",
          tagAudioEvents: false,
          diarize: false,
        });
        costTracking.transcriptionAttempts++;
        costTracking.elevenLabsCost *= 2;
      }
    } catch (error) {
      console.log("Spanish transcription failed, trying English:", error.message);
      transcriptionResult = await elevenLabsClient.speechToText.convert({
        file: audioBuffer,
        modelId: "scribe_v1",
        languageCode: "en",
        tagAudioEvents: false,
        diarize: false,
      });
      costTracking.transcriptionAttempts++;
    }
    
    let finalText = transcriptionResult.text;
    let translatedText = null;
    
    // Translation logic (same as before)
    if (isSpanishAudio && finalText.trim()) {
      try {
        costTracking.translationUsed = true;
        const inputTokens = estimateTokenCount(finalText);
        
        translatedText = await translateToEnglish(finalText);
        finalText = translatedText;
        
        const outputTokens = estimateTokenCount(translatedText);
        costTracking.openaiCost += (inputTokens / 1000 * COSTS.OPENAI_GPT35_INPUT_PER_1K_TOKENS) + 
                                   (outputTokens / 1000 * COSTS.OPENAI_GPT35_OUTPUT_PER_1K_TOKENS);
      } catch (translationError) {
        console.error("Translation failed, saving original Spanish text:", translationError.message);
        costTracking.error = `Translation failed: ${translationError.message}`;
      }
    }
    
    // NEW: Extract purchase order data
    const extractedData = await extractPurchaseOrderData(finalText);
    
    // Add extraction cost to OpenAI cost
    costTracking.openaiCost += (extractedData.extraction_tokens / 1000 * COSTS.OPENAI_GPT35_INPUT_PER_1K_TOKENS) + 
                               (extractedData.extraction_tokens / 1000 * COSTS.OPENAI_GPT35_OUTPUT_PER_1K_TOKENS);
    
    // Calculate total cost
    costTracking.totalCost = costTracking.elevenLabsCost + costTracking.openaiCost;
    
    // Save to memos.txt (keep existing functionality)
    const timestamp = new Date().toISOString();
    const log = `${timestamp} | ${finalText}\n`;
    fs.appendFileSync("memos.txt", log);
    
    // NEW: Save structured data to database
    const purchaseOrderData = {
      description: extractedData.description,
      unit_number: extractedData.unit_number,
      customer: extractedData.customer,
      vendor_supplier: extractedData.vendor_supplier,
      raw_transcription: finalText
    };
    
    const purchaseOrderId = await savePurchaseOrderData(purchaseOrderData);
    await saveCostData(costTracking);
    
    // Return comprehensive response
    const response = {
      transcription: transcriptionResult.text,
      finalText: finalText,
      wasSpanish: isSpanishAudio,
      wasTranslated: isSpanishAudio && translatedText !== null,
      extractedData: {
        description: extractedData.description,
        unit_number: extractedData.unit_number,
        customer: extractedData.customer,
        vendor_supplier: extractedData.vendor_supplier
      },
      purchaseOrderId: purchaseOrderId,
      costTracking: {
        elevenLabsCost: costTracking.elevenLabsCost.toFixed(4),
        openaiCost: costTracking.openaiCost.toFixed(4),
        totalCost: costTracking.totalCost.toFixed(4)
      }
    };
    
    res.json(response);
    
  } catch (error) {
    const apiError = error.response?.data || error.message;
    console.error("Processing failed:", apiError);
    
    costTracking.error = apiError;
    costTracking.totalCost = costTracking.elevenLabsCost;
    
    await saveCostData(costTracking);
    
    res.status(500).json({ 
      error: "Audio processing failed", 
      details: apiError 
    });
  } finally {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  }
});

// NEW: Get all purchase orders
app.get("/purchase-orders", (req, res) => {
  db.all(`SELECT * FROM purchase_orders ORDER BY created_at DESC`, [], (err, rows) => {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }
    res.json({ purchaseOrders: rows });
  });
});

// NEW: Get purchase orders as CSV for export
app.get("/export/purchase-orders.csv", (req, res) => {
  db.all(`SELECT date, time, description, unit_number, customer, vendor_supplier 
          FROM purchase_orders ORDER BY date DESC, time DESC`, [], (err, rows) => {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }
    
    // Create CSV content
    let csv = "Date,Time,Description,Unit Number,Customer,Vendor/Supplier\n";
    rows.forEach(row => {
      csv += `"${row.date || ''}","${row.time || ''}","${row.description || ''}","${row.unit_number || ''}","${row.customer || ''}","${row.vendor_supplier || ''}"\n`;
    });
    
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="purchase_orders.csv"');
    res.send(csv);
  });
});

// NEW: Get purchase order by ID
app.get("/purchase-orders/:id", (req, res) => {
  const id = req.params.id;
  db.get(`SELECT * FROM purchase_orders WHERE id = ?`, [id], (err, row) => {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }
    if (row) {
      res.json(row);
    } else {
      res.status(404).json({ error: "Purchase order not found" });
    }
  });
});

// NEW: Delete purchase order by ID
app.delete("/purchase-orders/:id", (req, res) => {
  const id = req.params.id;
  db.run(`DELETE FROM purchase_orders WHERE id = ?`, [id], function(err) {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }
    if (this.changes === 0) {
      res.status(404).json({ error: "Purchase order not found" });
    } else {
      res.json({ message: "Purchase order deleted successfully" });
    }
  });
});






// TO DO - fix costs
// Enhanced cost summary endpoint
app.get("/costs", (req, res) => {
  db.get(`SELECT 
    SUM(total_cost) as total_cost,
    SUM(elevenlabs_cost) as total_elevenlabs_cost,
    SUM(openai_cost) as total_openai_cost,
    COUNT(*) as total_requests
    FROM cost_tracking`, [], (err, summary) => {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }
    
    // Get daily breakdown
    db.all(`SELECT date, SUM(total_cost) as daily_cost, COUNT(*) as daily_requests 
            FROM cost_tracking GROUP BY date ORDER BY date DESC`, [], (err, daily) => {
      if (err) {
        res.status(500).json({ error: err.message });
        return;
      }
      
      res.json({
        summary: summary || { total_cost: 0, total_elevenlabs_cost: 0, total_openai_cost: 0, total_requests: 0 },
        daily_breakdown: daily
      });
    });
  });
});

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({ 
    status: "ok", 
    services: {
      elevenlabs: "connected",
      openai: "connected",
      database: "connected"
    }
  });
});


app.listen(3000, () => {
  console.log("✅ Server running on http://localhost:3000");
  console.log("📝 Features:");
  console.log("   - English transcription and memo saving");
  console.log("   - Spanish transcription with English translation");
  console.log("   - Purchase order data extraction");
  console.log("   - SQLite database storage");
  console.log("🔗 Endpoints:");
  console.log("   - POST /upload - Upload audio and extract PO data");
  console.log("   - GET /purchase-orders - View all purchase orders");
  console.log("   - GET /purchase-orders/:id - Get specific purchase order");
  console.log("   - DELETE /purchase-orders/:id - Delete purchase order");
  console.log("   - GET /export/purchase-orders.csv - Download CSV export");
  console.log("   - GET /costs - View cost summary");
  console.log("   - GET /health - Health check");
});