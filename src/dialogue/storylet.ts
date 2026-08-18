/**
 * Storylet graph schema and validation.
 *
 * A storylet is an authored map of how a social interaction normally moves
 * forward. Nodes are beats; edges are how a beat can hand off to the next one.
 * The runtime in `interpreter.ts` walks it; the model only ever sees the node it
 * is standing on.
 *
 * The schema deliberately does not know about greetings, tension, or repair. The
 * shipped example (`data/storylets/*.jsonc`) models that arc, but any arc the
 * captain authors is equally valid.
 */

import { EMOTION_DIMENSIONS, type EmotionDimension, type EmotionNudge } from './emotion';
import { parseJsonc } from './jsonc';
import { Validator } from './validate';

export const COMPARISONS = ['<', '<=', '==', '!=', '>=', '>'] as const;
export type Comparison = (typeof COMPARISONS)[number];

export const CONDITION_KINDS = [
  'always',
  'variable',
  'emotion',
  'flag',
  'turnsInNode',
  'all',
  'any',
  'not',
  'intent',
] as const;
export type ConditionKind = (typeof CONDITION_KINDS)[number];

export type Condition =
  | { kind: 'always' }
  | { kind: 'variable'; name: string; op: Comparison; value: number }
  | { kind: 'emotion'; dimension: EmotionDimension; op: Comparison; value: number }
  | { kind: 'flag'; name: string; value: boolean }
  | { kind: 'turnsInNode'; op: Comparison; value: number }
  | { kind: 'all'; of: Condition[] }
  | { kind: 'any'; of: Condition[] }
  | { kind: 'not'; of: Condition }
  /**
   * The only condition that cannot be decided from state. It falls through to a
   * small constrained classification call. `description` is what the classifier is
   * told to look for in the child's words.
   */
  | { kind: 'intent'; description: string };

export interface VariableEffect {
  name: string;
  /** Additive. Mutually exclusive with `set`. */
  delta?: number;
  /** Absolute assignment. */
  set?: number;
}

export interface FlagEffect {
  name: string;
  value: boolean;
}

export interface Effect {
  emotion?: EmotionNudge;
  variables?: VariableEffect[];
  flags?: FlagEffect[];
}

export interface StoryletEdge {
  id: string;
  to: string;
  when: Condition;
  /** Author's plain-language reason. Surfaced verbatim in the debug inspector. */
  why: string;
  effects?: Effect;
}

export interface StoryletNode {
  id: string;
  /** What the character is trying to do in this beat. Goes into the prompt. */
  beatGoal: string;
  /** Hard limits on this beat, e.g. "do not ask the child to fix it". */
  constraints: string[];
  onEnter?: Effect;
  onExit?: Effect;
  /** A beat the conversation can rest in. No edges are required. */
  terminal?: boolean;
  edges: StoryletEdge[];
}

export interface StoryletVariable {
  name: string;
  initial: number;
  min: number;
  max: number;
  description: string;
}

export interface StoryletFlag {
  name: string;
  initial: boolean;
  description: string;
}

export interface StoryletGraph {
  id: string;
  title: string;
  entryNode: string;
  variables: StoryletVariable[];
  flags: StoryletFlag[];
  nodes: StoryletNode[];
}

/** True when a condition can be decided from game state with no model call. */
export function isDeterministic(condition: Condition): boolean {
  switch (condition.kind) {
    case 'intent':
      return false;
    case 'all':
    case 'any':
      return condition.of.every(isDeterministic);
    case 'not':
      return isDeterministic(condition.of);
    default:
      return true;
  }
}

function parseCondition(validator: Validator, raw: unknown, path: string): Condition {
  const object = validator.object(raw, path);
  const kind = validator.oneOf(object.kind, `${path}.kind`, CONDITION_KINDS);

  switch (kind) {
    case 'always':
      return { kind: 'always' };
    case 'variable':
      return {
        kind: 'variable',
        name: validator.identifier(object.name, `${path}.name`),
        op: validator.oneOf(object.op, `${path}.op`, COMPARISONS),
        value: validator.number(object.value, `${path}.value`, { min: -1000, max: 1000 }),
      };
    case 'emotion':
      return {
        kind: 'emotion',
        dimension: validator.oneOf(object.dimension, `${path}.dimension`, EMOTION_DIMENSIONS),
        op: validator.oneOf(object.op, `${path}.op`, COMPARISONS),
        value: validator.number(object.value, `${path}.value`, { min: 0, max: 1 }),
      };
    case 'flag':
      return {
        kind: 'flag',
        name: validator.identifier(object.name, `${path}.name`),
        value: validator.boolean(object.value, `${path}.value`, true),
      };
    case 'turnsInNode':
      return {
        kind: 'turnsInNode',
        op: validator.oneOf(object.op, `${path}.op`, COMPARISONS),
        value: validator.integer(object.value, `${path}.value`, { min: 0, max: 100 }),
      };
    case 'all':
    case 'any': {
      const items = validator.array(object.of, `${path}.of`, { minLength: 1 });
      return {
        kind,
        of: items.map((item, index) => parseCondition(validator, item, `${path}.of[${index}]`)),
      };
    }
    case 'not':
      return { kind: 'not', of: parseCondition(validator, object.of, `${path}.of`) };
    case 'intent':
      return {
        kind: 'intent',
        description: validator.string(object.description, `${path}.description`, { minLength: 10 }),
      };
  }
}

