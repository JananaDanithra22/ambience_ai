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
from scipy import signal
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
    """Receive a conversation/order from the frontend and persist it in-memory (and on-disk)."""
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


def preprocess_audio(audio_data, sample_rate):
    """Lightweight audio preprocessing for better transcription."""
    # Convert to float for processing
    audio_float = audio_data.astype(np.float32)
    
    # Normalize audio to -1 to 1 range
    max_val = np.abs(audio_float).max()
    if max_val > 0:
        audio_float = audio_float / max_val
    
    # Apply gentle high-pass filter to remove rumble (below 80 Hz)
    sos = signal.butter(2, 80, btype='highpass', fs=sample_rate, output='sos')
    audio_float = signal.sosfilt(sos, audio_float)
    
    # Apply low-pass filter to remove high-frequency noise
    # Must be less than Nyquist frequency (sample_rate / 2)
    nyquist = sample_rate / 2
    cutoff = min(7500, nyquist * 0.95)  # 7500 Hz or 95% of Nyquist, whichever is lower
    sos = signal.butter(2, cutoff, btype='lowpass', fs=sample_rate, output='sos')
    audio_float = signal.sosfilt(sos, audio_float)
    
    # Normalize again after filtering
    max_val = np.abs(audio_float).max()
    if max_val > 0:
        audio_float = audio_float / max_val
    
    # Convert back to int16 with proper scaling
    audio_int16 = (audio_float * 32767 * 0.9).astype(np.int16)
    
    return audio_int16


def resample_audio(audio, original_rate, target_rate):
    """High-quality audio resampling using scipy's resample."""
    if original_rate == target_rate:
        return audio
    
    # Calculate the number of samples in the resampled audio
    num_samples = int(len(audio) * target_rate / original_rate)
    
    # Use scipy's resample for high-quality resampling
    resampled = signal.resample(audio, num_samples)
    
    return resampled.astype(np.int16)


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
        TARGET_SAMPLE_RATE = 16000  # Optimal for Whisper
        CHUNK_DURATION = 4  # Balanced: good accuracy + responsive
        MAX_SAMPLES = int(TARGET_SAMPLE_RATE * CHUNK_DURATION)
        processing_lock = {"is_processing": False}

        async def transcribe_audio(chunk, session_data):
            """Process transcription with improved audio quality."""
            try:
                print("[PREPROCESSING] Starting audio preprocessing...")
                # Preprocess audio for better quality
                processed_audio = preprocess_audio(chunk, TARGET_SAMPLE_RATE)
                
                # Save chunk as WAV
                with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
                    wav_path = f.name
                    wav_write(wav_path, TARGET_SAMPLE_RATE, processed_audio)
                    print(f"[SAVED] Audio saved: {len(processed_audio)/TARGET_SAMPLE_RATE:.2f}s")

                # Transcribe with Groq Whisper
                if client is None:
                    print("[ERROR] Groq client not initialized")
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
                            language="en",
                            temperature=0.0,
                            response_format="verbose_json",
                        )
                    except Exception:
                        raise

                print("[TRANSCRIBING] Sending to Whisper API...")
                start_time = time.time()
                transcription_resp = await asyncio.to_thread(
                    do_transcription, audio_bytes, os.path.basename(wav_path)
                )
                elapsed = time.time() - start_time
                print(f"[TRANSCRIPTION TIME] {elapsed:.2f}s")

                # Get transcribed text
                text = getattr(transcription_resp, "text", "").strip()
                
                if text:
                    print(f"[TRANSCRIBED] '{text}'")
                    session_data["transcriptions"].append(text)

                    # Send raw transcription to UI immediately (no AI processing)
                    for dc in session_data["data_channels"]:
                        if dc.readyState == "open":
                            try:
                                dc.send(text)  # Send ONLY the raw transcribed text
                                print(f"[✓ SENT TO UI] '{text}'")
                            except Exception as send_err:
                                print(f"[ERROR] Failed to send to UI: {send_err}")
                else:
                    print("[NO TEXT] Empty transcription result")

                # Clean up temp file
                try:
                    os.unlink(wav_path)
                except:
                    pass

            except Exception as e:
                print(f"[ERROR] Transcription error: {e}")
                import traceback
                traceback.print_exc()
            finally:
                processing_lock["is_processing"] = False
                print("[UNLOCK] Processing lock released")

        async def process_audio():
            print("[AUDIO] Starting audio processing loop...")
            frame_count = 0
            try:
                while True:
                    try:
                        frame = await asyncio.wait_for(track.recv(), timeout=10.0)
                        frame_count += 1

                        frame_samples = frame.samples
                        frame_rate = frame.sample_rate

                        if frame_count % 50 == 0:  # Log every 50 frames to reduce spam
                            print(f"[FRAME] #{frame_count}: {frame_rate}Hz, {frame_samples} samples")

                        # Convert to numpy array
                        pcm = frame.to_ndarray()

                        # Convert to mono if multichannel
                        if pcm.ndim > 1:
                            if pcm.shape[0] < pcm.shape[1]:
                                pcm = pcm.mean(axis=0)
                            else:
                                pcm = pcm.mean(axis=-1)
                            pcm = pcm.astype(np.int16)

                        # Ensure int16 format
                        if pcm.dtype != np.int16:
                            if pcm.dtype == np.float32 or pcm.dtype == np.float64:
                                pcm = (pcm * 32767).astype(np.int16)
                            else:
                                pcm = pcm.astype(np.int16)

                        # Resample to target rate
                        if frame_rate != TARGET_SAMPLE_RATE:
                            pcm = resample_audio(pcm, frame_rate, TARGET_SAMPLE_RATE)

                        buffer.append(pcm)

                        total_samples = sum(len(b) for b in buffer)
                        
                        if total_samples >= MAX_SAMPLES and not processing_lock["is_processing"]:
                            processing_lock["is_processing"] = True
                            duration = total_samples / TARGET_SAMPLE_RATE
                            print(f"\n[BUFFER FULL] Processing {duration:.2f}s of audio")
                            print(f"[LOCK] Processing lock acquired")
                            
                            chunk = np.concatenate(buffer)
                            buffer.clear()

                            # Trim to exact size
                            chunk = chunk[:MAX_SAMPLES]

                            # Process in background
                            asyncio.create_task(transcribe_audio(chunk, session_data))

                    except asyncio.TimeoutError:
                        print("[TIMEOUT] No audio frame (10s timeout)")
                        continue
                    except Exception as e:
                        print(f"[ERROR] Frame error: {e}")
                        break

            except Exception as e:
                print(f"[ERROR] Audio loop error: {e}")
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