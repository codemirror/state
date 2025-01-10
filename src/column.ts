import {findClusterBreak} from "./char"

/// Count the column position at the given offset into the string,
/// taking extending characters and tab size into account.
export function countColumn(string: string, tabSize: number, to = string.length): number {
  let n = 0
  for (let i = 0; i < to && i < string.length;) {
    if (string.charCodeAt(i) == 9) {
      n += tabSize - (n % tabSize)
      i++
    } else {
      n++
      i = findClusterBreak(string, i)
    }
  }
  return n
}

/// Find the offset that corresponds to the given column position in a
/// string, taking extending characters and tab size into account. By
/// default, the string length is returned when it is too short to
/// reach the column. Pass `strict` true to make it return -1 in that
/// situation.
export function findColumn(string: string, col: number, tabSize: number, strict?: boolean): number {
  for (let i = 0, n = 0;;) {
    if (n >= col) return i
    if (i == string.length) break
    n += string.charCodeAt(i) == 9 ? tabSize - (n % tabSize) : 1
    i = findClusterBreak(string, i)
  }
  return strict === true ? -1 : string.length
}
