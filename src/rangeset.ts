import {ChangeDesc, MapMode} from "./change"

/// Each range is associated with a value, which must inherit from
/// this class.
export abstract class RangeValue {
  /// Compare this value with another value. Used when comparing
  /// rangesets. The default implementation compares by identity.
  /// Unless you are only creating a fixed number of unique instances
  /// of your value type, it is a good idea to implement this
  /// properly.
  eq(other: RangeValue) { return this == other }
  /// The bias value at the start of the range. Determines how the
  /// range is positioned relative to other ranges starting at this
  /// position. Defaults to 0.
  declare startSide: number
  /// The bias value at the end of the range. Defaults to 0.
  declare endSide: number

  /// The mode with which the location of the range should be mapped
  /// when its `from` and `to` are the same, to decide whether a
  /// change deletes the range. Defaults to `MapMode.TrackDel`.
  declare mapMode: MapMode
  /// Determines whether this value marks a point range. Regular
  /// ranges affect the part of the document they cover, and are
  /// meaningless when empty. Point ranges have a meaning on their
  /// own. When non-empty, a point range is treated as atomic and
  /// shadows any ranges contained in it.
  declare point: boolean

  /// Create a [range](#state.Range) with this value.
  range(from: number, to = from) { return Range.create(from, to, this) }
}

RangeValue.prototype.startSide = RangeValue.prototype.endSide = 0
RangeValue.prototype.point = false
RangeValue.prototype.mapMode = MapMode.TrackDel

/// A range associates a value with a range of positions.
export class Range<T extends RangeValue> {
  private constructor(
    /// The range's start position.
    readonly from: number,
    /// Its end position.
    readonly to: number,
    /// The value associated with this range.
    readonly value: T) {}

  /// @internal
  static create<T extends RangeValue>(from: number, to: number, value: T) {
    return new Range<T>(from, to, value)
  }
}

function cmpRange<T extends RangeValue>(a: Range<T>, b: Range<T>) {
  return a.from - b.from || a.value.startSide - b.value.startSide
}

/// Collection of methods used when comparing range sets.
export interface RangeComparator<T extends RangeValue> {
  /// Notifies the comparator that a range (in positions in the new
  /// document) has the given sets of values associated with it, which
  /// are different in the old (A) and new (B) sets.
  compareRange(from: number, to: number, activeA: T[], activeB: T[]): void
  /// Notification for a changed (or inserted, or deleted) point range.
  comparePoint(from: number, to: number, pointA: T | null, pointB: T | null): void
  /// Notification for a changed boundary between ranges. For example,
  /// if the same span is covered by two partial ranges before and one
  /// bigger range after, this is called at the point where the ranges
  /// used to be split.
  boundChange?(pos: number): void
}

/// Methods used when iterating over the spans created by a set of
/// ranges. The entire iterated range will be covered with either
/// `span` or `point` calls.
export interface SpanIterator<T extends RangeValue> {
  /// Called for any ranges not covered by point decorations. `active`
  /// holds the values that the range is marked with (and may be
  /// empty). `openStart` indicates how many of those ranges are open
  /// (continued) at the start of the span.
  span(from: number, to: number, active: readonly T[], openStart: number): void
  /// Called when going over a point decoration. The active range
  /// decorations that cover the point and have a higher precedence
  /// are provided in `active`. The open count in `openStart` counts
  /// the number of those ranges that started before the point and. If
  /// the point started before the iterated range, `openStart` will be
  /// `active.length + 1` to signal this.
  point(from: number, to: number, value: T, active: readonly T[], openStart: number, index: number): void
}

const enum C {
  // The maximum amount of ranges to store in a single chunk
  ChunkSize = 250,
  // A large (fixnum) value to use for max/min values.
  Far = 1e9
}

class Chunk<T extends RangeValue> {
  constructor(readonly from: readonly number[],
              readonly to: readonly number[],
              readonly value: readonly T[],
              // Chunks are marked with the largest point that occurs
              // in them (or -1 for no points), so that scans that are
              // only interested in points (such as the
              // heightmap-related logic) can skip range-only chunks.
              readonly maxPoint: number) {}

  get length() { return this.to[this.to.length - 1] }

