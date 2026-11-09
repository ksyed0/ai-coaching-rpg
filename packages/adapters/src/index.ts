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
export { encodeWav, decodeWav } from "./speech/wav.js";
export { parseSttUrl, WhisperHttpSpeechToText, MAX_WHISPER_BODY_BYTES, WHISPER_HEALTH_TIMEOUT_MS } from "./speech/whisper-http.js";
export { LimitedSpeechToText, DEFAULT_STT_MAX_IN_FLIGHT, DEFAULT_STT_MAX_RETRIES, DEFAULT_STT_RETRY_BASE_MS, DEFAULT_STT_QUEUE_ALERT, DEFAULT_STT_COLD_TIMEOUT_MS, DEFAULT_STT_IDLE_COLD_MS, type LimitedOptions } from "./speech/limited.js";
// US-0072 (EPIC-0003 voice A1c): an HTTP liveness probe (voice:up, voice:check, control's LiveKit probe). Loads no LiveKit SDK.
export { httpAnswers, HTTP_PROBE_TIMEOUT_MS } from "./net/http-probe.js";
