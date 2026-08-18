/**
 * The dialogue panel.
 *
 * Deliberately not a debug console: 15px type in the same rounded, papery card
 * language as the controls card and Camo's bubble, clear speaker attribution on
 * every bubble, a visible thinking state, text that arrives as it streams, and a
 * Leave control that is always one obvious click or one Esc away.
 *
 * It also stays out of the way of the game underneath it: keystrokes inside the
 * input never reach the movement handler, and Esc always gets the child out.
 */

export type PanelSpeaker = 'child' | 'character';

export interface PanelCallbacks {
  onSubmit: (text: string) => void;
  onLeave: () => void;
  onToggleMute: (muted: boolean) => void;
  onToggleMic: (listening: boolean) => void;
}

function required<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Required dialogue element #${id} is missing`);
  return element as T;
}

export class DialoguePanel {
  private readonly root = required<HTMLElement>('dialogue');
  private readonly avatar = required<HTMLElement>('dialogue-avatar');
  private readonly speaker = required<HTMLElement>('dialogue-speaker');
  private readonly log = required<HTMLElement>('dialogue-log');
  private readonly form = required<HTMLFormElement>('dialogue-form');
  private readonly input = required<HTMLInputElement>('dialogue-input');
  private readonly send = required<HTMLButtonElement>('dialogue-send');
  private readonly leave = required<HTMLButtonElement>('dialogue-leave');
  private readonly mute = required<HTMLButtonElement>('dialogue-mute');
  private readonly mic = required<HTMLButtonElement>('dialogue-mic');

  private currentBubble?: HTMLElement;
  private thinkingBubble?: HTMLElement;
  private characterName = '';
  private micListening = false;

  constructor(private readonly callbacks: PanelCallbacks) {
    this.form.addEventListener('submit', (event) => {
      event.preventDefault();
      const text = this.input.value.trim();
      if (!text) return;
      this.input.value = '';
      this.callbacks.onSubmit(text);
    });

    this.leave.addEventListener('click', () => this.callbacks.onLeave());

    this.mute.addEventListener('click', () => {
      const muted = this.mute.getAttribute('aria-pressed') !== 'true';
      this.setMuted(muted);
      this.callbacks.onToggleMute(muted);
    });

    this.mic.addEventListener('click', () => {
      this.micListening = !this.micListening;
      this.setMicListening(this.micListening);
      this.callbacks.onToggleMic(this.micListening);
    });

    // Keys typed at the panel belong to the panel, not to the player. Without
    // this, "walk" in the input box would also walk the avatar across the room.
    for (const type of ['keydown', 'keyup', 'keypress'] as const) {
      this.root.addEventListener(type, (event) => event.stopPropagation());
    }

    this.root.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        this.callbacks.onLeave();
      }
    });
  }

  get isOpen(): boolean {
    return !this.root.hidden;
  }

  get inputElement(): HTMLInputElement {
    return this.input;
  }

  open(options: { characterName: string; entityId: string; voiceAvailable: boolean; micAvailable: boolean }): void {
    this.characterName = options.characterName;
    this.speaker.textContent = options.characterName;
    this.avatar.className = `dialogue__avatar dialogue__avatar--${options.entityId}`;
    this.input.placeholder = `Say something to ${options.characterName}…`;
    this.log.replaceChildren();
    this.currentBubble = undefined;
    this.thinkingBubble = undefined;

    this.mute.hidden = !options.voiceAvailable;
    this.mic.hidden = !options.micAvailable;
    this.setMicListening(false);
    this.micListening = false;

    this.root.hidden = false;
    document.body.dataset.dialogue = 'open';
    this.input.focus();
  }

  close(): void {
    this.root.hidden = true;
    delete document.body.dataset.dialogue;
    this.setThinking(false);
    this.setMicListening(false);
    this.micListening = false;
    this.input.value = '';
    this.input.blur();
  }

  setMuted(muted: boolean): void {
    this.mute.setAttribute('aria-pressed', String(muted));
    const icon = this.mute.querySelector('span[aria-hidden]');
    const label = this.mute.querySelector('.visually-hidden');
    if (icon) icon.textContent = muted ? '🔇' : '🔊';
    const text = muted ? 'Turn the voice on' : 'Turn the voice off';
    this.mute.title = text;
    if (label) label.textContent = text;
  }

  setMicListening(listening: boolean): void {
    this.micListening = listening;
    this.mic.setAttribute('aria-pressed', String(listening));
    const label = this.mic.querySelector('.visually-hidden');
    const text = listening ? 'Stop speaking' : 'Speak instead of typing';
    this.mic.title = text;
    if (label) label.textContent = text;
  }

  /** Shows what the recognizer thinks it heard while the child is still talking. */
  setPartialSpeech(text: string): void {
    this.input.value = text;
  }

  setThinking(thinking: boolean): void {
    this.send.disabled = thinking;
    if (!thinking) {
      this.thinkingBubble?.remove();
      this.thinkingBubble = undefined;
      return;
    }
    if (this.thinkingBubble) return;

    const bubble = document.createElement('div');
    bubble.className = 'bubble bubble--character bubble--thinking';
    bubble.setAttribute('aria-label', `${this.characterName} is thinking`);
    bubble.innerHTML = '<i></i><i></i><i></i>';
    this.log.append(bubble);
    this.thinkingBubble = bubble;
    this.scrollToEnd();
  }

  addChildTurn(text: string): void {
    this.currentBubble = undefined;
    this.append('child', 'You', text);
  }

  /** Appends one streamed, already-moderated sentence to the live reply bubble. */
  addCharacterSentence(text: string): void {
    this.thinkingBubble?.remove();
    this.thinkingBubble = undefined;

    if (!this.currentBubble) {
      this.currentBubble = this.append('character', this.characterName, text);
      return;
    }
    const body = this.currentBubble.querySelector('.bubble__body');
    if (body) body.textContent = `${body.textContent} ${text}`.trim();
    this.scrollToEnd();
  }

  /** Marks the reply finished so the next sentence starts a fresh bubble. */
  endCharacterTurn(): void {
    this.currentBubble = undefined;
  }

  private append(role: PanelSpeaker, name: string, text: string): HTMLElement {
    const bubble = document.createElement('div');
    bubble.className = `bubble bubble--${role}`;

    const label = document.createElement('span');
    label.className = 'bubble__name';
    label.textContent = name;

    const body = document.createElement('span');
    body.className = 'bubble__body';
    body.textContent = text;

    bubble.append(label, body);
    this.log.append(bubble);
    this.scrollToEnd();
    return bubble;
  }

  private scrollToEnd(): void {
    this.log.scrollTop = this.log.scrollHeight;
  }
}
