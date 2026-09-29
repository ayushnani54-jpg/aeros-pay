"use client";

import { useEffect, useSyncExternalStore } from "react";
import { PAYMENT_SOUND_STORAGE_KEY } from "@/lib/constants";

/**
 * PAYMENT SUCCESS SOUND (V3 Phase H, spec §27)
 * ===========================================================================
 *
 * A short two-note chime, synthesised in the browser, played once after the
 * SERVER has confirmed a payment. Every rule in the spec is satisfied by WHERE
 * this component is allowed to be rendered rather than by a check inside it:
 *
 *   NEVER BEFORE THE SERVER RESPONDS, AND NEVER ON FAILURE OR PENDING.
 *   `<PaymentSuccessSound />` is rendered only inside a success branch that
 *   already required a server result — `state.ok` on the pay receipt,
 *   `state.ok` on invoice payment, the PAID/COMPLETED state of an order. There
 *   is no timer, no optimistic path and no `onClick` that could play it: if the
 *   sound is audible, the server has already returned a receipt.
 *
 *   IT CANNOT DELAY ANYTHING. The chime is scheduled in an effect AFTER the
 *   success state has painted, and every call is wrapped so that a failure to
 *   create an AudioContext is swallowed. The UI never awaits it.
 *
 *   AUTOPLAY RESTRICTIONS ARE EXPECTED, NOT FOUGHT. A browser may refuse to
 *   start audio without a user gesture; a payment is normally a click, so this
 *   usually works, but when it does not the `catch` is the whole handling. The
 *   success state is plain text and is always shown either way, so a blocked
 *   sound costs the user nothing.
 *
 *   NO AUDIO FILE, ANYWHERE. Two oscillators and a gain envelope. Nothing is
 *   added to /public, nothing is fetched and the bundle does not grow by a
 *   single kilobyte of audio.
 *
 *   NOTHING IS STORED ABOUT SOUND EVENTS. No count, no timestamp, no "last
 *   played". The only persisted value is the user's own on/off preference, and
 *   it lives in `localStorage` — per browser, never a database column, so it is
 *   not account data and the Government cannot see it.
 */

/** Reads the per-browser preference. Sound is ON unless turned off. */
function soundEnabled(): boolean {
  try {
    return window.localStorage.getItem(PAYMENT_SOUND_STORAGE_KEY) !== "off";
  } catch {
    // Private mode / storage disabled: fall back to the default.
    return true;
  }
}

/**
 * A short, polished two-note rise with a soft bell partial — about 0.9s of
 * audio, ending in silence rather than a click because every gain envelope
 * ramps down exponentially.
 */
function playSuccessChime(): void {
  const Ctor =
    typeof window === "undefined"
      ? null
      : (window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext ??
        null);
  if (!Ctor) return;

  let ctx: AudioContext;
  try {
    ctx = new Ctor();
  } catch {
    return;
  }

  const close = () => {
    try {
      void ctx.close();
    } catch {
      // Already closed.
    }
  };

  try {
    // If the page has no audio gesture yet the context starts suspended;
    // resume() may reject, which is exactly the blocked-autoplay case.
    if (ctx.state === "suspended") void ctx.resume().catch(() => undefined);

    const start = ctx.currentTime + 0.01;
    const master = ctx.createGain();
    master.gain.setValueAtTime(0.0001, start);
    master.gain.exponentialRampToValueAtTime(0.16, start + 0.04);
    master.gain.exponentialRampToValueAtTime(0.0001, start + 0.9);
    master.connect(ctx.destination);

    // A major sixth: a settled, "done" interval rather than a game jingle.
    const notes: { freq: number; at: number; length: number; gain: number }[] = [
      { freq: 880.0, at: 0, length: 0.32, gain: 0.9 },
      { freq: 1318.5, at: 0.14, length: 0.6, gain: 0.7 },
      // A quiet octave partial gives it a bell-like body.
      { freq: 2637.0, at: 0.14, length: 0.35, gain: 0.18 },
    ];

    for (const note of notes) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(note.freq, start + note.at);
      gain.gain.setValueAtTime(0.0001, start + note.at);
      gain.gain.exponentialRampToValueAtTime(note.gain, start + note.at + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + note.at + note.length);
      osc.connect(gain);
      gain.connect(master);
      osc.start(start + note.at);
      osc.stop(start + note.at + note.length + 0.05);
    }

    // Close the context once the tail has finished so nothing is left running.
    window.setTimeout(close, 1400);
  } catch {
    close();
  }
}

/**
 * Renders nothing. Mounting it plays the chime once, if the viewer has not
 * turned it off.
 *
 * `key`-ing it on something that changes per payment (a transaction ref, an
 * invoice id) is what makes a second payment sound again.
 */
export function PaymentSuccessSound() {
  useEffect(() => {
    if (!soundEnabled()) return;
    playSuccessChime();
  }, []);

  return null;
}

/**
 * The preference as an EXTERNAL STORE.
 *
 * `localStorage` is exactly what `useSyncExternalStore` is for: it is state
 * that lives outside React, it can be changed by another tab, and reading it
 * during render on the client while reporting the default on the server is the
 * whole contract. Doing it this way also means no state is set from an effect.
 */
const soundListeners = new Set<() => void>();

function subscribeToSoundPreference(onChange: () => void): () => void {
  soundListeners.add(onChange);
  // Another tab changing the choice keeps this one in step.
  window.addEventListener("storage", onChange);
  return () => {
    soundListeners.delete(onChange);
    window.removeEventListener("storage", onChange);
  };
}

function setSoundPreference(next: boolean): void {
  try {
    window.localStorage.setItem(PAYMENT_SOUND_STORAGE_KEY, next ? "on" : "off");
  } catch {
    // Storage unavailable (private mode): the choice applies to this view only.
  }
  for (const listener of soundListeners) listener();
}

/**
 * The on/off switch, shown on the profile screen.
 *
 * Deliberately not a server action and not a form: there is nothing to submit
 * because there is nothing on the server to change.
 */
export function PaymentSoundToggle() {
  const enabled = useSyncExternalStore(
    subscribeToSoundPreference,
    soundEnabled,
    // On the server the default (on) is assumed; the real per-browser value
    // takes over as soon as the component hydrates.
    () => true,
  );

  function update(next: boolean) {
    setSoundPreference(next);
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="min-w-0">
        <p className="text-sm font-medium">Payment success sound</p>
        <p className="text-xs text-muted">
          A short chime after a payment the server has confirmed. Saved in this browser only —
          never on your account.
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <button
          type="button"
          className={enabled ? "btn btn-primary text-xs" : "btn btn-secondary text-xs"}
          onClick={() => update(true)}
          aria-pressed={enabled}
          data-testid="sound-on"
        >
          On
        </button>
        <button
          type="button"
          className={!enabled ? "btn btn-primary text-xs" : "btn btn-secondary text-xs"}
          onClick={() => update(false)}
          aria-pressed={!enabled}
          data-testid="sound-off"
        >
          Off
        </button>
      </div>
    </div>
  );
}
