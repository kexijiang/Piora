// Compile the desktop test fixture first with tsc6 -p desktop/tsconfig.json --outDir .verification/meme-desktop.
// Downloads the pinned package when absent. Uses only .verification/dsh-meme-runtime.
// Real upstream tools and browser panel; recognition uses a deterministic model fixture.
import "./test-dsh-meme-runtime.mjs";
