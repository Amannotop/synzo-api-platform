/** Runtime limit values, supplied from config so limits stay env-tunable (§22). */
export interface ValidationLimits {
  maxMessages: number;
  maxMessageChars: number;
  maxContentTokensHardCap: number;
}