function parseEffect(validator: Validator, raw: unknown, path: string): Effect | undefined {
  if (raw === undefined || raw === null) return undefined;
  const object = validator.object(raw, path);
  const effect: Effect = {};

  if (object.emotion !== undefined) {
    const emotionRaw = validator.object(object.emotion, `${path}.emotion`);
    const nudge: EmotionNudge = {};
    for (const [key, value] of Object.entries(emotionRaw)) {
      const dimension = validator.oneOf(key, `${path}.emotion (key)`, EMOTION_DIMENSIONS);
      nudge[dimension] = validator.number(value, `${path}.emotion.${key}`, { min: -1, max: 1 });
    }
    effect.emotion = nudge;
  }

  if (object.variables !== undefined) {
    const items = validator.array(object.variables, `${path}.variables`);
    effect.variables = items.map((item, index) => {
      const itemPath = `${path}.variables[${index}]`;
      const entry = validator.object(item, itemPath);
      const hasDelta = entry.delta !== undefined;
      const hasSet = entry.set !== undefined;
      if (hasDelta === hasSet) {
        validator.fail(itemPath, 'must specify exactly one of "delta" or "set"');
      }
      return {
        name: validator.identifier(entry.name, `${itemPath}.name`),
        ...(hasDelta
          ? { delta: validator.number(entry.delta, `${itemPath}.delta`, { min: -100, max: 100 }) }
          : {}),
        ...(hasSet
          ? { set: validator.number(entry.set, `${itemPath}.set`, { min: -100, max: 100 }) }
          : {}),
      };
    });
  }

  if (object.flags !== undefined) {
    const items = validator.array(object.flags, `${path}.flags`);
    effect.flags = items.map((item, index) => {
      const itemPath = `${path}.flags[${index}]`;
      const entry = validator.object(item, itemPath);
      return {
        name: validator.identifier(entry.name, `${itemPath}.name`),
        value: validator.boolean(entry.value, `${itemPath}.value`, true),
      };
    });
  }

  return effect;
}

/** Validates one storylet document. Collects every issue before throwing. */
export function parseStorylet(raw: unknown, sourceName: string): StoryletGraph {
  const validator = new Validator(sourceName);
  const root = validator.object(raw, 'storylet');

  const variables = validator.array(root.variables, 'variables').map((item, index) => {
    const path = `variables[${index}]`;
    const entry = validator.object(item, path);
    const min = validator.number(entry.min, `${path}.min`, { min: -100, max: 100 });
    const max = validator.number(entry.max, `${path}.max`, { min: -100, max: 100 });
    if (min > max) validator.fail(path, `min (${min}) must not exceed max (${max})`);
    return {
      name: validator.identifier(entry.name, `${path}.name`),
      initial: validator.number(entry.initial, `${path}.initial`, { min, max: Math.max(min, max) }),
      min,
      max,
      description: validator.string(entry.description, `${path}.description`, { minLength: 8 }),
    };
  });

  const flags = validator.array(root.flags, 'flags').map((item, index) => {
    const path = `flags[${index}]`;
    const entry = validator.object(item, path);
    return {
      name: validator.identifier(entry.name, `${path}.name`),
      initial: validator.boolean(entry.initial, `${path}.initial`),
      description: validator.string(entry.description, `${path}.description`, { minLength: 8 }),
    };
  });

  const nodes = validator.array(root.nodes, 'nodes', { minLength: 1 }).map((item, index) => {
    const path = `nodes[${index}]`;
    const entry = validator.object(item, path);
    const id = validator.identifier(entry.id, `${path}.id`);
    const terminal = entry.terminal === undefined ? false : validator.boolean(entry.terminal, `${path}.terminal`);

    const edges = validator.array(entry.edges ?? [], `${path}.edges`).map((edgeItem, edgeIndex) => {
      const edgePath = `${path}.edges[${edgeIndex}]`;
      const edgeEntry = validator.object(edgeItem, edgePath);
      return {
        id: validator.identifier(edgeEntry.id, `${edgePath}.id`),
        to: validator.identifier(edgeEntry.to, `${edgePath}.to`),
        when: parseCondition(validator, edgeEntry.when, `${edgePath}.when`),
        why: validator.string(edgeEntry.why, `${edgePath}.why`, { minLength: 8 }),
        effects: parseEffect(validator, edgeEntry.effects, `${edgePath}.effects`),
      } satisfies StoryletEdge;
    });

    if (!terminal && edges.length === 0) {
      validator.fail(
        path,
        `node "${id}" has no edges. Give it at least one edge, or mark it "terminal": true if the conversation is meant to rest here.`,
      );
    }

    return {
      id,
      beatGoal: validator.string(entry.beatGoal, `${path}.beatGoal`, { minLength: 12 }),
      constraints: validator.stringArray(entry.constraints, `${path}.constraints`, { minLength: 1 }),
      onEnter: parseEffect(validator, entry.onEnter, `${path}.onEnter`),
      onExit: parseEffect(validator, entry.onExit, `${path}.onExit`),
      terminal,
      edges,
    } satisfies StoryletNode;
  });

  const graph: StoryletGraph = {
    id: validator.identifier(root.id, 'id'),
    title: validator.string(root.title, 'title', { minLength: 4 }),
    entryNode: validator.identifier(root.entryNode, 'entryNode'),
    variables,
    flags,
    nodes,
  };

  checkReferentialIntegrity(validator, graph);
  validator.throwIfInvalid();
  return graph;
}

