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

# Initialize Groq client
client = Groq(api_key="GROQ_API_KEY")

app = FastAPI()

# Store sessions: pc_id -> session_data
sessions = {}

# CORS for local React dev
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/session")
async def new_session():
    session = {"id": len(sessions) + 1, "start": time.time()}
    sessions[session["id"]] = session
    print(f"🆕 Created session: {session}")
    return {"session": session}


@app.post("/webrtc/offer")
async def webrtc_offer(request: Request):
    params = await request.json()
    print("📩 Received offer")

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
        "summary": "",
    }
    sessions[pc_id] = session_data

    # ICE state logging
    @pc.on("iceconnectionstatechange")
    async def on_ice_change():
        print("🌐 ICE state:", pc.iceConnectionState)
        if pc.iceConnectionState == "failed":
            await pc.close()

    # Data channel for text messages & summary updates
    @pc.on("datachannel")
    def on_datachannel(channel):
        print(f"📡 Data channel: {channel.label}")
        session_data["data_channels"].append(channel)

        @channel.on("message")
        def on_message(msg):
            print("📩 Message from client:", msg)

    # Handle incoming audio
    @pc.on("track")
    def on_track(track):
        print(f"🎵 Track received: {track.kind}")
        if track.kind != "audio":
            return

        buffer = []
        SAMPLE_RATE = 16000  # Lower sample rate for faster processing
        CHUNK_DURATION = 10  # seconds - very frequent transcriptions
        MAX_SAMPLES = int(SAMPLE_RATE * CHUNK_DURATION)  # <-- ensure int for slicing
        processing_lock = {"is_processing": False}  # Use dict to avoid nonlocal issues

        async def transcribe_and_summarize(chunk, session_data):
            """Process transcription and summary in background"""
            try:
                # Save chunk as WAV
                with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
                    wav_path = f.name
                    wav_write(wav_path, SAMPLE_RATE, chunk)
                    print(f"💾 Saved audio to: {wav_path}")

                # 1️⃣ Transcribe with Groq Whisper
                with open(wav_path, "rb") as audio_file:
                    print("🔊 Sending for transcription...")
                    transcription_resp = client.audio.transcriptions.create(
                        file=(os.path.basename(wav_path), audio_file.read()),
                        model="whisper-large-v3",
                        temperature=0,
                        response_format="verbose_json",
                    )

                text = transcription_resp.text
                print(f"📝 Transcription: {text}")

                if text.strip():  # Only process non-empty transcriptions
                    session_data["transcriptions"].append(text)

                    # 2️⃣ Progressive summary
                    messages = [
                        {
                            "role": "system",
                            "content": "You are a medical scribe creating a progressive consultation summary.",
                        },
                        {
                            "role": "user",
                            "content": (
                                f"Previous summary:\n{session_data['summary']}\n\n"
                                f"New transcription:\n{text}\n\n"
                                "Update the summary accordingly, adding or amending."
                            ),
                        },
                    ]

                    completion = client.chat.completions.create(
                        model="llama-3.1-8b-instant",
                        messages=messages,
                        temperature=1,
                        max_completion_tokens=1024,
                        top_p=1,
                        stream=True,
                    )

                    # Aggregate streamed chunks
                    new_summary = ""
                    for chunk_resp in completion:
                        content = chunk_resp.choices[0].delta.content
                        if content:
                            new_summary += content

                    session_data["summary"] = new_summary
                    print(f"📄 Updated summary: {new_summary[:100]}...")

                    # 3️⃣ Send updated summary to all data channels
                    for dc in session_data["data_channels"]:
                        if dc.readyState == "open":
                            dc.send(f"📝 Summary update:\n{new_summary}")
                            print("📤 Sent summary to client")

                # Clean up temp file
                try:
                    os.unlink(wav_path)
                except:
                    pass

            except Exception as e:
                print(f"❌ Error transcribing or summarizing: {e}")
                import traceback

                traceback.print_exc()
            finally:
                processing_lock["is_processing"] = False

        async def process_audio():
            print("🎙️ Starting audio processing loop...")
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
                            f"🎵 Frame #{frame_count}: {frame.format.name}, "
                            f"rate={frame_rate}Hz, samples={frame_samples}, "
                            f"duration={frame_samples / frame_rate:.3f}s, "
                            f"total_received={total_samples_received}"
                        )

                        # Convert to numpy array - handle both mono and stereo
                        pcm = frame.to_ndarray()

                        # If multichannel, convert to mono by averaging channels robustly
                        if pcm.ndim > 1:
                            # handle (channels, samples) and (samples, channels)
                            if pcm.shape[0] < pcm.shape[1]:
                                # common: (channels, samples) -> mean over axis=0
                                pcm = pcm.mean(axis=0)
                            else:
                                # fallback: mean over last axis
                                pcm = pcm.mean(axis=-1)
                            pcm = pcm.astype(pcm.dtype)

                        # Resample from frame rate to target SAMPLE_RATE if needed
                        if frame_rate != SAMPLE_RATE:
                            print(
                                f"🔄 Resampling from {frame_rate}Hz to {SAMPLE_RATE}Hz"
                            )
                            original_length = len(pcm)
                            # Calculate new length (int)
                            new_length = int(original_length * SAMPLE_RATE / frame_rate)
                            # Use numpy interpolation for resampling
                            x_old = np.linspace(0, 1, original_length)
                            x_new = np.linspace(0, 1, new_length)
                            pcm = np.interp(
                                x_new, x_old, pcm.astype(np.float32)
                            ).astype(np.int16)
                            print(
                                f"📉 After resampling: {len(pcm)} samples (from {original_length})"
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
                            f"📊 Buffer: {total_samples}/{MAX_SAMPLES} samples ({progress:.1f}%) - "
                            f"{total_samples / SAMPLE_RATE:.2f}s audio"
                        )

                        if (
                            total_samples >= MAX_SAMPLES
                            and not processing_lock["is_processing"]
                        ):
                            processing_lock["is_processing"] = True
                            print(
                                f"✅ Buffer full! Processing {total_samples} samples ({total_samples / SAMPLE_RATE:.2f}s)"
                            )
                            chunk = np.concatenate(buffer)
                            buffer.clear()

                            # Trim to exact size (use int MAX_SAMPLES)
                            chunk = chunk[:MAX_SAMPLES]

                            # Process in background without blocking
                            asyncio.create_task(
                                transcribe_and_summarize(chunk, session_data)
                            )

                    except asyncio.TimeoutError:
                        print("⏱️ No audio frame received (timeout)")
                        continue
                    except Exception as e:
                        print(f"❌ Error receiving frame: {e}")
                        break

            except Exception as e:
                print(f"❌ Audio processing loop error: {e}")
                import traceback

                traceback.print_exc()

        # Start the audio processing task
        task = asyncio.create_task(process_audio())
        session_data["audio_task"] = task
        print("✅ Audio processing task started")

    # SDP handshake
    await pc.setRemoteDescription(offer)
    answer = await pc.createAnswer()
    await pc.setLocalDescription(answer)

    print("✅ Sending SDP answer")
    return JSONResponse(
        {"sdp": pc.localDescription.sdp, "type": pc.localDescription.type}
    )
