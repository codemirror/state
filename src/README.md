In its most basic form, the editor state is made up of a current <a
href="#state.EditorState.doc">document</a> and a <a
href="#state.EditorState.selection">selection</a>. Because there are a
lot of extra pieces that an editor might need to keep in its state
(such as an [undo history](#history) or [syntax
tree](#language.syntaxTree)), it is possible for extensions to add
additional [fields](#state.StateField) to the state object.

@EditorStateConfig

@EditorState

@SelectionRange

@EditorSelection

@CharCategory

### Text

The `Text` type stores documents in an immutable tree-shaped
representation that allows:

 - Efficient indexing both by code unit offset and by line number.

 - Structure-sharing immutable updates.

 - Access to and iteration over parts of the document without copying
   or concatenating big strings.

Line numbers start at 1. Character positions are counted from zero,
and count each line break and UTF-16 code unit as one unit.

@Text

@Line

@TextIterator

#### Column Utilities

@countColumn

@findColumn

#### Code Points and Characters

If you support environments that don't yet have `String.fromCodePoint`
and `codePointAt`, this package provides portable replacements for them.

@codePointAt

@fromCodePoint

@codePointSize

@findClusterBreak

### Changes and Transactions

CodeMirror treats changes to the document as
[objects](#state.ChangeSet), which are usually part of a
[transaction](#state.Transaction).

This is how you'd make a change to a document (replacing “world” with
“editor”) and create a new state with the updated document:

```javascript
let state = EditorState.create({doc: "hello world"})
let transaction = state.update({changes: {from: 6, to: 11, insert: "editor"}})
console.log(transaction.state.doc.toString()) // "hello editor"
```

@TransactionSpec

@ChangeSpec

@Transaction

@ChangeDesc

@MapMode

@ChangeSet

@Annotation

@AnnotationType

@StateEffect

@StateEffectType

### Extending Editor State

The following are some types and mechanisms used when writing
extensions for the editor state.

@StateCommand

@Extension

@StateField

@Facet

@Prec

@Compartment

### Range Sets

Range sets provide a data structure that can hold a collection of
tagged, possibly overlapping [ranges](#rangeset.Range) in such a way
that they can efficiently be [mapped](#rangeset.RangeSet.map) though
document changes. They are used for storing things like
[decorations](#view.Decoration) or [gutter
markers](#gutter.GutterMarker).

@RangeValue

@Range

@RangeSet

@RangeCursor

@RangeSetBuilder

@RangeComparator

@SpanIterator

### Utilities

@combineConfig
