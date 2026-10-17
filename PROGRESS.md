# Work log

Goals (from the project brief): CS:GO-like weapons, dynamic lighting on characters/viewmodel,
CS:GO-accurate movement, 1v1 across networks, CS-style menu with buy menu (guns, knives, gloves),
clean performant code without duplication.

Each step is saved here when done, so work can resume from the last finished step.

## Plan
1. [x] Review uncommitted work already in the tree (ammo/reload, tracers, view punch, TURN relay, fps counter)
2. [x] Movement: step up stairs (sv_stepsize 18), stay on ground down slopes/stairs, CS:GO
       ground acceleration scale and ground speed clamp
3. [x] Weapons: check damage/armor/range/inaccuracy against CS:GO rules (combat.js, recoil.js)
4. [x] 1v1 networking review (versus.js / netplay.js)
5. [x] Dynamic lighting on characters and viewmodel
6. [x] CS-style menu and buy menu
7. [x] Cleanup pass: duplicates, dead code

## Log
- Step 1: the tree already holds a coherent, unfinished-but-working batch: magazines and
  reserve ammo with R to reload (shell-by-shell for shotguns), reload animations and sounds
  from the asset pack, bullet tracers (tracers.js), a small view punch per shot and the
  viewmodel tilting with recoil, a TURN relay setting for 1v1 on strict networks, an fps
  counter, pausing when the window loses focus, and mouse-lock glitch filtering. Restart moved
  from R to Backspace. All files pass `node --check`; the local asset pack already has the
  ammo and reload data the code reads.
- Step 2 (movement.js, config.js, collision.js): added StepMove (walks up ledges up to
  sv_stepsize 18, keeps whichever of the flat or stepped move got farther), StayOnGround
  (no launching off stair tops and down slopes), CS:GO ground acceleration scale
  (max(250, wishspeed), so rifles reach top speed as quickly as knives) and the CS:GO clamp of
  ground speed to the weapon's max speed. A jump on the landing tick still keeps all speed.
  Checked headless: 16u stairs up and down with no airborne ticks, a 24u ledge blocks,
  215 u/s rifle reaches 95% in 37 ticks, landing without jumping drops to max speed at once,
  strafe hopping still gains speed.
- Step 3 (combat.js, recoil.js, weapons.js, match.js, versus.js, main.js, player.js, movement.js):
  - Wall penetration: one shared `traceBullet` for the player and the bot. Up to 4 walls,
    max 90u of solid per wall (touching brushes count as one wall), CS:GO damage loss
    (16% per wall + 3/power*1.25*3 + thickness^2/24); entry and exit holes are both marked.
    Range falloff now applies along the bullet's path before each wall, and the bullet stops at
    the weapon's range. Checked: AK chest through 8u leaves 21 damage, glock stops at 16u.
  - Penetration power: `m_flPenetration` added to the pack tool; packs made earlier get
    pistol/SMG/heavy 1, rifles 2 when the catalog loads.
  - Air inaccuracy now scales with vertical speed (accurate at the top of a jump, up to 2x
    the jump value when falling fast), as in CS:GO.
  - Tagging: a hit slows the victim to 50% of max speed, recovering 0.4/s (player and bot).
  - Knife hits share one `knifeHit`; damage messages in 1v1 now carry the final damage.
  - Scoped stats are made once per weapon, not on every read (the recoil table was being
    rebuilt per shot while scoped).
  - Removed unused imports (characters.js SkinnedModels, match.js scale).
- Step 4 (netplay.js, versus.js): PeerJS data channels are reliable but unordered, so
  state updates now carry a sequence number and late ones are dropped (a big jump back means
  the other side restarted counting). The shown opponent is run ahead along its last horizontal
  velocity (at most 0.1 s), so fast movers are drawn and hit where they are. A connection
  silent for 5 s counts as lost (WebRTC can take ~30 s to notice); the host's room stays open
  for a rejoin. STUN servers and the TURN relay setting were already in place.
