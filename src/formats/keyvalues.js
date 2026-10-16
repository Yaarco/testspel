/**
 * Parser for KeyValues text, the format of .vmt material files:
 *   "LightmappedGeneric" { "$basetexture" "concrete/wall" "Proxies" { ... } }
 * Keys are lowercased. Nested blocks become nested objects.
 */
function tokenize(text) {
  const tokens = [];
  const pattern = /\/\/[^\n]*|"([^"]*)"|([{}])|([^\s{}"]+)/g;
  for (const match of text.matchAll(pattern)) {
    if (match[0].startsWith('//')) continue;
    if (match[1] !== undefined) tokens.push({ text: match[1] });
    else if (match[2]) tokens.push({ brace: match[2] });
    else tokens.push({ text: match[3] });
  }
  return tokens;
}

function parseBlock(tokens, position, keepDuplicates = false) {
  const block = {};
  while (position.index < tokens.length) {
    const key = tokens[position.index++];
    if (key.brace === '}') break;
    if (key.brace) continue;
    const value = tokens[position.index++];
    if (!value) break;
    const name = key.text.toLowerCase();
    const parsed = value.brace === '{' ? parseBlock(tokens, position, keepDuplicates) : value.text;
    if (!(name in block)) block[name] = keepDuplicates ? [parsed] : parsed;
    else if (keepDuplicates) block[name].push(parsed);
  }
  return block;
}

/**
 * Parses a file of several top-level blocks, like sound scripts:
 *   "Weapon_AK47.Single" { "wave" "..." }  "Weapon_AK47.Draw" { ... }
 * Every key maps to the list of its values, since keys such as "wave" repeat.
 */
export function parseKeyValueList(text) {
  return parseBlock(tokenize(text), { index: 0 }, true);
}

/** Returns { name, body } for the first root block. */
export function parseKeyValues(text) {
  const tokens = tokenize(text);
  const position = { index: 0 };
  const name = tokens[position.index++]?.text?.toLowerCase() ?? '';
  if (tokens[position.index]?.brace === '{') position.index++;
  return { name, body: parseBlock(tokens, position) };
}
