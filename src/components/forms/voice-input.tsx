"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";

/**
 * VOICE-TO-TEXT FOR LONG FREE-TEXT FIELDS (V3 Phase H, spec §26)
 * ===========================================================================
 *
 * One small button, placed next to a `<textarea>`, that dictates into it. It
 * is used by the support form, wanted descriptions and replies, contract
 * requirements and applications, listing descriptions and invoice/order notes.
 *
 * WHAT IT IS NOT
 * --------------
 *   * NOT a dependency. It uses the browser's own `SpeechRecognition` /
 *     `webkitSpeechRecognition`. Nothing is added to package.json.
 *   * NOT an upload. Recognition happens through the browser's own speech
 *     service; this component never touches `getUserMedia`, never builds a
 *     `MediaRecorder`, never creates a Blob and never calls `fetch`. No audio
 *     is sent to this app's server, stored on disk, or written to Postgres —
 *     the only thing that ever leaves this component is the text the user can
 *     see and edit in the field.
 *   * NOT required. Typing is always available and unchanged. If the API is
 *     missing (Firefox, most headless browsers, older Safari) the component
 *     renders NOTHING AT ALL — no disabled button, no warning, no layout
 *     shift. That is the "degrade silently" rule: a user on an unsupported
 *     browser sees exactly the form V2 had.
 *   * NOT on any payment path. It is never rendered on /pay, on the invoice
 *     payment button, or on an order payment. Those screens have no long
 *     free-text field, and keeping dictation away from them is why it cannot
 *     delay or block a payment even in principle.
 *
 * HOW IT WRITES INTO THE FIELD
 * ----------------------------
 * The textareas in this app are uncontrolled (`name` + `defaultValue`), which
 * is what lets a server action read them from `FormData`. So the transcript is
 * appended by setting the element's `value` through the native setter and
 * dispatching an `input` event — the same thing typing does. A controlled React
 * field would see that event too, so this works either way, and the user can
 * edit or delete the transcript afterwards like any other text.
 */

type RecognitionResultLike = {
  isFinal: boolean;
  0: { transcript: string };
};

type RecognitionEventLike = {
  resultIndex: number;
  results: { length: number; [index: number]: RecognitionResultLike };
};

type RecognitionLike = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((event: RecognitionEventLike) => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onend: (() => void) | null;
};

type RecognitionConstructor = new () => RecognitionLike;

function recognitionConstructor(): RecognitionConstructor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: RecognitionConstructor;
    webkitSpeechRecognition?: RecognitionConstructor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/**
 * Support detection as an EXTERNAL STORE rather than state set in an effect.
 *
 * Whether the browser has `SpeechRecognition` is a fact about the environment,
 * not React state: it is read during render on the client and reported as
 * `false` on the server, so the markup the server sends (no button) matches the
 * first client render on an unsupported browser and React swaps in the button
 * on a supported one. Nothing subscribes, because the answer cannot change.
 */
const NEVER_CHANGES = () => () => undefined;

function useSpeechSupported(): boolean {
  return useSyncExternalStore(
    NEVER_CHANGES,
    () => recognitionConstructor() !== null,
    () => false,
  );
}

/** Appends text to a textarea/input the way typing would. */
function appendToField(targetId: string, text: string): void {
  const el = document.getElementById(targetId);
  if (!(el instanceof HTMLTextAreaElement) || text.length === 0) return;

  const existing = el.value;
  const separator = existing.length === 0 || /\s$/.test(existing) ? "" : " ";
  const next = `${existing}${separator}${text}`;

  const setter = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    "value",
  )?.set;
  if (setter) setter.call(el, next);
  else el.value = next;

  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.focus();
  el.setSelectionRange(el.value.length, el.value.length);
}

export function VoiceInput({
  targetId,
  label = "Dictate",
}: {
  /** The `id` of the textarea this button dictates into. */
  targetId: string;
  label?: string;
}) {
  // Rendered only where the browser can actually do it, so an unsupported
  // browser sees exactly the form it saw before this feature existed.
  const supported = useSpeechSupported();
  // Set only from an event handler, for the rare browser that advertises the
  // API and then throws when it is constructed.
  const [broken, setBroken] = useState(false);
  const [listening, setListening] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const recognition = useRef<RecognitionLike | null>(null);

  useEffect(() => {
    return () => {
      try {
        recognition.current?.abort();
      } catch {
        // Nothing to clean up if the browser already tore it down.
      }
      recognition.current = null;
    };
  }, []);

  if (!supported || broken) return null;

  function stop() {
    try {
      recognition.current?.stop();
    } catch {
      // Ignore: stopping an already-stopped recogniser is not an error here.
    }
    setListening(false);
  }

  function start() {
    const Ctor = recognitionConstructor();
    if (!Ctor) return;
    setNotice(null);

    let instance: RecognitionLike;
    try {
      instance = new Ctor();
    } catch {
      setBroken(true);
      return;
    }

    instance.lang = document.documentElement.lang || "en-IN";
    instance.continuous = true;
    instance.interimResults = false;

    instance.onresult = (event) => {
      let text = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) text += result[0].transcript;
      }
      appendToField(targetId, text.trim());
    };

    instance.onerror = (event) => {
      setListening(false);
      // The only two worth explaining; everything else just stops quietly.
      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        setNotice("Microphone access was blocked. Type instead.");
      } else if (event.error === "no-speech") {
        setNotice("Nothing was heard. Try again, or type instead.");
      }
    };

    instance.onend = () => setListening(false);

    recognition.current = instance;
    try {
      instance.start();
      setListening(true);
    } catch {
      setListening(false);
      setNotice("Dictation could not start. Type instead.");
    }
  }

  return (
    <div className="mt-1 flex flex-wrap items-center gap-2">
      <button
        type="button"
        className={listening ? "btn btn-primary text-xs" : "btn btn-secondary text-xs"}
        onClick={listening ? stop : start}
        aria-pressed={listening}
        data-testid="voice-input-button"
      >
        {listening ? "Stop dictating" : label}
      </button>
      <span className="text-xs text-muted">
        {listening ? "Listening — speak, then stop." : "Optional. You can always type."}
      </span>
      {notice && (
        <span className="text-xs text-danger" role="status">
          {notice}
        </span>
      )}
    </div>
  );
}
