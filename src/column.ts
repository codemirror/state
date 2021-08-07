import {findClusterBreak} from "./char"

/// Count the column position at the given offset into the string,
/// taking extending characters and tab size into account.
export function countColumn(string: string, tabSize: number, to = string.length): number {
  let n = 0
  for (let i = 0; i < to;) {
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
/// string, taking extending characters and tab size into account.
export function findColumn(string: string, col: number, tabSize: number): number {
  for (let i = 0, n = 0; i < string.length;) {
    if (n >= col) return i
    n += string.charCodeAt(i) == 9 ? tabSize - (n % tabSize) : 1
    i = findClusterBreak(string, i)
  }
  return string.length
}
