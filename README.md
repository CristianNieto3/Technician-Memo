# 🎙️ Technician Voice Memo App

A full-stack voice memo web app built for field technicians to quickly record spoken purchase orders. The app transcribes the audio (in English or Spanish), optionally translates to English, and extracts structured purchase order data using AI. Data is stored in an SQLite database and cost-tracked for billing analysis.

---

## ✨ Features

- 🎧 Microphone selector and in-browser recording
- 🧠 ElevenLabs transcription (English and Spanish auto-detect)
- 🌐 OpenAI-powered Spanish-to-English translation
- 🧾 AI-powered purchase order data extraction
- 🗃️ SQLite database for persistent PO storage
- 📊 Cost tracking for API usage
- 📥 Export purchase orders as CSV
- 🌐 Simple frontend with TailwindCSS (CDN)

---

## 🛠️ Tech Stack

| Layer       | Tech                     |
|-------------|--------------------------|
| Frontend    | HTML5, TailwindCSS, JS   |
| Backend     | Node.js, Express         |
| AI Services | ElevenLabs, OpenAI       |
| Database    | SQLite3 (with `sqlite3` NPM) |
| Deployment  | Local or Cloud-hosted    |

---

## ⚙️ Setup Instructions

1. Clone the Repo

  bash
git clone https://github.com/CristianNieto3/Technician-Memo.git
cd Technician-Memo 

2. Install dependencies
   
npm install   

npm install dotenv

npm install sqlite

pip install elevenlabs


4. Create .env file and paste this into the file

OPENAI_API_KEY="your-openai-api-key-here"

ELEVEN_API_KEY="your-elevenlabs-api-key-here"

4. In the terminal run
   
node server.js

6. Select mic device and start testing!


EXTRA:

GET /purchase-orders

Returns all saved POs.

GET /purchase-orders/:id

Fetch a PO by ID.

DELETE /purchase-orders/:id

Delete a PO by ID.

GET /export/purchase-orders.csv

Download all POs as CSV.

GET /costs

Returns cost summary and daily breakdown.   -> Work in Progress

GET /health

Returns a health check of backend + services.






