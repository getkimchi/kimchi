// Empty stub standing in for the `natural` npm package.
//
// mem0's only use of natural is a lazy PorterStemmer lookup guarded by a
// try/catch — an empty object makes `natural.PorterStemmer` undefined,
// which falls back to mem0's built-in simpleStem. That is exactly the
// behavior of the compiled binary, where natural is an --external and
// never loads. Stubbing it removes natural's transitive tree (mongoose,
// mongodb, redis, memjs, wordnet-db, stopwords-iso, afinn-165, apparatus)
// from every install.
//
// Version 8.1.1 satisfies mem0ai's peer range (^8.1.1) so pnpm resolves
// the peer to this stub instead of the registry package.
//
// NOT suitable for `compromise`: mem0 truthiness-guards `nlp` on the
// search path (query entity extraction), where an empty object would make
// `nlp(text)` throw instead of degrade — keep the real package installed.
//
// Removal criteria: when mem0 drops the natural dependency or the
// PorterStemmer path disappears from its bundle.

module.exports = {}