  // Find the index of the given position and side. Use the ranges'
  // `from` pos when `end == false`, `to` when `end == true`.
  findIndex(pos: number, side: number, end: boolean, startAt = 0) {
    let arr = end ? this.to : this.from
    for (let lo = startAt, hi = arr.length;;) {
      if (lo == hi) return lo
      let mid = (lo + hi) >> 1
      let diff = arr[mid] - pos || (end ? this.value[mid].endSide : this.value[mid].startSide) - side
      if (mid == lo) return diff >= 0 ? lo : hi
      if (diff >= 0) hi = mid
      else lo = mid + 1
    }
  }

  between(offset: number, from: number, to: number, f: (from: number, to: number, value: T) => void | false): void | false {
    for (let i = this.findIndex(from, -C.Far, true), e = this.findIndex(to, C.Far, false, i); i < e; i++)
      if (f(this.from[i] + offset, this.to[i] + offset, this.value[i]) === false) return false
  }

  map(offset: number, changes: ChangeDesc) {
    let value: T[] = [], from = [], to = [], newPos = -1, maxPoint = -1
    for (let i = 0; i < this.value.length; i++) {
      let val = this.value[i], curFrom = this.from[i] + offset, curTo = this.to[i] + offset, newFrom, newTo
      if (curFrom == curTo) {
        let mapped = changes.mapPos(curFrom, val.startSide, val.mapMode)
        if (mapped == null) continue
        newFrom = newTo = mapped
        if (val.startSide != val.endSide) {
          newTo = changes.mapPos(curFrom, val.endSide)
          if (newTo < newFrom) continue
        }
      } else {
        newFrom = changes.mapPos(curFrom, val.startSide)
        newTo = changes.mapPos(curTo, val.endSide)
        if (newFrom > newTo || newFrom == newTo && val.startSide > 0 && val.endSide <= 0) continue
      }
      if ((newTo - newFrom || val.endSide - val.startSide) < 0) continue
      if (newPos < 0) newPos = newFrom
      if (val.point) maxPoint = Math.max(maxPoint, newTo - newFrom)
      value.push(val)
      from.push(newFrom - newPos)
      to.push(newTo - newPos)
    }
    return {mapped: value.length ? new Chunk(from, to, value, maxPoint) : null, pos: newPos}
  }
}

/// A range cursor is an object that moves to the next range every
/// time you call `next` on it. Note that, unlike ES6 iterators, these
/// start out pointing at the first element, so you should call `next`
/// only after reading the first range (if any).
export interface RangeCursor<T> {
  /// Move the iterator forward.
  next: () => void
  /// The next range's value. Holds `null` when the cursor has reached
  /// its end.
  value: T | null
  /// The next range's start position.
  from: number
  /// The next end position.
  to: number
}

type RangeSetUpdate<T extends RangeValue> = {
  /// An array of ranges to add. If given, this should be sorted by
  /// `from` position and `startSide` unless
  /// [`sort`](#state.RangeSet.update^updateSpec.sort) is given as
  /// `true`.
  add?: readonly Range<T>[]
  /// Indicates whether the library should sort the ranges in `add`.
  /// Defaults to `false`.
  sort?: boolean
  /// Filter the ranges already in the set. Only those for which this
  /// function returns `true` are kept.
  filter?: (from: number, to: number, value: T) => boolean,
  /// Can be used to limit the range on which the filter is
  /// applied. Filtering only a small range, as opposed to the entire
  /// set, can make updates cheaper.
  filterFrom?: number
  /// The end position to apply the filter to.
  filterTo?: number
}

/// A range set stores a collection of [ranges](#state.Range) in a
/// way that makes them efficient to [map](#state.RangeSet.map) and
/// [update](#state.RangeSet.update). This is an immutable data
/// structure.
export class RangeSet<T extends RangeValue> {
  private constructor(
    /// @internal
    readonly chunkPos: readonly number[],
    /// @internal
    readonly chunk: readonly Chunk<T>[],
    /// @internal
    readonly nextLayer: RangeSet<T>,
    /// @internal
    readonly maxPoint: number
  ) {}

  /// @internal
  static create<T extends RangeValue>(
    chunkPos: readonly number[], chunk: readonly Chunk<T>[], nextLayer: RangeSet<T>, maxPoint: number
  ) {
    return new RangeSet<T>(chunkPos, chunk, nextLayer, maxPoint)
  }

  /// @internal
  get length(): number {
    let last = this.chunk.length - 1
    return last < 0 ? 0 : Math.max(this.chunkEnd(last), this.nextLayer.length)
  }

