import React, { useEffect, useRef, useState } from "react";
import {
  ExternalLink,
  Mic,
  MicOff,
  RotateCcw,
  Square,
  Volume2,
} from "lucide-react";

const API_BASE_URL =
  import.meta.env.VITE_API_URL ||
  (import.meta.env.MODE === "development" ? "http://localhost:8080/api" : "/api");

const Home = () => {
  const [status, setStatus] = useState("Press Speak and say a command");
  const [spokenText, setSpokenText] = useState("");
  const [assistantText, setAssistantText] = useState(
    "Say things like open YouTube, search music on YouTube, or what time is it.",
  );
  const [isListening, setIsListening] = useState(false);
  const [wakeMode, setWakeMode] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [actionUrl, setActionUrl] = useState("");
  const [voiceSupported, setVoiceSupported] = useState(true);

  const recognitionRef = useRef(null);
  const abortRef = useRef(null);
  const finalTranscriptRef = useRef("");
  const silenceTimerRef = useRef(null);
  const lastAssistantTextRef = useRef(assistantText);
  const wakeModeRef = useRef(false);
  const isProcessingRef = useRef(false);
  const awaitingCommandRef = useRef(false);
  const shouldRestartWakeRef = useRef(false);
  const speechRunRef = useRef(0);

  useEffect(() => {
    lastAssistantTextRef.current = assistantText;
  }, [assistantText]);

  useEffect(() => {
    wakeModeRef.current = wakeMode;
  }, [wakeMode]);

  useEffect(() => {
    isProcessingRef.current = isProcessing;
  }, [isProcessing]);

  useEffect(() => {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      setVoiceSupported(false);
      setStatus("Speech recognition is not supported in this browser");
      return;
    }

    const recognition = new SpeechRecognition();
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.lang = "en-US";

    recognition.onstart = () => {
      setIsListening(true);
      setStatus(wakeModeRef.current ? "Wake mode active. Say hey buddy." : "Listening now");
      if (!wakeModeRef.current) speak("Listening.");
    };

    recognition.onresult = (event) => {
      const results = Array.from(event.results);
      const transcript = results
        .map((result) => result[0].transcript)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();

      const finalTranscript = results
        .filter((result) => result.isFinal)
        .map((result) => result[0].transcript)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      const hasFinal = Boolean(finalTranscript);
      const lowerTranscript = transcript.toLowerCase();
      const wakeMatch = lowerTranscript.match(/\b(hey|hi|hello)\s+buddy\b/);

      setSpokenText(transcript);

      if (!hasFinal) {
        setStatus(wakeModeRef.current ? "Listening for hey buddy." : "Listening...");
        return;
      }

      if (wakeModeRef.current && !wakeMatch && !awaitingCommandRef.current) {
        setStatus("Wake mode active. Say hey buddy.");
        return;
      }

      let command = finalTranscript;
      if (wakeModeRef.current && wakeMatch) {
        const lowerFinalTranscript = finalTranscript.toLowerCase();
        const finalWakeMatch = lowerFinalTranscript.match(/\b(hey|hi|hello)\s+buddy\b/);
        command = finalWakeMatch
          ? finalTranscript.slice(finalWakeMatch.index + finalWakeMatch[0].length).trim()
          : "";
        awaitingCommandRef.current = !command;
        setStatus(command ? "Command heard: " + command : "Buddy is awake. Say your command.");
        if (!command) {
          speak("Yes, tell me the command.", () => restartWakeListening(300));
          return;
        }
      } else if (awaitingCommandRef.current) {
        command = finalTranscript;
        awaitingCommandRef.current = false;
        setStatus("Command heard: " + command);
      } else {
        setStatus("Heard: " + finalTranscript);
      }

      if (!isCompleteCommand(command)) {
        const prompt = "Please say the full command after hey buddy.";
        setAssistantText(prompt);
        setStatus("Command was incomplete");
        speak(prompt, () => restartWakeListening(500));
        return;
      }

      if (command) {
        finalTranscriptRef.current = command;
        window.clearTimeout(silenceTimerRef.current);
        silenceTimerRef.current = window.setTimeout(() => {
          shouldRestartWakeRef.current = false;
          isProcessingRef.current = true;
          recognition.stop();
          sendVoiceCommand(finalTranscriptRef.current);
        }, 250);
      }
    };

    recognition.onerror = () => {
      setIsListening(false);
      setStatus("Microphone error. Please allow microphone access.");
      speak("Microphone error. Please allow microphone access.");
    };

    recognition.onend = () => {
      setIsListening(false);
      if (wakeModeRef.current && !isProcessingRef.current && shouldRestartWakeRef.current) {
        restartWakeListening(400);
        return;
      }

      if (!isProcessingRef.current && !finalTranscriptRef.current) {
        setStatus("No speech heard. Press Speak and try again.");
      }
    };

    recognitionRef.current = recognition;

    return () => {
      window.clearTimeout(silenceTimerRef.current);
      recognition.stop();
      window.speechSynthesis?.cancel();
    };
  }, []);

  const restartWakeListening = (delay = 600) => {
    if (!wakeModeRef.current || isProcessingRef.current) return;
    shouldRestartWakeRef.current = true;
    window.setTimeout(() => {
      if (!wakeModeRef.current || isProcessingRef.current) return;
      try {
        recognitionRef.current?.start();
        setStatus("Wake mode active. Say hey buddy.");
      } catch {
        setStatus("Wake mode active. Say hey buddy.");
      }
    }, delay);
  };

  const isCompleteCommand = (command) => {
    const normalized = command.toLowerCase().trim();
    if (!normalized) return false;
    const incompletePhrases = new Set(["what", "what is", "who", "who is", "open", "search", "play"]);
    return !incompletePhrases.has(normalized);
  };

  const speak = (text, onEnd) => {
    if (!text || !window.speechSynthesis) return;
    speechRunRef.current += 1;
    const speechRun = speechRunRef.current;
    window.speechSynthesis.cancel();
    const lines = text
      .split(/\n+/)
      .map((line) => line.trim())
      .filter(Boolean);
    let currentLine = 0;

    const speakNextLine = () => {
      if (speechRun !== speechRunRef.current) return;
      if (currentLine >= lines.length) {
        onEnd?.();
        return;
      }

      const utterance = new SpeechSynthesisUtterance(lines[currentLine]);
      utterance.rate = 0.95;
      utterance.pitch = 1;
      utterance.onend = () => {
        currentLine += 1;
        window.setTimeout(speakNextLine, 250);
      };
      utterance.onerror = () => onEnd?.();
      window.speechSynthesis.speak(utterance);
    };

    speakNextLine();
  };

  const openAction = (url) => {
    if (!url) return;
    window.open(url, "_blank", "noopener,noreferrer");
  };

  const readStream = async (response) => {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const chunks = buffer.split("\n\n");
      buffer = chunks.pop() || "";

      for (const chunk of chunks) {
        const eventName = chunk.match(/^event:\s*(.+)$/m)?.[1];
        const dataText = chunk.match(/^data:\s*(.+)$/m)?.[1];
        if (!eventName || !dataText) continue;

        const data = JSON.parse(dataText);
        if (eventName === "status") {
          setStatus(data.message);
        }

        if (eventName === "final") {
          const responseText = data.response || "I could not understand that.";
          const speechText = data.spokenText || responseText;
          setAssistantText(responseText);
          setStatus("Task complete");
          setActionUrl(data.actionUrl || "");
          speak(speechText, () => restartWakeListening(700));
          if (data.actionUrl) {
            window.setTimeout(() => openAction(data.actionUrl), 500);
          }
        }
      }
    }
  };

  const sendVoiceCommand = async (command) => {
    const message = command.trim();
    if (!message || isProcessing) return;

    abortRef.current?.abort();
    abortRef.current = new AbortController();
    isProcessingRef.current = true;
    setIsProcessing(true);
    setActionUrl("");
    setStatus("Doing the task");
    setAssistantText("Working on it.");
    shouldRestartWakeRef.current = false;

    try {
      const response = await fetch(`${API_BASE_URL}/VA/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ message }),
        signal: abortRef.current.signal,
      });

      if (!response.ok || !response.body) {
        throw new Error("Assistant request failed");
      }

      await readStream(response);
    } catch (error) {
      if (error.name === "AbortError") return;
      const fallback = "I could not complete that task. Please try again.";
      setAssistantText(fallback);
      setStatus("Task failed");
      speak(fallback, () => restartWakeListening(700));
    } finally {
      setIsProcessing(false);
      isProcessingRef.current = false;
      abortRef.current = null;
    }
  };

  const startListening = () => {
    if (!voiceSupported || isProcessing) return;
    try {
      window.speechSynthesis?.cancel();
      finalTranscriptRef.current = "";
      awaitingCommandRef.current = false;
      shouldRestartWakeRef.current = true;
      setSpokenText("");
      recognitionRef.current?.start();
    } catch {
      setStatus("Already listening");
    }
  };

  const startWakeMode = () => {
    if (!voiceSupported) return;
    setWakeMode(true);
    wakeModeRef.current = true;
    shouldRestartWakeRef.current = true;
    setStatus("Wake mode active. Say hey buddy, then your command.");
    speak("Wake mode active. Say hey buddy, then your command.");
    window.setTimeout(startListening, 250);
  };

  const stopEverything = () => {
    window.clearTimeout(silenceTimerRef.current);
    speechRunRef.current += 1;
    recognitionRef.current?.stop();
    abortRef.current?.abort();
    window.speechSynthesis?.cancel();
    setIsListening(false);
    setWakeMode(false);
    wakeModeRef.current = false;
    awaitingCommandRef.current = false;
    shouldRestartWakeRef.current = false;
    setIsProcessing(false);
    setStatus("Stopped");
  };

  return (
    <main className="min-h-screen bg-black text-white">
      <section className="mx-auto flex min-h-screen w-full max-w-4xl flex-col justify-between gap-8 px-5 py-8">
        <div className="space-y-4">
          <p className="text-base font-black uppercase tracking-[0.18em] text-[#facc15]">
            Voice assistant for visually impaired users
          </p>
          <h1 className="text-4xl font-black leading-tight sm:text-6xl">
            Say “hey buddy” and the assistant does the task.
          </h1>
        </div>

        <div
          aria-live="assertive"
          aria-atomic="true"
          role="status"
          className="rounded-md border-4 border-[#facc15] bg-[#171103] p-5"
        >
          <p className="text-sm font-black uppercase tracking-[0.18em] text-[#facc15]">Status</p>
          <p className="mt-2 text-3xl font-black leading-tight">{status}</p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <button
            type="button"
            onClick={startListening}
            disabled={!voiceSupported || isListening || isProcessing}
            className="flex min-h-40 flex-col items-center justify-center gap-4 rounded-md bg-[#facc15] p-6 text-black outline-offset-4 transition hover:bg-[#fde047] focus:outline focus:outline-4 focus:outline-white disabled:cursor-not-allowed disabled:bg-white/20 disabled:text-white/50"
          >
            {isListening ? <MicOff size={56} aria-hidden="true" /> : <Mic size={56} aria-hidden="true" />}
            <span className="text-4xl font-black">{isListening ? "Listening" : "Speak"}</span>
          </button>

          <button
            type="button"
            onClick={stopEverything}
            className="flex min-h-40 flex-col items-center justify-center gap-4 rounded-md bg-[#ef4444] p-6 text-white outline-offset-4 transition hover:bg-[#f87171] focus:outline focus:outline-4 focus:outline-white"
          >
            <Square size={56} aria-hidden="true" />
            <span className="text-4xl font-black">Stop</span>
          </button>
        </div>

        <button
          type="button"
          onClick={startWakeMode}
          disabled={!voiceSupported || wakeMode}
          className="min-h-20 rounded-md border-4 border-[#22c55e] bg-[#03180b] px-6 py-4 text-3xl font-black text-[#86efac] outline-offset-4 hover:bg-[#064e3b] focus:outline focus:outline-4 focus:outline-white disabled:cursor-not-allowed disabled:border-white/30 disabled:text-white/50"
        >
          {wakeMode ? "Wake mode is on. Say hey buddy." : "Start wake mode"}
        </button>

        <div className="grid gap-4">
          <article className="rounded-md border-2 border-[#38bdf8] bg-[#03111b] p-5">
            <p className="text-sm font-black uppercase tracking-[0.18em] text-[#7dd3fc]">You said</p>
            <p className="mt-2 min-h-12 text-2xl font-bold leading-9">
              {spokenText || (wakeMode ? "Say hey buddy..." : "Waiting for speech...")}
            </p>
          </article>

          <article className="rounded-md border-2 border-[#22c55e] bg-[#03180b] p-5">
            <p className="text-sm font-black uppercase tracking-[0.18em] text-[#86efac]">Nova</p>
            <p className="mt-2 text-3xl font-black leading-10">{assistantText}</p>
          </article>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <button
            type="button"
            onClick={() => speak(lastAssistantTextRef.current)}
            className="flex min-h-16 items-center justify-center gap-3 rounded-md border-2 border-white px-5 py-4 text-xl font-black outline-offset-4 hover:bg-white hover:text-black focus:outline focus:outline-4 focus:outline-white"
          >
            <Volume2 aria-hidden="true" />
            Repeat response
          </button>

          {actionUrl ? (
            <button
              type="button"
              onClick={() => openAction(actionUrl)}
              className="flex min-h-16 items-center justify-center gap-3 rounded-md border-2 border-[#7dd3fc] px-5 py-4 text-xl font-black text-[#7dd3fc] outline-offset-4 hover:bg-[#082f49] focus:outline focus:outline-4 focus:outline-white"
            >
              <ExternalLink aria-hidden="true" />
              Open task again
            </button>
          ) : (
            <button
              type="button"
              onClick={() => {
                setSpokenText("");
                setAssistantText("Say things like open YouTube, search music on YouTube, or what time is it.");
                setStatus("Press Speak and say a command");
              }}
              className="flex min-h-16 items-center justify-center gap-3 rounded-md border-2 border-[#7dd3fc] px-5 py-4 text-xl font-black text-[#7dd3fc] outline-offset-4 hover:bg-[#082f49] focus:outline focus:outline-4 focus:outline-white"
            >
              <RotateCcw aria-hidden="true" />
              Reset
            </button>
          )}
        </div>

        {!voiceSupported && (
          <p className="rounded-md border-2 border-[#ef4444] bg-[#230606] p-4 text-xl font-bold">
            Your browser does not support speech recognition. Please use Chrome or Edge.
          </p>
        )}
      </section>
    </main>
  );
};

export default Home;
