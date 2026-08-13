# Alice's Adventures in Wonderland example

This is the primary real-world example for `dont-lose-the-plot`. It processes the first three narrative chapters of Lewis Carroll's _Alice's Adventures in Wonderland_ from the supplied EPUB, then produces a verified narrative graph, Obsidian vault, and Quartz-ready website.

## Source and rights

- Title: _Alice's Adventures in Wonderland_
- Author: Lewis Carroll
- Project Gutenberg eBook: [#11](https://www.gutenberg.org/ebooks/11)
- EPUB revision: June 26, 2025
- Local source SHA-256: `6b79f2d23b804172816e81c463dbcea689593bbde63ef200d52b6c0da7ef629c`

The work is in the public domain in the United States. The EPUB contains the Project Gutenberg License and its jurisdiction notice. Users outside the United States must check local copyright law before redistribution.

## Run it

From this directory, after installing the repository dependencies:

```sh
npx tsx ../../src/cli.ts ingest
npx tsx ../../src/cli.ts discover
npx tsx ../../src/cli.ts onboard --accept-recommended
npx tsx ../../src/cli.ts extract
npx tsx ../../src/cli.ts normalize
npx tsx ../../src/cli.ts render
npx tsx ../../src/cli.ts verify
```

`plot-tools.yml` uses `startSegment: 2` to skip Project Gutenberg front matter and `maxSegment: 3` to keep the recorded fixture compact. Remove the limit and use a live gateway provider to process all twelve chapters.