  /// The number of ranges in the set.
  get size(): number {
    if (this.isEmpty) return 0
    let size = this.nextLayer.size
    for (let chunk of this.chunk) size += chunk.value.length
    return size
  }

  /// @internal
  chunkEnd(index: number) {
    return this.chunkPos[index] + this.chunk[index].length
  }

  /// Update the range set, optionally adding new ranges or filtering
  /// out existing ones.
  ///
  /// (Note: The type parameter is just there as a kludge to work
  /// around TypeScript variance issues that prevented `RangeSet<X>`
  /// from being a subtype of `RangeSet<Y>` when `X` is a subtype of
  /// `Y`.)
  update<U extends T>(updateSpec: RangeSetUpdate<U>): RangeSet<T> {
    let {add = [], sort = false, filterFrom = 0, filterTo = this.length} = updateSpec
    let filter = updateSpec.filter as undefined | ((from: number, to: number, value: T) => boolean)
    if (add.length == 0 && !filter) return this
    if (sort) add = add.slice().sort(cmpRange)
    if (this.isEmpty) return add.length ? RangeSet.of(add) : this

    let cur = new LayerCursor(this, null, -1).goto(0), i = 0, spill: Range<T>[] = []
    let builder = new RangeSetBuilder<T>()
    while (cur.value || i < add.length) {
      if (i < add.length && (cur.from - add[i].from || cur.startSide - add[i].value.startSide) >= 0) {
        let range = add[i++]
        if (!builder.addInner(range.from, range.to, range.value)) spill.push(range)
      } else if (cur.rangeIndex == 1 && cur.chunkIndex < this.chunk.length &&
                 (i == add.length || this.chunkEnd(cur.chunkIndex) < add[i].from) &&
                 (!filter || filterFrom > this.chunkEnd(cur.chunkIndex) || filterTo < this.chunkPos[cur.chunkIndex]) &&
                 builder.addChunk(this.chunkPos[cur.chunkIndex], this.chunk[cur.chunkIndex])) {
        cur.nextChunk()
      } else {
        if (!filter || filterFrom > cur.to || filterTo < cur.from || filter(cur.from, cur.to, cur.value!)) {
          if (!builder.addInner(cur.from, cur.to, cur.value!))
            spill.push(Range.create(cur.from, cur.to, cur.value!))
        }
        cur.next()
      }
    }

    return builder.finishInner(this.nextLayer.isEmpty && !spill.length ? RangeSet.empty
                               : this.nextLayer.update<T>({add: spill, filter, filterFrom, filterTo}))
  }

  /// Map this range set through a set of changes, return the new set.
  map(changes: ChangeDesc): RangeSet<T> {
    if (changes.empty || this.isEmpty) return this

    let chunks = [], chunkPos = [], maxPoint = -1
    for (let i = 0; i < this.chunk.length; i++) {
      let start = this.chunkPos[i], chunk = this.chunk[i]
      let touch = changes.touchesRange(start, start + chunk.length)
      if (touch === false) {
        maxPoint = Math.max(maxPoint, chunk.maxPoint)
        chunks.push(chunk)
        chunkPos.push(changes.mapPos(start))
      } else if (touch === true) {
        let {mapped, pos} = chunk.map(start, changes)
        if (mapped) {
          maxPoint = Math.max(maxPoint, mapped.maxPoint)
          chunks.push(mapped)
          chunkPos.push(pos)
        }
      }
    }
    let next = this.nextLayer.map(changes)
    return chunks.length == 0 ? next : new RangeSet(chunkPos, chunks, next || RangeSet.empty, maxPoint)
  }

  /// Iterate over the ranges that touch the region `from` to `to`,
  /// calling `f` for each. There is no guarantee that the ranges will
  /// be reported in any specific order. When the callback returns
  /// `false`, iteration stops.
  between(from: number, to: number, f: (from: number, to: number, value: T) => void | false): void {
    if (this.isEmpty) return
    for (let i = 0; i < this.chunk.length; i++) {
      let start = this.chunkPos[i], chunk = this.chunk[i]
      if (to >= start && from <= start + chunk.length &&
          chunk.between(start, from - start, to - start, f) === false) return
    }
    this.nextLayer.between(from, to, f)
  }

