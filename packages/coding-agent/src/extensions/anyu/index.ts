import type { ExtensionAPI } from "../../core/extensions/types.ts";
import { createAnyuProvider } from "./provider.ts";

export default function anyuExtension(pi: ExtensionAPI): void {
	pi.registerProvider(createAnyuProvider().provider);
}
