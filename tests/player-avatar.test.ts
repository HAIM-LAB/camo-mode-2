import { describe, expect, it } from 'vitest';
import { Object3D, PropertyBinding } from 'three';
import { PlayerAvatar } from '../src/player-avatar';
import { DEFAULT_PLAYER_LOOK, PLAYER_STYLES, PlayerStyleId } from '../src/player-look';
import { loadPlayerModel, shownParts } from './helpers/player-model';

const STYLES = PLAYER_STYLES.map((style) => style.id);
const FRAME = 1 / 60;

/** A leg joint each style's walk clip swings. */
const LEG: Readonly<Record<PlayerStyleId, string>> = { cartoon: 'pivot_leg_L', realistic: 'thigh_l' };
/** How far each style's idle clip may turn that leg: the feet stay planted. */
const STILL_LEG_TURN = 0.06;

async function boundAvatar(style: PlayerStyleId): Promise<{ avatar: PlayerAvatar; model: Object3D }> {
  const avatar = new PlayerAvatar({ ...DEFAULT_PLAYER_LOOK, style });
  const model = await loadPlayerModel(style);
  avatar.prepare(model);
  return { avatar, model };
}

function joint(model: Object3D, name: string): Object3D {
  const found = model.getObjectByName(name);
  if (!found) throw new Error(`No joint named ${name}`);
  return found;
}

/** The widest angle a joint turns away from its first pose over a stretch of animation. */
function widestTurn(avatar: PlayerAvatar, target: Object3D, seconds: number, speed: number): number {
  const start = target.quaternion.clone();
  let widest = 0;
  for (let elapsed = 0; elapsed < seconds; elapsed += FRAME) {
    avatar.update(FRAME, speed);
    widest = Math.max(widest, start.angleTo(target.quaternion));
  }
  return widest;
}

