import { useState, useEffect, useRef } from 'react';

function App() {
  const [session, setSession] = useState(null);
  const [pc, setPc] = useState(null);
  const [channel, setChannel] = useState(null);
  const [liveTranscript, setLiveTranscript] = useState('');
  const [isConnecting, setIsConnecting] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [medicalReport, setMedicalReport] = useState(null);
  const transcriptEndRef = useRef(null);
  const audioStreamRef = useRef(null);

  const scrollToBottom = () => {
    transcriptEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [liveTranscript]);

  const handleStartConsultation = async () => {
    setIsConnecting(true);
    setMedicalReport(null);
    setIsPaused(false);
    try {
      const res = await fetch("http://localhost:8000/api/session");
      if (!res.ok) throw new Error("Failed to create session");
      const data = await res.json();
      if (!data?.session) throw new Error("Invalid session data");
      setSession(data.session);
      console.log("Session:", data.session);

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioStreamRef.current = stream;
      console.log("Microphone stream ready");

      const pc = new RTCPeerConnection();
      setPc(pc);

      stream.getAudioTracks().forEach((track) => pc.addTrack(track, stream));
      console.log("Audio track added to PeerConnection");

      const dc = pc.createDataChannel("consultation");
      setChannel(dc);

      dc.onopen = () => {
        console.log("Data channel opened");
        setLiveTranscript('Start Speaking...\n\n');
      };

      dc.onmessage = (e) => {
        console.log("Received:", e.data);
        const text = e.data;
        let content = text.replace('', '').replace('Summary update:\n', '');
        setLiveTranscript(prev => prev + content + ' ');
      };

      dc.onclose = () => {
        console.log("Data channel closed");
      };

      pc.oniceconnectionstatechange = () => {
        console.log("ICE state:", pc.iceConnectionState);
      };

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      const answerRes = await fetch("http://localhost:8000/api/webrtc/offer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sdp: offer.sdp, type: offer.type }),
      });

      if (!answerRes.ok) throw new Error("Failed to get answer");
      const answer = await answerRes.json();

      await pc.setRemoteDescription(answer);
      console.log("WebRTC connected");
      
      setIsConnecting(false);
    } catch (e) {
      console.error("Error:", e);
      alert(e.message);
      handleEndConsultation();
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

  const handleEndConsultation = async () => {
    if (!session || !liveTranscript.trim()) {
      if (channel) channel.close();
      if (pc) pc.close();
      if (audioStreamRef.current) {
        audioStreamRef.current.getTracks().forEach(track => track.stop());
      }
      setChannel(null);
      setPc(null);
      setSession(null);
      setLiveTranscript('');
      setIsPaused(false);
      audioStreamRef.current = null;
      return;
    }

    setIsProcessing(true);

    try {
      if (channel) channel.close();
      if (pc) pc.close();
      if (audioStreamRef.current) {
        audioStreamRef.current.getTracks().forEach(track => track.stop());
      }

      console.log("Processing medical report...");
      
      const response = await fetch("http://localhost:8000/api/process-consultation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: session.id,
          transcript: liveTranscript
        }),
      });

      if (!response.ok) throw new Error("Failed to process consultation");
      
      const data = await response.json();
      console.log("Medical report received:", data);
      
      setMedicalReport(data.report);
      
    } catch (e) {
      console.error("Error processing consultation:", e);
      alert("Failed to process consultation: " + e.message);
    } finally {
      setChannel(null);
      setPc(null);
      setSession(null);
      setIsProcessing(false);
      setIsPaused(false);
      audioStreamRef.current = null;
      console.log("Consultation ended");
    }
  };

  const clearTranscript = () => {
    setLiveTranscript('');
    setMedicalReport(null);
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
                color: 'white',
                margin: 0,
                letterSpacing: '-0.02em'
              }}>Ambience AI</h1>
              <p style={{
                fontSize: '13px',
                color: 'rgba(255, 255, 255, 0.8)',
                margin: 0,
                fontWeight: '500'
              }}>Medical Documentation</p>
            </div>
          </div>
        </div>
        
        <div style={{ padding: '24px', flex: 1 }}>
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
              backgroundColor: session ? '#dc2626' : (isConnecting || isProcessing) ? '#cbd5e1' : '#5E9C84',
              color: 'white',
              transition: 'all 0.2s',
              marginBottom: '12px',
              boxShadow: (isConnecting || isProcessing) ? 'none' : '0 2px 8px rgba(94, 156, 132, 0.4)'
            }}
            onMouseOver={(e) => {
              if (!isConnecting && !isProcessing) {
                e.target.style.backgroundColor = session ? '#b91c1c' : '#497F86';
                e.target.style.transform = 'translateY(-1px)';
                e.target.style.boxShadow = session ? '0 4px 12px rgba(220, 38, 38, 0.4)' : '0 4px 12px rgba(73, 127, 134, 0.5)';
              }
            }}
            onMouseOut={(e) => {
              e.target.style.backgroundColor = session ? '#dc2626' : (isConnecting || isProcessing) ? '#cbd5e1' : '#5E9C84';
              e.target.style.transform = 'translateY(0)';
              e.target.style.boxShadow = (isConnecting || isProcessing) ? 'none' : '0 2px 8px rgba(94, 156, 132, 0.4)';
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
                border: '2px solid white',
                cursor: 'pointer',
                backgroundColor: 'rgba(255, 255, 255, 0.1)',
                color: 'white',
                transition: 'all 0.2s',
                marginBottom: '12px'
              }}
              onMouseOver={(e) => {
                e.target.style.backgroundColor = 'rgba(255, 255, 255, 0.2)';
              }}
              onMouseOut={(e) => {
                e.target.style.backgroundColor = 'rgba(255, 255, 255, 0.1)';
              }}
            >
              {isPaused ? 'Resume Recording' : 'Pause Recording'}
            </button>
          )}

          {(liveTranscript || medicalReport) && !session && (
            <button
              onClick={clearTranscript}
              style={{
                width: '100%',
                padding: '12px 18px',
                borderRadius: '10px',
                fontWeight: '600',
                fontSize: '14px',
                border: '2px solid rgba(255, 255, 255, 0.3)',
                cursor: 'pointer',
                backgroundColor: 'rgba(255, 255, 255, 0.1)',
                color: 'white',
                transition: 'all 0.2s',
                marginBottom: '12px'
              }}
              onMouseOver={(e) => {
                e.target.style.backgroundColor = 'rgba(255, 255, 255, 0.15)';
                e.target.style.borderColor = 'rgba(255, 255, 255, 0.5)';
              }}
              onMouseOut={(e) => {
                e.target.style.backgroundColor = 'rgba(255, 255, 255, 0.1)';
                e.target.style.borderColor = 'rgba(255, 255, 255, 0.3)';
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
                  border: '2px solid white',
                  cursor: 'pointer',
                  backgroundColor: 'rgba(255, 255, 255, 0.15)',
                  color: 'white',
                  transition: 'all 0.2s'
                }}
                onMouseOver={(e) => {
                  e.target.style.backgroundColor = 'rgba(255, 255, 255, 0.25)';
                }}
                onMouseOut={(e) => {
                  e.target.style.backgroundColor = 'rgba(255, 255, 255, 0.15)';
                }}
              >
                Download TXT
              </button>
            </div>
          )}

          <div style={{
            marginTop: '24px',
            padding: '18px',
            backgroundColor: 'rgba(255, 255, 255, 0.1)',
            borderRadius: '12px',
            border: '1px solid rgba(255, 255, 255, 0.2)'
          }}>
            <h3 style={{
              fontWeight: '600',
              color: 'white',
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
              <span style={{ color: 'rgba(255, 255, 255, 0.9)', fontSize: '14px', fontWeight: '500' }}>
                {isProcessing ? 'Generating Report...' : session ? (isPaused ? 'Paused' : 'Recording...') : 'Ready'}
              </span>
            </div>
            {session && (
              <div style={{
                color: 'rgba(255, 255, 255, 0.8)',
                fontSize: '12px',
                padding: '8px 12px',
                backgroundColor: 'rgba(255, 255, 255, 0.1)',
                borderRadius: '6px',
                border: '1px solid rgba(255, 255, 255, 0.2)'
              }}>
                <strong>Session:</strong> #{session.id}
              </div>
            )}
          </div>
        </div>

        <div style={{
          padding: '16px 24px',
          borderTop: '1px solid rgba(255, 255, 255, 0.2)',
          backgroundColor: 'rgba(0, 0, 0, 0.1)',
          fontSize: '11px',
          color: 'rgba(255, 255, 255, 0.7)',
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
        background: 'linear-gradient(180deg, #364A7D 0%, #497F86 100%)'
      }}>
        <div style={{
          backgroundColor: 'rgba(255, 255, 255, 0.95)',
          boxShadow: '0 1px 3px rgba(0,0,0,0.08)',
          borderBottom: '1px solid rgba(255, 255, 255, 0.2)',
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
          backgroundColor: 'rgba(255, 255, 255, 0.05)'
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
                {liveTranscript}
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