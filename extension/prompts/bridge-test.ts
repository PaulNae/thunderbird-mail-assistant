// Strings for the connection test, kept in one place.
export const BRIDGE_TEST_SYSTEM = "Answer briefly.";
export const BRIDGE_TEST_MODEL = "haiku";
export const bridgeTestPrompt = (): string => messenger.i18n.getMessage("bridgeTestPrompt");
