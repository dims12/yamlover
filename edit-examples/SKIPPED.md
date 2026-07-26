# Sources the generator could not turn into a keystroke sequence

Written by `npm run gen:edit-fixtures`. A skip is a statement about the EDITOR's typing grammar,
not about the document: every entry here is a shape a person cannot currently type. Shrinking this
list is a feature request; the corpus's honesty depends on it being complete.

59 of 94 sources skipped.

## a `!!<…>` schema tag — its content lives in the tag cell

- `examples/60-simple-chapter.yamlover`
- `test-examples/0501/in.yamlover`
- `test-examples/0502/in.yamlover`

## a `!!set`/`!!var`/`!!mix` shape tag — no cell types one

- `test-examples/0401-01/in.yamlover`
- `test-examples/0401/in.yamlover`
- `test-examples/0405/in.yamlover`

## a `&` path anchor — no cell types one, and it IS part of IR identity

- `examples/06-tour.yamlover`
- `examples/58-genealogy-dag/.yamlover/body.yamlover`
- `test-examples/0301/in.yamlover`
- `test-examples/0302/in.yamlover`
- `test-examples/0303/in.yamlover`
- `test-examples/0304-01/in.yamlover`
- `test-examples/0504/in.yamlover`

## a `*` pointer — its cell commits through the completion popup, not a blur

- `examples/56-array-of-files/.yamlover/body.yamlover`
- `examples/61-table.yamlover`
- `examples/67-pdf-tags/.yamlover/body.yamlover`
- `examples/71-kml-map/.yamlover/body.yamlover`
- `examples/73-dev-board/.yamlover/body.yamlover`
- `test-examples/0006/in.yamlover`
- `test-examples/0200/in.yamlover`
- `test-examples/0201/in.yamlover`
- `test-examples/0202/in.yamlover`
- `test-examples/0203/in.yamlover`
- `test-examples/0204/in.yamlover`
- `test-examples/0205/in.yamlover`
- `test-examples/0206/in.yamlover`
- `test-examples/0207/in.yamlover`
- `test-examples/0208/in.yamlover`
- `test-examples/0300/in.yamlover`
- `test-examples/0500/in.yamlover`
- `test-examples/0705/in.yamlover`
- `test-examples/0708/in.yamlover`
- `test-examples/0710/in.yamlover`
- `test-examples/1047/in.yamlover`
- `test-examples/1048/in.yamlover`

## a `~` back-edge — no cell types one, and it IS part of IR identity

- `test-examples/0304/in.yamlover`
- `test-examples/0305/in.yamlover`
- `test-examples/0308/in.yamlover`
- `test-examples/1109/in.yamlover`

## a backslash escape in a quoted string — the quote cell edits DECODED text

- `test-examples/0003/in.yamlover`
- `test-examples/0007/in.yamlover`
- `test-examples/1003/in.yamlover`

## a block scalar — its cell is a textarea, finished by Shift-Tab, not a line of text

- `examples/07-omni.yamlover`
- `examples/59-all-formats-object/.yamlover/body.yamlover`
- `examples/65-all-formats-chunks/.yamlover/body.yamlover`
- `examples/66-pet-keeper-handbook/.yamlover/body.yamlover`
- `examples/68-math-chapter/.yamlover/body.yamlover`
- `examples/69-marklower-links.yamlover`
- `test-examples/0403/in.yamlover`
- `test-examples/0503/in.yamlover`
- `test-examples/0600/in.yamlover`
- `test-examples/0601/in.yamlover`
- `test-examples/0602/in.yamlover`
- `test-examples/0603/in.yamlover`
- `test-examples/0606/in.yamlover`

## a compact `- - ` dash chain — several tree levels on one row

- `test-examples/0103/in.yamlover`
- `test-examples/0108/in.yamlover`
- `test-examples/1011/in.yamlover`

## no content lines

- `test-examples/0000/in.yamlover`
