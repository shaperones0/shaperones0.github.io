// Loaded only for statements that contain math, because KaTeX and its fonts are large.
import katex from "katex";
import "katex/dist/katex.min.css";

export function renderMath(tex: string, displayMode: boolean) {
  // No throwing, so a typo in a formula shows in place. KaTeX's default refuses unsafe commands.
  return katex.renderToString(tex, { displayMode, throwOnError: false, strict: "ignore" });
}
