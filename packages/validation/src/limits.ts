/** Runtime limit values, supplied from config so limits stay env-tunable (§22). */
export interface ValidationLimits {
  maxMessages: number;
  maxMessageChars: number;
  maxContentTokensHardCap: number;
  /**
   * Image input caps. `maxImagesPerRequest` is 0 when the operator has turned
   * image input off entirely, in which case any image part is rejected.
   */
  maxImagesPerRequest: number;
  maxImageBytes: number;
}
