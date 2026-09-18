/**
 * Token counting for chunk sizing. Voyage's tokenizer is not shipped for JS;
 * cl100k_base is a close approximation (within roughly 15% on English prose)
 * and is pure JS. Used only for sizing decisions, never for billing.
 */
import { Tiktoken } from "js-tiktoken/lite";
import cl100k_base from "js-tiktoken/ranks/cl100k_base";

let encoder: Tiktoken | undefined;

function enc(): Tiktoken {
  encoder ??= new Tiktoken(cl100k_base);
  return encoder;
}

export function countTokens(text: string): number {
  if (text.length === 0) return 0;
  return enc().encode(text, "all").length;
}
