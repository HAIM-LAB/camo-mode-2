# Integrated scene review

All frames captured from the running Vite app with `chrome-devtools-axi` at a
1440 × 900 laptop viewport.

## [`integrated-scene.png`](integrated-scene.png)

The reset opening composition after all seven approved GLBs reported loaded.
Camo and the player together on the carpet left of the coffee table, Friend A
inside beside the couch, Friend B on the patio through the doorway, and both
pickup props on the rug.

This frame and the dialogue captures below predate the cast's two styles and
still show the earlier chunky characters; [`cast/`](cast/) shows the playroom
as it is now, in each style. The dialogue layer itself is unchanged;
[`menus/19-realistic-mock-dialogue.png`](menus/19-realistic-mock-dialogue.png)
shows it with a current player.

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

---

## Menus, styles, and character customization

The frames in [`menus/`](menus/) were captured on the keyless mock brain with
`chrome-devtools-axi`, at 1440 × 900 and at a 390 × 844 phone viewport. The
close-ups are crops of the same page at twice the pixel density.

- `01`, `02`: the start menu, then the style choice. Each card shows its
  character live, idling, in the child's current look.
- `03`–`05`: the cartoon player in customization: the default look, Girl ·
  skirt · beanie, and Boy · trousers · head scarf.
- `06b`–`08`: the cartoon player in the playroom from behind and from the
  front, and mid-stride in its walk clip.
- `09`: after a reload the style and look are restored, and both cards wear
  the look.
- `11`–`13`: the realistic player in customization: the default look, Girl ·
  skirt · beanie, and Girl · skirt · head scarf.
- `15b`–`17`: the realistic player in the playroom from behind and from the
  front, and mid-stride in its easy walk. It stands as tall as the rest of the
  cast.
- `32`: the realistic player carrying the ball.
- `18`, `19`: `?skipMenu=1` enters the room in the saved style, and a Camo
  conversation on the mock brain.
- `20`: a look saved before styles existed loads as the cartoon player with
  every choice kept.
- `21`, `22`: the phone layout of the style choice and of customization.
- `24`–`30`: each character standing, from the front and from the side, in
  trousers and (front only) in the skirt. The arms and hands hang clear of the
  body with a visible gap. These were captured with reduced motion forced, so
  the preview holds still at the front in the rest pose; both generators also
  measure that gap through every frame of the idle and walk clips.
- `33`–`36`: nothing on the head, the third choice beside the beanie and the
  head scarf: the cartoon Boy and Girl, then the realistic Boy and Girl, in
  customization. Captured with reduced motion forced, like `24`–`30`.
- `37`–`40`: the same four bare-headed characters turned to the front, the
  side, and the back in customization.
- `41`–`44`: the same four in the playroom, under its camera, from the front,
  the side, and behind.

The playroom frames in this set were captured before Camo and the friends had
a model per style, so the Camo and friends in them are the earlier chunky
ones. The player in them is current; [`cast/`](cast/) shows the cast as it is
now.

Both characters were reviewed for age-appropriateness in every combination:
- one shared child body per style, with Boy and Girl differing only in hair;
- everyday clothes that cover the torso, arms, and legs;
- skirts at or below the knee over leggings;
- a full head covering that frames the face;
- on a bare head, a child's everyday hair over the whole scalp from every
  side: a bob with a fringe on the cartoon player, and short or long hair on
  the realistic one;
- on the realistic player, a young child's proportions and round face with a
  slight closed-mouth smile and relaxed eyes.

---

The frames below show the cast in each style, captured from the running app
on the keyless mock brain, with the player stepped aside from the opening
position so that Camo is in view.

## [`cast/cartoon.png`](cast/cartoon.png)

The Cartoon style: the cartoon player with Camo on the rug, Friend A by the
couch, and Friend B on the patio, all drawn with the same kit. Each name label
sits over its character.

## [`cast/realistic.png`](cast/realistic.png)

The Realistic style, from the same spot: the realistic player, the sculpted
Camo, and both friends as children of the player's age and build. Only this
style's four character models were requested.
