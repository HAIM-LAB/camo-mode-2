/**
 * Storylet runtime: position, effects, and hybrid edge resolution.
 *
 * The rule that matters, and the one the unit tests pin down:
 *
 *   **A transition can only ever be an edge the current node declares.**
 *
 * Deterministic conditions are evaluated first, in authored order. Only edges
 * that genuinely need to read free-text intent fall through to a classification
 * call, and that call is handed the allowed edge ids and nothing else. If the
 * classifier returns an id outside that set, returns nothing, or throws, the
 * conversation *stays on the current node*. It never guesses.
 */

import { EmotionState, type EmotionVector } from './emotion';
import {
  findNode,
  isDeterministic,
  type Comparison,
  type Condition,
  type Effect,
  type StoryletEdge,
  type StoryletGraph,
  type StoryletNode,
} from './storylet';

export interface StoryletVariables {
  [name: string]: number;
}

export interface StoryletFlags {
  [name: string]: boolean;
}

/** Everything the runtime needs to decide an edge, with no model involved. */
export interface EvaluationContext {
  turnsInNode: number;
  variables: Readonly<StoryletVariables>;
  flags: Readonly<StoryletFlags>;
  emotion: Readonly<EmotionVector>;
}

export type ResolutionMethod = 'condition' | 'classification' | 'stay';

export interface EdgeResolution {
  edge?: StoryletEdge;
  method: ResolutionMethod;
  /** Inspector copy: exactly why this happened. */
  reason: string;
  /** Edge ids that were offered to the classifier, when one ran. */
  offered?: string[];
  /** Raw classifier answer, for the inspector. */
  classifierAnswer?: string;
}

/**
 * Decides one intent edge from the child's words. Implementations get only the
 * edges the graph permits; returning anything else is treated as a failure.
 */
export type IntentClassifier = (input: {
  nodeId: string;
  childUtterance: string;
  characterReply: string;
  candidates: readonly { id: string; description: string }[];
}) => Promise<string | undefined>;

function compare(left: number, op: Comparison, right: number): boolean {
  switch (op) {
    case '<':
      return left < right;
    case '<=':
      return left <= right;
    case '==':
      return left === right;
    case '!=':
      return left !== right;
    case '>=':
      return left >= right;
    case '>':
      return left > right;
  }
}

/** Evaluates a deterministic condition. Intent conditions are never true here. */
export function evaluateCondition(condition: Condition, context: EvaluationContext): boolean {
  switch (condition.kind) {
    case 'always':
      return true;
    case 'variable':
      return compare(context.variables[condition.name] ?? 0, condition.op, condition.value);
    case 'emotion':
      return compare(context.emotion[condition.dimension] ?? 0, condition.op, condition.value);
    case 'flag':
      return (context.flags[condition.name] ?? false) === condition.value;
    case 'turnsInNode':
      return compare(context.turnsInNode, condition.op, condition.value);
    case 'all':
      return condition.of.every((child) => evaluateCondition(child, context));
    case 'any':
      return condition.of.some((child) => evaluateCondition(child, context));
    case 'not':
      return !evaluateCondition(condition.of, context);
    case 'intent':
      // Not decidable from state. `resolveEdge` routes these to the classifier.
      return false;
  }
}

export interface ResolveEdgeInput {
  node: StoryletNode;
  context: EvaluationContext;
  childUtterance: string;
  characterReply: string;
  classifier?: IntentClassifier;
}

/** The hybrid rule. See the module comment. */
export async function resolveEdge(input: ResolveEdgeInput): Promise<EdgeResolution> {
  const { node, context } = input;

  for (const edge of node.edges) {
    if (!isDeterministic(edge.when)) continue;
    if (evaluateCondition(edge.when, context)) {
      return {
        edge,
        method: 'condition',
        reason: `state condition on "${edge.id}" was true - ${edge.why}`,
      };
    }
  }

  const intentEdges = node.edges.filter(
    (edge): edge is StoryletEdge & { when: { kind: 'intent'; description: string } } =>
      edge.when.kind === 'intent',
  );

  if (intentEdges.length === 0) {
    return {
      method: 'stay',
      reason: 'no state condition matched and this beat has no intent edges',
    };
  }

  if (!input.classifier) {
    return {
      method: 'stay',
      offered: intentEdges.map((edge) => edge.id),
      reason: 'intent edges need a classifier and none was supplied; holding position',
    };
  }

  const candidates = intentEdges.map((edge) => ({
    id: edge.id,
    description: edge.when.description,
  }));

  let answer: string | undefined;
  try {
    answer = await input.classifier({
      nodeId: node.id,
      childUtterance: input.childUtterance,
      characterReply: input.characterReply,
      candidates,
    });
  } catch (error) {
    return {
      method: 'stay',
      offered: candidates.map((candidate) => candidate.id),
      reason: `classifier failed (${error instanceof Error ? error.message : String(error)}); holding position`,
    };
  }

  const chosen = intentEdges.find((edge) => edge.id === answer);
  if (!chosen) {
    return {
      method: 'stay',
      offered: candidates.map((candidate) => candidate.id),
      classifierAnswer: answer,
      reason:
        answer && answer !== 'none'
          ? `classifier answered "${answer}", which this beat does not permit; holding position`
          : 'classifier found no clear intent; holding position',
    };
  }

  return {
    edge: chosen,
    method: 'classification',
    offered: candidates.map((candidate) => candidate.id),
    classifierAnswer: answer,
    reason: `classified the child's turn as "${chosen.id}" - ${chosen.why}`,
  };
}

