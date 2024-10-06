import {findClusterBreak as find} from "@marijn/find-cluster-break"

/// Returns a next grapheme cluster break _after_ (not equal to)
/// `pos`, if `forward` is true, or before otherwise. Returns `pos`
/// itself if no further cluster break is available in the string.
/// Moves across surrogate pairs, extending characters (when
/// `includeExtending` is true), characters joined with zero-width
/// joiners, and flag emoji.
export function findClusterBreak(str: string, pos: number, forward = true, includeExtending = true) {
  return find(str, pos, forward, includeExtending)
}

function surrogateLow(ch: number) { return ch >= 0xDC00 && ch < 0xE000 }
function surrogateHigh(ch: number) { return ch >= 0xD800 && ch < 0xDC00 }

/// Find the code point at the given position in a string (like the
/// [`codePointAt`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/String/codePointAt)
/// string method).
export function codePointAt(str: string, pos: number) {
  let code0 = str.charCodeAt(pos)
  if (!surrogateHigh(code0) || pos + 1 == str.length) return code0
  let code1 = str.charCodeAt(pos + 1)
  if (!surrogateLow(code1)) return code0
  return ((code0 - 0xd800) << 10) + (code1 - 0xdc00) + 0x10000
}

/// Given a Unicode codepoint, return the JavaScript string that
/// respresents it (like
/// [`String.fromCodePoint`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/String/fromCodePoint)).
export function fromCodePoint(code: number) {
  if (code <= 0xffff) return String.fromCharCode(code)
  code -= 0x10000
  return String.fromCharCode((code >> 10) + 0xd800, (code & 1023) + 0xdc00)
}

/// The amount of positions a character takes up in a JavaScript string.
export function codePointSize(code: number): 1 | 2 { return code < 0x10000 ? 1 : 2 }
