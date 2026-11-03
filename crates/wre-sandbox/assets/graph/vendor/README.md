Vendored, unmodified third-party engines the graph realm runs on, each bundled into one CommonJS
file (esbuild, `--format=cjs --platform=neutral`) and evaluated as a module so it leaves no global:

- web-streams-polyfill 4.3.0 (MIT): WHATWG Streams, behind streams.js.
- parse5 8.1.0 (MIT, with entities, BSD-2-Clause): the WHATWG HTML parser and serializer, with
  Chrome's (the current standard's) select parsing applied by `patch-parse5.py` after bundling.
- css-select 7.0.0 (BSD-2-Clause, with css-what, nth-check, boolbase, domutils, domhandler,
  domelementtype, dom-serializer): the CSS selector engine, over an adapter on the DOM's state.
- saxes 6.0.0 (ISC, with xmlchars, MIT): the XML parser behind DOMParser's XML types.

Rebuild a bundle from an entry that re-exports what the DOM uses, e.g.
`echo "export { parse, parseFragment, serialize, serializeOuter, defaultTreeAdapter, html } from 'parse5';" > e.mjs`
then `npx esbuild e.mjs --bundle --format=cjs --platform=neutral --target=es2022 --main-fields=module,main --legal-comments=inline --outfile=parse5-<version>.js`.