export interface TransitionRecord {
  fromNodeId: string;
  toNodeId: string;
  edgeId: string;
  method: ResolutionMethod;
  reason: string;
  offered?: string[];
  classifierAnswer?: string;
}

/**
 * One character's live position in their storylet, plus the variables and flags
 * that outlive any single beat.
 */
export class StoryletRuntime {
  readonly emotion: EmotionState;
  private currentNodeId: string;
  private turns = 0;
  private readonly variableState: StoryletVariables = {};
  private readonly flagState: StoryletFlags = {};
  private lastTransition?: TransitionRecord;
  private lastResolution?: EdgeResolution;

  constructor(
    readonly graph: StoryletGraph,
    emotionBaseline: EmotionVector,
  ) {
    this.emotion = new EmotionState(emotionBaseline);
    this.currentNodeId = graph.entryNode;
    for (const variable of graph.variables) this.variableState[variable.name] = variable.initial;
    for (const flag of graph.flags) this.flagState[flag.name] = flag.initial;
    this.applyEffect(findNode(graph, graph.entryNode).onEnter);
  }

  get nodeId(): string {
    return this.currentNodeId;
  }

  get node(): StoryletNode {
    return findNode(this.graph, this.currentNodeId);
  }

  get turnsInNode(): number {
    return this.turns;
  }

  get variables(): Readonly<StoryletVariables> {
    return { ...this.variableState };
  }

  get flags(): Readonly<StoryletFlags> {
    return { ...this.flagState };
  }

  get lastEdge(): TransitionRecord | undefined {
    return this.lastTransition;
  }

  get lastDecision(): EdgeResolution | undefined {
    return this.lastResolution;
  }

  context(): EvaluationContext {
    return {
      turnsInNode: this.turns,
      variables: this.variables,
      flags: this.flags,
      emotion: this.emotion.vector,
    };
  }

  /**
   * Advances one conversational turn: decay the mood, resolve an edge, apply
   * effects. Returns the resolution so the caller can show it in the inspector.
   */
  async advance(input: {
    childUtterance: string;
    characterReply: string;
    classifier?: IntentClassifier;
  }): Promise<EdgeResolution> {
    this.turns += 1;
    this.emotion.decay();

    const resolution = await resolveEdge({
      node: this.node,
      context: this.context(),
      childUtterance: input.childUtterance,
      characterReply: input.characterReply,
      classifier: input.classifier,
    });
    this.lastResolution = resolution;

    if (!resolution.edge) return resolution;

    const from = this.node;
    this.applyEffect(from.onExit);
    this.applyEffect(resolution.edge.effects);
    this.currentNodeId = resolution.edge.to;
    this.turns = 0;
    this.applyEffect(this.node.onEnter);

    this.lastTransition = {
      fromNodeId: from.id,
      toNodeId: this.currentNodeId,
      edgeId: resolution.edge.id,
      method: resolution.method,
      reason: resolution.reason,
      offered: resolution.offered,
      classifierAnswer: resolution.classifierAnswer,
    };
    return resolution;
  }

  applyEffect(effect: Effect | undefined): void {
    if (!effect) return;
    if (effect.emotion) this.emotion.apply(effect.emotion);

    for (const change of effect.variables ?? []) {
      const spec = this.graph.variables.find((variable) => variable.name === change.name);
      const current = this.variableState[change.name] ?? 0;
      const next = change.set !== undefined ? change.set : current + (change.delta ?? 0);
      this.variableState[change.name] = spec
        ? Math.min(spec.max, Math.max(spec.min, next))
        : next;
    }

    for (const change of effect.flags ?? []) {
      this.flagState[change.name] = change.value;
    }
  }
}
