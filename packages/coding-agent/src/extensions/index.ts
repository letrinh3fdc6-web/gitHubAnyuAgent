import type { InlineExtension } from "../core/extensions/types.ts";
import anyuExtension from "./anyu/index.ts";
import llamaExtension from "./llama/index.ts";

export const builtInExtensions: InlineExtension[] = [
	{ name: "Anyu", factory: anyuExtension, hidden: true },
	{ name: "llama.cpp", factory: llamaExtension, hidden: true },
];
