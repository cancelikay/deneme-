import React, { useState, useEffect, useRef } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality } from '@google/genai';
import { decode, decodeAudioData, createBlob } from './utils/audioUtils';
import { AudioVisualizer } from './components/AudioVisualizer';
import { PhoneIcon, MicrophoneIcon, StopIcon, Cog6ToothIcon, UserIcon, SparklesIcon, BoltIcon, TagIcon, XMarkIcon, ServerIcon, CommandLineIcon, SpeakerWaveIcon } from '@heroicons/react/24/solid';

// Constants
const API_KEY = process.env.API_KEY;
const MODEL_NAME = 'gemini-2.5-flash-native-audio-preview-09-2025';

// Type definitions
type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error';
type VoiceOption = 'Puck' | 'Charon' | 'Kore' | 'Fenrir' | 'Zephyr' | 'Cloned';

interface LogMessage {
  id: string;
  sender: 'user' | 'agent' | 'system';
  text: string;
  timestamp: Date;
}

const VOICES = [
  { id: 'Kore', name: 'Kore', gender: 'Kadın', desc: 'Dengeli ve Sakin' },
  { id: 'Zephyr', name: 'Zephyr', gender: 'Kadın', desc: 'Yumuşak ve Yardımsever' },
  { id: 'Puck', name: 'Puck', gender: 'Erkek', desc: 'Enerjik ve Net' },
  { id: 'Fenrir', name: 'Fenrir', gender: 'Erkek', desc: 'Güçlü ve Otoriter' },
];