  /// Iterate over the ranges in this set, in order, including all
  /// ranges that end at or after `from`.
  iter(from: number = 0): RangeCursor<T> {
    return HeapCursor.from([this]).goto(from)
  }

  /// @internal
  get isEmpty() { return this.nextLayer == this }

  /// Iterate over the ranges in a collection of sets, in order,
  /// starting from `from`.
  static iter<T extends RangeValue>(sets: readonly RangeSet<T>[], from: number = 0): RangeCursor<T> {
    return HeapCursor.from(sets).goto(from)
  }

  /// Iterate over two groups of sets, calling methods on `comparator`
  /// to notify it of possible differences.
  static compare<T extends RangeValue>(
    oldSets: readonly RangeSet<T>[], newSets: readonly RangeSet<T>[],
    /// This indicates how the underlying data changed between these
    /// ranges, and is needed to synchronize the iteration.
    textDiff: ChangeDesc,
    comparator: RangeComparator<T>,
    /// Can be used to ignore all non-point ranges, and points below
    /// the given size. When -1, all ranges are compared.
    minPointSize: number = -1
  ) {
    let a = oldSets.filter(set => set.maxPoint > 0 || !set.isEmpty && set.maxPoint >= minPointSize!)
    let b = newSets.filter(set => set.maxPoint > 0 || !set.isEmpty && set.maxPoint >= minPointSize!)
    let sharedChunks = findSharedChunks(a, b, textDiff)

    let sideA = new SpanCursor(a, sharedChunks, minPointSize!)
    let sideB = new SpanCursor(b, sharedChunks, minPointSize!)

    textDiff.iterGaps((fromA, fromB, length) => compare(sideA, fromA, sideB, fromB, length, comparator))
    if (textDiff.empty && textDiff.length == 0) compare(sideA, 0, sideB, 0, 0, comparator)
  }

  /// Compare the contents of two groups of range sets, returning true
  /// if they are equivalent in the given range.
  static eq<T extends RangeValue>(
    oldSets: readonly RangeSet<T>[], newSets: readonly RangeSet<T>[],
    from = 0, to?: number
  ) {
    if (to == null) to = C.Far - 1
    let a = oldSets.filter(set => !set.isEmpty && newSets.indexOf(set) < 0)
    let b = newSets.filter(set => !set.isEmpty && oldSets.indexOf(set) < 0)
    if (a.length != b.length) return false
    if (!a.length) return true
    let sharedChunks = findSharedChunks(a, b)
    let sideA = new SpanCursor(a, sharedChunks, 0).goto(from), sideB = new SpanCursor(b, sharedChunks, 0).goto(from)
    for (;;) {
      if (sideA.to != sideB.to ||
          !sameValues(sideA.active, sideB.active) ||
          sideA.point && (!sideB.point || !sideA.point.eq(sideB.point)))
        return false
      if (sideA.to > to) return true
      sideA.next(); sideB.next()
    }
  }

  /// Iterate over a group of range sets at the same time, notifying
  /// the iterator about the ranges covering every given piece of
  /// content. Returns the open count (see
  /// [`SpanIterator.span`](#state.SpanIterator.span)) at the end
  /// of the iteration.
  static spans<T extends RangeValue>(
    sets: readonly RangeSet<T>[], from: number, to: number,
    iterator: SpanIterator<T>,
    /// When given and greater than -1, only points of at least this
    /// size are taken into account.
    minPointSize: number = -1
  ): number {
    let cursor = new SpanCursor(sets, null, minPointSize).goto(from), pos = from
    let openRanges = cursor.openStart
    for (;;) {
      let curTo = Math.min(cursor.to, to)
      if (cursor.point) {
        let active = cursor.activeForPoint(cursor.to)
        let openCount = cursor.pointFrom < from ? active.length + 1
          : cursor.point.startSide < 0 ? active.length
          : Math.min(active.length, openRanges)
        iterator.point(pos, curTo, cursor.point, active, openCount, cursor.pointRank)
        openRanges = Math.min(cursor.openEnd(curTo), active.length)
      } else if (curTo > pos) {
        iterator.span(pos, curTo, cursor.active, openRanges)
        openRanges = cursor.openEnd(curTo)
      }
      if (cursor.to > to) return openRanges + (cursor.point && cursor.to > to ? 1 : 0)
      pos = cursor.to
      cursor.next()
    }
  }