/**
 * The checks that turn a graph from "well-typed" into "walkable": unique ids,
 * every edge target real, every variable and flag declared before use.
 */
function checkReferentialIntegrity(validator: Validator, graph: StoryletGraph): void {
  const nodeIds = new Set<string>();
  for (const node of graph.nodes) {
    if (nodeIds.has(node.id)) validator.fail(`nodes.${node.id}`, 'duplicate node id');
    nodeIds.add(node.id);
  }

  const variableNames = new Set(graph.variables.map((variable) => variable.name));
  const flagNames = new Set(graph.flags.map((flag) => flag.name));

  if (!nodeIds.has(graph.entryNode)) {
    validator.fail(
      'entryNode',
      `"${graph.entryNode}" is not a node in this graph. Known nodes: ${[...nodeIds].join(', ') || '(none)'}`,
    );
  }

  const walkCondition = (condition: Condition, path: string): void => {
    switch (condition.kind) {
      case 'variable':
        if (!variableNames.has(condition.name)) {
          validator.fail(path, `variable "${condition.name}" is not declared in "variables"`);
        }
        break;
      case 'flag':
        if (!flagNames.has(condition.name)) {
          validator.fail(path, `flag "${condition.name}" is not declared in "flags"`);
        }
        break;
      case 'all':
      case 'any':
        condition.of.forEach((child, index) => walkCondition(child, `${path}.of[${index}]`));
        break;
      case 'not':
        walkCondition(condition.of, `${path}.of`);
        break;
      default:
        break;
    }
  };

  const walkEffect = (effect: Effect | undefined, path: string): void => {
    for (const variable of effect?.variables ?? []) {
      if (!variableNames.has(variable.name)) {
        validator.fail(path, `variable "${variable.name}" is not declared in "variables"`);
      }
    }
    for (const flag of effect?.flags ?? []) {
      if (!flagNames.has(flag.name)) {
        validator.fail(path, `flag "${flag.name}" is not declared in "flags"`);
      }
    }
  };

  for (const node of graph.nodes) {
    walkEffect(node.onEnter, `nodes.${node.id}.onEnter`);
    walkEffect(node.onExit, `nodes.${node.id}.onExit`);
    const edgeIds = new Set<string>();
    for (const edge of node.edges) {
      const path = `nodes.${node.id}.edges.${edge.id}`;
      if (edgeIds.has(edge.id)) validator.fail(path, 'duplicate edge id within this node');
      edgeIds.add(edge.id);
      if (!nodeIds.has(edge.to)) {
        validator.fail(path, `targets "${edge.to}", which is not a node in this graph`);
      }
      walkCondition(edge.when, `${path}.when`);
      walkEffect(edge.effects, `${path}.effects`);
    }
  }
}

export function parseStoryletSource(source: string, sourceName: string): StoryletGraph {
  return parseStorylet(parseJsonc<unknown>(source, sourceName), sourceName);
}

export function findNode(graph: StoryletGraph, nodeId: string): StoryletNode {
  const node = graph.nodes.find((item) => item.id === nodeId);
  if (!node) throw new Error(`Storylet "${graph.id}" has no node "${nodeId}"`);
  return node;
}
