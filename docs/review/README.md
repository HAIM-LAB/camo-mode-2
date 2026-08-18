# Integrated scene review

All frames captured from the running Vite app with `chrome-devtools-axi` at a
1440 × 900 laptop viewport.

## [`integrated-scene.png`](integrated-scene.png)

The reset opening composition after all seven approved GLBs reported loaded.
Camo and the player together on the carpet left of the coffee table, Friend A
inside beside the couch, Friend B on the patio through the doorway, and both
pickup props on the rug.

## [`dialogue-panel.png`](dialogue-panel.png)

A conversation with Camo, four turns in, running on the **keyless mock brain**
with no `.env` present. The panel is deliberately short so the follow camera's
framing of Camo and the player stays visible above it. The exchange shown reached
the `repair` beat by classification after the child offered to help.

## [`dialogue-inspector.png`](dialogue-inspector.png)

The same moment with the research inspector open (backtick key, or `?debug=1`;
off by default and never shown in a demo run). It reports the current beat and
its goal, the live emotion vector, the relationship variables and scene flags,
and the last transition — here `tension-surfaces -> repair` via
`child-offers-help`, tagged `CLASSIFICATION`, with the authored reason, the three
edge ids offered to the classifier, and its raw answer.

---

The frames below were captured during the **live-provider** pass, against a real
`OPENAI_API_KEY` rather than the keyless mock. See
[`../dialogue-architecture.md`](../dialogue-architecture.md#live-provider-verification)
for what was exercised and the measured latency.

## [`live-dialogue-openai.png`](live-dialogue-openai.png)

A real conversation with Camo streamed from OpenAI, two child turns in and
standing on the `topic-raised` beat. Camo answers the question without claiming
to have a fix — "I can't fix things. I just watch." — which is the authored
constraint holding under a live model rather than a scripted one.

## [`live-inspector-openai.png`](live-inspector-openai.png)

The same moment with the inspector open. `LAST TURN` is tagged `CLASSIFICATION`:
the child's words were genuinely read by a structured call, which chose
`child-asks-about-friends` from the edges this beat permits, moved
`greeting -> topic-raised`, and set the `topic-known` flag. The `offered` and
`classifier said` rows show the constraint working — the classifier only ever saw
edge ids the graph allows.

## [`live-inspector-prompt.png`](live-inspector-prompt.png)

The inspector scrolled to `ASSEMBLED PROMPT`, showing what the model actually
received for that turn: the character and beat markers, and the persona rendered
as behavioural instruction. Note the beat marker reads `# BEAT: greeting` — the
prompt is from the turn that produced the transition, so it shows the beat the
character was standing on when it spoke, not the one it landed in.
