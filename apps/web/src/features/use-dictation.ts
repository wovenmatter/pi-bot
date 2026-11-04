import { useEffect, useRef, useState } from "react";

type Recognition = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult:
    | ((event: {
        resultIndex: number;
        results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>;
      }) => void)
    | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
};
type SpeechWindow = Window & {
  SpeechRecognition?: new () => Recognition;
  webkitSpeechRecognition?: new () => Recognition;
};

/** Browser dictation is optional; no microphone access until explicitly activated. */
export function useDictation(onText: (text: string) => void, onError: (error: string) => void) {
  const callbacks = useRef({ onText, onError });
  callbacks.current = { onText, onError };
  const recognition = useRef<Recognition | null>(null);
  const [listening, setListening] = useState(false);
  const browser = window as SpeechWindow;
  const Constructor = browser.SpeechRecognition ?? browser.webkitSpeechRecognition;

  useEffect(
    () => () => {
      const current = recognition.current;
      if (current) {
        current.onresult = null;
        current.onerror = null;
        current.onend = null;
        current.abort();
      }
    },
    [],
  );

  function toggle() {
    if (recognition.current) {
      recognition.current.stop();
      return;
    }
    if (!Constructor) return;
    const current = new Constructor();
    current.continuous = true;
    current.interimResults = false;
    current.lang = navigator.language;
    current.onresult = (event) => {
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result?.isFinal) callbacks.current.onText(result[0].transcript);
      }
    };
    current.onerror = (event) => {
      if (event.error !== "aborted")
        callbacks.current.onError(
          `Dictation failed (${event.error}). Check your browser’s microphone permission or use keyboard dictation.`,
        );
      current.abort();
      recognition.current = null;
      setListening(false);
    };
    current.onend = () => {
      recognition.current = null;
      setListening(false);
    };
    recognition.current = current;
    try {
      current.start();
      setListening(true);
    } catch {
      recognition.current = null;
      setListening(false);
      callbacks.current.onError(
        "Dictation could not start. Check microphone access and try again.",
      );
    }
  }
  return { supported: Boolean(Constructor), listening, toggle };
}
