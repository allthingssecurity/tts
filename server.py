"""Travel Buddy: Pipecat-powered real-time voice assistant with Kokoro TTS."""

import asyncio
import json
import os
import uuid
from datetime import datetime
from pathlib import Path

import httpx
import uvicorn
from dotenv import load_dotenv
from fastapi import FastAPI, WebSocket
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from loguru import logger

from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.frames.frames import TTSSpeakFrame, EndFrame
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.runner import PipelineRunner
from pipecat.pipeline.task import PipelineParams, PipelineTask
from pipecat.processors.aggregators.openai_llm_context import OpenAILLMContext
from pipecat.serializers.protobuf import ProtobufFrameSerializer
from pipecat.services.kokoro.tts import KokoroTTSService
from pipecat.services.llm_service import FunctionCallParams
from pipecat.services.openai.llm import OpenAILLMService
from pipecat.services.openai.stt import OpenAISTTService
from pipecat.transports.websocket.fastapi import (
    FastAPIWebsocketParams,
    FastAPIWebsocketTransport,
)

load_dotenv()

BASE_DIR = Path(__file__).parent

# ---------------------------------------------------------------------------
# Vapi webhook for travel APIs
# ---------------------------------------------------------------------------
VAPI_WEBHOOK_URL = "https://vapi-voice-agent.cfapps.eu10-004.hana.ondemand.com/vapi/webhook"
VAPI_AUTH_TOKEN = "ALxkU3FX_lyKF5zWYb0doeblCuvesYdkj1zHdrmUbxk"


async def call_vapi_webhook(function_name: str, arguments: dict) -> str:
    tool_call_id = f"{function_name}-{uuid.uuid4().hex[:8]}"
    call_id = f"call-{uuid.uuid4().hex[:8]}"
    logger.info(f"[TOOL] Calling {function_name} with {arguments}")

    payload = {
        "message": {
            "type": "tool-calls",
            "toolCallList": [{
                "id": tool_call_id,
                "function": {"name": function_name, "arguments": arguments or {}}
            }]
        },
        "call": {"id": call_id}
    }

    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.post(
                VAPI_WEBHOOK_URL,
                json=payload,
                headers={
                    "Authorization": f"Bearer {VAPI_AUTH_TOKEN}",
                    "Content-Type": "application/json"
                }
            )
            response.raise_for_status()
            result = response.json()
            logger.info(f"[TOOL] Response: {json.dumps(result)[:500]}")

            if isinstance(result, dict):
                if "results" in result and len(result["results"]) > 0:
                    tool_result = result["results"][0].get("result", "")
                    return tool_result if tool_result else json.dumps(result["results"][0])
                elif "result" in result:
                    return result["result"]
                else:
                    return json.dumps(result)
            return str(result)
    except Exception as e:
        logger.error(f"[TOOL] Error: {e}")
        return f"Error calling travel service: {str(e)}"


