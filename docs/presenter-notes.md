# Five-minute team demo

## Before presenting

- Use a laptop viewport near 1440 × 900 and start at `http://localhost:4173`. Press **Play**, pick **Understanding Feelings** or **Friendships** (both lead into this room; **Understanding Emotions** is the guessing game below), pick **Cartoon** or **Realistic**, pick a look, then **Let's play!**. To go straight in with the last saved mode, style, and look, start at `http://localhost:4173/?skipMenu=1` instead. That is this room unless the mode picked last was Understanding Emotions.
- Wait for **Ready • approved GLBs 7/7**. If a GLB fails, the demo remains usable but the status pill reports a fallback.
- Reload to reset the player, props, and opening composition. A plain reload returns to the start menu; with `?skipMenu=1` it goes straight back into the room.

## Beat progression

| Time | Presenter beat | Live interaction |
| --- | --- | --- |
| 0:00–0:45 | Establish the approved living room: the player and Camo begin together on the carpet, left of the coffee table. Point out Friend A inside by the couch and Friend B outside on the patio. | Show the opening frame and Camo’s starter bubble. |
| 0:45–1:45 | Hand over control and emphasize choice rather than a forced path. | Use the **Arrow keys** to move around Camo and toward either friend or the toys. |
| 1:45–2:35 | Demonstrate tangible free play. | Approach the ball or block; press **E** to pick it up, move while carrying it, then press **E** to drop it. |
| 2:35–3:35 | Visit both social anchors. Friend A is directly approachable indoors. Friend B stays visibly outside; the patio doorway is the intentional proximity/presentation stop. | Trigger each friend’s labeled proximity cue. Do not imply the yard is navigable. |
| 3:35–5:00 | Frame the prototype as the interaction foundation and narrate the longer-term experience. Finish by returning to Camo or continuing to play with a prop. | Movement, proximity cues, pickup/drop, and conversation are live in this build. |

## Demonstrating conversation

Conversation is live. Slot it in wherever it fits the room, or run it as its own five minutes:

| Beat | Live interaction |
| --- | --- |
| Open a conversation | Stand by Camo and press **T** or click **Talk to Camo**. Camo speaks first; the reply streams in. |
| Show that the child leads | Ask "what happened with your friends?" — Camo raises the falling out rather than being asked to. Or say nothing about it and Camo gets there in their own time. |
| Show that there is no right answer | Offer to help, change the subject, or say "not now". All three are authored beats. Nothing scores one above another. |
| Show that leaving is free | Press **Esc**, or simply walk away mid-sentence. Nothing calls the child back. |
| Show that the room matters | Pick up the ball with **E**, then walk to Friend B on the patio and open a conversation. He turns you away. Put the ball down, come back, and he talks. |
| Show that it left a mark | After Camo raises the topic, walk to either friend: the proximity prompt now acknowledges what the child learned, and still hands the choice back. |

## Demonstrating Understanding Emotions

Pick **Understanding Emotions** on the mode screen, or go back to it from the game with **Menu**.

| Beat | Live interaction |
| --- | --- |
| Show a face round | The camera zooms in on one avatar's face, the face changes, and four named choices wake. Pick the right one: the game celebrates. |
| Show that a wrong guess is safe | Pick a wrong one: the game names the emotion kindly and offers **Try again** and **Next**. Nothing is scored. |
| Show the body rounds | After every emotion has been asked on the face, the same emotions come round with the whole body: a jump, a droop, a step back. |
| Show the way out | **Menu**, or **Esc**, returns to the mode choice at any point. |

**Run the demo with no keys configured** unless a live provider has been checked that morning. The keyless mock brain is deterministic and offline, which is exactly what you want in front of a room.

**Keep the research inspector closed.** It is off by default; the backtick key toggles it. It is a tuning instrument, not part of the demo.

## Interactive versus narrated

**Interactive now:** approved GLB scene loading, third-person Arrow-key/WASD movement, indoor exploration, proximity labels/prompts, **E** pickup/drop for the ball and building block, and LLM-driven conversation with Camo and both friends - authored personas, a mutable emotion state, an authored storylet graph, streamed replies, optional ElevenLabs voice, and optional speech input. In Understanding Emotions, the guessing game with the avatars' facial and whole-body emotions.

**Presenter narration only:** facial animation inside the playroom's conversations, and durable relationship outcomes that persist across sessions. Relationship state is real but lives only for the current page. These are intentionally not represented as working controls in this prototype.
