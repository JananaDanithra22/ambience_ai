import time
import numpy as np
import asyncio
import tempfile
import os
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from aiortc import RTCPeerConnection, RTCSessionDescription
from scipy.io.wavfile import write as wav_write
from groq import Groq
import logging

# Initialize Groq client with API key directly
try:
    client = Groq(api_key="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")
    print("[SUCCESS] Groq client initialized successfully!")
except Exception as e:
    print(f"[ERROR] Failed to initialize Groq: {e}")
    client = None

app = FastAPI()

# Store sessions: pc_id -> session_data
sessions = {}
orders = {}
_NEXT_ORDER_ID = 1

# CORS for local React dev
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://localhost:5174"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/session")
async def new_session():
    session = {"id": len(sessions) + 1, "start": time.time()}
    sessions[session["id"]] = session
    print(f"[NEW SESSION] Created session: {session}")
    return {"session": session}


@app.get("/api/health")
async def health():
    """Simple health endpoint to check Groq availability."""
    return {"groq_available": client is not None}


@app.post('/api/orders')
async def create_order(request: Request):
    """Receive a conversation/order from the frontend and persist it in-memory (and on-disk).

    Expected JSON: { session_id: <int>, transcript: <str>, summary: <str> }
    Returns: { order_id }
    """
    global _NEXT_ORDER_ID
    payload = await request.json()
    print(f"[RECEIVED] Order payload: keys={list(payload.keys())}")
    order = {
        "id": _NEXT_ORDER_ID,
        "session_id": payload.get("session_id"),
        "transcript": payload.get("transcript", ""),
        "summary": payload.get("summary", ""),
        "created_at": time.time(),
    }
    orders[_NEXT_ORDER_ID] = order
    # write a lightweight copy to disk for persistence between runs
    try:
        os.makedirs("orders", exist_ok=True)
        with open(os.path.join("orders", f"order-{_NEXT_ORDER_ID}.json"), "w", encoding="utf-8") as f:
            import json

            json.dump(order, f, ensure_ascii=False, indent=2)
    except Exception as e:
        print("[WARNING] Failed to write order to disk:", e)

    _NEXT_ORDER_ID += 1
    return {"order_id": order["id"]}


@app.get('/api/orders/{order_id}')
async def get_order(order_id: int):
    o = orders.get(order_id)
    if not o:
        return JSONResponse({"error": "not found"}, status_code=404)
    return {"order": o}


@app.post('/api/process-consultation')
async def process_consultation(request: Request):
    """Process the consultation transcript into a medical report template."""
    payload = await request.json()
    transcript = payload.get("transcript", "")
    session_id = payload.get("session_id")
    
    print(f"[PROCESSING] Processing consultation for session {session_id}")
    print(f"[TRANSCRIPT] Transcript length: {len(transcript)} characters")
    
    if not transcript.strip():
        return JSONResponse({"error": "Empty transcript"}, status_code=400)
    
    if client is None:
        return JSONResponse({"error": "Groq client not initialized"}, status_code=500)
    
    try:
        # Use Groq to extract structured medical information
        messages = [
            {
                "role": "system",
                "content": """You are a medical documentation assistant. Extract key information from doctor-patient conversations and format it into a structured medical report.

Format the output EXACTLY as follows (fill in the blanks based on the conversation):

Patient Name: [Extract if mentioned, otherwise use "Not provided"]
Date: [Use today's date]
Doctor: [Extract if mentioned, otherwise use "Not provided"]
Chief Complaint: [What the patient mainly came for]

Symptoms:
- [List each symptom on a new line with a dash]
- [Add more as needed]

Duration of Symptoms: [How long symptoms have been present]

Diagnosis: [Doctor's diagnosis or assessment]

Medications / Treatment Given:
- [List each medication/treatment on a new line with a dash]
- [Add more as needed]

Doctor's Advice:
[Summarize key advice and recommendations given by the doctor]

Follow-up Date: [If mentioned, otherwise "As needed" or "Not specified"]

If information is not mentioned in the conversation, use "Not provided" or "Not discussed"."""
            },
            {
                "role": "user",
                "content": f"Here is the doctor-patient conversation:\n\n{transcript}\n\nPlease extract and format this into a medical report."
            }
        ]
        
        def do_chat_completion(msgs):
            try:
                comp = client.chat.completions.create(
                    model="llama-3.1-8b-instant",
                    messages=msgs,
                    temperature=0.3,
                    max_completion_tokens=2048,
                    top_p=1,
                    stream=False,
                )
                return comp.choices[0].message.content
            except Exception:
                raise
        
        print("[AI PROCESSING] Sending to Groq for medical report generation...")
        report = await asyncio.to_thread(do_chat_completion, messages)
        
        print(f"[SUCCESS] Medical report generated ({len(report)} characters)")
        
        return {"report": report, "session_id": session_id}
        
    except Exception as e:
        print(f"[ERROR] Error processing consultation: {e}")
        import traceback
        traceback.print_exc()
        return JSONResponse({"error": str(e)}, status_code=500)