# ---------------------------------------------------------------------------
# Travel tool definitions (OpenAI function calling)
# ---------------------------------------------------------------------------
TRAVEL_TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "get_current_date",
            "description": "Get the current date. Call this for relative date calculations.",
            "parameters": {"type": "object", "properties": {}, "required": []}
        }
    },
    {
        "type": "function",
        "function": {
            "name": "search_flights",
            "description": "Search for available flights between two locations on a specific date.",
            "parameters": {
                "type": "object",
                "properties": {
                    "origin": {"type": "string", "description": "Origin city or airport code"},
                    "destination": {"type": "string", "description": "Destination city or airport code"},
                    "departure_date": {"type": "string", "description": "Departure date YYYY-MM-DD"}
                },
                "required": ["origin", "destination", "departure_date"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "book_flight",
            "description": "Book a selected flight. Only call after user explicitly confirms.",
            "parameters": {
                "type": "object",
                "properties": {
                    "journey_id": {"type": "string"},
                    "offer_id": {"type": "string"},
                    "carrier_name": {"type": "string"},
                    "origin": {"type": "string"},
                    "destination": {"type": "string"},
                    "departure_time": {"type": "string"},
                    "arrival_time": {"type": "string"},
                    "price_amount": {"type": "number"},
                    "currency_code": {"type": "string"},
                    "cabin_class": {"type": "string"},
                    "passenger_name": {"type": "string"}
                },
                "required": ["journey_id", "offer_id", "carrier_name", "origin",
                            "destination", "departure_time", "arrival_time",
                            "price_amount", "currency_code", "cabin_class"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "search_hotels",
            "description": "Search for available hotels in a destination city.",
            "parameters": {
                "type": "object",
                "properties": {
                    "destination": {"type": "string"},
                    "check_in_date": {"type": "string", "description": "YYYY-MM-DD"},
                    "check_out_date": {"type": "string", "description": "YYYY-MM-DD"}
                },
                "required": ["destination", "check_in_date", "check_out_date"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "book_hotel",
            "description": "Book a selected hotel. Only call after user explicitly confirms.",
            "parameters": {
                "type": "object",
                "properties": {
                    "hotel_name": {"type": "string"},
                    "hotel_address": {"type": "string"},
                    "city": {"type": "string"},
                    "check_in_date": {"type": "string"},
                    "check_out_date": {"type": "string"},
                    "room_type": {"type": "string"},
                    "price_per_night": {"type": "number"},
                    "total_price": {"type": "number"},
                    "currency_code": {"type": "string"},
                    "guest_name": {"type": "string"},
                    "star_rating": {"type": "number"}
                },
                "required": ["hotel_name", "hotel_address", "city", "check_in_date",
                            "check_out_date", "room_type", "price_per_night",
                            "total_price", "currency_code"]
            }
        }
    }
]

def get_system_prompt():
    today = datetime.now().strftime("%Y-%m-%d")
    return f"""You are Travel Buddy, a friendly and helpful travel assistant in a voice call.
Today's date is {today}.

You help users:
1. Search for flights between cities
2. Book flights
3. Search for hotels
4. Book hotels

IMPORTANT GUIDELINES:
- Today is {today}. When users mention dates without a year, ALWAYS use the current or next occurrence of that date. For example, "March 23" means {datetime.now().year}-03-23 if it hasn't passed yet, otherwise {datetime.now().year + 1}-03-23.
- When users mention relative dates like "next week", "tomorrow", "in 3 days", calculate the actual date based on today ({today})
- Always confirm details before booking (flight selection, hotel choice)
- Present search results clearly and concisely - mention 2-3 best options
- For flights, mention: airline, departure time, arrival time, and price
- For hotels, mention: hotel name, star rating, and price per night
- Keep responses brief and conversational - this is a voice call, not text
- Never use markdown, lists, bullet points, or formatting
- If a search returns no results, suggest alternatives
- Ask for confirmation before booking anything
- IMPORTANT: Before calling any search or booking function, ALWAYS say a brief phrase like "Let me search for that, one moment" or "Sure, let me look that up for you" so the user knows you're working on it and waits. The API calls take a few seconds.
- ALWAYS respond in English, regardless of what language the user's message appears to be in.
"""

WELCOME_MESSAGE = (
    "Hey there! I'm Travel Buddy, your personal travel assistant. "
    "I can help you search and book flights and hotels. "
    "Where would you like to go?"
)


# ---------------------------------------------------------------------------
# Tool handlers
# ---------------------------------------------------------------------------
async def handle_get_current_date(params: FunctionCallParams):
    result = datetime.now().strftime("%Y-%m-%d")
    logger.info(f"[FUNCTION] get_current_date -> {result}")
    await params.result_callback(result)


async def handle_search_flights(params: FunctionCallParams):
    args = params.arguments
    logger.info(f"[FUNCTION] search_flights({args})")
    result = await call_vapi_webhook("search_flights", dict(args))
    await params.result_callback(result)


async def handle_book_flight(params: FunctionCallParams):
    args = params.arguments
    logger.info(f"[FUNCTION] book_flight({args})")
    result = await call_vapi_webhook("book_flight", dict(args))
    await params.result_callback(result)


async def handle_search_hotels(params: FunctionCallParams):
    args = params.arguments
    logger.info(f"[FUNCTION] search_hotels({args})")
    result = await call_vapi_webhook("search_hotels", dict(args))
    await params.result_callback(result)


async def handle_book_hotel(params: FunctionCallParams):
    args = params.arguments
    logger.info(f"[FUNCTION] book_hotel({args})")
    result = await call_vapi_webhook("book_hotel", dict(args))
    await params.result_callback(result)


# ---------------------------------------------------------------------------
# Bot pipeline
# ---------------------------------------------------------------------------
async def run_bot(websocket_client):
    """Create and run a Pipecat voice pipeline for one client."""

    transport = FastAPIWebsocketTransport(
        websocket=websocket_client,
        params=FastAPIWebsocketParams(
            audio_in_enabled=True,
            audio_out_enabled=True,
            add_wav_header=False,
            vad_enabled=True,
            vad_analyzer=SileroVADAnalyzer(),
            vad_audio_passthrough=True,
            serializer=ProtobufFrameSerializer(),
            audio_in_sample_rate=16000,   # Resample client audio to 16kHz for VAD/STT
            audio_out_sample_rate=24000,  # Kokoro output rate
        ),
    )

    stt = OpenAISTTService(
        api_key=os.getenv("OPENAI_API_KEY"),
        model="gpt-4o-transcribe",
        language="en",
    )

    llm = OpenAILLMService(
        api_key=os.getenv("OPENAI_API_KEY"),
        model="gpt-4o-mini",
    )

    # Register travel tool handlers
    # cancel_on_interruption=False prevents user speech from cancelling slow API calls
    llm.register_function("get_current_date", handle_get_current_date)
    llm.register_function("search_flights", handle_search_flights, cancel_on_interruption=False)
    llm.register_function("book_flight", handle_book_flight, cancel_on_interruption=False)
    llm.register_function("search_hotels", handle_search_hotels, cancel_on_interruption=False)
    llm.register_function("book_hotel", handle_book_hotel, cancel_on_interruption=False)

    tts = KokoroTTSService(
        voice_id="af_heart",
        model_path=str(BASE_DIR / "kokoro-v1.0.int8.onnx"),
        voices_path=str(BASE_DIR / "voices-v1.0.bin"),
        sample_rate=24000,
    )

    # Conversation context with tools
    messages = [{"role": "system", "content": get_system_prompt()}]
    context = OpenAILLMContext(messages=messages, tools=TRAVEL_TOOLS)
    context_aggregator = llm.create_context_aggregator(context)

    pipeline = Pipeline([
        transport.input(),
        stt,
        context_aggregator.user(),
        llm,
        tts,
        transport.output(),
        context_aggregator.assistant(),
    ])

    task = PipelineTask(
        pipeline,
        params=PipelineParams(
            allow_interruptions=True,
            enable_metrics=True,
            enable_usage_metrics=True,
        ),
    )

    @transport.event_handler("on_client_connected")
    async def on_client_connected(transport, client):
        logger.info("Client connected")
        # Send welcome greeting
        await task.queue_frames([TTSSpeakFrame(text=WELCOME_MESSAGE)])

    @transport.event_handler("on_client_disconnected")
    async def on_client_disconnected(transport, client):
        logger.info("Client disconnected")
        await task.queue_frames([EndFrame()])

    runner = PipelineRunner(handle_sigint=False)
    await runner.run(task)


# ---------------------------------------------------------------------------
# FastAPI app
# ---------------------------------------------------------------------------
app = FastAPI(title="Travel Buddy")

app.mount("/static", StaticFiles(directory=BASE_DIR / "static"), name="static")


@app.get("/")
async def root():
    return FileResponse(BASE_DIR / "static" / "index.html")


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    await run_bot(websocket)


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8002)
