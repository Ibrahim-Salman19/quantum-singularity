/**
 * Temporal smoothing + hysteresis over fused per-gesture scores.
 *
 * Raw classifier output flickers frame to frame. This turns it into a stable
 * "active gesture" with an asymmetric EMA (fast attack, slow release), a confirm
 * window before activation, a switch margin so a challenger must clearly beat the
 * incumbent, and a release window so momentary tracking dropouts do not cancel a
 * held gesture.
 *
 * Everything is expressed in seconds, not frame counts: inference runs anywhere from
 * 12 to 26 Hz depending on device tier and adaptive quality, and frame-counted
 * thresholds would make the debounce window vary by more than 2x across devices.
 *
 * @module gesture/state-machine
 */
import { clamp, clamp01 } from '../core/math.js';
import { GESTURE_NAMES } from './classifier.js';

export const GESTURE_THRESHOLDS = Object.freeze({
    GESTURE_ACTIVATE:    0.64,  // score needed to claim an idle slot
    GESTURE_SWITCH:      0.74,  // score needed to displace an active gesture
    GESTURE_HOLD:        0.44,  // below this, the active gesture starts releasing
    GESTURE_MARGIN:      0.10,  // challenger must beat the incumbent by this much
    GESTURE_IDLE_MARGIN: 0.09,  // winner must beat the runner-up by this much
    GESTURE_CONFIRM_SEC: 0.085, // sustained time before a gesture is confirmed
    GESTURE_RELEASE_SEC: 0.20   // sustained time below hold before releasing
});

const EMA_TAU_ATTACK  = 0.045; // rising time constant (seconds)
const EMA_TAU_RELEASE = 0.13;  // falling time constant (seconds)

// The most confirm time any single sample may contribute. Inference drops to 8-9 Hz
// on the weakest devices (125 ms per sample, longer than the confirm window) and can
// stall for a few hundred ms; without this cap one misclassified frame after such a
// gap would confirm a gesture on its own. With it, confirmation always needs at least
// two consecutive agreeing samples, and timing at 12 Hz and above is unchanged.
const MAX_CONFIRM_STEP = GESTURE_THRESHOLDS.GESTURE_CONFIRM_SEC * 0.75;

/**
 * @param {object} [options]
 * @param {(value:number) => void} [options.onBar] receives the confidence of the
 *        gesture currently being displayed (active, else candidate, else best) after
 *        every update, and 0 on reset. The UI uses it to drive the confidence bar.
 */
export function createGestureStateMachine({ onBar } = {}) {
    const {
        GESTURE_ACTIVATE, GESTURE_SWITCH, GESTURE_HOLD, GESTURE_MARGIN,
        GESTURE_IDLE_MARGIN, GESTURE_CONFIRM_SEC, GESTURE_RELEASE_SEC
    } = GESTURE_THRESHOLDS;

    const s = {
        active: null,
        candidate: null,
        candidateTime: 0,   // seconds the current challenger has held above threshold
        releaseTime: 0,     // seconds the active gesture has been below hold threshold
        lastUpdate: 0,      // ms timestamp of the previous update
        ema: { Pointing_Up: 0, Open_Palm: 0, Victory: 0 }
    };

    function promote(name) {
        s.active = name;
        s.candidate = null;
        s.candidateTime = 0;
        s.releaseTime = 0;
    }

    function accumulateCandidate(name, dt) {
        const step = Math.min(dt, MAX_CONFIRM_STEP);
        if (s.candidate === name) s.candidateTime += step;
        else { s.candidate = name; s.candidateTime = step; }
        if (s.candidateTime >= GESTURE_CONFIRM_SEC) promote(name);
    }

    function clearCandidate() {
        s.candidate = null;
        s.candidateTime = 0;
    }

    function reset() {
        s.active = null;
        s.lastUpdate = 0;
        s.releaseTime = 0;
        clearCandidate();
        for (const name of GESTURE_NAMES) s.ema[name] = 0;
        onBar?.(0);
    }

    /**
     * @param {Record<string, number>} rawScores fused scores keyed by gesture name
     * @param {number} nowMs monotonic clock in milliseconds
     * @returns {{gesture: string|null, bestName: string, bestScore: number}}
     */
    function update(rawScores, nowMs) {
        const prevUpdate = s.lastUpdate;
        // First sample after a reset, or a resumed tab: treat as a single nominal
        // step instead of integrating a multi-second gap.
        const dt = prevUpdate > 0 ? clamp((nowMs - prevUpdate) / 1000, 1 / 120, 0.5) : 1 / 30;
        s.lastUpdate = nowMs;

        // Asymmetric time-constant EMA: fast attack so activation feels immediate,
        // slower release so momentary dropouts do not cancel a held gesture.
        for (const name of GESTURE_NAMES) {
            const incoming = clamp01(rawScores?.[name]);
            const previous = s.ema[name];
            const tau = incoming > previous ? EMA_TAU_ATTACK : EMA_TAU_RELEASE;
            s.ema[name] = previous + (incoming - previous) * (1 - Math.exp(-dt / tau));
        }

        // Rank without allocating: only the top two scores are needed.
        let bestName = GESTURE_NAMES[0], bestScore = -1, secondScore = -1;
        for (const name of GESTURE_NAMES) {
            const v = s.ema[name];
            if (v > bestScore) { secondScore = bestScore; bestScore = v; bestName = name; }
            else if (v > secondScore) secondScore = v;
        }
        if (secondScore < 0) secondScore = 0;

        const active = s.active;
        if (active) {
            const activeScore = s.ema[active];
            // Release accumulates independently of the switch evaluation, so a
            // flickering challenger cannot suppress the release timer and keep a
            // collapsed gesture active indefinitely.
            s.releaseTime = activeScore < GESTURE_HOLD ? s.releaseTime + dt : 0;

            const canSwitch = bestName !== active
                && bestScore >= GESTURE_SWITCH
                && bestScore >= activeScore + GESTURE_MARGIN;
            if (canSwitch) accumulateCandidate(bestName, dt);
            else clearCandidate();

            if (s.active === active && s.releaseTime >= GESTURE_RELEASE_SEC) {
                s.active = null;
                s.releaseTime = 0;
                clearCandidate();
            }
        } else if (bestScore >= GESTURE_ACTIVATE && bestScore >= secondScore + GESTURE_IDLE_MARGIN) {
            accumulateCandidate(bestName, dt);
        } else {
            clearCandidate();
        }

        const displayed = s.active || s.candidate || bestName;
        onBar?.(s.ema[displayed] || 0);
        return { gesture: s.active, bestName, bestScore };
    }

    /** Snapshot for diagnostics and tests (copies; safe to retain). */
    function snapshot() {
        return { active: s.active, candidate: s.candidate, ema: { ...s.ema } };
    }

    return { update, reset, snapshot };
}
