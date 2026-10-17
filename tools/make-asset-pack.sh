#!/bin/sh
# Makes the asset pack from your own game install: assets/pack, converted to
# formats a browser reads (.glb, .webp, .wav, .svg), and assets/asset-pack.zip
# of it, which the game asks for when it is not served next to the page:
#   - every gun and knife: viewmodel meshes (current and older), base color
#     textures, draw/idle/attack/inspect/reload animations, shot, draw and
#     reload sounds,
#   - every finish (skin) each of them can have: the paint parameters and
#     pattern textures, plus each weapon's paint masks, and inventory icons,
#   - gloves with their finishes, agents (first-person sleeves and gloves,
#     third-person body) with third-person and main menu animations,
#   - the default arms, footstep, landing and jump sounds, menu icons and fonts.
# Files already in assets/pack are kept, so running it again after a game
# update only extracts what is new. Delete assets/pack to start over.
# The pack is for your own use; keep it out of the repository (.gitignore does).
#
# Needs: a resource converter CLI that decompiles the game's packages to glTF,
# PNG and WAV (Source2Viewer-CLI), node, ffmpeg and cwebp.
# Usage: tools/make-asset-pack.sh /path/to/converter-cli /path/to/game-folder-with-pak01_dir.vpk
set -eu

CONVERTER="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
GAME="$(cd "$2" && pwd)"
TOOLS="$(cd "$(dirname "$0")" && pwd)"
OUT="$(dirname "$TOOLS")/assets/pack"
PAK="$GAME/pak01_dir.vpk"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
cd "$WORK"   # the converter writes its exceptions.txt log into the current folder

echo "Reading game data…"
"$CONVERTER" -i "$PAK" -l | sed 's/ .*//' > "$WORK/paths.txt"
"$CONVERTER" -i "$PAK" -o "$WORK" -d > /dev/null \
  -f "scripts/items/items_game.txt,resource/csgo_english.txt,scripts/weapons.vdata_c,soundevents/game_sounds_weapons.vsndevts_c"
"$CONVERTER" -i "$PAK" -o "$WORK" -d -e vnmclip_c -f "animation/anims/viewmodel/" > /dev/null   # clip events (reload sounds)
"$CONVERTER" -i "$PAK" -o "$WORK" -d -e vcompmat_c -f "weapons/paints/,gloves/paints/" > /dev/null
"$CONVERTER" -i "$PAK" -e vmat_c -b DATA -f "materials/models/weapons/customization/,workshop/paintkits/templates/,weapons/models/,gloves/paints/" \
  > "$WORK/vmats.txt"
node "$TOOLS/asset-pack.mjs" plan "$WORK" "$OUT"

# Extracts the files listed in $WORK/$1, 200 per call since the path filter is one argument.
extract() {
  list="$1"
  shift
  [ -s "$WORK/$list" ] || return 0
  split -l 200 "$WORK/$list" "$WORK/batch-"
  for batch in "$WORK"/batch-*; do
    files="$({ grep -v '^$' "$batch" || true; } | paste -sd, -)"
    rm "$batch"
    # Never call the converter with an empty filter: it would extract the whole game.
    [ -n "$files" ] || continue
    "$CONVERTER" -i "$PAK" -o "$OUT" -d --threads 8 -f "$files" "$@" > /dev/null
  done
}

mkdir -p "$OUT"
MODEL="--gltf_export_format glb --gltf_export_materials --gltf_export_animations --gltf_animation_list __none__"
echo "Extracting models…"
extract models.txt $MODEL
extract gloves.txt $MODEL --gltf_mesh_list viewmodel
# Agents twice: their first-person meshes become <agent>_arms.glb, then the third-person body <agent>.glb.
extract agents.txt $MODEL --gltf_mesh_list firstperson_sleeves,firstperson_default_gloves_arms
while read -r agent; do
  glb="$OUT/${agent%.vmdl_c}.glb"
  if [ -f "$glb" ]; then mv "$glb" "${glb%.glb}_arms.glb"; fi
done < "$WORK/agents.txt"
extract agents.txt $MODEL --gltf_mesh_list thirdperson_body,thirdperson_default_gloves
echo "Extracting animations…"
extract clips.txt --gltf_export_format glb --gltf_export_animations
echo "Extracting sounds…"
extract sounds.txt
echo "Extracting finish, paint and icon textures…"
extract textures.txt
extract icons.txt
mkdir -p "$OUT/fonts"
cp "$GAME/panorama/fonts/notosans-regular.ttf" "$GAME/panorama/fonts/notosans-bold.ttf" "$OUT/fonts/"
echo "Converting textures…"
node "$TOOLS/asset-pack.mjs" finish "$WORK" "$OUT"
du -sh "$OUT"
