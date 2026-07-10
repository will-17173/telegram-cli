# Hide Interactive Listen Image Previews

## Goal

Stop showing low-quality embedded photo previews in the default interactive `listen` interface while retaining the extraction, decoding, caching, sizing, and rendering infrastructure for future improvement.

The existing photo attachment line and download action remain visible. Plain `--no-interactive` output remains unchanged.

## Behavior

An internal constant, `LISTEN_IMAGE_PREVIEWS_ENABLED`, will default to `false`. Interactive message construction will use this constant when deciding whether preview decoding and preview rows are eligible.

When disabled:

- incoming photo thumbnails may still be extracted into the transient message field;
- the JPEG decoder is not called by the interactive listener;
- attachment view models contain no decoded preview cells or preview rows;
- Ink renders only the existing attachment line and download action;
- viewport height does not reserve space for a hidden image.

The constant is intentionally internal behavior, not a CLI flag or documented user option. Re-enabling previews later requires an explicit code change after rendering quality improves.

## Preserved infrastructure

The mtcute stripped-thumbnail extraction, transient storage exclusion, bounded preview cache, JPEG resource limits, terminal resize handling, preview renderer, and their focused tests remain in place. This avoids conflating a product-level visibility decision with removal of the underlying implementation.

## Documentation

The English and Chinese README statements claiming that true-color terminals display embedded previews will be removed. No replacement promise or experimental option will be documented.

## Testing

A regression test will exercise the default interactive construction path with valid preview data and a true-color terminal context. It must prove that the decoder is not called and that no preview rows or cells are exposed. Existing tests may continue to cover the lower-level opt-in rendering context so the dormant infrastructure stays verified.

The change will be verified with the focused Ink tests, the full Vitest suite, strict TypeScript checking, and the production build.
