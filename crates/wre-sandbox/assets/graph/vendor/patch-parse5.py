# Applies Chrome 156's select parsing (the HTML standard's customizable-select parser changes, which
# parse5 8.1.0 predates) to the bundled parse5: a <select> no longer has its own insertion mode, so
# its content parses as in body; only <input> and a nested <select> close an open select, </select>
# closes it across other elements, and a select-context fragment ignores <select>.
# Usage: python3 patch-parse5.py <bundle.js>. Fails if parse5's code differs from what it expects.
import sys

path = sys.argv[1]
source = open(path).read()

def swap(old, new):
    global source
    if source.count(old) != 1:
        sys.exit("patch-parse5: expected exactly one match for:\n" + old)
    source = source.replace(old, new)

swap("""        case TAG_ID.SELECT: {
          this._resetInsertionModeForSelect(i);
          return;
        }
""", "")

swap("""function selectStartTagInBody(p, token) {
  p._reconstructActiveFormattingElements();
  p._insertElement(token, NS.HTML);
  p.framesetOk = false;
  p.insertionMode = p.insertionMode === InsertionMode.IN_TABLE || p.insertionMode === InsertionMode.IN_CAPTION || p.insertionMode === InsertionMode.IN_TABLE_BODY || p.insertionMode === InsertionMode.IN_ROW || p.insertionMode === InsertionMode.IN_CELL ? InsertionMode.IN_SELECT_IN_TABLE : InsertionMode.IN_SELECT;
}
function optgroupStartTagInBody(p, token) {
  if (p.openElements.currentTagId === TAG_ID.OPTION) {
    p.openElements.pop();
  }
  p._reconstructActiveFormattingElements();
  p._insertElement(token, NS.HTML);
}""", """function selectStartTagInBody(p, token) {
  if (p.fragmentContext && p.fragmentContextID === TAG_ID.SELECT) {
    return;
  }
  if (p.openElements.hasInScope(TAG_ID.SELECT)) {
    p.openElements.popUntilTagNamePopped(TAG_ID.SELECT);
    return;
  }
  p._reconstructActiveFormattingElements();
  p._insertElement(token, NS.HTML);
  p.framesetOk = false;
}
function optgroupStartTagInBody(p, token) {
  if (p.openElements.hasInScope(TAG_ID.SELECT)) {
    if (token.tagID === TAG_ID.OPTION) {
      p.openElements.generateImpliedEndTagsWithExclusion(TAG_ID.OPTGROUP);
    } else {
      p.openElements.generateImpliedEndTags();
    }
  } else if (p.openElements.currentTagId === TAG_ID.OPTION) {
    p.openElements.pop();
  }
  p._reconstructActiveFormattingElements();
  p._insertElement(token, NS.HTML);
}""")

swap("""function inputStartTagInBody(p, token) {
  p._reconstructActiveFormattingElements();""", """function inputStartTagInBody(p, token) {
  if (p.openElements.hasInScope(TAG_ID.SELECT)) {
    p.openElements.popUntilTagNamePopped(TAG_ID.SELECT);
  }
  p._reconstructActiveFormattingElements();""")

swap("""function hrStartTagInBody(p, token) {
  if (p.openElements.hasInButtonScope(TAG_ID.P)) {
    p._closePElement();
  }""", """function hrStartTagInBody(p, token) {
  if (p.openElements.hasInButtonScope(TAG_ID.P)) {
    p._closePElement();
  }
  if (p.openElements.hasInScope(TAG_ID.SELECT)) {
    p.openElements.generateImpliedEndTags();
  }""")

swap("""function endTagInBody(p, token) {
  switch (token.tagID) {""", """function endTagInBody(p, token) {
  if (token.tagID === TAG_ID.SELECT) {
    if (p.openElements.hasInScope(TAG_ID.SELECT)) {
      p.openElements.popUntilTagNamePopped(TAG_ID.SELECT);
    }
    return;
  }
  switch (token.tagID) {""")

source = source.replace("// parse5 8.1.0", "// parse5 8.1.0", 1)
open(path, "w").write("// parse5 8.1.0, bundled, with Chrome's select parsing patched in (see patch-parse5.py).\n" + source)
