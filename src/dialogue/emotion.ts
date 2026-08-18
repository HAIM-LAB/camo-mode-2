/**
 * Emotion state.
 *
 * Traits are who a character *is* and never change during play. Emotions are how
 * they *are right now*: they start at an authored baseline, get nudged by storylet
 * effects, and drift back toward baseline every turn. Keeping the two apart is
 * what lets Friend A stay a warm, agreeable child while still being genuinely
 * hurt for a few beats.
 *
 * Every dimension is 0..1. The dimensions are fixed here rather than authored per
 * persona so the prompt builder, the storylet effects, and the inspector all
 * agree on what exists; personas choose the baselines.
 */

export const EMOTION_DIMENSIONS = [
  'joy',
  'hurt',
  'anger',
  'worry',
  'warmth',
  'energy',
] as const;

export type EmotionDimension = (typeof EMOTION_DIMENSIONS)[number];

export type EmotionVector = Record<EmotionDimension, number>;

export interface EmotionDimensionSpec {
  id: EmotionDimension;
  label: string;
  /** What the model is told when this dimension runs high. */
  high: string;
  /** What the model is told when this dimension runs low. */
  low: string;
  /**
   * Share of the gap back to baseline closed per conversational turn. 0 means the
   * feeling never fades on its own; 1 means it resets every turn.
   */
  decayPerTurn: number;
}

export const EMOTION_SPECS: Readonly<Record<EmotionDimension, EmotionDimensionSpec>> =
  Object.freeze({
    joy: {
      id: 'joy',
      label: 'Joy',
      high: 'is bright and playful, and lets that show',
      low: 'is flat and unsmiling right now',
      decayPerTurn: 0.25,
    },
    hurt: {
      id: 'hurt',
      label: 'Hurt',
      high: 'still feels wronged, and it leaks into how they answer',
      low: 'does not feel wronged right now',
      decayPerTurn: 0.15,
    },
    anger: {
      id: 'anger',
      label: 'Anger',
      high: 'is frustrated, and gets short and clipped',
      low: 'is not frustrated',
      decayPerTurn: 0.3,
    },
    worry: {
      id: 'worry',
      label: 'Worry',
      high: 'is anxious, hesitates, and checks whether it is safe to say things',
      low: 'feels settled and unworried',
      decayPerTurn: 0.2,
    },
    warmth: {
      id: 'warmth',
      label: 'Warmth',
      high: 'trusts this child and opens up to them',
      low: 'is guarded with this child and keeps answers short',
      // Warmth is a relationship, not a mood: it should persist across the scene.
      decayPerTurn: 0.05,
    },
    energy: {
      id: 'energy',
      label: 'Energy',
      high: 'is bouncy and talks fast',
      low: 'is tired and says little',
      decayPerTurn: 0.2,
    },
  });

export function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

export function createEmotionVector(baselines: Partial<EmotionVector> = {}): EmotionVector {
  const vector = {} as EmotionVector;
  for (const dimension of EMOTION_DIMENSIONS) {
    vector[dimension] = clamp01(baselines[dimension] ?? 0.5);
  }
  return vector;
}

/** A named delta applied to one or more dimensions. Values are additive, then clamped. */
export type EmotionNudge = Partial<Record<EmotionDimension, number>>;

export class EmotionState {
  private current: EmotionVector;

  constructor(readonly baseline: EmotionVector) {
    this.current = { ...baseline };
  }

  /** The live vector. Copied so the inspector cannot mutate play state. */
  get vector(): EmotionVector {
    return { ...this.current };
  }

  apply(nudge: EmotionNudge): void {
    for (const dimension of EMOTION_DIMENSIONS) {
      const delta = nudge[dimension];
      if (typeof delta !== 'number' || delta === 0) continue;
      this.current[dimension] = clamp01(this.current[dimension] + delta);
    }
  }

  /** Drifts every dimension back toward its baseline by that dimension's decay rate. */
  decay(): void {
    for (const dimension of EMOTION_DIMENSIONS) {
      const rate = EMOTION_SPECS[dimension].decayPerTurn;
      const gap = this.baseline[dimension] - this.current[dimension];
      this.current[dimension] = clamp01(this.current[dimension] + gap * rate);
    }
  }

  reset(): void {
    this.current = { ...this.baseline };
  }

  /** Dimensions far enough from the neutral middle to be worth telling the model about. */
  salient(threshold = 0.15): { dimension: EmotionDimension; value: number; high: boolean }[] {
    return EMOTION_DIMENSIONS.map((dimension) => ({
      dimension,
      value: this.current[dimension],
      high: this.current[dimension] >= 0.5,
    }))
      .filter((entry) => Math.abs(entry.value - 0.5) >= threshold)
      .sort((a, b) => Math.abs(b.value - 0.5) - Math.abs(a.value - 0.5));
  }
}