describe('player avatar', () => {
  it.each(STYLES)('binds every track of the %s model\'s idle and walk clips to a joint it has', async (style) => {
    const model = await loadPlayerModel(style);
    expect(model.animations.map((clip) => clip.name).sort()).toEqual(['idle', 'walk']);
    for (const clip of model.animations) {
      expect(clip.duration, clip.name).toBeGreaterThan(0.3);
      expect(clip.tracks.length, clip.name).toBeGreaterThan(0);
      // A clip that started late would hold its first frame on every loop,
      // and the walk's stride would no longer match its speed.
      expect(Math.min(...clip.tracks.map((track) => track.times[0])), clip.name).toBe(0);
      for (const track of clip.tracks) {
        const { nodeName } = PropertyBinding.parseTrackName(track.name);
        expect(model.getObjectByName(nodeName), `${clip.name} ${track.name}`).toBeDefined();
      }
    }
  });

  it.each(STYLES)('stands, walks, and stands again on the %s model', async (style) => {
    const { avatar, model } = await boundAvatar(style);
    const leg = joint(model, LEG[style]);
    expect(avatar.motion).toBe('idle');

    // Standing: the idle clip plays and the legs stay where they are.
    expect(widestTurn(avatar, leg, 2, 0)).toBeLessThan(STILL_LEG_TURN);
    expect(avatar.motion).toBe('idle');

    // Walking at the style's own speed: the legs swing through a real stride.
    expect(widestTurn(avatar, leg, 1.5, avatar.moveSpeed)).toBeGreaterThan(0.3);
    expect(avatar.motion).toBe('walk');

    // Stopping blends back to the stand rather than freezing mid-stride.
    widestTurn(avatar, leg, 1.5, 0);
    expect(avatar.motion).toBe('idle');
    expect(widestTurn(avatar, leg, 1, 0)).toBeLessThan(STILL_LEG_TURN);
  });

  it.each(STYLES)('poses the %s model as soon as it is prepared and dresses it in the look', async (style) => {
    const avatar = new PlayerAvatar({ ...DEFAULT_PLAYER_LOOK, style, gender: 'girl', headwear: 'scarf' });
    const model = await loadPlayerModel(style);
    const leg = joint(model, LEG[style]);
    const bind = leg.quaternion.clone();

    avatar.prepare(model);

    // The idle pose is a small step from the bind pose, never a different stance.
    expect(bind.angleTo(leg.quaternion)).toBeLessThan(STILL_LEG_TURN);
    expect(shownParts(model, 'player_scarf_').length).toBeGreaterThan(0);
    expect(shownParts(model, 'player_hair_')).toEqual([]);
  });

  it('hops the stand-in while it moves and rests it when it stops', () => {
    const avatar = new PlayerAvatar(DEFAULT_PLAYER_LOOK);
    expect(avatar.motion).toBe('stand-in');

    let highest = 0;
    for (let frame = 0; frame < 30; frame += 1) {
      avatar.update(FRAME, 2.75);
      highest = Math.max(highest, avatar.visual.position.y);
    }
    expect(highest).toBeGreaterThan(0.02);

    avatar.update(FRAME, 0);
    expect(avatar.visual.position.y).toBe(0);
  });

  it('falls back to the hop for a model that carries no clips', () => {
    const avatar = new PlayerAvatar(DEFAULT_PLAYER_LOOK);
    avatar.prepare(new Object3D());
    expect(avatar.motion).toBe('stand-in');
  });

  it('moves the realistic child at a walking pace and the cartoon player faster', () => {
    const cartoon = new PlayerAvatar(DEFAULT_PLAYER_LOOK);
    const realistic = new PlayerAvatar({ ...DEFAULT_PLAYER_LOOK, style: 'realistic' });
    expect(cartoon.moveSpeed).toBe(2.75);
    // An easy walk, well short of the cartoon player's scamper.
    expect(realistic.moveSpeed).toBeGreaterThan(1);
    expect(realistic.moveSpeed).toBeLessThan(2);
  });

  it('moves the realistic child at the speed its walk clip plants its feet for', async () => {
    const { avatar, model } = await boundAvatar('realistic');
    // The generator records the clip's ground speed on the rig; at any other
    // speed the feet would slide.
    expect(joint(model, 'player_rig').userData.walk_speed).toBeCloseTo(avatar.moveSpeed, 2);
  });

  it.each(STYLES)('reports the %s model\'s height once it is prepared, for framing it', async (style) => {
    const { avatar } = await boundAvatar(style);
    // Both stand about as tall as the rest of the cast.
    const [low, high] = style === 'cartoon' ? [1.25, 1.36] : [1.33, 1.43];
    expect(avatar.height).toBeGreaterThan(low);
    expect(avatar.height).toBeLessThan(high);
  });

  it('carries toys lower in front of the short cartoon player than the realistic one', () => {
    const cartoon = new PlayerAvatar(DEFAULT_PLAYER_LOOK).carryPosition;
    const realistic = new PlayerAvatar({ ...DEFAULT_PLAYER_LOOK, style: 'realistic' }).carryPosition;
    expect(cartoon.y).toBeLessThan(realistic.y);
    for (const position of [cartoon, realistic]) {
      expect(position.x).toBe(0);
      expect(position.z).toBeGreaterThan(0.25);
    }
  });

  it('re-dresses in place but refuses to change style, which needs another model', () => {
    const avatar = new PlayerAvatar(DEFAULT_PLAYER_LOOK);
    avatar.setLook({ ...DEFAULT_PLAYER_LOOK, headwear: 'scarf' });
    expect(shownParts(avatar.visual, 'player_scarf_')).toEqual(['player_scarf_fallback']);
    avatar.setLook({ ...DEFAULT_PLAYER_LOOK, headwear: 'none' });
    expect(shownParts(avatar.visual, 'player_scarf_')).toEqual([]);
    expect(shownParts(avatar.visual, 'player_bare_')).toEqual(['player_bare_hair_fallback']);
    expect(() => avatar.setLook({ ...DEFAULT_PLAYER_LOOK, style: 'realistic' })).toThrow(/style/);
  });
});
