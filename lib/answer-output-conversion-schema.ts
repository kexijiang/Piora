import { Type } from "typebox";

export function answerConversionSchema(target: "mini-app" | "intelligent-ui") {
  return Type.Optional(Type.Object({
    fromKind: Type.Literal(target === "mini-app" ? "intelligent-ui" : "mini-app"),
    fromToolCallId: Type.String({ minLength: 1, maxLength: 200 }),
    fromDigest: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    description: Type.String({ minLength: 1, maxLength: 600 }),
  }, { additionalProperties: false, description: "Explicit output-form conversion, only when outputConversion is available. Use the same logical answer id and exact conversionSource identity from saved context. Explain what changes and which progress cannot transfer. Defaults remain new defaults, not guessed input mappings. Host review and explicit user confirmation are required; task progress, tick, RNG and camera restart. Do not combine with same-app migration or claim the switch already happened." }));
}
