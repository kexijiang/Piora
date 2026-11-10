const textParts = message => typeof message.content === 'string' ? [message.content] : (message.content ?? []).filter(block => block.type === 'text').map(block => block.text);

/** Title requests include the original conversation, so text membership alone is insufficient. */
export function spatialRequestPhase(body, { phase, prompt, followup, titleInstruction }) {
  const messages = body.messages ?? [];
  // Production title agents retain shadow tool schemas and may append the
  // instruction to a trailing user message. Neither tools nor thinking is a
  // task/utility discriminator.
  // The shared context transformer can append host user messages after the
  // title instruction, and the provider may merge adjacent user blocks. This
  // isolated harness uses the exact default instruction, not a title keyword.
  const title = messages.some(message => message.role === 'user' && textParts(message).some(text => text.includes(titleInstruction)));
  if (title) return 'background';
  return messages.flatMap(textParts).includes(phase === 'followup' ? followup : prompt) ? phase : 'background';
}
