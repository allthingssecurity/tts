# Travel Buddy — Real-Time Voice Assistant

A real-time voice travel assistant powered by [Pipecat](https://github.com/pipecat-ai/pipecat), Kokoro TTS, and OpenAI. Speak naturally to search and book flights and hotels.

## Architecture

```
Browser (WebRTC mic capture + Web Audio playback)
    ↕ WebSocket (Protobuf binary frames)
FastAPI Server (Python)
    ├── Silero VAD (voice activity detection)
    ├── OpenAI Whisper STT (gpt-4o-transcribe)
    ├── OpenAI GPT-4o-mini (LLM with function calling)
    └── Kokoro TTS (local ONNX, 24kHz, af_heart voice)
```

## Features

- **Real-time voice conversation** — speak and get instant audio responses
- **Local TTS** — Kokoro v1.0 runs locally via ONNX (no cloud TTS latency)
- **Travel tools** — search flights, book flights, search hotels, book hotels via Concur Travel APIs
- **Client-side barge-in** — interrupt the bot mid-sentence by speaking
- **Echo prevention** — mic audio is suppressed during bot playback to prevent false VAD triggers
- **Barge-in cooldown** — trailing server audio is discarded after interruption
- **Protected API calls** — user speech during slow API calls won't cancel them

## Prerequisites

- **Python 3.13** (Pipecat/numba doesn't support 3.14 yet)
- **OpenAI API key** (for Whisper STT + GPT-4o-mini)
- **espeak-ng** (required by Kokoro for phoneme generation)

## Setup

### 1. Install espeak-ng

```bash
# macOS
brew install espeak-ng

# Ubuntu/Debian
sudo apt-get install espeak-ng

# Windows
# Download from https://github.com/espeak-ng/espeak-ng/releases
```

### 2. Create virtual environment

```bash
python3.13 -m venv .venv
source .venv/bin/activate  # On Windows: .venv\Scripts\activate
```

### 3. Install dependencies

```bash
pip install -r requirements.txt
```

### 4. Set up environment variables

```bash
cp .env.example .env
# Edit .env and add your OpenAI API key
```

### 5. Run the server

```bash
python server.py
```

Open http://localhost:8002 in your browser, click **Start**, and begin speaking.

## How It Works

### Voice Pipeline (Pipecat)

```
Mic Input → Silero VAD → OpenAI Whisper STT → GPT-4o-mini → Kokoro TTS → Audio Output
```

1. Browser captures mic audio via `getUserMedia` with echo cancellation
2. Audio is resampled from 48kHz to 16kHz and sent via WebSocket as Protobuf frames
3. Silero VAD detects speech boundaries
4. OpenAI Whisper transcribes the speech
5. GPT-4o-mini generates a response (with optional tool calls for travel APIs)
6. Kokoro TTS synthesizes speech locally at 24kHz
7. Audio is streamed back to the browser and played

### Client-Side Barge-In

The browser monitors mic amplitude while the bot is speaking. If the user speaks loudly enough for 3 consecutive chunks (~300ms), playback is stopped. A 2-second cooldown discards trailing server audio. A 500ms grace period lets echo dissipate before sending new audio to the server.

### Travel API Integration

The LLM has access to 5 tools via OpenAI function calling:
- `get_current_date` — for relative date calculations
- `search_flights` — search flights between cities
- `book_flight` — book a selected flight
- `search_hotels` — search hotels in a city
- `book_hotel` — book a selected hotel

API calls are protected from interruption (`cancel_on_interruption=False`), so user speech during slow API calls won't cancel them.

## File Structure

```
├── server.py           # FastAPI + Pipecat pipeline + travel tools
├── static/
│   ├── index.html      # UI with visualizer + transcript
│   ├── style.css       # Dark theme styling
│   └── app.js          # WebRTC capture, protobuf transport, barge-in
├── kokoro-v1.0.int8.onnx  # Kokoro TTS model (88MB, int8 quantized)
├── voices-v1.0.bin     # Kokoro voice embeddings (27MB)
├── requirements.txt    # Python dependencies
├── .env.example        # Environment variable template
└── .gitignore
```

## Configuration

| Setting | Value | Location |
|---------|-------|----------|
| TTS Voice | `af_heart` (American female) | `server.py` |
| TTS Sample Rate | 24kHz | `server.py` |
| LLM Model | `gpt-4o-mini` | `server.py` |
| STT Model | `gpt-4o-transcribe` | `server.py` |
| STT Language | English | `server.py` |
| Server Port | 8002 | `server.py` |
| Barge-in Threshold | 5000 (Int16 amplitude) | `static/app.js` |
| Barge-in Chunks | 3 consecutive | `static/app.js` |

## Tech Stack

- **[Pipecat](https://github.com/pipecat-ai/pipecat)** — Real-time voice AI framework
- **[Kokoro TTS](https://github.com/hexgrad/kokoro)** — Local ONNX text-to-speech (400M params, int8)
- **[Silero VAD](https://github.com/snakers4/silero-vad)** — Voice activity detection
- **[OpenAI](https://platform.openai.com/)** — Whisper STT + GPT-4o-mini LLM
- **[FastAPI](https://fastapi.tiangolo.com/)** — WebSocket server
- **[protobuf.js](https://github.com/protobufjs/protobuf.js)** — Browser-side protobuf serialization
