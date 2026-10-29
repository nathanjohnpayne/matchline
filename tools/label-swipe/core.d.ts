// Types for core.js, which publishes `globalThis.LabelCore` (a classic
// script so the page also works from file://).

export type Label = "true" | "false" | "mixed" | "unsure";

export interface DeckCardLike {
  item_id: string;
  type: string;
  catch: boolean;
  expected?: "true" | "false";
}

export interface DeckLike {
  deck_id: string;
  cards: DeckCardLike[];
}

export interface Decision {
  label: Label;
  note: string;
  ms: number;
  order: number;
}

export interface LabelState {
  deck_id: string;
  seed: number;
  queue: string[];
  types: Record<string, string>;
  decisions: Record<string, Decision>;
  history: { kind: "decide" | "requeue"; id: string; ms: number }[];
  undos: Record<string, number>;
  elapsed: Record<string, number>;
  requeued: Record<string, boolean>;
  counter: number;
}

export interface LabelsExport {
  deck_id: string;
  seed: number;
  session_id: string;
  items: { item_id: string; type: string; label: Label; note: string; ms: number; order: number; undos: number; catch: boolean }[];
  attention: { catch_cards: number; catch_correct: number };
}

export interface LabelCoreApi {
  LABELS: Label[];
  MIXED_TYPES: string[];
  allowsMixed(type: string): boolean;
  prng(seed: number): () => number;
  shuffle<T>(items: T[], seed: number): T[];
  randomUint32(): number;
  newSessionId(): string;
  initState(deck: DeckLike, seed: number): LabelState;
  current(state: LabelState): string | null;
  decide(state: LabelState, label: Label, ms: number): LabelState;
  setNote(state: LabelState, id: string, note: string): LabelState;
  undo(state: LabelState): LabelState;
  progress(state: LabelState): { done: number; total: number };
  buildExport(deck: DeckLike, state: LabelState, sessionId: string): LabelsExport;
  exportFilename(deckId: string, date: Date): string;
  stateMatchesDeck(state: unknown, deck: DeckLike): boolean;
}

declare global {
  var LabelCore: LabelCoreApi;
}
