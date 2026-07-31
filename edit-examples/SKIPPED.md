# Sources the generator could not turn into a keystroke sequence

Written by `npm run gen:edit-fixtures`. A skip is a statement about the EDITOR's typing grammar,
not about the document: every entry here is a shape a person cannot currently type. Shrinking this
list is a feature request; the corpus's honesty depends on it being complete.

59 of 94 sources skipped.

## a `!!<…>` schema tag — its content lives in the tag cell

- `examples/60-simple-chapter.yo`
- `test-examples/0501/in.yo`
- `test-examples/0502/in.yo`

## a `!!set`/`!!var`/`!!mix` shape tag — no cell types one

- `test-examples/0401-01/in.yo`
- `test-examples/0401/in.yo`
- `test-examples/0405/in.yo`

## a `&` path anchor — no cell types one, and it IS part of IR identity

- `examples/06-tour.yo`
- `examples/58-genealogy-dag/.yo/body.yo`
- `test-examples/0301/in.yo`
- `test-examples/0302/in.yo`
- `test-examples/0303/in.yo`
- `test-examples/0304-01/in.yo`
- `test-examples/0504/in.yo`

## a `*` pointer — its cell commits through the completion popup, not a blur

- `examples/56-array-of-files/.yo/body.yo`
- `examples/61-table.yo`
- `examples/67-pdf-tags/.yo/body.yo`
- `examples/71-kml-map/.yo/body.yo`
- `examples/73-dev-board/.yo/body.yo`
- `test-examples/0006/in.yo`
- `test-examples/0200/in.yo`
- `test-examples/0201/in.yo`
- `test-examples/0202/in.yo`
- `test-examples/0203/in.yo`
- `test-examples/0204/in.yo`
- `test-examples/0205/in.yo`
- `test-examples/0206/in.yo`
- `test-examples/0207/in.yo`
- `test-examples/0208/in.yo`
- `test-examples/0300/in.yo`
- `test-examples/0500/in.yo`
- `test-examples/0705/in.yo`
- `test-examples/0708/in.yo`
- `test-examples/0710/in.yo`
- `test-examples/1047/in.yo`
- `test-examples/1048/in.yo`

## a `~` back-edge — no cell types one, and it IS part of IR identity

- `test-examples/0304/in.yo`
- `test-examples/0305/in.yo`
- `test-examples/0308/in.yo`
- `test-examples/1109/in.yo`

## a backslash escape in a quoted string — the quote cell edits DECODED text

- `test-examples/0003/in.yo`
- `test-examples/0007/in.yo`
- `test-examples/1003/in.yo`

## a block scalar — its cell is a textarea, finished by Shift-Tab, not a line of text

- `examples/07-omni.yo`
- `examples/59-all-formats-object/.yo/body.yo`
- `examples/65-all-formats-chunks/.yo/body.yo`
- `examples/66-pet-keeper-handbook/.yo/body.yo`
- `examples/68-math-chapter/.yo/body.yo`
- `examples/69-marklower-links.yo`
- `test-examples/0403/in.yo`
- `test-examples/0503/in.yo`
- `test-examples/0600/in.yo`
- `test-examples/0601/in.yo`
- `test-examples/0602/in.yo`
- `test-examples/0603/in.yo`
- `test-examples/0606/in.yo`

## a compact `- - ` dash chain — several tree levels on one row

- `test-examples/0103/in.yo`
- `test-examples/0108/in.yo`
- `test-examples/1011/in.yo`

## no content lines

- `test-examples/0000/in.yo`
