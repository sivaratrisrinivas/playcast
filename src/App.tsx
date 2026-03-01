import React, { useState, useEffect, useRef } from 'react';
import { Volume2, VolumeX, Play, Square, Library, ArrowLeft, Download } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { ElevenLabsClient } from 'elevenlabs';
import { GoogleGenAI } from '@google/genai';
import { saveGame, getGames, SavedGame } from './lib/db';

const elevenlabs = new ElevenLabsClient({ apiKey: import.meta.env.VITE_ELEVENLABS_API_KEY || process.env.ELEVENLABS_API_KEY });
const ai = new GoogleGenAI({ apiKey: import.meta.env.VITE_GEMINI_API_KEY || process.env.GEMINI_API_KEY });

type CommentaryLine = {
  id: string;
  timestamp: string;
  relativeTimeSec: number;
  text: string;
};

type Highlight = {
  time: number;
  text: string;
};

export default function App() {
  const [appState, setAppState] = useState<'setup' | 'live' | 'postgame' | 'library'>('setup');
  const [eventDescription, setEventDescription] = useState('Detecting Game...');
  const [wsUrl] = useState('wss://vision-commentator-549305467378.us-central1.run.app/ws');
  const [voiceId] = useState('21m00Tcm4TlvDq8ikWAM');

  const [isConnected, setIsConnected] = useState(false);
  const [volume, setVolume] = useState(1);
  
  const [commentaryFeed, setCommentaryFeed] = useState<CommentaryLine[]>([]);
  const [mediaStream, setMediaStream] = useState<MediaStream | null>(null);
  
  const [recordedVideoUrl, setRecordedVideoUrl] = useState<string | null>(null);
  const [summaryText, setSummaryText] = useState<string | null>(null);
  const [highlights, setHighlights] = useState<Highlight[]>([]);
  const [savedGames, setSavedGames] = useState<SavedGame[]>([]);
  const [elapsedTime, setElapsedTime] = useState(0);

  const wsRef = useRef<WebSocket | null>(null);
  const feedEndRef = useRef<HTMLDivElement>(null);
  const audioQueueRef = useRef<string[]>([]);
  const isPlayingAudioRef = useRef(false);
  
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const postGameVideoRef = useRef<HTMLVideoElement>(null);
  const frameIntervalRef = useRef<number | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  const gameStartTimeRef = useRef<number>(0);

  const currentAudioRef = useRef<HTMLAudioElement | null>(null);
  const currentBufferSourceRef = useRef<AudioBufferSourceNode | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const audioDestRef = useRef<MediaStreamAudioDestinationNode | null>(null);
  const gainNodeRef = useRef<GainNode | null>(null);

  useEffect(() => {
    if (feedEndRef.current) {
      feedEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [commentaryFeed]);

  useEffect(() => {
    return () => {
      // Pure cleanup, no state changes
      if (frameIntervalRef.current) clearInterval(frameIntervalRef.current);
      if (wsRef.current) wsRef.current.close();
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        mediaRecorderRef.current.stop();
      }
      stopAllAudio();
      if (audioCtxRef.current) audioCtxRef.current.close();
    };
  }, []);

  useEffect(() => {
    let interval: number;
    if (appState === 'live') {
      setElapsedTime(0);
      interval = window.setInterval(() => {
        setElapsedTime(prev => prev + 1);
      }, 1000);
    }
    return () => clearInterval(interval);
  }, [appState]);

  useEffect(() => {
    if (elapsedTime >= 600 && appState === 'live') { // 10 minutes max
      endGame();
    }
  }, [elapsedTime, appState]);

  const formatDuration = (seconds: number) => {
    const m = Math.floor(seconds / 60).toString().padStart(2, '0');
    const s = (seconds % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
  };

  const stopAllAudio = () => {
    audioQueueRef.current = [];
    isPlayingAudioRef.current = false;
    if (currentAudioRef.current) {
      currentAudioRef.current.pause();
      currentAudioRef.current.currentTime = 0;
      currentAudioRef.current = null;
    }
    if (currentBufferSourceRef.current) {
      try { currentBufferSourceRef.current.stop(); } catch(e) {}
      currentBufferSourceRef.current.disconnect();
      currentBufferSourceRef.current = null;
    }
  };

  const playSingleAudio = async (text: string) => {
    stopAllAudio();
    isPlayingAudioRef.current = true;
    try {
      const audioStream = await elevenlabs.textToSpeech.convert(voiceId, {
        text,
        model_id: "eleven_turbo_v2_5",
        output_format: "mp3_44100_128",
      });
      const chunks: Uint8Array[] = [];
      for await (const chunk of audioStream) chunks.push(chunk);
      
      if (!isPlayingAudioRef.current) return; // Abort if stopped during fetch
      
      const blob = new Blob(chunks, { type: 'audio/mpeg' });
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audio.volume = volume;
      currentAudioRef.current = audio;
      
      audio.onended = () => {
        isPlayingAudioRef.current = false;
      };
      
      await audio.play();
    } catch (err) {
      console.error("TTS Error:", err);
      isPlayingAudioRef.current = false;
    }
  };

  useEffect(() => {
    if (gainNodeRef.current) {
      gainNodeRef.current.gain.value = volume;
    }
    if (currentAudioRef.current) {
      currentAudioRef.current.volume = volume;
    }
  }, [volume]);

  useEffect(() => {
    if (appState === 'live' && videoRef.current && mediaStream) {
      videoRef.current.srcObject = mediaStream;
    }
  }, [appState, mediaStream]);

  const loadLibrary = async () => {
    const games = await getGames();
    setSavedGames(games);
    setAppState('library');
  };

  const startCamera = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ 
        video: { facingMode: "environment" }, 
        audio: true 
      });
      setMediaStream(stream);

      // Setup Audio Mixer to embed AI commentary into the video recording
      let audioCtx = audioCtxRef.current;
      if (!audioCtx) {
        const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
        audioCtx = new AudioContextClass();
        audioCtxRef.current = audioCtx;
      }

      const dest = audioCtx.createMediaStreamDestination();
      audioDestRef.current = dest;

      const gainNode = audioCtx.createGain();
      gainNode.gain.value = volume;
      gainNode.connect(audioCtx.destination);
      gainNodeRef.current = gainNode;

      if (stream.getAudioTracks().length > 0) {
        const micSource = audioCtx.createMediaStreamSource(stream);
        micSource.connect(dest);
      }

      const combinedStream = new MediaStream([
        ...stream.getVideoTracks(),
        ...dest.stream.getAudioTracks()
      ]);

      let mimeType = 'video/webm';
      if (!MediaRecorder.isTypeSupported(mimeType)) {
        mimeType = 'video/mp4';
      }
      const recorder = new MediaRecorder(combinedStream, { mimeType });
      recordedChunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) recordedChunksRef.current.push(e.data);
      };
      mediaRecorderRef.current = recorder;
    } catch (err) {
      console.error("Error accessing camera:", err);
      alert("Could not access camera. Please allow camera and microphone permissions.");
    }
  };

  const stopCamera = () => {
    if (mediaStream) {
      mediaStream.getTracks().forEach(track => track.stop());
      setMediaStream(null);
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
  };

  const autoDetectGame = async () => {
    if (!videoRef.current || !canvasRef.current) return;
    try {
      const video = videoRef.current;
      const canvas = canvasRef.current;
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const base64Frame = canvas.toDataURL('image/jpeg', 0.5).split(',')[1];

      const response = await ai.models.generateContent({
        model: 'gemini-3-flash-preview',
        contents: [
          { inlineData: { data: base64Frame, mimeType: 'image/jpeg' } },
          { text: "What sport or activity is happening in this image? Reply with a short, punchy title (e.g., 'Pickup Basketball', 'Tennis Match', 'Skateboarding'). If unclear, reply 'Live Event'." }
        ]
      });
      if (response.text) {
        setEventDescription(response.text.trim());
      }
    } catch (e) {
      console.error("Auto-detect failed", e);
      setEventDescription("Live Event");
    }
  };

  const connectWebSocket = async () => {
    if (!import.meta.env.VITE_ELEVENLABS_API_KEY) {
      alert("Missing ElevenLabs API Key! Please add VITE_ELEVENLABS_API_KEY to your environment variables.");
      return;
    }
    if (!wsUrl) return;
    
    try {
      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
      if (!audioCtxRef.current) {
        audioCtxRef.current = new AudioContextClass();
      }
      if (audioCtxRef.current.state === 'suspended') {
        await audioCtxRef.current.resume();
      }
    } catch (e) {
      console.error("AudioContext init failed:", e);
    }

    setAppState('live');
    setCommentaryFeed([]);
    setEventDescription("Detecting Game...");
    await startCamera();

    try {
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        console.log("[WebSocket] Connected");
        setIsConnected(true);
        gameStartTimeRef.current = Date.now();
        
        if (mediaRecorderRef.current) {
          mediaRecorderRef.current.start(1000);
        }

        // Auto-detect game after 2 seconds to let camera focus
        setTimeout(autoDetectGame, 2000);

        frameIntervalRef.current = window.setInterval(() => {
          if (videoRef.current && canvasRef.current && ws.readyState === WebSocket.OPEN) {
            const video = videoRef.current;
            const canvas = canvasRef.current;
            if (video.videoWidth > 0 && video.videoHeight > 0) {
              canvas.width = video.videoWidth;
              canvas.height = video.videoHeight;
              const ctx = canvas.getContext('2d');
              if (ctx) {
                ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
                const base64Frame = canvas.toDataURL('image/jpeg', 0.5);
                ws.send(JSON.stringify({ type: 'video_frame', frame: base64Frame }));
              }
            }
          }
        }, 1000);
      };

      ws.onmessage = async (event) => {
        try {
          const data = JSON.parse(event.data);
          const commentaryText = data.metadata?.description || data.commentary || data.text || data.message;
          
          if (commentaryText) {
            const relativeTimeSec = Math.floor((Date.now() - gameStartTimeRef.current) / 1000);
            const newLine: CommentaryLine = {
              id: Math.random().toString(36).substring(7),
              timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
              relativeTimeSec,
              text: commentaryText,
            };
            
            setCommentaryFeed(prev => [...prev, newLine]);
            
            audioQueueRef.current.push(commentaryText);
            playNextAudio();
          }
        } catch (err) {
          console.error("Failed to parse WebSocket message:", err);
        }
      };

      ws.onerror = (error) => console.error("[WebSocket] Error:", error);
      ws.onclose = () => {
        console.log("[WebSocket] Disconnected");
        setIsConnected(false);
      };
    } catch (err) {
      console.error("Error creating WebSocket:", err);
      alert("Failed to connect to WebSocket. Check the URL.");
    }
  };

  const endGame = () => {
    stopAllAudio();
    if (frameIntervalRef.current) {
      clearInterval(frameIntervalRef.current);
      frameIntervalRef.current = null;
    }
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.onstop = () => {
        const blob = new Blob(recordedChunksRef.current, { type: mediaRecorderRef.current?.mimeType || 'video/webm' });
        generateHighlightReel(commentaryFeed, blob);
      };
      mediaRecorderRef.current.stop();
    } else {
      generateHighlightReel(commentaryFeed, new Blob());
    }
    
    stopCamera();
    setIsConnected(false);
    setAppState('postgame');
  };

  const generateHighlightReel = async (feed: CommentaryLine[], videoBlob: Blob) => {
    setRecordedVideoUrl(URL.createObjectURL(videoBlob));
    setHighlights([]);

    if (feed.length === 0) {
      setSummaryText("No action recorded. It was a quiet game.");
      return;
    }
    
    setSummaryText("Analyzing game footage and generating highlights...");
    
    try {
      const transcript = feed.map(l => `[${l.relativeTimeSec}s] ${l.text}`).join('\n');
      const prompt = `You are a high-energy, veteran ESPN SportsCenter anchor. Review this live game transcript (format: [timestamp_in_seconds] commentary).
      1. Write an electrifying, punchy 2-sentence overall recap of the game's narrative and energy. Make it sound like a professional sports broadcast.
      2. Identify the 1 to 3 most jaw-dropping, crucial, or funny moments.
      Return ONLY a valid JSON object with this exact structure:
      {
        "recap": "The 2-sentence recap...",
        "highlights": [
          { "time": 12, "text": "Amazing dunk" }
        ]
      }
      Transcript:\n${transcript}`;

      const response = await ai.models.generateContent({
        model: 'gemini-3-flash-preview',
        contents: prompt,
        config: { responseMimeType: "application/json" }
      });

      const result = JSON.parse(response.text || "{}");
      const recap = result.recap || "What a game, folks!";
      const hls = result.highlights || [];

      setSummaryText(recap);
      setHighlights(hls);

      // Save to DB
      await saveGame({
        id: Date.now().toString(),
        date: Date.now(),
        title: eventDescription,
        videoBlob,
        summary: recap,
        highlights: hls
      });

      playSingleAudio(recap);

    } catch (err) {
      console.error("Highlight reel generation failed:", err);
      setSummaryText("Failed to generate highlight reel. " + err);
    }
  };

  const playNextAudio = async () => {
    if (isPlayingAudioRef.current || audioQueueRef.current.length === 0) return;
    isPlayingAudioRef.current = true;
    const textToSpeak = audioQueueRef.current.shift()!;

    try {
      const audioStream = await elevenlabs.textToSpeech.convert(voiceId, {
        text: textToSpeak,
        model_id: "eleven_turbo_v2_5",
        output_format: "mp3_44100_128",
      });

      const chunks: Uint8Array[] = [];
      for await (const chunk of audioStream) {
        chunks.push(chunk);
      }
      
      if (!isPlayingAudioRef.current) return; // Abort if stopped during fetch
      
      const blob = new Blob(chunks, { type: 'audio/mpeg' });

      if (audioCtxRef.current && audioDestRef.current && gainNodeRef.current) {
        const arrayBuffer = await blob.arrayBuffer();
        const audioBuffer = await audioCtxRef.current.decodeAudioData(arrayBuffer);
        const source = audioCtxRef.current.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(audioDestRef.current);
        source.connect(gainNodeRef.current);
        
        source.onended = () => {
          currentBufferSourceRef.current = null;
          isPlayingAudioRef.current = false;
          playNextAudio();
        };
        currentBufferSourceRef.current = source;
        source.start();
      } else {
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);
        audio.volume = volume;
        currentAudioRef.current = audio;

        audio.onended = () => {
          currentAudioRef.current = null;
          isPlayingAudioRef.current = false;
          playNextAudio();
        };
        await audio.play();
      }
    } catch (err) {
      console.error("TTS Error:", err);
      isPlayingAudioRef.current = false;
      playNextAudio();
    }
  };

  const formatTime = (seconds: number) => {
    const m = Math.floor(seconds / 60).toString().padStart(2, '0');
    const s = (seconds % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
  };

  return (
    <div className="h-screen w-full flex flex-col bg-[var(--color-bg-main)] text-[var(--color-text-main)] font-sans selection:bg-[var(--color-accent)] selection:text-white overflow-hidden">
      <canvas ref={canvasRef} className="hidden" />

      <header className="px-6 py-4 lg:px-8 lg:py-6 flex items-center justify-between z-20 shrink-0">
        <div className="flex items-center gap-3 cursor-pointer" onClick={() => setAppState('setup')}>
          <div className="w-3 h-3 rounded-full bg-[var(--color-accent)]" />
          <h1 className="font-display font-bold text-xl lg:text-2xl tracking-tight text-[var(--color-text-main)]">
            Playcast
          </h1>
        </div>
        
        <div className="flex items-center gap-6">
          {appState === 'setup' && (
            <button onClick={loadLibrary} className="flex items-center gap-2 text-[var(--color-text-muted)] hover:text-[var(--color-text-main)] transition-colors font-medium bg-white px-4 py-2 rounded-full shadow-sm border border-black/5">
              <Library className="w-4 h-4" /> Library
            </button>
          )}
        </div>
      </header>

      <main className="flex-1 flex flex-col min-h-0 relative">
        
        {appState === 'setup' && (
          <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="flex-1 flex flex-col items-center justify-center max-w-3xl mx-auto w-full px-6">
            <div className="bg-white p-8 md:p-12 rounded-[2.5rem] shadow-xl border border-black/5 w-full flex flex-col items-center text-center">
              <div className="w-20 h-20 bg-[var(--color-bg-main)] rounded-full flex items-center justify-center mb-8 shadow-inner">
                <div className="w-8 h-8 rounded-full bg-[var(--color-accent)] animate-pulse" />
              </div>
              <h2 className="text-4xl md:text-5xl font-display font-bold text-[var(--color-text-main)] mb-4">
                Ready to broadcast?
              </h2>
              <p className="text-[var(--color-text-muted)] font-medium text-lg mb-10 max-w-md">
                Mount your phone, point the camera at the action, and let the AI take over the commentary.
              </p>
              <button onClick={connectWebSocket} className="px-10 py-5 bg-[var(--color-text-main)] text-white rounded-full font-bold text-xl hover:bg-black transition-transform hover:scale-105 active:scale-95 flex items-center gap-3 shadow-2xl shadow-black/20">
                <Play className="w-6 h-6 fill-current" /> Go Live Now
              </button>
            </div>
          </motion.div>
        )}

        {appState === 'live' && (
          <div className="flex-1 flex flex-col lg:flex-row h-full min-h-0 px-4 lg:px-8 pb-4 lg:pb-8 gap-4 lg:gap-8 relative">
            
            {/* Video Section */}
            <div className="w-full lg:w-3/5 xl:w-2/3 flex flex-col relative rounded-3xl overflow-hidden bg-black shadow-2xl shrink-0 lg:shrink min-h-0 aspect-video lg:aspect-auto">
              <video ref={videoRef} autoPlay playsInline muted className="absolute inset-0 w-full h-full object-cover" />
              
              <div className="absolute inset-0 pointer-events-none border-[2px] border-white/10 rounded-3xl m-2 lg:m-4">
                <div className="absolute top-0 left-0 w-8 h-8 lg:w-12 lg:h-12 border-t-4 border-l-4 border-[var(--color-accent)] rounded-tl-xl" />
                <div className="absolute top-0 right-0 w-8 h-8 lg:w-12 lg:h-12 border-t-4 border-r-4 border-[var(--color-accent)] rounded-tr-xl" />
                <div className="absolute bottom-0 left-0 w-8 h-8 lg:w-12 lg:h-12 border-b-4 border-l-4 border-[var(--color-accent)] rounded-bl-xl" />
                <div className="absolute bottom-0 right-0 w-8 h-8 lg:w-12 lg:h-12 border-b-4 border-r-4 border-[var(--color-accent)] rounded-br-xl" />
                <motion.div animate={{ y: ['0%', '100%', '0%'] }} transition={{ duration: 3, repeat: Infinity, ease: "linear" }} className="absolute top-0 left-0 right-0 h-0.5 bg-[var(--color-accent)] shadow-[0_0_20px_var(--color-accent)] opacity-40" />
                <div className="absolute top-4 right-4 bg-red-500 text-white text-xs font-bold px-3 py-1.5 rounded-full flex items-center gap-2 shadow-lg backdrop-blur-md bg-opacity-90">
                  <div className="w-2 h-2 bg-white rounded-full animate-pulse" /> 
                  {formatDuration(elapsedTime)} / 10:00
                </div>
              </div>

              {!isConnected && (
                <div className="absolute inset-0 flex items-center justify-center bg-black/60 backdrop-blur-sm text-white z-10">
                  <div className="flex flex-col items-center gap-4">
                    <div className="w-8 h-8 border-4 border-white border-t-transparent rounded-full animate-spin" />
                    <span className="font-medium text-lg tracking-wide">Connecting to AI...</span>
                  </div>
                </div>
              )}
            </div>

            {/* Commentary Section */}
            <div className="flex-1 flex flex-col min-h-0 bg-white rounded-3xl shadow-xl border border-black/5 overflow-hidden">
              <div className="p-4 lg:p-6 border-b border-black/5 bg-white z-10 shrink-0 shadow-sm flex items-center justify-between gap-4">
                <h2 className="text-lg lg:text-2xl font-display font-bold text-[var(--color-text-main)] flex items-center gap-3 truncate">
                  {eventDescription === 'Detecting Game...' && <div className="w-4 h-4 border-2 border-[var(--color-accent)] border-t-transparent rounded-full animate-spin shrink-0" />}
                  <span className="truncate">{eventDescription}</span>
                </h2>
                
                <div className="flex items-center gap-2 shrink-0">
                  <div className="flex items-center gap-2 bg-black/5 px-3 py-2 rounded-full border border-black/5">
                    {volume === 0 ? <VolumeX className="w-4 h-4 lg:w-5 lg:h-5 text-[var(--color-text-muted)]" /> : <Volume2 className="w-4 h-4 lg:w-5 lg:h-5 text-[var(--color-text-main)]" />}
                    <input
                      type="range"
                      min="0"
                      max="1"
                      step="0.05"
                      value={volume}
                      onChange={(e) => setVolume(parseFloat(e.target.value))}
                      className="w-16 lg:w-24 h-1.5 bg-black/10 rounded-lg appearance-none cursor-pointer accent-[var(--color-accent)]"
                    />
                  </div>
                  <button 
                    onClick={endGame} 
                    className="px-4 py-2 lg:px-6 lg:py-3 bg-red-500 text-white rounded-full font-bold text-sm lg:text-base flex items-center gap-2 hover:bg-red-600 transition-transform hover:scale-105 active:scale-95 shadow-md shadow-red-500/30"
                  >
                    <Square className="w-4 h-4 fill-current" /> Stop
                  </button>
                </div>
              </div>
              
              <div className="flex-1 overflow-y-auto p-6 space-y-6 scroll-smooth">
                {commentaryFeed.length === 0 ? (
                  <div className="h-full flex flex-col items-center justify-center text-center opacity-50">
                    <Volume2 className="w-12 h-12 mb-4" />
                    <p className="text-lg font-medium">Waiting for the action to begin...</p>
                  </div>
                ) : (
                  <AnimatePresence initial={false}>
                    {commentaryFeed.map((line) => (
                      <motion.div key={line.id} initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} className="group bg-[var(--color-bg-main)] p-4 rounded-2xl border border-black/5">
                        <span className="text-xs font-bold tracking-widest uppercase text-[var(--color-accent)] mb-2 block">
                          {line.timestamp}
                        </span>
                        <p className="text-lg lg:text-xl font-medium leading-snug text-[var(--color-text-main)]">
                          {line.text}
                        </p>
                      </motion.div>
                    ))}
                    <div ref={feedEndRef} className="h-4" />
                  </AnimatePresence>
                )}
              </div>
            </div>
          </div>
        )}

        {appState === 'postgame' && (
          <div className="flex-1 overflow-y-auto px-4 lg:px-8 pb-12">
            <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} className="flex flex-col items-center max-w-5xl mx-auto w-full gap-8">
              <h2 className="text-4xl md:text-5xl font-display font-bold text-[var(--color-text-main)] text-center mt-4">
                {eventDescription} Highlights
              </h2>
              
              {recordedVideoUrl ? (
                <div className="w-full relative">
                  <video ref={postGameVideoRef} src={recordedVideoUrl} controls className="w-full rounded-3xl shadow-2xl bg-black max-h-[50vh] object-contain border border-black/5" />
                  
                  <div className="flex flex-col sm:flex-row justify-between items-center gap-4 mt-6">
                    <a href={recordedVideoUrl} download={`Broadcast-${Date.now()}.webm`} className="px-5 py-3 bg-[var(--color-text-main)] text-white rounded-xl hover:bg-black transition-all text-sm font-bold shadow-sm flex items-center gap-2 w-full sm:w-auto justify-center">
                      <Download className="w-4 h-4" /> Download Full Video
                    </a>
                  </div>

                  {highlights.length > 0 && (
                    <div className="mt-6 flex flex-wrap gap-3 justify-center">
                      {highlights.map((hl, i) => (
                        <button key={i} onClick={() => { stopAllAudio(); if (postGameVideoRef.current) { postGameVideoRef.current.currentTime = hl.time; postGameVideoRef.current.play(); } }} className="px-5 py-3 bg-white border border-black/10 rounded-xl hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] transition-all text-sm font-bold shadow-sm flex items-center gap-2">
                          <Play className="w-4 h-4" /> {formatTime(hl.time)} - {hl.text}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              ) : (
                <div className="w-full h-[40vh] rounded-3xl bg-black/5 animate-pulse flex items-center justify-center border border-black/5">
                  <span className="text-[var(--color-text-muted)] font-medium text-lg">Processing Video...</span>
                </div>
              )}

              <div className="bg-white p-8 md:p-10 rounded-3xl shadow-xl w-full border border-black/5 relative overflow-hidden">
                <div className="absolute top-0 left-0 w-1 h-full bg-[var(--color-accent)]" />
                <h3 className="text-sm font-bold uppercase tracking-widest text-[var(--color-text-muted)] mb-4 flex items-center gap-2">
                  <Volume2 className="w-4 h-4" /> AI Anchor Recap
                </h3>
                <p className="text-2xl md:text-3xl font-medium leading-relaxed tracking-tight text-[var(--color-text-main)]">
                  {summaryText}
                </p>
              </div>

              <button onClick={() => { stopAllAudio(); setAppState('setup'); }} className="px-10 py-4 mt-4 bg-[var(--color-text-main)] text-white rounded-full font-bold text-xl hover:bg-black transition-transform hover:scale-105 active:scale-95 shadow-xl shadow-black/20">
                Done
              </button>
            </motion.div>
          </div>
        )}

        {appState === 'library' && (
          <div className="flex-1 overflow-y-auto px-4 lg:px-8 pb-12">
            <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="flex flex-col max-w-5xl mx-auto w-full gap-8">
              <div className="flex items-center gap-4 mb-8 mt-4">
                <button onClick={() => { stopAllAudio(); setAppState('setup'); }} className="p-3 bg-white rounded-full shadow-sm border border-black/5 hover:bg-black/5 transition-colors">
                  <ArrowLeft className="w-6 h-6" />
                </button>
                <h2 className="text-4xl font-display font-bold text-[var(--color-text-main)]">
                  Past Games
                </h2>
              </div>

              {savedGames.length === 0 ? (
                <div className="text-center py-20 text-[var(--color-text-muted)] text-xl font-medium">
                  No games recorded yet. Go live to save your first game!
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  {savedGames.map(game => (
                    <div key={game.id} className="bg-white p-6 rounded-3xl shadow-md border border-black/5 flex flex-col gap-4">
                      <div className="flex justify-between items-start">
                        <h3 className="font-display font-bold text-xl">{game.title}</h3>
                        <span className="text-xs font-mono text-[var(--color-text-muted)] bg-black/5 px-2 py-1 rounded-md">
                          {new Date(game.date).toLocaleDateString()}
                        </span>
                      </div>
                      <p className="text-sm text-[var(--color-text-muted)] line-clamp-3">{game.summary}</p>
                      <button 
                        onClick={() => {
                          stopAllAudio();
                          setEventDescription(game.title);
                          setRecordedVideoUrl(URL.createObjectURL(game.videoBlob));
                          setSummaryText(game.summary);
                          setHighlights(game.highlights);
                          setAppState('postgame');
                          playSingleAudio(game.summary);
                        }}
                        className="mt-auto flex items-center justify-center gap-2 w-full py-3 bg-[var(--color-bg-main)] hover:bg-black/5 rounded-xl transition-colors font-medium text-sm"
                      >
                        <Play className="w-4 h-4" /> Watch Highlights
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </motion.div>
          </div>
        )}
      </main>
    </div>
  );
}