const App: React.FC = () => {
  // Application State
  const [connectionState, setConnectionState] = useState<ConnectionState>('disconnected');
  const [logs, setLogs] = useState<LogMessage[]>([]);
  const [isMuted, setIsMuted] = useState(false);
  
  // Caller Information State
  const [callerName, setCallerName] = useState('');
  const [callReason, setCallReason] = useState('');
  
  // SIP & Agent Configuration State
  const [showSettings, setShowSettings] = useState(false);
  const [settingsTab, setSettingsTab] = useState<'sip' | 'prompt' | 'voice'>('sip');
  
  // Voice State
  const [selectedVoice, setSelectedVoice] = useState<VoiceOption>('Kore');
  const [cloningState, setCloningState] = useState<'idle' | 'recording' | 'processing' | 'success'>('idle');
  const [hasClonedVoice, setHasClonedVoice] = useState(false);

  const [sipConfig, setSipConfig] = useState({
    server: '',
    port: '5060',
    username: '',
    password: ''
  });

  const [baseSystemInstruction, setBaseSystemInstruction] = useState(`Sen "TechCorp Çözümleri" sekreteri Aslı'sın.

KURALLAR:
1. HIZ: Cevapların ANLIK ve KISA olsun. Düşünme payı bırakma.
2. DOĞALLIK: "ııı", "şey", "hmm" gibi dolgu kelimelerini mutlaka kullan.
3. TEYİT: Kullanıcı bilgilerini hemen teyit et.
4. KESİLME: Kullanıcı konuşursa sus.`);

  // Audio Context Refs
  const inputAudioContextRef = useRef<AudioContext | null>(null);
  const outputAudioContextRef = useRef<AudioContext | null>(null);
  const inputAnalyserRef = useRef<AnalyserNode | null>(null);
  const outputAnalyserRef = useRef<AnalyserNode | null>(null);
  const nextStartTimeRef = useRef<number>(0);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  
  // Gemini Session Refs
  const sessionPromiseRef = useRef<Promise<any> | null>(null);
  const currentInputTranscriptionRef = useRef<string>('');
  const currentOutputTranscriptionRef = useRef<string>('');
  const streamRef = useRef<MediaStream | null>(null);

  // Initialize Audio Logic
  const initializeAudio = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      // Input Context (Mic -> Gemini)
      const inputCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      // CRITICAL FIX: Ensure context is resumed
      if (inputCtx.state === 'suspended') {
        await inputCtx.resume();
      }
      inputAudioContextRef.current = inputCtx;
      
      const source = inputCtx.createMediaStreamSource(stream);
      const analyser = inputCtx.createAnalyser();
      analyser.fftSize = 256;
      inputAnalyserRef.current = analyser;

      // Optimization: Reduced buffer size to 1024 for ultra-low latency.
      // 1024 samples @ 16kHz = 64ms latency per chunk.
      const scriptProcessor = inputCtx.createScriptProcessor(1024, 1, 1);
      
      scriptProcessor.onaudioprocess = (e) => {
        if (isMuted) return;
        
        // Safety check: if we are not connected/connecting, stop processing
        if (!sessionPromiseRef.current) return;

        const inputData = e.inputBuffer.getChannelData(0);
        const pcmBlob = createBlob(inputData);
        
        sessionPromiseRef.current.then((session) => {
          // Check if session is still valid/open if possible, or try/catch
          try {
            session.sendRealtimeInput({ media: pcmBlob });
          } catch (e) {
            console.error("Error sending input:", e);
          }
        }).catch(err => {
             // Session initialization failed or was cancelled
             console.warn("Session not ready or failed:", err);
        });
      };

      source.connect(analyser);
      analyser.connect(scriptProcessor);
      scriptProcessor.connect(inputCtx.destination);

      // Output Context (Gemini -> Speakers)
      const outputCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      // CRITICAL FIX: Ensure context is resumed
      if (outputCtx.state === 'suspended') {
        await outputCtx.resume();
      }
      outputAudioContextRef.current = outputCtx;
      const outAnalyser = outputCtx.createAnalyser();
      outAnalyser.fftSize = 256;
      outputAnalyserRef.current = outAnalyser;
      outAnalyser.connect(outputCtx.destination); // Master out

    } catch (err) {
      console.error("Audio initialization failed", err);
      setConnectionState('error');
      addLog('system', 'Mikrofon hatası. Lütfen izinleri kontrol edin.');
    }
  };

  const connectToGemini = async () => {
    if (!API_KEY) {
      addLog('system', 'API Key eksik. Lütfen metadata/env kontrol edin.');
      return;
    }

    setConnectionState('connecting');
    await initializeAudio();

    // Construct Dynamic System Instruction based on Form Inputs
    let taskInstruction = "";

    if (callerName || callReason) {
        taskInstruction = `
        BAĞLAM:
        Arayan: "${callerName || 'Bilinmiyor'}"
        Konu: "${callReason || 'Belirtilmedi'}"
        
        GÖREV:
        Telefonu açar açmaz bu bilgileri doğrula. 
        Örnek: "TechCorp, ben Aslı. Merhaba ${callerName}, ${callReason} için mi aramıştınız?"
        Sonra ilgili birime aktar.
        `;
    } else {
        taskInstruction = `
        GÖREV:
        Telefonu "TechCorp, ben Aslı, size nasıl yardımcı olabilirim?" diye aç.
        İsim ve neden sor, sonra aktar.
        `;
    }

    // Include SIP context in system prompt if available (Simulated)
    let sipContext = "";
    if (sipConfig.server) {
       sipContext = `\n[SİSTEM BİLGİSİ: Şu an SIP Trunk üzerinden konuşuyorsun. Server: ${sipConfig.server}]`;
    }

    const finalSystemInstruction = baseSystemInstruction + taskInstruction + sipContext;

    // Determine actual voice name for API
    // If "Cloned", we map to a specific robust voice (e.g., Fenrir) or user preference
    const apiVoiceName = selectedVoice === 'Cloned' ? 'Fenrir' : selectedVoice;

    const ai = new GoogleGenAI({ apiKey: API_KEY });

    try {
      const sessionPromise = ai.live.connect({
        model: MODEL_NAME,
        callbacks: {
          onopen: () => {
            setConnectionState('connected');
            addLog('system', 'Hızlı Bağlantı Kuruldu (Ultra Low Latency).');
            // Initial log depends on context
            if (callerName) {
                addLog('agent', `TechCorp, ben Aslı. Merhaba ${callerName}...`);
            } else {
                addLog('agent', 'TechCorp, ben Aslı, size nasıl yardımcı olabilirim?');
            }
          },
          onmessage: async (message: LiveServerMessage) => {
            // Handle Transcription
            if (message.serverContent?.outputTranscription) {
              currentOutputTranscriptionRef.current += message.serverContent.outputTranscription.text;
            } else if (message.serverContent?.inputTranscription) {
              currentInputTranscriptionRef.current += message.serverContent.inputTranscription.text;
            }

            if (message.serverContent?.turnComplete) {
              if (currentInputTranscriptionRef.current) {
                addLog('user', currentInputTranscriptionRef.current);
                currentInputTranscriptionRef.current = '';
              }
              if (currentOutputTranscriptionRef.current) {
                addLog('agent', currentOutputTranscriptionRef.current);
                currentOutputTranscriptionRef.current = '';
              }
            }

            // Handle Audio Output
            const base64Audio = message.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
            if (base64Audio && outputAudioContextRef.current && outputAnalyserRef.current) {
               const ctx = outputAudioContextRef.current;
               
               // Sync time logic
               nextStartTimeRef.current = Math.max(nextStartTimeRef.current, ctx.currentTime);
               
               const audioBuffer = await decodeAudioData(
                 decode(base64Audio),
                 ctx,
                 24000,
                 1
               );

               const source = ctx.createBufferSource();
               source.buffer = audioBuffer;
               source.connect(outputAnalyserRef.current); // Connect to analyser (which connects to dest)
               
               source.addEventListener('ended', () => {
                 sourcesRef.current.delete(source);
               });

               source.start(nextStartTimeRef.current);
               nextStartTimeRef.current += audioBuffer.duration;
               sourcesRef.current.add(source);
            }

            // Handle Interruptions
            if (message.serverContent?.interrupted) {
              console.log("Interruption detected - clearing audio queue");
              sourcesRef.current.forEach(source => {
                try { source.stop(); } catch(e) {}
              });
              sourcesRef.current.clear();
              nextStartTimeRef.current = 0;
            }
          },
          onclose: () => {
            console.log("Session closed from server");
            setConnectionState('disconnected');
            addLog('system', 'Bağlantı kesildi.');
          },
          onerror: (err) => {
            console.error("Session error:", err);
            setConnectionState('error');
            addLog('system', 'Bağlantı hatası oluştu.');
          }
        },
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: apiVoiceName } }
          },
          systemInstruction: finalSystemInstruction,
          thinkingConfig: { thinkingBudget: 0 },
          inputAudioTranscription: {},
          outputAudioTranscription: {},
        }
      });

      sessionPromiseRef.current = sessionPromise;

    } catch (error) {
      console.error("Connection failed", error);
      setConnectionState('error');
      addLog('system', 'Bağlantı başlatılamadı: ' + String(error));
    }
  };

  const disconnect = () => {
    // 1. Clear session promise immediately to stop onaudioprocess sending data
    sessionPromiseRef.current = null;

    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
    }
    if (inputAudioContextRef.current) {
      inputAudioContextRef.current.close();
      inputAudioContextRef.current = null;
    }
    if (outputAudioContextRef.current) {
      outputAudioContextRef.current.close();
      outputAudioContextRef.current = null;
    }
    
    setConnectionState('disconnected');
    setLogs([]);
    currentInputTranscriptionRef.current = '';
    currentOutputTranscriptionRef.current = '';
    nextStartTimeRef.current = 0;
    sourcesRef.current.clear();
  };

  const addLog = (sender: 'user' | 'agent' | 'system', text: string) => {
    setLogs(prev => [...prev, {
      id: Math.random().toString(36).substring(7),
      sender,
      text,
      timestamp: new Date()
    }]);
  };

  // Mock Voice Cloning Function
  const handleVoiceCloning = () => {
     setCloningState('recording');
     // Simulate recording for 3 seconds
     setTimeout(() => {
        setCloningState('processing');
        // Simulate processing for 2 seconds
        setTimeout(() => {
            setCloningState('success');
            setHasClonedVoice(true);
            setSelectedVoice('Cloned');
        }, 2000);
     }, 3000);
  };

  // Scroll to bottom of logs
  const logsEndRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);


  return (
    <div className="min-h-screen bg-slate-900 text-slate-100 p-4 md:p-8 font-sans">
      <div className="max-w-6xl mx-auto grid grid-cols-1 lg:grid-cols-3 gap-6 h-[85vh]">
        
        {/* LEFT PANEL: Control & Visuals */}
        <div className="lg:col-span-2 flex flex-col gap-6">
          
          {/* Header Card */}
          <div className="bg-slate-800 rounded-2xl p-6 shadow-xl border border-slate-700 relative overflow-hidden">
             <div className="absolute top-0 right-0 p-4 opacity-10">
                <SparklesIcon className="w-32 h-32 text-blue-400" />
             </div>

             {/* Settings Button */}
             <button 
               onClick={() => setShowSettings(true)}
               className="absolute top-6 right-6 p-2 bg-slate-700/50 hover:bg-slate-700 rounded-lg text-slate-300 transition-colors z-10"
               title="Ayarlar (SIP & Sistem)"
             >
               <Cog6ToothIcon className="w-5 h-5" />
             </button>

             <h1 className="text-2xl font-bold mb-2 flex items-center gap-2">
               <span className="bg-blue-600 p-2 rounded-lg"><PhoneIcon className="w-6 h-6 text-white"/></span>
               SIP Trunk Asistanı
             </h1>
             <p className="text-slate-400 mb-6 flex items-center gap-2">
               <BoltIcon className="w-4 h-4 text-yellow-400" />
               Ultra düşük gecikmeli, gerçekçi yapay zeka resepsiyonist.
             </p>

             {/* Caller Information Form */}
             <div className="bg-slate-900/50 rounded-xl p-4 mb-6 border border-slate-700 space-y-3">
               <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider flex items-center gap-2">
                 <TagIcon className="w-4 h-4" /> Arama Bağlamı (Opsiyonel)
               </h3>
               <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                 <div className="space-y-1">
                   <label className="text-xs text-slate-400 ml-1">Arayan Adı</label>
                   <div className="relative">
                     <UserIcon className="w-5 h-5 absolute left-3 top-2.5 text-slate-500" />
                     <input 
                       type="text"
                       disabled={connectionState !== 'disconnected'}
                       value={callerName}
                       onChange={(e) => setCallerName(e.target.value)}
                       placeholder="Örn: Ahmet Yılmaz"
                       className="w-full bg-slate-800 border border-slate-600 text-sm rounded-lg pl-10 pr-3 py-2.5 focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none disabled:opacity-50 transition-all placeholder:text-slate-600"
                     />
                   </div>
                 </div>
                 <div className="space-y-1">
                   <label className="text-xs text-slate-400 ml-1">Arama Nedeni</label>
                   <div className="relative">
                     <TagIcon className="w-5 h-5 absolute left-3 top-2.5 text-slate-500" />
                     <input 
                       type="text"
                       disabled={connectionState !== 'disconnected'}
                       value={callReason}
                       onChange={(e) => setCallReason(e.target.value)}
                       placeholder="Örn: Fatura İtirazı"
                       className="w-full bg-slate-800 border border-slate-600 text-sm rounded-lg pl-10 pr-3 py-2.5 focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none disabled:opacity-50 transition-all placeholder:text-slate-600"
                     />
                   </div>
                 </div>
               </div>
             </div>

             <div className="flex gap-4 items-center">
               {connectionState === 'disconnected' || connectionState === 'error' ? (
                 <button 
                   onClick={connectToGemini}
                   className="flex items-center gap-2 bg-green-600 hover:bg-green-500 text-white px-8 py-3 rounded-xl font-semibold transition-all shadow-lg shadow-green-900/50 hover:scale-105 active:scale-95"
                 >
                   <PhoneIcon className="w-5 h-5" />
                   Çağrıyı Başlat
                 </button>
               ) : (
                 <button 
                   onClick={disconnect}
                   className="flex items-center gap-2 bg-red-600 hover:bg-red-500 text-white px-8 py-3 rounded-xl font-semibold transition-all shadow-lg shadow-red-900/50 hover:scale-105 active:scale-95"
                 >
                   <StopIcon className="w-5 h-5" />
                   Çağrıyı Sonlandır
                 </button>
               )}
               
               <div className="flex items-center gap-2 px-4 py-2 bg-slate-900/50 rounded-lg border border-slate-700">
                  <div className={`w-3 h-3 rounded-full ${connectionState === 'connected' ? 'bg-green-500 animate-pulse' : connectionState === 'connecting' ? 'bg-yellow-500 animate-bounce' : 'bg-red-500'}`}></div>
                  <span className="text-sm font-medium uppercase tracking-wider text-slate-400">
                    {connectionState === 'connected' ? 'HAT AÇIK' : connectionState === 'connecting' ? 'BAĞLANIYOR...' : 'HAT KAPALI'}
                  </span>
               </div>
             </div>
          </div>

          {/* Visualization Card */}
          <div className="bg-slate-800 rounded-2xl p-6 shadow-xl border border-slate-700 flex-1 flex flex-col justify-center items-center relative min-h-[250px]">
            <div className="absolute top-4 left-4 text-xs font-mono text-slate-500 flex items-center gap-2">
              CANLI SES ANALİZİ (PCM 16kHz)
              {connectionState === 'connected' && <span className="text-green-500 bg-green-900/30 px-1 rounded text-[10px] border border-green-800">ULTRA LOW LATENCY (64ms)</span>}
            </div>
            
            <div className="w-full space-y-8">
               {/* User Mic Visualizer */}
               <div className="relative">
                  <div className="flex items-center gap-2 mb-2 text-blue-400 text-sm font-bold tracking-widest">
                    <MicrophoneIcon className="w-4 h-4" /> ARAYAN {callerName ? `(${callerName})` : '(SİZ)'}
                  </div>
                  <div className="h-20 bg-slate-900/50 rounded-xl border border-slate-700 overflow-hidden flex items-center justify-center">
                     {connectionState === 'connected' ? (
                       <AudioVisualizer analyser={inputAnalyserRef.current} isActive={true} color="#60a5fa" />
                     ) : (
                       <div className="text-slate-600 text-sm">Sinyal bekleniyor...</div>
                     )}
                  </div>
               </div>

               {/* Agent Visualizer */}
               <div className="relative">
                  <div className="flex items-center gap-2 mb-2 text-purple-400 text-sm font-bold tracking-widest">
                    <SparklesIcon className="w-4 h-4" /> ASLI (AI ASİSTAN)
                  </div>
                  <div className="h-20 bg-slate-900/50 rounded-xl border border-slate-700 overflow-hidden flex items-center justify-center">
                     {connectionState === 'connected' ? (
                        <AudioVisualizer analyser={outputAnalyserRef.current} isActive={true} color="#c084fc" />
                     ) : (
                        <div className="text-slate-600 text-sm">Sinyal bekleniyor...</div>
                     )}
                  </div>
               </div>
            </div>
          </div>
        </div>

        {/* RIGHT PANEL: Live Transcription Log */}
        <div className="bg-slate-800 rounded-2xl shadow-xl border border-slate-700 flex flex-col overflow-hidden h-full">
          <div className="p-4 bg-slate-700/50 border-b border-slate-700 flex justify-between items-center">
            <h2 className="font-semibold flex items-center gap-2">
              <Cog6ToothIcon className="w-5 h-5 text-slate-400"/>
              Çağrı Kaydı (Transkript)
            </h2>
            <span className="text-xs bg-slate-600 px-2 py-1 rounded text-slate-200">Canlı</span>
          </div>
          
          <div className="flex-1 overflow-y-auto p-4 space-y-4 bg-slate-900/30">
            {logs.length === 0 && (
              <div className="text-center text-slate-500 mt-10 italic">
                Çağrı başlatıldığında konuşmalar burada görünecek.
              </div>
            )}
            
            {logs.map((log) => (
              <div key={log.id} className={`flex flex-col ${log.sender === 'user' ? 'items-end' : log.sender === 'agent' ? 'items-start' : 'items-center'}`}>
                <div className={`
                  max-w-[85%] p-3 rounded-lg text-sm leading-relaxed shadow-md
                  ${log.sender === 'user' ? 'bg-blue-600 text-white rounded-br-none' : 
                    log.sender === 'agent' ? 'bg-purple-600 text-white rounded-bl-none' : 
                    'bg-slate-700 text-slate-300 text-xs py-1 px-3 rounded-full border border-slate-600'}
                `}>
                  {log.sender === 'agent' && <div className="text-xs text-purple-200 font-bold mb-1 opacity-75">Aslı (AI)</div>}
                  {log.sender === 'user' && <div className="text-xs text-blue-200 font-bold mb-1 opacity-75 text-right">{callerName || 'Müşteri'}</div>}
                  {log.text}
                </div>
                <div className="text-[10px] text-slate-500 mt-1 px-1">
                  {log.timestamp.toLocaleTimeString()}
                </div>
              </div>
            ))}
            <div ref={logsEndRef} />
          </div>

          {/* Footer Controls */}
          <div className="p-4 bg-slate-800 border-t border-slate-700">
             <div className="flex items-center justify-between text-xs text-slate-400">
                <span>Model: Gemini 2.5 Flash Native Audio</span>
                <span className="flex items-center gap-1">
                   <span className="w-2 h-2 rounded-full bg-green-500"></span> 
                   <span className="text-green-400 font-mono">~64ms Input Latency</span>
                </span>
             </div>
          </div>
        </div>
      </div>

      {/* SETTINGS MODAL */}
      {showSettings && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-fade-in">
          <div className="bg-slate-800 rounded-2xl border border-slate-700 w-full max-w-lg shadow-2xl relative flex flex-col overflow-hidden max-h-[90vh]">
            
            {/* Modal Header */}
            <div className="p-4 border-b border-slate-700 flex justify-between items-center bg-slate-900/50">
              <h2 className="font-bold text-lg flex items-center gap-2">
                <Cog6ToothIcon className="w-5 h-5 text-slate-400" />
                Sistem Ayarları
              </h2>
              <button 
                onClick={() => setShowSettings(false)}
                className="p-1 hover:bg-slate-700 rounded-full transition-colors text-slate-400"
              >
                <XMarkIcon className="w-6 h-6" />
              </button>
            </div>

            {/* Navigation Tabs */}
            <div className="flex border-b border-slate-700 bg-slate-800/50">
               <button 
                 onClick={() => setSettingsTab('sip')}
                 className={`flex-1 py-3 text-sm font-medium border-b-2 transition-colors flex items-center justify-center gap-2 ${settingsTab === 'sip' ? 'border-blue-500 text-blue-400 bg-blue-500/5' : 'border-transparent text-slate-400 hover:text-slate-200'}`}
               >
                 <ServerIcon className="w-4 h-4" /> SIP Trunk
               </button>
               <button 
                 onClick={() => setSettingsTab('voice')}
                 className={`flex-1 py-3 text-sm font-medium border-b-2 transition-colors flex items-center justify-center gap-2 ${settingsTab === 'voice' ? 'border-green-500 text-green-400 bg-green-500/5' : 'border-transparent text-slate-400 hover:text-slate-200'}`}
               >
                 <SpeakerWaveIcon className="w-4 h-4" /> Ses Seçimi
               </button>
               <button 
                 onClick={() => setSettingsTab('prompt')}
                 className={`flex-1 py-3 text-sm font-medium border-b-2 transition-colors flex items-center justify-center gap-2 ${settingsTab === 'prompt' ? 'border-purple-500 text-purple-400 bg-purple-500/5' : 'border-transparent text-slate-400 hover:text-slate-200'}`}
               >
                 <CommandLineIcon className="w-4 h-4" /> Davranış
               </button>
            </div>

            {/* Modal Body */}
            <div className="p-6 overflow-y-auto">
              
              {/* TAB: SIP SETTINGS */}
              {settingsTab === 'sip' && (
                <div className="space-y-4 animate-fade-in">
                  <div className="space-y-1">
                    <label className="text-xs text-slate-400 font-semibold uppercase">SIP Server / Domain</label>
                    <input 
                      type="text"
                      value={sipConfig.server}
                      onChange={(e) => setSipConfig({...sipConfig, server: e.target.value})}
                      placeholder="sip.provider.com"
                      className="w-full bg-slate-900 border border-slate-600 text-sm rounded-lg px-3 py-2 focus:ring-2 focus:ring-blue-500 outline-none text-slate-200"
                    />
                  </div>

                  <div className="grid grid-cols-3 gap-4">
                     <div className="space-y-1 col-span-2">
                        <label className="text-xs text-slate-400 font-semibold uppercase">Kullanıcı Adı (Ext)</label>
                        <input 
                          type="text"
                          value={sipConfig.username}
                          onChange={(e) => setSipConfig({...sipConfig, username: e.target.value})}
                          placeholder="1001"
                          className="w-full bg-slate-900 border border-slate-600 text-sm rounded-lg px-3 py-2 focus:ring-2 focus:ring-blue-500 outline-none text-slate-200"
                        />
                     </div>
                     <div className="space-y-1">
                        <label className="text-xs text-slate-400 font-semibold uppercase">Port</label>
                        <input 
                          type="text"
                          value={sipConfig.port}
                          onChange={(e) => setSipConfig({...sipConfig, port: e.target.value})}
                          placeholder="5060"
                          className="w-full bg-slate-900 border border-slate-600 text-sm rounded-lg px-3 py-2 focus:ring-2 focus:ring-blue-500 outline-none text-slate-200"
                        />
                     </div>
                  </div>

                  <div className="space-y-1">
                    <label className="text-xs text-slate-400 font-semibold uppercase">Şifre / Secret</label>
                    <input 
                      type="password"
                      value={sipConfig.password}
                      onChange={(e) => setSipConfig({...sipConfig, password: e.target.value})}
                      placeholder="••••••••"
                      className="w-full bg-slate-900 border border-slate-600 text-sm rounded-lg px-3 py-2 focus:ring-2 focus:ring-blue-500 outline-none text-slate-200"
                    />
                  </div>
                  
                  <div className="pt-2">
                     <div className="p-3 bg-blue-900/20 border border-blue-900/50 rounded-lg text-xs text-blue-300">
                        <span className="font-bold block mb-1">Bilgi:</span>
                        Bu ayarlar simülasyon amaçlıdır. Gerçek SIP bağlantısı için WebRTC/SIP ağ geçidi gerekir.
                     </div>
                  </div>
                </div>
              )}

              {/* TAB: VOICE SELECTION */}
              {settingsTab === 'voice' && (
                <div className="space-y-6 animate-fade-in">
                  
                  {/* Voice List */}
                  <div>
                    <label className="text-xs text-slate-400 font-semibold uppercase mb-3 block">Hazır Ses Modelleri</label>
                    <div className="grid grid-cols-2 gap-3">
                        {VOICES.map((v) => (
                           <button 
                             key={v.id}
                             onClick={() => setSelectedVoice(v.id as VoiceOption)}
                             className={`p-3 rounded-xl border text-left transition-all relative overflow-hidden group ${selectedVoice === v.id ? 'bg-green-600/20 border-green-500 ring-1 ring-green-500' : 'bg-slate-800 border-slate-600 hover:bg-slate-750 hover:border-slate-500'}`}
                           >
                              <div className="text-sm font-bold text-slate-200">{v.name}</div>
                              <div className="text-xs text-slate-400 mt-1">{v.gender} • {v.desc}</div>
                              {selectedVoice === v.id && (
                                <div className="absolute top-2 right-2 w-2 h-2 bg-green-500 rounded-full shadow-[0_0_10px_rgba(34,197,94,0.8)]"></div>
                              )}
                           </button>
                        ))}
                    </div>
                  </div>

                  {/* Cloning Section */}
                  <div className="border-t border-slate-700 pt-6">
                    <label className="text-xs text-slate-400 font-semibold uppercase mb-3 flex items-center gap-2">
                        <SparklesIcon className="w-4 h-4 text-purple-400"/>
                        Ses Klonlama (Deneysel)
                    </label>
                    
                    {!hasClonedVoice ? (
                        <div className="bg-slate-900/50 rounded-xl p-4 border border-slate-700 flex flex-col items-center justify-center text-center space-y-4">
                           {cloningState === 'idle' && (
                             <>
                                <p className="text-sm text-slate-400">
                                   Kendi sesinizi klonlamak için aşağıdaki butona basarak 3 saniye boyunca konuşun. Sistem ses karakteristiğinizi analiz edecektir.
                                </p>
                                <button 
                                  onClick={handleVoiceCloning}
                                  className="flex items-center gap-2 bg-slate-700 hover:bg-slate-600 text-white px-6 py-3 rounded-full font-semibold transition-all hover:scale-105"
                                >
                                  <MicrophoneIcon className="w-5 h-5 text-red-500" />
                                  Kayıt Başlat & Klonla
                                </button>
                             </>
                           )}

                           {cloningState === 'recording' && (
                             <div className="flex flex-col items-center animate-pulse">
                                <div className="w-16 h-16 rounded-full bg-red-500/20 flex items-center justify-center mb-3 border border-red-500">
                                   <MicrophoneIcon className="w-8 h-8 text-red-500" />
                                </div>
                                <span className="text-red-400 font-mono text-sm">Ses örneği alınıyor...</span>
                             </div>
                           )}

                           {cloningState === 'processing' && (
                             <div className="flex flex-col items-center">
                                <div className="w-full max-w-[200px] h-1 bg-slate-700 rounded-full overflow-hidden mb-3">
                                   <div className="h-full bg-purple-500 animate-[width_2s_ease-in-out_infinite] w-1/2"></div>
                                </div>
                                <span className="text-purple-400 font-mono text-sm">Spektral analiz yapılıyor...</span>
                             </div>
                           )}
                        </div>
                    ) : (
                        <button 
                           onClick={() => setSelectedVoice('Cloned')}
                           className={`w-full p-4 rounded-xl border text-left transition-all relative overflow-hidden flex items-center gap-4 ${selectedVoice === 'Cloned' ? 'bg-purple-600/20 border-purple-500 ring-1 ring-purple-500' : 'bg-slate-800 border-slate-600 hover:bg-slate-750'}`}
                        >
                           <div className="w-12 h-12 rounded-full bg-purple-500/20 flex items-center justify-center border border-purple-500/50">
                              <UserIcon className="w-6 h-6 text-purple-400" />
                           </div>
                           <div>
                              <div className="text-sm font-bold text-slate-200">Klonlanmış Sesim</div>
                              <div className="text-xs text-slate-400 mt-1">Özel Profil • Oluşturuldu</div>
                           </div>
                           {selectedVoice === 'Cloned' && (
                             <div className="absolute top-4 right-4 w-3 h-3 bg-purple-500 rounded-full shadow-[0_0_15px_rgba(168,85,247,0.8)]"></div>
                           )}
                        </button>
                    )}
                  </div>
                </div>
              )}

              {/* TAB: AGENT PROMPT */}
              {settingsTab === 'prompt' && (
                <div className="space-y-4 animate-fade-in h-full flex flex-col">
                  <div className="space-y-1 flex-1 flex flex-col">
                    <div className="flex justify-between items-center">
                        <label className="text-xs text-slate-400 font-semibold uppercase">Sistem Talimatı (Prompt)</label>
                        <span className="text-[10px] text-slate-500 bg-slate-800 px-2 py-0.5 rounded border border-slate-700">Base Instruction</span>
                    </div>
                    <p className="text-xs text-slate-500 mb-2">
                        Agent'ın kişiliğini, konuşma tarzını ve genel kurallarını buradan düzenleyebilirsiniz. Hız ve gerçekçilik kurallarını korumanız önerilir.
                    </p>
                    <textarea 
                      value={baseSystemInstruction}
                      onChange={(e) => setBaseSystemInstruction(e.target.value)}
                      placeholder="Agent sistem talimatlarını buraya girin..."
                      className="w-full h-64 bg-slate-900 border border-slate-600 text-sm font-mono rounded-lg px-3 py-2 focus:ring-2 focus:ring-purple-500 outline-none text-slate-200 resize-none"
                    />
                  </div>
                   <div className="p-3 bg-purple-900/20 border border-purple-900/50 rounded-lg text-xs text-purple-300">
                      <span className="font-bold block mb-1">Dinamik İçerik:</span>
                      Arayan ismi ve arama nedeni gibi dinamik bilgiler, çağrı başladığında bu talimatın sonuna otomatik olarak eklenir.
                   </div>
                </div>
              )}

            </div>

            {/* Modal Footer */}
            <div className="p-4 border-t border-slate-700 bg-slate-900/50 flex justify-end gap-3">
               <button 
                 onClick={() => setShowSettings(false)}
                 className="px-4 py-2 text-sm text-slate-300 hover:text-white hover:bg-slate-800 rounded-lg transition-colors"
               >
                 Kapat
               </button>
               <button 
                 onClick={() => setShowSettings(false)}
                 className="px-6 py-2 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded-lg font-semibold shadow-lg shadow-blue-900/30 transition-all active:scale-95"
               >
                 Kaydet ve Kapat
               </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default App;