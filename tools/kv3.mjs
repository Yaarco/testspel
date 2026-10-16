/**
 * Parser for KeyValues3 text, the format the converter decompiles game data files to
 * (.vdata, .vsndevts, .vcompmat):
 *   <!-- kv3 ... --> { key = "text" list = [ 1, 2.5, true ] child = { ... } }
 * Typed values such as resource_name:"path" keep only their string.
 */
const TOKEN = /\s+|\/\/[^\n]*|<!--[\s\S]*?-->|"((?:[^"\\]|\\.)*)"|([{}[\]=,])|([^\s{}[\]=,"]+)/y;

function tokenize(text) {
  const tokens = [];
  TOKEN.lastIndex = 0;
  let match;
  while (TOKEN.lastIndex < text.length && (match = TOKEN.exec(text))) {
    if (match[1] !== undefined) tokens.push({ string: match[1] });
    else if (match[2]) tokens.push({ symbol: match[2] });
    else if (match[3]) tokens.push({ word: match[3] });
  }
  return tokens;
}

function scalar(word) {
  if (word === 'true') return true;
  if (word === 'false') return false;
  if (word === 'null') return null;
  const number = Number(word);
  return Number.isNaN(number) ? word : number;
}

export function parseKv3(text) {
  const tokens = tokenize(text);
  let at = 0;

  function value() {
    const token = tokens[at++];
    if (token.symbol === '{') return object();
    if (token.symbol === '[') return array();
    if (token.string !== undefined) return token.string;
    // A type prefix is glued to its value: resource_name:"x", soundevent:"x", and #[ hex ] for binary blobs.
    if (token.word.endsWith(':') || token.word === '#') return value();
    return scalar(token.word);
  }

  function object() {
    const out = {};
    while (at < tokens.length && tokens[at].symbol !== '}') {
      const key = tokens[at++];
      at++; // '='
      out[key.word ?? key.string] = value();
    }
    at++;
    return out;
  }

  function array() {
    const out = [];
    while (at < tokens.length && tokens[at].symbol !== ']') {
      if (tokens[at].symbol === ',') { at++; continue; }
      out.push(value());
    }
    at++;
    return out;
  }

  while (tokens[at] && tokens[at].symbol !== '{') at++;
  at++;
  return object();
}
