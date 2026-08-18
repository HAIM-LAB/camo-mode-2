/**
 * Research inspector.
 *
 * A tuning instrument for the captain, not a feature: it is off by default,
 * built lazily on first open, and must never appear in a demo run. Toggle with
 * the backtick key, or start with `?debug=1`.
 *
 * It answers the four questions that come up while tuning a storylet: where is
 * this character standing, how do they feel, which edge fired last turn and why
 * (a state condition or a classification), and what exactly did the model see.
 */

import { EMOTION_DIMENSIONS, EMOTION_SPECS } from '../emotion';
import type { InspectorSnapshot } from '../session';

const TOGGLE_KEY = '`';

export class DialogueInspector {
  private root?: HTMLElement;
  private body?: HTMLElement;
  private visible = false;

  constructor(private readonly read: () => InspectorSnapshot | undefined) {
    this.visible = new URLSearchParams(window.location.search).get('debug') === '1';

    window.addEventListener('keydown', (event) => {
      if (event.key !== TOGGLE_KEY) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
      event.preventDefault();
      this.toggle();
    });

    if (this.visible) this.render();
  }

  get isVisible(): boolean {
    return this.visible;
  }

  toggle(): void {
    this.visible = !this.visible;
    if (this.visible) this.render();
    else if (this.root) this.root.hidden = true;
  }

  /** Called after every turn. A no-op while hidden, which is the demo case. */
  update(): void {
    if (this.visible) this.render();
  }

  private ensureRoot(): HTMLElement {
    if (this.root) return this.root;

    const root = document.createElement('aside');
    root.className = 'inspector';
    root.id = 'dialogue-inspector';
    root.setAttribute('aria-label', 'Dialogue debug inspector');

    const heading = document.createElement('h2');
    heading.textContent = 'Dialogue inspector';

    const hint = document.createElement('div');
    hint.className = 'inspector-hint';
    hint.textContent = 'Backtick toggles. Off in demo runs.';

    const body = document.createElement('div');
    root.append(heading, hint, body);
    document.getElementById('app')?.append(root);

    this.root = root;
    this.body = body;
    return root;
  }

  private render(): void {
    const root = this.ensureRoot();
    root.hidden = false;
    const body = this.body;
    if (!body) return;

    const snapshot = this.read();
    if (!snapshot) {
      body.replaceChildren(text('div', 'inspector-hint', 'No conversation open.'));
      return;
    }

    body.replaceChildren(
      section('Position', [
        definitionList([
          ['brain', snapshot.brainLabel],
          ['persona', `${snapshot.characterName} (${snapshot.personaId})`],
          ['storylet', snapshot.storyletId],
          ['node', snapshot.nodeId],
          ['beat goal', snapshot.beatGoal],
          ['turns here', String(snapshot.turnsInNode)],
        ]),
      ]),
      section('Emotion', EMOTION_DIMENSIONS.map((dimension) =>
        meter(EMOTION_SPECS[dimension].label, snapshot.emotion[dimension]),
      )),
      section('State', [
        definitionList([
          ...Object.entries(snapshot.variables).map(
            ([name, value]) => [name, value.toFixed(2)] as [string, string],
          ),
          ...Object.entries(snapshot.flags).map(
            ([name, value]) => [name, value ? 'true' : 'false'] as [string, string],
          ),
        ]),
      ]),
      section('Last turn', this.renderDecision(snapshot)),
      section('Assembled prompt', [preformatted(snapshot.lastPrompt)]),
      ...(snapshot.sceneReactions.length > 0
        ? [section('Scene reactions at greeting', [list(snapshot.sceneReactions)])]
        : []),
    );
  }

  private renderDecision(snapshot: InspectorSnapshot): HTMLElement[] {
    const decision = snapshot.lastDecision;
    if (!decision) return [text('div', 'inspector-hint', 'No turn resolved yet.')];

    const tag = document.createElement('span');
    tag.className = `inspector-tag inspector-tag--${decision.method}`;
    tag.textContent = decision.method;

    const rows: [string, string][] = [['reason', decision.reason]];
    if (decision.offered) rows.push(['offered', decision.offered.join(', ')]);
    if (decision.classifierAnswer) rows.push(['classifier said', decision.classifierAnswer]);
    if (snapshot.lastEdge) {
      rows.unshift([
        'edge',
        `${snapshot.lastEdge.fromNodeId} -> ${snapshot.lastEdge.toNodeId} via ${snapshot.lastEdge.edgeId}`,
      ]);
    }

    const header = document.createElement('div');
    header.append(tag);
    return [header, definitionList(rows)];
  }
}

function text(tag: string, className: string, content: string): HTMLElement {
  const element = document.createElement(tag);
  element.className = className;
  element.textContent = content;
  return element;
}

function section(title: string, children: HTMLElement[]): HTMLElement {
  const element = document.createElement('section');
  const heading = document.createElement('h2');
  heading.textContent = title;
  element.append(heading, ...children);
  return element;
}

function definitionList(rows: readonly [string, string][]): HTMLElement {
  const list = document.createElement('dl');
  for (const [term, value] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = term;
    const dd = document.createElement('dd');
    dd.textContent = value;
    list.append(dt, dd);
  }
  return list;
}

function meter(label: string, value: number): HTMLElement {
  const row = document.createElement('div');
  row.className = 'inspector-meter';

  const name = document.createElement('span');
  name.textContent = label;

  const bar = document.createElement('b');
  bar.style.setProperty('--fill', `${Math.round(value * 100)}%`);

  const readout = document.createElement('em');
  readout.textContent = value.toFixed(2);

  row.append(name, bar, readout);
  return row;
}

function list(items: readonly string[]): HTMLElement {
  const element = document.createElement('div');
  for (const item of items) element.append(text('div', '', item));
  return element;
}

function preformatted(content: string): HTMLElement {
  const element = document.createElement('pre');
  element.textContent = content || '(nothing assembled yet)';
  return element;
}