  /// Create a range set for the given range or array of ranges. By
  /// default, this expects the ranges to be _sorted_ (by start
  /// position and, if two start at the same position,
  /// `value.startSide`). You can pass `true` as second argument to
  /// cause the method to sort them.
  static of<T extends RangeValue>(ranges: readonly Range<T>[] | Range<T>, sort = false): RangeSet<T> {
    let build = new RangeSetBuilder<T>()
    for (let range of ranges instanceof Range ? [ranges] : sort ? lazySort(ranges) : ranges)
      build.add(range.from, range.to, range.value)
    return build.finish()
  }

  /// Join an array of range sets into a single set.
  static join<T extends RangeValue>(sets: readonly RangeSet<T>[]): RangeSet<T> {
    if (!sets.length) return RangeSet.empty
    let result = sets[sets.length - 1]
    for (let i = sets.length - 2; i >= 0; i--) {
      for (let layer = sets[i]; layer != RangeSet.empty; layer = layer.nextLayer)
        result = new RangeSet(layer.chunkPos, layer.chunk, result, Math.max(layer.maxPoint, result.maxPoint))
    }
    return result
  }

  /// The empty set of ranges.
  static empty = new RangeSet<any>([], [], null as any, -1)
}

function lazySort<T extends RangeValue>(ranges: readonly Range<T>[]): readonly Range<T>[] {
  if (ranges.length > 1) for (let prev = ranges[0], i = 1; i < ranges.length; i++) {
    let cur = ranges[i]
    if (cmpRange(prev, cur) > 0) return ranges.slice().sort(cmpRange)
    prev = cur
  }
  return ranges
}

// Awkward patch-up to create a cyclic structure.
;(RangeSet.empty as any).nextLayer = RangeSet.empty

/// A range set builder is a data structure that helps build up a
/// [range set](#state.RangeSet) directly, without first allocating
/// an array of [`Range`](#state.Range) objects.
export class RangeSetBuilder<T extends RangeValue> {
  private chunks: Chunk<T>[] = []
  private chunkPos: number[] = []
  private chunkStart = -1
  private last: T | null = null
  private lastFrom = -C.Far
  private lastTo = -C.Far
  private from: number[] = []
  private to: number[] = []
  private value: T[] = []
  private maxPoint = -1
  private setMaxPoint = -1
  private nextLayer: RangeSetBuilder<T> | null = null

  private finishChunk(newArrays: boolean) {
    this.chunks.push(new Chunk(this.from, this.to, this.value, this.maxPoint))
    this.chunkPos.push(this.chunkStart)
    this.chunkStart = -1
    this.setMaxPoint = Math.max(this.setMaxPoint, this.maxPoint)
    this.maxPoint = -1
    if (newArrays) { this.from = []; this.to = []; this.value = [] }
  }

  /// Create an empty builder.
  constructor() {}

  /// Add a range. Ranges should be added in sorted (by `from` and
  /// `value.startSide`) order.
  add(from: number, to: number, value: T) {
    if (!this.addInner(from, to, value))
      (this.nextLayer || (this.nextLayer = new RangeSetBuilder)).add(from, to, value)
  }

  /// @internal
  addInner(from: number, to: number, value: T) {
    let diff = from - this.lastTo || value.startSide - this.last!.endSide
    if (diff <= 0 && (from - this.lastFrom || value.startSide - this.last!.startSide) < 0)
      throw new Error("Ranges must be added sorted by `from` position and `startSide`")
    if (diff < 0) return false
    if (this.from.length == C.ChunkSize) this.finishChunk(true)
    if (this.chunkStart < 0) this.chunkStart = from
    this.from.push(from - this.chunkStart)
    this.to.push(to - this.chunkStart)
    this.last = value
    this.lastFrom = from
    this.lastTo = to
    this.value.push(value)
    if (value.point) this.maxPoint = Math.max(this.maxPoint, to - from)
    return true
  }

  /// @internal
  addChunk(from: number, chunk: Chunk<T>) {
    if ((from - this.lastTo || chunk.value[0].startSide - this.last!.endSide) < 0) return false
    if (this.from.length) this.finishChunk(true)
    this.setMaxPoint = Math.max(this.setMaxPoint, chunk.maxPoint)
    this.chunks.push(chunk)
    this.chunkPos.push(from)
    let last = chunk.value.length - 1
    this.last = chunk.value[last]
    this.lastFrom = chunk.from[last] + from
    this.lastTo = chunk.to[last] + from
    return true
  }