- Step 5 (modelLighting.js new, shaders.js SKINNED_SHADER, skinnedModels.js, viewmodel.js,
  characters.js, bspScene.js, main.js): the viewmodel and characters are lit like engine models,
  an ambient cube plus up to 3 directional lights summed in linear light (half-lambert), shown
  in gamma space with the maps' 2x overbright. On .bsp maps the light comes from the map's leaf
  ambient cubes and its sun/point/spot lights with occlusion (the same code that lights static
  props, now exposed as `scene.lightingAt`). In the arena and course a sky/ground cube plus a sun
  that walls and cover shade. Samples are retaken every 24u or 0.25 s and eased, so walking
  into shadow fades. Muzzle flashes briefly light the shooter's own gun/model (4th light slot).
  The menu character keeps a fixed studio light. Checked in headless Chromium with part of the
  asset pack: no shader or console errors; viewmodel and bot render lit in the arena.
- Step 6 (buyMenu.js new, inventoryView.js, input.js, main.js, index.html, style.css): a CS-style
  buy menu on B (in game and on the menu): five columns (Pistols, Mid-Tier, Rifles, Knives,
  Gloves), number key for the column then the item, or click. Buying equips the item in its
  slot with the finish last equipped for it in the inventory (remembered per item in
  localStorage `finishes`), draws it and goes straight back to playing. B or a click beside
  the panel closes back to the game, Esc to the main menu. The inventory moved off B (still on
  its tab). The existing menu was already CS2-styled (top bar tabs, modes, GO), so it was kept.
  Checked headless: buying FAMAS via 3,3 and gloves via 5,1 updates the loadout and held gun.
- Step 7 (storage.js new, dom.js new, main.js, menu.js, inventoryView.js, buyMenu.js,
  renderer.js, modelLighting.js, formats/keyvalues.js): one localStorage helper instead of three
  copies of try/catch code; one `element` DOM helper; one sun direction shared by the arena
  shader and model lighting; removed the unused `parseKeyValueList`. Final headless run: menu,
  buy menu and a bot round in the arena (the bot hit the player through the new bullet code)
  with no script errors.

## Still open / ideas
- Regenerate the asset pack (tools/make-asset-pack.sh) so guns carry `penetration` from game
  data; until then rifles use 2 and everything else 1.
- No money/buy time: buying is free at any moment, also mid-round in 1v1.
- Wall penetration treats every surface the same (no per-material modifier yet).
- Stamina (jump/land slowdown of matchmaking) is not modelled; bhop servers turn it off.
- The test bundles in assets/ (test-bundle.tgz, test-assets*.tgz) can be deleted.

## Round 2: ragdolls, blood, crosshair
1. [x] Crosshair customizer (crosshair.js new, index.html, style.css, main.js): Settings →
   Crosshair with a live preview: static or dynamic style (the gap opens with the gun's current
   inaccuracy), length, thickness, gap, outline and its thickness, alpha, color picker plus
   swatches, center dot, T style, reset. Sizes scale with screen height; parts are placed in
   whole pixels; remembered in localStorage `crosshair`.
2. [x] Blood: a small spray where a bullet or knife hits, and a splat on the wall behind
3. [x] Ragdolls when the opponent dies (bot or friend)
   - [x] Step 2 done (blood.js new, impacts.js, shaders.js, renderer.js, combat.js, match.js,
     versus.js, main.js): a mist puff and a dozen droplets spray from every bullet or knife hit
     on the opponent (mostly onward, a few back), fall and fade in about half a second; ragged
     blood splats land on the wall behind and the floor below (also behind you when the bot hits
     you). Splats are a second kind of impact decal with random size and turn. The renderer's
     effect drawing and clearing were folded into one place.
   - [x] Step 3 done (ragdoll.js new, collision.js traceBox, characters.js holdWeapon,
     match.js/versus.js opponentKilled, main.js): a killed opponent falls from the pose it
     died in. 19 joint particles (Verlet, 120 Hz, 8 constraint passes) with cross braces and
     minimum distances over elbows, knees and spine; each joint is a small box swept against the
     world, with friction. The skeleton follows in 13 rigid body parts, the gun stays in the
     hand. The killing bullet or knife knocks the nearest joint (and neighbours less). The body
     is raised just enough at the start not to begin inside the floor, rests after 6 s and stays
     until the next round. No ragdoll when a friend disconnects (only on a real kill).
     Checked: node test (falls flat on the arena floor, nothing sinks, stick error < 0.2 u) and
     headless browser (bot killed in front of the camera lies on the floor).
   - Found that `node --check` misses some syntax errors in these ES modules; use
     `node --experimental-default-type=module --check`. It caught a duplicate variable in
     impacts.js, now fixed; every other file passes.
