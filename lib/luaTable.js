// Minimal reader for the Lua table literals ESO writes into SavedVariables.
// It understands only what the game serializer emits: tables, strings, numbers,
// booleans, nil and comments. Anything else is a hard error so a malformed file
// fails loudly instead of importing partial data.

const IDENT_START = /[A-Za-z_]/;
const IDENT_PART = /[A-Za-z0-9_]/;
const NUMBER = /^-?(?:0[xX][0-9a-fA-F]+|\d+(?:\.\d*)?(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)/;

const SIMPLE_ESCAPES = {
  a: '\x07',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
  v: '\v',
  '\\': '\\',
  '"': '"',
  "'": "'",
  '\n': '\n',
};

class LuaParser {
  constructor(text, position) {
    this.text = text;
    this.pos = position;
  }

  fail(message) {
    const line = this.text.slice(0, this.pos).split('\n').length;
    throw new Error(`Lua parse error on line ${line}: ${message}`);
  }

  peek() {
    return this.text[this.pos];
  }

  skipTrivia() {
    const text = this.text;
    for (;;) {
      const ch = text[this.pos];
      if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
        this.pos += 1;
        continue;
      }
      if (ch === '-' && text[this.pos + 1] === '-') {
        this.pos += 2;
        if (text.startsWith('[[', this.pos)) {
          const end = text.indexOf(']]', this.pos + 2);
          this.pos = end === -1 ? text.length : end + 2;
        } else {
          while (this.pos < text.length && text[this.pos] !== '\n') {
            this.pos += 1;
          }
        }
        continue;
      }
      return;
    }
  }

  expect(char) {
    if (this.text[this.pos] !== char) {
      this.fail(`expected '${char}' but found ${JSON.stringify(this.text[this.pos] ?? 'end of file')}`);
    }
    this.pos += 1;
  }

  readIdentifier() {
    let identifier = '';
    while (this.pos < this.text.length && IDENT_PART.test(this.text[this.pos])) {
      identifier += this.text[this.pos];
      this.pos += 1;
    }
    return identifier;
  }

  parseValue() {
    this.skipTrivia();
    const ch = this.peek();

    if (ch === '{') {
      return this.parseTable();
    }
    if (ch === '"' || ch === "'") {
      return this.parseString(ch);
    }
    if (ch === '-' || ch === '.' || (ch !== undefined && ch >= '0' && ch <= '9')) {
      const number = this.tryParseNumber();
      if (number !== null) {
        return number;
      }
    }
    if (ch !== undefined && IDENT_START.test(ch)) {
      const identifier = this.readIdentifier();
      if (identifier === 'true') return true;
      if (identifier === 'false') return false;
      if (identifier === 'nil') return null;
      this.fail(`unsupported literal "${identifier}"`);
    }

    this.fail(`unexpected ${JSON.stringify(ch ?? 'end of file')}`);
    return undefined;
  }

  tryParseNumber() {
    const match = NUMBER.exec(this.text.slice(this.pos));
    if (!match) {
      return null;
    }
    this.pos += match[0].length;
    const raw = match[0];
    const value = /^0[xX]/.test(raw) ? parseInt(raw, 16) : Number(raw);
    if (!Number.isFinite(value)) {
      this.fail(`invalid number "${raw}"`);
    }
    return value;
  }

  parseString(quote) {
    this.expect(quote);
    let out = '';

    for (;;) {
      if (this.pos >= this.text.length) {
        this.fail('unterminated string');
      }
      const ch = this.text[this.pos];

      if (ch === quote) {
        this.pos += 1;
        return out;
      }

      if (ch !== '\\') {
        out += ch;
        this.pos += 1;
        continue;
      }

      this.pos += 1;
      const escape = this.text[this.pos];
      if (escape === undefined) {
        this.fail('unterminated escape sequence');
      }

      if (Object.prototype.hasOwnProperty.call(SIMPLE_ESCAPES, escape)) {
        out += SIMPLE_ESCAPES[escape];
        this.pos += 1;
        continue;
      }
      if (escape === 'x') {
        const hex = this.text.slice(this.pos + 1, this.pos + 3);
        if (!/^[0-9a-fA-F]{2}$/.test(hex)) {
          this.fail(`invalid \\x escape "${hex}"`);
        }
        out += String.fromCharCode(parseInt(hex, 16));
        this.pos += 3;
        continue;
      }
      if (escape === 'z') {
        this.pos += 1;
        while (this.pos < this.text.length && /\s/.test(this.text[this.pos])) {
          this.pos += 1;
        }
        continue;
      }
      if (escape >= '0' && escape <= '9') {
        const digits = this.text.slice(this.pos, this.pos + 3).match(/^\d{1,3}/)[0];
        out += String.fromCharCode(Number(digits));
        this.pos += digits.length;
        continue;
      }

      this.fail(`unsupported escape sequence "\\${escape}"`);
    }
  }

  parseTable() {
    this.expect('{');
    const table = {};
    let nextIndex = 1;

    for (;;) {
      this.skipTrivia();
      if (this.pos >= this.text.length) {
        this.fail('unterminated table');
      }
      if (this.peek() === '}') {
        this.pos += 1;
        return table;
      }

      let key = null;

      if (this.peek() === '[') {
        this.pos += 1;
        key = this.parseValue();
        this.skipTrivia();
        this.expect(']');
        this.skipTrivia();
        this.expect('=');
      } else if (this.isIdentifierKey()) {
        key = this.readIdentifier();
        this.skipTrivia();
        this.expect('=');
      }

      const value = this.parseValue();

      if (key === null) {
        table[nextIndex] = value;
        nextIndex += 1;
      } else {
        table[String(key)] = value;
      }

      this.skipTrivia();
      const separator = this.peek();
      if (separator === ',' || separator === ';') {
        this.pos += 1;
        continue;
      }
      if (separator === '}') {
        this.pos += 1;
        return table;
      }
      this.fail(`expected ',' or '}' but found ${JSON.stringify(separator ?? 'end of file')}`);
    }
  }

  isIdentifierKey() {
    const start = this.pos;
    if (this.peek() === undefined || !IDENT_START.test(this.peek())) {
      return false;
    }
    this.readIdentifier();
    this.skipTrivia();
    const isKey = this.peek() === '=';
    this.pos = start;
    return isKey;
  }
}

/**
 * Finds `name = { ... }` and returns the parsed table.
 * @param {string} text full saved variables file contents
 * @param {string} name top level saved variable name, e.g. ItemShareSavedVars
 */
export function parseLuaAssignment(text, name) {
  const pattern = new RegExp(`(?:^|[^\\w.])${name}\\s*=\\s*\\{`);
  const match = pattern.exec(text);
  if (!match) {
    throw new Error(`Could not find a "${name} = { ... }" table in this file`);
  }

  const braceIndex = text.indexOf('{', match.index);
  const parser = new LuaParser(text, braceIndex);
  return parser.parseTable();
}

export function isPlainTable(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
