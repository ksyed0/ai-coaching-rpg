export * from "./model/types.js";
export { MockModelProvider } from "./model/mock.js";
export { AnthropicModelProvider } from "./model/anthropic.js";
export { OpenAICompatibleModelProvider } from "./model/openai-compatible.js";
export { modelProviderContract } from "./model/contract.js";
export { selectModelProvider, describeModelProvider } from "./model/select.js";
export { ModelProviderError, isTransientModelError, MAX_RETRY_AFTER_MS, type ModelErrorKind, type ModelProviderErrorInit } from "./model/errors.js";
export { RetryingModelProvider, withRetry, getRetryProgress, type RetryProgress, DEFAULT_MODEL_MAX_RETRIES, DEFAULT_MODEL_RETRY_BASE_MS, DEFAULT_MODEL_RETRY_CAP_MS, type RetryOptions, type RetryInfo } from "./model/retry.js";
// US-0070 (EPIC-0003 voice A1a): speech to text.
export type { SpeechSegment, SpeechToText, Transcript } from "./speech/types.js";
export { SpeechRefusedError, SpeechTimeoutError, SpeechUnavailableError, isSpeechError, isTransientSpeechError, type AnySpeechError } from "./speech/errors.js";
export { FakeSpeechToText } from "./speech/fake.js";
export { speechToTextContract, type ContractControl } from "./speech/contract.js";
