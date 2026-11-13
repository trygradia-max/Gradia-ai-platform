/**
 * Capability token for placing a voice test call. `startVoiceTestCall` (the only function that
 * reaches Vapi's outbound-call endpoint) requires one, and the only legitimate minter is
 * `src/lib/voice-test-call.ts` after it has proven entitlement, readiness, budget, a verified
 * destination and taken the atomic rate/concurrency claim (audit finding #6). A lock test in
 * `eval/voice-test-call.test.ts` pins that no other module imports the minter.
 */
declare const brand: unique symbol

export type VoiceTestCallAuthorization = {
  readonly [brand]: true
  readonly toNumber: string
  readonly attemptId: string
}

export function mintVoiceTestCallAuthorization(input: {
  toNumber: string
  attemptId: string
}): VoiceTestCallAuthorization {
  return Object.freeze({ ...input }) as unknown as VoiceTestCallAuthorization
}
