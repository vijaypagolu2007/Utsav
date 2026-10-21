// One place for the model id. Google retires model ids for new keys (gemini-2.5-flash now returns 404),
// so override with GEMINI_MODEL instead of editing code.
export const DEFAULT_GEMINI_MODEL = "gemini-3.8-flash";
export const geminiModel = (): string => process.env.GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL;