  /// Finish the range set. Returns the new set. The builder can't be
  /// used anymore after this has been called.
  finish() { return this.finishInner(RangeSet.empty) }

  /// @internal
  finishInner(next: RangeSet<T>): RangeSet<T> {
    if (this.from.length) this.finishChunk(false)
    if (this.chunks.length == 0) return next
    let result = RangeSet.create(this.chunkPos, this.chunks,
                                 this.nextLayer ? this.nextLayer.finishInner(next) : next, this.setMaxPoint)
    this.from = null as any // Make sure further `add` calls produce errors
    return result
  }
}

function findSharedChunks(a: readonly RangeSet<any>[], b: readonly RangeSet<any>[], textDiff?: ChangeDesc) {
  let inA = new Map<Chunk<any>, number>()
  for (let set of a) for (let i = 0; i < set.chunk.length; i++)
    if (set.chunk[i].maxPoint <= 0) inA.set(set.chunk[i], set.chunkPos[i])
  let shared = new Set<Chunk<any>>()
  for (let set of b) for (let i = 0; i < set.chunk.length; i++) {
    let known = inA.get(set.chunk[i])
    if (known != null && (textDiff ? textDiff.mapPos(known) : known) == set.chunkPos[i] &&
        !textDiff?.touchesRange(known, known + set.chunk[i].length))
      shared.add(set.chunk[i])
  }
  return shared
}

class LayerCursor<T extends RangeValue> {
  declare from: number
  declare to: number
  declare value: T | null

  declare chunkIndex: number
  declare rangeIndex: number

  constructor(readonly layer: RangeSet<T>,
              readonly skip: Set<Chunk<T>> | null,
              readonly minPoint: number,
              readonly rank = 0) {}

  get startSide() { return this.value ? this.value.startSide : 0 }
  get endSide() { return this.value ? this.value.endSide : 0 }

  goto(pos: number, side: number = -C.Far) {
    this.chunkIndex = this.rangeIndex = 0
    this.gotoInner(pos, side, false)
    return this
  }

  gotoInner(pos: number, side: number, forward: boolean) {
    while (this.chunkIndex < this.layer.chunk.length) {
      let next = this.layer.chunk[this.chunkIndex]
      if (!(this.skip && this.skip.has(next) ||
            this.layer.chunkEnd(this.chunkIndex) < pos ||
            next.maxPoint < this.minPoint)) break
      this.chunkIndex++
      forward = false
    }
    if (this.chunkIndex < this.layer.chunk.length) {
      let rangeIndex = this.layer.chunk[this.chunkIndex].findIndex(pos - this.layer.chunkPos[this.chunkIndex], side, true)
      if (!forward || this.rangeIndex < rangeIndex) this.setRangeIndex(rangeIndex)
    }
    this.next()
  }

  forward(pos: number, side: number) {
    if ((this.to - pos || this.endSide - side) < 0)
      this.gotoInner(pos, side, true)
  }

  next() {
    for (;;) {
      if (this.chunkIndex == this.layer.chunk.length) {
        this.from = this.to = C.Far
        this.value = null
        break
      } else {
        let chunkPos = this.layer.chunkPos[this.chunkIndex], chunk = this.layer.chunk[this.chunkIndex]
        let from = chunkPos + chunk.from[this.rangeIndex]
        this.from = from
        this.to = chunkPos + chunk.to[this.rangeIndex]
        this.value = chunk.value[this.rangeIndex]
        this.setRangeIndex(this.rangeIndex + 1)
        if (this.minPoint < 0 || this.value.point && this.to - this.from >= this.minPoint) break
      }
    }
  }

  setRangeIndex(index: number) {
    if (index == this.layer.chunk[this.chunkIndex].value.length) {
      this.chunkIndex++
      if (this.skip) {
        while (this.chunkIndex < this.layer.chunk.length && this.skip.has(this.layer.chunk[this.chunkIndex]))
          this.chunkIndex++
      }
      this.rangeIndex = 0
    } else {
      this.rangeIndex = index
    }
  }

  nextChunk() {
    this.chunkIndex++
    this.rangeIndex = 0
    this.next()
  }

