import { useState } from "react";
import "./App.css";

function App() {
  const [session, setSession] = useState(null);
  const [pc, setPc] = useState(null);
  const [channel, setChannel] = useState(null);

  const handleStartConsultation = async () => {
    try {
      // 1️⃣ Create session
      const res = await fetch("/api/session");
      if (!res.ok) throw new Error("Failed to create session");
      const data = await res.json();
      if (!data?.session) throw new Error("Invalid session data");
      setSession(data.session);
      console.log("🆕 Session:", data.session);

      // 2️⃣ Get microphone stream BEFORE creating offer
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      console.log("🎤 Microphone stream ready");

      // 3️⃣ Create PeerConnection
      const pc = new RTCPeerConnection();
      setPc(pc);

      // 4️⃣ Add audio tracks to PeerConnection
      stream.getAudioTracks().forEach((track) => pc.addTrack(track, stream));
      console.log("🎤 Audio track added to PeerConnection");

      // 5️⃣ DataChannel for messages
      const dc = pc.createDataChannel("consultation");
      setChannel(dc);

      dc.onopen = () => console.log("✅ Data channel opened");
      dc.onmessage = (e) => {};
      dc.onclose = () => console.log("❌ Data channel closed");

      // 6️⃣ ICE state logging
      pc.oniceconnectionstatechange = () => {
        console.log("🌐 ICE state:", pc.iceConnectionState);
      };

      // 7️⃣ Create offer
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      // 8️⃣ Send offer to server
      const answerRes = await fetch("/webrtc/offer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sdp: offer.sdp, type: offer.type }),
      });

      if (!answerRes.ok) throw new Error("Failed to get answer");
      const answer = await answerRes.json();

      // 9️⃣ Apply server answer
      await pc.setRemoteDescription(answer);
      console.log("✅ WebRTC connected via audio + data channel");
    } catch (e) {
      console.error("❌ Error starting consultation:", e);
      alert(e.message);
      handleEndConsultation();
    }
  };

  const handleEndConsultation = () => {
    if (channel) channel.close();
    if (pc) pc.close();
    setChannel(null);
    setPc(null);
    setSession(null);
    console.log("🛑 Consultation ended");
  };

  return (
    <div className="flex h-screen flex-col gap-4 items-center justify-center p-4">
      <button
        onClick={session ? handleEndConsultation : handleStartConsultation}
        className="py-2 px-4 bg-sky-600 hover:bg-sky-400 text-white rounded-lg"
      >
        {session ? "End Consultation" : "Start Consultation"}
      </button>
    </div>
  );
}

export default App;
