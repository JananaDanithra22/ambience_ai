import { useState, useEffect, useRef } from 'react';

function App() {
  const [session, setSession] = useState(null);
  const [pc, setPc] = useState(null);
  const [channel, setChannel] = useState(null);
  const [liveTranscript, setLiveTranscript] = useState('');
  const [recognitionLang, setRecognitionLang] = useState('en-US');
  const [patientName, setPatientName] = useState('');
  const [patientDOB, setPatientDOB] = useState('');
  const [patientID, setPatientID] = useState('');
  const [doctorName, setDoctorName] = useState('');
  const [isConnecting, setIsConnecting] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [medicalReport, setMedicalReport] = useState(null);
  const [audioWavUrl, setAudioWavUrl] = useState(null);
  const transcriptEndRef = useRef(null);
  const audioStreamRef = useRef(null);
  const recognitionRef = useRef(null);
  const recorderRef = useRef(null);
  const audioChunksRef = useRef([]);
  const audioWavRef = useRef(null);
  const [interimText, setInterimText] = useState('');

  const scrollToBottom = () => {
    transcriptEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [liveTranscript]);

  const handleStartConsultation = async () => {
    // Simplified: do local-only recording + transcription. No backend/WebRTC.
    setIsConnecting(true);
    setMedicalReport(null);
    // clear any previous audio
    if (audioWavUrl) { URL.revokeObjectURL(audioWavUrl); setAudioWavUrl(null); audioWavRef.current = null; }
    setIsPaused(false);
    try {
      // Recommend entering patient name; allow continuation if user confirms
      if (!patientName?.trim()) {
        const ok = confirm('Patient name is empty. Continue without patient metadata?');
        if (!ok) {
          setIsConnecting(false);
          return;
        }
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          channelCount: 1,
          sampleRate: 48000
        }
      });
      audioStreamRef.current = stream;
      console.log('Microphone stream ready (local only)');

      // Mark a lightweight local session so UI behaves the same
      setSession({ id: 'local' });
      setLiveTranscript('Start Speaking...\n\n');

      // Start local transcription automatically
  startLocalTranscription();

      // Start audio recording automatically so full conversation (doctor + patient) is captured
      try {
        startAudioRecording();
      } catch (err) {
        console.warn('Auto-start audio recording failed:', err);
      }

      setIsConnecting(false);
    } catch (e) {
      console.error('Error starting local consultation:', e);
      alert(e.message || 'Failed to start local consultation');
      // cleanup
      try { audioStreamRef.current?.getTracks().forEach(t => t.stop()); } catch (err) { console.warn(err); }
      audioStreamRef.current = null;
      setIsConnecting(false);
    }
  };

  const handlePauseResume = () => {
    if (audioStreamRef.current) {
      const audioTracks = audioStreamRef.current.getAudioTracks();
      audioTracks.forEach(track => {
        track.enabled = isPaused;
      });
      setIsPaused(!isPaused);
      console.log(isPaused ? "Resumed" : "Paused");
    }
  };

  const handleEndConsultation = () => {
    // Build a simple medical report from the transcript and patient metadata
    try {
      const transcript = (liveTranscript || '').trim();
  const header = `Patient Name: ${patientName || 'Not provided'}\nDate: ${new Date().toLocaleDateString()}\nDoctor: ${doctorName || 'Not provided'}\nPatient ID: ${patientID || 'Not provided'}\n\n`;

      // helper to find a short sentence containing a keyword
      const findSentence = (keywords) => {
        if (!transcript) return null;
        const sentences = transcript.split(/[.?!]\s+/);
        for (const s of sentences) {
          for (const k of keywords) {
            if (s.toLowerCase().includes(k)) return s.trim();
          }
        }
        return null;
      };

      const chief = findSentence(['chief complaint', 'complaint', 'presenting']);
      const symptoms = findSentence(['symptom', 'symptoms', 'pain', 'fever', 'cough', 'headache']);
      const duration = findSentence(['duration', 'for', 'since']);
      const diagnosis = findSentence(['diagnos']);
      const meds = findSentence(['medicat', 'tablet', 'dose', 'prescrib']);
      const advice = findSentence(['advice', 'recommend', 'take', 'rest', 'follow up']);
      const follow = findSentence(['follow up', 'follow-up', 'review']);

      const reportLines = [];
      reportLines.push(header);
      reportLines.push(`Chief Complaint: ${chief ? chief : 'Not discussed'}`);
      reportLines.push('');
      reportLines.push(`Symptoms:\n- ${symptoms ? symptoms : 'Not mentioned'}`);
      reportLines.push('');
      reportLines.push(`Duration of Symptoms: ${duration ? duration : 'Not discussed'}`);
      reportLines.push('');
      reportLines.push(`Diagnosis: ${diagnosis ? diagnosis : 'Not discussed'}`);
      reportLines.push('');
      reportLines.push(`Medications / Treatment Given:\n- ${meds ? meds : 'Not mentioned'}`);
      reportLines.push('');
      reportLines.push(`Doctor's Advice:\n${advice ? advice : 'Not discussed'}`);
      reportLines.push('');
      reportLines.push(`Follow-up Date: ${follow ? follow : 'Not specified'}`);
      reportLines.push('\nConsultation Transcript:\n');
      reportLines.push(transcript || 'No transcript available');

      const report = reportLines.join('\n');
      setMedicalReport(report);
    } catch (err) {
      console.warn('Failed to build medical report:', err);
      setMedicalReport(liveTranscript || '');
    }

    try { stopLocalTranscription(); } catch (err) { console.warn(err); }
    try { stopAudioRecording(); } catch (err) { console.warn(err); }
    if (audioStreamRef.current) {
      try { audioStreamRef.current.getTracks().forEach(t => t.stop()); } catch (err) { console.warn(err); }
    }
    setChannel(null);
    setPc(null);
    setSession(null);
    setIsProcessing(false);
    setIsPaused(false);
    audioStreamRef.current = null;
    console.log('Consultation ended');
  };

  const startLocalTranscription = () => {
    if (!window) return;
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      alert('Web Speech API not supported in this browser. Use Chrome or Edge for local transcription.');
      return;
    }

    try {
      const recognition = new SpeechRecognition();
      recognition.lang = recognitionLang || 'en-US';
      // ask for a few alternatives to improve chance of correct text
  try { recognition.maxAlternatives = 3; } catch (err) { console.warn(err); }
      recognition.interimResults = true;
      recognition.continuous = true;

      let interim = '';

      recognition.onresult = (event) => {
        let finalTranscript = '';
        interim = '';
        for (let i = event.resultIndex; i < event.results.length; ++i) {
          const res = event.results[i];
          if (res.isFinal) {
            finalTranscript += res[0].transcript;
          } else {
            interim += res[0].transcript;
          }
        }

        // Post-process final transcript for basic punctuation/casing heuristics
        if (finalTranscript) {
          const cleaned = normalizeTranscript(finalTranscript);
          setLiveTranscript(prev => prev + (prev ? ' ' : '') + cleaned);
          setInterimText('');
        } else {
          // keep interim separately so UI shows it inline without creating separate lines
          setInterimText(interim);
        }
      };

      recognition.onerror = (e) => {
        console.error('Recognition error', e);
      };
      recognition.onend = () => {
        recognitionRef.current = null;
        // If session still active, restart recognition to keep continuous transcription
        try {
          if (session) {
            console.log('Recognition ended, restarting...');
            startLocalTranscription();
          }
        } catch (err) {
          console.warn('Failed to restart recognition', err);
        }
      };

      recognition.start();
  recognitionRef.current = recognition;
    } catch (e) {
      console.error('startLocalTranscription error', e);
      alert('Failed to start local transcription: ' + e.message);
    }
  };

  // Basic cleanup: trim, collapse spaces, capitalize sentences and ensure punctuation.
  const normalizeTranscript = (text) => {
    if (!text) return '';
    let t = text.trim();
    // collapse multiple spaces
    t = t.replace(/\s+/g, ' ');
    // add punctuation at end if missing
    if (!/[.?!]$/.test(t)) t = t.charAt(0).toUpperCase() + t.slice(1) + '.';
    else t = t.charAt(0).toUpperCase() + t.slice(1);
    return t;
  };

  // Encode an AudioBuffer to a 16-bit PCM WAV Blob
  const encodeWAV = (audioBuffer) => {
    const numChannels = Math.min(2, audioBuffer.numberOfChannels || 1);
    const sampleRate = audioBuffer.sampleRate || 48000;
    const format = 1; // PCM

    // interleave channels
    let interleaved;
    if (numChannels === 1) {
      const ch0 = audioBuffer.getChannelData(0);
      interleaved = ch0;
    } else {
      const ch0 = audioBuffer.getChannelData(0);
      const ch1 = audioBuffer.getChannelData(1);
      interleaved = new Float32Array(ch0.length + ch1.length);
      let idx = 0;
      for (let i = 0; i < ch0.length; i++) {
        interleaved[idx++] = ch0[i];
        interleaved[idx++] = ch1[i];
      }
    }

    // convert float audio data to 16-bit PCM
    const buffer = new ArrayBuffer(44 + interleaved.length * 2);
    const view = new DataView(buffer);

    /* RIFF identifier */ writeString(view, 0, 'RIFF');
    /* file length */ view.setUint32(4, 36 + interleaved.length * 2, true);
    /* RIFF type */ writeString(view, 8, 'WAVE');
    /* format chunk identifier */ writeString(view, 12, 'fmt ');
    /* format chunk length */ view.setUint32(16, 16, true);
    /* sample format (raw) */ view.setUint16(20, format, true);
    /* channel count */ view.setUint16(22, numChannels, true);
    /* sample rate */ view.setUint32(24, sampleRate, true);
    /* byte rate (sample rate * block align) */ view.setUint32(28, sampleRate * numChannels * 2, true);
    /* block align (channel count * bytes per sample) */ view.setUint16(32, numChannels * 2, true);
    /* bits per sample */ view.setUint16(34, 16, true);
    /* data chunk identifier */ writeString(view, 36, 'data');
    /* data chunk length */ view.setUint32(40, interleaved.length * 2, true);

    // write PCM samples
    let offset = 44;
    for (let i = 0; i < interleaved.length; i++, offset += 2) {
      let s = Math.max(-1, Math.min(1, interleaved[i]));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }

    return new Blob([view], { type: 'audio/wav' });
  };

  const writeString = (view, offset, string) => {
    for (let i = 0; i < string.length; i++) {
      view.setUint8(offset + i, string.charCodeAt(i));
    }
  };

  const stopLocalTranscription = () => {
    try {
      if (recognitionRef.current) {
        recognitionRef.current.stop();
        recognitionRef.current = null;
      }
    } catch (e) {
      console.error('stopLocalTranscription error', e);
    } finally {
      // transcription stopped
    }
  };

  const startAudioRecording = () => {
    if (!audioStreamRef.current) {
      alert('No microphone stream available. Start the consultation first.');
      return;
    }

    try {
      audioChunksRef.current = [];
      const options = { mimeType: 'audio/webm' };
      const recorder = new MediaRecorder(audioStreamRef.current, options);
      recorderRef.current = recorder;

      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) audioChunksRef.current.push(e.data);
      };

      recorder.onstop = () => {
        // audioChunksRef.current contains the recorded Blob parts
        (async () => {
          try {
            const blob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
            console.log('Recorded audio blob size:', blob.size);

            // Try to decode the webm/opus data and export as WAV for higher compatibility/accuracy
            if (window.AudioContext || window.webkitAudioContext) {
              const AudioCtx = window.AudioContext || window.webkitAudioContext;
              const ac = new AudioCtx();
              const arrayBuffer = await blob.arrayBuffer();
              const audioBuffer = await ac.decodeAudioData(arrayBuffer);

              // encode WAV (16-bit PCM)
              const wavBlob = encodeWAV(audioBuffer);
              audioWavRef.current = wavBlob;
              if (audioWavUrl) {
                URL.revokeObjectURL(audioWavUrl);
              }
              const url = URL.createObjectURL(wavBlob);
              setAudioWavUrl(url);
              console.log('WAV blob created, size:', wavBlob.size);
            } else {
              console.warn('AudioContext not available; cannot convert to WAV');
            }
          } catch (err) {
            console.warn('Failed to convert recorded audio to WAV:', err);
          }
        })();
      };

      recorder.start();
    } catch (e) {
      console.error('startAudioRecording error', e);
      alert('Failed to start audio recording: ' + e.message);
    }
  };

  const stopAudioRecording = () => {
    try {
      if (recorderRef.current && recorderRef.current.state !== 'inactive') {
        recorderRef.current.stop();
      }
    } catch (e) {
      console.error('stopAudioRecording error', e);
    }
  };

  

  

  const clearTranscript = () => {
    setLiveTranscript('');
    setMedicalReport(null);
    if (audioWavUrl) { URL.revokeObjectURL(audioWavUrl); setAudioWavUrl(null); audioWavRef.current = null; }
  };

  const downloadTextReport = () => {
    if (!medicalReport) return;
    const blob = new Blob([medicalReport], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `medical-report-${new Date().toISOString().split('T')[0]}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const downloadPDF = () => {
    if (!medicalReport) return;
    
    const printWindow = window.open('', '_blank');
    
    printWindow.document.write(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Medical Report - ${new Date().toLocaleDateString()}</title>
        <style>
          @media print {
            body { margin: 0; }
            @page { margin: 1.5cm; }
          }
          body {
            font-family: 'Arial', 'Helvetica', sans-serif;
            line-height: 1.6;
            color: #1a202c;
            max-width: 800px;
            margin: 0 auto;
            padding: 40px 20px;
          }
          .header {
            text-align: center;
            border-bottom: 3px solid #0369a1;
            padding-bottom: 20px;
            margin-bottom: 30px;
          }
          .header h1 {
            color: #0369a1;
            margin: 0 0 5px 0;
            font-size: 28px;
          }
          .header p {
            color: #64748b;
            margin: 5px 0;
            font-size: 14px;
          }
          .content {
            white-space: pre-wrap;
            font-size: 14px;
            line-height: 1.8;
          }
          .footer {
            margin-top: 40px;
            padding-top: 20px;
            border-top: 2px solid #e2e8f0;
            text-align: center;
            font-size: 12px;
            color: #94a3b8;
          }
        </style>
      </head>
      <body>
        <div class="header">
          <h1>Medical Consultation Report</h1>
          <p>Generated on ${new Date().toLocaleString()}</p>
        </div>
        <div class="content">${medicalReport.replace(/\n/g, '<br>')}</div>
        <div class="footer">
          <p>This report was generated using Ambience AI Medical Consultation System</p>
          <p>Confidential Medical Document</p>
        </div>
      </body>
      </html>
    `);
    
    printWindow.document.close();
    
    setTimeout(() => {
      printWindow.print();
    }, 250);
  };

  const handlePrint = () => {
    if (!medicalReport) return;
    downloadPDF();
  };

  return (
    <div style={{
      display: 'flex',
      height: '100vh',
      background: 'linear-gradient(135deg, #5E9C84 0%, #497F86 25%, #364A7D 50%, #524286 75%, #69458B 100%)',
      fontFamily: '"Poppins", "Segoe UI", "Roboto", sans-serif'
    }}>
      {/* Sidebar */}
      <div style={{
        width: '340px',
        background: 'linear-gradient(180deg, #69458B 0%, #524286 100%)',
        boxShadow: '4px 0 24px rgba(0, 0, 0, 0.08)',
        borderRight: '1px solid rgba(255, 255, 255, 0.1)',
        display: 'flex',
        flexDirection: 'column'
      }}>
        <div style={{
          padding: '28px 24px',
          borderBottom: '2px solid rgba(255, 255, 255, 0.2)',
          backgroundColor: 'rgba(255, 255, 255, 0.05)'
        }}>
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: '16px',
            marginBottom: '8px'
          }}>
            <img 
              src="/src/assets/Ambiencelogo.png" 
              alt="Ambience AI Logo"
              style={{
                width: '100px',
                height: '100px',
                objectFit: 'contain',
                flexShrink: 0
              }}
            />
            <div>
              <h1 style={{
                fontSize: '24px',
                fontWeight: '700',
                color: '#0f172a',
                margin: 0,
                letterSpacing: '-0.02em'
              }}>Ambience AI</h1>
              <p style={{
                fontSize: '13px',
                color: '#64748b',
                margin: 0,
                fontWeight: '500'
              }}>Medical Documentation</p>
            </div>
          </div>
        </div>
        
        <div style={{ padding: '24px', flex: 1 }}>
          {/* Clinician inputs: Patient metadata (optional but recommended) */}
          <div style={{ marginBottom: '16px' }}>
            <label style={{ display: 'block', fontSize: '13px', marginBottom: '6px', color: '#f8fafc' }}>Patient Name</label>
            <input
              value={patientName}
              onChange={(e) => setPatientName(e.target.value)}
              placeholder="e.g. John Doe"
              style={{ width: '100%', padding: '10px', borderRadius: '6px', border: '1px solid rgba(255,255,255,0.06)', marginBottom: '8px' }}
            />

            <label style={{ display: 'block', fontSize: '13px', marginBottom: '6px', color: '#f8fafc' }}>DOB</label>
            <input
              value={patientDOB}
              onChange={(e) => setPatientDOB(e.target.value)}
              placeholder="YYYY-MM-DD"
              style={{ width: '100%', padding: '10px', borderRadius: '6px', border: '1px solid rgba(255,255,255,0.06)', marginBottom: '8px' }}
            />

            <label style={{ display: 'block', fontSize: '13px', marginBottom: '6px', color: '#f8fafc' }}>Patient ID</label>
            <input
              value={patientID}
              onChange={(e) => setPatientID(e.target.value)}
              placeholder="Optional patient identifier"
              style={{ width: '100%', padding: '10px', borderRadius: '6px', border: '1px solid rgba(255,255,255,0.06)' }}
            />
            
            <label style={{ display: 'block', fontSize: '13px', marginBottom: '6px', color: '#f8fafc', marginTop: '12px' }}>Doctor Name</label>
            <input
              value={doctorName}
              onChange={(e) => setDoctorName(e.target.value)}
              placeholder="e.g. Dr. Jane Smith"
              style={{ width: '100%', padding: '10px', borderRadius: '6px', border: '1px solid rgba(255,255,255,0.06)' }}
            />
            <div style={{ marginTop: '10px' }}>
              <label style={{ display: 'block', fontSize: '13px', marginBottom: '6px', color: '#f8fafc' }}>Transcription Language</label>
              <select value={recognitionLang} onChange={(e) => setRecognitionLang(e.target.value)} style={{ width: '100%', padding: '8px', borderRadius: '6px' }}>
                <option value="en-US">English (US)</option>
                <option value="en-GB">English (UK)</option>
                <option value="es-ES">Spanish (Spain)</option>
                <option value="fr-FR">French</option>
              </select>
            </div>
          </div>

          <button
            onClick={session ? handleEndConsultation : handleStartConsultation}
            disabled={isConnecting || isProcessing}
            style={{
              width: '100%',
              padding: '14px 18px',
              borderRadius: '10px',
              fontWeight: '600',
              fontSize: '15px',
              border: 'none',
              cursor: (isConnecting || isProcessing) ? 'not-allowed' : 'pointer',
              backgroundColor: session ? '#dc2626' : (isConnecting || isProcessing) ? '#cbd5e1' : '#364A7D',
              color: 'white',
              transition: 'all 0.2s',
              marginBottom: '12px',
              boxShadow: (isConnecting || isProcessing) ? 'none' : '0 2px 8px rgba(54, 74, 125, 0.3)'
            }}
            onMouseOver={(e) => {
              if (!isConnecting && !isProcessing) {
                e.target.style.backgroundColor = session ? '#b91c1c' : '#524286';
                e.target.style.transform = 'translateY(-1px)';
                e.target.style.boxShadow = session ? '0 4px 12px rgba(220, 38, 38, 0.4)' : '0 4px 12px rgba(82, 66, 134, 0.4)';
              }
            }}
            onMouseOut={(e) => {
              e.target.style.backgroundColor = session ? '#dc2626' : (isConnecting || isProcessing) ? '#cbd5e1' : '#364A7D';
              e.target.style.transform = 'translateY(0)';
              e.target.style.boxShadow = (isConnecting || isProcessing) ? 'none' : '0 2px 8px rgba(54, 74, 125, 0.3)';
            }}
          >
            {isProcessing ? 'Processing Report...' : isConnecting ? 'Connecting...' : session ? 'End Consultation' : 'Start Consultation'}
          </button>

          {session && (
            <button
              onClick={handlePauseResume}
              style={{
                width: '100%',
                padding: '12px 18px',
                borderRadius: '10px',
                fontWeight: '600',
                fontSize: '14px',
                border: '2px solid #364A7D',
                cursor: 'pointer',
                backgroundColor: 'white',
                color: '#364A7D',
                transition: 'all 0.2s',
                marginBottom: '12px'
              }}
              onMouseOver={(e) => {
                e.target.style.backgroundColor = '#f0f9ff';
              }}
              onMouseOut={(e) => {
                e.target.style.backgroundColor = 'white';
              }}
            >
              {isPaused ? 'Resume Recording' : 'Pause Recording'}
            </button>
          )}

          {/* manual transcription/recording controls removed per request - recording & transcription run automatically */}

          {(liveTranscript || medicalReport) && !session && (
            <button
              onClick={clearTranscript}
              style={{
                width: '100%',
                padding: '12px 18px',
                borderRadius: '10px',
                fontWeight: '600',
                fontSize: '14px',
                border: '2px solid #e2e8f0',
                cursor: 'pointer',
                backgroundColor: 'white',
                color: '#475569',
                transition: 'all 0.2s',
                marginBottom: '12px'
              }}
              onMouseOver={(e) => {
                e.target.style.backgroundColor = '#f8fafc';
                e.target.style.borderColor = '#cbd5e1';
              }}
              onMouseOut={(e) => {
                e.target.style.backgroundColor = 'white';
                e.target.style.borderColor = '#e2e8f0';
              }}
            >
              New Consultation
            </button>
          )}

          {medicalReport && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              <button
                onClick={downloadPDF}
                style={{
                  width: '100%',
                  padding: '12px 18px',
                  borderRadius: '10px',
                  fontWeight: '600',
                  fontSize: '14px',
                  border: 'none',
                  cursor: 'pointer',
                  backgroundColor: '#5E9C84',
                  color: 'white',
                  transition: 'all 0.2s',
                  boxShadow: '0 2px 8px rgba(94, 156, 132, 0.3)'
                }}
                onMouseOver={(e) => {
                  e.target.style.backgroundColor = '#497F86';
                  e.target.style.transform = 'translateY(-1px)';
                  e.target.style.boxShadow = '0 4px 12px rgba(94, 156, 132, 0.4)';
                }}
                onMouseOut={(e) => {
                  e.target.style.backgroundColor = '#5E9C84';
                  e.target.style.transform = 'translateY(0)';
                  e.target.style.boxShadow = '0 2px 8px rgba(94, 156, 132, 0.3)';
                }}
              >
                Download PDF
              </button>

              {audioWavUrl && (
                <button
                  onClick={() => {
                    try {
                      const a = document.createElement('a');
                      a.href = audioWavUrl;
                      a.download = `consultation-audio-${new Date().toISOString().split('T')[0]}.wav`;
                      document.body.appendChild(a);
                      a.click();
                      document.body.removeChild(a);
                    } catch (err) {
                      console.warn('Failed to download audio', err);
                    }
                  }}
                  style={{
                    width: '100%',
                    padding: '12px 18px',
                    borderRadius: '10px',
                    fontWeight: '600',
                    fontSize: '14px',
                    border: 'none',
                    cursor: 'pointer',
                    backgroundColor: '#2563eb',
                    color: 'white',
                    transition: 'all 0.2s',
                    boxShadow: '0 2px 8px rgba(37, 99, 235, 0.3)'
                  }}
                  onMouseOver={(e) => {
                    e.target.style.backgroundColor = '#1e40af';
                    e.target.style.transform = 'translateY(-1px)';
                    e.target.style.boxShadow = '0 4px 12px rgba(37, 99, 235, 0.4)';
                  }}
                  onMouseOut={(e) => {
                    e.target.style.backgroundColor = '#2563eb';
                    e.target.style.transform = 'translateY(0)';
                    e.target.style.boxShadow = '0 2px 8px rgba(37, 99, 235, 0.3)';
                  }}
                >
                  Download Audio
                </button>
              )}

              <button
                onClick={handlePrint}
                style={{
                  width: '100%',
                  padding: '12px 18px',
                  borderRadius: '10px',
                  fontWeight: '600',
                  fontSize: '14px',
                  border: 'none',
                  cursor: 'pointer',
                  backgroundColor: '#69458B',
                  color: 'white',
                  transition: 'all 0.2s',
                  boxShadow: '0 2px 8px rgba(105, 69, 139, 0.3)'
                }}
                onMouseOver={(e) => {
                  e.target.style.backgroundColor = '#524286';
                  e.target.style.transform = 'translateY(-1px)';
                  e.target.style.boxShadow = '0 4px 12px rgba(105, 69, 139, 0.4)';
                }}
                onMouseOut={(e) => {
                  e.target.style.backgroundColor = '#69458B';
                  e.target.style.transform = 'translateY(0)';
                  e.target.style.boxShadow = '0 2px 8px rgba(105, 69, 139, 0.3)';
                }}
              >
                Print Report
              </button>

              <button
                onClick={downloadTextReport}
                style={{
                  width: '100%',
                  padding: '12px 18px',
                  borderRadius: '10px',
                  fontWeight: '600',
                  fontSize: '14px',
                  border: '2px solid #364A7D',
                  cursor: 'pointer',
                  backgroundColor: 'white',
                  color: '#364A7D',
                  transition: 'all 0.2s'
                }}
                onMouseOver={(e) => {
                  e.target.style.backgroundColor = '#f0f9ff';
                }}
                onMouseOut={(e) => {
                  e.target.style.backgroundColor = 'white';
                }}
              >
                Download TXT
              </button>
            </div>
          )}

          <div style={{
            marginTop: '24px',
            padding: '18px',
            backgroundColor: '#f8fafc',
            borderRadius: '12px',
            border: '1px solid #e2e8f0'
          }}>
            <h3 style={{
              fontWeight: '600',
              color: '#334155',
              margin: '0 0 14px 0',
              fontSize: '13px',
              textTransform: 'uppercase',
              letterSpacing: '0.05em'
            }}>Status</h3>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '12px' }}>
              <div style={{
                width: '10px',
                height: '10px',
                borderRadius: '50%',
                backgroundColor: session ? (isPaused ? '#f59e0b' : '#22c55e') : isProcessing ? '#8b5cf6' : '#94a3b8',
                boxShadow: (session || isProcessing) ? '0 0 12px currentColor' : 'none',
                animation: (session && !isPaused) || isProcessing ? 'pulse 2s infinite' : 'none'
              }} />
              <span style={{ color: '#475569', fontSize: '14px', fontWeight: '500' }}>
                {isProcessing ? 'Generating Report...' : session ? (isPaused ? 'Paused' : 'Recording...') : 'Ready'}
              </span>
            </div>
            {session && (
              <div style={{
                color: '#64748b',
                fontSize: '12px',
                padding: '8px 12px',
                backgroundColor: 'white',
                borderRadius: '6px',
                border: '1px solid #e2e8f0'
              }}>
                <strong>Session:</strong> #{session.id}
              </div>
            )}
          </div>
        </div>

        <div style={{
          padding: '16px 24px',
          borderTop: '1px solid #e2e8f0',
          backgroundColor: '#f8fafc',
          fontSize: '11px',
          color: '#94a3b8',
          textAlign: 'center'
        }}>
          HIPAA Compliant • Secure Recording
        </div>
      </div>

      {/* Main Content */}
      <div style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        backgroundColor: 'white'
      }}>
        <div style={{
          backgroundColor: 'white',
          boxShadow: '0 1px 3px rgba(0,0,0,0.08)',
          borderBottom: '1px solid #e2e8f0',
          padding: '20px 32px',
          display: 'flex',
          alignItems: 'center',
          gap: '14px'
        }}>
          <div style={{
            width: '14px',
            height: '14px',
            borderRadius: '50%',
            backgroundColor: medicalReport ? '#8b5cf6' : session ? (isPaused ? '#f59e0b' : '#22c55e') : '#cbd5e1',
            boxShadow: (medicalReport || (session && !isPaused)) ? '0 0 14px currentColor' : 'none'
          }} />
          <h2 style={{
            fontSize: '18px',
            fontWeight: '600',
            color: '#0f172a',
            margin: 0,
            letterSpacing: '-0.01em'
          }}>
            {medicalReport ? 'Medical Report' : session ? (isPaused ? 'Recording Paused' : 'Live Transcription') : 'Waiting to Start'}
          </h2>
        </div>

        <div style={{
          flex: 1,
          overflowY: 'auto',
          padding: '40px',
          backgroundColor: '#fafbfc'
        }}>
          {medicalReport ? (
            <div style={{
              maxWidth: '900px',
              margin: '0 auto',
              backgroundColor: 'white',
              padding: '48px',
              borderRadius: '16px',
              border: '1px solid #e2e8f0',
              boxShadow: '0 4px 24px rgba(0,0,0,0.06)'
            }}>
              <pre style={{
                color: '#1e293b',
                fontSize: '15px',
                lineHeight: '1.9',
                whiteSpace: 'pre-wrap',
                wordWrap: 'break-word',
                margin: 0,
                fontFamily: '"Poppins", "Segoe UI", sans-serif'
              }}>
                {medicalReport}
              </pre>
            </div>
          ) : liveTranscript ? (
            <div style={{
              maxWidth: '1100px',
              margin: '0 auto',
              backgroundColor: 'white',
              padding: '40px',
              borderRadius: '16px',
              border: '1px solid #e2e8f0',
              boxShadow: '0 2px 12px rgba(0,0,0,0.04)'
            }}>
              <pre style={{
                color: '#334155',
                fontSize: '16px',
                lineHeight: '1.9',
                whiteSpace: 'pre-wrap',
                wordWrap: 'break-word',
                margin: 0,
                fontFamily: '"Poppins", "Segoe UI", sans-serif',
                letterSpacing: '0.01em'
              }}>
                {liveTranscript}{interimText ? interimText : ''}
                {session && !isPaused && (
                  <span style={{
                    display: 'inline-block',
                    width: '3px',
                    height: '1.3em',
                    backgroundColor: '#364A7D',
                    marginLeft: '3px',
                    animation: 'blink 1s infinite',
                    verticalAlign: 'text-bottom'
                  }} />
                )}
              </pre>
              <div ref={transcriptEndRef} />
            </div>
          ) : (
            <div style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              height: '100%',
              textAlign: 'center',
              color: '#64748b'
            }}>
              <div>
                <div style={{
                  width: '120px',
                  height: '120px',
                  margin: '0 auto 28px',
                  borderRadius: '50%',
                  background: 'linear-gradient(135deg, #5E9C84 0%, #497F86 100%)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  boxShadow: '0 8px 24px rgba(94, 156, 132, 0.3)'
                }}>
                  <svg width="56" height="56" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <rect x="9" y="2" width="6" height="14" rx="3" fill="#364A7D"/>
                    <path d="M5 10V12C5 15.866 8.13401 19 12 19C15.866 19 19 15.866 19 12V10" stroke="#364A7D" strokeWidth="2" strokeLinecap="round"/>
                    <line x1="12" y1="19" x2="12" y2="22" stroke="#364A7D" strokeWidth="2" strokeLinecap="round"/>
                    <line x1="8" y1="22" x2="16" y2="22" stroke="#364A7D" strokeWidth="2" strokeLinecap="round"/>
                  </svg>
                </div>
                <p style={{ fontSize: '22px', fontWeight: '600', margin: '0 0 10px 0', color: '#334155' }}>
                  Ready to Begin
                </p>
                <p style={{ fontSize: '15px', margin: 0, color: '#64748b' }}>
                  Start a consultation to begin transcribing
                </p>
              </div>
            </div>
          )}
        </div>
      </div>

      <style>{`
        @keyframes blink {
          0%, 50% { opacity: 1; }
          51%, 100% { opacity: 0; }
        }
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.6; }
        }
        * {
          -webkit-font-smoothing: antialiased;
          -moz-osx-font-smoothing: grayscale;
        }
      `}</style>
    </div>
  );
}

export default App;