  compare(other: LayerCursor<T>) {
    return this.from - other.from || this.startSide - other.startSide || this.rank - other.rank ||
      this.to - other.to || this.endSide - other.endSide
  }
}

class HeapCursor<T extends RangeValue> {
  declare from: number
  declare to: number
  declare value: T | null
  declare rank: number
  
  constructor(readonly heap: LayerCursor<T>[]) {}

  static from<T extends RangeValue>(
    sets: readonly RangeSet<T>[],
    skip: Set<Chunk<T>> | null = null,
    minPoint: number = -1
  ): HeapCursor<T> | LayerCursor<T> {
    let heap = []
    for (let i = 0; i < sets.length; i++) {
      for (let cur = sets[i]; !cur.isEmpty; cur = cur.nextLayer) {
        if (cur.maxPoint >= minPoint)
          heap.push(new LayerCursor(cur, skip, minPoint, i))
      }
    }
    return heap.length == 1 ? heap[0] : new HeapCursor(heap)
  }

  get startSide() { return this.value ? this.value.startSide : 0 }

  goto(pos: number, side: number = -C.Far) {
    for (let cur of this.heap) cur.goto(pos, side)
    for (let i = this.heap.length >> 1; i >= 0; i--) heapBubble(this.heap, i)
    this.next()
    return this
  }

  forward(pos: number, side: number) {
    for (let cur of this.heap) cur.forward(pos, side)
    for (let i = this.heap.length >> 1; i >= 0; i--) heapBubble(this.heap, i)
    if ((this.to - pos || this.value!.endSide - side) < 0) this.next()
  }    

  next() {
    if (this.heap.length == 0) {
      this.from = this.to = C.Far
      this.value = null
      this.rank = -1
    } else {
      let top = this.heap[0]
      this.from = top.from
      this.to = top.to
      this.value = top.value
      this.rank = top.rank
      if (top.value) top.next()
      heapBubble(this.heap, 0)
    }
  }
}

function heapBubble<T extends RangeValue>(heap: LayerCursor<T>[], index: number) {
  for (let cur = heap[index];;) {
    let childIndex = (index << 1) + 1
    if (childIndex >= heap.length) break
    let child = heap[childIndex]
    if (childIndex + 1 < heap.length && child.compare(heap[childIndex + 1]) >= 0) {
      child = heap[childIndex + 1]
      childIndex++
    }
    if (cur.compare(child) < 0) break
    heap[childIndex] = cur
    heap[index] = child
    index = childIndex
  }
}

class SpanCursor<T extends RangeValue> {
  cursor: HeapCursor<T> | LayerCursor<T>

  active: T[] = []
  activeTo: number[] = []
  activeRank: number[] = []
  minActive = -1

  // A currently active point range, if any
  point: T | null = null
  pointFrom = 0
  pointRank = 0

  to = -C.Far
  endSide = 0
  // The amount of open active ranges at the start of the iterator.
  // Not including points.
  openStart = -1

  constructor(sets: readonly RangeSet<T>[],
              skip: Set<Chunk<T>> | null,
              readonly minPoint: number) {
    this.cursor = HeapCursor.from(sets, skip, minPoint)
  }

  goto(pos: number, side: number = -C.Far) {
    this.cursor.goto(pos, side)
    this.active.length = this.activeTo.length = this.activeRank.length = 0
    this.minActive = -1
    this.to = pos
    this.endSide = side
    this.openStart = -1
    this.next()
    return this
  }

  forward(pos: number, side: number) {
    while (this.minActive > -1 && (this.activeTo[this.minActive] - pos || this.active[this.minActive].endSide - side) < 0)
      this.removeActive(this.minActive)
    this.cursor.forward(pos, side)
  }

  removeActive(index: number) {
    remove(this.active, index)
    remove(this.activeTo, index)
    remove(this.activeRank, index)
    this.minActive = findMinIndex(this.active, this.activeTo)
  }

  addActive(trackOpen: number[] | null) {
    let i = 0, {value, to, rank} = this.cursor
    // Organize active marks by rank first, then by size
    while (i < this.activeRank.length && (rank - this.activeRank[i] || to - this.activeTo[i]) > 0) i++
    insert(this.active, i, value)
    insert(this.activeTo, i, to)
    insert(this.activeRank, i, rank)
    if (trackOpen) insert(trackOpen, i, this.cursor.from)
    this.minActive = findMinIndex(this.active, this.activeTo)
  }

