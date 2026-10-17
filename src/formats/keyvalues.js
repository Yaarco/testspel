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

function parseBlock(tokens, position) {
  const block = {};
  while (position.index < tokens.length) {
    const key = tokens[position.index++];
    if (key.brace === '}') break;
    if (key.brace) continue;
    const value = tokens[position.index++];
    if (!value) break;
    const name = key.text.toLowerCase();
    if (!(name in block)) block[name] = value.brace === '{' ? parseBlock(tokens, position) : value.text;
    else if (value.brace === '{') parseBlock(tokens, position);   // a repeated key: the first one counts
  }
  return block;
}

/** Returns { name, body } for the first root block. */
export function parseKeyValues(text) {
  const tokens = tokenize(text);
  const position = { index: 0 };
  const name = tokens[position.index++]?.text?.toLowerCase() ?? '';
  if (tokens[position.index]?.brace === '{') position.index++;
  return { name, body: parseBlock(tokens, position) };
}