@app.post("/api/webrtc/offer")
async def webrtc_offer(request: Request):
    params = await request.json()
    print("[WEBRTC] Received offer")

    if "sdp" not in params or "type" not in params:
        return JSONResponse({"error": "Invalid SDP offer"}, status_code=400)

    offer = RTCSessionDescription(sdp=params["sdp"], type=params["type"])
    pc = RTCPeerConnection()
    pc_id = id(pc)

    # Session data per PC
    session_data = {
        "pc": pc,
        "data_channels": [],
        "transcriptions": [],
    }
    sessions[pc_id] = session_data

    # ICE state logging
    @pc.on("iceconnectionstatechange")
    async def on_ice_change():
        print("[ICE] State:", pc.iceConnectionState)
        if pc.iceConnectionState == "failed":
            print("[ERROR] ICE connection failed!")
            await pc.close()
        elif pc.iceConnectionState == "closed":
            print("[CLOSED] ICE connection closed")
        elif pc.iceConnectionState == "connected":
            print("[SUCCESS] ICE connection established!")

    # Data channel for text messages
    @pc.on("datachannel")
    def on_datachannel(channel):
        print(f"[DATA CHANNEL] Channel: {channel.label}")
        session_data["data_channels"].append(channel)

        @channel.on("open")
        def on_open():
            print(f"[OPEN] Data channel '{channel.label}' is now OPEN")
            # Send a test message to verify connection
            try:
                channel.send("System ready - start speaking!")
                print("[SENT] Test message sent to client")
            except Exception as e:
                print(f"[ERROR] Failed to send test message: {e}")

        @channel.on("message")
        def on_message(msg):
            print("[MESSAGE] Message from client:", msg)

    # Handle incoming audio
    @pc.on("track")
    def on_track(track):
        print(f"[TRACK] Track received: {track.kind}")
        if track.kind != "audio":
            return

        buffer = []
        SAMPLE_RATE = 48000  # Higher sample rate for better quality
        CHUNK_DURATION = 3  # Shorter chunks for more frequent transcription
        MAX_SAMPLES = int(SAMPLE_RATE * CHUNK_DURATION)
        processing_lock = {"is_processing": False}

        async def transcribe_audio(chunk, session_data):
            """Process transcription only - no summary"""
            try:
                # Save chunk as WAV
                with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
                    wav_path = f.name
                    wav_write(wav_path, SAMPLE_RATE, chunk)
                    print(f"[SAVED] Audio saved to: {wav_path}")

                # Transcribe with Groq Whisper
                if client is None:
                    print("[ERROR] Groq client not initialized; skipping transcription")
                    try:
                        os.unlink(wav_path)
                    except:
                        pass
                    return

                with open(wav_path, "rb") as audio_file:
                    audio_bytes = audio_file.read()

                def do_transcription(file_bytes, filename):
                    try:
                        return client.audio.transcriptions.create(
                            file=(filename, file_bytes),
                            model="whisper-large-v3",
                            temperature=0,
                            response_format="verbose_json",
                        )
                    except Exception:
                        raise

                print("[TRANSCRIBING] Sending for transcription (background thread)...")
                transcription_resp = await asyncio.to_thread(
                    do_transcription, audio_bytes, os.path.basename(wav_path)
                )

                # Get transcribed text
                text = getattr(transcription_resp, "text", "")
                print(f"[TRANSCRIBED] {text}")

                if text.strip():  # Only process non-empty transcriptions
                    session_data["transcriptions"].append(text)

                    # Send transcription to UI
                    for dc in session_data["data_channels"]:
                        if dc.readyState == "open":
                            dc.send(f"{text}")
                            print(f"[SENT] Transcription to client: {text[:50]}...")

                # Clean up temp file
                try:
                    os.unlink(wav_path)
                except:
                    pass

            except Exception as e:
                print(f"[ERROR] Error transcribing: {e}")
                import traceback

                traceback.print_exc()
            finally:
                processing_lock["is_processing"] = False

        async def process_audio():
            print("[AUDIO] Starting audio processing loop...")
            frame_count = 0
            total_samples_received = 0
            try:
                while True:
                    try:
                        # Add timeout to prevent hanging
                        frame = await asyncio.wait_for(track.recv(), timeout=10.0)
                        frame_count += 1

                        # Get frame info
                        frame_samples = frame.samples
                        frame_rate = frame.sample_rate
                        total_samples_received += frame_samples

                        print(
                            f"[FRAME] #{frame_count}: {frame.format.name}, "
                            f"rate={frame_rate}Hz, samples={frame_samples}, "
                            f"duration={frame_samples / frame_rate:.3f}s, "
                            f"total_received={total_samples_received}"
                        )

                        # Convert to numpy array - handle both mono and stereo
                        pcm = frame.to_ndarray()

                        # If multichannel, convert to mono by averaging channels robustly
                        if pcm.ndim > 1:
                            if pcm.shape[0] < pcm.shape[1]:
                                pcm = pcm.mean(axis=0)
                            else:
                                pcm = pcm.mean(axis=-1)
                            pcm = pcm.astype(pcm.dtype)

                        # Resample from frame rate to target SAMPLE_RATE if needed
                        if frame_rate != SAMPLE_RATE:
                            print(
                                f"[RESAMPLE] From {frame_rate}Hz to {SAMPLE_RATE}Hz"
                            )
                            original_length = len(pcm)
                            new_length = int(original_length * SAMPLE_RATE / frame_rate)
                            x_old = np.linspace(0, 1, original_length)
                            x_new = np.linspace(0, 1, new_length)
                            pcm = np.interp(
                                x_new, x_old, pcm.astype(np.float32)
                            ).astype(np.int16)
                            print(
                                f"[RESAMPLED] After resampling: {len(pcm)} samples (from {original_length})"
                            )

                        # Ensure int16 format
                        if pcm.dtype != np.int16:
                            if pcm.dtype == np.float32 or pcm.dtype == np.float64:
                                pcm = (pcm * 32767).astype(np.int16)
                            else:
                                pcm = pcm.astype(np.int16)

                        buffer.append(pcm)

                        total_samples = sum(len(b) for b in buffer)
                        progress = (total_samples / MAX_SAMPLES) * 100
                        print(
                            f"[BUFFER] {total_samples}/{MAX_SAMPLES} samples ({progress:.1f}%) - "
                            f"{total_samples / SAMPLE_RATE:.2f}s audio"
                        )

                        if (
                            total_samples >= MAX_SAMPLES
                            and not processing_lock["is_processing"]
                        ):
                            processing_lock["is_processing"] = True
                            print(
                                f"[PROCESSING] Buffer full! Processing {total_samples} samples ({total_samples / SAMPLE_RATE:.2f}s)"
                            )
                            chunk = np.concatenate(buffer)
                            buffer.clear()

                            # Trim to exact size
                            chunk = chunk[:MAX_SAMPLES]

                            # Process in background without blocking
                            asyncio.create_task(
                                transcribe_audio(chunk, session_data)
                            )

                    except asyncio.TimeoutError:
                        print("[TIMEOUT] No audio frame received (timeout)")
                        continue
                    except Exception as e:
                        print(f"[ERROR] Error receiving frame: {e}")
                        break

            except Exception as e:
                print(f"[ERROR] Audio processing loop error: {e}")
                import traceback

                traceback.print_exc()

        # Start the audio processing task
        task = asyncio.create_task(process_audio())
        session_data["audio_task"] = task
        print("[STARTED] Audio processing task started")

    # SDP handshake
    await pc.setRemoteDescription(offer)
    answer = await pc.createAnswer()
    await pc.setLocalDescription(answer)

    print("[SUCCESS] Sending SDP answer")
    return JSONResponse(
        {"sdp": pc.localDescription.sdp, "type": pc.localDescription.type}
    )


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host="127.0.0.1", port=8000)