  // After calling this, if `this.point` != null, the next range is a
  // point. Otherwise, it's a regular range, covered by `this.active`.
  next() {
    let from = this.to, wasPoint = this.point
    this.point = null
    let trackOpen = this.openStart < 0 ? [] : null
    for (;;) {
      let a = this.minActive
      if (a > -1 && (this.activeTo[a] - this.cursor.from || this.active[a].endSide - this.cursor.startSide) < 0) {
        if (this.activeTo[a] > from) {
          this.to = this.activeTo[a]
          this.endSide = this.active[a].endSide
          break
        }
        this.removeActive(a)
        if (trackOpen) remove(trackOpen, a)
      } else if (!this.cursor.value) {
        this.to = this.endSide = C.Far
        break
      } else if (this.cursor.from > from) {
        this.to = this.cursor.from
        this.endSide = this.cursor.startSide
        break
      } else {
        let nextVal = this.cursor.value
        if (!nextVal.point) { // Opening a range
          this.addActive(trackOpen)
          this.cursor.next()
        } else if (wasPoint && this.cursor.to == this.to && this.cursor.from < this.cursor.to) {
          // Ignore any non-empty points that end precisely at the end of the prev point
          this.cursor.next()
        } else { // New point
          this.point = nextVal
          this.pointFrom = this.cursor.from
          this.pointRank = this.cursor.rank
          this.to = this.cursor.to
          this.endSide = nextVal.endSide
          this.cursor.next()
          this.forward(this.to, this.endSide)
          break
        }
      }
    }
    if (trackOpen) {
      this.openStart = 0
      for (let i = trackOpen.length - 1; i >= 0 && trackOpen[i] < from; i--) this.openStart++
    }
  }

  activeForPoint(to: number) {
    if (!this.active.length) return this.active
    let active = []
    for (let i = this.active.length - 1; i >= 0; i--) {
      if (this.activeRank[i] < this.pointRank) break
      if (this.activeTo[i] > to || this.activeTo[i] == to && this.active[i].endSide >= this.point!.endSide)
        active.push(this.active[i])
    }
    return active.reverse()
  }

  openEnd(to: number) {
    let open = 0
    for (let i = this.activeTo.length - 1; i >= 0 && this.activeTo[i] > to; i--) open++
    return open
  }
}

function compare<T extends RangeValue>(a: SpanCursor<T>, startA: number,
                                       b: SpanCursor<T>, startB: number,
                                       length: number,
                                       comparator: RangeComparator<T>) {
  a.goto(startA)
  b.goto(startB)
  let endB = startB + length
  let pos = startB, dPos = startB - startA
  for (;;) {
    let dEnd = (a.to + dPos) - b.to, diff = dEnd || a.endSide - b.endSide
    let end = diff < 0 ? a.to + dPos : b.to, clipEnd = Math.min(end, endB)
    if (a.point || b.point) {
      if (!(a.point && b.point && (a.point == b.point || a.point.eq(b.point)) &&
            sameValues(a.activeForPoint(a.to), b.activeForPoint(b.to))))
        comparator.comparePoint(pos, clipEnd, a.point, b.point)
    } else {
      if (clipEnd > pos && !sameValues(a.active, b.active)) comparator.compareRange(pos, clipEnd, a.active, b.active)
    }
    if (end > endB) break
    if ((dEnd || a.openEnd != b.openEnd) && comparator.boundChange) comparator.boundChange(end)
    pos = end
    if (diff <= 0) a.next()
    if (diff >= 0) b.next()
  }
}

function sameValues<T extends RangeValue>(a: T[], b: T[]) {
  if (a.length != b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] != b[i] && !a[i].eq(b[i])) return false
  return true
}

function remove<T>(array: T[], index: number) {
  for (let i = index, e = array.length - 1; i < e; i++) array[i] = array[i + 1]
  array.pop()
}

function insert<T>(array: T[], index: number, value: T) {
  for (let i = array.length - 1; i >= index; i--) array[i + 1] = array[i]
  array[index] = value
}

function findMinIndex(value: RangeValue[], array: number[]) {
  let found = -1, foundPos = C.Far
  for (let i = 0; i < array.length; i++)
    if ((array[i] - foundPos || value[i].endSide - value[found].endSide) < 0) {
    found = i
    foundPos = array[i]
  }
  return found
}
